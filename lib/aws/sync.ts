import type { Reflection } from '@movogo-io/host/reflect'
import { type Context } from './lite.js'
import { getApi, syncGateway } from './services/api-gateway.js'
import { logQueryLink } from './services/cloud-watch.js'
import { syncTimeToLive } from './services/dynamodb.js'
import { syncEventBridge } from './services/event-bridge.js'
import { type Concurrency, desiredConcurrency, syncConcurrency } from './services/concurrency.js'
import type { Layers } from './services/layers.js'
import { type AwsFunction, getFunctions, syncLambda } from './services/lambda.js'
import {
    assignPolicy,
    checkPolicyStatements,
    getRole,
    permissionsBoundary,
    syncRole,
} from './services/roles.js'
import { syncTopics, unsubscribeSurplus } from './services/sns.js'
import { getTriggers, syncTriggers } from './services/triggers.js'

export async function getCurrentState(
    context: Context,
    prefix: string,
    service: string,
    reflectedNames: string[],
    accountFunctions: Promise<AwsFunction[]>,
) {
    const [role, { functions, triggers }, apis] = await Promise.all([
        getRole(context, prefix, service),
        getFunctionsWithTriggers(context, prefix, service, reflectedNames, accountFunctions),
        getApi(context, prefix, service),
    ])
    return { role, functions, triggers, apis }
}

async function getFunctionsWithTriggers(
    context: Context,
    prefix: string,
    service: string,
    reflectedNames: string[],
    accountFunctions: Promise<AwsFunction[]>,
) {
    const functions = await getFunctions(
        context,
        await accountFunctions,
        prefix,
        service,
        reflectedNames,
    )
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
    code: { [name: string]: { fileName: string; code: string } },
    layers: Layers,
    provider: {
        aws?: {
            policyStatements?: unknown
            concurrency?: Concurrency
            permissionsBoundary?: unknown
        }
    },
    ownedTimerNames: string[],
    newTimers: 'disabled' | undefined,
) {
    const functionNames = [...reflection.http, ...reflection.events, ...reflection.timers].map(
        fn => fn.name,
    )
    const concurrency = desiredConcurrency(reflection, provider.aws?.concurrency ?? {})
    const policyStatements = checkPolicyStatements(provider.aws?.policyStatements ?? [])

    const boundary = permissionsBoundary(provider.aws?.permissionsBoundary, context.env, prefix)

    const role = await syncRole(context, prefix, service, currentState.role, boundary)

    await unsubscribeSurplus(context, prefix, currentState.triggers, reflection)

    const fns = await syncLambda(
        context,
        prefix,
        currentState.functions,
        reflection,
        environment,
        role,
        code,
        layers,
    )
    await syncConcurrency(context, prefix, service, functionNames, concurrency)
    const [_arn, _aws, _lambda, region, account, _function, _name] = fns[0]?.id.split(':') ?? []
    if (!region || !account) {
        throw new Error('Weird')
    }

    await assignPolicy(context, prefix, service, region, account, publishTopics, policyStatements)

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

    // With no HTTP entrypoint left, an API the stage has still loses its routes and integrations.
    const gatewayId =
        !existingGatewayId && reflection.http.length === 0
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
    await syncEventBridge(
        context,
        region,
        account,
        prefix,
        service,
        reflection,
        ownedTimerNames,
        newTimers,
    )
    await syncTimeToLive(context, prefix, service)

    return {
        logLink: logQueryLink(
            region,
            prefix,
            service,
            [...reflection.http, ...reflection.timers, ...reflection.events].map(fn => fn.name),
            reflection.revision,
        ),
        host:
            !gatewayId || reflection.http.length === 0
                ? undefined
                : `https://${gatewayId}.execute-api.${region}.amazonaws.com/`,
    }
}
