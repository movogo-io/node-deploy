import assert from 'node:assert/strict'
import { isThrottled, timeToLiveAction } from '../lib/aws/services/dynamodb.js'

describe('time to live', () => {
    it('leaves a table set up by hand alone', () => {
        assert.deepStrictEqual(
            [
                timeToLiveAction({ TimeToLiveStatus: 'ENABLED', AttributeName: 'ttl' }),
                timeToLiveAction({ TimeToLiveStatus: 'ENABLING', AttributeName: 'ttl' }),
                timeToLiveAction({ TimeToLiveStatus: 'DISABLING', AttributeName: 'expiresAt' }),
            ],
            ['leave', 'leave', 'leave'],
        )
    })

    it('enables it where it is missing', () => {
        assert.deepStrictEqual(
            [
                timeToLiveAction(undefined),
                timeToLiveAction({}),
                timeToLiveAction({ TimeToLiveStatus: 'DISABLED' }),
            ],
            ['enable', 'enable', 'enable'],
        )
    })

    it('does nothing where it is on the driver attribute', () => {
        assert.deepStrictEqual(
            [
                timeToLiveAction({ TimeToLiveStatus: 'ENABLED', AttributeName: 'expiresAt' }),
                timeToLiveAction({ TimeToLiveStatus: 'ENABLING', AttributeName: 'expiresAt' }),
            ],
            ['none', 'none'],
        )
    })
})

describe('throttling', () => {
    it('retries what DynamoDB throttles with a 400', async () => {
        assert.deepStrictEqual(
            await Promise.all(
                [
                    'com.amazonaws.dynamodb.v20120810#ThrottlingException',
                    'com.amazonaws.dynamodb.v20120810#RequestLimitExceeded',
                    'com.amazonaws.dynamodb.v20120810#ProvisionedThroughputExceededException',
                ].map(type => isThrottled(Response.json({ __type: type }, { status: 400 }))),
            ),
            [true, true, true],
        )
    })

    it('does not retry a real client error', async () => {
        assert.deepStrictEqual(
            await Promise.all([
                isThrottled(
                    Response.json(
                        { __type: 'com.amazonaws.dynamodb.v20120810#ResourceNotFoundException' },
                        { status: 400 },
                    ),
                ),
                isThrottled(Response.json({}, { status: 400 })),
                isThrottled(Response.json({}, { status: 200 })),
            ]),
            [false, false, false],
        )
    })
})
