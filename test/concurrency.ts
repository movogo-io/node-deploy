import assert from 'node:assert/strict'
import { checkConcurrency, concurrencyChanges } from '../lib/aws/services/concurrency.js'

describe('reserved concurrency', () => {
    it('refuses a name the service has no function of', () => {
        assert.throws(
            () => {
                checkConcurrency(['get', 'reconcile-due'], { 'reconcile-dew': 25 })
            },
            {
                message:
                    'aws.concurrency names reconcile-dew, which the service has no function of.',
            },
        )
    })

    it('refuses a cap that is no positive integer', () => {
        assert.throws(
            () => {
                checkConcurrency(['reconcile-due'], { 'reconcile-due': 0 })
            },
            {
                message: 'aws.concurrency of reconcile-due must be a positive integer, not 0.',
            },
        )
        assert.throws(
            () => {
                checkConcurrency(['reconcile-due'], { 'reconcile-due': 2.5 })
            },
            {
                message: 'aws.concurrency of reconcile-due must be a positive integer, not 2.5.',
            },
        )
    })

    it('reserves what the glue names, removes what it no longer names, and leaves the rest', () => {
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
