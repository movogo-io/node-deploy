import assert from 'node:assert/strict'
import {
    checkPolicyStatements,
    createRoleParameters,
    getRoleTags,
    listAttachedPolicyNames,
    listRoleNames,
    listRolePolicyNames,
    permissionsBoundary,
    renderStatement,
} from '../lib/aws/services/roles.js'
import { context, stubAws } from './lib/aws.js'

describe('policy statements', () => {
    it('refuses a statement without Allow or Deny', () => {
        assert.throws(
            () =>
                checkPolicyStatements([{ Effect: 'allow', Resource: '*', Action: 'sns:Publish' }]),
            { message: 'aws.policyStatements[0].Effect must be "Allow" or "Deny", not "allow".' },
        )
    })

    it('refuses a statement without a Resource', () => {
        assert.throws(() => checkPolicyStatements([{ Effect: 'Allow', Action: 'sns:Publish' }]), {
            message:
                'aws.policyStatements[0].Resource must be a string or a non-empty array of strings, not undefined.',
        })
    })

    it('refuses a statement with an empty Action', () => {
        assert.throws(
            () => checkPolicyStatements([{ Effect: 'Allow', Resource: '*', Action: [] }]),
            {
                message:
                    'aws.policyStatements[0].Action must be a string or a non-empty array of strings, not [].',
            },
        )
    })

    it('refuses a condition without operators', () => {
        assert.throws(
            () =>
                checkPolicyStatements([
                    { Effect: 'Allow', Resource: '*', Action: ['ses:SendEmail'] },
                    {
                        Effect: 'Allow',
                        Resource: '*',
                        Action: ['ses:SendEmail'],
                        Condition: ['StringLike'],
                    },
                ]),
            {
                message:
                    'aws.policyStatements[1].Condition must name at least one operator, not ["StringLike"].',
            },
        )
        assert.throws(
            () =>
                checkPolicyStatements([
                    { Effect: 'Allow', Resource: '*', Action: ['ses:SendEmail'], Condition: {} },
                ]),
            {
                message:
                    'aws.policyStatements[0].Condition must name at least one operator, not {}.',
            },
        )
        assert.throws(
            () =>
                checkPolicyStatements([
                    // eslint-disable-next-line unicorn/no-null -- a glue file is JSON, which can say null
                    { Effect: 'Allow', Resource: '*', Action: ['ses:SendEmail'], Condition: null },
                ]),
            {
                message:
                    'aws.policyStatements[0].Condition must name at least one operator, not null.',
            },
        )
    })

    it('refuses an operator without condition keys', () => {
        assert.throws(
            () =>
                checkPolicyStatements([
                    {
                        Effect: 'Allow',
                        Resource: '*',
                        Action: ['ses:SendEmail'],
                        Condition: { StringLike: '*@sink.dev.movogo.io' },
                    },
                ]),
            {
                message:
                    'aws.policyStatements[0].Condition.StringLike must name at least one condition key, not "*@sink.dev.movogo.io".',
            },
        )
    })

    it('refuses a condition value that is not a scalar or a non-empty array of them', () => {
        assert.throws(
            () =>
                checkPolicyStatements([
                    {
                        Effect: 'Allow',
                        Resource: '*',
                        Action: ['ses:SendEmail'],
                        Condition: { StringLike: { 'ses:Recipients': [] } },
                    },
                ]),
            {
                message:
                    'aws.policyStatements[0].Condition.StringLike.ses:Recipients must be a string, number or boolean, or a non-empty array of them, not [].',
            },
        )
        assert.throws(
            () =>
                checkPolicyStatements([
                    {
                        Effect: 'Allow',
                        Resource: '*',
                        Action: ['ses:SendEmail'],
                        Condition: { StringLike: { 'ses:Recipients': { not: 'a value' } } },
                    },
                ]),
            {
                message:
                    'aws.policyStatements[0].Condition.StringLike.ses:Recipients must be a string, number or boolean, or a non-empty array of them, not {"not":"a value"}.',
            },
        )
    })

    it('refuses a key it would not render, naming the statement', () => {
        assert.throws(
            () =>
                checkPolicyStatements([
                    { Effect: 'Allow', Resource: '*', Action: ['ses:SendEmail'] },
                    {
                        Effect: 'Allow',
                        Principal: { AWS: '*' },
                        Sid: 'publish',
                        Action: 'SNS:Publish',
                        Resource: 'arn:aws:sns:$REGION:$ACCOUNT:*',
                    },
                ]),
            {
                message:
                    'aws.policyStatements[1] carries Principal, Sid, which a role policy cannot hold: only Effect, Resource, Action and Condition are rendered. Versions before 0.5.0 dropped such a key without saying so, so removing it from the glue leaves the role as it is.',
            },
        )
    })

    it('refuses a variable it does not know, in a Resource, an Action or a Condition', () => {
        assert.throws(
            () =>
                checkPolicyStatements([
                    {
                        Effect: 'Allow',
                        Action: 'SNS:Publish',
                        Resource: ['arn:aws:sns:$REGION:$ACCOUNT:$ENV-*', 'arn:aws:sns:$STAGE-*'],
                    },
                ]),
            {
                message:
                    'aws.policyStatements[0] still contains "$" once $REGION, $ACCOUNT and $ENV are substituted: {"Effect":"Allow","Action":"SNS:Publish","Resource":["arn:aws:sns:$REGION:$ACCOUNT:$ENV-*","arn:aws:sns:$STAGE-*"]}.',
            },
        )
        assert.throws(
            () =>
                checkPolicyStatements([
                    { Effect: 'Allow', Action: 'sns:$ENV', Resource: 'arn:aws:sns:*' },
                ]),
            { message: /^aws\.policyStatements\[0\] still contains "\$"/u },
        )
        assert.throws(
            () =>
                checkPolicyStatements([
                    {
                        Effect: 'Allow',
                        Action: 'ses:SendEmail',
                        Resource: '*',
                        Condition: { StringLike: { 'ses:Recipients': '*@$DOMAIN' } },
                    },
                ]),
            { message: /^aws\.policyStatements\[0\] still contains "\$"/u },
        )
    })

    it('renders a statement without a condition exactly as before', () => {
        assert.strictEqual(
            JSON.stringify(
                renderStatement(
                    {
                        Effect: 'Allow',
                        Resource: 'arn:aws:ses:$REGION:$ACCOUNT:identity/dev.movogo.io',
                        Action: ['ses:SendEmail'],
                    },
                    'eu-north-1',
                    '123456789012',
                    'dev',
                ),
            ),
            '{"Effect":"Allow","Resource":"arn:aws:ses:eu-north-1:123456789012:identity/dev.movogo.io","Action":["ses:SendEmail"]}',
        )
    })

    it('renders a Resource list without a condition', () => {
        assert.strictEqual(
            JSON.stringify(
                renderStatement(
                    {
                        Effect: 'Deny',
                        Resource: [
                            'arn:aws:ses:$REGION:$ACCOUNT:identity/dev.movogo.io',
                            'arn:aws:ses:$REGION:$ACCOUNT:configuration-set/dev-mails',
                        ],
                        Action: 'ses:SendEmail',
                    },
                    'eu-north-1',
                    '123456789012',
                    'dev',
                ),
            ),
            '{"Effect":"Deny","Resource":["arn:aws:ses:eu-north-1:123456789012:identity/dev.movogo.io","arn:aws:ses:eu-north-1:123456789012:configuration-set/dev-mails"],"Action":"ses:SendEmail"}',
        )
    })

    it('passes statements with and without a well-formed condition', () => {
        assert.deepStrictEqual(
            checkPolicyStatements([
                { Effect: 'Allow', Resource: '*', Action: ['ses:SendEmail'] },
                {
                    Effect: 'Allow',
                    Resource: '*',
                    Action: ['ses:SendEmail'],
                    Condition: {
                        StringEquals: { 'ses:FromAddress': 'no-reply@dev.movogo.io' },
                        NumericLessThanEquals: { 'aws:MultiFactorAuthAge': 3600 },
                        Bool: { 'aws:SecureTransport': [true] },
                    },
                },
            ]),
            [
                { Effect: 'Allow', Resource: '*', Action: ['ses:SendEmail'] },
                {
                    Effect: 'Allow',
                    Resource: '*',
                    Action: ['ses:SendEmail'],
                    Condition: {
                        StringEquals: { 'ses:FromAddress': 'no-reply@dev.movogo.io' },
                        NumericLessThanEquals: { 'aws:MultiFactorAuthAge': 3600 },
                        Bool: { 'aws:SecureTransport': [true] },
                    },
                },
            ],
        )
    })

    it('renders a condition, substituting region and account in its string values', () => {
        assert.deepStrictEqual(
            renderStatement(
                {
                    Effect: 'Allow',
                    Resource: ['arn:aws:ses:$REGION:$ACCOUNT:identity/dev.movogo.io'],
                    Action: ['ses:SendEmail'],
                    Condition: {
                        'ForAllValues:StringLike': {
                            'ses:Recipients': ['*@sink.dev.movogo.io', '*@simulator.amazonses.com'],
                        },
                        ArnLike: {
                            'aws:SourceArn': 'arn:aws:sns:$REGION:$ACCOUNT:dev-*',
                            'aws:PrincipalArn': [
                                'arn:aws:iam::$ACCOUNT:role/dev-*',
                                'arn:aws:sns:$REGION:$ACCOUNT:staging-*',
                            ],
                        },
                        NumericLessThan: { 'aws:MultiFactorAuthAge': [3600, 7200] },
                        Bool: { 'aws:SecureTransport': true },
                    },
                },
                'eu-north-1',
                '123456789012',
                'dev',
            ),
            {
                Effect: 'Allow',
                Resource: ['arn:aws:ses:eu-north-1:123456789012:identity/dev.movogo.io'],
                Action: ['ses:SendEmail'],
                Condition: {
                    'ForAllValues:StringLike': {
                        'ses:Recipients': ['*@sink.dev.movogo.io', '*@simulator.amazonses.com'],
                    },
                    ArnLike: {
                        'aws:SourceArn': 'arn:aws:sns:eu-north-1:123456789012:dev-*',
                        'aws:PrincipalArn': [
                            'arn:aws:iam::123456789012:role/dev-*',
                            'arn:aws:sns:eu-north-1:123456789012:staging-*',
                        ],
                    },
                    NumericLessThan: { 'aws:MultiFactorAuthAge': [3600, 7200] },
                    Bool: { 'aws:SecureTransport': true },
                },
            },
        )
    })

    it('substitutes the stage in Resource and Condition values, so one glue serves every stage', () => {
        assert.deepStrictEqual(
            checkPolicyStatements([
                {
                    Effect: 'Allow',
                    Action: ['SNS:Publish'],
                    Resource: ['arn:aws:sns:$REGION:$ACCOUNT:$ENV-tender-*', '$ENV.$ENV'],
                    Condition: {
                        ArnLike: {
                            'aws:SourceArn': 'arn:aws:sns:$REGION:$ACCOUNT:$ENV-*',
                            'aws:PrincipalArn': ['arn:aws:iam::$ACCOUNT:role/$ENV-*'],
                        },
                    },
                },
            ]).map(statement => renderStatement(statement, 'eu-north-1', '123456789012', 'w1')),
            [
                {
                    Effect: 'Allow',
                    Action: ['SNS:Publish'],
                    Resource: ['arn:aws:sns:eu-north-1:123456789012:w1-tender-*', 'w1.w1'],
                    Condition: {
                        ArnLike: {
                            'aws:SourceArn': 'arn:aws:sns:eu-north-1:123456789012:w1-*',
                            'aws:PrincipalArn': ['arn:aws:iam::123456789012:role/w1-*'],
                        },
                    },
                },
            ],
        )
    })
})

describe('permissions boundary', () => {
    const boundary = 'arn:aws:iam::123456789012:policy/slot-boundary-w1'

    it('refuses a boundary that is no IAM policy ARN', () => {
        assert.throws(
            () => permissionsBoundary(undefined, { DEPLOY_PERMISSIONS_BOUNDARY: 'slot-w1' }, 'w1'),
            {
                message:
                    'DEPLOY_PERMISSIONS_BOUNDARY must be the ARN of an IAM policy, not "slot-w1".',
            },
        )
        assert.throws(
            () => permissionsBoundary('arn:aws:iam::123456789012:role/slot-runner-w1', {}, 'w1'),
            {
                message:
                    'aws.permissionsBoundary must be the ARN of an IAM policy, not "arn:aws:iam::123456789012:role/slot-runner-w1".',
            },
        )
        assert.throws(() => permissionsBoundary({ arn: boundary }, {}, 'w1'), {
            message: `aws.permissionsBoundary must be the ARN of an IAM policy, not {"arn":"${boundary}"}.`,
        })
    })

    it('refuses a glue that names another boundary than the environment', () => {
        assert.throws(
            () =>
                permissionsBoundary(
                    'arn:aws:iam::123456789012:policy/wide-open',
                    { DEPLOY_PERMISSIONS_BOUNDARY: boundary },
                    'w1',
                ),
            {
                message: `DEPLOY_PERMISSIONS_BOUNDARY is ${boundary} while the glue's aws.permissionsBoundary is arn:aws:iam::123456789012:policy/wide-open; they must agree.`,
            },
        )
    })

    it('is none unless the environment or the glue names one', () => {
        assert.deepStrictEqual(
            [
                permissionsBoundary(undefined, {}, 'dev'),
                permissionsBoundary(undefined, { DEPLOY_PERMISSIONS_BOUNDARY: '' }, 'dev'),
            ],
            [undefined, undefined],
        )
        assert.strictEqual(
            new URLSearchParams(createRoleParameters('dev', 'crew')).has('PermissionsBoundary'),
            false,
        )
    })

    it('comes from the environment, or from the glue with the stage filled in', () => {
        assert.deepStrictEqual(
            [
                permissionsBoundary(undefined, { DEPLOY_PERMISSIONS_BOUNDARY: boundary }, 'w1'),
                permissionsBoundary(
                    'arn:aws:iam::123456789012:policy/slot-boundary-$ENV',
                    {},
                    'w1',
                ),
                permissionsBoundary(
                    'arn:aws:iam::123456789012:policy/slot-boundary-$ENV',
                    { DEPLOY_PERMISSIONS_BOUNDARY: boundary },
                    'w1',
                ),
            ],
            [boundary, boundary, boundary],
        )
    })

    it('is carried by CreateRole', () => {
        assert.deepStrictEqual(
            Object.fromEntries(
                Object.entries(createRoleParameters('w1', 'crew', boundary)).filter(
                    ([key]) => key !== 'AssumeRolePolicyDocument',
                ),
            ),
            {
                Action: 'CreateRole',
                Version: '2010-05-08',
                RoleName: 'w1-crew-role',
                PermissionsBoundary: boundary,
                'Tags.member.1.Key': 'framework',
                'Tags.member.1.Value': 'riddance',
                'Tags.member.2.Key': 'environment',
                'Tags.member.2.Value': 'w1',
                'Tags.member.3.Key': 'service',
                'Tags.member.3.Value': 'crew',
            },
        )
    })
})

describe('role listings', () => {
    it('refuses a list of roles cut short without a marker', async () => {
        const aws = stubAws(() => ({
            ListRolesResponse: {
                ListRolesResult: { Roles: [{ RoleName: 'w1-crew-role' }], IsTruncated: true },
            },
        }))
        try {
            await assert.rejects(listRoleNames(context), {
                message: 'IAM cut the list short without a way to continue when listing roles.',
            })
        } finally {
            aws.restore()
        }
    })

    it('refuses an answer that holds no list', async () => {
        const aws = stubAws(({ action }) => ({
            [`${action}Response`]: { [`${action}Result`]: { IsTruncated: false } },
        }))
        try {
            await assert.rejects(listRoleNames(context), {
                message: 'IAM gave no Roles when listing roles.',
            })
            await assert.rejects(getRoleTags(context, 'w1-crew-role'), {
                message: 'IAM gave no Tags when reading tags of role w1-crew-role.',
            })
        } finally {
            aws.restore()
        }
    })

    it('refuses a role without a name', async () => {
        const aws = stubAws(() => ({
            ListRolesResponse: {
                ListRolesResult: { Roles: [{ Name: 'w1-crew-role' }], IsTruncated: false },
            },
        }))
        try {
            await assert.rejects(listRoleNames(context), {
                message: 'IAM gave a role without RoleName: {"Name":"w1-crew-role"}.',
            })
        } finally {
            aws.restore()
        }
    })

    it('reads a role without tags, policies or managed policies as having none', async () => {
        const aws = stubAws(({ action }) => ({
            [`${action}Response`]: {
                /* eslint-disable unicorn/no-null -- as IAM answers for an empty list */
                [`${action}Result`]: {
                    Tags: null,
                    PolicyNames: null,
                    AttachedPolicies: [],
                    IsTruncated: false,
                },
                /* eslint-enable unicorn/no-null */
            },
        }))
        try {
            assert.deepStrictEqual(await getRoleTags(context, 'w1-crew-role'), {})
            assert.deepStrictEqual(await listRolePolicyNames(context, 'w1-crew-role'), [])
            assert.deepStrictEqual(await listAttachedPolicyNames(context, 'w1-crew-role'), [])
        } finally {
            aws.restore()
        }
    })

    it('follows the marker to the last page of every list', async () => {
        const aws = stubAws(({ action, parameters: { Marker: marker } }) => {
            const last = marker === 'second'
            const item = last ? 'b' : 'a'
            return {
                [`${action}Response`]: {
                    [`${action}Result`]: {
                        Roles: [{ RoleName: item }],
                        Tags: [{ Key: item, Value: item }],
                        PolicyNames: [item],
                        AttachedPolicies: [{ PolicyName: item }],
                        IsTruncated: !last,
                        // eslint-disable-next-line unicorn/no-null -- as IAM ends a listing
                        Marker: last ? null : 'second',
                    },
                },
            }
        })
        try {
            assert.deepStrictEqual(await listRoleNames(context), ['a', 'b'])
            assert.deepStrictEqual(await getRoleTags(context, 'w1-crew-role'), { a: 'a', b: 'b' })
            assert.deepStrictEqual(await listRolePolicyNames(context, 'w1-crew-role'), ['a', 'b'])
            assert.deepStrictEqual(await listAttachedPolicyNames(context, 'w1-crew-role'), [
                'a',
                'b',
            ])
            assert.deepStrictEqual(
                aws.calls.map(call => [call.action, call.parameters.Marker]),
                [
                    ['ListRoles', undefined],
                    ['ListRoles', 'second'],
                    ['ListRoleTags', undefined],
                    ['ListRoleTags', 'second'],
                    ['ListRolePolicies', undefined],
                    ['ListRolePolicies', 'second'],
                    ['ListAttachedRolePolicies', undefined],
                    ['ListAttachedRolePolicies', 'second'],
                ],
            )
        } finally {
            aws.restore()
        }
    })
})
