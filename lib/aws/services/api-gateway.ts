import { jsonResponse, okResponse, throwOnNotOK } from '@riddance/fetch'
import { Reflection } from '@movogo-io/host/reflect'
import { isDeepStrictEqual } from 'node:util'
import { compare } from '../diff.js'
import { type Context, awsRequest, pages, retryConflict } from '../lite.js'

export async function syncGateway(
    context: Context,
    region: string | undefined,
    account: string | undefined,
    prefix: string,
    service: string,
    currentGateway: AwsGateway,
    reflection: Reflection,
    corsSites: string[],
) {
    if (currentGateway.api) {
        await syncGatewayApi(context, currentGateway.api, prefix, service, corsSites)
        await syncStage(context, prefix, service, currentGateway.api.apiId, currentGateway.stage)
        const { ids, surplus: surplusIntegrations } = await syncIntegrations(
            context,
            region,
            account,
            prefix,
            service,
            currentGateway.api.apiId,
            currentGateway.integrations,
            reflection,
        )
        const integrationIdByName = Object.fromEntries(ids)
        const nameByTarget = Object.fromEntries(
            ids.map(([name, integrationId]) => [`integrations/${integrationId}`, name]),
        )

        const { missing, surplus, existing } = compare(
            reflection.http,
            currentGateway.routes.map(r => ({
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                name: nameByTarget[r.target]!,
                ...r,
            })),
        )
        await Promise.all(surplus.map(i => deleteRoute(context, currentGateway.api.apiId, i)))
        await Promise.all([
            ...missing.map(fn =>
                createRoute(
                    context,
                    currentGateway.api.apiId,
                    asRoute(integrationIdByName[fn.name], fn),
                ),
            ),
            ...existing.map(async ({ name, routeId, ...ex }) => {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                const fn = reflection.http.find(f => f.name === name)!
                const route = asRoute(integrationIdByName[fn.name], fn)
                if (isDeepStrictEqual(ex, route)) {
                    return
                }
                await updateRoute(context, currentGateway.api.apiId, routeId, route)
            }),
        ])
        await Promise.all(
            surplusIntegrations.map(i =>
                deleteIntegration(
                    context,
                    region,
                    account,
                    currentGateway.api.apiId,
                    i.integrationId,
                ),
            ),
        )
        return currentGateway.api.apiId
    }
    const gateway = await createGateway(context, prefix, service, corsSites)
    const ids = await Promise.all(
        reflection.http.map(fn =>
            createIntegration(
                context,
                gateway.apiId,
                fn.name,
                asIntegration(region, account, prefix, service, fn),
            ),
        ),
    )
    const integrationIdByName = Object.fromEntries(ids)
    await Promise.all(
        reflection.http.map(fn =>
            createRoute(context, gateway.apiId, asRoute(integrationIdByName[fn.name], fn)),
        ),
    )
    return gateway.apiId
}

async function syncIntegrations(
    context: Context,
    region: string | undefined,
    account: string | undefined,
    prefix: string,
    service: string,
    apiId: string,
    currentIntegrations: (AwsIntegration & { name: string; integrationId: string })[],
    reflection: Reflection,
) {
    const { missing, surplus, existing } = compare(reflection.http, currentIntegrations)
    const ids = await Promise.all([
        ...missing.map(fn =>
            createIntegration(
                context,
                apiId,
                fn.name,
                asIntegration(region, account, prefix, service, fn),
            ),
        ),
        ...existing.map(async ({ name, integrationId, ...ex }) => {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const fn = reflection.http.find(f => f.name === name)!
            const integration = asIntegration(region, account, prefix, service, fn)
            if (isDeepStrictEqual(ex, integration)) {
                return [name, integrationId] as [string, string]
            }
            await updateIntegration(context, apiId, integrationId, integration)
            return [name, integrationId] as [string, string]
        }),
    ])
    return { ids, surplus }
}

type AwsGateway = Awaited<ReturnType<typeof getApi>>

export type AwsGatewayApi = {
    apiId: string
    name: string
    protocolType: 'HTTP' | 'REST'
    apiEndpoint: string
    corsConfiguration: {
        allowOrigins: string[]
        allowCredentials: false
        maxAge: number
        allowMethods: string[]
        allowHeaders: string[]
        exposeHeaders: string[]
    }
}

export function getApis(context: Context, prefix: string) {
    return pages(
        context,
        'apigateway',
        '/v2/apis/',
        (items: AwsGatewayApi[]) => items.filter(a => a.name.startsWith(`${prefix}-`)),
        'Error getting APIs.',
    )
}

export async function getApi(context: Context, prefix: string, service: string) {
    const name = `${prefix}-${service}`
    for await (const api of getApis(context, prefix)) {
        if (api.name === name) {
            const [integrations, routes, stage] = await Promise.all([
                Array.fromAsync(getIntegrations(context, api.apiId, name.length + 1)),
                Array.fromAsync(getRoutes(context, api.apiId)),
                getStage(context, api.apiId),
            ])
            return { api, integrations, routes, stage }
        }
    }
    return { integrations: [], routes: [] }
}

export type AwsIntegration = {
    payloadFormatVersion: '2.0'
    integrationType: 'AWS_PROXY'
    integrationMethod: string
    integrationUri: string
    connectionType: 'INTERNET'
    timeoutInMillis: number | undefined
}

function getIntegrations(context: Context, apiId: string, prefixLength: number) {
    return pages(
        context,
        'apigateway',
        `/v2/apis/${apiId}/integrations`,
        (items: (AwsIntegration & { integrationId: string })[]) =>
            items.map(i => ({
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                name: i.integrationUri.split(':').at(-1)!.slice(prefixLength),
                ...i,
            })),
        'Error getting API integrations.',
    )
}

function asIntegration(
    region: string | undefined,
    account: string | undefined,
    prefix: string,
    service: string,
    fn: { name: string; method: string; config: { timeout?: number } },
): AwsIntegration {
    if (!region || !account) {
        throw new Error('Weird')
    }
    return {
        payloadFormatVersion: '2.0',
        integrationType: 'AWS_PROXY',
        integrationMethod: fn.method,
        integrationUri: `arn:aws:lambda:${region}:${account}:function:${prefix}-${service}-${fn.name}`,
        connectionType: 'INTERNET',
        timeoutInMillis: Math.min(((fn.config.timeout ?? 15) + 5) * 1000, 30_000),
    }
}

async function createIntegration(
    context: Context,
    apiId: string,
    name: string,
    integration: AwsIntegration,
) {
    context.log.trace('creating API integration')
    const created = await retryConflict(() =>
        jsonResponse<{ integrationId: string }>(
            awsRequest(
                context,
                'POST',
                'apigateway',
                `/v2/apis/${apiId}/integrations`,
                integration,
            ),
            'Error creating API integration.',
        ),
    )
    context.log.trace(
        `  from ${apiId} to ${integration.integrationUri} as ${created.integrationId}`,
    )
    return [name, created.integrationId] as [string, string]
}

async function updateIntegration(
    context: Context,
    apiId: string,
    id: string,
    integration: AwsIntegration,
) {
    context.log.trace('updating API integration ' + id)
    context.log.trace(`  from ${apiId} to ${integration.integrationUri}`)
    await okResponse(
        awsRequest(
            context,
            'PATCH',
            'apigateway',
            `/v2/apis/${apiId}/integrations/${id}`,
            integration,
        ),
        'Error updating API integration',
    )
}

async function deleteIntegration(
    context: Context,
    region: string | undefined,
    account: string | undefined,
    apiId: string,
    id: string,
) {
    if (!region || !account) {
        throw new Error('Weird')
    }
    context.log.trace('deleting API integration ' + id)
    await okResponse(
        awsRequest(context, 'DELETE', 'apigateway', `/v2/apis/${apiId}/integrations/${id}`),
        'Error deleting API integration.',
    )
}

export type AwsRoute = {
    routeKey: string
    authorizationType: 'NONE'
    apiKeyRequired: false
    target: string
}

function asRoute(
    integrationId: string | undefined,
    fn: { method: 'GET' | 'PATCH' | 'PUT' | 'POST' | 'DELETE'; pathPattern: string },
): AwsRoute {
    if (!integrationId) {
        throw new Error(`Weird: no integration ID for ${fn.method} ${fn.pathPattern}`)
    }
    let p = 0
    return {
        routeKey: `${fn.method} /${trimTrailingSlash(
            fn.pathPattern.replaceAll('*', () => `{p${++p}}`),
        )}`,
        authorizationType: 'NONE',
        apiKeyRequired: false,
        target: `integrations/${integrationId}`,
    }
}

function trimTrailingSlash(pathPattern: string) {
    if (pathPattern.endsWith('/')) {
        return pathPattern.slice(0, Math.max(0, pathPattern.length - 1))
    }
    return pathPattern
}

function getRoutes(context: Context, apiId: string) {
    return pages(
        context,
        'apigateway',
        `/v2/apis/${apiId}/routes`,
        (routes: (AwsRoute & { routeId: string })[]) => routes,
        'Error getting API routes.',
    )
}

async function createRoute(context: Context, apiId: string, route: AwsRoute) {
    context.log.trace(`creating route ${route.routeKey} to ${route.target}`)
    await retryConflict(() =>
        okResponse(
            awsRequest(context, 'POST', 'apigateway', `/v2/apis/${apiId}/routes`, route),
            'Error creating API route.',
        ),
    )
}

async function updateRoute(context: Context, apiId: string, id: string, route: AwsRoute) {
    context.log.trace(`updating API route ${id} to ${route.target}`)
    await okResponse(
        awsRequest(context, 'PATCH', 'apigateway', `/v2/apis/${apiId}/routes/${id}`, route),
        'Error updating API route.',
    )
}

async function deleteRoute(context: Context, apiId: string, route: AwsRoute & { routeId: string }) {
    context.log.trace(`deleting API route ${route.routeId} from ${route.target}`)
    await okResponse(
        awsRequest(context, 'DELETE', 'apigateway', `/v2/apis/${apiId}/routes/${route.routeId}`),
        'Error deleting API route.',
    )
}

async function createGateway(
    context: Context,
    prefix: string,
    service: string,
    corsSites: string[],
) {
    context.log.trace('creating gateway')
    const gateway = await jsonResponse<{ apiId: string }>(
        awsRequest(context, 'POST', 'apigateway', `/v2/apis/`, {
            name: `${prefix}-${service}`,
            protocolType: 'HTTP',
            corsConfiguration: corsSettings(corsSites),
            tags: {
                framework: 'riddance',
                environment: prefix,
                service,
            },
        }),
        'Error creating gateway.',
    )
    await syncStage(context, prefix, service, gateway.apiId, undefined)
    return gateway
}

async function syncGatewayApi(
    context: Context,
    gateway: AwsGatewayApi,
    prefix: string,
    service: string,
    corsSites: string[],
) {
    const corsConfiguration = corsSettings(corsSites)
    if (isDeepStrictEqual(corsConfiguration, gateway.corsConfiguration)) {
        return
    }
    context.log.trace('updating gateway')
    await okResponse(
        awsRequest(context, 'PATCH', 'apigateway', `/v2/apis/${gateway.apiId}`, {
            name: `${prefix}-${service}`,
            protocolType: 'HTTP',
            corsConfiguration,
            tags: {
                framework: 'riddance',
                environment: prefix,
                service,
            },
        }),
        'Error updating gateway.',
    )
}

function corsSettings(corsSites: string[]) {
    return {
        allowOrigins: corsSites,
        allowCredentials: !isDeepStrictEqual(corsSites, ['*']),
        maxAge: 600,
        allowMethods: ['*'],
        allowHeaders: ['*'],
        exposeHeaders: ['*'],
    }
}

export type ApiStage = {
    stageName: string
    description: string
    deploymentId: string
    clientCertificateId: string
    defaultRouteSettings: {
        detailedMetricsEnabled: boolean
        loggingLevel: 'INFO' | 'ERROR' | 'OFF'
        dataTraceEnabled: boolean
        throttlingBurstLimit: number
        throttlingRateLimit: number
    }
    routeSettings: { [key: string]: string }
    stageVariables: { [key: string]: string }
    accessLogSettings: {
        format: string
        destinationArn: string
    }
    autoDeploy: boolean
    lastDeploymentStatusMessage: string
    createdDate: string
    lastUpdatedDate: string
    tags: { [key: string]: string }
    apiGatewayManaged: boolean
}

async function getStage(context: Context, apiId: string) {
    const response = await awsRequest(
        context,
        'GET',
        'apigateway',
        `/v2/apis/${apiId}/stages/$default`,
    )
    if (response.status === 404) {
        return undefined
    }
    await throwOnNotOK(response, 'Error getting API stage.')
    return (await response.json()) as ApiStage
}

async function syncStage(
    context: Context,
    prefix: string,
    service: string,
    apiId: string,
    stage: ApiStage | undefined,
) {
    if (!stage) {
        await okResponse(
            awsRequest(context, 'POST', 'apigateway', `/v2/apis/${apiId}/stages`, {
                stageName: '$default',
                autoDeploy: true,
                tags: {
                    framework: 'riddance',
                    environment: prefix,
                    service,
                },
            }),
            'Error creating stage.',
        )
    }
}
