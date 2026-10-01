import { jsonResponse, okResponse } from '@riddance/fetch'
import { PackageJsonConfiguration, Reflection, resolveCpu } from '@riddance/host/reflect'
import JSZip from 'jszip'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { compare } from '../diff.js'
import { type Context, awsRequest, retry, retryConflict } from '../lite.js'

export async function syncLambda(
    context: Context,
    prefix: string,
    currentFunctions: AwsFunctionLite[],
    reflection: Reflection,
    environment: { [key: string]: string },
    role: string,
    code: { [name: string]: string },
) {
    const zipped = Object.fromEntries(
        await Promise.all(
            Object.entries(code).map(async ([name, c]) => [name, await zip(c)] as const),
        ),
    )

    const functions = [...reflection.http, ...reflection.events, ...reflection.timers]
    const { missing, surplus, existing } = compare(functions, currentFunctions)
    const created = await Promise.all(
        missing.map(fn =>
            createLambda(
                context,
                prefix,
                fn.name,
                reflection.name,
                reflection.revision,
                role,
                fn,
                environment,
                zipped[fn.name],
            ),
        ),
    )
    await Promise.all(surplus.map(fn => deleteLambda(context, prefix, reflection.name, fn.name)))
    await Promise.all(
        existing.map(awsFn =>
            updateLambda(
                context,
                prefix,
                awsFn.name,
                reflection.name,
                role,
                functions.find(fn => fn.name === awsFn.name),
                awsFn,
                environment,
                zipped[awsFn.name],
            ),
        ),
    )

    return [...currentFunctions.map(fn => ({ id: fn.id, name: fn.name })), ...created]
}

async function zip(code: string) {
    const buffer = await new JSZip()
        .file('index.js', code, {
            compression: 'DEFLATE',
            compressionOptions: { level: 9 },
            date: new Date(2022, 8, 1),
        })
        .generateAsync({ type: 'nodebuffer' })
    return {
        zipped: buffer.toString('base64'),
        size:
            buffer.length < 1024
                ? `${buffer.length} bytes`
                : `${Math.ceil(buffer.length / 102.4) / 10} KiB`,
        sha256: createHash('sha256').update(buffer).digest('base64'),
    }
}

type Architectures = ['arm64'] | ['x86_64']
export type AwsFunctionLite = {
    id: string
    name: string
    runtime: string
    memory: number
    timeout: number
    env: { [key: string]: string }
    cpus: Architectures
    hash: string
    size: string
}

type AwsFunction = {
    Description: string
    TracingConfig: {
        Mode: 'PassThrough'
    }
    RevisionId: string
    LastModified: string
    FunctionArn: string
    FunctionName: string
    Runtime: 'nodejs18.x' | 'nodejs20.x' | 'nodejs22.x' | 'nodejs24.x'
    Version: '$LATEST'
    PackageType: 'Zip'
    MemorySize: number
    Timeout: number
    Handler: 'index.handler'
    CodeSha256: string
    Role: string
    SigningProfileVersionArn: null
    MasterArn: null
    CodeSize: number
    State: null
    StateReason: null
    Environment?: {
        Variables: { [key: string]: string }
        Error: null
    }
    EphemeralStorage: {
        Size: number
    }
    StateReasonCode: null
    LastUpdateStatusReasonCode: null
    Architectures: Architectures
}

/**
Every function whose name starts with `${prefix}-${service}-`, for reading a sibling's
environment through the glue (`$SAME_AS`, `$PUBLIC_KEY`). It is a prefix match, so
`staging-rentals-` also lists `staging-rentals-v2-*`: nothing may be created, updated or
deleted from this list. `getFunctions` is for that, and pays for the exactness.
*/
export async function listFunctions(
    context: Context,
    prefix: string,
    service: string,
): Promise<AwsFunctionLite[]> {
    const fnPrefix = `${prefix}-${service}-`.toLowerCase()
    return (await listFunctionsByPrefix(context, fnPrefix)).map(fn => asLite(fn, fnPrefix))
}

/**
The service's own functions, for sync to compare the reflection against: compare() deletes
whatever is returned here but not reflected, so a prefix match would delete a sibling's
`staging-rentals-v2-*` under `staging-rentals-`. A candidate is ours when its whole name is
one the service reflects, or else when the tags createLambda wrote name this service and
environment. ListFunctions carries no tags, so only an unreflected candidate (a handler the
service no longer has, or a sibling's function) costs a ListTags call; a deploy that changes
no handler names makes none. The deploy principal therefore needs `lambda:ListTags` on the
functions under its prefix, beside the permissions it already has.
*/
export async function getFunctions(
    context: Context,
    prefix: string,
    service: string,
    reflectedNames: string[],
): Promise<AwsFunctionLite[]> {
    const fnPrefix = `${prefix}-${service}-`.toLowerCase()
    const candidates = await listFunctionsByPrefix(context, fnPrefix)
    const ours = await selectOwnFunctions(candidates, fnPrefix, reflectedNames, {
        service,
        environment: prefix,
        tagsOf: async fn => {
            // The Lambda control plane throttles at a low shared rate; a throttled or failed
            // read is retried as createLambda retries its own request.
            const { Tags } = await jsonResponse<{ Tags?: { [key: string]: string } }>(
                retry(
                    context.log,
                    () =>
                        awsRequest(
                            context,
                            'GET',
                            'lambda',
                            `/2017-03-31/tags/${encodeURIComponent(fn.FunctionArn)}`,
                        ),
                    r => (r.status === 429 || r.status >= 500 ? 5 : undefined),
                ),
                'Error reading tags of function ' + fn.FunctionName,
            )
            return Tags
        },
        leftAlone: (fn, tags) => {
            if (typeof tags?.service === 'string' && tags.service !== service) {
                // A sibling's function under a prefix of ours: expected, and quiet.
                context.log.trace(`left alone: ${fn.FunctionName} belongs to ${tags.service}`)
                return
            }
            // Untagged, or tagged for another environment under this one's prefix: nobody's
            // by the rule, so it is never deleted or updated here; an operator decides.
            context.log.warn(
                `left alone: ${fn.FunctionName} is not tagged service=${service} environment=${prefix} (tags: ${JSON.stringify(tags ?? {})}); delete or re-tag it by hand if it is a leftover of this service`,
            )
        },
    })
    return ours.map(fn => asLite(fn, fnPrefix))
}

/**
The ownership decision, pure so it can be tested without AWS: a candidate is reflected (ours,
no lookup), tagged as this service in this environment (ours), or left alone (never deleted or
updated), with the tags it was judged by. `reflectedNames` are the names of the reflected
handlers, without the prefix. Tags are read one function at a time: the control plane throttles
at a low shared rate, and there is rarely more than one unreflected candidate.
*/
export async function selectOwnFunctions<T extends { FunctionName: string }>(
    candidates: T[],
    fnPrefix: string,
    reflectedNames: string[],
    owner: {
        service: string
        environment: string
        tagsOf: (fn: T) => Promise<{ [key: string]: string } | undefined>
        leftAlone: (fn: T, tags: { [key: string]: string } | undefined) => void
    },
): Promise<T[]> {
    const reflected = new Set(reflectedNames.map(name => `${fnPrefix}${name}`.toLowerCase()))
    const ours: T[] = []
    for (const fn of candidates) {
        if (reflected.has(fn.FunctionName.toLowerCase())) {
            ours.push(fn)
            continue
        }
        const tags = await owner.tagsOf(fn)
        if (tags?.service === owner.service && tags.environment === owner.environment) {
            ours.push(fn)
            continue
        }
        owner.leftAlone(fn, tags)
    }
    return ours
}

async function listFunctionsByPrefix(context: Context, fnPrefix: string) {
    const funcs: AwsFunction[] = []
    let marker = ''
    for (;;) {
        const page = await jsonResponse<{
            Functions: AwsFunction[]
            NextMarker: string | null
        }>(
            awsRequest(context, 'GET', 'lambda', `/2015-03-31/functions/?${marker}`),
            'Error listing functions',
        )
        funcs.push(...page.Functions)
        if (page.NextMarker === null) {
            break
        }
        marker = `Marker=${encodeURIComponent(page.NextMarker)}`
    }
    return funcs.filter(fn => fn.FunctionName.toLowerCase().startsWith(fnPrefix))
}

function asLite(fn: AwsFunction, fnPrefix: string): AwsFunctionLite {
    return {
        id: fn.FunctionArn,
        name: fn.FunctionName.slice(fnPrefix.length),
        runtime: fn.Runtime,
        memory: fn.MemorySize,
        timeout: fn.Timeout,
        env: fn.Environment?.Variables ?? {},
        cpus: fn.Architectures,
        hash: fn.CodeSha256,
        size:
            fn.CodeSize < 1024
                ? `${fn.CodeSize} bytes`
                : `${Math.ceil(fn.CodeSize / 102.4) / 10} KiB`,
    }
}

type Target = {
    config: {
        memory?: string
        compute?: string
        timeout?: number
    } & PackageJsonConfiguration
    method?: string
}

async function createLambda(
    context: Context,
    prefix: string,
    name: string,
    service: string,
    revision: string | undefined,
    role: string,
    target: Target,
    environment: { [key: string]: string },
    code?: { zipped: string; sha256: string; size: string },
) {
    if (!code) {
        throw new Error('No code')
    }
    context.log.trace(`creating lambda ${name} (${code.size})`)
    const response = await jsonResponse<{ FunctionArn: string }>(
        retry(
            context.log,
            () =>
                awsRequest(context, 'POST', 'lambda', '/2015-03-31/functions', {
                    FunctionName: `${prefix}-${service}-${name}`,
                    Code: { ZipFile: code.zipped },
                    PackageType: 'Zip',
                    Architectures: lambdaArchitecture(target),
                    ...lambdaConfig(target, role, environment),
                    Tags: {
                        framework: 'riddance',
                        environment: prefix,
                        service,
                        revision,
                    },
                }),
            r => (r.status === 400 ? 25 : undefined),
        ),
        'Error creating lambda ' + name,
    )
    return { name, id: response.FunctionArn }
}

async function updateLambda(
    context: Context,
    prefix: string,
    name: string,
    service: string,
    role: string,
    target: Target | undefined,
    awsFn: AwsFunctionLite,
    environment: { [key: string]: string },
    code?: { zipped: string; sha256: string; size: string },
) {
    if (!code) {
        throw new Error('No code')
    }
    if (!target) {
        throw new Error('No config')
    }
    const cpus = lambdaArchitecture(target)
    const awsConfig = lambdaConfig(target, role, environment)
    if (!isDeepStrictEqual({ cpus, hash: code.sha256 }, { cpus: awsFn.cpus, hash: awsFn.hash })) {
        context.log.trace(`updating code for lambda ${name} (${awsFn.size} -> ${code.size})`)
        await okResponse(
            awsRequest(
                context,
                'PUT',
                'lambda',
                `/2015-03-31/functions/${prefix}-${service}-${name}/code`,
                {
                    ZipFile: code.zipped,
                    Architectures: cpus,
                },
            ),
            'Error updating code for lambda ' + name,
        )
    }
    if (
        !isDeepStrictEqual(
            {
                env: awsConfig.Environment.Variables,
                memory: awsConfig.MemorySize,
                timeout: awsConfig.Timeout,
                runtime: awsConfig.Runtime,
            },
            {
                env: awsFn.env,
                memory: awsFn.memory,
                timeout: awsFn.timeout,
                runtime: awsFn.runtime,
            },
        )
    ) {
        context.log.trace('updating config for lambda ' + name)
        await retryConflict(() =>
            okResponse(
                awsRequest(
                    context,
                    'PUT',
                    'lambda',
                    `/2015-03-31/functions/${prefix}-${service}-${name}/configuration`,
                    awsConfig,
                ),
                'Error updating config for lambda ' + name,
            ),
        )
    }
}

async function deleteLambda(context: Context, prefix: string, service: string, name: string) {
    context.log.trace('deleting lambda ' + name)
    await okResponse(
        awsRequest(
            context,
            'DELETE',
            'lambda',
            `/2015-03-31/functions/${prefix}-${service}-${name}`,
        ),
        'Error deleting lambda ' + name,
    )
}

function lambdaConfig(target: Target, role: string, environment: { [key: string]: string }) {
    return {
        Role: role,
        Runtime: getRuntime(target),
        Handler: 'index.handler',
        Timeout: target.config.timeout ?? 15,
        MemorySize: memorySize(target),
        TracingConfig: {
            Mode: 'PassThrough',
        },
        Environment: {
            Variables: environment,
        },
    }
}

function getRuntime({ config }: Target) {
    switch (config.nodeVersion?.slice(0, 4)) {
        case '>=24':
            return 'nodejs24.x'
        case '>=22':
            return 'nodejs22.x'
        case '>=20':
            return 'nodejs20.x'
        case '>=18':
            return 'nodejs18.x'
        default:
            throw new Error(
                'Unsupported engine; please specify "node": ">=18", "node": ">=20", "node": ">=22", or "node": ">=24" as an engine in your package.json.',
            )
    }
}

function memorySize({ config, method }: Target) {
    if (method && !config.compute && !config.memory) {
        return 256
    }
    if (config.compute === 'high' || config.memory === 'high') {
        return 3008
    }
    return 128
}

function lambdaArchitecture({ config, method }: Target) {
    switch (
        resolveCpu(
            config,
            config.compute === 'high' || (method === 'GET' && config.compute === undefined)
                ? ['x64', 'x32', 'arm64', 'arm']
                : ['arm64', 'arm', 'x64', 'x32'],
        )
    ) {
        case 'arm64':
        case 'arm':
            return ['arm64']
        case 'x64':
        case 'x32':
            return ['x86_64']
        default:
            throw new Error('Unsupported CPUs: ' + (config.cpus?.join(', ') ?? ''))
    }
}
