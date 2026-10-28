import { jsonResponse, okResponse, throwOnNotOK } from '@riddance/fetch'
import { setTimeout } from 'node:timers/promises'
import { type Context, awsRequest } from '../lite.js'

export type AwsRole = {
    Arn: string
    AssumeRolePolicyDocument: string
    CreateDate: number
    Description: string
    MaxSessionDuration: number
    Path: string
    PermissionsBoundary: null
    RoleId: string
    RoleLastUsed: { LastUsedDate: number; Region: string }
    RoleName: string
    Tags: null
}

export async function getRole(
    context: Context,
    prefix: string,
    service: string,
): Promise<AwsRole | undefined> {
    const response = await awsRequest(
        context,
        'GET',
        'iam',
        `?Action=GetRole&RoleName=${prefix}-${service}-role&Version=2010-05-08`,
    )

    if (response.status === 404) {
        return undefined
    }
    await throwOnNotOK(response, 'Error getting role')
    const body = (await response.json()) as {
        GetRoleResponse: {
            GetRoleResult: {
                Role: AwsRole
            }
        }
    }
    return body.GetRoleResponse.GetRoleResult.Role
}

export async function syncRole(
    context: Context,
    prefix: string,
    service: string,
    role: AwsRole | undefined,
) {
    role ??= await createRole(context, prefix, service)
    return role.Arn
}

async function createRole(context: Context, prefix: string, service: string) {
    context.log.trace('creating role')
    const response = await jsonResponse<{
        CreateRoleResponse: {
            CreateRoleResult: {
                Role: AwsRole
            }
        }
    }>(
        awsRequest(
            context,
            'GET',
            'iam',
            `?${new URLSearchParams({
                Action: 'CreateRole',
                Version: '2010-05-08',
                RoleName: `${prefix}-${service}-role`,
                AssumeRolePolicyDocument: JSON.stringify({
                    Version: '2012-10-17',
                    Statement: [
                        {
                            Effect: 'Allow',
                            Principal: {
                                Service: 'lambda.amazonaws.com',
                            },
                            Action: 'sts:AssumeRole',
                        },
                    ],
                }),
                'Tags.member.1.Key': 'framework',
                'Tags.member.1.Value': 'riddance',
                'Tags.member.2.Key': 'environment',
                'Tags.member.2.Value': prefix,
                'Tags.member.3.Key': 'service',
                'Tags.member.3.Value': service,
            }).toString()}`,
        ),
        'Error creating role',
    )
    await setTimeout(10_000)
    return response.CreateRoleResponse.CreateRoleResult.Role
}

export async function assignPolicy(
    context: Context,
    prefix: string,
    service: string,
    region: string,
    account: string,
    publishTopics: string[],
    additionalStatements: PolicyStatement[],
) {
    context.log.trace('assigning policy')
    await okResponse(
        awsRequest(
            context,
            'GET',
            'iam',
            `?${new URLSearchParams({
                Action: 'PutRolePolicy',
                Version: '2010-05-08',
                RoleName: `${prefix}-${service}-role`,
                PolicyName: `${prefix}-${service}-policy`,
                PolicyDocument: JSON.stringify({
                    Version: '2012-10-17',
                    Statement: [
                        {
                            Effect: 'Allow',
                            Resource: `arn:aws:logs:${region}:${account}:*`,
                            Action: 'logs:CreateLogGroup',
                        },
                        {
                            Effect: 'Allow',
                            Resource: `arn:aws:logs:${region}:${account}:log-group:/aws/lambda/${prefix}-${service}-*`,
                            Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
                        },
                        {
                            Effect: 'Allow',
                            Resource: `arn:aws:dynamodb:${region}:${account}:table/${prefix}.${service}.*`,
                            Action: [
                                // @movogo-io/dynamodb-docs creates a table on first write, waits
                                // for it to be active, then enables TTL and, when asked, backups.
                                'dynamodb:CreateTable',
                                'dynamodb:DescribeTable',
                                'dynamodb:UpdateTimeToLive',
                                'dynamodb:UpdateContinuousBackups',
                                'dynamodb:BatchGetItem',
                                'dynamodb:ConditionCheckItem',
                                'dynamodb:PutItem',
                                'dynamodb:DeleteItem',
                                'dynamodb:GetItem',
                                'dynamodb:Scan',
                                'dynamodb:Query',
                                'dynamodb:UpdateItem',
                                'dynamodb:UpdateTable',
                                'dynamodb:GetRecords',
                                'dax:GetItem',
                                'dax:PutItem',
                                'dax:ConditionCheckItem',
                                'dax:BatchGetItem',
                                'dax:BatchWriteItem',
                                'dax:DeleteItem',
                                'dax:Query',
                                'dax:UpdateItem',
                                'dax:Scan',
                            ],
                        },
                        ...publishTopics.map(topic => ({
                            Effect: 'Allow',
                            Action: ['sns:Publish'],
                            Resource: `arn:aws:sns:${region}:${account}:${prefix}-${topic}-*`,
                        })),
                        ...additionalStatements.map(as => renderStatement(as, region, account)),
                    ],
                }),
            }).toString()}`,
        ),
        'Error assigning policy',
    )
}

export type PolicyStatement = {
    Effect: 'Allow' | 'Deny'
    Resource: string | string[]
    Action: string | string[]
    Condition?: PolicyCondition
}

type PolicyCondition = { [operator: string]: { [key: string]: ConditionValue } }

type ConditionValue = string | number | boolean | (string | number | boolean)[]

export function checkPolicyStatements(statements: unknown): PolicyStatement[] {
    if (!Array.isArray(statements)) {
        throw new TypeError(
            `aws.policyStatements must be a list, not ${JSON.stringify(statements)}.`,
        )
    }
    return statements.map((statement: unknown, index) =>
        checkStatement(statement, `aws.policyStatements[${index}]`),
    )
}

function checkStatement(statement: unknown, at: string): PolicyStatement {
    if (!isObject(statement)) {
        throw new Error(`${at} must be an object, not ${JSON.stringify(statement)}.`)
    }
    const { Effect, Resource, Action, Condition } = statement
    if (Effect !== 'Allow' && Effect !== 'Deny') {
        throw new Error(`${at}.Effect must be "Allow" or "Deny", not ${JSON.stringify(Effect)}.`)
    }
    if (!isStrings(Resource)) {
        throw new Error(
            `${at}.Resource must be a string or a non-empty array of strings, not ${JSON.stringify(Resource)}.`,
        )
    }
    if (!isStrings(Action)) {
        throw new Error(
            `${at}.Action must be a string or a non-empty array of strings, not ${JSON.stringify(Action)}.`,
        )
    }
    if (Condition === undefined) {
        return { Effect, Resource, Action }
    }
    return { Effect, Resource, Action, Condition: checkCondition(Condition, `${at}.Condition`) }
}

function checkCondition(condition: unknown, at: string): PolicyCondition {
    if (!isObject(condition) || Object.keys(condition).length === 0) {
        throw new Error(`${at} must name at least one operator, not ${JSON.stringify(condition)}.`)
    }
    return Object.fromEntries(
        Object.entries(condition).map(([operator, keys]) => {
            if (!isObject(keys) || Object.keys(keys).length === 0) {
                throw new Error(
                    `${at}.${operator} must name at least one condition key, not ${JSON.stringify(keys)}.`,
                )
            }
            return [
                operator,
                Object.fromEntries(
                    Object.entries(keys).map(([key, value]) => {
                        if (!isConditionValue(value)) {
                            throw new Error(
                                `${at}.${operator}.${key} must be a string, number or boolean, or a non-empty array of them, not ${JSON.stringify(value)}.`,
                            )
                        }
                        return [key, value]
                    }),
                ),
            ]
        }),
    )
}

export function renderStatement(
    { Effect, Resource, Action, Condition }: PolicyStatement,
    region: string,
    account: string,
) {
    const substitute = (value: string) =>
        value.replaceAll('$REGION', () => region).replaceAll('$ACCOUNT', () => account)
    const substituteValue = (value: string | number | boolean) =>
        typeof value === 'string' ? substitute(value) : value
    return {
        Effect,
        Resource: typeof Resource === 'string' ? substitute(Resource) : Resource.map(substitute),
        Action,
        Condition:
            Condition &&
            Object.fromEntries(
                Object.entries(Condition).map(([operator, keys]) => [
                    operator,
                    Object.fromEntries(
                        Object.entries(keys).map(([key, value]) => [
                            key,
                            Array.isArray(value)
                                ? value.map(substituteValue)
                                : substituteValue(value),
                        ]),
                    ),
                ]),
            ),
    }
}

function isObject(value: unknown): value is { [key: string]: unknown } {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStrings(value: unknown): value is string | string[] {
    if (typeof value === 'string') {
        return true
    }
    return Array.isArray(value) && value.length !== 0 && value.every(v => typeof v === 'string')
}

function isConditionValue(value: unknown): value is ConditionValue {
    if (isScalar(value)) {
        return true
    }
    return Array.isArray(value) && value.length !== 0 && value.every(isScalar)
}

function isScalar(value: unknown) {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}
