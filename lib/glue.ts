import { createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type Resolver = {
    getEnvironment(prefix: string, service: string): Promise<{ [key: string]: string }>
    getBaseUrl(prefix: string, service: string): Promise<string | undefined>
}

export async function getGlue(path: string, prefix: string, resolver: Resolver, gluePath?: string) {
    const [packageJson, glueJson] = await Promise.all([
        readFile(join(path, 'package.json'), 'utf-8'),
        readFile(glueFilePath(path, gluePath), 'utf-8'),
    ])
    const { name: service } = JSON.parse(packageJson) as { name: string }
    const glue = JSON.parse(glueJson) as {
        implementations: Implementations
        websites: {
            [key: string]: string[]
        }
        services: {
            [key: string]: {
                implementations: Implementations
                publish?: string[]
                cors?: string
                env: { [key: string]: string }
                secrets: { [key: string]: string }
                [provider: string]: unknown
            }
        }
    }

    const { publish, cors, env, secrets, implementations, ...provider } =
        glue.services[service] ?? {}
    return {
        service,
        implementations: {
            ...glue.implementations,
            ...implementations,
        },
        publishTopics: publish ?? [],
        corsSites: cors ? (glue.websites[cors] ?? []) : [],
        env: resolveEnv(env ?? {}, secrets ?? {}, prefix, service, resolver),
        ...provider,
    }
}

export function glueFilePath(path: string, gluePath?: string) {
    return gluePath ?? join(path, '..', 'glue', 'glue.json')
}

/**
The AWS account the glue file says its stage lives in: `aws.accountId` at the top level, once for
the file, as a string so that an id starting with zero survives JSON. Undefined when the file
declares none. A key the tool does not know is refused: `accountID` or `account` would otherwise
read as no account declared, and the check the author asked for would silently not run.
*/
export async function declaredAccount(glueFile: string) {
    const glue: unknown = JSON.parse(await readFile(glueFile, 'utf-8'))
    if (glue === null || typeof glue !== 'object' || !('aws' in glue)) {
        return undefined
    }
    const { aws } = glue
    if (aws === null || typeof aws !== 'object' || Array.isArray(aws)) {
        throw new Error(`aws in ${glueFile} must be an object.`)
    }
    const unknown = Object.keys(aws).filter(key => !topLevelAwsKeys.includes(key))
    if (unknown.length !== 0) {
        throw new Error(
            `aws in ${glueFile} holds ${unknown.join(', ')}, which the tool does not know. The top-level aws object takes ${topLevelAwsKeys.join(', ')}.`,
        )
    }
    if (!('accountId' in aws)) {
        return undefined
    }
    if (typeof aws.accountId !== 'string' || !/^\d{12}$/u.test(aws.accountId)) {
        throw new Error(`aws.accountId in ${glueFile} must be a string of twelve digits.`)
    }
    return aws.accountId
}

const topLevelAwsKeys = ['accountId']

/**
A setting of the glue's `aws` object that names a list per function (`layers`, `external`), keyed
by function name. `items` says what the lists hold, for the refusals.
*/
export function functionLists(
    functionNames: string[],
    glueAws: unknown,
    setting: string,
    items: string,
): { [functionName: string]: string[] } {
    const named =
        glueAws !== null && typeof glueAws === 'object'
            ? Object.entries(glueAws).find(([key]) => key === setting)
            : undefined
    const glue: unknown = named ? named[1] : {}
    if (glue === null || typeof glue !== 'object' || Array.isArray(glue)) {
        throw new Error(`aws.${setting} must map function names to lists of ${items}.`)
    }
    const unknown = Object.keys(glue).filter(name => !functionNames.includes(name))
    if (unknown.length !== 0) {
        throw new Error(
            `aws.${setting} names ${unknown.join(', ')}, which the service has no function of.`,
        )
    }
    return Object.fromEntries(
        Object.entries(glue).map(([name, list]: [string, unknown]) => {
            const strings = Array.isArray(list)
                ? list.filter((item): item is string => typeof item === 'string')
                : []
            if (!Array.isArray(list) || strings.length !== list.length) {
                throw new Error(`aws.${setting} of ${name} must be a list of ${items}.`)
            }
            return [name, strings] as const
        }),
    )
}

type Implementations = {
    [interfacePackage: string]: {
        implementation: string
        version: string
    }
}

const own = Symbol()

type Variable = {
    pattern: RegExp
    source: (match: RegExpMatchArray) => {
        environment?: string | typeof own
        baseUrl?: string
    }
    value: (
        prefix: string,
        service: string,
        match: RegExpMatchArray,
        key: string,
        environments: { [service: string]: { [key: string]: string } },
        baseUrls: { [service: string]: string | undefined },
    ) => string
}

const variables: Variable[] = [
    {
        pattern: /\$ENV/gu,
        source: () => ({}),
        value: prefix => prefix,
    },
    {
        pattern: /\$SERVICE/gu,
        source: () => ({}),
        value: (_prefix, service) => service,
    },
    {
        pattern: /\$PRIVATE_KEY\(([^)]+)\)/gu,
        source: () => ({ environment: own }),
        value: (_prefix, service, [_, curve], key, env) =>
            env[service]?.[key] ??
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            generateKeyPairSync('ec', { namedCurve: curve! })
                .privateKey.export({ type: 'sec1', format: 'pem' })
                .toString()
                .split('\n')
                .slice(1, -2)
                .join(''),
    },
    {
        pattern: /\$ASK\(([^)]*)\)/gu,
        source: () => ({ environment: own }),
        value: (_prefix, service, [_, hint], key, env, _url) =>
            env[service]?.[key] ?? missing(hint ? `ASK implementation: ${hint}` : 'ASK'),
    },
    {
        pattern: /\$RANDOM\(([0-9]+)\)/gu,
        source: () => ({ environment: own }),
        value: (_prefix, service, [_, bits], key, env, _url) =>
            env[service]?.[key] ?? randomBytes(Math.ceil(Number(bits) / 8)).toString('hex'),
    },
    {
        pattern: /\$SAME_AS\(([^,]+),([^)]+)\)/gu,
        source: match => ({ environment: match[1] }),
        value: (_prefix, _service, [, service, key], _key, env, _url) =>
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            env[service!]?.[key!] ??
            variableError(
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                `Variable ${key!} for ${service!} not found. Has it been deployed?`,
            ),
    },
    {
        pattern: /\$PUBLIC_KEY\(([^,]+),([^)]+)\)/gu,
        source: match => ({ environment: match[1] }),
        value: (_prefix, _service, [, service, key], _key, env) =>
            createPublicKey(
                `-----BEGIN EC PRIVATE KEY-----\n${
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    env[service!]?.[key!] ??
                    variableError(
                        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                        `Private key for ${service!} not found. Has it been deployed?`,
                    )
                }\n-----END EC PRIVATE KEY-----\n`,
            )
                .export({ type: 'spki', format: 'pem' })
                .toString()
                .split('\n')
                .slice(1, -2)
                .join(''),
    },
    {
        pattern: /\$BASE_URL\(([^)]+)\)/gu,
        source: match => ({ baseUrl: match[1] }),
        value: (_prefix, _service, [_, service], _key, _env, url) =>
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            url[service!] ??
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            variableError(`Base URL for ${service!} not found. Has it been deployed?`),
    },
]

function variableError(message: string): never {
    throw new Error(message)
}

async function resolveEnv(
    clear: { [key: string]: string },
    secrets: { [key: string]: string },
    prefix: string,
    service: string,
    resolver: Resolver,
) {
    const env = {
        ...clear,
        ...secrets,
    }
    const referencedEnvironments: string[] = []
    const referencedBaseUrls: string[] = []
    const selfReferencing: { key: string; v: Variable; match: RegExpMatchArray }[] = []
    for (const [key, value] of Object.entries(env)) {
        for (const v of variables) {
            for (const match of value.matchAll(v.pattern)) {
                const source = v.source(match)
                const sourceEnvName = source.environment === own ? service : source.environment
                if (sourceEnvName && !referencedEnvironments.includes(sourceEnvName)) {
                    if (source.environment === service) {
                        selfReferencing.push({ key, v, match })
                    } else {
                        referencedEnvironments.push(sourceEnvName)
                    }
                }
                if (source.baseUrl && !referencedBaseUrls.includes(source.baseUrl)) {
                    referencedBaseUrls.push(source.baseUrl)
                }
            }
        }
    }
    const [environments, baseUrls] = await Promise.all([
        fetchEnvironments(prefix, referencedEnvironments, resolver),
        fetchBaseUrls(prefix, referencedBaseUrls, resolver),
    ])
    for (const v of variables) {
        for (const [key, value] of Object.entries(env)) {
            env[key] = value.replaceAll(v.pattern, (substring, ...matches: string[]) => {
                if (
                    selfReferencing.some(
                        r => r.key === key && r.v === v && r.match[0] === substring,
                    )
                ) {
                    return substring
                }
                return v.value(
                    prefix,
                    service,
                    [substring, ...matches],
                    key,
                    environments,
                    baseUrls,
                )
            })
        }
    }

    for (const ref of selfReferencing) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        env[ref.key] = env[ref.key]!.replaceAll(
            ref.v.pattern,
            (substring, ...matches: string[]) => {
                return ref.v.value(
                    prefix,
                    service,
                    [substring, ...matches],
                    ref.key,
                    { [service]: env },
                    baseUrls,
                )
            },
        )
    }

    return env
}

async function fetchEnvironments(prefix: string, services: string[], resolver: Resolver) {
    return Object.fromEntries(
        await Promise.all(
            services.map(async s => [s, await resolver.getEnvironment(prefix, s)] as const),
        ),
    )
}

async function fetchBaseUrls(prefix: string, services: string[], resolver: Resolver) {
    return Object.fromEntries(
        await Promise.all(
            services.map(async s => [s, await resolver.getBaseUrl(prefix, s)] as const),
        ),
    )
}

function missing(what?: string): never {
    throw new Error(what ? `Missing ${what}.` : 'Missing.')
}
