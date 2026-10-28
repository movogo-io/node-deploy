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

    it('renders a legacy statement exactly as 0.4.1 did, dropping its Principal', () => {
        assert.strictEqual(
            JSON.stringify(
                checkPolicyStatements([
                    {
                        Effect: 'Allow',
                        Principal: { AWS: '*' },
                        Action: 'SNS:Publish',
                        Resource: 'arn:aws:sns:$REGION:$ACCOUNT:*',
                    },
                ]).map(statement => renderStatement(statement, 'eu-north-1', '123456789012')),
            ),
            '[{"Effect":"Allow","Resource":"arn:aws:sns:eu-north-1:123456789012:*","Action":"SNS:Publish"}]',
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
})
