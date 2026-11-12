import assert from 'node:assert/strict'
import { Resolver } from '../lib/aws/resolve.js'
import { getFunctions } from '../lib/aws/services/lambda.js'
import { context, stubAws } from './lib/aws.js'

describe('function listing', () => {
    it('is made once for every sibling the glue references and for the service itself', async () => {
        const pages: { [marker: string]: unknown } = {
            '': {
                Functions: [
                    {
                        FunctionName: 'w1-customers-get',
                        FunctionArn: 'arn:customers-get',
                        Environment: { Variables: { API_KEY: 'customers-key' } },
                    },
                    {
                        FunctionName: 'w1-rentals-create',
                        FunctionArn: 'arn:rentals-create',
                        Environment: { Variables: { API_KEY: 'rentals-key' } },
                    },
                ],
                NextMarker: 'second',
            },
            second: {
                Functions: [
                    {
                        FunctionName: 'w1-pricing-quote',
                        FunctionArn: 'arn:pricing-quote',
                        Environment: { Variables: { PRIVATE_KEY: 'pricing-key' } },
                    },
                    { FunctionName: 'dev-pricing-quote', FunctionArn: 'arn:dev-pricing-quote' },
                ],
                // eslint-disable-next-line unicorn/no-null -- as the API ends a listing
                NextMarker: null,
            },
        }
        const aws = stubAws(({ parameters: { Marker: marker } }) =>
            typeof marker === 'string' ? pages[marker] : pages[''],
        )
        try {
            const resolver = new Resolver(context)

            const [customers, pricing, missing, own] = await Promise.all([
                resolver.getEnvironment('w1', 'customers'),
                resolver.getEnvironment('w1', 'pricing'),
                resolver.getEnvironment('w1', 'absent'),
                getFunctions(context, await resolver.accountFunctions(), 'w1', 'rentals', [
                    'create',
                ]),
            ])

            assert.deepStrictEqual(
                [customers, pricing, missing, own.map(fn => fn.name)],
                [{ API_KEY: 'customers-key' }, { PRIVATE_KEY: 'pricing-key' }, {}, ['create']],
            )
            assert.deepStrictEqual(
                aws.calls.map(call => `${call.method} ${call.service} ${call.path}`),
                ['GET lambda /2015-03-31/functions/', 'GET lambda /2015-03-31/functions/'],
            )
            assert.deepStrictEqual(
                aws.calls.map(call => call.parameters),
                [{}, { Marker: 'second' }],
            )
        } finally {
            aws.restore()
        }
    })
})
