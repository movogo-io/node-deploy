import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSecretArguments, secretUsage, usage } from '../lib/arguments.js'
import { checkAccount } from '../lib/aws/account.js'
import { resolveCredentials } from '../lib/aws/credentials.js'
import { AwsError, awsJson } from '../lib/aws/lite.js'
import { runSecret } from '../lib/secret/cli.js'
import { Refusal, refusing } from '../lib/secret/refusal.js'
import { readValue } from '../lib/secret/value.js'
import { type AwsCall, context, stubAws, thrownBy } from './lib/aws.js'

const directory = join(tmpdir(), 'riddance', 'deploy-test-secret')
const glueFile = join(directory, 'glue.json')
const otherAccount = join(directory, 'glue.other-account.json')
const sameAccount = join(directory, 'glue.same-account.json')
const noAccount = join(directory, 'glue.no-account.json')

const account = '123456789012'
const adminA = `arn:aws:iam::${account}:user/admin-a`
const adminB = `arn:aws:iam::${account}:role/people/admin-b`
const operator = `arn:aws:iam::${account}:user/operator`
const deployer = `arn:aws:iam::${account}:role/deployer`
const slotW1 = `arn:aws:iam::${account}:role/slot-runner-w1`
const slotW2 = `arn:aws:iam::${account}:role/slot-runner-w2`

const error = (type: string, status = 400) =>
    Response.json({ __type: type, message: 'throwaway' }, { status })

const identityOf = (arn: string) => ({
    GetCallerIdentityResponse: { GetCallerIdentityResult: { Account: account, Arn: arn } },
})

/**
Runs one secret command as the binary does, over a stub of AWS that answers who the caller is
and hands every other call to `answer`. What comes back is everything the command let out: its
exit code, both streams, and the calls it made after the account check.
*/
async function run(
    argv: string[],
    answer: (call: AwsCall, earlier: AwsCall[]) => unknown = () => ({}),
    { value = 'throwaway', caller = adminA }: { value?: string; caller?: string } = {},
) {
    const args = parseSecretArguments([...argv, '--glue', glueFile])
    assert.ok(args.command === 'secret')
    const out: string[] = []
    const err: string[] = []
    const aws = stubAws(call =>
        call.action === 'GetCallerIdentity'
            ? identityOf(caller)
            : answer(call, aws.calls.slice(1, -1)),
    )
    try {
        const exitCode = await runSecret(
            args,
            {
                out: line => {
                    out.push(line)
                },
                log: {
                    trace: () => {
                        //
                    },
                    warn: line => {
                        err.push(line)
                    },
                    error: line => {
                        err.push(line)
                    },
                },
                readValue: () => Promise.resolve(value),
            },
            () => Promise.resolve(context.env),
        )
        return {
            exitCode,
            out,
            err,
            calls: aws.calls.slice(1).map(call => `${call.service} ${call.action ?? call.path}`),
            sent: aws.calls.slice(1).map(call => call.parameters),
        }
    } finally {
        aws.restore()
    }
}

// spell-checker: ignore nostage AROAEXAMPLE

const check = (file: string) =>
    checkAccount(context, 'secret list on dev', file, 'profile dev', 'refuse')

const policyOf = (body: { [key: string]: unknown } | undefined) =>
    typeof body?.Policy === 'string' ? (JSON.parse(body.Policy) as unknown) : undefined

const putting =
    (version: number, existing: unknown[] = []) =>
    ({ action }: AwsCall) =>
        action === 'PutParameter' ? { Version: version } : { Parameters: existing }

const refusedPut = ({ action }: AwsCall) =>
    action === 'PutParameter' ? error('AccessDeniedException') : { Parameters: [] }

const importing =
    (listed: unknown) =>
    ({ action }: AwsCall) => {
        if (action === 'GetParameter') {
            return error('ParameterNotFound')
        }
        return action === 'PutParameter' ? { Version: 1 } : listed
    }

const holding = (listed: unknown, value: string) => (call: AwsCall) =>
    call.action === 'GetParameter' ? { Parameter: { Value: value, Version: 5 } } : listed

const oldSet = () => ({ Parameters: [row('/dev/svc/OLD', 4)] })

const fn = (name: string, variables: { [key: string]: string }) => ({
    FunctionName: name,
    FunctionArn: `arn:aws:lambda:eu-north-1:${account}:function:${name}`,
    Environment: { Variables: variables },
})

// eslint-disable-next-line unicorn/no-null -- as the API ends a listing
const functions = (...listed: unknown[]) => ({ Functions: listed, NextMarker: null })

const row = (name: string, version: number, more: { [key: string]: unknown } = {}) => ({
    Name: name,
    Type: 'SecureString',
    KeyId: 'alias/dev-secrets',
    Version: version,
    LastModifiedDate: 1_794_571_200.5,
    LastModifiedUser: operator,
    ...more,
})

before(async () => {
    await mkdir(directory, { recursive: true })
    const services = {
        svc: {
            env: { PLAIN: 'x' },
            secrets: {
                PARAMETERS: true,
                TOKEN: '$PARAMETER()',
                SHARED: '$PARAMETER(mails,PASSWORD)',
                LIT: 'literal',
            },
        },
        mails: { secrets: { PARAMETERS: true, PASSWORD: '$PARAMETER()' } },
        rentals: {},
        'rentals-v2': {},
    }
    await writeFile(glueFile, JSON.stringify({ aws: { accountId: account }, services }))
    await writeFile(sameAccount, JSON.stringify({ aws: { accountId: account }, services }))
    await writeFile(otherAccount, JSON.stringify({ aws: { accountId: '210987654321' } }))
    await writeFile(noAccount, JSON.stringify({ services }))
})

describe('secret put', () => {
    it('refuses the tripwire’s name as a key before it asks anything', async () => {
        for (const args of [['put'], ['import'], ['rm'], ['restore', '1']]) {
            const [command, ...version] = args
            assert.deepStrictEqual(
                await run([command ?? '', 'dev', 'svc', 'PARAMETERS', ...version]),
                {
                    exitCode: 1,
                    out: [],
                    err: [
                        'error: PARAMETERS is the entry that marks a block with references, not a parameter',
                    ],
                    calls: [],
                    sent: [],
                },
            )
        }
    })

    it('refuses a key the glue does not refer to', async () => {
        assert.deepStrictEqual(await run(['put', 'dev', 'svc', 'LIT']), {
            exitCode: 1,
            out: [],
            err: [`error: svc.LIT is not a parameter reference in ${glueFile}`],
            calls: [],
            sent: [],
        })
    })

    it('refuses a name that is set, and with --replace one that is not or is of another kind', async () => {
        assert.deepStrictEqual(
            [
                await run(['put', 'dev', 'svc', 'TOKEN'], () => ({
                    Parameters: [row('/dev/svc/TOKEN', 3)],
                })),
                await run(['put', 'dev', 'svc', 'TOKEN', '--replace'], () => ({ Parameters: [] })),
                await run(['put', 'dev', 'svc', 'TOKEN', '--replace'], () => ({
                    Parameters: [row('/dev/svc/TOKEN', 3, { Type: 'String', KeyId: undefined })],
                })),
                await run(['put', 'dev', 'svc', 'TOKEN', '--replace'], () => ({
                    Parameters: [row('/dev/svc/TOKEN', 3, { KeyId: 'alias/other' })],
                })),
            ].map(({ exitCode, out, err, calls }) => ({ exitCode, out, err, calls })),
            [
                'error: already set at version 3; use --replace',
                'error: not set; put without --replace',
                'error: exists as String under no key; rm it first',
                'error: exists as SecureString under alias/other; rm it first',
            ].map(line => ({
                exitCode: 1,
                out: [],
                err: [line],
                calls: ['ssm DescribeParameters'],
            })),
        )
    })

    it('refuses a value that is empty, too long, or holds a line break it was not told of', async () => {
        assert.deepStrictEqual(
            [
                await run(['put', 'dev', 'svc', 'TOKEN'], () => ({ Parameters: [] }), {
                    value: '',
                }),
                await run(['put', 'dev', 'svc', 'TOKEN'], () => ({ Parameters: [] }), {
                    value: 'a\nb',
                }),
                await run(['put', 'dev', 'svc', 'TOKEN'], () => ({ Parameters: [] }), {
                    value: 'é'.repeat(2049),
                }),
            ].map(({ exitCode, err, calls }) => ({ exitCode, err, calls })),
            [
                'error: the value is empty',
                'error: the value holds a line break; use --multiline if it is meant to',
                'error: the value is over 4,096 bytes, the most a parameter holds',
            ].map(line => ({ exitCode: 1, err: [line], calls: ['ssm DescribeParameters'] })),
        )
    })

    it('puts a new value under the stage key and names who reads it, never the value', async () => {
        assert.deepStrictEqual(await run(['put', 'dev', 'svc', 'TOKEN'], putting(1)), {
            exitCode: 0,
            out: ['version 1', 'redeploy: svc'],
            err: [],
            calls: ['ssm DescribeParameters', 'ssm PutParameter'],
            sent: [
                {
                    ParameterFilters: [
                        { Key: 'Name', Option: 'Equals', Values: ['/dev/svc/TOKEN'] },
                    ],
                    MaxResults: 50,
                },
                {
                    Name: '/dev/svc/TOKEN',
                    Value: 'throwaway',
                    Type: 'SecureString',
                    Tier: 'Standard',
                    KeyId: 'alias/dev-secrets',
                    Overwrite: false,
                },
            ],
        })
    })

    it('puts another service’s reference under the service it names', async () => {
        const { out, sent } = await run(
            ['put', 'dev', 'mails', 'PASSWORD', '--multiline'],
            putting(1),
            { value: 'a\nb' },
        )
        assert.deepStrictEqual(
            [out, sent.at(-1)],
            [
                ['version 1', 'redeploy: svc, mails'],
                {
                    Name: '/dev/mails/PASSWORD',
                    Value: 'a\nb',
                    Type: 'SecureString',
                    Tier: 'Standard',
                    KeyId: 'alias/dev-secrets',
                    Overwrite: false,
                },
            ],
        )
    })

    it('replaces a value and says both versions', async () => {
        const { exitCode, out, sent } = await run(
            ['put', 'dev', 'svc', 'TOKEN', '--replace'],
            putting(4, [row('/dev/svc/TOKEN', 3)]),
        )
        assert.deepStrictEqual(
            [exitCode, out, sent.at(-1)?.Overwrite],
            [0, ['version 3 → 4', 'redeploy: svc'], true],
        )
    })

    it('exits 3 with one line that holds no value when AWS refuses', async () => {
        assert.deepStrictEqual(await run(['put', 'dev', 'svc', 'TOKEN'], refusedPut), {
            exitCode: 3,
            out: [],
            err: ['error: ssm PutParameter failed: AccessDeniedException (/dev/svc/TOKEN)'],
            calls: ['ssm DescribeParameters', 'ssm PutParameter'],
            sent: [
                {
                    ParameterFilters: [
                        { Key: 'Name', Option: 'Equals', Values: ['/dev/svc/TOKEN'] },
                    ],
                    MaxResults: 50,
                },
                {
                    Name: '/dev/svc/TOKEN',
                    Value: 'throwaway',
                    Type: 'SecureString',
                    Tier: 'Standard',
                    KeyId: 'alias/dev-secrets',
                    Overwrite: false,
                },
            ],
        })
    })
})

describe('the value of a put', () => {
    it('is all of standard input less one trailing line break', async () => {
        assert.deepStrictEqual(
            await Promise.all(
                ['throwaway\n', 'throwaway\r\n', 'throwaway', 'a\nb\n\n', '\n', ''].map(input =>
                    readValue(new Blob([input]).stream()),
                ),
            ),
            ['throwaway', 'throwaway', 'throwaway', 'a\nb\n', '', ''],
        )
    })
})

const typing = () => {
    // eslint-disable-next-line unicorn/prefer-event-target -- stands in for a terminal's stream, which is an emitter
    const emitter = new EventEmitter()
    const modes: boolean[] = []
    return {
        modes,
        type: (keys: string) => emitter.emit('data', Buffer.from(keys)),
        listeners: () => emitter.listenerCount('data'),
        stdin: {
            isTTY: true,
            setRawMode: (raw: boolean) => {
                modes.push(raw)
            },
            resume: () => {
                //
            },
            pause: () => {
                //
            },
            on: (event: 'data', listener: (data: Buffer) => void) => emitter.on(event, listener),
            off: (event: 'data', listener: (data: Buffer) => void) => emitter.off(event, listener),
            [Symbol.asyncIterator]: () => ({
                next: () => Promise.reject(new Error('a terminal is not read to its end')),
            }),
        },
    }
}

describe('a typed value', () => {
    it('is read in raw mode up to Enter, with what backspace took away gone', async () => {
        const terminal = typing()
        const value = readValue(terminal.stdin)
        terminal.type('one two3')
        terminal.type('\u{7F}\rnot read')
        assert.deepStrictEqual(
            [await value, terminal.modes, terminal.listeners()],
            ['one two', [true, false], 0],
        )
    })

    it('is refused when a control character was typed, saying nothing of what was', async () => {
        for (const keys of ['one\u{1B}[A two\r', 'value\u{4}', 'one\ttwo\r']) {
            const terminal = typing()
            const value = thrownBy(() => readValue(terminal.stdin))
            terminal.type(keys)
            const refused = await value
            assert.ok(refused instanceof Refusal)
            assert.deepStrictEqual(
                [refused.message, terminal.modes, terminal.listeners()],
                [
                    'a control character was typed, as an arrow key or Ctrl-D sends; nothing was put. Type the value and end it with Enter, or pipe it in',
                    [true, false],
                    0,
                ],
            )
        }
    })

    it('is given up on Ctrl-C', async () => {
        const terminal = typing()
        const value = thrownBy(() => readValue(terminal.stdin))
        terminal.type('value\u{3}')
        const refused = await value
        assert.ok(refused instanceof Refusal)
        assert.strictEqual(refused.message, 'interrupted; nothing was put')
    })
})

describe('secret import', () => {
    const listed = functions(
        fn('dev-svc-a', { LIT: 'held', DIFFERS: 'one', TEXT: '$PARAMETER()' }),
        fn('dev-svc-b', { LIT: 'held', DIFFERS: 'two' }),
        fn('dev-svc-c', {}),
        fn('dev-rentals-get', { K: 'rentals-held' }),
        fn('dev-rentals-v2-get', { K: 'v2-held' }),
        fn('w1-svc-a', { LIT: 'slot-held' }),
    )

    it('refuses a service the glue does not hold and a key no function holds', async () => {
        assert.deepStrictEqual(
            [
                await run(['import', 'dev', 'absent', 'LIT'], () => listed),
                await run(['import', 'dev', 'svc', 'NOWHERE'], () => listed),
            ].map(({ exitCode, err, calls }) => ({ exitCode, err, calls })),
            [
                {
                    exitCode: 1,
                    err: [`error: absent is not a service in ${glueFile}`],
                    calls: [],
                },
                {
                    exitCode: 1,
                    err: ['error: no function of svc on dev holds NOWHERE'],
                    calls: ['lambda /2015-03-31/functions/'],
                },
            ],
        )
    })

    it('refuses functions that hold different values, naming them and no value', async () => {
        assert.deepStrictEqual((await run(['import', 'dev', 'svc', 'DIFFERS'], () => listed)).err, [
            'error: dev-svc-a and dev-svc-b hold different values of DIFFERS',
        ])
    })

    it('refuses the text of a reference, which an older tool deployed as the value', async () => {
        assert.deepStrictEqual(await run(['import', 'dev', 'svc', 'TEXT'], () => listed), {
            exitCode: 1,
            out: [],
            err: [
                'error: dev-svc-a holds the text of a parameter reference as TEXT, as a tool older than 0.6.2 deploys it; that is no value to import. Put the value (deploy secret put …) and redeploy with 0.6.2.',
            ],
            calls: ['lambda /2015-03-31/functions/'],
            sent: [{}],
        })
    })

    it('puts what the functions hold when the parameter is not there, with no reference in glue', async () => {
        assert.deepStrictEqual(await run(['import', 'dev', 'svc', 'LIT'], importing(listed)), {
            exitCode: 0,
            out: ['version 1'],
            err: [],
            calls: ['lambda /2015-03-31/functions/', 'ssm GetParameter', 'ssm PutParameter'],
            sent: [
                {},
                { Name: '/dev/svc/LIT', WithDecryption: true },
                {
                    Name: '/dev/svc/LIT',
                    Value: 'held',
                    Type: 'SecureString',
                    Tier: 'Standard',
                    KeyId: 'alias/dev-secrets',
                    Overwrite: false,
                },
            ],
        })
    })

    it('leaves out the functions of a service whose name starts the same', async () => {
        const { exitCode, sent } = await run(['import', 'dev', 'rentals', 'K'], importing(listed))
        assert.deepStrictEqual([exitCode, sent.at(-1)?.Value], [0, 'rentals-held'])
    })

    it('does nothing when the parameter holds that value, and refuses when it holds another', async () => {
        assert.deepStrictEqual(
            [
                await run(['import', 'dev', 'svc', 'LIT'], holding(listed, 'held')),
                await run(['import', 'dev', 'svc', 'LIT'], holding(listed, 'other')),
            ].map(({ exitCode, out, err, calls }) => ({ exitCode, out, err, calls })),
            [
                {
                    exitCode: 0,
                    out: ['already at version 5'],
                    err: [],
                    calls: ['lambda /2015-03-31/functions/', 'ssm GetParameter'],
                },
                {
                    exitCode: 1,
                    out: [],
                    err: [
                        'error: /dev/svc/LIT is set at version 5 to another value than the functions hold; put --replace or restore decides which one stands',
                    ],
                    calls: ['lambda /2015-03-31/functions/', 'ssm GetParameter'],
                },
            ],
        )
    })
})

describe('secret list', () => {
    it('prints a line a parameter with what is odd about it, and the referenced ones that are missing', async () => {
        const pages = [
            {
                Parameters: [
                    row('/dev/svc/TOKEN', 3),
                    row('/dev/svc/OLD', 1, { Type: 'String', KeyId: undefined }),
                ],
                NextToken: 'more',
            },
            { Parameters: [row('/dev/extra/KEY', 12, { KeyId: 'alias/other' })] },
        ]
        assert.deepStrictEqual(
            await run(['list', 'dev'], (_call, earlier) => pages[earlier.length]),
            {
                exitCode: 0,
                out: [
                    `/dev/extra/KEY\tv12\t2026-11-13T12:00:00.500Z\t${operator}\tunreferenced,other key`,
                    '/dev/mails/PASSWORD\t-\t-\t-\tmissing',
                    `/dev/svc/OLD\tv1\t2026-11-13T12:00:00.500Z\t${operator}\tunreferenced,not SecureString`,
                    `/dev/svc/TOKEN\tv3\t2026-11-13T12:00:00.500Z\t${operator}\t-`,
                ],
                err: [],
                calls: ['ssm DescribeParameters', 'ssm DescribeParameters'],
                sent: [
                    {
                        ParameterFilters: [{ Key: 'Path', Option: 'Recursive', Values: ['/dev'] }],
                        MaxResults: 50,
                    },
                    {
                        ParameterFilters: [{ Key: 'Path', Option: 'Recursive', Values: ['/dev'] }],
                        MaxResults: 50,
                        NextToken: 'more',
                    },
                ],
            },
        )
    })

    it('lists one service’s parameters, those another service refers to among them', async () => {
        const { out, sent } = await run(['list', 'dev', 'mails'], () => ({
            Parameters: [row('/dev/mails/PASSWORD', 2)],
        }))
        assert.deepStrictEqual(
            [out, sent],
            [
                [`/dev/mails/PASSWORD\tv2\t2026-11-13T12:00:00.500Z\t${operator}\t-`],
                [
                    {
                        ParameterFilters: [
                            { Key: 'Path', Option: 'Recursive', Values: ['/dev/mails'] },
                        ],
                        MaxResults: 50,
                    },
                ],
            ],
        )
    })
})

describe('secret check', () => {
    const parameters = { Parameters: [row('/dev/svc/TOKEN', 3), row('/dev/mails/PASSWORD', 7)] }
    const checking = (...listed: unknown[]) =>
        run(['check', 'dev'], ({ action }) =>
            action === 'DescribeParameters' ? parameters : functions(...listed),
        )

    it('prints nothing and exits 0 when every function runs with the current versions', async () => {
        assert.deepStrictEqual(
            await checking(
                fn('dev-svc-a', {
                    TOKEN: 't',
                    SHARED: 's',
                    PARAMETER_VERSIONS: '{"TOKEN":3,"SHARED":7}',
                }),
                fn('dev-mails-send', { PASSWORD: 's', PARAMETER_VERSIONS: '{"PASSWORD":7}' }),
                fn('dev-rentals-get', { TOKEN: 'a literal of its own' }),
                fn('w1-svc-a', { TOKEN: 't' }),
            ),
            {
                exitCode: 0,
                out: [],
                err: [],
                calls: ['lambda /2015-03-31/functions/', 'ssm DescribeParameters'],
                sent: [
                    {},
                    {
                        ParameterFilters: [{ Key: 'Path', Option: 'Recursive', Values: ['/dev'] }],
                        MaxResults: 50,
                    },
                ],
            },
        )
    })

    it('exits 1 with a line for each stale, unstamped or orphaned key of a function', async () => {
        const { exitCode, out, err } = await checking(
            fn('dev-svc-b', { TOKEN: 't', SHARED: 's', PARAMETER_VERSIONS: 'no json' }),
            fn('dev-svc-a', {
                TOKEN: 't',
                SHARED: 's',
                GONE: 'g',
                PARAMETER_VERSIONS: '{"TOKEN":2,"SHARED":7,"GONE":1}',
            }),
            fn('dev-svc-c', {}),
        )
        assert.deepStrictEqual(
            { exitCode, out, err },
            {
                exitCode: 1,
                out: [
                    'dev-svc-a\tGONE\tdeployed v1\t-\tparameter missing',
                    'dev-svc-a\tTOKEN\tdeployed v2\tcurrent v3\tstale',
                    'dev-svc-b\tSHARED\t-\tcurrent v7\tnot deployed since the reference',
                    'dev-svc-b\tTOKEN\t-\tcurrent v3\tnot deployed since the reference',
                ],
                err: [],
            },
        )
    })

    it('checks one service, which the glue must hold', async () => {
        const one = await run(['check', 'dev', 'mails'], ({ action }) =>
            action === 'DescribeParameters'
                ? parameters
                : functions(
                      fn('dev-svc-a', { TOKEN: 't' }),
                      fn('dev-mails-send', { PASSWORD: 's', PARAMETER_VERSIONS: '{"PASSWORD":6}' }),
                  ),
        )
        const absent = await run(['check', 'dev', 'absent'])
        assert.deepStrictEqual(
            [one.exitCode, one.out, absent.exitCode, absent.err, absent.calls],
            [
                1,
                ['dev-mails-send\tPASSWORD\tdeployed v6\tcurrent v7\tstale'],
                1,
                [`error: absent is not a service in ${glueFile}`],
                [],
            ],
        )
    })

    it('exits 3 when it could not run', async () => {
        const { exitCode, out, err } = await run(['check', 'dev'], ({ action }) =>
            action === 'DescribeParameters' ? error('InternalFailure', 400) : functions(),
        )
        assert.deepStrictEqual(
            { exitCode, out, err },
            {
                exitCode: 3,
                out: [],
                err: ['error: ssm DescribeParameters failed: InternalFailure (/dev)'],
            },
        )
    })
})

describe('secret restore', () => {
    it('puts an earlier version’s value as the newest and says who to redeploy', async () => {
        assert.deepStrictEqual(
            await run(['restore', 'dev', 'svc', 'TOKEN', '2'], ({ action }) =>
                action === 'GetParameter'
                    ? { Parameter: { Value: 'earlier', Version: 2 } }
                    : { Version: 5 },
            ),
            {
                exitCode: 0,
                out: ['version 2 restored as 5; redeploy: svc'],
                err: [],
                calls: ['ssm GetParameter', 'ssm PutParameter'],
                sent: [
                    { Name: '/dev/svc/TOKEN:2', WithDecryption: true },
                    {
                        Name: '/dev/svc/TOKEN',
                        Value: 'earlier',
                        Type: 'SecureString',
                        Tier: 'Standard',
                        KeyId: 'alias/dev-secrets',
                        Overwrite: true,
                    },
                ],
            },
        )
    })

    it('refuses a parameter that is not set', async () => {
        const { exitCode, err, calls } = await run(['restore', 'dev', 'svc', 'TOKEN', '1'], () =>
            error('ParameterNotFound'),
        )
        assert.deepStrictEqual(
            { exitCode, err, calls },
            {
                exitCode: 1,
                err: ['error: /dev/svc/TOKEN is not set'],
                calls: ['ssm GetParameter'],
            },
        )
    })

    it('refuses a version that is not there', async () => {
        const { exitCode, err, calls } = await run(['restore', 'dev', 'svc', 'TOKEN', '9'], () =>
            error('ParameterVersionNotFound'),
        )
        assert.deepStrictEqual(
            { exitCode, err, calls },
            {
                exitCode: 1,
                err: ['error: /dev/svc/TOKEN has no version 9'],
                calls: ['ssm GetParameter'],
            },
        )
    })
})

describe('secret rm', () => {
    it('refuses a parameter the glue refers to, before it asks anything', async () => {
        assert.deepStrictEqual(await run(['rm', 'dev', 'mails', 'PASSWORD', '--yes']), {
            exitCode: 1,
            out: [],
            err: [
                `error: /dev/mails/PASSWORD is referenced in ${glueFile} by svc, mails; take the reference out first`,
            ],
            calls: [],
            sent: [],
        })
    })

    it('says how many versions go and exits 1 until it is told --yes', async () => {
        assert.deepStrictEqual(
            [
                await run(['rm', 'dev', 'svc', 'OLD'], oldSet),
                await run(['rm', 'dev', 'svc', 'OLD', '--yes'], oldSet),
                await run(['rm', 'dev', 'svc', 'OLD', '--yes'], () => ({ Parameters: [] })),
            ].map(({ exitCode, out, err, calls }) => ({ exitCode, out, err, calls })),
            [
                {
                    exitCode: 1,
                    out: ['this also deletes its 4 versions'],
                    err: [],
                    calls: ['ssm DescribeParameters'],
                },
                {
                    exitCode: 0,
                    out: ['deleted /dev/svc/OLD'],
                    err: [],
                    calls: ['ssm DescribeParameters', 'ssm DeleteParameter'],
                },
                {
                    exitCode: 1,
                    out: [],
                    err: ['error: /dev/svc/OLD is not set'],
                    calls: ['ssm DescribeParameters'],
                },
            ],
        )
    })
})

describe('secret init', () => {
    const principals = [
        '--admin',
        adminA,
        '--admin',
        adminB,
        '--operator',
        operator,
        '--deployer',
        deployer,
    ]
    const parameters = {
        StringLike: {
            'kms:EncryptionContext:PARAMETER_ARN': `arn:aws:ssm:eu-north-1:${account}:parameter/dev/*`,
        },
    }
    const statements = [
        {
            Sid: 'RootUserOnly',
            Effect: 'Allow',
            Principal: { AWS: `arn:aws:iam::${account}:root` },
            Action: ['kms:DescribeKey', 'kms:GetKeyPolicy', 'kms:PutKeyPolicy'],
            Resource: '*',
            Condition: { ArnEquals: { 'aws:PrincipalArn': `arn:aws:iam::${account}:root` } },
        },
        {
            Sid: 'Admins',
            Effect: 'Allow',
            Principal: { AWS: [adminA, adminB] },
            Action: [
                'kms:DescribeKey',
                'kms:GetKeyPolicy',
                'kms:PutKeyPolicy',
                'kms:CreateAlias',
                'kms:UpdateAlias',
                'kms:DeleteAlias',
                'kms:EnableKey',
                'kms:DisableKey',
                'kms:ScheduleKeyDeletion',
                'kms:CancelKeyDeletion',
                'kms:EnableKeyRotation',
                'kms:GetKeyRotationStatus',
            ],
            Resource: '*',
        },
        {
            Sid: 'Operators',
            Effect: 'Allow',
            Principal: { AWS: [operator] },
            Action: ['kms:Encrypt', 'kms:Decrypt'],
            Resource: '*',
            Condition: parameters,
        },
        {
            Sid: 'Deployers',
            Effect: 'Allow',
            Principal: { AWS: [deployer] },
            Action: 'kms:Decrypt',
            Resource: '*',
            Condition: parameters,
        },
    ]
    const slotReaders = {
        Sid: 'SlotReaders',
        Effect: 'Allow',
        Principal: { AWS: [slotW1, slotW2] },
        Action: 'kms:Decrypt',
        Resource: '*',
        Condition: parameters,
    }
    const key = {
        KeyId: 'key-1',
        Arn: `arn:aws:kms:eu-north-1:${account}:key/key-1`,
        Description: 'dev secrets',
    }
    const existing =
        (stored: unknown[]) =>
        ({ action }: AwsCall) =>
            action === 'DescribeKey'
                ? { KeyMetadata: key }
                : { Policy: JSON.stringify({ Version: '2012-10-17', Statement: stored }) }

    it('refuses fewer than two administrators and a caller who is none, before any call to KMS', async () => {
        assert.deepStrictEqual(
            [
                await run(['init', 'dev', '--admin', adminA, ...principals.slice(4)]),
                await run(['init', 'dev', ...principals.slice(0, 6)]),
                await run(['init', 'dev', ...principals], undefined, { caller: operator }),
                await run(['init', 'dev', ...principals], undefined, {
                    caller: `arn:aws:sts::${account}:assumed-role/deployer/session`,
                }),
                await run(['init', 'dev', ...principals, '--slot-reader', deployer]),
                await run(['init', 'dev', ...principals, '--slot-reader', 'slot-runner-w1']),
            ],
            [
                'init needs at least two --admin: one alone could lock the key',
                'init needs at least one --operator and one --deployer',
                `the caller ${operator} is not one of the --admin principals: init is run by an administrator of the key`,
                `the caller arn:aws:sts::${account}:assumed-role/deployer/session is not one of the --admin principals: init is run by an administrator of the key`,
                `${deployer} is given as --deployer and as --slot-reader; name it once`,
                '--slot-reader takes the ARN of an IAM role or user, not "slot-runner-w1"',
            ].map(line => ({ exitCode: 1, out: [], err: [`error: ${line}`], calls: [], sent: [] })),
        )
    })

    it('makes the key with its policy of four statements and names it', async () => {
        const { exitCode, out, err, calls, sent } = await run(
            ['init', 'dev', ...principals],
            ({ action }) => {
                if (action === 'DescribeKey') {
                    return error('NotFoundException')
                }
                return action === 'CreateKey' ? { KeyMetadata: key } : new Response('')
            },
            { caller: `arn:aws:sts::${account}:assumed-role/admin-b/session` },
        )
        assert.deepStrictEqual(
            { exitCode, out, err, calls, sent: [sent[0], { ...sent[1], Policy: '' }, sent[2]] },
            {
                exitCode: 0,
                out: ['created key key-1'],
                err: [],
                calls: ['kms DescribeKey', 'kms CreateKey', 'kms CreateAlias'],
                sent: [
                    { KeyId: 'alias/dev-secrets' },
                    {
                        Description: 'dev secrets',
                        KeyUsage: 'ENCRYPT_DECRYPT',
                        KeySpec: 'SYMMETRIC_DEFAULT',
                        Policy: '',
                    },
                    { AliasName: 'alias/dev-secrets', TargetKeyId: 'key-1' },
                ],
            },
        )
        assert.deepStrictEqual(policyOf(sent[1]), { Version: '2012-10-17', Statement: statements })
    })

    it('writes a SlotReaders statement from --slot-reader and leaves Deployers as given', async () => {
        const { sent } = await run(
            ['init', 'dev', ...principals, '--slot-reader', slotW1, '--slot-reader', slotW2],
            ({ action }) => {
                if (action === 'DescribeKey') {
                    return error('NotFoundException')
                }
                return action === 'CreateKey' ? { KeyMetadata: key } : new Response('')
            },
        )
        assert.deepStrictEqual(policyOf(sent[1]), {
            Version: '2012-10-17',
            Statement: [...statements, slotReaders],
        })
    })

    it('says which key has no alias when naming it fails, and resumes with --key', async () => {
        const failed = await run(['init', 'dev', ...principals], ({ action }) => {
            if (action === 'DescribeKey') {
                return error('NotFoundException')
            }
            return action === 'CreateKey' ? { KeyMetadata: key } : error('AccessDeniedException')
        })
        const resumed = await run(
            ['init', 'dev', ...principals, '--key', 'key-1'],
            ({ action, parameters: sent }, earlier) => {
                if (action === 'DescribeKey' && sent.KeyId === 'alias/dev-secrets') {
                    return earlier.some(call => call.action === 'CreateAlias')
                        ? { KeyMetadata: key }
                        : error('NotFoundException')
                }
                if (action === 'DescribeKey') {
                    return { KeyMetadata: key }
                }
                return action === 'GetKeyPolicy'
                    ? { Policy: JSON.stringify({ Statement: statements }) }
                    : new Response('')
            },
        )
        const foreign = await run(
            ['init', 'dev', ...principals, '--key', 'key-1'],
            ({ parameters: sent }) =>
                sent.KeyId === 'key-1'
                    ? { KeyMetadata: { ...key, Description: 'something else' } }
                    : error('NotFoundException'),
        )
        assert.deepStrictEqual(
            [failed, resumed, foreign].map(({ exitCode, out, err, calls }) => ({
                exitCode,
                out,
                err,
                calls,
            })),
            [
                {
                    exitCode: 3,
                    out: ['created key key-1'],
                    err: [
                        'key key-1 has no alias; rerun with --key key-1',
                        'error: kms CreateAlias failed: AccessDeniedException (alias/dev-secrets)',
                    ],
                    calls: ['kms DescribeKey', 'kms CreateKey', 'kms CreateAlias'],
                },
                {
                    exitCode: 0,
                    out: ['alias/dev-secrets is key key-1; its policy is as given'],
                    err: [],
                    calls: [
                        'kms DescribeKey',
                        'kms DescribeKey',
                        'kms CreateAlias',
                        'kms GetKeyPolicy',
                    ],
                },
                {
                    exitCode: 1,
                    out: [],
                    err: [
                        'error: key key-1 is described as "something else", not "dev secrets": it is not the key this command made',
                    ],
                    calls: ['kms DescribeKey', 'kms DescribeKey'],
                },
            ],
        )
    })

    it('refuses --key that names another key than the alias', async () => {
        const { exitCode, err } = await run(
            ['init', 'dev', ...principals, '--key', 'key-2'],
            existing(statements),
        )
        assert.deepStrictEqual(
            { exitCode, err },
            { exitCode: 1, err: ['error: alias/dev-secrets names key key-1, not key-2'] },
        )
    })

    it('does nothing when the stored policy is the same in any order and spelling', async () => {
        const [root, admins, operators, deployers] = statements
        const stored = [
            { ...deployers, Action: ['kms:Decrypt'], Principal: { AWS: deployer } },
            { ...operators, Action: ['kms:Decrypt', 'kms:Encrypt'], Principal: { AWS: operator } },
            { ...admins, Principal: { AWS: [adminB, adminA] } },
            root,
        ]
        assert.deepStrictEqual(await run(['init', 'dev', ...principals], existing(stored)), {
            exitCode: 0,
            out: ['alias/dev-secrets is key key-1; its policy is as given'],
            err: [],
            calls: ['kms DescribeKey', 'kms GetKeyPolicy'],
            sent: [{ KeyId: 'alias/dev-secrets' }, { KeyId: 'key-1', PolicyName: 'default' }],
        })
    })

    it('refuses a policy that differs, a dropped slot reader among it, unless told to replace it', async () => {
        const stored = [...statements, slotReaders]
        const oneReader = ['init', 'dev', ...principals, '--slot-reader', slotW1]
        const refused = await run(oneReader, existing(stored))
        const replaced = await run([...oneReader, '--update-policy'], call =>
            call.action === 'PutKeyPolicy' ? new Response('') : existing(stored)(call),
        )
        const none = await run(['init', 'dev', ...principals], existing(stored))
        assert.deepStrictEqual(
            [
                { exitCode: refused.exitCode, err: refused.err, calls: refused.calls },
                { exitCode: replaced.exitCode, out: replaced.out, calls: replaced.calls },
                policyOf(replaced.sent[2]),
                none.err,
            ],
            [
                {
                    exitCode: 1,
                    err: [
                        'error: the policy of alias/dev-secrets differs from the one asked for in SlotReaders; rerun with --update-policy to replace it',
                    ],
                    calls: ['kms DescribeKey', 'kms GetKeyPolicy'],
                },
                {
                    exitCode: 0,
                    out: ['alias/dev-secrets is key key-1; its policy was replaced in SlotReaders'],
                    calls: ['kms DescribeKey', 'kms GetKeyPolicy', 'kms PutKeyPolicy'],
                },
                {
                    Version: '2012-10-17',
                    Statement: [...statements, { ...slotReaders, Principal: { AWS: [slotW1] } }],
                },
                [
                    'error: the policy of alias/dev-secrets differs from the one asked for in SlotReaders; rerun with --update-policy to replace it',
                ],
            ],
        )
    })

    it('refuses a principal of another account, naming it', async () => {
        const foreign = 'arn:aws:iam::210987654321:role/deployer'
        assert.deepStrictEqual(
            [
                await run(['init', 'dev', ...principals, '--deployer', foreign]),
                await run(['init', 'dev', ...principals, '--slot-reader', foreign]),
                await run(['init', 'dev', ...principals, '--admin', foreign]),
                await run(['init', 'dev', ...principals, '--operator', foreign]),
            ],
            ['--deployer', '--slot-reader', '--admin', '--operator'].map(flag => ({
                exitCode: 1,
                out: [],
                err: [
                    `error: ${flag} ${foreign} is of another account than ${account}, the stage's`,
                ],
                calls: [],
                sent: [],
            })),
        )
    })

    it('takes a stored statement of another shape as one that differs', async () => {
        const [root, admins, operators] = statements
        const stored = [
            root,
            admins,
            operators,
            { Sid: 'Deployers', Effect: 'Allow', Principal: '*', Action: 'kms:Decrypt' },
            { Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'kms:*' },
            'no statement',
        ]
        assert.deepStrictEqual(await run(['init', 'dev', ...principals], existing(stored)), {
            exitCode: 1,
            out: [],
            err: [
                'error: the policy of alias/dev-secrets differs from the one asked for in Deployers, (no Sid); rerun with --update-policy to replace it',
            ],
            calls: ['kms DescribeKey', 'kms GetKeyPolicy'],
            sent: [{ KeyId: 'alias/dev-secrets' }, { KeyId: 'key-1', PolicyName: 'default' }],
        })
    })

    it('says which statement names a principal that was deleted', async () => {
        const [root, admins, operators, deployers] = statements
        const stored = [
            root,
            admins,
            operators,
            { ...deployers, Principal: { AWS: 'AROAEXAMPLE' } },
        ]
        assert.deepStrictEqual((await run(['init', 'dev', ...principals], existing(stored))).err, [
            'error: the policy of alias/dev-secrets differs from the one asked for in Deployers (a principal named in Deployers no longer exists); rerun with --update-policy to replace it',
        ])
    })

    it('says what a policy KMS refuses usually means', async () => {
        const { exitCode, err } = await run(['init', 'dev', ...principals], ({ action }) =>
            error(
                action === 'DescribeKey' ? 'NotFoundException' : 'MalformedPolicyDocumentException',
            ),
        )
        assert.deepStrictEqual(
            { exitCode, err },
            {
                exitCode: 3,
                err: [
                    'KMS refused the key policy: usually a principal that does not exist, or one that cannot be named in a policy',
                    'error: kms CreateKey failed: MalformedPolicyDocumentException (alias/dev-secrets)',
                ],
            },
        )
    })

    describe('for a service key', () => {
        const serviceKey = {
            KeyId: 'key-9',
            Arn: `arn:aws:kms:eu-north-1:${account}:key/key-9`,
            Description: 'dev svc seeds',
        }
        const role = {
            GetRoleResponse: {
                GetRoleResult: { Role: { Arn: `arn:aws:iam::${account}:role/dev-svc-role` } },
            },
        }
        const answer =
            (stored: unknown[], roleAnswer: unknown = role) =>
            ({ action, parameters: sent }: AwsCall) => {
                switch (action) {
                    case 'DescribeKey':
                        return sent.KeyId === 'alias/dev-secrets'
                            ? { KeyMetadata: key }
                            : error('NotFoundException')
                    case 'GetKeyPolicy':
                        return { Policy: JSON.stringify({ Statement: stored }) }
                    case 'GetRole':
                        return roleAnswer
                    case 'CreateKey':
                        return { KeyMetadata: serviceKey }
                    default:
                        return new Response('')
                }
            }

        it('needs the stage key, an administrator of it and the service’s role', async () => {
            assert.deepStrictEqual(
                [
                    await run(['init-key', 'dev', 'svc', 'seeds'], () =>
                        error('NotFoundException'),
                    ),
                    await run(['init-key', 'dev', 'svc', 'seeds'], answer(statements), {
                        caller: operator,
                    }),
                    await run(
                        ['init-key', 'dev', 'svc', 'seeds'],
                        answer(statements, new Response('', { status: 404 })),
                    ),
                ].map(({ exitCode, err, calls }) => ({ exitCode, err, calls })),
                [
                    {
                        exitCode: 1,
                        err: [
                            'error: alias/dev-secrets does not exist; run deploy secret init dev first, as its administrator',
                        ],
                        calls: ['kms DescribeKey'],
                    },
                    {
                        exitCode: 1,
                        err: [
                            `error: the caller ${operator} is not an administrator of alias/dev-secrets: init-key is run by one`,
                        ],
                        calls: ['kms DescribeKey', 'kms GetKeyPolicy'],
                    },
                    {
                        exitCode: 1,
                        err: [
                            "error: dev-svc-role does not exist: deploy svc to dev once, then run init-key, then deploy it with the key's ARN",
                        ],
                        calls: ['kms DescribeKey', 'kms GetKeyPolicy', 'iam GetRole'],
                    },
                ],
            )
        })

        it('refuses an alias that is the key of another service and name, whatever it is told', async () => {
            const taken = { ...serviceKey, Description: 'dev svc-a b' }
            const { exitCode, err, calls } = await run(
                ['init-key', 'dev', 'svc', 'a-b', '--update-policy'],
                call =>
                    call.action === 'DescribeKey' && call.parameters.KeyId === 'alias/dev-svc-a-b'
                        ? { KeyMetadata: taken }
                        : answer(statements)(call),
            )
            assert.deepStrictEqual(
                { exitCode, err, calls },
                {
                    exitCode: 1,
                    err: [
                        'error: alias/dev-svc-a-b is key key-9, described as "dev svc-a b", not "dev svc a-b": it is the key of another service or name',
                    ],
                    calls: [
                        'kms DescribeKey',
                        'kms GetKeyPolicy',
                        'iam GetRole',
                        'kms DescribeKey',
                    ],
                },
            )
        })

        it('makes a key only the service’s role may use, under a context naming it and a record', async () => {
            const { exitCode, out, calls, sent } = await run(
                ['init-key', 'dev', 'svc', 'seeds'],
                answer(statements),
            )
            assert.deepStrictEqual(
                { exitCode, out, calls, alias: sent[5] },
                {
                    exitCode: 0,
                    out: [
                        'created key key-9',
                        serviceKey.Arn,
                        "Only svc means: no other function's role, and no IAM policy. An administrator can rewrite the policy, and whoever deploys the service can ship code that uses the key.",
                    ],
                    calls: [
                        'kms DescribeKey',
                        'kms GetKeyPolicy',
                        'iam GetRole',
                        'kms DescribeKey',
                        'kms CreateKey',
                        'kms CreateAlias',
                    ],
                    alias: { AliasName: 'alias/dev-svc-seeds', TargetKeyId: 'key-9' },
                },
            )
            assert.deepStrictEqual(
                [sent[4]?.Description, policyOf(sent[4])],
                [
                    'dev svc seeds',
                    {
                        Version: '2012-10-17',
                        Statement: [
                            statements[0],
                            statements[1],
                            {
                                Sid: 'ServiceUse',
                                Effect: 'Allow',
                                Principal: { AWS: `arn:aws:iam::${account}:role/dev-svc-role` },
                                Action: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey'],
                                Resource: '*',
                                Condition: {
                                    StringEquals: { 'kms:EncryptionContext:service': 'svc' },
                                    'ForAnyValue:StringEquals': {
                                        'kms:EncryptionContextKeys': 'record',
                                    },
                                },
                            },
                        ],
                    },
                ],
            )
        })
    })
})

describe('what a failed check is taken for', () => {
    const files: { [path: string]: string } = {
        '/aws/config':
            '[profile role]\nrole_arn = arn:aws:iam::123456789012:role/r\nregion = eu-north-1\n',
    }
    const sources = (
        env: { [key: string]: string },
        exportCredentials: () => Promise<string> = () => Promise.reject(new Error('unexpected')),
    ) => ({
        env: { AWS_CONFIG_FILE: '/aws/config', AWS_SHARED_CREDENTIALS_FILE: '/aws/none', ...env },
        readFile: (path: string) => Promise.resolve(files[path]),
        exportCredentials,
    })

    it('is a refusal when this machine found it: glue, account and credentials', async () => {
        const aws = stubAws(() => identityOf(adminA))
        try {
            const refused = await Promise.all(
                [
                    () => check(noAccount),
                    () => check(otherAccount),
                    () => resolveCredentials(undefined, 'nostage', sources({})),
                    () =>
                        resolveCredentials(undefined, 'dev', sources({ AWS_ACCESS_KEY_ID: 'id' })),
                    () =>
                        resolveCredentials(
                            undefined,
                            'role',
                            sources({}, () =>
                                Promise.resolve(
                                    JSON.stringify({
                                        AccessKeyId: 'id',
                                        SecretAccessKey: 'throwaway',
                                        Expiration: '2020-01-01T00:00:00Z',
                                    }),
                                ),
                            ),
                        ),
                    () =>
                        resolveCredentials(
                            undefined,
                            'role',
                            sources({}, () =>
                                Promise.reject(
                                    new Error(
                                        'Profile role has no static keys, and aws configure export-credentials could not resolve it: no session',
                                    ),
                                ),
                            ),
                        ),
                ].map(async (call: () => Promise<unknown>) => {
                    const e = await thrownBy(() => refusing(call))
                    return e instanceof Refusal ? e.message : e
                }),
            )
            assert.deepStrictEqual(refused, [
                `Refusing to secret list on dev: ${noAccount} declares no AWS account. Give it "aws": { "accountId": "<the stage's twelve-digit account id>" } at the top level.`,
                `Refusing to secret list on dev: ${otherAccount} declares AWS account 210987654321, but profile dev reaches account ${account} as ${adminA}. Nothing was changed.`,
                'AWS profile nostage not found in /aws/config or /aws/none. Add a profile named like the stage or set AWS_PROFILE; [default] is never used in its place.',
                'The environment holds AWS_ACCESS_KEY_ID without AWS_SECRET_ACCESS_KEY. Set both or neither: half a key is not passed over in favour of profile dev.',
                'aws configure export-credentials gave credentials for profile role that expired at 2020-01-01T00:00:00Z.',
                'Profile role has no static keys, and aws configure export-credentials could not resolve it: no session',
            ])
        } finally {
            aws.restore()
        }
    })

    it('is not a refusal when AWS or the connection failed', async () => {
        const denied = stubAws(() => new Response('{}', { status: 403 }))
        try {
            const sts = await thrownBy(() => refusing(() => check(glueFile)))
            const aws = await thrownBy(() =>
                refusing(() =>
                    awsJson(context, 'ssm', 'GetParameter', {}, { names: [], delayMs: 0 }),
                ),
            )
            const connection = await thrownBy(() =>
                refusing(() => Promise.reject(new TypeError('fetch failed'))),
            )
            assert.deepStrictEqual(
                [sts, aws, connection].map(e => [
                    e instanceof Refusal,
                    Error.isError(e) ? e.name : e,
                    Error.isError(e) && 'response' in e,
                ]),
                [
                    [false, 'Error', true],
                    [false, 'AwsError', false],
                    [false, 'TypeError', false],
                ],
            )
            assert.ok(aws instanceof AwsError)
        } finally {
            denied.restore()
        }
    })

    it('exits 1 for the refusal and 3 for the rest, each on one line but the unexpected', async () => {
        const args = parseSecretArguments(['list', 'dev', '--glue', glueFile])
        assert.ok(args.command === 'secret')
        const outcome = async (env: () => Promise<typeof context.env>, answer: () => unknown) => {
            const err: string[] = []
            const aws = stubAws(answer)
            try {
                const exitCode = await runSecret(
                    args,
                    {
                        out: () => {
                            //
                        },
                        log: {
                            trace: () => {
                                //
                            },
                            warn: () => {
                                //
                            },
                            error: line => {
                                err.push(line)
                            },
                        },
                        readValue: () => Promise.resolve(''),
                    },
                    env,
                )
                return { exitCode, lines: err.length, first: err[0]?.split('\n', 1)[0] }
            } finally {
                aws.restore()
            }
        }
        assert.deepStrictEqual(
            [
                await outcome(
                    () => Promise.reject(new Error('AWS profile dev not found')),
                    () => ({}),
                ),
                await outcome(
                    () => Promise.resolve(context.env),
                    () => new Response('{}', { status: 403 }),
                ),
                await outcome(
                    () => Promise.reject(new TypeError('fetch failed')),
                    () => ({}),
                ),
            ],
            [
                { exitCode: 1, lines: 1, first: 'error: AWS profile dev not found' },
                { exitCode: 3, lines: 1, first: 'Error: Error getting caller identity.' },
                { exitCode: 3, lines: 1, first: 'TypeError: fetch failed' },
            ],
        )
    })
})

describe('a secret command and the stage its glue declares', () => {
    const bound = join(directory, 'glue.production.json')
    const secretOn = async (stage: string, region: string) => {
        const parsed = parseSecretArguments(['list', 'production', '--glue', bound])
        assert.ok(parsed.command === 'secret')
        const args = { ...parsed, stage }
        const err: string[] = []
        const record = (line: string) => {
            err.push(line)
        }
        const aws = stubAws(call =>
            call.action === 'GetCallerIdentity' ? identityOf(adminA) : { Parameters: [] },
        )
        try {
            const exitCode = await runSecret(
                args,
                {
                    out: () => undefined,
                    log: { trace: () => undefined, warn: record, error: record },
                    readValue: () => Promise.resolve('throwaway'),
                },
                () => Promise.resolve({ ...context.env, AWS_REGION: region }),
            )
            return { exitCode, err, calls: aws.calls.length }
        } finally {
            aws.restore()
        }
    }

    before(async () => {
        await writeFile(
            bound,
            JSON.stringify({
                aws: { accountId: account, stage: 'production', region: 'eu-north-1' },
                services: {},
            }),
        )
    })

    it('refuses another stage or region than the glue declares, before any request', async () => {
        assert.deepStrictEqual(
            [await secretOn('prod', 'eu-north-1'), await secretOn('production', 'eu-central-1')],
            [
                {
                    exitCode: 1,
                    err: [
                        `error: Refusing to secret list on prod: ${bound} declares stage production in aws.stage, not prod. Name the glue file of prod. Nothing was changed.`,
                    ],
                    calls: 0,
                },
                {
                    exitCode: 1,
                    err: [
                        `error: Refusing to secret list on production: ${bound} declares region eu-north-1 in aws.region, but the requests would go to eu-central-1: the region is AWS_REGION, else AWS_DEFAULT_REGION, else the profile's. Nothing was changed.`,
                    ],
                    calls: 0,
                },
            ],
        )
    })

    it('refuses a slot that got past the command line, before any request', async () => {
        assert.deepStrictEqual(await secretOn('w1', 'eu-north-1'), {
            exitCode: 1,
            err: [
                'error: secret list takes no slot: w1 has no parameters and no key of its own; a deploy to it reads those of the stage its glue names. Run the command for that stage',
            ],
            calls: 0,
        })
    })

    it('runs on the stage and region the glue declares', async () => {
        const { exitCode, err, calls } = await secretOn('production', 'eu-north-1')
        assert.deepStrictEqual(
            { exitCode, err, asked: calls !== 0 },
            {
                exitCode: 0,
                err: [],
                asked: true,
            },
        )
    })
})

describe('the secret command line', () => {
    const env = {
        PATH: process.env.PATH,
        AWS_REGION: 'eu-north-1',
        AWS_ACCESS_KEY_ID: 'test-key-id',
        AWS_SECRET_ACCESS_KEY: 'test-secret',
    }
    const secret = (args: string[], environment: { [key: string]: string | undefined } = env) =>
        spawnSync(
            process.execPath,
            [
                '--import',
                join(process.cwd(), 'test/lib/offline.js'),
                join(process.cwd(), 'bin/index.js'),
                'secret',
                ...args,
            ],
            { env: environment, encoding: 'utf-8', input: '' },
        )

    it('prints its own usage and exits 0 when asked for help, and the deploy’s is still the deploy’s', () => {
        const { status, stdout, stderr } = secret(['put', '--help'], {})
        assert.deepStrictEqual(
            { status, stdout, stderr },
            { status: 0, stdout: `${secretUsage}\n`, stderr: '' },
        )
        assert.notStrictEqual(secretUsage, usage)
    }).timeout(60_000)

    it('exits 1 with its usage for a slot, before it reads a file or a credential', () => {
        for (const args of [
            ['list', 'w9', '--glue', 'no-such-file.json'],
            ['put', 'w9', 'svc', 'TOKEN', '--glue', 'no-such-file.json'],
        ]) {
            const { status, stdout, stderr } = secret(args, {})
            assert.deepStrictEqual(
                { status, stdout, stderr },
                {
                    status: 1,
                    stdout: '',
                    stderr: `secret ${args[0]} takes no slot: w9 has no parameters and no key of its own; a deploy to it reads those of the stage its glue names. Run the command for that stage.\n\n${secretUsage}\n`,
                },
            )
        }
    }).timeout(60_000)

    it('exits 1 with one line when the stage has no profile', () => {
        const { status, stdout, stderr } = secret(['list', 'nostage', '--glue', sameAccount], {
            PATH: process.env.PATH,
            AWS_CONFIG_FILE: join(directory, 'no-config'),
            AWS_SHARED_CREDENTIALS_FILE: join(directory, 'no-credentials'),
        })
        assert.deepStrictEqual(
            { status, stdout, stderr },
            {
                status: 1,
                stdout: '',
                stderr: `error: AWS profile nostage not found in ${join(directory, 'no-config')} or ${join(directory, 'no-credentials')}. Add a profile named like the stage or set AWS_PROFILE; [default] is never used in its place.\n`,
            },
        )
    }).timeout(60_000)

    it('exits 1 with one line for a glue of another account, a glue without one and a glue that is not there', () => {
        assert.deepStrictEqual(
            [otherAccount, noAccount, join(directory, 'absent.json')].map(file => {
                const { status, stdout, stderr } = secret(['list', 'dev', '--glue', file])
                return {
                    status,
                    stdout,
                    stderr: stderr.slice(0, 21),
                    lines: stderr.split('\n').length,
                }
            }),
            [
                { status: 1, stdout: '', stderr: 'error: Refusing to se', lines: 2 },
                { status: 1, stdout: '', stderr: 'error: Refusing to se', lines: 2 },
                { status: 1, stdout: '', stderr: 'Cannot read glue file', lines: 2 },
            ],
        )
        assert.match(
            secret(['list', 'dev', '--glue', otherAccount]).stderr,
            /^error: Refusing to secret list on dev: .* declares AWS account 210987654321, but .* reaches account 123456789012 as arn:aws:iam::123456789012:user\/offline\. Nothing was changed\.\n$/u,
        )
    }).timeout(60_000)

    it('exits 3 when it passed the account check and AWS did not answer', () => {
        const { status, stdout, stderr } = secret(['list', 'dev', '--glue', sameAccount])
        assert.deepStrictEqual({ status, stdout }, { status: 3, stdout: '' })
        assert.match(
            stderr,
            /^secret list on dev as arn:aws:iam::123456789012:user\/offline\nError: Offline: no answer for POST https:\/\/ssm\.eu-north-1\.amazonaws\.com\//u,
        )
    }).timeout(60_000)

    it('exits 1 for the tripwire’s name as a key, with standard input closed', () => {
        const { status, stdout, stderr } = secret([
            'put',
            'dev',
            'svc',
            'PARAMETERS',
            '--glue',
            sameAccount,
        ])
        assert.deepStrictEqual(
            { status, stdout, stderr },
            {
                status: 1,
                stdout: '',
                stderr: 'error: PARAMETERS is the entry that marks a block with references, not a parameter\n',
            },
        )
    }).timeout(60_000)
})
