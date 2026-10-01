import { jsonResponse } from '@riddance/fetch'
import type { Reflection } from '@movogo-io/host/reflect'
import { awsRequest, type Context } from '../lite.js'

export async function syncEventBridge(
    context: Context,
    region: string,
    account: string,
    prefix: string,
    service: string,
    reflection: Reflection,
) {
    await Promise.all(
        reflection.timers.map(async fn => {
            const fullName = `${prefix}-${service}-${fn.name}`
            await createRule(
                context,
                region,
                account,
                prefix,
                fn.name,
                service,
                fullName,
                fn.schedule,
            )
            await createTarget(context, region, account, fn.name, fullName)
        }),
    )
}

async function createRule(
    context: Context,
    _region: string | undefined,
    _account: string | undefined,
    prefix: string,
    name: string,
    service: string,
    fullName: string,
    schedule: string,
) {
    context.log.trace(`creating event bridge rule ${name} for ${schedule}`)
    const r = await jsonResponse<{ RuleArn: string }>(
        awsRequest(
            context,
            'POST',
            'events',
            '',
            {
                Name: fullName,
                ScheduleExpression: scheduleExpression(schedule),
                Tags: [
                    { Key: 'framework', Value: 'riddance' },
                    { Key: 'environment', Value: prefix },
                    { Key: 'service', Value: service },
                ],
            },
            'AWSEvents.PutRule',
            'application/x-amz-json-1.1',
        ),
        'Error creating event bridge schedule.',
    )
    if (!r.RuleArn) {
        throw new Error('Unexpected schedule rule response')
    }
}

async function createTarget(
    context: Context,
    region: string,
    account: string,
    name: string,
    fullName: string,
) {
    context.log.trace(`creating event bridge target ${name}`)
    const r = await jsonResponse<{ FailedEntryCount: number }>(
        awsRequest(
            context,
            'POST',
            'events',
            '',
            {
                Rule: fullName,
                Targets: [
                    {
                        Id: fullName,
                        Arn: `arn:aws:lambda:${region}:${account}:function:${fullName}`,
                    },
                ],
            },
            'AWSEvents.PutTargets',
            'application/x-amz-json-1.1',
        ),
        'Error creating event bridge schedule.',
    )
    if (r.FailedEntryCount !== 0) {
        throw new Error('Unexpected schedule rule response')
    }
}

function scheduleExpression(schedule: string) {
    const [min, h, dom, m, dow] = schedule.split(' ', 5)
    if (!min || !h || !dom || !m || !dow) {
        throw new Error('Invalid cron expression: ' + schedule)
    }
    return `cron(${min} ${h} ${dom} ${m} ${dow.replace('*', '?')} *)`
}
