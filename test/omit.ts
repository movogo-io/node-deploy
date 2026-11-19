import type { Reflection } from '@movogo-io/host/reflect'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getApi, syncGateway } from '../lib/aws/services/api-gateway.js'
import { syncEventBridge } from '../lib/aws/services/event-bridge.js'
import { getFunctions, listAccountFunctions, syncLambda } from '../lib/aws/services/lambda.js'
import { getCurrentState, sync } from '../lib/aws/sync.js'
import { getGlue, stageEntrypoints, withoutOmitted } from '../lib/glue.js'
import { context, stubAws } from './lib/aws.js'

describe('the entrypoints a glue omits', () => {
    const directory = join(tmpdir(), 'riddance', 'deploy-test-omit')
    const glueFile = join(directory, 'glue.json')
    const config = { nodeVersion: '>=24' }
    const reflection: Reflection = {
        name: 'svc',
        revision: undefined,
        http: [
            { name: 'get', method: 'GET', pathPattern: 'things/*', config },
            { name: 'internal-reset', method: 'POST', pathPattern: 'internal/reset', config },
        ],
        timers: [
            { name: 'sweep', schedule: '0 3 * * *', config },
            { name: 'internal-fault-tick', schedule: '*/5 * * * *', config },
        ],
        events: [
            { name: 'thing-changed', topic: 'things', type: 'changed', config },
            { name: 'internal-fault', topic: 'things', type: 'fault', config },
        ],
        emits: [],
    }
    const omit = ['internal-reset', 'internal-fault-tick', 'internal-fault']
    const { kept, ownedNames, ownedTimerNames } = stageEntrypoints(
        reflection,
        { omit, newTimers: undefined },
        'svc',
        glueFile,
    )
    const resolver = {
        getEnvironment: () => Promise.resolve({}),
        getBaseUrl: () => Promise.resolve(undefined),
        getParameters: () => Promise.resolve([]),
    }
    const log = {
        warn: () => {
            //
        },
    }

    const bound = { aws: { stage: 'dev' } }
    const glueWith = async (name: string, block: unknown, top: object = bound) => {
        const file = join(directory, `glue.${name}.json`)
        await writeFile(
            file,
            JSON.stringify({ ...top, implementations: {}, websites: {}, services: { svc: block } }),
        )
        return file
    }

    before(async () => {
        await mkdir(join(directory, 'svc'), { recursive: true })
        await writeFile(join(directory, 'svc', 'package.json'), JSON.stringify({ name: 'svc' }))
    })

    it('reads the names a service block omits, and none where it has no omit', async () => {
        const path = join(directory, 'svc')
        const [withOmit, without, otherService] = await Promise.all([
            getGlue(path, 'dev', resolver, await glueWith('omit', { omit }), log),
            getGlue(path, 'dev', resolver, await glueWith('plain', {}), log),
            getGlue(path, 'dev', resolver, await glueWith('absent', undefined), log),
        ])

        assert.deepStrictEqual([withOmit.omit, without.omit, otherService.omit], [omit, [], []])
    })

    it('refuses an omit that is no list of names, each once, naming the service and the file', async () => {
        for (const [name, value] of Object.entries({
            text: 'internal-reset',
            object: { 'internal-reset': true },
            number: ['internal-reset', 7],
            empty: ['internal-reset', ''],
            twice: ['internal-reset', 'get', 'internal-reset'],
            // eslint-disable-next-line unicorn/no-null -- as JSON may hold it
            none: null,
        })) {
            const file = await glueWith(`bad-${name}`, { omit: value })
            await assert.rejects(
                getGlue(join(directory, 'svc'), 'dev', resolver, file, log),
                {
                    message: `services.svc.omit in ${file} must be a list of entrypoint names, each once: an entrypoint file's name without .ts.`,
                },
                name,
            )
        }
    })

    it('refuses an omit in a glue file that declares no aws.stage, which older tools would deploy', async () => {
        for (const [name, top] of Object.entries({
            'no-aws': {},
            'no-stage': { aws: { accountId: '123456789012', region: 'eu-north-1' } },
        })) {
            const file = await glueWith(`unbound-${name}`, { omit }, top)
            await assert.rejects(
                getGlue(join(directory, 'svc'), 'dev', resolver, file, log),
                {
                    message: `services.svc.omit in ${file} needs aws.stage declared at the top level of the same file: a tool that does not know omit would deploy the entrypoints it names, and aws.stage is what makes 0.6.0 to 0.6.2 refuse the file. Nothing was changed.`,
                },
                name,
            )
        }
        const empty = await glueWith('unbound-empty', { omit: [] }, {})

        assert.deepStrictEqual(
            (await getGlue(join(directory, 'svc'), 'dev', resolver, empty, log)).omit,
            [],
        )
    })

    it('leaves the reflection as it is where nothing is omitted', () => {
        assert.strictEqual(withoutOmitted(reflection, [], 'svc', glueFile), reflection)
    })

    it('takes the omitted entrypoints of every kind out of the reflection', () => {
        assert.deepStrictEqual(kept, {
            name: 'svc',
            revision: undefined,
            http: [{ name: 'get', method: 'GET', pathPattern: 'things/*', config }],
            timers: [{ name: 'sweep', schedule: '0 3 * * *', config }],
            events: [{ name: 'thing-changed', topic: 'things', type: 'changed', config }],
            emits: [],
        })
    })

    it('refuses a name that matches no entrypoint, listing the unmatched and the entrypoints', () => {
        assert.throws(
            () =>
                withoutOmitted(
                    reflection,
                    ['internal-reset', 'internal-rest', 'Get'],
                    'svc',
                    glueFile,
                ),
            {
                message: `services.svc.omit in ${glueFile} names internal-rest, Get, which the service has no entrypoint of. Its entrypoints are get, internal-reset, sweep, internal-fault-tick, thing-changed, internal-fault. Nothing was changed.`,
            },
        )
    })

    it('refuses an omit that leaves the service no entrypoint', () => {
        assert.throws(
            () =>
                withoutOmitted(
                    reflection,
                    [...omit, 'get', 'sweep', 'thing-changed'],
                    'svc',
                    glueFile,
                ),
            {
                message: `services.svc.omit in ${glueFile} names every entrypoint of the service, which leaves nothing to deploy. Nothing was changed.`,
            },
        )
    })

    it('hands a deploy the kept entrypoints to build, every function and timer rule to own, and the glue settings', () => {
        assert.deepStrictEqual(
            stageEntrypoints(reflection, { omit, newTimers: 'disabled' }, 'svc', glueFile),
            {
                kept: {
                    name: 'svc',
                    revision: undefined,
                    http: [{ name: 'get', method: 'GET', pathPattern: 'things/*', config }],
                    timers: [{ name: 'sweep', schedule: '0 3 * * *', config }],
                    events: [{ name: 'thing-changed', topic: 'things', type: 'changed', config }],
                    emits: [],
                },
                types: { get: 'http', sweep: 'timer', 'thing-changed': 'event' },
                functionNames: ['get', 'sweep', 'thing-changed'],
                ownedNames: [
                    'get',
                    'internal-reset',
                    'sweep',
                    'internal-fault-tick',
                    'thing-changed',
                    'internal-fault',
                ],
                ownedTimerNames: ['sweep', 'internal-fault-tick'],
                newTimers: 'disabled',
                omitted: omit,
            },
        )
    })

    it('hands a deploy without omit every entrypoint to build, and only the timers as owners of rules', () => {
        assert.deepStrictEqual(
            stageEntrypoints(reflection, { omit: [], newTimers: undefined }, 'svc', glueFile),
            {
                kept: reflection,
                types: {
                    get: 'http',
                    'internal-reset': 'http',
                    sweep: 'timer',
                    'internal-fault-tick': 'timer',
                    'thing-changed': 'event',
                    'internal-fault': 'event',
                },
                functionNames: ownedNames,
                ownedNames,
                ownedTimerNames: ['sweep', 'internal-fault-tick'],
                newTimers: undefined,
                omitted: [],
            },
        )
    })

    it('creates no function for an omitted entrypoint, and deletes the untagged one a stage has', async () => {
        const code = Object.fromEntries(
            ['get', 'sweep', 'thing-changed'].map(name => [
                name,
                { fileName: 'index.js', code: 'exports.handler = () => {}' },
            ]),
        )
        const aws = stubAws(({ method, path, parameters }) => {
            if (path === '/2015-03-31/functions/') {
                return {
                    Functions: [
                        {
                            FunctionArn: arnOf('internal-reset'),
                            FunctionName: 'dev-svc-internal-reset',
                            Runtime: 'nodejs24.x',
                            MemorySize: 512,
                            Timeout: 15,
                            Architectures: ['arm64'],
                            CodeSha256: 'the code deployed before',
                            CodeSize: 1024,
                        },
                    ],
                    // eslint-disable-next-line unicorn/no-null -- as Lambda ends a listing
                    NextMarker: null,
                }
            }
            if (path.startsWith('/2017-03-31/tags/')) {
                return { Tags: {} }
            }
            return method === 'POST'
                ? { FunctionArn: `arn:function:${String(parameters.FunctionName)}` }
                : new Response('')
        })
        try {
            await syncLambda(context, 'dev', [], kept, {}, 'arn:role', code, {})
            const deployed = await getFunctions(
                context,
                await listAccountFunctions(context),
                'dev',
                'svc',
                ownedNames,
            )
            await syncLambda(context, 'dev', deployed, kept, {}, 'arn:role', code, {})

            const requests = aws.calls
                .filter(call => call.method !== 'GET')
                .map(({ method, path, parameters }) =>
                    method === 'POST'
                        ? `create ${String(parameters.FunctionName)}`
                        : `${method} ${path}`,
                )
            const created = [
                'create dev-svc-get',
                'create dev-svc-sweep',
                'create dev-svc-thing-changed',
            ]
            assert.deepStrictEqual(
                [new Set(requests.slice(0, 3)), new Set(requests.slice(3))],
                [
                    new Set(created),
                    new Set([...created, 'DELETE /2015-03-31/functions/dev-svc-internal-reset']),
                ],
            )
        } finally {
            aws.restore()
        }
    })

    it('makes no route for an omitted entrypoint, deletes the one a stage has, and changes nothing without omit', async () => {
        assert.deepStrictEqual(
            {
                fresh: (await gatewayChanges(false, kept)).filter(
                    ([request]) => request !== 'POST /v2/apis/new/stages',
                ),
                added: await gatewayChanges(true, kept),
                withoutOmit: await gatewayChanges(true, reflection),
            },
            {
                fresh: [
                    ['POST /v2/apis/', undefined],
                    ['POST /v2/apis/new/integrations', arnOf('get')],
                    ['POST /v2/apis/new/routes', 'GET /things/{p1}'],
                ],
                added: [
                    ['DELETE /v2/apis/api/routes/r-internal-reset', undefined],
                    ['DELETE /v2/apis/api/integrations/i-internal-reset', undefined],
                ],
                withoutOmit: [],
            },
        )
    })

    it('puts no rule for an omitted timer, deletes the untagged one a stage has, and leaves alone an untagged rule named for an entrypoint that is no timer', async () => {
        assert.deepStrictEqual(await ruleChangesOf(kept, ownedTimerNames), [
            'RemoveTargets dev-svc-internal-fault-tick',
            'DeleteRule dev-svc-internal-fault-tick',
            'PutRule dev-svc-sweep',
            'PutTargets dev-svc-sweep',
        ])
    })

    it('deletes no untagged rule named for an entrypoint without omit', async () => {
        const all = stageEntrypoints(
            reflection,
            { omit: [], newTimers: undefined },
            'svc',
            glueFile,
        )

        assert.deepStrictEqual(await ruleChangesOf(all.kept, all.ownedTimerNames), [
            'PutRule dev-svc-sweep',
            'PutTargets dev-svc-sweep',
            'PutRule dev-svc-internal-fault-tick',
            'PutTargets dev-svc-internal-fault-tick',
        ])
    })

    it('takes the routes and integrations off an API whose service has no HTTP entrypoint left, and keeps the API', async () => {
        const timersOnly = { ...kept, http: [], events: [] }
        const aws = stubAws(call => {
            if (call.service === 'apigateway') {
                return gatewayAnswer(true, call)
            }
            if (call.method === 'POST' && call.path === '/2015-03-31/functions') {
                return { FunctionArn: arnOf('sweep') }
            }
            switch (call.action) {
                case 'GetRole':
                    return { GetRoleResponse: { GetRoleResult: { Role: { Arn: 'arn:role' } } } }
                case 'ListRules':
                    return { Rules: [] }
                case 'PutRule':
                    return { RuleArn: 'arn:rule' }
                case 'ListTables':
                    return { TableNames: [] }
                default:
                    return { FailedEntryCount: 0 }
            }
        })
        try {
            const { host } = await sync(
                context,
                'dev',
                'svc',
                await getCurrentState(context, 'dev', 'svc', ownedNames, Promise.resolve([])),
                timersOnly,
                [],
                [],
                {},
                { sweep: { fileName: 'index.js', code: 'exports.handler = () => {}' } },
                {},
                {},
                ownedTimerNames,
                undefined,
            )

            assert.deepStrictEqual(
                {
                    host,
                    gatewayChanges: aws.calls
                        .filter(call => call.service === 'apigateway' && call.method !== 'GET')
                        .map(({ method, path }) => `${method} ${path}`),
                },
                {
                    host: undefined,
                    gatewayChanges: [
                        'DELETE /v2/apis/api/routes/r-get',
                        'DELETE /v2/apis/api/routes/r-internal-reset',
                        'DELETE /v2/apis/api/integrations/i-get',
                        'DELETE /v2/apis/api/integrations/i-internal-reset',
                    ],
                },
            )
        } finally {
            aws.restore()
        }
    })
})

function arnOf(name: string) {
    return `arn:aws:lambda:eu-north-1:123456789012:function:dev-svc-${name}`
}

function integration(name: string, method: string) {
    return {
        integrationId: `i-${name}`,
        payloadFormatVersion: '2.0',
        integrationType: 'AWS_PROXY',
        integrationMethod: method,
        integrationUri: arnOf(name),
        connectionType: 'INTERNET',
        timeoutInMillis: 20_000,
    }
}

function route(name: string, routeKey: string) {
    return {
        routeId: `r-${name}`,
        routeKey,
        authorizationType: 'NONE',
        apiKeyRequired: false,
        target: `integrations/i-${name}`,
    }
}

function gatewayAnswer(existing: boolean, call: { method: string; path: string }) {
    if (call.method !== 'GET') {
        return call.method === 'POST' ? { apiId: 'new', integrationId: 'i-new' } : new Response('')
    }
    if (call.path.endsWith('/integrations')) {
        return {
            items: [integration('get', 'GET'), integration('internal-reset', 'POST')],
        }
    }
    if (call.path.endsWith('/routes')) {
        return {
            items: [
                route('get', 'GET /things/{p1}'),
                route('internal-reset', 'POST /internal/reset'),
            ],
        }
    }
    if (call.path.includes('/stages/')) {
        return { stageName: '$default' }
    }
    return {
        items: existing
            ? [
                  {
                      apiId: 'api',
                      name: 'dev-svc',
                      corsConfiguration: {
                          allowOrigins: [],
                          allowCredentials: true,
                          maxAge: 600,
                          allowMethods: ['*'],
                          allowHeaders: ['*'],
                          exposeHeaders: ['*'],
                      },
                  },
              ]
            : [],
    }
}

async function gatewayChanges(existing: boolean, reflected: Reflection) {
    const aws = stubAws(call => gatewayAnswer(existing, call))
    try {
        await syncGateway(
            context,
            'eu-north-1',
            '123456789012',
            'dev',
            'svc',
            await getApi(context, 'dev', 'svc'),
            reflected,
            [],
        )
        return aws.calls
            .filter(call => call.method !== 'GET')
            .map(({ method, path, parameters: { integrationUri, routeKey } }) => [
                `${method} ${path}`,
                integrationUri ?? routeKey,
            ])
    } finally {
        aws.restore()
    }
}

// The stage has an untagged rule under each name: for a kept and an omitted timer, and for a
// kept and an omitted HTTP entrypoint.
async function ruleChangesOf(reflected: Reflection, ownedTimerNames: string[]) {
    const aws = stubAws(({ action, parameters }) => {
        switch (action) {
            case 'ListRules':
                return {
                    Rules: ['sweep', 'internal-fault-tick', 'get', 'internal-reset'].map(name => ({
                        Name: `dev-svc-${name}`,
                        Arn: `arn:${name}`,
                        State: 'ENABLED',
                    })),
                }
            case 'ListTagsForResource':
                return { Tags: [] }
            case 'ListTargetsByRule':
                return { Targets: [{ Id: String(parameters.Rule) }] }
            case 'PutRule':
                return { RuleArn: 'arn:rule' }
            case 'DeleteRule':
                return new Response('')
            default:
                return { FailedEntryCount: 0 }
        }
    })
    try {
        await syncEventBridge(
            context,
            'eu-north-1',
            '123456789012',
            'dev',
            'svc',
            reflected,
            ownedTimerNames,
            undefined,
        )
        return aws.calls
            .filter(call => !call.action?.startsWith('List'))
            .map(
                ({ action, parameters: { Name: name, Rule: rule } }) =>
                    `${action} ${String(name ?? rule)}`,
            )
    } finally {
        aws.restore()
    }
}
