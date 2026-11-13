import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { inspect } from 'node:util'
import { AwsError, awsJson, awsRequest, withoutBody } from '../lib/aws/lite.js'
import { context, recording, stubAws, thrownBy } from './lib/aws.js'

const throttle = () =>
    Response.json({ __type: 'ThrottlingException', message: 'Rate exceeded' }, { status: 400 })

describe('the JSON protocol of SSM and KMS', () => {
    it('names the operation of each service in the target and answers the parsed body', async () => {
        const aws = stubAws(() => ({ Version: 3 }))
        try {
            assert.deepStrictEqual(
                [
                    await awsJson(
                        context,
                        'ssm',
                        'PutParameter',
                        { Name: '/dev/a/B' },
                        { names: [] },
                    ),
                    await awsJson(
                        context,
                        'kms',
                        'DescribeKey',
                        { KeyId: 'alias/x' },
                        { names: [] },
                    ),
                ],
                [{ Version: 3 }, { Version: 3 }],
            )
            assert.deepStrictEqual(aws.calls, [
                {
                    method: 'POST',
                    service: 'ssm',
                    path: '/',
                    action: 'PutParameter',
                    parameters: { Name: '/dev/a/B' },
                },
                {
                    method: 'POST',
                    service: 'kms',
                    path: '/',
                    action: 'DescribeKey',
                    parameters: { KeyId: 'alias/x' },
                },
            ])
        } finally {
            aws.restore()
        }
    })

    it('answers an empty object for a call AWS answers without a body', async () => {
        const aws = stubAws(() => new Response('', { status: 200 }))
        try {
            assert.deepStrictEqual(
                await awsJson(
                    context,
                    'kms',
                    'CreateAlias',
                    { AliasName: 'alias/x' },
                    { names: [] },
                ),
                {},
            )
        } finally {
            aws.restore()
        }
    })

    it('leaves a throttle to the request beneath it and adds no retry of its own', async () => {
        mock.method(Math, 'random', () => 0)
        const once = stubAws(call =>
            once.calls.indexOf(call) === 0 ? throttle() : { Parameters: [] },
        )
        try {
            assert.deepStrictEqual(
                await awsJson(
                    context,
                    'ssm',
                    'GetParameters',
                    { Names: ['/dev/a/B'] },
                    { names: [] },
                ),
                { Parameters: [] },
            )
            assert.strictEqual(once.calls.length, 2)
        } finally {
            once.restore()
        }
        const always = stubAws(throttle)
        try {
            await assert.rejects(
                awsJson(
                    context,
                    'ssm',
                    'GetParameters',
                    { Names: ['/dev/a/B'] },
                    { names: ['/dev/a/B'] },
                ),
                { name: 'AwsError', code: 'ThrottlingException' },
            )
            assert.strictEqual(always.calls.length, 9)
        } finally {
            always.restore()
            mock.restoreAll()
        }
    })

    it('retries a 500 and a 400 TooManyUpdates five times itself, saying only the code', async () => {
        for (const failure of [
            {
                status: 500,
                body: { __type: 'InternalServerError', message: 'throwaway-sent' },
                code: 'InternalServerError',
            },
            { status: 500, body: 'no json', code: 'HTTP 500' },
            {
                status: 400,
                body: { __type: 'com.amazonaws.ssm#TooManyUpdates', message: 'throwaway-sent' },
                code: 'TooManyUpdates',
            },
        ]) {
            const { lines: traced, context: traces } = recording()
            const aws = stubAws(() =>
                typeof failure.body === 'string'
                    ? new Response(failure.body, { status: failure.status })
                    : Response.json(failure.body, { status: failure.status }),
            )
            try {
                await assert.rejects(
                    awsJson(
                        traces,
                        'ssm',
                        'DeleteParameter',
                        { Name: '/dev/a/B', Value: 'throwaway-sent' },
                        { names: ['/dev/a/B'], delayMs: 0 },
                    ),
                    {
                        name: 'AwsError',
                        message: `ssm DeleteParameter failed: ${failure.code} (/dev/a/B)`,
                        service: 'ssm',
                        operation: 'DeleteParameter',
                        code: failure.code,
                        names: ['/dev/a/B'],
                    },
                )
                assert.strictEqual(aws.calls.length, 6)
                assert.deepStrictEqual(
                    traced,
                    [1, 2, 3, 4, 5].map(n => `retrying #${n} (${failure.code})`),
                )
            } finally {
                aws.restore()
            }
        }
    })

    it('succeeds when a retried call is answered', async () => {
        const aws = stubAws(call =>
            aws.calls.indexOf(call) < 2
                ? Response.json({ __type: 'TooManyUpdates' }, { status: 400 })
                : { Version: 2 },
        )
        try {
            assert.deepStrictEqual(
                await awsJson(
                    context,
                    'ssm',
                    'DeleteParameter',
                    { Name: '/dev/a/B' },
                    { names: [], delayMs: 0 },
                ),
                { Version: 2 },
            )
            assert.strictEqual(aws.calls.length, 3)
        } finally {
            aws.restore()
        }
    })

    it('never retries a put, which may have succeeded when it failed', async () => {
        for (const failure of [
            Response.json({ __type: 'InternalFailure' }, { status: 500 }),
            Response.json({ __type: 'TooManyUpdates' }, { status: 400 }),
        ]) {
            const aws = stubAws(() => failure)
            try {
                await assert.rejects(
                    awsJson(
                        context,
                        'ssm',
                        'PutParameter',
                        { Name: '/dev/a/B' },
                        { names: ['/dev/a/B'], delayMs: 0 },
                    ),
                    { name: 'AwsError' },
                )
                assert.strictEqual(aws.calls.length, 1)
            } finally {
                aws.restore()
            }
        }
    })

    it('says nothing of an answer it cannot read', async () => {
        const aws = stubAws(() => new Response('throwaway-answered is no JSON', { status: 200 }))
        try {
            const error = await thrownBy(() =>
                awsJson(
                    context,
                    'ssm',
                    'GetParameter',
                    { Name: '/dev/a/B' },
                    { names: ['/dev/a/B'] },
                ),
            )
            assert.ok(error instanceof AwsError)
            assert.deepStrictEqual(
                [
                    error.message,
                    inspect(error, { depth: 10, showHidden: true }).includes('throwaway'),
                ],
                ['ssm GetParameter failed: UnreadableAnswer (/dev/a/B)', false],
            )
        } finally {
            aws.restore()
        }
    })

    it('fails a client error at once', async () => {
        const aws = stubAws(() =>
            Response.json({ __type: 'ParameterAlreadyExists', message: 'exists' }, { status: 400 }),
        )
        try {
            await assert.rejects(
                awsJson(
                    context,
                    'ssm',
                    'PutParameter',
                    { Name: '/dev/a/B' },
                    { names: ['/dev/a/B'] },
                ),
                { message: 'ssm PutParameter failed: ParameterAlreadyExists (/dev/a/B)' },
            )
            assert.strictEqual(aws.calls.length, 1)
        } finally {
            aws.restore()
        }
    })

    it('keeps the value sent and the value answered out of the error and out of every trace line', async () => {
        mock.method(Math, 'random', () => 0)
        const answers = [
            Response.json(
                { __type: 'ThrottlingException', message: 'throwaway-answered' },
                { status: 400 },
            ),
            Response.json(
                { __type: 'InternalFailure', message: 'throwaway-answered' },
                { status: 500 },
            ),
            Response.json(
                {
                    __type: 'AccessDeniedException',
                    message: 'no access to throwaway-answered',
                    Parameters: [{ Name: '/dev/a/B', Value: 'throwaway-answered' }],
                },
                { status: 400 },
            ),
        ]
        try {
            for (const [operation, body, retried, code] of [
                [
                    'PutParameter',
                    { Name: '/dev/a/B', Value: 'throwaway-sent' },
                    1,
                    'InternalFailure',
                ],
                [
                    'GetParameters',
                    { Names: ['/dev/a/B'], Note: 'throwaway-sent' },
                    2,
                    'AccessDeniedException',
                ],
            ] as const) {
                const { lines: traced, context: traces } = recording()
                const aws = stubAws(call => answers[aws.calls.indexOf(call)]?.clone())
                try {
                    const error = await thrownBy(() =>
                        awsJson(traces, 'ssm', operation, body, {
                            names: ['/dev/a/B'],
                            delayMs: 0,
                        }),
                    )

                    assert.ok(error instanceof AwsError)
                    const said = [
                        inspect(error, { depth: 10, showHidden: true }),
                        JSON.stringify(error, Object.getOwnPropertyNames(error)),
                        ...traced,
                    ].join('\n')
                    assert.deepStrictEqual([traced.length, error.code], [retried, code])
                    assert.doesNotMatch(said, /throwaway/u)
                } finally {
                    aws.restore()
                }
            }
        } finally {
            mock.restoreAll()
        }
    })
})

const refusedEnvironment = () =>
    Response.json(
        { Type: 'User', message: 'Environment too large: {"TOKEN":"throwaway-sent"}' },
        { status: 400, headers: { 'x-amzn-errortype': 'InvalidParameterValueException:http' } },
    )

describe('a request that carries a function’s environment', () => {
    it('keeps the answer’s body out of the trace and out of what it throws', async () => {
        const { lines: traced, context: traces } = recording()
        const aws = stubAws(refusedEnvironment)
        try {
            const error = await thrownBy(() =>
                withoutBody(
                    traces.log,
                    () => awsRequest(traces, 'POST', 'lambda', '/2015-03-31/functions', {}),
                    'Error creating lambda get',
                    status => (status === 400 ? 1 : 0),
                ),
            )
            assert.ok(Error.isError(error))
            assert.deepStrictEqual(
                {
                    message: error.message,
                    response: 'response' in error ? error.response : undefined,
                    traced,
                    calls: aws.calls.length,
                    shown: /throwaway|too large/u.test(
                        inspect(error, { depth: 10, showHidden: true }),
                    ),
                },
                {
                    message: 'Error creating lambda get',
                    response: { status: 400, type: 'InvalidParameterValueException' },
                    traced: ['  retrying #1... (400 InvalidParameterValueException)'],
                    calls: 2,
                    shown: false,
                },
            )
        } finally {
            aws.restore()
        }
    }).timeout(10_000)

    it('answers the response when the request is taken', async () => {
        const aws = stubAws(() => ({ FunctionArn: 'arn' }))
        try {
            const response = await withoutBody(
                context.log,
                () => awsRequest(context, 'POST', 'lambda', '/2015-03-31/functions', {}),
                'Error creating lambda get',
            )
            assert.deepStrictEqual(await response.json(), { FunctionArn: 'arn' })
        } finally {
            aws.restore()
        }
    })
})
