import type { Reflection } from '@movogo-io/host/reflect'
import { type Context } from './lite.js'
import { getApi, syncGateway } from './services/api-gateway.js'
import { logQueryLink } from './services/cloud-watch.js'
import { syncEventBridge } from './services/event-bridge.js'
import { getFunctions, syncLambda } from './services/lambda.js'
import { assignPolicy, getRole, syncRole } from './services/roles.js'
import { syncTopics } from './services/sns.js'
import { syncTriggers } from './services/triggers.js'

export async function getCurrentState(
    context: Context,
    prefix: string,
    service: string,
    reflectedNames: string[],
) {
    const [role, functions, apis] = await Promise.all([
        getRole(context, prefix, service),
        getFunctions(context, prefix, service, reflectedNames),
        getApi(context, prefix, service),
    ])
    return { role, functions, apis }
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
        aws?: { policyStatements: { Effect: string; Resource: string; Action: string[] }[] }
    },
) {
    const role = await syncRole(context, prefix, service, currentState.role)

    const fns = await syncLambda(
        context,
        prefix,
        currentState.functions,
        reflection,
        environment,
        role,
        code,
    )
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
        await syncTriggers(context, prefix, service, fns, reflection, region, account, gatewayId)
    }

    await syncTopics(context, fns, prefix, service, reflection, region, account)
    await syncEventBridge(context, region, account, prefix, service, reflection)

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
