import { isDeepStrictEqual } from 'node:util'
import { type SecretArguments } from '../arguments.js'
import { AwsError, type Context, awsJson } from '../aws/lite.js'
import { getRole } from '../aws/services/roles.js'
import { type Command } from './references.js'
import { Refusal } from './refusal.js'

type Statement = {
    Sid: string
    Effect: string
    Principal: { AWS: string | string[] }
    Action: string | string[]
    Resource: string
    Condition?: { [operator: string]: { [key: string]: string } }
}

type Stored = { Sid: string; [key: string]: unknown }

type Key = { KeyId: string; Arn: string; Description: string }

/**
The stage's key. All use of it is granted in its policy, which has no statement for the plain
account principal: no IAM policy can add use or management of the key. Lock-out is covered by
two administrators and a statement confined to the account's root user.
*/
export async function init(command: Command, args: SecretArguments) {
    const { stage, caller } = command
    if (args.admins.length < 2) {
        throw new Refusal('init needs at least two --admin: one alone could lock the key')
    }
    if (args.operators.length === 0 || args.deployers.length === 0) {
        throw new Refusal('init needs at least one --operator and one --deployer')
    }
    for (const [flag, arns] of Object.entries({
        '--admin': args.admins,
        '--operator': args.operators,
        '--deployer': args.deployers,
        '--slot-reader': args.slotReaders,
    })) {
        const odd = arns.find(arn => !/^arn:aws:iam::\d{12}:(?:role|user)\/.+$/u.test(arn))
        if (odd !== undefined) {
            throw new Refusal(
                `${flag} takes the ARN of an IAM role or user, not ${JSON.stringify(odd)}`,
            )
        }
        // The key's policy is the only grant there is: a principal of another account in it
        // would hold the stage's credentials from outside.
        const foreign = arns.find(arn => arn.split(':', 5)[4] !== caller.account)
        if (foreign !== undefined) {
            throw new Refusal(
                `${flag} ${foreign} is of another account than ${caller.account}, the stage's`,
            )
        }
    }
    const both = args.deployers.find(arn => args.slotReaders.includes(arn))
    if (both !== undefined) {
        throw new Refusal(`${both} is given as --deployer and as --slot-reader; name it once`)
    }
    if (!isAmong(caller.arn, args.admins)) {
        throw new Refusal(
            `the caller ${caller.arn} is not one of the --admin principals: init is run by an administrator of the key`,
        )
    }
    const parameters = {
        StringLike: {
            'kms:EncryptionContext:PARAMETER_ARN': `arn:aws:ssm:${regionOf(command.context)}:${caller.account}:parameter/${stage}/*`,
        },
    }
    await ensureKey(command, args, {
        alias: `alias/${stage}-secrets`,
        description: `${stage} secrets`,
        described: false,
        statements: [
            rootUserOnly(caller.account),
            {
                Sid: 'Admins',
                Effect: 'Allow',
                Principal: { AWS: args.admins },
                Action: adminActions,
                Resource: '*',
            },
            {
                Sid: 'Operators',
                Effect: 'Allow',
                Principal: { AWS: args.operators },
                Action: ['kms:Encrypt', 'kms:Decrypt'],
                Resource: '*',
                Condition: parameters,
            },
            {
                Sid: 'Deployers',
                Effect: 'Allow',
                Principal: { AWS: args.deployers },
                Action: 'kms:Decrypt',
                Resource: '*',
                Condition: parameters,
            },
            // A statement cannot have an empty principal list, so without a reader it is absent.
            ...(args.slotReaders.length === 0
                ? []
                : [
                      {
                          Sid: 'SlotReaders',
                          Effect: 'Allow',
                          Principal: { AWS: args.slotReaders },
                          Action: 'kms:Decrypt',
                          Resource: '*',
                          Condition: parameters,
                      },
                  ]),
        ],
    })
    return 0
}

/**
A key one service's functions alone may use, under an encryption context that names the service
and a record. Its administrators are the stage key's, copied from that key's stored policy.
*/
export async function initKey(command: Command, args: SecretArguments) {
    const { stage, caller, context, io } = command
    const { service, key: name } = args
    if (service === undefined || name === undefined) {
        throw new Refusal('init-key needs <service> and <name>')
    }
    const stageAlias = `alias/${stage}-secrets`
    const stageKey = await describeKey(context, stageAlias)
    if (!stageKey) {
        throw new Refusal(
            `${stageAlias} does not exist; run deploy secret init ${stage} first, as its administrator`,
        )
    }
    const stored = await storedStatements(context, stageKey.KeyId, stageAlias)
    const root = stored.find(statement => statement.Sid === 'RootUserOnly')
    const admins = stored.find(statement => statement.Sid === 'Admins')
    if (!root || !admins) {
        throw new Refusal(
            `the policy of ${stageAlias} has no RootUserOnly and Admins statements to copy; rerun deploy secret init ${stage}`,
        )
    }
    if (!isAmong(caller.arn, principalsOf(admins))) {
        throw new Refusal(
            `the caller ${caller.arn} is not an administrator of ${stageAlias}: init-key is run by one`,
        )
    }
    // KMS refuses a policy that names a role that does not exist.
    const role = await getRole(context, stage, service)
    if (!role) {
        throw new Refusal(
            `${stage}-${service}-role does not exist: deploy ${service} to ${stage} once, then run init-key, then deploy it with the key's ARN`,
        )
    }
    const key = await ensureKey(command, args, {
        alias: `alias/${stage}-${service}-${name}`,
        description: `${stage} ${service} ${name}`,
        described: true,
        statements: [
            root,
            admins,
            {
                Sid: 'ServiceUse',
                Effect: 'Allow',
                Principal: { AWS: role.Arn },
                Action: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey'],
                Resource: '*',
                Condition: {
                    StringEquals: { 'kms:EncryptionContext:service': service },
                    'ForAnyValue:StringEquals': { 'kms:EncryptionContextKeys': 'record' },
                },
            },
        ],
    })
    io.out(key.Arn)
    io.out(
        `Only ${service} means: no other function's role, and no IAM policy. An administrator can rewrite the policy, and whoever deploys the service can ship code that uses the key.`,
    )
    return 0
}

const adminActions = [
    'kms:DescribeKey',
    'kms:GetKeyPolicy',
    'kms:PutKeyPolicy',
    'kms:CreateAlias',
    'kms:UpdateAlias',
    'kms:DeleteAlias',
    'kms:EnableKey',
    'kms:DisableKey',
    'kms:ScheduleKeyDeletion',
    'kms:CancelKeyDeletion',
    'kms:EnableKeyRotation',
    'kms:GetKeyRotationStatus',
]

// The account principal, narrowed by the condition to the root user itself: without the
// condition the statement would let IAM policies add access to the key.
function rootUserOnly(account: string): Statement {
    return {
        Sid: 'RootUserOnly',
        Effect: 'Allow',
        Principal: { AWS: `arn:aws:iam::${account}:root` },
        Action: ['kms:DescribeKey', 'kms:GetKeyPolicy', 'kms:PutKeyPolicy'],
        Resource: '*',
        Condition: { ArnEquals: { 'aws:PrincipalArn': `arn:aws:iam::${account}:root` } },
    }
}

// A user is matched by its ARN. A role session's ARN names the role without its path and with
// a session, so it is matched by the role's name.
function isAmong(caller: string, principals: string[]) {
    const session = /^arn:aws:sts::(\d{12}):assumed-role\/([^/]+)\//u.exec(caller)
    if (!session) {
        return principals.includes(caller)
    }
    const [, account, role] = session
    return principals.some(
        principal =>
            account !== undefined &&
            principal.startsWith(`arn:aws:iam::${account}:role/`) &&
            principal.split('/').at(-1) === role,
    )
}

function regionOf({ env }: Context) {
    if (env.AWS_REGION === undefined) {
        throw new Refusal('no AWS region: set AWS_REGION or give the profile a region')
    }
    return env.AWS_REGION
}

/**
Makes the key and its alias, or finds them, and holds the stored policy against the one asked
for. A key made whose alias then failed is resumed with --key; a key whose creation was answered
but the answer lost cannot be found, since no listing is granted, and is cleaned up by hand.
*/
async function ensureKey(
    { context, io }: Command,
    { keyId, updatePolicy }: SecretArguments,
    {
        alias,
        description,
        described,
        statements,
    }: { alias: string; description: string; described: boolean; statements: Stored[] },
) {
    const policy = JSON.stringify({ Version: '2012-10-17', Statement: statements })
    const existing = await describeKey(context, alias)
    if (existing && keyId !== undefined && ![existing.KeyId, existing.Arn].includes(keyId)) {
        throw new Refusal(`${alias} names key ${existing.KeyId}, not ${keyId}`)
    }
    // An alias joins its parts with hyphens, which the parts may hold themselves: the
    // description, joined with spaces, is what tells one service's key from another's.
    if (existing && described && existing.Description !== description) {
        throw new Refusal(
            `${alias} is key ${existing.KeyId}, described as ${JSON.stringify(existing.Description)}, not ${JSON.stringify(description)}: it is the key of another service or name`,
        )
    }
    const key = existing ?? (await namedKey(context, io, keyId, description, policy, alias))
    if (!existing && keyId === undefined) {
        return key
    }
    const stored = await storedStatements(context, key.KeyId, alias)
    const differing = differingStatements(stored, statements)
    if (differing.length === 0) {
        io.out(`${alias} is key ${key.KeyId}; its policy is as given`)
        return key
    }
    const deleted = deletedPrincipals(stored)
    if (!updatePolicy) {
        throw new Refusal(
            `the policy of ${alias} differs from the one asked for in ${differing.join(', ')}${deleted}; rerun with --update-policy to replace it`,
        )
    }
    await putPolicy(
        context,
        'PutKeyPolicy',
        { KeyId: key.KeyId, PolicyName: 'default', Policy: policy },
        alias,
        io,
    )
    io.out(
        `${alias} is key ${key.KeyId}; its policy was replaced in ${differing.join(', ')}${deleted}`,
    )
    return key
}

// Answers the key it made or was given, not a second look at the alias: KMS may take a moment
// to answer for an alias it just made.
async function namedKey(
    context: Context,
    io: Command['io'],
    keyId: string | undefined,
    description: string,
    policy: string,
    alias: string,
) {
    const created = await keyToName(context, io, keyId, description, policy, alias)
    try {
        await awsJson(
            context,
            'kms',
            'CreateAlias',
            { AliasName: alias, TargetKeyId: created.KeyId },
            { names: [alias] },
        )
    } catch (e) {
        io.log.error(`key ${created.KeyId} has no alias; rerun with --key ${created.KeyId}`)
        throw e
    }
    return created
}

async function keyToName(
    context: Context,
    io: Command['io'],
    keyId: string | undefined,
    description: string,
    policy: string,
    alias: string,
) {
    if (keyId === undefined) {
        const { KeyMetadata: created } = await putPolicy<{ KeyMetadata: Key }>(
            context,
            'CreateKey',
            {
                Description: description,
                KeyUsage: 'ENCRYPT_DECRYPT',
                KeySpec: 'SYMMETRIC_DEFAULT',
                Policy: policy,
            },
            alias,
            io,
        )
        io.out(`created key ${created.KeyId}`)
        return created
    }
    const given = await describeKey(context, keyId)
    if (!given) {
        throw new Refusal(`key ${keyId} does not exist`)
    }
    if (given.Description !== description) {
        throw new Refusal(
            `key ${keyId} is described as ${JSON.stringify(given.Description)}, not ${JSON.stringify(description)}: it is not the key this command made`,
        )
    }
    return given
}

async function putPolicy<T>(
    context: Context,
    operation: string,
    body: { [key: string]: unknown },
    alias: string,
    io: Command['io'],
) {
    try {
        return await awsJson<T>(context, 'kms', operation, body, { names: [alias] })
    } catch (e) {
        if (e instanceof AwsError && e.code === 'MalformedPolicyDocumentException') {
            io.log.error(
                'KMS refused the key policy: usually a principal that does not exist, or one that cannot be named in a policy',
            )
        }
        throw e
    }
}

async function describeKey(context: Context, id: string) {
    try {
        const { KeyMetadata } = await awsJson<{ KeyMetadata: Key }>(
            context,
            'kms',
            'DescribeKey',
            { KeyId: id },
            { names: [id] },
        )
        return KeyMetadata
    } catch (e) {
        if (e instanceof AwsError && e.code === 'NotFoundException') {
            return undefined
        }
        throw e
    }
}

async function storedStatements(context: Context, keyId: string, alias: string) {
    const { Policy } = await awsJson<{ Policy: string }>(
        context,
        'kms',
        'GetKeyPolicy',
        { KeyId: keyId, PolicyName: 'default' },
        { names: [alias] },
    )
    return storedOf(JSON.parse(Policy))
}

// A stored policy is whatever an administrator last put, by this tool or by hand.
function storedOf(policy: unknown): Stored[] {
    if (
        policy === null ||
        typeof policy !== 'object' ||
        !('Statement' in policy) ||
        !Array.isArray(policy.Statement)
    ) {
        return []
    }
    return policy.Statement.filter(
        (statement: unknown) => statement !== null && typeof statement === 'object',
    ).map((statement: object) => ({
        ...statement,
        Sid: 'Sid' in statement && typeof statement.Sid === 'string' ? statement.Sid : '(no Sid)',
    }))
}

function stringsOf(value: unknown) {
    if (typeof value === 'string') {
        return [value]
    }
    if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
        return value.toSorted((a, b) => a.localeCompare(b))
    }
    return undefined
}

function principalsOf({ Principal: principal }: Stored) {
    if (principal === null || typeof principal !== 'object' || !('AWS' in principal)) {
        return []
    }
    return stringsOf(principal.AWS) ?? []
}

// AWS answers a single principal or action as a string and in an order of its own. A
// statement of another shape stays as it is, and so differs.
function canonical(statement: Stored) {
    const principals = principalsOf(statement)
    const actions = stringsOf(statement.Action)
    return {
        ...statement,
        ...(principals.length !== 0 && { Principal: { AWS: principals } }),
        ...(actions && { Action: actions }),
    }
}

function differingStatements(stored: Stored[], wanted: Stored[]) {
    return [...new Set([...stored, ...wanted].map(statement => statement.Sid))].filter(sid => {
        const [a, b] = [stored, wanted].map(statements =>
            statements.filter(statement => statement.Sid === sid).map(canonical),
        )
        return !isDeepStrictEqual(a, b)
    })
}

// AWS stores a principal by its id: one that reads as an id and no longer as an ARN was
// deleted after the policy was put.
function deletedPrincipals(stored: Stored[]) {
    const statements = stored
        .filter(statement =>
            principalsOf(statement).some(principal => !principal.startsWith('arn:')),
        )
        .map(statement => statement.Sid)
    return statements.length === 0
        ? ''
        : ` (a principal named in ${statements.join(', ')} no longer exists)`
}
