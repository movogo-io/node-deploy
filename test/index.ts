import { fetchJson, fetchOK, jsonResponse, thrownHasStatus } from '@riddance/fetch'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { deploy } from '../index.js'
import { awsFormRequest, localAwsEnv } from '../lib/aws/lite.js'
import { install } from '../lib/npm.js'
import { compile } from './lib/compile.js'

describe('deploy', () => {
    it('should deploy greeting', async () => {
        const log = new Log()
        await Promise.all([deployTestCase(log, 'greeting'), deployTestCase(log, 'subber')])
        const frontDoorHost = await deployTestCase(log, 'front-door')
        assert.deepStrictEqual(log.issues, [])
        assert.ok(frontDoorHost)

        const greeting = await fetchJson<{ message: string }>(
            frontDoorHost,
            { headers },
            'Error fetching greeting',
        )
        assert.strictEqual(greeting.message, 'Hello from Riddance, World!')
    }).timeout(60_000)

    it('should deploy tick-tock', async () => {
        const log = new Log()
        await deployTestCase(log, 'tick-tock')
        assert.deepStrictEqual(log.issues, [])
    }).timeout(30_000)

    it('should follow the handler filter and topic on every redeploy', async () => {
        const log = new Log()
        const topicArnPrefix = await testTopicArnPrefix()
        await deployTestCase(log, 'filtered-a')
        await eventually(async () => {
            assert.deepStrictEqual(await filterPolicy(topicArnPrefix), { kind: ['a'] })
        })
        await deployTestCase(log, 'filtered-b')
        await eventually(async () => {
            assert.deepStrictEqual(await filterPolicy(topicArnPrefix), {
                kind: ['b', 'c'],
                tier: ['gold'],
            })
        })
        await deployTestCase(log, 'filtered-none')
        await eventually(async () => {
            assert.deepStrictEqual(await filterPolicy(topicArnPrefix), {})
        })
        await deployTestCase(log, 'filtered-moved')
        await eventually(async () => {
            assert.deepStrictEqual(
                Object.keys(await subscribers(topicArnPrefix, 'status-greeting')),
                [],
            )
            assert.deepStrictEqual(
                Object.keys(await subscribers(topicArnPrefix, 'status-farewell')),
                ['greet-filter'],
            )
        })
        await deployTestCase(log, 'filtered-renamed')
        await eventually(async () => {
            assert.deepStrictEqual(
                Object.keys(await subscribers(topicArnPrefix, 'status-farewell')),
                ['greet-other'],
            )
        })
        assert.deepStrictEqual(log.issues, [])
    }).timeout(300_000)

    it('should deploy big twice', async () => {
        const log = new Log()
        await deployTestCase(log, 'big')
        const host = await deployTestCase(log, 'big')
        assert.deepStrictEqual(log.issues, [])
        assert.ok(host)

        const result = await Promise.allSettled(
            Array.from({ length: 32 }, (_, ix) =>
                retry(() => fetchOK(`${host}${ix + 1}`, { headers }, `big #${ix + 1} failed`)),
            ),
        )
        assert.deepStrictEqual(
            result
                .filter(r => r.status === 'rejected')
                .map(
                    r =>
                        `${r.reason.message} (GET ${r.reason.response?.url}, status ${r.reason.response?.status})`,
                ),
            [],
            'Error fetching',
        )
    }).timeout(60_000)
})

async function deployTestCase(log: Log, name: string) {
    const path = join(process.cwd(), 'test/data/' + name)
    await install(path)
    compile(path)
    const stagePath = join(tmpdir(), 'riddance', 'deploy-test-stage', name)
    const { host } = await deploy(
        {
            log,
            env: await localAwsEnv(undefined, 'deploy-test'),
        },
        'deploy-test',
        path,
        undefined,
        stagePath,
    )
    return host
}

async function retry(fn: () => Promise<void>) {
    for (let i = 0; ; ++i) {
        try {
            await fn()
            return
        } catch (e) {
            if (thrownHasStatus(e, 503) && i < 5) {
                await setTimeout(1000)
                continue
            }
            throw e
        }
    }
}

async function filterPolicy(topicArnPrefix: string) {
    const subscriptionArn = (await subscribers(topicArnPrefix, 'status-greeting'))['greet-filter']
    if (!subscriptionArn) {
        return undefined
    }
    const {
        GetSubscriptionAttributesResponse: {
            GetSubscriptionAttributesResult: { Attributes: attributes },
        },
    } = await jsonResponse<{
        GetSubscriptionAttributesResponse: {
            GetSubscriptionAttributesResult: { Attributes: { FilterPolicy?: string } }
        }
    }>(
        awsFormRequest(
            await awsContext(),
            'POST',
            'sns',
            '',
            new URLSearchParams({
                Action: 'GetSubscriptionAttributes',
                Version: '2010-03-31',
                SubscriptionArn: subscriptionArn,
            }),
        ),
        'Error getting subscription attributes.',
    )
    const policy: unknown = JSON.parse(attributes.FilterPolicy ?? '{}')
    return policy
}

async function subscribers(topicArnPrefix: string, topic: string) {
    const {
        ListSubscriptionsByTopicResponse: {
            ListSubscriptionsByTopicResult: { Subscriptions: subscriptions },
        },
    } = await jsonResponse<{
        ListSubscriptionsByTopicResponse: {
            ListSubscriptionsByTopicResult: {
                Subscriptions: { Endpoint: string; SubscriptionArn: string }[]
            }
        }
    }>(
        awsFormRequest(
            await awsContext(),
            'POST',
            'sns',
            '',
            new URLSearchParams({
                Action: 'ListSubscriptionsByTopic',
                Version: '2010-03-31',
                TopicArn: topicArnPrefix + topic,
            }),
        ),
        'Error listing subscriptions.',
    )
    const functionPrefix = ':function:deploy-test-filtered-'
    return Object.fromEntries(
        subscriptions
            .filter(s => s.Endpoint.includes(functionPrefix))
            .map(s => [s.Endpoint.split(functionPrefix)[1], s.SubscriptionArn]),
    )
}

async function testTopicArnPrefix() {
    const context = await awsContext()
    const {
        GetCallerIdentityResponse: {
            GetCallerIdentityResult: { Account: account },
        },
    } = await jsonResponse<{
        GetCallerIdentityResponse: { GetCallerIdentityResult: { Account: string } }
    }>(
        awsFormRequest(
            context,
            'POST',
            'sts',
            '',
            new URLSearchParams({ Action: 'GetCallerIdentity', Version: '2011-06-15' }),
        ),
        'Error getting account.',
    )
    return `arn:aws:sns:${context.env.AWS_REGION}:${account}:deploy-test-`
}

async function awsContext() {
    return { log: new Log(), env: await localAwsEnv(undefined, 'deploy-test') }
}

async function eventually(assertion: () => Promise<void>) {
    for (let i = 0; ; ++i) {
        try {
            await assertion()
            return
        } catch (e) {
            if (i < 10) {
                await setTimeout(2000)
                continue
            }
            throw e
        }
    }
}

const headers = {
    'user-agent': 'Riddance/1 (Deploy test)',
}

class Log {
    issues: string[] = []

    trace() {
        //
    }
    warn(message: string) {
        if (message.startsWith('CIRCULAR_DEPENDENCY') || message.includes(' -> ')) {
            return
        }
        this.issues.push(message)
    }
    error(message: string) {
        this.issues.push(message)
    }
}
