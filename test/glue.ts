import assert from 'node:assert/strict'
import { createPublicKey, generateKeyPairSync } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AwsError } from '../lib/aws/lite.js'
import { Resolver } from '../lib/aws/resolve.js'
import { getGlue, parameterStage, referenceOf, resolveEnv } from '../lib/glue.js'
import { context, stubAws } from './lib/aws.js'

type Block = { env?: { [key: string]: unknown }; secrets?: { [key: string]: unknown } }

type Setup = {
    stage?: string
    services?: { [service: string]: unknown }
    slotParametersFrom?: unknown
    accountId?: string | undefined
    environments?: { [service: string]: { [key: string]: string } }
    baseUrls?: { [service: string]: string }
    parameters?: { [name: string]: { value: string; version: number } }
    denied?: string[]
}

const file = 'glue.test.json'

function fake({ environments = {}, baseUrls = {}, parameters = {}, denied }: Setup) {
    const asked = { environments: [] as string[], parameters: [] as string[][] }
    return {
        asked,
        resolver: {
            getEnvironment: (prefix: string, service: string) => {
                asked.environments.push(`${prefix}-${service}`)
                return Promise.resolve(environments[service] ?? {})
            },
            getBaseUrl: (_prefix: string, service: string) => Promise.resolve(baseUrls[service]),
            getParameters: (names: string[]) => {
                asked.parameters.push(names)
                if (denied) {
                    return Promise.reject(
                        new AwsError({
                            service: 'ssm',
                            operation: 'GetParameters',
                            code: 'AccessDeniedException',
                            names: denied,
                        }),
                    )
                }
                return Promise.resolve(
                    names.flatMap(name => {
                        const parameter = parameters[name]
                        return parameter ? [{ name, ...parameter }] : []
                    }),
                )
            },
        },
    }
}

/**
What resolving the block of `svc` answers or refuses with, what it asked of the resolver and
what it warned of: a refusal is only as good as the calls it came before.
*/
async function resolving({ env = {}, secrets = {} }: Block, setup: Setup = {}) {
    const { asked, resolver } = fake(setup)
    const warned: string[] = []
    try {
        return {
            env: await resolveEnv(env, secrets, setup.stage ?? 'dev', 'svc', resolver, {
                file,
                services: setup.services ?? {},
                slotParametersFrom: setup.slotParametersFrom,
                accountId: 'accountId' in setup ? setup.accountId : '123456789012',
                warn: message => {
                    warned.push(message)
                },
            }),
            asked,
            warned,
        }
    } catch (e) {
        return { refused: Error.isError(e) ? e.message : String(e), asked, warned }
    }
}

// spell-checker: ignore secretpart

// eslint-disable-next-line unicorn/no-null -- a glue file is JSON, which can hold one
const jsonNull = null

const copyOfCopy = (key: string) =>
    refusal(
        `svc.env.C copies ${key} of other with $SAME_AS, and ${key} there is a parameter reference (or a copy of one): the copy would carry no version. Write "$PARAMETER(other,K)" in secrets, with "PARAMETERS": true.`,
    )

const pemBody = (pem: string | Buffer) => pem.toString().split('\n').slice(1, -2).join('')

const nothingAsked = { environments: [], parameters: [] }

function refusal(message: string) {
    return { refused: message, asked: nothingAsked, warned: [] }
}

const reserved = (block: string) =>
    refusal(
        `svc.${block}.PARAMETERS is reserved. It is written "PARAMETERS": true, in secrets, and nowhere else.`,
    )

const notExact = (key: string) =>
    refusal(
        `svc.secrets.${key} holds $PARAMETER and is not exactly $PARAMETER() or $PARAMETER(<service>,<KEY>). A reference is the whole value. The value is not shown.`,
    )

const withoutTripwire = (keys: string) =>
    refusal(
        `svc.secrets holds a parameter reference (${keys}) and no "PARAMETERS": true. Add it to that block: it is what stops a tool older than 0.6.2, which would deploy the reference's text as the credential. Nothing was changed.`,
    )

describe('a parameter reference', () => {
    it('is the two exact forms and nothing near them', () => {
        assert.deepStrictEqual(
            [
                '$PARAMETER()',
                '$PARAMETER(mails,MAILGUN_API_PASSWORD)',
                '$PARAMETER(rentals-v2,_k9)',
                '$PARAMETER(a)',
                '$PARAMETER(a,b,c)',
                '$PARAMETER(,b)',
                '$PARAMETER(a, b)',
                '$PARAMETER(a/b,c)',
                '$PARAMETER(a,1b)',
                '$PARAMETER',
                '$parameter()',
                ' $PARAMETER()',
                '$PARAMETER()\n',
            ].map(referenceOf),
            [
                { own: true },
                { service: 'mails', key: 'MAILGUN_API_PASSWORD' },
                { service: 'rentals-v2', key: '_k9' },
                ...Array.from({ length: 10 }, () => undefined),
            ],
        )
    })

    it('is read from the stage itself, and for a slot from the stage its glue names', () => {
        assert.deepStrictEqual(
            [
                parameterStage('w1', 'dev'),
                parameterStage('w9', 'staging'),
                parameterStage('dev', 'staging'),
                parameterStage('staging', 'dev'),
                parameterStage('w10', 'dev'),
                parameterStage('w0', 'dev'),
            ],
            ['dev', 'staging', 'dev', 'staging', 'w10', 'w0'],
        )
    })

    it('fetches the own key, another service’s key and an own key under another name', async () => {
        assert.deepStrictEqual(
            await resolving(
                {
                    env: { STAGE: '$ENV-$SERVICE' },
                    secrets: {
                        PARAMETERS: true,
                        OWN: '$PARAMETER()',
                        SHARED: '$PARAMETER(mails,MAILGUN_API_PASSWORD)',
                        RENAMED: '$PARAMETER(svc,OTHER_NAME)',
                        LITERAL: 'plain',
                    },
                },
                {
                    parameters: {
                        '/dev/svc/OWN': { value: 'own-value', version: 3 },
                        '/dev/mails/MAILGUN_API_PASSWORD': { value: 'shared-value', version: 7 },
                        '/dev/svc/OTHER_NAME': { value: 'renamed-value', version: 1 },
                    },
                },
            ),
            {
                env: {
                    STAGE: 'dev-svc',
                    LITERAL: 'plain',
                    OWN: 'own-value',
                    SHARED: 'shared-value',
                    RENAMED: 'renamed-value',
                    PARAMETER_VERSIONS: '{"OWN":3,"SHARED":7,"RENAMED":1}',
                },
                asked: {
                    environments: [],
                    parameters: [
                        ['/dev/svc/OWN', '/dev/mails/MAILGUN_API_PASSWORD', '/dev/svc/OTHER_NAME'],
                    ],
                },
                warned: [],
            },
        )
    })

    it('asks once for a parameter two keys refer to', async () => {
        assert.deepStrictEqual(
            await resolving(
                { secrets: { PARAMETERS: true, A: '$PARAMETER()', B: '$PARAMETER(svc,A)' } },
                { parameters: { '/dev/svc/A': { value: 'a', version: 2 } } },
            ),
            {
                env: { A: 'a', B: 'a', PARAMETER_VERSIONS: '{"A":2,"B":2}' },
                asked: { environments: [], parameters: [['/dev/svc/A']] },
                warned: [],
            },
        )
    })

    it('comes out byte-identical when the fetched value holds variables', async () => {
        const value = 'a$ENVb$BASE_URL(x)c$SERVICE$RANDOM(8)$ASK()$&$1$PARAMETER()'
        assert.deepStrictEqual(
            await resolving(
                { env: { URL: '$BASE_URL(y)' }, secrets: { PARAMETERS: true, A: '$PARAMETER()' } },
                {
                    parameters: { '/dev/svc/A': { value, version: 1 } },
                    baseUrls: { y: 'https://y/' },
                },
            ),
            {
                env: { URL: 'https://y/', A: value, PARAMETER_VERSIONS: '{"A":1}' },
                asked: { environments: [], parameters: [['/dev/svc/A']] },
                warned: [],
            },
        )
    })

    it('leaves a block without one as it was resolved before, with no stamp', async () => {
        assert.deepStrictEqual(
            await resolving(
                {
                    env: {
                        A: '$ENV',
                        B: '$SAME_AS(other,X)',
                        C: '$parameter()',
                        D: 'US$ 5 a$Bc $5',
                    },
                    secrets: { E: '$SAME_AS(svc,A)' },
                },
                { environments: { other: { X: 'x' } } },
            ),
            {
                env: { A: 'dev', B: 'x', C: '$parameter()', D: 'US$ 5 a$Bc $5', E: 'dev' },
                asked: { environments: ['dev-other'], parameters: [] },
                warned: [],
            },
        )
    })
})

describe('the tripwire', () => {
    it('is no variable, has no version and is asked of no resolver', async () => {
        assert.deepStrictEqual(
            await resolving(
                { secrets: { PARAMETERS: true, A: '$PARAMETER()' } },
                { parameters: { '/dev/svc/A': { value: 'a', version: 4 } } },
            ),
            {
                env: { A: 'a', PARAMETER_VERSIONS: '{"A":4}' },
                asked: { environments: [], parameters: [['/dev/svc/A']] },
                warned: [],
            },
        )
    })

    it('may stand in a block that holds no reference, which resolves as without it', async () => {
        assert.deepStrictEqual(
            await resolving({ env: { A: '$ENV' }, secrets: { PARAMETERS: true, B: 'literal' } }),
            { env: { A: 'dev', B: 'literal' }, asked: nothingAsked, warned: [] },
        )
    })

    it('is required of a block that holds a reference, before any parameter is asked for', async () => {
        assert.deepStrictEqual(
            await resolving(
                { secrets: { A: '$PARAMETER()', L: 'literal', B: '$PARAMETER(other,K)' } },
                { parameters: { '/dev/svc/A': { value: 'a', version: 1 } } },
            ),
            withoutTripwire('A, B'),
        )
        assert.deepStrictEqual(
            await resolving({ secrets: { A: 'throwaway-$PARAMETER()' } }),
            withoutTripwire('A'),
        )
    })

    it('is reserved in env and with any value but true', async () => {
        assert.deepStrictEqual(await resolving({ env: { PARAMETERS: true } }), reserved('env'))
        assert.deepStrictEqual(await resolving({ env: { PARAMETERS: 'x' } }), reserved('env'))
        for (const value of [false, 'true', 1, { on: true }, jsonNull]) {
            assert.deepStrictEqual(
                await resolving({ secrets: { PARAMETERS: value, A: 'a' } }),
                reserved('secrets'),
            )
        }
    })

    it('refuses in the order reserved name, string, tripwire, env, form, stamp, copy', async () => {
        assert.deepStrictEqual(
            [
                await resolving({ env: { PARAMETERS: 'x' }, secrets: { A: '$PARAMETER()' } }),
                await resolving({ secrets: { PARAMETERS: false, N: 1 } }),
                await resolving({ secrets: { N: 1, A: '$PARAMETER()' } }),
                await resolving({ env: { E: '$PARAMETER()' }, secrets: { A: '$PARAMETER()' } }),
                await resolving({
                    env: { E: '$PARAMETER()' },
                    secrets: { PARAMETERS: true, A: '$PARAMETER(a)' },
                }),
                await resolving({
                    secrets: { PARAMETERS: true, A: '$PARAMETER(a)', PARAMETER_VERSIONS: '{}' },
                }),
                await resolving(
                    { env: { PARAMETER_VERSIONS: '{}', C: '$SAME_AS(other,K)' } },
                    { services: { other: { secrets: { K: '$PARAMETER()' } } } },
                ),
            ],
            [
                reserved('env'),
                reserved('secrets'),
                refusal('svc.secrets.N must be a string.'),
                withoutTripwire('A'),
                refusal(
                    'svc.env.E holds $PARAMETER: a parameter reference is written in secrets only.',
                ),
                notExact('A'),
                refusal(
                    'svc.env.PARAMETER_VERSIONS is reserved: the tool writes that variable itself, with the versions of the parameters it read.',
                ),
            ],
        )
    })
})

describe('what a block is refused for', () => {
    it('is a reference in env', async () => {
        assert.deepStrictEqual(
            [
                await resolving({ env: { E: '$PARAMETER()' }, secrets: { PARAMETERS: true } }),
                await resolving({ env: { E: 'throwaway $PARAMETER(a,b)' } }),
                await resolving({ env: { E: '$PARAMETER' } }),
            ],
            Array.from({ length: 3 }, () =>
                refusal(
                    'svc.env.E holds $PARAMETER: a parameter reference is written in secrets only.',
                ),
            ),
        )
    })

    it('is a value of secrets that holds $PARAMETER and is not one of the two forms, never shown', async () => {
        for (const value of [
            'pre-$PARAMETER()',
            '$PARAMETER()$ENV',
            '$PARAMETER()$PARAMETER()',
            '$PARAMETER(a)',
            '$PARAMETER(a,b,c)',
            '$PARAMETER(,b)',
            '$PARAMETER(a, b)',
            '$PARAMETER(a/b,c)',
            '$PARAMETER(a,1b)',
            '$PARAMETER',
            'throwaway-$PARAMETER(svc,K)',
        ]) {
            assert.deepStrictEqual(
                await resolving({ secrets: { PARAMETERS: true, K: value } }),
                notExact('K'),
                value,
            )
        }
    })

    it('is not the lower-case text, which stays a literal', async () => {
        assert.deepStrictEqual(await resolving({ secrets: { K: '$parameter()' } }), {
            env: { K: '$parameter()' },
            asked: nothingAsked,
            warned: [],
        })
    })

    it('is a value that is no string and not the tripwire', async () => {
        for (const value of [true, 5, { parameter: true }, ['a'], jsonNull]) {
            assert.deepStrictEqual(
                [
                    await resolving({ secrets: { PARAMETERS: true, K: value } }),
                    await resolving({ env: { K: value } }),
                ],
                [
                    refusal('svc.secrets.K must be a string.'),
                    refusal('svc.env.K must be a string.'),
                ],
            )
        }
    })

    it('is the stamp variable as a key', async () => {
        assert.deepStrictEqual(
            [
                await resolving({ secrets: { PARAMETER_VERSIONS: '{}' } }),
                await resolving({ env: { PARAMETER_VERSIONS: 'x' } }),
            ],
            [
                refusal(
                    'svc.secrets.PARAMETER_VERSIONS is reserved: the tool writes that variable itself, with the versions of the parameters it read.',
                ),
                refusal(
                    'svc.env.PARAMETER_VERSIONS is reserved: the tool writes that variable itself, with the versions of the parameters it read.',
                ),
            ],
        )
    })

    it('is an unknown variable, named without the rest of the value', async () => {
        assert.deepStrictEqual(
            [
                await resolving({ secrets: { X: 'abc$FOO(secretpart)def' } }),
                await resolving({ env: { X: 'abc $FOO' } }),
                await resolving({ env: { X: '$ENV-$FOO_BAR-x' } }),
                await resolving({ env: { X: '$ASK' } }),
                await resolving({ env: { X: '$SAME_AS(other)' } }),
            ],
            [
                refusal('svc.secrets.X: unknown variable $FOO'),
                refusal('svc.env.X: unknown variable $FOO'),
                refusal('svc.env.X: unknown variable $FOO_BAR'),
                refusal('svc.env.X: unknown variable $ASK'),
                refusal('svc.env.X: unknown variable $SAME_AS'),
            ],
        )
    })
})

describe('another service’s block', () => {
    const other = {
        env: { N: 5 },
        secrets: { BAD: 'pre-$PARAMETER()', REF: '$PARAMETER()', PARAMETER_VERSIONS: 'x' },
    }

    it('does not stop the deploy, whatever is wrong with it', async () => {
        assert.deepStrictEqual(
            await resolving(
                { env: { A: '$SAME_AS(other,PLAIN)' } },
                { services: { other }, environments: { other: { PLAIN: 'p' } } },
            ),
            { env: { A: 'p' }, asked: { environments: ['dev-other'], parameters: [] }, warned: [] },
        )
    })

    it('is read for whether a copied key is a reference there, well-formed or not', async () => {
        assert.deepStrictEqual(
            await resolving({ env: { C: '$SAME_AS(other,BAD)' } }, { services: { other } }),
            refusal(
                'svc.env.C copies BAD of other with $SAME_AS, and BAD there is a parameter reference (or a copy of one): the copy would carry no version. Write "$PARAMETER(other,BAD)" in secrets, with "PARAMETERS": true.',
            ),
        )
    })

    it('refuses a copy and a public key of its reference, naming the reference to write', async () => {
        const services = {
            other: { secrets: { PARAMETERS: true, K: '$PARAMETER()' } },
            reader: { secrets: { PARAMETERS: true, K: '$PARAMETER(owner,K2)' } },
        }
        assert.deepStrictEqual(
            [
                await resolving({ secrets: { C: 'pre-$SAME_AS(other,K)' } }, { services }),
                await resolving({ env: { C: '$SAME_AS(reader,K)' } }, { services }),
                await resolving({ env: { P: '$PUBLIC_KEY(other,K)' } }, { services }),
            ],
            [
                refusal(
                    'svc.secrets.C copies K of other with $SAME_AS, and K there is a parameter reference (or a copy of one): the copy would carry no version. Write "$PARAMETER(other,K)" in secrets, with "PARAMETERS": true.',
                ),
                refusal(
                    'svc.env.C copies K of reader with $SAME_AS, and K there is a parameter reference (or a copy of one): the copy would carry no version. Write "$PARAMETER(owner,K2)" in secrets, with "PARAMETERS": true.',
                ),
                refusal(
                    "svc.env.P reads K of other with $PUBLIC_KEY, and K there is a parameter reference. A public key cannot be derived from a reference in another service's block: K must stay a value other's functions hold.",
                ),
            ],
        )
    })

    it('refuses a copy of its own copy of a reference, however long the chain', async () => {
        const services = {
            other: {
                secrets: {
                    PARAMETERS: true,
                    K: '$PARAMETER()',
                    K3: '$SAME_AS(other,K2)',
                    K4: '$PUBLIC_KEY(other,K)',
                    L1: '$SAME_AS(other,L2)',
                    L2: 'x-$SAME_AS(other,L1)',
                },
                env: { K2: '$SAME_AS(other,K)' },
            },
        }
        assert.deepStrictEqual(
            [
                await resolving({ env: { C: '$SAME_AS(other,K2)' } }, { services }),
                await resolving({ env: { C: '$SAME_AS(other,K3)' } }, { services }),
            ],
            [copyOfCopy('K2'), copyOfCopy('K3')],
        )
        assert.deepStrictEqual(
            await resolving(
                { env: { C: '$SAME_AS(other,L1)', D: '$SAME_AS(other,K4)' } },
                { services, environments: { other: { L1: 'circle', K4: 'public' } } },
            ),
            {
                env: { C: 'circle', D: 'public' },
                asked: { environments: ['dev-other'], parameters: [] },
                warned: [],
            },
        )
    })

    it('is refused as a source when its functions hold the text of a reference', async () => {
        assert.deepStrictEqual(
            await resolving(
                { secrets: { C: '$SAME_AS(other,X)' } },
                { environments: { other: { X: '$PARAMETER()' } } },
            ),
            {
                refused:
                    'svc.secrets.C resolved to the text of a parameter reference: the functions of other hold that text in place of the value, as a tool older than 0.6.2 leaves it. Redeploy other with 0.6.2 or later, then this service. Nothing was changed.',
                asked: { environments: ['dev-other'], parameters: [] },
                warned: [],
            },
        )
    })
})

describe('the own service’s deployed values', () => {
    const warning =
        'svc: the deployed value of K is the text of a parameter reference and is ignored. Run "deploy secret check dev svc --glue glue.test.json"; redeploy the services that read it.'

    it('are ignored with a warning where they hold the text of a reference', async () => {
        const made = await resolving(
            { secrets: { K: '$RANDOM(128)', KEEP: '$RANDOM(128)' } },
            { environments: { svc: { K: '$PARAMETER()', KEEP: 'kept' } } },
        )
        assert.match(String(made.env?.K), /^[0-9a-f]{32}$/u)
        assert.deepStrictEqual(
            { ...made, env: { ...made.env, K: 'new' } },
            {
                env: { K: 'new', KEEP: 'kept' },
                asked: { environments: ['dev-svc'], parameters: [] },
                warned: [warning],
            },
        )
        assert.deepStrictEqual(
            await resolving(
                { secrets: { K: '$ASK()' } },
                { environments: { svc: { K: '$PARAMETER(a,b)' } } },
            ),
            {
                refused: 'Missing ASK.',
                asked: { environments: ['dev-svc'], parameters: [] },
                warned: [warning],
            },
        )
    })
})

describe('an own copy of a fetched value', () => {
    const value = 'abc$BASE_URL(x)def$ENV$&$1'

    it('is put in after all expansion, alone and inside a longer value', async () => {
        const { env, asked, warned } = await resolving(
            {
                env: {
                    BEFORE: '$RANDOM(8)',
                    COPY: '$SAME_AS(svc,KEY)',
                    LONG: 'pre-$SAME_AS(svc,KEY)-$ENV',
                    AFTER: '$RANDOM(8)',
                },
                secrets: { PARAMETERS: true, KEY: '$PARAMETER()' },
            },
            {
                parameters: { '/dev/svc/KEY': { value, version: 2 } },
                environments: { svc: { BEFORE: 'b', AFTER: 'a', KEY: 'deployed' } },
            },
        )
        assert.deepStrictEqual(
            { env, asked, warned },
            {
                env: {
                    BEFORE: 'b',
                    COPY: value,
                    LONG: `pre-${value}-dev`,
                    AFTER: 'a',
                    KEY: value,
                    PARAMETER_VERSIONS: '{"KEY":2}',
                },
                asked: { environments: ['dev-svc'], parameters: [['/dev/svc/KEY']] },
                warned: [],
            },
        )
    })

    it('gives the public key of a fetched private key', async () => {
        const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
        const secret = pemBody(privateKey.export({ type: 'sec1', format: 'pem' }))
        const { env } = await resolving(
            {
                env: { PUBLIC: '$PUBLIC_KEY(svc,KEY)' },
                secrets: { PARAMETERS: true, KEY: '$PARAMETER()' },
            },
            { parameters: { '/dev/svc/KEY': { value: secret, version: 1 } } },
        )
        assert.deepStrictEqual(env, {
            PUBLIC: pemBody(createPublicKey(privateKey).export({ type: 'spki', format: 'pem' })),
            KEY: secret,
            PARAMETER_VERSIONS: '{"KEY":1}',
        })
    })

    it('is put in once, so that nothing a credential brought is expanded', async () => {
        const parameters = {
            '/dev/svc/A': { value: 'lit$SAME_AS(svc,B)', version: 1 },
            '/dev/svc/B': { value: 'vb', version: 1 },
        }
        const both = await resolving(
            {
                env: { C: '$SAME_AS(svc,A)-$SAME_AS(svc,B)' },
                secrets: { PARAMETERS: true, A: '$PARAMETER()', B: '$PARAMETER()' },
            },
            { parameters },
        )
        const one = await resolving(
            {
                env: { C: '$SAME_AS(svc,A)-$SAME_AS(svc,B)' },
                secrets: { PARAMETERS: true, A: '$PARAMETER()', B: 'vb' },
            },
            { parameters },
        )
        assert.deepStrictEqual(
            [both.env, one.env],
            [
                {
                    C: 'lit$SAME_AS(svc,B)-vb',
                    A: 'lit$SAME_AS(svc,B)',
                    B: 'vb',
                    PARAMETER_VERSIONS: '{"A":1,"B":1}',
                },
                {
                    C: 'lit$SAME_AS(svc,B)-vb',
                    A: 'lit$SAME_AS(svc,B)',
                    B: 'vb',
                    PARAMETER_VERSIONS: '{"A":1}',
                },
            ],
        )
    })
})

describe('a slot', () => {
    const block = {
        env: { C: '$SAME_AS(other,X)' },
        secrets: { PARAMETERS: true, A: '$PARAMETER()', B: '$PARAMETER(other,K)' },
    }
    const parameters = {
        '/dev/svc/A': { value: 'a', version: 5 },
        '/dev/other/K': { value: 'k', version: 6 },
        '/staging/svc/A': { value: 'staging-a', version: 1 },
        '/staging/other/K': { value: 'staging-k', version: 2 },
    }
    const environments = { other: { X: 'slot-x' } }

    it('reads the parameters of the stage its glue names and everything else of itself', async () => {
        assert.deepStrictEqual(
            await resolving(block, {
                stage: 'w1',
                slotParametersFrom: 'dev',
                parameters,
                environments,
            }),
            {
                env: { C: 'slot-x', A: 'a', B: 'k', PARAMETER_VERSIONS: '{"A":5,"B":6}' },
                asked: {
                    environments: ['w1-other'],
                    parameters: [['/dev/svc/A', '/dev/other/K']],
                },
                warned: [],
            },
        )
    })

    it('maps what the glue says, whichever stage that is', async () => {
        assert.deepStrictEqual(
            await resolving(block, {
                stage: 'w1',
                slotParametersFrom: 'staging',
                parameters,
                environments,
            }),
            {
                env: {
                    C: 'slot-x',
                    A: 'staging-a',
                    B: 'staging-k',
                    PARAMETER_VERSIONS: '{"A":1,"B":2}',
                },
                asked: {
                    environments: ['w1-other'],
                    parameters: [['/staging/svc/A', '/staging/other/K']],
                },
                warned: [],
            },
        )
    })

    it('needs no source of parameters when its block holds no reference', async () => {
        for (const stage of ['dev', 'w1']) {
            assert.deepStrictEqual(
                await resolving({ env: { A: '$ENV' }, secrets: { PARAMETERS: true } }, { stage }),
                { env: { A: stage }, asked: nothingAsked, warned: [] },
            )
        }
    })

    it('refuses a source that is no stage or is a slot, for every stage', async () => {
        for (const from of ['w2', '', 'a/b', 5, { stage: 'dev' }, jsonNull]) {
            for (const stage of ['dev', 'w1']) {
                assert.deepStrictEqual(
                    await resolving(block, { stage, slotParametersFrom: from, parameters }),
                    refusal(
                        `slotParametersFrom in glue.test.json must name a stage that is not a slot, not ${typeof from === 'string' ? from : JSON.stringify(from)}.`,
                    ),
                )
            }
        }
    })

    it('refuses a reference when the glue names no source, before any call', async () => {
        assert.deepStrictEqual(
            await resolving(block, { stage: 'w1', parameters }),
            refusal(
                'svc.secrets.A is a parameter reference, and glue.test.json does not say whose parameters a slot reads. Give it "slotParametersFrom": "<stage>" at the top level. Nothing was changed.',
            ),
        )
    })

    it('refuses a reference when the glue declares no account, as every stage does in its own words', async () => {
        const setup = { slotParametersFrom: 'dev', accountId: undefined, parameters, environments }
        assert.deepStrictEqual(
            await resolving(block, { ...setup, stage: 'w1' }),
            refusal(
                'svc.secrets.A is a parameter reference, and glue.test.json declares no AWS account: a slot reads another stage\'s parameters only in the account its glue declares. Give it "aws": { "accountId": "…" }. Nothing was changed.',
            ),
        )
        for (const stage of ['dev', 'production']) {
            assert.deepStrictEqual(
                await resolving(block, { ...setup, stage }),
                refusal(
                    `svc.secrets.A is a parameter reference, and glue.test.json declares no AWS account: ${stage} reads its parameters only in the account its glue declares. Give it "aws": { "accountId": "…" }. Nothing was changed.`,
                ),
            )
        }
    })

    it('asks no account of a block without a reference, on any stage', async () => {
        for (const stage of ['dev', 'w1']) {
            assert.deepStrictEqual(
                await resolving(
                    { env: { C: '$SAME_AS(other,X)' }, secrets: { PARAMETERS: true, L: 'x' } },
                    { stage, accountId: undefined, environments },
                ),
                {
                    env: { C: 'slot-x', L: 'x' },
                    asked: { environments: [`${stage}-other`], parameters: [] },
                    warned: [],
                },
            )
        }
    })

    it('says whose parameter is missing and where it is put from', async () => {
        assert.deepStrictEqual(await resolving(block, { stage: 'w1', slotParametersFrom: 'dev' }), {
            refused: [
                'Parameter /dev/svc/A is missing. Put it: deploy secret put dev svc A --glue glue.test.json',
                'Parameter /dev/other/K is missing. Put it: deploy secret put dev other K --glue glue.test.json',
                "(w1 reads dev's parameters. Put it from a session with dev's own credentials, not a slot's.)",
            ].join('\n'),
            asked: { environments: [], parameters: [['/dev/svc/A', '/dev/other/K']] },
            warned: [],
        })
    })

    it('says which policies to check when the read is refused', async () => {
        assert.deepStrictEqual(
            await resolving(block, {
                stage: 'w1',
                slotParametersFrom: 'dev',
                denied: ['/dev/svc/A', '/dev/other/K'],
            }),
            {
                refused: [
                    "Not allowed to read or decrypt /dev/svc/A, /dev/other/K: check the deployer's policy and the stage key's Deployers.",
                    "For w1: the slot runner's two policies and the key's SlotReaders (RUNBOOK).",
                ].join('\n'),
                asked: { environments: [], parameters: [['/dev/svc/A', '/dev/other/K']] },
                warned: [],
            },
        )
    })
})

describe('a parameter that cannot be deployed', () => {
    const secrets = { PARAMETERS: true, A: '$PARAMETER()', B: '$PARAMETER()' }
    const glue = {
        file,
        services: {},
        slotParametersFrom: undefined,
        accountId: '123456789012',
        warn: () => {
            //
        },
    }
    const b = { Name: '/dev/svc/B', Type: 'SecureString', Value: 'b', Version: 2 }

    it('is named as missing when it is not there, before any function is listed', async () => {
        assert.deepStrictEqual(
            await resolving(
                { env: { C: '$SAME_AS(other,X)' }, secrets },
                { parameters: { '/dev/svc/B': { value: 'b', version: 1 } } },
            ),
            {
                refused:
                    'Parameter /dev/svc/A is missing. Put it: deploy secret put dev svc A --glue glue.test.json',
                asked: { environments: [], parameters: [['/dev/svc/A', '/dev/svc/B']] },
                warned: [],
            },
        )
    })

    it('is missing too when AWS answers it as invalid, empty or no SecureString', async () => {
        for (const answer of [
            { Parameters: [b], InvalidParameters: ['/dev/svc/A'] },
            {
                Parameters: [
                    b,
                    { Name: '/dev/svc/A', Type: 'SecureString', Value: '', Version: 1 },
                ],
            },
            {
                Parameters: [
                    b,
                    { Name: '/dev/svc/A', Type: 'String', Value: 'throwaway', Version: 1 },
                ],
            },
        ]) {
            const aws = stubAws(() => answer)
            try {
                await assert.rejects(
                    resolveEnv({}, secrets, 'dev', 'svc', new Resolver(context), glue),
                    {
                        message:
                            'Parameter /dev/svc/A is missing. Put it: deploy secret put dev svc A --glue glue.test.json',
                    },
                )
                assert.deepStrictEqual(aws.calls, [
                    {
                        method: 'POST',
                        service: 'ssm',
                        path: '/',
                        action: 'GetParameters',
                        parameters: { Names: ['/dev/svc/A', '/dev/svc/B'], WithDecryption: true },
                    },
                ])
            } finally {
                aws.restore()
            }
        }
    })

    it('is never called missing when the read was refused', async () => {
        const aws = stubAws(() =>
            Response.json(
                { __type: 'AccessDeniedException', message: 'throwaway' },
                { status: 400 },
            ),
        )
        try {
            await assert.rejects(
                resolveEnv({}, secrets, 'dev', 'svc', new Resolver(context), glue),
                {
                    message:
                        "Not allowed to read or decrypt /dev/svc/A, /dev/svc/B: check the deployer's policy and the stage key's Deployers.",
                },
            )
        } finally {
            aws.restore()
        }
    })

    it('leaves any other failed read as the error it is', async () => {
        const aws = stubAws(() =>
            Response.json({ __type: 'ValidationException', message: 'x' }, { status: 400 }),
        )
        try {
            await assert.rejects(
                resolveEnv({}, secrets, 'dev', 'svc', new Resolver(context), glue),
                { name: 'AwsError', code: 'ValidationException' },
            )
        } finally {
            aws.restore()
        }
    })

    it('is asked for ten names a call, decrypted', async () => {
        const names = Array.from({ length: 23 }, (_, ix) => `/dev/svc/K${ix}`)
        const aws = stubAws(({ parameters: { Names } }) => ({
            Parameters: (Array.isArray(Names) ? Names : []).map((name: unknown) => ({
                Name: name,
                Type: 'SecureString',
                Value: `value of ${String(name)}`,
                Version: 1,
            })),
        }))
        try {
            const parameters = await new Resolver(context).getParameters(names)

            assert.deepStrictEqual(
                parameters,
                names.map(name => ({ name, value: `value of ${name}`, version: 1 })),
            )
            assert.deepStrictEqual(
                aws.calls.map(call => call.parameters),
                [
                    { Names: names.slice(0, 10), WithDecryption: true },
                    { Names: names.slice(10, 20), WithDecryption: true },
                    { Names: names.slice(20), WithDecryption: true },
                ],
            )
        } finally {
            aws.restore()
        }
    })
})

describe('a deploy’s glue', () => {
    const directory = join(tmpdir(), 'riddance', 'deploy-test-glue')
    const glueFile = join(directory, 'glue.json')
    const log = {
        warn: () => {
            //
        },
    }

    before(async () => {
        await mkdir(join(directory, 'svc'), { recursive: true })
        await writeFile(join(directory, 'svc', 'package.json'), JSON.stringify({ name: 'svc' }))
        await writeFile(
            glueFile,
            JSON.stringify({
                aws: { accountId: '123456789012', slots: ['w1'] },
                slotParametersFrom: 'dev',
                implementations: {},
                websites: {},
                services: {
                    svc: {
                        env: { C: '$SAME_AS(other,X)' },
                        secrets: { PARAMETERS: true, A: '$PARAMETER()' },
                    },
                },
            }),
        )
    })

    it('is rejected by a parameter that cannot be read, before any function is listed', async () => {
        const { asked, resolver } = fake({})

        await assert.rejects(getGlue(join(directory, 'svc'), 'w1', resolver, glueFile, log), {
            message: [
                `Parameter /dev/svc/A is missing. Put it: deploy secret put dev svc A --glue ${glueFile}`,
                "(w1 reads dev's parameters. Put it from a session with dev's own credentials, not a slot's.)",
            ].join('\n'),
        })
        assert.deepStrictEqual(asked, { environments: [], parameters: [['/dev/svc/A']] })
    })

    it('has fetched its parameters when it is answered, and resolves the rest beside the build', async () => {
        const { asked, resolver } = fake({
            parameters: { '/dev/svc/A': { value: 'a', version: 9 } },
            environments: { other: { X: 'x' } },
        })

        const glue = await getGlue(join(directory, 'svc'), 'w1', resolver, glueFile, log)

        assert.deepStrictEqual(asked.parameters, [['/dev/svc/A']])
        assert.deepStrictEqual(await glue.env, {
            C: 'x',
            A: 'a',
            PARAMETER_VERSIONS: '{"A":9}',
        })
        assert.deepStrictEqual(asked.environments, ['w1-other'])
    })
})

describe('a function whose environment cannot be read', () => {
    it('is fatal to whoever lists it', async () => {
        const aws = stubAws(() => ({
            Functions: [
                {
                    FunctionName: 'dev-svc-get',
                    FunctionArn: 'arn:aws:lambda:eu-north-1:123456789012:function:dev-svc-get',
                    Environment: {
                        Error: { ErrorCode: 'AccessDeniedException', Message: 'throwaway' },
                    },
                },
            ],
            NextMarker: jsonNull,
        }))
        try {
            await assert.rejects(new Resolver(context).getEnvironment('dev', 'svc'), {
                message: 'Function dev-svc-get: environment unreadable (AccessDeniedException)',
            })
        } finally {
            aws.restore()
        }
    })
})

describe('a name that would be no parameter path', () => {
    it('is refused as the key of an own reference', async () => {
        assert.deepStrictEqual(
            [
                await resolving({ secrets: { PARAMETERS: true, 'a/b': '$PARAMETER()' } }),
                await resolving(
                    { secrets: { PARAMETERS: true, 'a/b': '$PARAMETER(svc,K)' } },
                    { parameters: { '/dev/svc/K': { value: 'k', version: 1 } } },
                ),
            ],
            [
                refusal(
                    'svc.secrets.a/b is $PARAMETER() under a key that cannot name a parameter: letters, digits and _ only, not starting with a digit.',
                ),
                {
                    env: { 'a/b': 'k', PARAMETER_VERSIONS: '{"a/b":1}' },
                    asked: { environments: [], parameters: [['/dev/svc/K']] },
                    warned: [],
                },
            ],
        )
    })

    it('is refused as the service’s name in package.json', async () => {
        const { asked, resolver } = fake({})
        await assert.rejects(
            resolveEnv(
                {},
                { PARAMETERS: true, K: '$PARAMETER()' },
                'dev',
                '../dev/other',
                resolver,
                {
                    file,
                    services: {},
                    slotParametersFrom: undefined,
                    accountId: '123456789012',
                    warn: () => {
                        //
                    },
                },
            ),
            {
                message:
                    '"../dev/other", the name in package.json, cannot name a parameter: ../dev/other.secrets.K is a parameter reference.',
            },
        )
        assert.deepStrictEqual(asked, nothingAsked)
    })
})

describe('a refused read of more than ten parameters', () => {
    it('names every parameter asked for, not only the refused call’s', async () => {
        const keys = Array.from({ length: 12 }, (_, ix) => `K${ix}`)
        const aws = stubAws(({ parameters: { Names } }) =>
            Array.isArray(Names) && Names.length === 10
                ? {
                      Parameters: Names.map((name: unknown) => ({
                          Name: name,
                          Type: 'SecureString',
                          Value: 'v',
                          Version: 1,
                      })),
                  }
                : Response.json({ __type: 'AccessDeniedException' }, { status: 400 }),
        )
        try {
            await assert.rejects(
                resolveEnv(
                    {},
                    {
                        PARAMETERS: true,
                        ...Object.fromEntries(keys.map(key => [key, '$PARAMETER()'])),
                    },
                    'dev',
                    'svc',
                    new Resolver(context),
                    {
                        file,
                        services: {},
                        slotParametersFrom: undefined,
                        accountId: '123456789012',
                        warn: () => {
                            //
                        },
                    },
                ),
                {
                    message: `Not allowed to read or decrypt ${keys.map(key => `/dev/svc/${key}`).join(', ')}: check the deployer's policy and the stage key's Deployers.`,
                },
            )
        } finally {
            aws.restore()
        }
    })
})
