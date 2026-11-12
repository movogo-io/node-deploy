import assert from 'node:assert/strict'
import {
    listRuleTargetIds,
    ruleChanges,
    syncEventBridge,
} from '../lib/aws/services/event-bridge.js'
import { context, stubAws } from './lib/aws.js'

describe('timer rules', () => {
    it('creates a rule enabled on a stage that has none', () => {
        assert.deepStrictEqual(ruleChanges([{ name: 'sweep', schedule: '0 3 * * *' }], [], 'dev'), {
            put: [{ name: 'sweep', schedule: '0 3 * * *', state: 'ENABLED' }],
            remove: [],
        })
    })

    it('keeps the state of an existing rule, whatever the others have', () => {
        assert.deepStrictEqual(
            ruleChanges(
                [
                    { name: 'sweep', schedule: '0 3 * * *' },
                    { name: 'remind', schedule: '*/5 * * * *' },
                ],
                [
                    { name: 'sweep', state: 'DISABLED' },
                    { name: 'remind', state: 'ENABLED' },
                ],
                'dev',
            ),
            {
                put: [
                    { name: 'sweep', schedule: '0 3 * * *', state: 'DISABLED' },
                    { name: 'remind', schedule: '*/5 * * * *', state: 'ENABLED' },
                ],
                remove: [],
            },
        )
    })

    it('creates a rule disabled only where every other rule of the service is', () => {
        assert.deepStrictEqual(
            ruleChanges(
                [{ name: 'fresh', schedule: '0 3 * * *' }],
                [
                    { name: 'sweep', state: 'DISABLED' },
                    { name: 'remind', state: 'DISABLED' },
                ],
                'dev',
            ).put,
            [{ name: 'fresh', schedule: '0 3 * * *', state: 'DISABLED' }],
        )
        assert.deepStrictEqual(
            ruleChanges(
                [{ name: 'fresh', schedule: '0 3 * * *' }],
                [
                    { name: 'sweep', state: 'DISABLED' },
                    { name: 'remind', state: 'ENABLED' },
                ],
                'dev',
            ).put,
            [{ name: 'fresh', schedule: '0 3 * * *', state: 'ENABLED' }],
        )
    })

    it('removes the rule of a timer the code no longer has', () => {
        assert.deepStrictEqual(
            ruleChanges(
                [{ name: 'sweep', schedule: '0 3 * * *' }],
                [
                    { name: 'sweep', state: 'ENABLED' },
                    { name: 'retired', state: 'ENABLED' },
                ],
                'dev',
            ).remove,
            ['retired'],
        )
    })

    it('creates a rule enabled on every stage that is not a slot', () => {
        for (const stage of ['dev', 'staging', 'production', 'w0', 'w10', 'W1', 'w1-dev']) {
            assert.deepStrictEqual(
                ruleChanges(
                    [
                        { name: 'sweep', schedule: '0 3 * * *' },
                        { name: 'fresh', schedule: '*/5 * * * *' },
                    ],
                    [{ name: 'sweep', state: 'ENABLED' }],
                    stage,
                ),
                {
                    put: [
                        { name: 'sweep', schedule: '0 3 * * *', state: 'ENABLED' },
                        { name: 'fresh', schedule: '*/5 * * * *', state: 'ENABLED' },
                    ],
                    remove: [],
                },
                stage,
            )
        }
    })

    it('creates a rule disabled on a slot, whatever the others have', () => {
        for (const stage of ['w1', 'w9']) {
            assert.deepStrictEqual(
                ruleChanges([{ name: 'fresh', schedule: '0 3 * * *' }], [], stage).put,
                [{ name: 'fresh', schedule: '0 3 * * *', state: 'DISABLED' }],
                stage,
            )
            assert.deepStrictEqual(
                ruleChanges(
                    [{ name: 'fresh', schedule: '0 3 * * *' }],
                    [
                        { name: 'sweep', state: 'ENABLED' },
                        { name: 'remind', state: 'ENABLED' },
                    ],
                    stage,
                ).put,
                [{ name: 'fresh', schedule: '0 3 * * *', state: 'DISABLED' }],
                stage,
            )
            assert.deepStrictEqual(
                ruleChanges(
                    [{ name: 'fresh', schedule: '0 3 * * *' }],
                    [
                        { name: 'sweep', state: 'DISABLED' },
                        { name: 'remind', state: 'ENABLED' },
                    ],
                    stage,
                ).put,
                [{ name: 'fresh', schedule: '0 3 * * *', state: 'DISABLED' }],
                stage,
            )
        }
    })

    it('keeps the state of an existing rule on a slot, and removes a retired one', () => {
        assert.deepStrictEqual(
            ruleChanges(
                [
                    { name: 'sweep', schedule: '0 3 * * *' },
                    { name: 'remind', schedule: '*/5 * * * *' },
                ],
                [
                    { name: 'sweep', state: 'ENABLED' },
                    { name: 'remind', state: 'DISABLED' },
                    { name: 'retired', state: 'ENABLED' },
                ],
                'w1',
            ),
            {
                put: [
                    { name: 'sweep', schedule: '0 3 * * *', state: 'ENABLED' },
                    { name: 'remind', schedule: '*/5 * * * *', state: 'DISABLED' },
                ],
                remove: ['retired'],
            },
        )
    })

    it('sends each rule with its state, deletes a retired rule with its target, and leaves the rules of others alone', async () => {
        const tags: { [arn: string]: { Key: string; Value: string }[] | undefined } = {
            'arn:retired': [
                { Key: 'environment', Value: 'w1' },
                { Key: 'service', Value: 'crew' },
            ],
            'arn:v2-tick': [
                { Key: 'environment', Value: 'w1' },
                { Key: 'service', Value: 'crew-v2' },
            ],
            'arn:by-hand': [],
        }
        const warnings: string[] = []
        const aws = stubAws(({ action, parameters }) => {
            switch (action) {
                case 'ListRules':
                    return {
                        Rules: [
                            { Name: 'w1-crew-sweep', Arn: 'arn:sweep', State: 'DISABLED' },
                            { Name: 'w1-crew-retired', Arn: 'arn:retired', State: 'DISABLED' },
                            { Name: 'w1-crew-v2-tick', Arn: 'arn:v2-tick', State: 'ENABLED' },
                            { Name: 'w1-crew-by-hand', Arn: 'arn:by-hand', State: 'ENABLED' },
                        ],
                    }
                case 'ListTagsForResource':
                    return { Tags: tags[parameters.ResourceARN as string] }
                case 'ListTargetsByRule':
                    return { Targets: [{ Id: 'w1-crew-retired', Arn: 'arn:function' }] }
                case 'PutRule':
                    return { RuleArn: 'arn:rule' }
                case 'DeleteRule':
                    return new Response('')
                default:
                    return { FailedEntryCount: 0 }
            }
        })
        try {
            await syncEventBridge(
                {
                    ...context,
                    log: {
                        ...context.log,
                        warn: message => {
                            warnings.push(message)
                        },
                    },
                },
                'eu-north-1',
                '123456789012',
                'w1',
                'crew',
                {
                    timers: [
                        { name: 'sweep', schedule: '0 3 * * *', config: {} },
                        { name: 'fresh', schedule: '*/5 * * * *', config: {} },
                    ],
                },
            )

            const tagged = [
                { Key: 'framework', Value: 'riddance' },
                { Key: 'environment', Value: 'w1' },
                { Key: 'service', Value: 'crew' },
            ]
            assert.deepStrictEqual(
                aws.calls
                    .filter(call => !call.action?.startsWith('List'))
                    .map(({ action, parameters }) => ({ action, parameters })),
                [
                    {
                        action: 'RemoveTargets',
                        parameters: { Rule: 'w1-crew-retired', Ids: ['w1-crew-retired'] },
                    },
                    { action: 'DeleteRule', parameters: { Name: 'w1-crew-retired' } },
                    {
                        action: 'PutRule',
                        parameters: {
                            Name: 'w1-crew-sweep',
                            ScheduleExpression: 'cron(0 3 * * ? *)',
                            State: 'DISABLED',
                            Tags: tagged,
                        },
                    },
                    {
                        action: 'PutTargets',
                        parameters: {
                            Rule: 'w1-crew-sweep',
                            Targets: [
                                {
                                    Id: 'w1-crew-sweep',
                                    Arn: 'arn:aws:lambda:eu-north-1:123456789012:function:w1-crew-sweep',
                                },
                            ],
                        },
                    },
                    {
                        action: 'PutRule',
                        parameters: {
                            Name: 'w1-crew-fresh',
                            ScheduleExpression: 'cron(*/5 * * * ? *)',
                            State: 'DISABLED',
                            Tags: tagged,
                        },
                    },
                    {
                        action: 'PutTargets',
                        parameters: {
                            Rule: 'w1-crew-fresh',
                            Targets: [
                                {
                                    Id: 'w1-crew-fresh',
                                    Arn: 'arn:aws:lambda:eu-north-1:123456789012:function:w1-crew-fresh',
                                },
                            ],
                        },
                    },
                ],
            )
            assert.deepStrictEqual(warnings, [
                'left alone: rule w1-crew-by-hand is not tagged service=crew environment=w1 (tags: {}); delete or re-tag it by hand if it is a leftover of this service',
                "new timers of crew created disabled (fresh): w1 is a slot, and a slot's timers stay off until they are enabled",
            ])
        } finally {
            aws.restore()
        }
    })

    it('creates the new rules of a slot disabled beside an enabled one, says so once, and still deletes a retired rule', async () => {
        const warnings: string[] = []
        const aws = stubAws(({ action }) => {
            switch (action) {
                case 'ListRules':
                    return {
                        Rules: [
                            { Name: 'w2-crew-sweep', Arn: 'arn:sweep', State: 'ENABLED' },
                            { Name: 'w2-crew-retired', Arn: 'arn:retired', State: 'ENABLED' },
                        ],
                    }
                case 'ListTagsForResource':
                    return {
                        Tags: [
                            { Key: 'environment', Value: 'w2' },
                            { Key: 'service', Value: 'crew' },
                        ],
                    }
                case 'ListTargetsByRule':
                    return { Targets: [{ Id: 'w2-crew-retired', Arn: 'arn:function' }] }
                case 'PutRule':
                    return { RuleArn: 'arn:rule' }
                case 'DeleteRule':
                    return new Response('')
                default:
                    return { FailedEntryCount: 0 }
            }
        })
        try {
            await syncEventBridge(
                {
                    ...context,
                    log: {
                        ...context.log,
                        warn: message => {
                            warnings.push(message)
                        },
                    },
                },
                'eu-north-1',
                '123456789012',
                'w2',
                'crew',
                {
                    timers: [
                        { name: 'sweep', schedule: '0 3 * * *', config: {} },
                        { name: 'fresh', schedule: '*/5 * * * *', config: {} },
                        { name: 'remind', schedule: '0 * * * *', config: {} },
                    ],
                },
            )

            assert.deepStrictEqual(
                aws.calls
                    .filter(call =>
                        ['PutRule', 'RemoveTargets', 'DeleteRule'].includes(call.action ?? ''),
                    )
                    .map(({ action, parameters: { Name: name, Rule: rule, State: state } }) => ({
                        action,
                        rule: name ?? rule,
                        state,
                    })),
                [
                    { action: 'RemoveTargets', rule: 'w2-crew-retired', state: undefined },
                    { action: 'DeleteRule', rule: 'w2-crew-retired', state: undefined },
                    { action: 'PutRule', rule: 'w2-crew-sweep', state: 'ENABLED' },
                    { action: 'PutRule', rule: 'w2-crew-fresh', state: 'DISABLED' },
                    { action: 'PutRule', rule: 'w2-crew-remind', state: 'DISABLED' },
                ],
            )
            assert.deepStrictEqual(warnings, [
                "new timers of crew created disabled (fresh, remind): w2 is a slot, and a slot's timers stay off until they are enabled",
            ])
        } finally {
            aws.restore()
        }
    })

    it('says nothing on a slot that gets no new rule', async () => {
        const warnings: string[] = []
        const aws = stubAws(({ action }) => {
            switch (action) {
                case 'ListRules':
                    return {
                        Rules: [{ Name: 'w2-crew-sweep', Arn: 'arn:sweep', State: 'ENABLED' }],
                    }
                case 'PutRule':
                    return { RuleArn: 'arn:rule' }
                default:
                    return { FailedEntryCount: 0 }
            }
        })
        try {
            await syncEventBridge(
                {
                    ...context,
                    log: {
                        ...context.log,
                        warn: message => {
                            warnings.push(message)
                        },
                    },
                },
                'eu-north-1',
                '123456789012',
                'w2',
                'crew',
                { timers: [{ name: 'sweep', schedule: '0 3 * * *', config: {} }] },
            )

            assert.deepStrictEqual(
                aws.calls
                    .filter(call => call.action === 'PutRule')
                    .map(call => call.parameters.State),
                ['ENABLED'],
            )
            assert.deepStrictEqual(warnings, [])
        } finally {
            aws.restore()
        }
    })

    it('creates the new rules of a stage that is not a slot enabled, and says nothing', async () => {
        const warnings: string[] = []
        const aws = stubAws(({ action }) => {
            switch (action) {
                case 'ListRules':
                    return { Rules: [] }
                case 'PutRule':
                    return { RuleArn: 'arn:rule' }
                default:
                    return { FailedEntryCount: 0 }
            }
        })
        try {
            await syncEventBridge(
                {
                    ...context,
                    log: {
                        ...context.log,
                        warn: message => {
                            warnings.push(message)
                        },
                    },
                },
                'eu-north-1',
                '123456789012',
                'dev',
                'crew',
                {
                    timers: [
                        { name: 'sweep', schedule: '0 3 * * *', config: {} },
                        { name: 'fresh', schedule: '*/5 * * * *', config: {} },
                    ],
                },
            )

            assert.deepStrictEqual(
                aws.calls
                    .filter(call => call.action === 'PutRule')
                    .map(({ parameters: { Name: name, State: state } }) => ({ name, state })),
                [
                    { name: 'dev-crew-sweep', state: 'ENABLED' },
                    { name: 'dev-crew-fresh', state: 'ENABLED' },
                ],
            )
            assert.deepStrictEqual(warnings, [])
        } finally {
            aws.restore()
        }
    })

    it('lists the targets of a rule to the last page', async () => {
        const aws = stubAws(({ parameters: { NextToken: next } }) =>
            next === 'second'
                ? { Targets: [{ Id: 'b' }] }
                : { Targets: [{ Id: 'a' }], NextToken: 'second' },
        )
        try {
            assert.deepStrictEqual(await listRuleTargetIds(context, 'w1-crew-sweep'), ['a', 'b'])
        } finally {
            aws.restore()
        }
    })
})
