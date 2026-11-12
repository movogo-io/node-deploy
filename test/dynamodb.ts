import assert from 'node:assert/strict'
import { timeToLiveAction } from '../lib/aws/services/dynamodb.js'

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
