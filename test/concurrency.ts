import assert from 'node:assert/strict'
import {
    concurrencyChanges,
    desiredConcurrency,
    syncConcurrency,
} from '../lib/aws/services/concurrency.js'
import { context, stubAws } from './lib/aws.js'

describe('reserved concurrency', () => {
    const http = [{ name: 'get', method: 'GET' as const, pathPattern: 'views/*', config: {} }]
    const timers = [{ name: 'reconcile-nightly', schedule: '0 3 * * *', config: {} }]
    const events = [
        {
            name: 'reconcile-due',
            topic: 'view',
            type: 'reconcile-due',
            config: { timeout: 900, concurrencyMax: 25 },
        },
        { name: 'document-changed', topic: 'document', type: 'changed', config: {} },
    ]

    it('refuses a cap on an http or timer handler', () => {
        // As a service on a host that types the option would hand it to an HTTP or timer handler.
        const capped = { timeout: 15, concurrencyMax: 5 }
        assert.throws(
            () =>
                desiredConcurrency(
                    {
                        http: [
                            { name: 'get', method: 'GET', pathPattern: 'views/*', config: capped },
                        ],
                        timers: [
                            { name: 'reconcile-nightly', schedule: '0 3 * * *', config: capped },
                        ],
                        events,
                    },
                    {},
                ),
            {
                message: 'concurrencyMax is for event handlers only, not get, reconcile-nightly.',
            },
        )
    })

    it('refuses a glue name the service has no event function of', () => {
        assert.throws(() => desiredConcurrency({ http, timers, events }, { get: 5 }), {
            message: 'aws.concurrency names get, which the service has no event function of.',
        })
        assert.throws(() => desiredConcurrency({ http, timers, events }, { 'reconcile-dew': 25 }), {
            message:
                'aws.concurrency names reconcile-dew, which the service has no event function of.',
        })
    })

    it('refuses a glue cap that is no positive integer', () => {
        assert.throws(() => desiredConcurrency({ http, timers, events }, { 'reconcile-due': 0 }), {
            message: 'aws.concurrency of reconcile-due must be a positive integer, not 0.',
        })
        assert.throws(
            () => desiredConcurrency({ http, timers, events }, { 'reconcile-due': 2.5 }),
            { message: 'aws.concurrency of reconcile-due must be a positive integer, not 2.5.' },
        )
    })

    it("takes each event handler's own cap, and the glue's where it names one", () => {
        assert.deepStrictEqual(desiredConcurrency({ http, timers, events }, {}), {
            'reconcile-due': 25,
        })
        assert.deepStrictEqual(
            desiredConcurrency(
                { http, timers, events },
                { 'reconcile-due': 10, 'document-changed': 50 },
            ),
            { 'reconcile-due': 10, 'document-changed': 50 },
        )
    })

    it('reserves what is desired, removes what no longer is, and leaves the rest', () => {
        assert.deepStrictEqual(
            concurrencyChanges(
                ['get', 'reconcile-due', 'document-changed', 'reconcile-nightly'],
                { 'reconcile-due': 10, 'document-changed': 5, 'reconcile-nightly': 1 },
                { 'reconcile-due': 25, 'reconcile-nightly': 1 },
            ),
            [
                { name: 'reconcile-due', reserved: 25 },
                { name: 'document-changed', reserved: undefined },
            ],
        )
    })

    it('reserves and removes on a stage that is no slot', async () => {
        assert.deepStrictEqual(await synced('dev'), {
            writes: [
                {
                    method: 'PUT',
                    path: '/2017-10-31/functions/dev-views-reconcile-due/concurrency',
                    parameters: { ReservedConcurrentExecutions: 25 },
                },
                {
                    method: 'DELETE',
                    path: '/2017-10-31/functions/dev-views-document-changed/concurrency',
                    parameters: {},
                },
            ],
            warnings: [],
        })
        assert.deepStrictEqual(
            (await synced('w10')).writes.map(call => call.method),
            ['PUT', 'DELETE'],
        )
    })

    it('reserves nothing on a slot, says so once, and still removes a reservation', async () => {
        assert.deepStrictEqual(await synced('w9'), {
            writes: [
                {
                    method: 'DELETE',
                    path: '/2017-10-31/functions/w9-views-document-changed/concurrency',
                    parameters: {},
                },
            ],
            warnings: [
                'reserved concurrency skipped for reconcile-due: w9 is a slot, and a slot reserves none',
            ],
        })
    })
})

// A service whose `reconcile-due` declares 25 and holds none, and whose `document-changed`
// declares none and holds 5.
async function synced(stage: string) {
    const warnings: string[] = []
    const aws = stubAws(call =>
        call.method === 'GET' && call.path.endsWith('-document-changed/concurrency')
            ? { ReservedConcurrentExecutions: 5 }
            : {},
    )
    try {
        await syncConcurrency(
            {
                ...context,
                log: {
                    ...context.log,
                    warn: message => {
                        warnings.push(message)
                    },
                },
            },
            stage,
            'views',
            ['get', 'reconcile-due', 'document-changed'],
            { 'reconcile-due': 25 },
        )
        return {
            writes: aws.calls
                .filter(call => call.method !== 'GET')
                .map(({ method, path, parameters }) => ({ method, path, parameters })),
            warnings,
        }
    } finally {
        aws.restore()
    }
}
