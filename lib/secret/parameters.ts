import { type SecretArguments } from '../arguments.js'
import { AwsError, type Context, awsJson } from '../aws/lite.js'
import { listAccountFunctions } from '../aws/services/lambda.js'
import { parameterName } from '../glue.js'
import {
    type Command,
    readersOf,
    referencesIn,
    requireService,
    serviceFunctions,
} from './references.js'
import { Refusal } from './refusal.js'
import { checkedValue } from './value.js'

type Described = {
    Name: string
    Type: string
    KeyId?: string
    Version: number
    LastModifiedDate: number
    LastModifiedUser: string
}

export async function put(command: Command, args: SecretArguments) {
    const { service, key } = named(args)
    const name = parameterName(command.stage, service, key)
    const readers = readersOf(command, name)
    if (readers.length === 0) {
        throw new Refusal(`${service}.${key} is not a parameter reference in ${command.glueFile}`)
    }
    const [existing] = await describe(command.context, { Key: 'Name', Option: 'Equals' }, name)
    if (existing && !args.replace) {
        throw new Refusal(`already set at version ${existing.Version}; use --replace`)
    }
    if (!existing && args.replace) {
        throw new Refusal('not set; put without --replace')
    }
    if (existing && (existing.Type !== 'SecureString' || existing.KeyId !== stageKey(command))) {
        throw new Refusal(
            `exists as ${existing.Type} under ${existing.KeyId ?? 'no key'}; rm it first`,
        )
    }
    const value = checkedValue(await command.io.readValue(), args.multiline)
    const version = await putParameter(command, name, value, args.replace)
    command.io.out(existing ? `version ${existing.Version} → ${version}` : `version ${version}`)
    command.io.out(`redeploy: ${readers.join(', ')}`)
    return 0
}

/**
Copies what the service's functions hold into the parameter. It needs no reference in glue, so
that the value can be in place before glue changes: the function holding the key is the guard
against a mistyped one.
*/
export async function importValue(command: Command, args: SecretArguments) {
    const { service, key } = named(args)
    requireService(command, service)
    const name = parameterName(command.stage, service, key)
    const holding = serviceFunctions(
        await listAccountFunctions(command.context),
        command,
        service,
    ).flatMap(fn => {
        const value = fn.env[key]
        return value === undefined ? [] : [{ name: fn.name, value }]
    })
    const [first] = holding
    if (!first) {
        throw new Refusal(`no function of ${service} on ${command.stage} holds ${key}`)
    }
    // Imported, the text would become the parameter and every later deploy would fetch it.
    const text = holding.find(({ value }) => value.includes('$PARAMETER('))
    if (text) {
        throw new Refusal(
            `${text.name} holds the text of a parameter reference as ${key}, as a tool older than 0.6.2 deploys it; that is no value to import. Put the value (deploy secret put …) and redeploy with 0.6.2.`,
        )
    }
    const differing = holding.find(({ value }) => value !== first.value)
    if (differing) {
        throw new Refusal(`${first.name} and ${differing.name} hold different values of ${key}`)
    }
    const value = checkedValue(first.value, true)
    const existing = await stored(command.context, name)
    if (!existing) {
        command.io.out(`version ${await putParameter(command, name, value, false)}`)
        return 0
    }
    if (existing.Value !== value) {
        throw new Refusal(
            `${name} is set at version ${existing.Version} to another value than the functions hold; put --replace or restore decides which one stands`,
        )
    }
    command.io.out(`already at version ${existing.Version}`)
    return 0
}

export async function list(command: Command, args: SecretArguments) {
    const { stage, services, context, io } = command
    const path = args.service === undefined ? `/${stage}` : `/${stage}/${args.service}`
    const rows = await describe(context, { Key: 'Path', Option: 'Recursive' }, path)
    const referenced = referencesIn(services, stage)
        .filter(reference => args.service === undefined || reference.service === args.service)
        .map(({ name }) => name)
    const lines = [
        ...rows.map(row => ({
            name: row.Name,
            fields: [
                `v${row.Version}`,
                new Date(row.LastModifiedDate * 1000).toISOString(),
                row.LastModifiedUser,
                [
                    ...(referenced.includes(row.Name) ? [] : ['unreferenced']),
                    ...(row.Type === 'SecureString' ? [] : ['not SecureString']),
                    ...(row.Type !== 'SecureString' || row.KeyId === stageKey(command)
                        ? []
                        : ['other key']),
                ].join(',') || '-',
            ],
        })),
        ...[...new Set(referenced)]
            .filter(name => rows.every(row => row.Name !== name))
            .map(name => ({ name, fields: ['-', '-', '-', 'missing'] })),
    ]
    for (const { name, fields } of lines.toSorted((a, b) => a.name.localeCompare(b.name))) {
        io.out([name, ...fields].join('\t'))
    }
    return 0
}

/**
Compares what each function was deployed with, by the versions stamped in PARAMETER_VERSIONS,
with the parameters as they stand. It reads no value: a function that holds a referenced key
without a stamp holds the literal from before the reference, or, where a block had a reference
and no tripwire, the reference's text; the cure for both is a deploy.
*/
export async function check(command: Command, args: SecretArguments) {
    const { stage, services, context, io } = command
    if (args.service !== undefined) {
        requireService(command, args.service)
    }
    const [all, rows] = await Promise.all([
        listAccountFunctions(context),
        describe(context, { Key: 'Path', Option: 'Recursive' }, `/${stage}`),
    ])
    const references = referencesIn(services, stage)
    const lines = (args.service === undefined ? Object.keys(services) : [args.service]).flatMap(
        service =>
            serviceFunctions(all, command, service).flatMap(fn => {
                const stamps = stampsOf(fn.env.PARAMETER_VERSIONS)
                const own = references.filter(reference => reference.reader === service)
                const keys = new Set([
                    ...Object.keys(stamps),
                    ...own.filter(({ key }) => Object.hasOwn(fn.env, key)).map(({ key }) => key),
                ])
                return [...keys]
                    .toSorted((a, b) => a.localeCompare(b))
                    .flatMap(key => {
                        const name =
                            own.find(reference => reference.key === key)?.name ??
                            parameterName(stage, service, key)
                        const current = rows.find(row => row.Name === name)?.Version
                        const state = stateOf(stamps[key], current)
                        return state === undefined
                            ? []
                            : [
                                  [
                                      fn.name,
                                      key,
                                      stamps[key] === undefined ? '-' : `deployed v${stamps[key]}`,
                                      current === undefined ? '-' : `current v${current}`,
                                      state,
                                  ].join('\t'),
                              ]
                    })
            }),
    )
    for (const line of lines) {
        io.out(line)
    }
    return lines.length === 0 ? 0 : 1
}

export async function restore(command: Command, args: SecretArguments) {
    const { service, key } = named(args)
    const name = parameterName(command.stage, service, key)
    const earlier = await storedVersion(command.context, name, args.version)
    const version = await putParameter(command, name, earlier.Value, true)
    command.io.out(
        `version ${earlier.Version} restored as ${version}; redeploy: ${readersOf(command, name).join(', ')}`,
    )
    return 0
}

export async function rm(command: Command, args: SecretArguments) {
    const { service, key } = named(args)
    const name = parameterName(command.stage, service, key)
    const readers = readersOf(command, name)
    if (readers.length !== 0) {
        throw new Refusal(
            `${name} is referenced in ${command.glueFile} by ${readers.join(', ')}; take the reference out first`,
        )
    }
    const [existing] = await describe(command.context, { Key: 'Name', Option: 'Equals' }, name)
    if (!existing) {
        throw new Refusal(`${name} is not set`)
    }
    if (!args.yes) {
        command.io.out(`this also deletes its ${existing.Version} versions`)
        return 1
    }
    await awsJson(command.context, 'ssm', 'DeleteParameter', { Name: name }, { names: [name] })
    command.io.out(`deleted ${name}`)
    return 0
}

function named({ service, key }: SecretArguments) {
    if (service === undefined || key === undefined) {
        throw new Refusal('the command needs <service> and <KEY>')
    }
    return { service, key }
}

function stageKey({ stage }: { stage: string }) {
    return `alias/${stage}-secrets`
}

function stateOf(deployed: number | undefined, current: number | undefined) {
    if (deployed === undefined) {
        return 'not deployed since the reference'
    }
    if (current === undefined) {
        return 'parameter missing'
    }
    return deployed === current ? undefined : 'stale'
}

function stampsOf(stamp: string | undefined): { [key: string]: number } {
    const parsed = parseJson(stamp ?? '{}')
    if (parsed === null || typeof parsed !== 'object') {
        return {}
    }
    return Object.fromEntries(
        Object.entries(parsed).filter(
            (entry): entry is [string, number] => typeof entry[1] === 'number',
        ),
    )
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text)
    } catch (e) {
        if (e instanceof SyntaxError) {
            return undefined
        }
        throw e
    }
}

async function describe(context: Context, filter: { Key: string; Option: string }, value: string) {
    const rows: Described[] = []
    for (let next: string | undefined; ;) {
        const page = await awsJson<{ Parameters?: Described[]; NextToken?: string }>(
            context,
            'ssm',
            'DescribeParameters',
            {
                ParameterFilters: [{ ...filter, Values: [value] }],
                MaxResults: 50,
                ...(next !== undefined && { NextToken: next }),
            },
            { names: [value] },
        )
        rows.push(...(page.Parameters ?? []))
        if (!page.NextToken) {
            return rows
        }
        next = page.NextToken
    }
}

async function stored(context: Context, name: string) {
    try {
        return await getParameter(context, name)
    } catch (e) {
        if (e instanceof AwsError && e.code === 'ParameterNotFound') {
            return undefined
        }
        throw e
    }
}

async function storedVersion(context: Context, name: string, version: number | undefined) {
    if (version === undefined) {
        throw new Refusal('restore needs <version>')
    }
    try {
        return await getParameter(context, `${name}:${version}`)
    } catch (e) {
        if (e instanceof AwsError && e.code === 'ParameterVersionNotFound') {
            throw new Refusal(`${name} has no version ${version}`, { cause: e })
        }
        if (e instanceof AwsError && e.code === 'ParameterNotFound') {
            throw new Refusal(`${name} is not set`, { cause: e })
        }
        throw e
    }
}

async function getParameter(context: Context, name: string) {
    const { Parameter } = await awsJson<{ Parameter: { Value: string; Version: number } }>(
        context,
        'ssm',
        'GetParameter',
        { Name: name, WithDecryption: true },
        { names: [name] },
    )
    return Parameter
}

async function putParameter(command: Command, name: string, value: string, overwrite: boolean) {
    const { Version } = await awsJson<{ Version: number }>(
        command.context,
        'ssm',
        'PutParameter',
        {
            Name: name,
            Value: value,
            Type: 'SecureString',
            Tier: 'Standard',
            KeyId: stageKey(command),
            Overwrite: overwrite,
        },
        { names: [name] },
    )
    return Version
}
