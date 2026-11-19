import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArguments } from '../lib/arguments.js'
import { destroy, executeDestroy } from '../lib/aws/destroy.js'
import { GlueFileError } from '../lib/glue.js'
import { type AwsCall, context, stubAws } from './lib/aws.js'

// An account holding the slot w1 beside dev and w10, with hand-made and wrongly tagged leftovers
// under w1's prefix. Nothing here is deleted by the stub: the tests read what was asked for.
const functions: { [name: string]: { [key: string]: string } | undefined } = {
    'w1-crew-get': { environment: 'w1', service: 'crew' },
    'w1-crew-sweep': { environment: 'w1', service: 'crew' },
    'w1-crew-v2-get': { environment: 'w1', service: 'crew-v2' },
    'w1-crew-borrowed': { environment: 'dev', service: 'crew' },
    'w1-by-hand': undefined,
    'w10-crew-get': { environment: 'w1', service: 'crew' },
    'dev-crew-get': { environment: 'dev', service: 'crew' },
}
const apis = [
    { apiId: 'a1', name: 'w1-crew', tags: { environment: 'w1', service: 'crew' } },
    { apiId: 'a2', name: 'w1-crew-v2', tags: { environment: 'w1', service: 'crew-v2' } },
    { apiId: 'a3', name: 'w1-by-hand', tags: {} },
    { apiId: 'a4', name: 'w1-borrowed', tags: { environment: 'dev' } },
    { apiId: 'a5', name: 'dev-crew', tags: { environment: 'dev', service: 'crew' } },
    { apiId: 'a6', name: 'w10-crew', tags: { environment: 'w1', service: 'crew' } },
]
const rules: { [name: string]: { Key: string; Value: string }[] } = {
    'w1-crew-sweep': [
        { Key: 'environment', Value: 'w1' },
        { Key: 'service', Value: 'crew' },
    ],
    'w1-by-hand': [],
    'w10-crew-sweep': [{ Key: 'environment', Value: 'w1' }],
    'dev-crew-sweep': [{ Key: 'environment', Value: 'dev' }],
}
const topics: { [name: string]: { Key: string; Value: string }[] | null } = {
    'w1-rental-created': [{ Key: 'environment', Value: 'w1' }],
    // eslint-disable-next-line unicorn/no-null -- as SNS answers for a topic without tags
    'w1-by-hand': null,
    'dev-rental-created': [{ Key: 'environment', Value: 'dev' }],
}
const roles: { [name: string]: { Key: string; Value: string }[] } = {
    'w1-crew-role': [
        { Key: 'environment', Value: 'w1' },
        { Key: 'service', Value: 'crew' },
    ],
    'w1-crew-v2-role': [
        { Key: 'environment', Value: 'w1' },
        { Key: 'service', Value: 'crew-v2' },
    ],
    'w1-attached-role': [{ Key: 'environment', Value: 'w1' }],
    'w1-by-hand-role': [],
    'w1-admin': [{ Key: 'environment', Value: 'w1' }],
    'dev-crew-role': [{ Key: 'environment', Value: 'dev' }],
}
const logGroups = [
    '/aws/lambda/w1-crew-get',
    '/aws/lambda/w1-crew-retired',
    '/aws/lambda/w1-crew-v2-get',
    '/aws/lambda/w1-crew-borrowed',
    '/aws/lambda/w1-by-hand',
    '/aws/lambda/w10-crew-get',
    '/aws/lambda/dev-crew-get',
]

function text(value: unknown) {
    return typeof value === 'string' ? value : ''
}

function answer({ method, service, path, action, parameters }: AwsCall): unknown {
    if (method === 'DELETE') {
        // eslint-disable-next-line unicorn/no-null -- a 204 has no body
        return new Response(null, { status: 204 })
    }
    switch (`${service} ${action ?? path}`) {
        case 'sts GetCallerIdentity':
            return {
                GetCallerIdentityResponse: {
                    GetCallerIdentityResult: {
                        Account: '123456789012',
                        Arn: 'arn:aws:sts::123456789012:assumed-role/w1',
                    },
                },
            }
        case 'lambda /2015-03-31/functions/':
            return {
                Functions: Object.keys(functions).map(name => ({
                    FunctionName: name,
                    FunctionArn: `arn:aws:lambda:eu-north-1:123456789012:function:${name}`,
                    Layers: [
                        {
                            Arn: 'arn:aws:lambda:eu-north-1:123456789012:layer:w1-chromium:3',
                            CodeSize: 81_000_000,
                        },
                    ],
                })),
                // eslint-disable-next-line unicorn/no-null -- as the API ends a listing
                NextMarker: null,
            }
        case 'apigateway /v2/apis/':
            return { items: apis }
        case 'events ListRules':
            return {
                Rules: Object.keys(rules)
                    .filter(name => name.startsWith(text(parameters.NamePrefix)))
                    .map(name => ({ Name: name, Arn: `arn:rule/${name}`, State: 'ENABLED' })),
            }
        case 'events ListTagsForResource':
            return { Tags: rules[text(parameters.ResourceARN).slice('arn:rule/'.length)] }
        case 'events ListTargetsByRule':
            return { Targets: [{ Id: text(parameters.Rule) }] }
        case 'events RemoveTargets':
            return { FailedEntryCount: 0 }
        case 'events DeleteRule':
        case 'logs DeleteLogGroup':
            return new Response('')
        case 'sns ListTopics':
            return {
                ListTopicsResponse: {
                    ListTopicsResult: {
                        Topics: Object.keys(topics).map(name => ({
                            TopicArn: `arn:aws:sns:eu-north-1:123456789012:${name}`,
                        })),
                        // eslint-disable-next-line unicorn/no-null -- as SNS ends a listing
                        NextToken: null,
                    },
                },
            }
        case 'sns ListTagsForResource':
            return {
                ListTagsForResourceResponse: {
                    ListTagsForResourceResult: {
                        Tags: topics[
                            text(parameters.ResourceArn).slice(
                                'arn:aws:sns:eu-north-1:123456789012:'.length,
                            )
                        ],
                    },
                },
            }
        case 'sns ListSubscriptionsByTopic':
            return {
                ListSubscriptionsByTopicResponse: {
                    ListSubscriptionsByTopicResult: {
                        Subscriptions: [
                            {
                                Protocol: 'lambda',
                                Endpoint:
                                    'arn:aws:lambda:eu-north-1:123456789012:function:w1-crew-get',
                                SubscriptionArn: `${text(parameters.TopicArn)}:sub-crew`,
                            },
                            {
                                Protocol: 'lambda',
                                Endpoint:
                                    'arn:aws:lambda:eu-north-1:123456789012:function:w1-crew-v2-get',
                                SubscriptionArn: `${text(parameters.TopicArn)}:sub-crew-v2`,
                            },
                            {
                                Protocol: 'email',
                                Endpoint: 'someone@example.com',
                                SubscriptionArn: 'PendingConfirmation',
                            },
                        ],
                        // eslint-disable-next-line unicorn/no-null -- as SNS ends a listing
                        NextToken: null,
                    },
                },
            }
        case 'iam ListRoles':
            return {
                ListRolesResponse: {
                    ListRolesResult: {
                        Roles: Object.keys(roles).map(name => ({ RoleName: name })),
                        IsTruncated: false,
                        // eslint-disable-next-line unicorn/no-null -- as IAM ends a listing
                        Marker: null,
                    },
                },
            }
        case 'iam ListRoleTags':
            return {
                ListRoleTagsResponse: {
                    ListRoleTagsResult: { Tags: roles[text(parameters.RoleName)] },
                },
            }
        case 'iam ListRolePolicies':
            return {
                ListRolePoliciesResponse: {
                    ListRolePoliciesResult: {
                        PolicyNames: [text(parameters.RoleName).replace(/-role$/u, '-policy')],
                    },
                },
            }
        case 'iam ListAttachedRolePolicies':
            return {
                ListAttachedRolePoliciesResponse: {
                    ListAttachedRolePoliciesResult: {
                        AttachedPolicies:
                            parameters.RoleName === 'w1-attached-role'
                                ? [{ PolicyName: 'AdministratorAccess' }]
                                : [],
                    },
                },
            }
        case 'logs DescribeLogGroups':
            return {
                logGroups: logGroups
                    .filter(name => name.startsWith(text(parameters.logGroupNamePrefix)))
                    .map(name => ({ logGroupName: name })),
            }
        default:
            if (service === 'lambda' && path.startsWith('/2017-03-31/tags/')) {
                return { Tags: functions[decodeURIComponent(path).split(':').at(-1) ?? ''] }
            }
            return {}
    }
}

function isRead({ method, service, action }: AwsCall) {
    if (service === 'lambda' || service === 'apigateway') {
        return method === 'GET'
    }
    return /^(?:List|Get|Describe)/u.test(action ?? '')
}

function summary({ method, service, path, action, parameters }: AwsCall) {
    const { Action: _action, Version: _version, ...rest } = parameters
    const details = Object.keys(rest).length === 0 ? '' : ` ${JSON.stringify(rest)}`
    return `${service} ${action ?? `${method} ${path}`}${details}`
}

function logging() {
    const lines: string[] = []
    return {
        lines,
        context: {
            ...context,
            log: {
                ...context.log,
                trace: (message: string) => {
                    lines.push(message)
                },
            },
        },
    }
}

describe('destroy', () => {
    const directory = join(tmpdir(), 'riddance', 'deploy-test-destroy')
    const glueFile = join(directory, 'glue.w1.json')
    const glueFileWithoutAccount = join(directory, 'glue.without-account.json')
    const glueFileOfAnotherAccount = join(directory, 'glue.w2.json')
    const glueFileWithoutSlots = join(directory, 'glue.production.json')

    before(async () => {
        await mkdir(directory, { recursive: true })
        await writeFile(
            glueFile,
            JSON.stringify({ aws: { accountId: '123456789012', slots: ['w1'] } }),
        )
        await writeFile(glueFileWithoutAccount, JSON.stringify({ aws: { slots: ['w1'] } }))
        await writeFile(
            glueFileOfAnotherAccount,
            JSON.stringify({ aws: { accountId: '123456789012', slots: ['w2'] } }),
        )
        await writeFile(
            glueFileWithoutSlots,
            JSON.stringify({ aws: { accountId: '123456789012' } }),
        )
    })

    it('refuses every stage that is not literally w1 to w9, before any request', async () => {
        const aws = stubAws(answer)
        try {
            for (const stage of [
                'dev',
                'staging',
                'production',
                'w10',
                'w1x',
                'w0',
                'W1',
                'w',
                'w1-',
                ' w1',
                'xw1',
                '',
            ]) {
                await assert.rejects(destroy(context, stage, { dryRun: true, glueFile }), {
                    message: `destroy only removes the slots w1 to w9, not ${JSON.stringify(stage)}; any other stage is removed by hand.`,
                })
                await assert.rejects(executeDestroy(context, stage, []), {
                    message: /^destroy only removes the slots w1 to w9/u,
                })
                assert.throws(() => parseArguments(['destroy', stage]), {
                    message: /^destroy only removes the slots w1 to w9/u,
                })
            }
            assert.deepStrictEqual(aws.calls, [])
        } finally {
            aws.restore()
        }
    })

    it('refuses a command line that is not a destroy of one slot', () => {
        assert.throws(() => parseArguments(['destroy']), {
            message: /^destroy only removes the slots w1 to w9, not ""/u,
        })
        for (const args of [
            ['destroy', 'w1'],
            ['destroy', 'w1', '--dry-run'],
            ['destroy', 'w1', '--service', 'crew'],
        ]) {
            assert.throws(() => parseArguments(args), {
                message:
                    /^destroy needs --glue <file>, the glue file that lists w1 in aws\.slots; it guesses none\./u,
            })
        }
        assert.throws(() => parseArguments(['destroy', 'w1', '--glue']), { message: /--glue/u })
        assert.throws(() => parseArguments(['destroy', 'w1', 'w2']), {
            message: /^Unexpected argument w2\./u,
        })
        assert.throws(() => parseArguments(['destroy', 'w1', '--service']), {
            message: /--service/u,
        })
        assert.throws(() => parseArguments(['destroy', 'w1', '--stage-dir', '/builds']), {
            message: /^--stage-dir belongs to a deploy\./u,
        })
        for (const service of ['', '*', '-', 'crew/x', 'crew role', 'crew.v2']) {
            assert.throws(() => parseArguments(['destroy', 'w1', `--service=${service}`]), {
                message: /^--service must name a service/u,
            })
        }
        assert.throws(() => parseArguments(['.', 'dev', '--glue', 'glue.dev.json']), {
            message: /^--glue belongs to destroy; a deploy names its glue file last\./u,
        })
        assert.throws(() => parseArguments(['w1', '--dry-run']), {
            message: /^--service and --dry-run belong to destroy\./u,
        })
        assert.throws(() => parseArguments(['.', 'dev', '--service', 'crew']), {
            message: /^--service and --dry-run belong to destroy\./u,
        })
    })

    it('reads the destroy command line', () => {
        assert.deepStrictEqual(parseArguments(['destroy', 'w1', '--glue=glue.w1.json']), {
            command: 'destroy',
            stage: 'w1',
            glueFile: 'glue.w1.json',
            service: undefined,
            dryRun: false,
        })
        assert.deepStrictEqual(
            parseArguments([
                'destroy',
                'w9',
                '--glue',
                '../glue/glue.w9.json',
                '--service',
                'crew',
                '--dry-run',
            ]),
            {
                command: 'destroy',
                stage: 'w9',
                glueFile: '../glue/glue.w9.json',
                service: 'crew',
                dryRun: true,
            },
        )
    })

    it('refuses a service name that could widen the name prefix', async () => {
        const aws = stubAws(answer)
        try {
            await assert.rejects(destroy(context, 'w1', { service: '', dryRun: true, glueFile }), {
                message: '--service must name a service, not "".',
            })
            await assert.rejects(destroy(context, 'w1', { service: '*', dryRun: true, glueFile }), {
                message: '--service must name a service, not "*".',
            })
            assert.deepStrictEqual(aws.calls.filter(call => !isRead(call)).map(summary), [])
        } finally {
            aws.restore()
        }
    })

    it('refuses a list that holds anything outside the stage, deleting nothing of it', async () => {
        const aws = stubAws(answer)
        try {
            await assert.rejects(
                executeDestroy(context, 'w1', [
                    { kind: 'function', name: 'w1-crew-get' },
                    { kind: 'function', name: 'w10-crew-get' },
                ]),
                {
                    message:
                        'Refusing to delete function w10-crew-get: its name does not start with w1-. Nothing was deleted.',
                },
            )
            await assert.rejects(
                executeDestroy(context, 'w1', [
                    { kind: 'log group', name: '/aws/lambda/dev-crew-get' },
                ]),
                { message: /^Refusing to delete log group \/aws\/lambda\/dev-crew-get/u },
            )
            await assert.rejects(
                executeDestroy(context, 'w1', [
                    {
                        kind: 'topic',
                        name: 'dev-rental-created',
                        arn: 'arn:aws:sns:eu-north-1:123456789012:w1-looks-right',
                    },
                ]),
                {
                    message:
                        /^Refusing to delete topic arn:aws:sns:eu-north-1:123456789012:w1-looks-right/u,
                },
            )
            assert.deepStrictEqual(aws.calls, [])
        } finally {
            aws.restore()
        }
    })

    it('refuses a list whose identifiers are not those of the named thing', async () => {
        const aws = stubAws(answer)
        const devTopic = 'arn:aws:sns:eu-north-1:123456789012:dev-rental-created'
        try {
            await assert.rejects(
                executeDestroy(context, 'w1', [
                    { kind: 'topic', name: 'w1-rental-created', arn: devTopic },
                ]),
                {
                    message: `Refusing to delete topic ${devTopic}: its ARN is not that of a topic named w1-rental-created. Nothing was deleted.`,
                },
            )
            await assert.rejects(
                executeDestroy(context, 'w1', [
                    {
                        kind: 'subscription',
                        name: 'w1-rental-created',
                        arn: `${devTopic}:sub-crew`,
                        endpoint: 'arn:aws:lambda:eu-north-1:123456789012:function:w1-crew-get',
                    },
                ]),
                { message: /its ARN is not that of a subscription to w1-rental-created/u },
            )
            await assert.rejects(
                executeDestroy(context, 'w1', [{ kind: 'api', name: 'w1-crew', id: 'a1/../a5' }]),
                { message: /its id is not an API id/u },
            )
            await assert.rejects(
                executeDestroy(context, 'w1', [
                    { kind: 'function', name: 'w1-crew/../dev-crew-get' },
                ]),
                { message: /its name is not one a deploy gives/u },
            )
            await assert.rejects(
                executeDestroy(context, 'w1', [
                    { kind: 'log group', name: '/aws/lambda/w1-crew-get?x' },
                ]),
                { message: /its name is not one a deploy gives/u },
            )
            assert.deepStrictEqual(aws.calls, [])
        } finally {
            aws.restore()
        }
    })

    it('names a glue file that is missing or no JSON in one line, before any request', async () => {
        const missing = join(directory, 'glue.missing.json')
        const broken = join(directory, 'glue.broken.json')
        await writeFile(broken, '{ "aws": ')
        const aws = stubAws(answer)
        try {
            for (const file of [missing, broken]) {
                await assert.rejects(
                    destroy(context, 'w1', { dryRun: true, glueFile: file }),
                    (e: unknown) =>
                        e instanceof GlueFileError &&
                        e.message.startsWith(`Cannot read glue file ${file}: `) &&
                        !e.message.includes('\n'),
                )
            }
            await assert.rejects(destroy(context, 'w1', { dryRun: true, glueFile: missing }), {
                message: /: ENOENT/u,
            })
            assert.deepStrictEqual(aws.calls, [])
        } finally {
            aws.restore()
        }
    })

    it('refuses a glue that does not list the slot, a dry run too, before any request', async () => {
        const aws = stubAws(answer)
        try {
            for (const dryRun of [true, false]) {
                await assert.rejects(
                    destroy(context, 'w1', { dryRun, glueFile: glueFileWithoutSlots }),
                    {
                        message: `Refusing to destroy w1: ${glueFileWithoutSlots} does not list w1 in aws.slots (it lists none). A slot is deployed and destroyed only with the glue file of the account that holds it: "aws": { "slots": ["w1"] } at the top level. Nothing was changed.`,
                    },
                )
                await assert.rejects(
                    destroy(context, 'w1', { dryRun, glueFile: glueFileOfAnotherAccount }),
                    {
                        message: `Refusing to destroy w1: ${glueFileOfAnotherAccount} does not list w1 in aws.slots (it lists w2). A slot is deployed and destroyed only with the glue file of the account that holds it: "aws": { "slots": ["w1"] } at the top level. Nothing was changed.`,
                    },
                )
            }
            assert.deepStrictEqual(aws.calls, [])
        } finally {
            aws.restore()
        }
    })

    it('refuses a glue that declares another region, a dry run too, before any request', async () => {
        const file = join(directory, 'glue.other-region.json')
        await writeFile(
            file,
            JSON.stringify({
                aws: {
                    accountId: '123456789012',
                    slots: ['w1'],
                    stage: 'dev',
                    region: 'eu-central-1',
                },
            }),
        )
        const aws = stubAws(answer)
        try {
            for (const dryRun of [true, false]) {
                await assert.rejects(destroy(context, 'w1', { dryRun, glueFile: file }), {
                    message: `Refusing to destroy w1: ${file} declares region eu-central-1 in aws.region, but the requests would go to eu-north-1: the region is AWS_REGION, else AWS_DEFAULT_REGION, else the profile's. Nothing was changed.`,
                })
            }
            assert.deepStrictEqual(aws.calls, [])
        } finally {
            aws.restore()
        }
    })

    it('refuses a glue that declares no account, a dry run too, before any request', async () => {
        const aws = stubAws(answer)
        try {
            for (const dryRun of [true, false]) {
                await assert.rejects(
                    destroy(context, 'w1', {
                        dryRun,
                        glueFile: glueFileWithoutAccount,
                        credentials: 'profile w1',
                    }),
                    {
                        message: `Refusing to destroy w1: ${glueFileWithoutAccount} declares no AWS account. Give it "aws": { "accountId": "<the stage's twelve-digit account id>" } at the top level.`,
                    },
                )
            }
            assert.deepStrictEqual(aws.calls, [])
        } finally {
            aws.restore()
        }
    })

    it('refuses credentials of another account than the glue declares, having asked only who the caller is', async () => {
        const aws = stubAws(call =>
            call.action === 'GetCallerIdentity'
                ? {
                      GetCallerIdentityResponse: {
                          GetCallerIdentityResult: {
                              Account: '999999999999',
                              Arn: 'arn:aws:sts::999999999999:assumed-role/w1',
                          },
                      },
                  }
                : answer(call),
        )
        try {
            await assert.rejects(
                destroy(context, 'w1', { dryRun: false, glueFile, credentials: 'profile w1' }),
                {
                    message: `Refusing to destroy w1: ${glueFile} declares AWS account 123456789012, but profile w1 reaches account 999999999999 as arn:aws:sts::999999999999:assumed-role/w1. Nothing was changed.`,
                },
            )
            assert.deepStrictEqual(aws.calls.map(summary), ['sts GetCallerIdentity'])
        } finally {
            aws.restore()
        }
    })

    it('prints the list and stops on a dry run, having only read', async () => {
        const aws = stubAws(answer)
        const { lines, context: logged } = logging()
        try {
            const plan = await destroy(logged, 'w1', { dryRun: true, glueFile })

            assert.deepStrictEqual(lines.slice(-2), [
                '17 to delete, 12 skipped',
                'dry run: nothing deleted',
            ])
            assert.strictEqual(plan.deletions.length, 17)
            assert.deepStrictEqual(aws.calls.filter(call => !isRead(call)).map(summary), [])
            assert.deepStrictEqual(
                aws.calls.filter(call => call.service === 'dynamodb'),
                [],
            )
        } finally {
            aws.restore()
        }
    })

    it('deletes exactly what it printed, skips and reports what is not tagged for the stage, and keeps the tables and layers', async () => {
        const aws = stubAws(answer)
        const { lines, context: logged } = logging()
        try {
            await destroy(logged, 'w1', { dryRun: false, glueFile })

            assert.deepStrictEqual(
                lines.filter(line => line.startsWith('skip ')),
                [
                    'skip rule w1-by-hand: no environment tag',
                    'skip subscription of someone@example.com to w1-rental-created: it is PendingConfirmation and has no ARN to delete it by',
                    'skip api w1-by-hand (a3): no environment tag',
                    'skip api w1-borrowed (a4): tagged environment=dev',
                    'skip function w1-crew-borrowed: tagged environment=dev',
                    'skip function w1-by-hand: no environment tag',
                    'skip topic arn:aws:sns:eu-north-1:123456789012:w1-by-hand: no environment tag',
                    'skip role w1-attached-role: managed policies were attached by hand (AdministratorAccess)',
                    'skip role w1-by-hand-role: no environment tag',
                    'skip role w1-admin: not named as a deploy names a role',
                    'skip log group /aws/lambda/w1-crew-borrowed: its function is skipped',
                    'skip log group /aws/lambda/w1-by-hand: its function is skipped',
                ],
            )
            assert.deepStrictEqual(
                lines.filter(line => line.startsWith('delete ')),
                [
                    'delete targets w1-crew-sweep of rule w1-crew-sweep',
                    'delete rule w1-crew-sweep',
                    'delete subscription arn:aws:sns:eu-north-1:123456789012:w1-rental-created:sub-crew of arn:aws:lambda:eu-north-1:123456789012:function:w1-crew-get',
                    'delete subscription arn:aws:sns:eu-north-1:123456789012:w1-rental-created:sub-crew-v2 of arn:aws:lambda:eu-north-1:123456789012:function:w1-crew-v2-get',
                    'delete api w1-crew (a1)',
                    'delete api w1-crew-v2 (a2)',
                    'delete function w1-crew-get',
                    'delete function w1-crew-sweep',
                    'delete function w1-crew-v2-get',
                    'delete topic arn:aws:sns:eu-north-1:123456789012:w1-rental-created',
                    'delete policy w1-crew-policy of role w1-crew-role',
                    'delete role w1-crew-role',
                    'delete policy w1-crew-v2-policy of role w1-crew-v2-role',
                    'delete role w1-crew-v2-role',
                    'delete log group /aws/lambda/w1-crew-get',
                    'delete log group /aws/lambda/w1-crew-retired',
                    'delete log group /aws/lambda/w1-crew-v2-get',
                ],
            )
            const writes = aws.calls.filter(call => !isRead(call))
            assert.deepStrictEqual(writes.map(summary), [
                'events RemoveTargets {"Rule":"w1-crew-sweep","Ids":["w1-crew-sweep"]}',
                'events DeleteRule {"Name":"w1-crew-sweep"}',
                'sns Unsubscribe {"SubscriptionArn":"arn:aws:sns:eu-north-1:123456789012:w1-rental-created:sub-crew"}',
                'sns Unsubscribe {"SubscriptionArn":"arn:aws:sns:eu-north-1:123456789012:w1-rental-created:sub-crew-v2"}',
                'apigateway DELETE /v2/apis/a1',
                'apigateway DELETE /v2/apis/a2',
                'lambda DELETE /2015-03-31/functions/w1-crew-get',
                'lambda DELETE /2015-03-31/functions/w1-crew-sweep',
                'lambda DELETE /2015-03-31/functions/w1-crew-v2-get',
                'sns DeleteTopic {"TopicArn":"arn:aws:sns:eu-north-1:123456789012:w1-rental-created"}',
                'iam DeleteRolePolicy {"RoleName":"w1-crew-role","PolicyName":"w1-crew-policy"}',
                'iam DeleteRole {"RoleName":"w1-crew-role"}',
                'iam DeleteRolePolicy {"RoleName":"w1-crew-v2-role","PolicyName":"w1-crew-v2-policy"}',
                'iam DeleteRole {"RoleName":"w1-crew-v2-role"}',
                'logs DeleteLogGroup {"logGroupName":"/aws/lambda/w1-crew-get"}',
                'logs DeleteLogGroup {"logGroupName":"/aws/lambda/w1-crew-retired"}',
                'logs DeleteLogGroup {"logGroupName":"/aws/lambda/w1-crew-v2-get"}',
            ])
            assert.deepStrictEqual(aws.calls.slice(0, 1).map(summary), ['sts GetCallerIdentity'])
            // Nothing is listed again once deleting has begun.
            assert.deepStrictEqual(
                aws.calls.slice(aws.calls.findIndex(call => !isRead(call))).filter(isRead),
                [],
            )
            assert.deepStrictEqual(
                aws.calls.filter(
                    call => call.service === 'dynamodb' || call.path.includes('/layers'),
                ),
                [],
            )
        } finally {
            aws.restore()
        }
    })

    it('stops at the first delete that fails, leaving the rest for the next run', async () => {
        const aws = stubAws(call =>
            call.method === 'DELETE' && call.path.endsWith('/w1-crew-sweep')
                ? new Response('{"message":"Rate exceeded"}', { status: 400 })
                : answer(call),
        )
        try {
            await assert.rejects(destroy(context, 'w1', { dryRun: false, glueFile }), {
                message: 'Error deleting lambda w1-crew-sweep',
            })

            assert.deepStrictEqual(
                aws.calls
                    .filter(call => !isRead(call))
                    .map(summary)
                    .slice(-3),
                [
                    'apigateway DELETE /v2/apis/a2',
                    'lambda DELETE /2015-03-31/functions/w1-crew-get',
                    'lambda DELETE /2015-03-31/functions/w1-crew-sweep',
                ],
            )
        } finally {
            aws.restore()
        }
    })

    it('takes only one service when asked to, and keeps the topics it shares', async () => {
        const aws = stubAws(answer)
        const { lines, context: logged } = logging()
        try {
            await destroy(logged, 'w1', { service: 'crew', dryRun: false, glueFile })

            assert.deepStrictEqual(
                lines.filter(line => line.startsWith('skip ')),
                [
                    'skip function w1-crew-v2-get: tagged service=crew-v2',
                    'skip function w1-crew-borrowed: tagged environment=dev',
                    'skip log group /aws/lambda/w1-crew-v2-get: its function is skipped',
                    'skip log group /aws/lambda/w1-crew-borrowed: its function is skipped',
                ],
            )
            assert.deepStrictEqual(aws.calls.filter(call => !isRead(call)).map(summary), [
                'events RemoveTargets {"Rule":"w1-crew-sweep","Ids":["w1-crew-sweep"]}',
                'events DeleteRule {"Name":"w1-crew-sweep"}',
                'sns Unsubscribe {"SubscriptionArn":"arn:aws:sns:eu-north-1:123456789012:w1-rental-created:sub-crew"}',
                'apigateway DELETE /v2/apis/a1',
                'lambda DELETE /2015-03-31/functions/w1-crew-get',
                'lambda DELETE /2015-03-31/functions/w1-crew-sweep',
                'iam DeleteRolePolicy {"RoleName":"w1-crew-role","PolicyName":"w1-crew-policy"}',
                'iam DeleteRole {"RoleName":"w1-crew-role"}',
                'logs DeleteLogGroup {"logGroupName":"/aws/lambda/w1-crew-get"}',
                'logs DeleteLogGroup {"logGroupName":"/aws/lambda/w1-crew-retired"}',
            ])
        } finally {
            aws.restore()
        }
    })

    it('takes the log groups a failed run of one service left, but none named like a sibling service', async () => {
        const aws = stubAws(call => {
            if (call.service === 'lambda' && call.path === '/2015-03-31/functions/') {
                return {
                    Functions: [
                        {
                            FunctionName: 'w1-crew-v2-get',
                            FunctionArn:
                                'arn:aws:lambda:eu-north-1:123456789012:function:w1-crew-v2-get',
                        },
                    ],
                    // eslint-disable-next-line unicorn/no-null -- as the API ends a listing
                    NextMarker: null,
                }
            }
            if (call.action === 'DescribeLogGroups') {
                return {
                    logGroups: [
                        { logGroupName: '/aws/lambda/w1-crew-get' },
                        { logGroupName: '/aws/lambda/w1-crew-sweep' },
                        { logGroupName: '/aws/lambda/w1-crew-v2-get' },
                        { logGroupName: '/aws/lambda/w1-crew-v2-retired' },
                    ],
                }
            }
            return answer(call)
        })
        const { lines, context: logged } = logging()
        try {
            await destroy(logged, 'w1', { service: 'crew', dryRun: false, glueFile })

            assert.deepStrictEqual(
                lines.filter(line => line.startsWith('skip log group ')),
                [
                    'skip log group /aws/lambda/w1-crew-v2-get: its function is skipped',
                    'skip log group /aws/lambda/w1-crew-v2-retired: its function is gone, and it is named like one of crew-v2',
                ],
            )
            assert.deepStrictEqual(
                aws.calls.filter(call => call.action === 'DeleteLogGroup').map(summary),
                [
                    'logs DeleteLogGroup {"logGroupName":"/aws/lambda/w1-crew-get"}',
                    'logs DeleteLogGroup {"logGroupName":"/aws/lambda/w1-crew-sweep"}',
                ],
            )
        } finally {
            aws.restore()
        }
    })
})
