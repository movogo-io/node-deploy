import assert from 'node:assert/strict'
import { selectOwnFunctions } from '../lib/aws/services/lambda.js'

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
