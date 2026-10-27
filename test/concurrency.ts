import assert from 'node:assert/strict'
import { concurrencyChanges, desiredConcurrency } from '../lib/aws/services/concurrency.js'

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
})
