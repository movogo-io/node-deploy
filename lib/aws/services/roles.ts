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
    Effect: string
    Resource: string | string[]
    Action: string[]
    Condition?: PolicyCondition
}

type PolicyCondition = { [operator: string]: { [key: string]: string | string[] } }

/**
Refuses a glue statement whose Condition is not operator → key → string or string[], before
anything is deployed, rather than leaving IAM to reject the role policy halfway through.
*/
export function checkPolicyStatements(statements: PolicyStatement[]) {
    for (const [index, { Condition: condition }] of statements.entries()) {
        if (condition === undefined) {
            continue
        }
        const at = `aws.policyStatements[${index}].Condition`
        if (!isObject(condition) || Object.keys(condition).length === 0) {
            throw new Error(
                `${at} must name at least one operator, not ${JSON.stringify(condition)}.`,
            )
        }
        for (const [operator, keys] of Object.entries(condition)) {
            if (!isObject(keys) || Object.keys(keys).length === 0) {
                throw new Error(
                    `${at}.${operator} must name at least one condition key, not ${JSON.stringify(keys)}.`,
                )
            }
            for (const [key, value] of Object.entries(keys)) {
                if (!isConditionValue(value)) {
                    throw new Error(
                        `${at}.${operator}.${key} must be a string or a non-empty array of strings, not ${JSON.stringify(value)}.`,
                    )
                }
            }
        }
    }
    return statements
}

// A statement without a Condition renders exactly as before it could carry one, so no existing
// role's policy changes on the next deploy.
export function renderStatement(
    { Effect, Resource, Action, Condition }: PolicyStatement,
    region: string,
    account: string,
) {
    const substitute = (value: string) =>
        value.replaceAll('$REGION', () => region).replaceAll('$ACCOUNT', () => account)
    const statement = {
        Effect,
        Resource: typeof Resource === 'string' ? substitute(Resource) : Resource.map(substitute),
        Action,
    }
    if (Condition === undefined) {
        return statement
    }
    return {
        ...statement,
        Condition: Object.fromEntries(
            Object.entries(Condition).map(([operator, keys]) => [
                operator,
                Object.fromEntries(
                    Object.entries(keys).map(([key, value]) => [
                        key,
                        typeof value === 'string' ? substitute(value) : value.map(substitute),
                    ]),
                ),
            ]),
        ),
    }
}

function isObject(value: unknown): value is { [key: string]: unknown } {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isConditionValue(value: unknown) {
    if (typeof value === 'string') {
        return true
    }
    return Array.isArray(value) && value.length !== 0 && value.every(v => typeof v === 'string')
}
