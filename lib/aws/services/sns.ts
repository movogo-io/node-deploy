import { jsonResponse } from '@riddance/fetch'
import type { EventFilter } from '@movogo-io/host/lib/context'
import type { Reflection } from '@movogo-io/host/reflect'
import { isDeepStrictEqual } from 'node:util'
import { compare } from '../diff.js'
import { type Context, awsFormRequest, isNotFound } from '../lite.js'
import type { AwsTrigger } from './triggers.js'

export async function syncTopics(
    context: Context,
    functions: { id: string; name: string }[],
    prefix: string,
    reflection: Reflection,
) {
    await Promise.all(
        reflection.events.map(async e => {
            const {
                CreateTopicResponse: {
                    CreateTopicResult: { TopicArn: topicArn },
                },
            } = await sns<{ CreateTopicResponse: { CreateTopicResult: { TopicArn: string } } }>(
                context,
                {
                    Action: 'CreateTopic',
                    Name: `${prefix}-${e.topic}-${e.type}`,
                    'Tags.member.1.Key': 'framework',
                    'Tags.member.1.Value': 'riddance',
                    'Tags.member.2.Key': 'environment',
                    'Tags.member.2.Value': prefix,
                },
                'Error creating topic.',
            )
            const lambdaArn = functions.find(f => f.name === e.name)?.id
            if (!lambdaArn) {
                throw new Error(`No function ${e.name} to subscribe to ${topicArn}.`)
            }
            // Never send the policy here: SNS refuses a Subscribe whose attributes differ from
            // the existing subscription's, while a plain one returns the existing subscription.
            const {
                SubscribeResponse: {
                    SubscribeResult: { SubscriptionArn: subscriptionArn },
                },
            } = await sns<{
                SubscribeResponse: { SubscribeResult: { SubscriptionArn: string } }
            }>(
                context,
                {
                    Action: 'Subscribe',
                    TopicArn: topicArn,
                    Protocol: 'lambda',
                    Endpoint: lambdaArn,
                },
                'Error subscribing to topic.',
            )
            const policy = await syncFilterPolicy(context, subscriptionArn, e.config.filter)
            context.log.trace(`subscribed ${e.name} to ${topicArn}, filter policy ${policy}`)
        }),
    )
}

// Deleting a Lambda deletes its policy, the only record of the topics it was subscribed to,
// so this must run before the surplus functions and statements are removed.
export async function unsubscribeSurplus(
    context: Context,
    prefix: string,
    triggers: AwsTrigger[],
    reflection: Reflection,
) {
    if (triggers.length === 0) {
        return
    }
    const [_arn, _aws, _lambda, region, account] = triggers[0]?.id.split(':') ?? []
    if (!region || !account) {
        throw new Error('Weird')
    }
    const { surplus: deleted } = compare(
        [...reflection.http, ...reflection.timers, ...reflection.events],
        triggers,
    )
    const isKept = (fn: AwsTrigger, topicArn: string) =>
        !deleted.includes(fn) &&
        reflection.events.some(
            e => e.name === fn.name && arnOfTopic(region, account, prefix, e) === topicArn,
        )
    const topicArns = new Set([
        ...triggers.flatMap(t =>
            (t.statements ?? []).flatMap(statement => {
                const source = statement.Condition?.ArnLike?.['AWS:SourceArn']
                if (
                    !source ||
                    source.includes('*') ||
                    statement.Principal.Service !== 'sns.amazonaws.com'
                ) {
                    return []
                }
                return [source]
            }),
        ),
        ...reflection.events.map(e => arnOfTopic(region, account, prefix, e)),
    ])
    await Promise.all(
        [...topicArns].map(async topicArn => {
            const surplus = (await listLambdaSubscriptions(context, topicArn)).flatMap(
                subscription => {
                    const fn = triggers.find(t => t.id === subscription.Endpoint)
                    if (!fn || isKept(fn, topicArn)) {
                        return []
                    }
                    return [{ ...subscription, name: fn.name }]
                },
            )
            await Promise.all(
                surplus.map(async subscription => {
                    context.log.trace(`unsubscribing ${subscription.name} from ${topicArn}`)
                    try {
                        await sns(
                            context,
                            {
                                Action: 'Unsubscribe',
                                SubscriptionArn: subscription.SubscriptionArn,
                            },
                            'Error unsubscribing from topic.',
                        )
                    } catch (e) {
                        if (!isNotFound(e)) {
                            throw e
                        }
                    }
                }),
            )
        }),
    )
}

function arnOfTopic(
    region: string,
    account: string,
    prefix: string,
    event: { topic: string; type: string },
) {
    return `arn:aws:sns:${region}:${account}:${prefix}-${event.topic}-${event.type}`
}

async function listLambdaSubscriptions(
    context: Context,
    topicArn: string,
    nextToken?: string,
): Promise<{ Endpoint: string; SubscriptionArn: string }[]> {
    try {
        const {
            ListSubscriptionsByTopicResponse: { ListSubscriptionsByTopicResult: page },
        } = await sns<{
            ListSubscriptionsByTopicResponse: {
                ListSubscriptionsByTopicResult: {
                    NextToken: string | null
                    Subscriptions: {
                        Endpoint: string
                        Protocol: string
                        SubscriptionArn: string
                    }[]
                }
            }
        }>(
            context,
            {
                Action: 'ListSubscriptionsByTopic',
                TopicArn: topicArn,
                ...(nextToken && { NextToken: nextToken }),
            },
            'Error listing subscriptions.',
        )
        const subscriptions = page.Subscriptions.filter(s => s.Protocol === 'lambda')
        if (!page.NextToken) {
            return subscriptions
        }
        return [
            ...subscriptions,
            ...(await listLambdaSubscriptions(context, topicArn, page.NextToken)),
        ]
    } catch (e) {
        // A new handler's topic is listed here before syncTopics creates it.
        if (isNotFound(e)) {
            return []
        }
        throw e
    }
}

async function syncFilterPolicy(
    context: Context,
    subscriptionArn: string,
    filter: EventFilter | undefined,
) {
    const {
        GetSubscriptionAttributesResponse: {
            GetSubscriptionAttributesResult: { Attributes: attributes },
        },
    } = await sns<{
        GetSubscriptionAttributesResponse: {
            GetSubscriptionAttributesResult: { Attributes: { FilterPolicy?: string } }
        }
    }>(
        context,
        { Action: 'GetSubscriptionAttributes', SubscriptionArn: subscriptionArn },
        'Error getting subscription attributes.',
    )
    const current: unknown =
        attributes.FilterPolicy === undefined ? {} : JSON.parse(attributes.FilterPolicy)
    const wanted = filter ?? {}
    if (isDeepStrictEqual(current, wanted)) {
        return filter ? 'kept' : 'none'
    }
    await sns(
        context,
        {
            Action: 'SetSubscriptionAttributes',
            SubscriptionArn: subscriptionArn,
            AttributeName: 'FilterPolicy',
            AttributeValue: JSON.stringify(wanted),
        },
        'Error setting filter policy.',
    )
    if (!filter) {
        return 'cleared'
    }
    if (isDeepStrictEqual(current, {})) {
        return 'created'
    }
    return 'replaced'
}

async function sns<T>(
    context: Context,
    parameters: { [key: string]: string },
    errorMessage: string,
) {
    const response = await awsFormRequest(
        context,
        'POST',
        'sns',
        '',
        new URLSearchParams({ Version: '2010-03-31', ...parameters }),
    )
    const body = await response.text()
    if (!response.ok && body.includes('"Code":"FilterPolicyLimitExceeded"')) {
        throw new Error(
            `${errorMessage} SNS refused the filter policy: the topic or the account holds as many filter policies as its quota allows. Raise "Filter policies per topic" or "Filter policies per account" for Amazon SNS in Service Quotas.`,
        )
    }
    return await jsonResponse<T>(
        Promise.resolve({
            ok: response.ok,
            status: response.status,
            url: response.url,
            text: () => Promise.resolve(body),
            json: () => Promise.resolve(JSON.parse(body)),
        }),
        errorMessage,
    )
}
