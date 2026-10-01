import { jsonResponse } from '@riddance/fetch'
import type { Reflection } from '@movogo-io/host/reflect'
import { type Context, awsFormRequest } from '../lite.js'

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
            const lambdaArn = functions.find(f => f.name === e.name)?.id ?? ''
            await subscribe(
                context,
                region,
                account,
                prefix,
                service,
                lambdaArn,
                e.topic,
                e.type,
                fullName,
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

async function subscribe(
    context: Context,
    region: string,
    account: string,
    prefix: string,
    service: string,
    lambdaArn: string,
    name: string,
    type: string,
    fullName: string,
) {
    context.log.trace(`subscribing to ${name} ${type}`)
    await jsonResponse(
        awsFormRequest(
            context,
            'POST',
            'sns',
            '',
            new URLSearchParams({
                Action: 'Subscribe',
                Version: '2010-03-31',
                TopicArn: `arn:aws:sns:${region}:${account}:${fullName}`,
                Protocol: 'lambda',
                Endpoint: lambdaArn,
                'Tags.member.1.Key': 'framework',
                'Tags.member.1.Value': 'riddance',
                'Tags.member.2.Key': 'environment',
                'Tags.member.2.Value': prefix,
                'Tags.member.3.Key': 'service',
                'Tags.member.3.Value': service,
            }),
        ),
        'Error creating topic.',
    )
}
