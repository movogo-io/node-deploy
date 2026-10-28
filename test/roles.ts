import assert from 'node:assert/strict'
import { checkPolicyStatements, renderStatement } from '../lib/aws/services/roles.js'

describe('policy statements', () => {
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

    it('renders a condition, substituting region and account in its values', () => {
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
                        ArnLike: { 'aws:SourceArn': 'arn:aws:sns:$REGION:$ACCOUNT:dev-*' },
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
                    ArnLike: { 'aws:SourceArn': 'arn:aws:sns:eu-north-1:123456789012:dev-*' },
                },
            },
        )
    })

    it('refuses a malformed condition', () => {
        const statement = { Effect: 'Allow', Resource: '*', Action: ['ses:SendEmail'] }
        const refuse = (condition: unknown, message: string) => {
            assert.throws(
                () =>
                    checkPolicyStatements([
                        statement,
                        { ...statement, Condition: condition },
                    ] as Parameters<typeof checkPolicyStatements>[0]),
                { message },
            )
        }
        refuse(
            ['StringLike'],
            'aws.policyStatements[1].Condition must name at least one operator, not ["StringLike"].',
        )
        refuse({}, 'aws.policyStatements[1].Condition must name at least one operator, not {}.')
        refuse(
            { StringLike: '*@sink.dev.movogo.io' },
            'aws.policyStatements[1].Condition.StringLike must name at least one condition key, not "*@sink.dev.movogo.io".',
        )
        refuse(
            { StringLike: { 'ses:Recipients': 5 } },
            'aws.policyStatements[1].Condition.StringLike.ses:Recipients must be a string or a non-empty array of strings, not 5.',
        )
        refuse(
            { StringLike: { 'ses:Recipients': [] } },
            'aws.policyStatements[1].Condition.StringLike.ses:Recipients must be a string or a non-empty array of strings, not [].',
        )
    })

    it('passes statements with and without a well-formed condition', () => {
        const statements = [
            { Effect: 'Allow', Resource: '*', Action: ['ses:SendEmail'] },
            {
                Effect: 'Allow',
                Resource: '*',
                Action: ['ses:SendEmail'],
                Condition: { StringEquals: { 'ses:FromAddress': 'no-reply@dev.movogo.io' } },
            },
        ]
        assert.strictEqual(checkPolicyStatements(statements), statements)
    })
})
