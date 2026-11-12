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
    PermissionsBoundary: { PermissionsBoundaryArn: string } | null
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
    boundary: string | undefined,
) {
    if (!role) {
        return (await createRole(context, prefix, service, boundary)).Arn
    }
    const current = role.PermissionsBoundary?.PermissionsBoundaryArn
    if (boundary && current !== boundary) {
        context.log.warn(
            `role ${role.RoleName} has ${current ? `permissions boundary ${current}` : 'no permissions boundary'}, not ${boundary}: a boundary is only set when the deploy creates the role`,
        )
    }
    return role.Arn
}

/**
The permissions boundary a role created by this deploy gets: DEPLOY_PERMISSIONS_BOUNDARY, else
`aws.permissionsBoundary` of the service in the glue, where `$ENV` stands for the stage. The
environment is where a fenced session's boundary comes from, so a glue that names another one is
refused, not overruled in either direction.
*/
export function permissionsBoundary(
    glue: unknown,
    env: { [key: string]: string | undefined },
    prefix: string,
) {
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty variable is unset
    const fromEnv = env.DEPLOY_PERMISSIONS_BOUNDARY || undefined
    if (fromEnv !== undefined && !policyArnPattern.test(fromEnv)) {
        throw new Error(
            `DEPLOY_PERMISSIONS_BOUNDARY must be the ARN of an IAM policy, not ${JSON.stringify(fromEnv)}.`,
        )
    }
    if (glue === undefined) {
        return fromEnv
    }
    const fromGlue = typeof glue === 'string' ? glue.replaceAll('$ENV', () => prefix) : glue
    if (typeof fromGlue !== 'string' || !policyArnPattern.test(fromGlue)) {
        throw new Error(
            `aws.permissionsBoundary must be the ARN of an IAM policy, not ${JSON.stringify(glue)}.`,
        )
    }
    if (fromEnv !== undefined && fromEnv !== fromGlue) {
        throw new Error(
            `DEPLOY_PERMISSIONS_BOUNDARY is ${fromEnv} while the glue's aws.permissionsBoundary is ${fromGlue}; they must agree.`,
        )
    }
    return fromGlue
}

const policyArnPattern = /^arn:aws[a-z-]*:iam::(?:\d{12}|aws):policy\/[\w+=,.@/-]+$/u

export function createRoleParameters(prefix: string, service: string, boundary?: string) {
    return {
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
        ...(boundary && { PermissionsBoundary: boundary }),
        'Tags.member.1.Key': 'framework',
        'Tags.member.1.Value': 'riddance',
        'Tags.member.2.Key': 'environment',
        'Tags.member.2.Value': prefix,
        'Tags.member.3.Key': 'service',
        'Tags.member.3.Value': service,
    }
}

async function createRole(
    context: Context,
    prefix: string,
    service: string,
    boundary: string | undefined,
) {
    context.log.trace(`creating role${boundary ? ` with permissions boundary ${boundary}` : ''}`)
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
            `?${new URLSearchParams(createRoleParameters(prefix, service, boundary)).toString()}`,
        ),
        'Error creating role',
    )
    await setTimeout(10_000)
    return response.CreateRoleResponse.CreateRoleResult.Role
}

export async function listRoleNames(context: Context) {
    const roles = await iamList(context, 'ListRoles', {}, 'Roles', 'listing roles')
    return roles.map(role => textOf(role, 'RoleName', 'a role'))
}

export async function getRoleTags(context: Context, roleName: string) {
    const tags = await iamList(
        context,
        'ListRoleTags',
        { RoleName: roleName },
        'Tags',
        `reading tags of role ${roleName}`,
    )
    return Object.fromEntries(
        tags.map(tag => [textOf(tag, 'Key', 'a tag'), textOf(tag, 'Value', 'a tag')]),
    )
}

export async function listRolePolicyNames(context: Context, roleName: string) {
    const names = await iamList(
        context,
        'ListRolePolicies',
        { RoleName: roleName },
        'PolicyNames',
        `listing policies of role ${roleName}`,
    )
    return names.map(name => {
        if (typeof name !== 'string') {
            throw new TypeError(`IAM named a policy of role ${roleName} ${JSON.stringify(name)}.`)
        }
        return name
    })
}

export async function listAttachedPolicyNames(context: Context, roleName: string) {
    const attached = await iamList(
        context,
        'ListAttachedRolePolicies',
        { RoleName: roleName },
        'AttachedPolicies',
        `listing managed policies of role ${roleName}`,
    )
    return attached.map(policy => textOf(policy, 'PolicyName', 'a managed policy'))
}

/**
Every page of an IAM listing, or an error: a listing cut short would make a plan that looks
complete, so an answer of another shape, or one truncated without a marker, is refused.
*/
async function iamList(
    context: Context,
    action: string,
    parameters: { [key: string]: string },
    list: string,
    doing: string,
) {
    const items: unknown[] = []
    for (let marker: string | undefined; ;) {
        const body = await iam<unknown>(
            context,
            { Action: action, ...parameters, ...(marker && { Marker: marker }) },
            doing,
        )
        const page = member(member(body, `${action}Response`), `${action}Result`)
        // IAM answers null for an empty list; a missing one is an answer of another shape.
        const listed = member(page, list) === null ? [] : member(page, list)
        if (!isObject(page) || !isList(listed)) {
            throw new TypeError(`IAM gave no ${list} when ${doing}.`)
        }
        items.push(...listed)
        if (!page.IsTruncated) {
            return items
        }
        if (typeof page.Marker !== 'string' || !page.Marker || page.Marker === marker) {
            throw new Error(`IAM cut the list short without a way to continue when ${doing}.`)
        }
        marker = page.Marker
    }
}

function isList(value: unknown): value is unknown[] {
    return Array.isArray(value)
}

function member(value: unknown, key: string) {
    if (!isObject(value)) {
        return undefined
    }
    return value[key]
}

function textOf(value: unknown, key: string, what: string) {
    const text = member(value, key)
    if (typeof text !== 'string') {
        throw new TypeError(`IAM gave ${what} without ${key}: ${JSON.stringify(value)}.`)
    }
    return text
}

export async function deleteRolePolicy(context: Context, roleName: string, policyName: string) {
    await okResponse(
        iamRequest(context, {
            Action: 'DeleteRolePolicy',
            RoleName: roleName,
            PolicyName: policyName,
        }),
        `Error deleting policy ${policyName} of role ${roleName}.`,
    )
}

export async function deleteRole(context: Context, roleName: string) {
    await okResponse(
        iamRequest(context, { Action: 'DeleteRole', RoleName: roleName }),
        `Error deleting role ${roleName}.`,
    )
}

function iam<T>(context: Context, parameters: { [key: string]: string }, doing: string) {
    return jsonResponse<T>(iamRequest(context, parameters), `Error ${doing}.`)
}

function iamRequest(context: Context, parameters: { [key: string]: string }) {
    return awsRequest(
        context,
        'GET',
        'iam',
        `?${new URLSearchParams({ Version: '2010-05-08', ...parameters }).toString()}`,
    )
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
                        ...additionalStatements.map(as =>
                            renderStatement(as, region, account, prefix),
                        ),
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
    const unrendered = Object.keys(statement).filter(key => !renderedKeys.has(key))
    if (unrendered.length !== 0) {
        throw new Error(
            `${at} carries ${unrendered.join(', ')}, which a role policy cannot hold: only Effect, Resource, Action and Condition are rendered. Versions before 0.5.0 dropped such a key without saying so, so removing it from the glue leaves the role as it is.`,
        )
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
    const checked: PolicyStatement =
        Condition === undefined
            ? { Effect, Resource, Action }
            : { Effect, Resource, Action, Condition: checkCondition(Condition, `${at}.Condition`) }
    if (JSON.stringify(renderStatement(checked, '', '', '')).includes('$')) {
        throw new Error(
            `${at} still contains "$" once $REGION, $ACCOUNT and $ENV are substituted: ${JSON.stringify(statement)}.`,
        )
    }
    return checked
}

const renderedKeys = new Set(['Effect', 'Resource', 'Action', 'Condition'])

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
    environment: string,
) {
    const substitute = (value: string) =>
        value
            .replaceAll('$REGION', () => region)
            .replaceAll('$ACCOUNT', () => account)
            .replaceAll('$ENV', () => environment)
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
