import assert from 'node:assert/strict'
import { checkPolicyStatements, renderStatement } from '../lib/aws/services/roles.js'

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
                    'aws.policyStatements[1] carries Principal, Sid, which a role policy cannot hold: only Effect, Resource, Action and Condition are rendered.',
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
