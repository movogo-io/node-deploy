import { jsonResponse, okResponse } from '@riddance/fetch'
import { Reflection } from '@movogo-io/host/reflect'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { type Context, awsRequest, isNotFound } from '../lite.js'

export async function syncTriggers(
    context: Context,
    prefix: string,
    service: string,
    functions: { id: string; name: string }[],
    reflection: Reflection,
    region: string,
    account: string,
    apiGatewayId: string | undefined,
) {
    const currentTriggers = await getTriggers(context, prefix, service, functions)
    await Promise.all([
        ...reflection.http.map(async fn => {
            if (!apiGatewayId) {
                throw new Error('Need API Gateway for http triggers.')
            }
            const trigger = currentTriggers.find(t => t.name === fn.name)
            if (!trigger) {
                const statement = makeApiGatewayStatementData(
                    region,
                    account,
                    apiGatewayId,
                    functions.find(f => f.name === fn.name)?.id ?? '',
                    fn,
                )
                await addTrigger(context, prefix, service, fn.name, randomUUID(), statement)
                return
            }
            const statement = makeApiGatewayStatementData(
                region,
                account,
                apiGatewayId,
                trigger.id,
                fn,
            )
            await syncTrigger(trigger, statement, context, prefix, service, fn.name)
        }),
        ...reflection.timers.map(async fn => {
            const trigger = currentTriggers.find(t => t.name === fn.name)
            if (!trigger) {
                const statement = makeEventBridgeStatementData(
                    region,
                    account,
                    functions.find(f => f.name === fn.name)?.id ?? '',
                    prefix,
                    service,
                    fn.name,
                )
                await addTrigger(context, prefix, service, fn.name, randomUUID(), statement)
                return
            }
            const statement = makeEventBridgeStatementData(
                region,
                account,
                trigger.id,
                prefix,
                service,
                fn.name,
            )
            await syncTrigger(trigger, statement, context, prefix, service, fn.name)
        }),
        ...reflection.events.map(async fn => {
            const trigger = currentTriggers.find(t => t.name === fn.name)
            if (!trigger) {
                const statement = makeSnsStatementData(
                    region,
                    account,
                    functions.find(f => f.name === fn.name)?.id ?? '',
                    prefix,
                    fn.topic,
                    fn.type,
                )
                await addTrigger(context, prefix, service, fn.name, randomUUID(), statement)
                return
            }
            const statement = makeSnsStatementData(
                region,
                account,
                trigger.id,
                prefix,
                fn.topic,
                fn.type,
            )
            await syncTrigger(trigger, statement, context, prefix, service, fn.name)
        }),
    ])
}

export type AwsTrigger = {
    id: string
    name: string
    config?: {
        method: string
        pathPattern: string
    }
    statements?: AwsStatement[]
}

type AwsStatement = {
    Sid: string
    Effect: string
    Principal: { Service: string }
    Action: string
    Resource: string
    Condition: unknown
}

async function syncTrigger(
    trigger: AwsTrigger,
    statement: StatementData,
    context: Context,
    prefix: string,
    service: string,
    name: string,
) {
    let exists = false
    if (trigger.statements) {
        for (const { Sid, ...data } of trigger.statements) {
            if (isDeepStrictEqual(data, statement)) {
                if (exists) {
                    await deleteTrigger(context, prefix, service, name, Sid)
                } else {
                    exists = true
                }
            } else {
                await deleteTrigger(context, prefix, service, name, Sid)
            }
        }
    }
    if (!exists) {
        await addTrigger(context, prefix, service, name, randomUUID(), statement)
    }
}

export async function getTriggers(
    context: Context,
    prefix: string,
    service: string,
    functions: { id: string; name: string }[],
): Promise<AwsTrigger[]> {
    return await Promise.all(
        functions.map(async fn => {
            try {
                return {
                    id: fn.id,
                    name: fn.name,
                    statements: (
                        JSON.parse(
                            (
                                await jsonResponse<{ Policy: string }>(
                                    awsRequest(
                                        context,
                                        'GET',
                                        'lambda',
                                        `/2015-03-31/functions/${prefix}-${service}-${fn.name}/policy/`,
                                    ),
                                    'Error getting triggers.',
                                )
                            ).Policy,
                        ) as { Statement: AwsStatement[] }
                    ).Statement,
                }
            } catch (e) {
                if (isNotFound(e)) {
                    return {
                        id: fn.id,
                        name: fn.name,
                    }
                }
                throw e
            }
        }),
    )
}

async function addTrigger(
    context: Context,
    prefix: string,
    service: string,
    name: string,
    id: string,
    statement: StatementData,
) {
    const arn = statement.Condition.ArnLike['AWS:SourceArn']
    context.log.trace(`adding trigger ${id} to lambda ${name}`)
    context.log.trace(`  from ${arn}`)
    await okResponse(
        awsRequest(
            context,
            'POST',
            'lambda',
            `/2015-03-31/functions/${prefix}-${service}-${name}/policy/`,
            {
                StatementId: id,
                Action: statement.Action,
                Principal: statement.Principal.Service,
                SourceArn: arn,
            },
        ),
        'Error adding triggers.',
    )
}

async function deleteTrigger(
    context: Context,
    prefix: string,
    service: string,
    name: string,
    id: string,
) {
    context.log.trace(`deleting trigger ${id} from ${name}`)
    await okResponse(
        awsRequest(
            context,
            'DELETE',
            'lambda',
            `/2015-03-31/functions/${prefix}-${service}-${name}/policy/${id}`,
        ),
        'Error deleting triggers.',
    )
}

function makeApiGatewayStatementData(
    region: string,
    account: string,
    apiGatewayId: string,
    functionId: string,
    fn: {
        pathPattern: string
    },
) {
    let p = 0
    return makeStatementData(
        region,
        account,
        functionId,
        'apigateway.amazonaws.com',
        `arn:aws:execute-api:${region}:${account}:${apiGatewayId}/*/*/${trimTrailingSlash(
            fn.pathPattern.replaceAll('*', () => `{p${++p}}`),
        )}`,
    )
}

function makeEventBridgeStatementData(
    region: string,
    account: string,
    functionId: string,
    prefix: string,
    service: string,
    name: string,
) {
    return makeStatementData(
        region,
        account,
        functionId,
        'events.amazonaws.com',
        `arn:aws:events:${region}:${account}:rule/${prefix}-${service}-${name}`,
    )
}

function makeSnsStatementData(
    region: string,
    account: string,
    functionId: string,
    prefix: string,
    topic: string,
    type: string,
) {
    return makeStatementData(
        region,
        account,
        functionId,
        'sns.amazonaws.com',
        `arn:aws:sns:${region}:${account}:${prefix}-${topic}-${type}`,
    )
}

type StatementData = ReturnType<typeof makeStatementData>

function makeStatementData(
    region: string | undefined,
    account: string | undefined,
    functionId: string,
    service: string,
    source: string,
) {
    if (!region || !account) {
        throw new Error('Weird')
    }
    return {
        Action: 'lambda:InvokeFunction',
        Effect: 'Allow',
        Principal: {
            Service: service,
        },
        Resource: functionId,
        Condition: {
            ArnLike: {
                'AWS:SourceArn': source,
            },
        },
    }
}

function trimTrailingSlash(pathPattern: string) {
    if (pathPattern.endsWith('/')) {
        return pathPattern.slice(0, -1)
    }
    return pathPattern
}
