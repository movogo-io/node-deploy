import assert from 'node:assert/strict'
import { ruleChanges, syncEventBridge } from '../lib/aws/services/event-bridge.js'
import { context, stubAws } from './lib/aws.js'

describe('timer rules', () => {
    it('creates a rule enabled on a stage that has none', () => {
        assert.deepStrictEqual(ruleChanges([{ name: 'sweep', schedule: '0 3 * * *' }], []), {
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
            ).remove,
            ['retired'],
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
            ])
        } finally {
            aws.restore()
        }
    })
})
