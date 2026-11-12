import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deploy } from '../index.js'
import { checkAccount } from '../lib/aws/account.js'
import { declaredAccount } from '../lib/glue.js'
import { context, stubAws } from './lib/aws.js'

describe('account', () => {
    const directory = join(tmpdir(), 'riddance', 'deploy-test-account')
    const withAccount = join(directory, 'glue.with-account.json')
    const withoutAccount = join(directory, 'glue.without-account.json')
    const identity = {
        GetCallerIdentityResponse: {
            GetCallerIdentityResult: {
                Account: '123456789012',
                Arn: 'arn:aws:sts::123456789012:assumed-role/slot-runner-w1/session',
                UserId: 'id',
            },
        },
    }

    before(async () => {
        await mkdir(directory, { recursive: true })
        await writeFile(
            withAccount,
            JSON.stringify({ aws: { accountId: '123456789012' }, services: {} }),
        )
        await writeFile(withoutAccount, JSON.stringify({ services: { crew: { aws: {} } } }))
    })

    it('refuses an account id the glue does not state as twelve digits in a string', async () => {
        for (const [name, aws] of Object.entries({
            number: { accountId: 123_456_789_012 },
            short: { accountId: '12345678901' },
            arn: { accountId: 'arn:aws:iam::123456789012:root' },
            empty: { accountId: '' },
        })) {
            const file = join(directory, `glue.${name}.json`)
            await writeFile(file, JSON.stringify({ aws }))
            await assert.rejects(declaredAccount(file), {
                message: `aws.accountId in ${file} must be a string of twelve digits.`,
            })
        }
        const file = join(directory, 'glue.list.json')
        await writeFile(file, JSON.stringify({ aws: ['123456789012'] }))
        await assert.rejects(declaredAccount(file), {
            message: `aws in ${file} must be an object.`,
        })
    })

    it('reads the account the glue declares, and none when it declares none', async () => {
        assert.deepStrictEqual(
            [await declaredAccount(withAccount), await declaredAccount(withoutAccount)],
            ['123456789012', undefined],
        )
    })

    it('refuses a glue without an account where one is required, asking nobody', async () => {
        const aws = stubAws(() => identity)
        try {
            await assert.rejects(
                checkAccount(context, 'destroy w1', withoutAccount, 'profile w1', 'refuse'),
                {
                    message: `Refusing to destroy w1: ${withoutAccount} declares no AWS account. Give it "aws": { "accountId": "<the stage's twelve-digit account id>" } at the top level.`,
                },
            )
            assert.deepStrictEqual(aws.calls, [])
        } finally {
            aws.restore()
        }
    })

    it('warns about a glue without an account where none is required', async () => {
        const aws = stubAws(() => identity)
        const warnings: string[] = []
        try {
            assert.deepStrictEqual(
                await checkAccount(
                    {
                        ...context,
                        log: {
                            ...context.log,
                            warn: (message: string) => {
                                warnings.push(message)
                            },
                        },
                    },
                    'deploy to dev',
                    withoutAccount,
                    'profile dev',
                    'warn',
                ),
                {
                    account: '123456789012',
                    arn: 'arn:aws:sts::123456789012:assumed-role/slot-runner-w1/session',
                },
            )
            assert.deepStrictEqual(warnings, [
                `${withoutAccount} declares no AWS account, so nothing checks that profile dev (account 123456789012) is where to deploy to dev. Give it "aws": { "accountId": "<the stage's twelve-digit account id>" } at the top level.`,
            ])
        } finally {
            aws.restore()
        }
    })

    it('refuses credentials of another account than the glue declares, naming both and the profile', async () => {
        const aws = stubAws(() => ({
            GetCallerIdentityResponse: {
                GetCallerIdentityResult: {
                    Account: '999999999999',
                    Arn: 'arn:aws:iam::999999999999:user/someone',
                    UserId: 'id',
                },
            },
        }))
        try {
            for (const undeclared of ['warn', 'refuse'] as const) {
                await assert.rejects(
                    checkAccount(context, 'deploy to dev', withAccount, 'profile dev', undeclared),
                    {
                        message: `Refusing to deploy to dev: ${withAccount} declares AWS account 123456789012, but profile dev reaches account 999999999999 as arn:aws:iam::999999999999:user/someone. Nothing was changed.`,
                    },
                )
            }
        } finally {
            aws.restore()
        }
    })

    it('passes credentials of the account the glue declares', async () => {
        const aws = stubAws(() => identity)
        const warnings: string[] = []
        try {
            assert.deepStrictEqual(
                await checkAccount(
                    {
                        ...context,
                        log: {
                            ...context.log,
                            warn: (message: string) => {
                                warnings.push(message)
                            },
                        },
                    },
                    'destroy w1',
                    withAccount,
                    'profile w1',
                    'refuse',
                ),
                {
                    account: '123456789012',
                    arn: 'arn:aws:sts::123456789012:assumed-role/slot-runner-w1/session',
                },
            )
            assert.deepStrictEqual(warnings, [])
        } finally {
            aws.restore()
        }
    })

    it('refuses a deploy to another account having asked only who the caller is', async () => {
        const aws = stubAws(() => ({
            GetCallerIdentityResponse: {
                GetCallerIdentityResult: {
                    Account: '999999999999',
                    Arn: 'arn:aws:iam::999999999999:user/someone',
                    UserId: 'id',
                },
            },
        }))
        try {
            await assert.rejects(
                deploy(
                    {
                        ...context,
                        log: {
                            ...context.log,
                            error: () => {
                                //
                            },
                        },
                    },
                    'dev',
                    join(process.cwd(), 'test/data/greeting'),
                    withAccount,
                    undefined,
                    undefined,
                    'profile dev',
                ),
                {
                    message: `Refusing to deploy to dev: ${withAccount} declares AWS account 123456789012, but profile dev reaches account 999999999999 as arn:aws:iam::999999999999:user/someone. Nothing was changed.`,
                },
            )
            assert.deepStrictEqual(
                aws.calls.map(call => `${call.service} ${call.action ?? call.path}`),
                ['sts GetCallerIdentity'],
            )
        } finally {
            aws.restore()
        }
    })
})
