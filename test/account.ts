import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deploy } from '../index.js'
import { checkAccount, checkSlot, checkStage } from '../lib/aws/account.js'
import { declaredAws } from '../lib/glue.js'
import { context, stubAws } from './lib/aws.js'

describe('account', () => {
    const directory = join(tmpdir(), 'riddance', 'deploy-test-account')
    const withAccount = join(directory, 'glue.with-account.json')
    const withoutAccount = join(directory, 'glue.without-account.json')
    const withSlots = join(directory, 'glue.with-slots.json')
    const identity = {
        GetCallerIdentityResponse: {
            GetCallerIdentityResult: {
                Account: '123456789012',
                Arn: 'arn:aws:sts::123456789012:assumed-role/slot-runner-w1/session',
                UserId: 'id',
            },
        },
    }

    const nothingDeclared = {
        accountId: undefined,
        slots: [],
        stage: undefined,
        region: undefined,
        newTimers: undefined,
    }
    const bound = join(directory, 'glue.production.json')

    const undeclaredWarning = `${withoutAccount} declares no AWS account, so nothing checks that profile dev (account 123456789012) is where to deploy to dev. Give it "aws": { "accountId": "<the stage's twelve-digit account id>" } at the top level.`

    before(async () => {
        await mkdir(directory, { recursive: true })
        await writeFile(
            withAccount,
            JSON.stringify({ aws: { accountId: '123456789012' }, services: {} }),
        )
        await writeFile(
            withSlots,
            JSON.stringify({ aws: { accountId: '123456789012', slots: ['w1', 'w2'] } }),
        )
        await writeFile(withoutAccount, JSON.stringify({ services: { crew: { aws: {} } } }))
        await writeFile(
            bound,
            JSON.stringify({
                aws: {
                    accountId: '123456789012',
                    slots: ['w1'],
                    stage: 'production',
                    region: 'eu-north-1',
                    newTimers: 'disabled',
                },
            }),
        )
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
            await assert.rejects(declaredAws(file), {
                message: `aws.accountId in ${file} must be a string of twelve digits.`,
            })
        }
        const file = join(directory, 'glue.list.json')
        await writeFile(file, JSON.stringify({ aws: ['123456789012'] }))
        await assert.rejects(declaredAws(file), {
            message: `aws in ${file} must be an object.`,
        })
    })

    it('refuses a key of the top-level aws object it does not know, a misspelt accountId among them', async () => {
        for (const [name, aws] of Object.entries({
            accountID: { accountID: '123456789012' },
            account: { account: '123456789012' },
            layers: { accountId: '123456789012', layers: {} },
        })) {
            const file = join(directory, `glue.unknown-${name}.json`)
            await writeFile(file, JSON.stringify({ aws }))
            await assert.rejects(declaredAws(file), {
                message: `aws in ${file} holds ${name}, which the tool does not know. The top-level aws object takes accountId, slots, stage, region, newTimers.`,
            })
        }
    })

    it('refuses a deploy whose glue misspells accountId, before any request', async () => {
        const file = join(directory, 'glue.misspelt.json')
        await writeFile(file, JSON.stringify({ aws: { accountID: '123456789012' } }))
        const aws = stubAws(() => identity)
        try {
            await assert.rejects(
                deploy(
                    { ...context, log: { ...context.log, error: () => undefined } },
                    'dev',
                    join(process.cwd(), 'test/data/greeting'),
                    file,
                    undefined,
                    undefined,
                    'profile dev',
                ),
                { message: /^aws in .* holds accountID, which the tool does not know\./u },
            )
            assert.deepStrictEqual(aws.calls, [])
        } finally {
            aws.restore()
        }
    })

    it('repeats the warning about a glue without an account after a deploy that failed', async () => {
        const aws = stubAws(() => identity)
        const warnings: string[] = []
        try {
            await assert.rejects(
                deploy(
                    {
                        ...context,
                        log: {
                            ...context.log,
                            warn: (message: string) => {
                                warnings.push(message)
                            },
                            error: () => undefined,
                        },
                    },
                    'dev',
                    directory,
                    withoutAccount,
                    undefined,
                    undefined,
                    'profile dev',
                ),
            )
            assert.deepStrictEqual(warnings, [undeclaredWarning, undeclaredWarning])
        } finally {
            aws.restore()
        }
    })

    it('reads the account the glue declares, and none when it declares none', async () => {
        assert.deepStrictEqual(
            [await declaredAws(withAccount), await declaredAws(withoutAccount)],
            [{ ...nothingDeclared, accountId: '123456789012' }, nothingDeclared],
        )
    })

    it('refuses slots the glue does not state as a list of w1 to w9', async () => {
        for (const [name, slots] of Object.entries({
            string: 'w1',
            map: { w1: true },
            stage: ['w1', 'dev'],
            beyond: ['w10'],
            pattern: ['w*'],
            number: [1],
        })) {
            const file = join(directory, `glue.slots-${name}.json`)
            await writeFile(file, JSON.stringify({ aws: { accountId: '123456789012', slots } }))
            await assert.rejects(declaredAws(file), {
                message: `aws.slots in ${file} must be a list of slot names, w1 to w9.`,
            })
        }
    })

    it('reads the slots the glue lists', async () => {
        assert.deepStrictEqual(await declaredAws(withSlots), {
            ...nothingDeclared,
            accountId: '123456789012',
            slots: ['w1', 'w2'],
        })
    })

    it('refuses a slot the glue does not list, and passes one it lists and any stage that is no slot', async () => {
        await assert.rejects(checkSlot('destroy w3', 'w3', withSlots), {
            message: `Refusing to destroy w3: ${withSlots} does not list w3 in aws.slots (it lists w1, w2). A slot is deployed and destroyed only with the glue file of the account that holds it: "aws": { "slots": ["w3"] } at the top level. Nothing was changed.`,
        })
        for (const file of [withAccount, withoutAccount]) {
            await assert.rejects(checkSlot('deploy to w1', 'w1', file), {
                message: `Refusing to deploy to w1: ${file} does not list w1 in aws.slots (it lists none). A slot is deployed and destroyed only with the glue file of the account that holds it: "aws": { "slots": ["w1"] } at the top level. Nothing was changed.`,
            })
        }
        await checkSlot('deploy to w2', 'w2', withSlots)
        for (const stage of ['dev', 'staging', 'production', 'w10']) {
            await checkSlot(`deploy to ${stage}`, stage, withoutAccount)
        }
    })

    it('refuses a deploy to a slot the glue does not list, before any request', async () => {
        const aws = stubAws(() => identity)
        try {
            await assert.rejects(
                deploy(
                    { ...context, log: { ...context.log, error: () => undefined } },
                    'w1',
                    join(process.cwd(), 'test/data/greeting'),
                    withAccount,
                    undefined,
                    undefined,
                    'profile w1',
                ),
                { message: /^Refusing to deploy to w1: .* does not list w1 in aws\.slots/u },
            )
            assert.deepStrictEqual(aws.calls, [])
        } finally {
            aws.restore()
        }
    })

    it('reads the stage, the region and the state of new timers the glue declares', async () => {
        assert.deepStrictEqual(await declaredAws(bound), {
            accountId: '123456789012',
            slots: ['w1'],
            stage: 'production',
            region: 'eu-north-1',
            newTimers: 'disabled',
        })
    })

    it('refuses a stage, a region and a state of new timers the glue states as something else', async () => {
        for (const [name, stage] of Object.entries({
            slot: 'w1',
            path: '../prod',
            empty: '',
            list: ['prod'],
        })) {
            const file = join(directory, `glue.stage-${name}.json`)
            await writeFile(file, JSON.stringify({ aws: { stage } }))
            await assert.rejects(declaredAws(file), {
                message: `aws.stage in ${file} must name the stage the file belongs to, and no slot: a slot is listed in aws.slots.`,
            })
        }
        for (const [name, region] of Object.entries({
            zone: 'eu-north-1a',
            capitals: 'EU-NORTH-1',
            unnumbered: 'eu-north',
            // eslint-disable-next-line unicorn/no-null -- as JSON may hold it
            none: null,
        })) {
            const file = join(directory, `glue.region-${name}.json`)
            await writeFile(file, JSON.stringify({ aws: { region } }))
            await assert.rejects(declaredAws(file), {
                message: `aws.region in ${file} must name an AWS region, like eu-north-1.`,
            })
        }
        for (const [name, newTimers] of Object.entries({
            enabled: 'enabled',
            state: 'DISABLED',
            flag: true,
        })) {
            const file = join(directory, `glue.timers-${name}.json`)
            await writeFile(file, JSON.stringify({ aws: { newTimers } }))
            await assert.rejects(declaredAws(file), {
                message: `aws.newTimers in ${file} must be "disabled" or left out.`,
            })
        }
    })

    it('refuses another stage than the glue declares, naming both and the file', async () => {
        for (const [intent, stage] of [
            ['deploy to prod', 'prod'],
            ['secret list on dev', 'dev'],
        ] as const) {
            await assert.rejects(checkStage(context, intent, stage, bound), {
                message: `Refusing to ${intent}: ${bound} declares stage production in aws.stage, not ${stage}. Name the glue file of ${stage}. Nothing was changed.`,
            })
        }
    })

    it('refuses another region than the glue declares, naming both and the file', async () => {
        for (const [region, named] of [
            ['eu-central-1', 'eu-central-1'],
            [undefined, 'no region'],
        ] as const) {
            await assert.rejects(
                checkStage(
                    { env: { ...context.env, AWS_REGION: region } },
                    'deploy to production',
                    'production',
                    bound,
                ),
                {
                    message: `Refusing to deploy to production: ${bound} declares region eu-north-1 in aws.region, but the requests would go to ${named}: the region is AWS_REGION, else AWS_DEFAULT_REGION, else the profile's. Nothing was changed.`,
                },
            )
        }
    })

    it('passes the stage and region the glue declares, and any where it declares neither', async () => {
        await checkStage(context, 'deploy to production', 'production', bound)
        for (const file of [withAccount, withSlots, withoutAccount]) {
            for (const stage of ['dev', 'prod', 'production', 'w1']) {
                await checkStage(
                    { env: { ...context.env, AWS_REGION: 'eu-central-1' } },
                    `deploy to ${stage}`,
                    stage,
                    file,
                )
            }
        }
    })

    it('holds a slot to the region of the glue that lists it, not to its stage', async () => {
        await checkStage(context, 'deploy to w1', 'w1', bound)
        await assert.rejects(
            checkStage(
                { env: { ...context.env, AWS_REGION: 'eu-central-1' } },
                'destroy w1',
                'w1',
                bound,
            ),
            { message: /^Refusing to destroy w1: .* declares region eu-north-1 in aws\.region/u },
        )
    })

    it('refuses a deploy to another stage or region than the glue declares, before any request', async () => {
        const aws = stubAws(() => identity)
        try {
            for (const [stage, region, message] of [
                ['prod', 'eu-north-1', /declares stage production in aws\.stage, not prod\./u],
                ['production', 'eu-central-1', /declares region eu-north-1 in aws\.region/u],
                ['w1', 'eu-central-1', /declares region eu-north-1 in aws\.region/u],
            ] as const) {
                await assert.rejects(
                    deploy(
                        {
                            env: { ...context.env, AWS_REGION: region },
                            log: { ...context.log, error: () => undefined },
                        },
                        stage,
                        join(process.cwd(), 'test/data/greeting'),
                        bound,
                        undefined,
                        undefined,
                        `profile ${stage}`,
                    ),
                    { message },
                )
            }
            assert.deepStrictEqual(aws.calls, [])
        } finally {
            aws.restore()
        }
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
                    warning: undeclaredWarning,
                },
            )
            assert.deepStrictEqual(warnings, [undeclaredWarning])
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
                    warning: undefined,
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
