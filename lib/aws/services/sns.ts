import { jsonResponse } from '@riddance/fetch'
import type { EventFilter } from '@movogo-io/host/lib/context'
import type { Reflection } from '@movogo-io/host/reflect'
import { setTimeout } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { type Context, awsFormRequest } from '../lite.js'

const listingAttemptsMax = 5

export async function syncTopics(
    context: Context,
    functions: { id: string; name: string }[],
    prefix: string,
    service: string,
    reflection: Reflection,
    region: string,
    account: string,
) {
    await Promise.all(
        reflection.events.map(async e => {
            const fullName = `${prefix}-${e.topic}-${e.type}`
            await createTopic(context, prefix, e.topic, e.type, fullName)
            const lambdaArn = functions.find(f => f.name === e.name)?.id
            if (!lambdaArn) {
                throw new Error(`No function ${e.name} to subscribe to ${fullName}.`)
            }
            const topicArn = `arn:aws:sns:${region}:${account}:${fullName}`
            const label = `${e.name} on ${fullName}`
            const subscriptionArn = await findSubscription(context, topicArn, lambdaArn)
            if (subscriptionArn) {
                await syncFilterPolicy(context, subscriptionArn, e.config.filter, label)
                return
            }
            const subscribed = await subscribe(
                context,
                prefix,
                service,
                topicArn,
                lambdaArn,
                e.config.filter,
            )
            if (subscribed) {
                context.log.trace(
                    `subscribed ${label}${e.config.filter ? ' with filter policy' : ''}`,
                )
                return
            }
            await syncFilterPolicy(
                context,
                await findLaggingSubscription(context, topicArn, lambdaArn),
                e.config.filter,
                label,
            )
        }),
    )
}

async function createTopic(
    context: Context,
    prefix: string,
    name: string,
    type: string,
    fullName: string,
) {
    context.log.trace(`creating ${name} topic for ${type}`)
    await jsonResponse(
        awsFormRequest(
            context,
            'POST',
            'sns',
            '',
            new URLSearchParams({
                Action: 'CreateTopic',
                Version: '2010-03-31',
                Name: fullName,
                'Tags.member.1.Key': 'framework',
                'Tags.member.1.Value': 'riddance',
                'Tags.member.2.Key': 'environment',
                'Tags.member.2.Value': prefix,
            }),
        ),
        'Error creating topic.',
    )
}

async function findSubscription(
    context: Context,
    topicArn: string,
    endpoint: string,
    nextToken?: string,
): Promise<string | undefined> {
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
    const found = page.Subscriptions.find(s => s.Protocol === 'lambda' && s.Endpoint === endpoint)
    if (found) {
        return found.SubscriptionArn
    }
    if (!page.NextToken) {
        return undefined
    }
    return await findSubscription(context, topicArn, endpoint, page.NextToken)
}

// The listing is eventually consistent, so SNS can refuse a Subscribe as a duplicate of a
// subscription the listing does not show yet.
async function findLaggingSubscription(
    context: Context,
    topicArn: string,
    endpoint: string,
    attempt = 1,
): Promise<string> {
    await setTimeout(1000 * attempt)
    const subscriptionArn = await findSubscription(context, topicArn, endpoint)
    if (subscriptionArn) {
        return subscriptionArn
    }
    if (listingAttemptsMax <= attempt) {
        throw new Error(
            `SNS refused to subscribe ${endpoint} to ${topicArn} as already subscribed, but never listed the subscription.`,
        )
    }
    return await findLaggingSubscription(context, topicArn, endpoint, attempt + 1)
}

async function subscribe(
    context: Context,
    prefix: string,
    service: string,
    topicArn: string,
    endpoint: string,
    filter: EventFilter | undefined,
) {
    const reply = await snsRequest(context, {
        Action: 'Subscribe',
        TopicArn: topicArn,
        Protocol: 'lambda',
        Endpoint: endpoint,
        'Tags.member.1.Key': 'framework',
        'Tags.member.1.Value': 'riddance',
        'Tags.member.2.Key': 'environment',
        'Tags.member.2.Value': prefix,
        'Tags.member.3.Key': 'service',
        'Tags.member.3.Value': service,
        ...(filter && {
            'Attributes.entry.1.key': 'FilterPolicy',
            'Attributes.entry.1.value': JSON.stringify(filter),
        }),
    })
    // SNS has no error code of its own for this refusal; its message is the only discriminator.
    if (
        reply.status === 400 &&
        reply.body.includes('"Code":"InvalidParameter"') &&
        reply.body.includes('already exists with different attributes')
    ) {
        return false
    }
    await snsResult(reply, 'Error subscribing to topic.')
    return true
}

async function syncFilterPolicy(
    context: Context,
    subscriptionArn: string,
    filter: EventFilter | undefined,
    label: string,
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
        context.log.trace(`kept filter policy of ${label}`)
        return
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
    context.log.trace(`${filterPolicyChange(current, filter)} filter policy of ${label}`)
}

function filterPolicyChange(current: unknown, filter: EventFilter | undefined) {
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
    return await snsResult<T>(await snsRequest(context, parameters), errorMessage)
}

async function snsRequest(context: Context, parameters: { [key: string]: string }) {
    const response = await awsFormRequest(
        context,
        'POST',
        'sns',
        '',
        new URLSearchParams({ Version: '2010-03-31', ...parameters }),
    )
    return {
        ok: response.ok,
        status: response.status,
        url: response.url,
        body: await response.text(),
    }
}

async function snsResult<T>(
    reply: { ok: boolean; status: number; url: string; body: string },
    errorMessage: string,
) {
    if (!reply.ok && reply.body.includes('"Code":"FilterPolicyLimitExceeded"')) {
        throw new Error(
            `${errorMessage} SNS refused the filter policy: the topic or the account holds as many filter policies as its quota allows. Raise "Filter policies per topic" or "Filter policies per account" for Amazon SNS in Service Quotas.`,
        )
    }
    return await jsonResponse<T>(
        Promise.resolve({
            ...reply,
            text: () => Promise.resolve(reply.body),
            json: () => Promise.resolve(JSON.parse(reply.body)),
        }),
        errorMessage,
    )
}
