import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { awsFormRequest, awsRequest, isThrottled, throttleDelayMs } from '../lib/aws/lite.js'
import { context, stubAws } from './lib/aws.js'

describe('throttling', () => {
    it('does not take a real client error for a throttle', async () => {
        assert.deepStrictEqual(
            await Promise.all([
                isThrottled(
                    Response.json(
                        { __type: 'com.amazonaws.dynamodb.v20120810#ResourceNotFoundException' },
                        { status: 400 },
                    ),
                ),
                isThrottled(Response.json({ Error: { Code: 'NoSuchEntity' } }, { status: 400 })),
                isThrottled(new Response('<Code>MalformedPolicyDocument</Code>', { status: 400 })),
                isThrottled(new Response('not json', { status: 400 })),
                isThrottled(Response.json({}, { status: 400 })),
                isThrottled(Response.json({ __type: 'ThrottlingException' }, { status: 500 })),
                isThrottled(Response.json({}, { status: 200 })),
            ]),
            [false, false, false, false, false, false, false],
        )
    })

    it('knows the throttles of Lambda, IAM, EventBridge and DynamoDB', async () => {
        assert.deepStrictEqual(
            await Promise.all([
                isThrottled(
                    Response.json({ Type: 'User', message: 'Rate exceeded' }, { status: 429 }),
                ),
                isThrottled(
                    Response.json(
                        { Error: { Code: 'Throttling', Message: 'Rate exceeded', Type: 'Sender' } },
                        { status: 400 },
                    ),
                ),
                isThrottled(
                    new Response(
                        '<ErrorResponse><Error><Type>Sender</Type><Code>Throttling</Code><Message>Rate exceeded</Message></Error></ErrorResponse>',
                        { status: 400 },
                    ),
                ),
                isThrottled(
                    Response.json(
                        { __type: 'ThrottlingException', message: 'Rate exceeded' },
                        { status: 400 },
                    ),
                ),
                ...[
                    'com.amazonaws.dynamodb.v20120810#ThrottlingException',
                    'com.amazonaws.dynamodb.v20120810#RequestLimitExceeded',
                    'com.amazonaws.dynamodb.v20120810#ProvisionedThroughputExceededException',
                ].map(type => isThrottled(Response.json({ __type: type }, { status: 400 }))),
            ]),
            [true, true, true, true, true, true, true],
        )
    })

    it('waits up to a ceiling that doubles from half a second to 16 seconds', () => {
        assert.deepStrictEqual(
            [0, 1, 2, 3, 4, 5, 6, 7].map(retries => throttleDelayMs(retries, undefined, 1)),
            [500, 1000, 2000, 4000, 8000, 16_000, 16_000, 16_000],
        )
        assert.deepStrictEqual(
            [0, 7].map(retries => throttleDelayMs(retries, undefined, 0.5)),
            [250, 8000],
        )
    })

    it('waits at least as long as Retry-After asks, up to 16 seconds', () => {
        assert.deepStrictEqual(
            [
                throttleDelayMs(0, '3', 1),
                throttleDelayMs(5, '3', 1),
                throttleDelayMs(0, '600', 0),
                throttleDelayMs(0, 'x', 0),
            ],
            [3000, 16_000, 16_000, 0],
        )
    })

    it('retries what IAM and EventBridge throttle with a 400, and what Lambda throttles with a 429', async () => {
        mock.method(Math, 'random', () => 0)
        const throttles = [
            Response.json(
                { Error: { Code: 'Throttling', Message: 'Rate exceeded' } },
                { status: 400 },
            ),
            Response.json({ __type: 'ThrottlingException' }, { status: 400 }),
            Response.json({ message: 'CallerRateLimitExceeded' }, { status: 429 }),
        ]
        const stub = stubAws(call => throttles[stub.calls.indexOf(call)] ?? { Ok: true })
        try {
            const response = await awsFormRequest(
                context,
                'POST',
                'iam',
                '/',
                new URLSearchParams({ Action: 'GetRole' }),
            )

            assert.deepStrictEqual(
                { status: response.status, body: await response.json(), calls: stub.calls.length },
                { status: 200, body: { Ok: true }, calls: 4 },
            )
        } finally {
            stub.restore()
            mock.restoreAll()
        }
    })

    it('answers a real client error at once, with its body', async () => {
        const stub = stubAws(() =>
            Response.json({ __type: 'ValidationException', message: 'bad' }, { status: 400 }),
        )
        try {
            const response = await awsRequest(
                context,
                'POST',
                'events',
                '/',
                {},
                'AWSEvents.PutRule',
            )

            assert.deepStrictEqual(
                { status: response.status, body: await response.json(), calls: stub.calls.length },
                { status: 400, body: { __type: 'ValidationException', message: 'bad' }, calls: 1 },
            )
        } finally {
            stub.restore()
        }
    })

    it('gives up after eight retries and answers the last throttle', async () => {
        mock.method(Math, 'random', () => 0)
        const stub = stubAws(() =>
            Response.json(
                { __type: 'ThrottlingException', message: 'Rate exceeded' },
                { status: 400 },
            ),
        )
        try {
            const response = await awsRequest(
                context,
                'POST',
                'events',
                '/',
                {},
                'AWSEvents.PutRule',
            )

            assert.deepStrictEqual(
                { status: response.status, body: await response.json(), calls: stub.calls.length },
                {
                    status: 400,
                    body: { __type: 'ThrottlingException', message: 'Rate exceeded' },
                    calls: 9,
                },
            )
        } finally {
            stub.restore()
            mock.restoreAll()
        }
    })
})
