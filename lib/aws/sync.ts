import type { Reflection } from '@movogo-io/host/reflect'
import { type Context } from './lite.js'
import { getApi, syncGateway } from './services/api-gateway.js'
import { logQueryLink } from './services/cloud-watch.js'
import { syncTimeToLive } from './services/dynamodb.js'
import { syncEventBridge } from './services/event-bridge.js'
import { type Concurrency, checkConcurrency, syncConcurrency } from './services/concurrency.js'
import { getFunctions, syncLambda } from './services/lambda.js'
import { assignPolicy, getRole, syncRole } from './services/roles.js'
import { syncTopics, unsubscribeSurplus } from './services/sns.js'
import { getTriggers, syncTriggers } from './services/triggers.js'

export async function getCurrentState(
    context: Context,
    prefix: string,
    service: string,
    reflectedNames: string[],
) {
    const [role, { functions, triggers }, apis] = await Promise.all([
        getRole(context, prefix, service),
        getFunctionsWithTriggers(context, prefix, service, reflectedNames),
        getApi(context, prefix, service),
    ])
    return { role, functions, triggers, apis }
}

async function getFunctionsWithTriggers(
    context: Context,
    prefix: string,
    service: string,
    reflectedNames: string[],
) {
    const functions = await getFunctions(context, prefix, service, reflectedNames)
    return { functions, triggers: await getTriggers(context, prefix, service, functions) }
}

export type CurrentState = Awaited<ReturnType<typeof getCurrentState>>

export async function sync(
    context: Context,
    prefix: string,
    service: string,
    currentState: CurrentState,
    reflection: Reflection,
    publishTopics: string[],
    corsSites: string[],
    environment: { [key: string]: string },
    code: { [name: string]: string },
    provider: {
        aws?: {
            policyStatements?: { Effect: string; Resource: string; Action: string[] }[]
            concurrency?: Concurrency
        }
    },
) {
    const functionNames = [...reflection.http, ...reflection.events, ...reflection.timers].map(
        fn => fn.name,
    )
    const concurrency = provider.aws?.concurrency ?? {}
    checkConcurrency(functionNames, concurrency)

    const role = await syncRole(context, prefix, service, currentState.role)

    await unsubscribeSurplus(context, prefix, currentState.triggers, reflection)

    const fns = await syncLambda(
        context,
        prefix,
        currentState.functions,
        reflection,
        environment,
        role,
        code,
    )
    await syncConcurrency(context, prefix, service, functionNames, concurrency)
    const [_arn, _aws, _lambda, region, account, _function, _name] = fns[0]?.id.split(':') ?? []
    if (!region || !account) {
        throw new Error('Weird')
    }

    await assignPolicy(
        context,
        prefix,
        service,
        region,
        account,
        publishTopics,
        provider.aws?.policyStatements ?? [],
    )

    const existingGatewayId = currentState.apis.api?.apiId
    if (existingGatewayId) {
        await syncTriggers(
            context,
            prefix,
            service,
            fns,
            currentState.triggers,
            reflection,
            region,
            account,
            existingGatewayId,
        )
    }

    const gatewayId =
        reflection.http.length === 0
            ? undefined
            : await syncGateway(
                  context,
                  region,
                  account,
                  prefix,
                  service,
                  currentState.apis,
                  reflection,
                  corsSites,
              )

    if (!existingGatewayId) {
        await syncTriggers(
            context,
            prefix,
            service,
            fns,
            currentState.triggers,
            reflection,
            region,
            account,
            gatewayId,
        )
    }

    await syncTopics(context, fns, prefix, reflection)
    await syncEventBridge(context, region, account, prefix, service, reflection)
    await syncTimeToLive(context, prefix, service)

    return {
        logLink: logQueryLink(
            region,
            prefix,
            service,
            [...reflection.http, ...reflection.timers, ...reflection.events].map(fn => fn.name),
            reflection.revision,
        ),
        host: gatewayId && `https://${gatewayId}.execute-api.${region}.amazonaws.com/`,
    }
}
