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
    const [first] = triggers
    if (!first) {
        return
    }
    const [_arn, _aws, _lambda, region, account] = first.id.split(':', 5)
    if (!region || !account) {
        throw new Error(`Cannot read region and account from function ARN ${first.id}.`)
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
                        await unsubscribe(context, subscription.SubscriptionArn)
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

async function listLambdaSubscriptions(context: Context, topicArn: string) {
    try {
        return (await listSubscriptions(context, topicArn)).filter(s => s.Protocol === 'lambda')
    } catch (e) {
        // A new handler's topic is listed here before syncTopics creates it.
        if (isNotFound(e)) {
            return []
        }
        throw e
    }
}

export async function listSubscriptions(
    context: Context,
    topicArn: string,
    nextToken?: string,
): Promise<{ Endpoint: string; Protocol: string; SubscriptionArn: string }[]> {
    const {
        ListSubscriptionsByTopicResponse: { ListSubscriptionsByTopicResult: page },
    } = await sns<{
        ListSubscriptionsByTopicResponse: {
            ListSubscriptionsByTopicResult: {
                NextToken: string | null
                Subscriptions: { Endpoint: string; Protocol: string; SubscriptionArn: string }[]
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
    if (!page.NextToken) {
        return page.Subscriptions
    }
    return [...page.Subscriptions, ...(await listSubscriptions(context, topicArn, page.NextToken))]
}

export async function listTopicArns(context: Context, nextToken?: string): Promise<string[]> {
    const {
        ListTopicsResponse: { ListTopicsResult: page },
    } = await sns<{
        ListTopicsResponse: {
            ListTopicsResult: { NextToken: string | null; Topics: { TopicArn: string }[] }
        }
    }>(
        context,
        { Action: 'ListTopics', ...(nextToken && { NextToken: nextToken }) },
        'Error listing topics.',
    )
    const arns = page.Topics.map(topic => topic.TopicArn)
    if (!page.NextToken) {
        return arns
    }
    return [...arns, ...(await listTopicArns(context, page.NextToken))]
}

export async function getTopicTags(context: Context, topicArn: string) {
    const {
        ListTagsForResourceResponse: {
            ListTagsForResourceResult: { Tags: tags },
        },
    } = await sns<{
        ListTagsForResourceResponse: {
            ListTagsForResourceResult: { Tags: { Key: string; Value: string }[] | null }
        }
    }>(
        context,
        { Action: 'ListTagsForResource', ResourceArn: topicArn },
        `Error reading tags of topic ${topicArn}.`,
    )
    return Object.fromEntries((tags ?? []).map(tag => [tag.Key, tag.Value]))
}

export async function unsubscribe(context: Context, subscriptionArn: string) {
    await sns(
        context,
        { Action: 'Unsubscribe', SubscriptionArn: subscriptionArn },
        'Error unsubscribing from topic.',
    )
}

export async function deleteTopic(context: Context, topicArn: string) {
    await sns(
        context,
        { Action: 'DeleteTopic', TopicArn: topicArn },
        `Error deleting topic ${topicArn}.`,
    )
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
