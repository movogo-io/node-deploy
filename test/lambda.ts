/* eslint-disable unicorn/no-global-object-property-assignment */
// spell-checker: ignore AKIDEXAMPLE
import assert from 'node:assert/strict'
import {
    getFunctions,
    memorySize,
    selectOwnFunctions,
    syncLambda,
} from '../lib/aws/services/lambda.js'

// The decision that keeps compare() from deleting a sibling's functions: pure, so the live
// suite is not the only place it is exercised.
describe('own functions', () => {
    const candidates = [
        { FunctionName: 'staging-rentals-create', FunctionArn: 'arn:create' },
        { FunctionName: 'staging-rentals-Removed', FunctionArn: 'arn:removed' },
        { FunctionName: 'staging-rentals-v2-create', FunctionArn: 'arn:v2-create' },
        { FunctionName: 'staging-rentals-untagged', FunctionArn: 'arn:untagged' },
    ]
    const tags: { [arn: string]: { [key: string]: string } | undefined } = {
        'arn:create': { service: 'rentals', environment: 'staging' },
        'arn:removed': { service: 'rentals', environment: 'staging' },
        'arn:v2-create': { service: 'rentals-v2', environment: 'staging' },
    }

    it('keeps reflected and tagged functions, leaves the rest alone, looks up only the unreflected', async () => {
        const lookedUp: string[] = []
        const leftAlone: string[] = []
        let inFlight = 0

        const ours = await selectOwnFunctions(candidates, 'staging-rentals-', ['create'], {
            service: 'rentals',
            environment: 'staging',
            tagsOf: async fn => {
                // One read at a time, so the control plane's throttle is never met.
                assert.strictEqual(inFlight++, 0)
                lookedUp.push(fn.FunctionName)
                await Promise.resolve()
                --inFlight
                return tags[fn.FunctionArn]
            },
            leftAlone: (fn, fnTags) => {
                leftAlone.push(`${fn.FunctionName} (${fnTags?.service ?? 'untagged'})`)
            },
        })

        assert.deepStrictEqual(
            ours.map(fn => fn.FunctionName),
            ['staging-rentals-create', 'staging-rentals-Removed'],
        )
        assert.deepStrictEqual(lookedUp, [
            'staging-rentals-Removed',
            'staging-rentals-v2-create',
            'staging-rentals-untagged',
        ])
        assert.deepStrictEqual(leftAlone, [
            'staging-rentals-v2-create (rentals-v2)',
            'staging-rentals-untagged (untagged)',
        ])
    })

    it('matches a reflected name regardless of case and makes no lookup for it', async () => {
        const ours = await selectOwnFunctions(
            [{ FunctionName: 'staging-rentals-Removed' }],
            'staging-rentals-',
            ['removed'],
            {
                service: 'rentals',
                environment: 'staging',
                tagsOf: () => Promise.reject(new Error('no lookup expected')),
                leftAlone: () => {
                    throw new Error('not left alone')
                },
            },
        )

        assert.deepStrictEqual(ours, [{ FunctionName: 'staging-rentals-Removed' }])
    })

    it('leaves alone a function tagged with another environment', async () => {
        const ours = await selectOwnFunctions(
            [{ FunctionName: 'staging-rentals-create' }],
            'staging-rentals-',
            [],
            {
                service: 'rentals',
                environment: 'staging',
                tagsOf: () => Promise.resolve({ service: 'rentals', environment: 'production' }),
                leftAlone: () => undefined,
            },
        )

        assert.deepStrictEqual(ours, [])
    })
})

describe('memory size', () => {
    it('gives a function that names no compute or memory 512 MB', () => {
        assert.deepStrictEqual(
            [memorySize({ config: {} }), memorySize({ config: { timeout: 900 } })],
            [512, 512],
        )
    })

    it('gives a function asking for high compute or memory 3008 MB', () => {
        assert.deepStrictEqual(
            [
                memorySize({ config: { compute: 'high' } }),
                memorySize({ config: { memory: 'high' } }),
            ],
            [3008, 3008],
        )
    })

    it('gives a function asking for low compute or memory 128 MB', () => {
        assert.deepStrictEqual(
            [memorySize({ config: { compute: 'low' } }), memorySize({ config: { memory: 'low' } })],
            [128, 128],
        )
    })
})

describe('function layers', () => {
    const context = {
        log: {
            trace() {
                //
            },
            warn() {
                //
            },
        },
        env: {
            AWS_REGION: 'eu-north-1',
            AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE',
            AWS_SECRET_ACCESS_KEY: 'secret',
        },
    }
    const chromium = 'arn:aws:lambda:eu-north-1:123456789012:layer:chromium:3'
    const reflection = {
        name: 'compose',
        revision: undefined,
        http: [
            {
                name: 'render',
                method: 'POST' as const,
                pathPattern: 'render',
                config: { nodeVersion: '>=24' },
            },
        ],
        timers: [],
        events: [],
        emits: [],
    }
    const deployed = {
        id: 'arn:aws:lambda:eu-north-1:123456789012:function:staging-compose-render',
        name: 'render',
        runtime: 'nodejs24.x',
        memory: 512,
        timeout: 15,
        env: {},
        cpus: ['arm64' as const] satisfies ['arm64'],
        hash: 'the code deployed before',
        size: '1 KiB',
    }
    const code = { render: { fileName: 'index.mjs', code: 'export const handler = () => {}' } }
    const lambda = 'https://lambda.eu-north-1.amazonaws.com'
    const realFetch = fetch
    let requests: { request: string; layers: unknown }[] = []

    function answer(responses: Response[]) {
        requests = []
        globalThis.fetch = (input, init) => {
            const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
            requests.push({
                request: `${init?.method ?? 'GET'} ${new URL(input instanceof Request ? input.url : input).href.slice(lambda.length)}`,
                layers:
                    body !== null && typeof body === 'object' && 'Layers' in body
                        ? body.Layers
                        : undefined,
            })
            return Promise.resolve(responses[requests.length - 1] ?? Response.error())
        }
    }

    afterEach(() => {
        globalThis.fetch = realFetch
    })

    it('reads the layers a function runs with', async () => {
        answer([
            Response.json({
                Functions: [
                    {
                        FunctionArn: deployed.id,
                        FunctionName: 'staging-compose-render',
                        Runtime: 'nodejs24.x',
                        MemorySize: 512,
                        Timeout: 15,
                        Architectures: ['arm64'],
                        CodeSha256: 'the code deployed before',
                        CodeSize: 1024,
                        Layers: [{ Arn: chromium, CodeSize: 81_000_000 }],
                    },
                ],
                // eslint-disable-next-line unicorn/no-null
                NextMarker: null,
            }),
        ])

        assert.deepStrictEqual(await getFunctions(context, 'staging', 'compose', ['render']), [
            { ...deployed, layers: [chromium] },
        ])
    })

    it('creates a function with its layers', async () => {
        answer([Response.json({ FunctionArn: deployed.id })])

        await syncLambda(context, 'staging', [], reflection, {}, 'arn:role', code, {
            render: [chromium],
        })

        assert.deepStrictEqual(requests, [
            { request: 'POST /2015-03-31/functions', layers: [chromium] },
        ])
    })

    it('attaches a new layer before updating to the code that imports from it', async () => {
        answer([Response.json({}), Response.json({})])

        await syncLambda(
            context,
            'staging',
            [{ ...deployed, layers: [] }],
            reflection,
            {},
            'arn:role',
            code,
            { render: [chromium] },
        )

        assert.deepStrictEqual(requests, [
            {
                request: 'PUT /2015-03-31/functions/staging-compose-render/configuration',
                layers: [chromium],
            },
            { request: 'PUT /2015-03-31/functions/staging-compose-render/code', layers: undefined },
        ])
    })

    it('waits for Lambda to apply the new layer before updating the code', async () => {
        answer([
            Response.json({}),
            Response.json({ message: 'An update is in progress.' }, { status: 409 }),
            Response.json({}),
        ])

        await syncLambda(
            context,
            'staging',
            [{ ...deployed, layers: [] }],
            reflection,
            {},
            'arn:role',
            code,
            { render: [chromium] },
        )

        assert.deepStrictEqual(
            requests.map(r => r.request),
            [
                'PUT /2015-03-31/functions/staging-compose-render/configuration',
                'PUT /2015-03-31/functions/staging-compose-render/code',
                'PUT /2015-03-31/functions/staging-compose-render/code',
            ],
        )
    })

    it('leaves the code a function had when Lambda refuses its new layer', async () => {
        answer([Response.json({ message: 'Layer version not found.' }, { status: 400 })])

        await assert.rejects(
            syncLambda(
                context,
                'staging',
                [{ ...deployed, layers: [] }],
                reflection,
                {},
                'arn:role',
                code,
                { render: [chromium] },
            ),
            { message: 'Error updating config for lambda render' },
        )
        assert.deepStrictEqual(requests, [
            {
                request: 'PUT /2015-03-31/functions/staging-compose-render/configuration',
                layers: [chromium],
            },
        ])
    })

    it('updates the code before removing the layers the glue no longer names', async () => {
        answer([Response.json({}), Response.json({})])

        await syncLambda(
            context,
            'staging',
            [{ ...deployed, layers: [chromium] }],
            reflection,
            {},
            'arn:role',
            code,
            {},
        )

        assert.deepStrictEqual(requests, [
            { request: 'PUT /2015-03-31/functions/staging-compose-render/code', layers: undefined },
            {
                request: 'PUT /2015-03-31/functions/staging-compose-render/configuration',
                layers: [],
            },
        ])
    })

    it('leaves the configuration alone when the layers are the ones deployed', async () => {
        answer([Response.json({})])

        await syncLambda(
            context,
            'staging',
            [{ ...deployed, layers: [chromium] }],
            reflection,
            {},
            'arn:role',
            code,
            { render: [chromium] },
        )

        assert.deepStrictEqual(requests, [
            { request: 'PUT /2015-03-31/functions/staging-compose-render/code', layers: undefined },
        ])
    })
})
