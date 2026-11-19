import { createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Reflection } from '@movogo-io/host/reflect'
import { isServiceName } from './aws/destroy.js'
import { AwsError } from './aws/lite.js'

export type Resolver = {
    getEnvironment(prefix: string, service: string): Promise<{ [key: string]: string }>
    getBaseUrl(prefix: string, service: string): Promise<string | undefined>
    /**
    The parameters of those names that hold a credential: a name that is not there, an empty
    value and a parameter that is no SecureString are left out, and are missing to the caller.
    */
    getParameters(names: string[]): Promise<{ name: string; value: string; version: number }[]>
}

/**
What resolving one service's block needs of its glue file beyond the block: the file's name for
the messages, the other blocks for the one question asked of them, the stage a slot reads
parameters of, and the account the file declares.
*/
export type GlueFile = {
    file: string
    services: { [service: string]: unknown }
    slotParametersFrom: unknown
    accountId: string | undefined
    warn: (message: string) => void
}

export async function getGlue(
    path: string,
    prefix: string,
    resolver: Resolver,
    gluePath: string | undefined,
    log: { warn: (message: string) => void },
) {
    const file = glueFilePath(path, gluePath)
    const [packageJson, glueJson] = await Promise.all([
        readFile(join(path, 'package.json'), 'utf-8'),
        readGlueFile(file),
    ])
    const { name: service } = JSON.parse(packageJson) as { name: string }
    const glue = glueJson as {
        implementations: Implementations
        websites: {
            [key: string]: string[]
        }
        slotParametersFrom?: unknown
        services: {
            [key: string]: {
                implementations: Implementations
                publish?: string[]
                cors?: string
                omit?: unknown
                env: { [key: string]: unknown }
                secrets: { [key: string]: unknown }
                [provider: string]: unknown
            }
        }
    }

    const { publish, cors, env, secrets, implementations, omit, ...provider } =
        glue.services[service] ?? {}
    const omitted = omitOf(omit, service, file)
    const declared = declaredAwsOf(glueJson, file)
    // A tool up to 0.6.2 ignores omit and would deploy the entrypoints; aws.stage is a key the
    // tools from 0.6.0 on refuse, so with it in the file they stop before they deploy.
    if (omitted.length !== 0 && declared.stage === undefined) {
        throw new Error(
            `services.${service}.omit in ${file} needs aws.stage declared at the top level of the same file: a tool that does not know omit would deploy the entrypoints it names, and aws.stage is what makes 0.6.0 to 0.6.2 refuse the file. Nothing was changed.`,
        )
    }
    // Awaited here, and so before the build and any write: the block's refusals and the
    // parameters' fetch. What is left waits on the account's function listing, half a minute
    // long, and stays a promise beside the build.
    const prepared = await prepareEnv(env ?? {}, secrets ?? {}, prefix, service, resolver, {
        file,
        services: glue.services,
        slotParametersFrom: glue.slotParametersFrom,
        accountId: declared.accountId,
        warn: message => {
            log.warn(message)
        },
    })
    return {
        service,
        implementations: {
            ...glue.implementations,
            ...implementations,
        },
        publishTopics: publish ?? [],
        corsSites: cors ? (glue.websites[cors] ?? []) : [],
        env: expandEnv(prepared),
        omit: omitted,
        newTimers: declared.newTimers,
        ...provider,
    }
}

function omitOf(omit: unknown, service: string, glueFile: string) {
    if (omit === undefined) {
        return []
    }
    const names = Array.isArray(omit)
        ? omit.filter((name): name is string => typeof name === 'string' && name !== '')
        : []
    if (
        !Array.isArray(omit) ||
        names.length !== omit.length ||
        new Set(names).size !== names.length
    ) {
        throw new Error(
            `services.${service}.omit in ${glueFile} must be a list of entrypoint names, each once: an entrypoint file's name without .ts.`,
        )
    }
    return names
}

/**
The reflection without the entrypoints the service's glue block omits on this stage. A deploy
makes and removes everything from the reflection, so an omitted entrypoint the stage already has
goes as one deleted from the code does. A name that matches no entrypoint is refused: a typo
would deploy the entrypoint it was meant to leave out.
*/
export function withoutOmitted(
    reflection: Reflection,
    omit: string[],
    service: string,
    glueFile: string,
): Reflection {
    if (omit.length === 0) {
        return reflection
    }
    const names = [...reflection.http, ...reflection.timers, ...reflection.events].map(
        fn => fn.name,
    )
    const unmatched = omit.filter(name => !names.includes(name))
    if (unmatched.length !== 0) {
        throw new Error(
            `services.${service}.omit in ${glueFile} names ${unmatched.join(', ')}, which the service has no entrypoint of. Its entrypoints are ${names.join(', ')}. Nothing was changed.`,
        )
    }
    // With no function left the sync fails half way, after its first deletes.
    if (names.every(name => omit.includes(name))) {
        throw new Error(
            `services.${service}.omit in ${glueFile} names every entrypoint of the service, which leaves nothing to deploy. Nothing was changed.`,
        )
    }
    return {
        ...reflection,
        http: reflection.http.filter(fn => !omit.includes(fn.name)),
        timers: reflection.timers.filter(fn => !omit.includes(fn.name)),
        events: reflection.events.filter(fn => !omit.includes(fn.name)),
    }
}

/**
What a deploy works from, given the glue's `omit` and `newTimers` and the service as reflected:
`kept` is what is built and what the stage ends up with, `types` and `functionNames` are of the
kept alone. `ownedNames` are all entrypoints and `ownedTimerNames` all timers, the omitted too:
a function named for an entrypoint, and a rule named for a timer, is the service's own whatever
its tags, so the one a stage already has is deleted, where the kept names alone would leave it
alone untagged. A rule named for an entrypoint that is no timer is not the service's own.
*/
export function stageEntrypoints(
    reflected: Reflection,
    glue: { omit: string[]; newTimers: 'disabled' | undefined },
    service: string,
    glueFile: string,
) {
    const kept = withoutOmitted(reflected, glue.omit, service, glueFile)
    const types: { [name: string]: 'http' | 'timer' | 'event' } = Object.fromEntries([
        ...kept.http.map(fn => [fn.name, 'http'] as const),
        ...kept.timers.map(fn => [fn.name, 'timer'] as const),
        ...kept.events.map(fn => [fn.name, 'event'] as const),
    ])
    return {
        kept,
        types,
        functionNames: [...kept.http, ...kept.timers, ...kept.events].map(fn => fn.name),
        ownedNames: [...reflected.http, ...reflected.timers, ...reflected.events].map(
            fn => fn.name,
        ),
        ownedTimerNames: reflected.timers.map(fn => fn.name),
        newTimers: glue.newTimers,
        omitted: glue.omit,
    }
}

export function glueFilePath(path: string, gluePath?: string) {
    return gluePath ?? join(path, '..', 'glue', 'glue.json')
}

/**
A glue file that is missing, unreadable or no JSON. The command prints its message alone: the
path is what the reader needs, not the stack of an ENOENT.
*/
export class GlueFileError extends Error {
    name = 'GlueFileError'
}

export async function readGlueFile(glueFile: string): Promise<unknown> {
    try {
        return JSON.parse(await readFile(glueFile, 'utf-8'))
    } catch (e) {
        throw new GlueFileError(
            `Cannot read glue file ${glueFile}: ${Error.isError(e) ? e.message : String(e)}`,
            { cause: e },
        )
    }
}

/**
What the glue file says about its stage, in `aws` at the top level, once for the file:
`accountId`, as a string so that an id starting with zero survives JSON, `slots`, the slots that
account may hold, `stage` and `region`, which the file is refused outside of, and `newTimers`. A
key the tool does not know is refused: `accountID` or `account` would otherwise read as no
account declared, and the check the author asked for would silently not run.
*/
export async function declaredAws(glueFile: string) {
    return declaredAwsOf(await readGlueFile(glueFile), glueFile)
}

function declaredAwsOf(glue: unknown, glueFile: string) {
    if (glue === null || typeof glue !== 'object' || !('aws' in glue)) {
        return {
            accountId: undefined,
            slots: [],
            stage: undefined,
            region: undefined,
            newTimers: undefined,
        }
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
    return {
        accountId: accountIdOf(aws, glueFile),
        slots: slotsOf(aws, glueFile),
        stage: stageOf(aws, glueFile),
        region: regionOf(aws, glueFile),
        newTimers: newTimersOf(aws, glueFile),
    }
}

/**
Slots are named literally. A pattern would sooner or later match something else: `w1*` matches
`w10`, and any prefix rule would admit `dev`.
*/
export function isSlot(stage: string) {
    return /^w[1-9]$/u.test(stage)
}

/**
The stage whose parameters a deploy to `stage` reads: its own, or for a slot the one its glue
names. Nothing else of a slot is mapped: function names, lookups and generated values keep the
slot's own name.
*/
export function parameterStage(stage: string, from: string) {
    return isSlot(stage) ? from : stage
}

// The stage starts the name of everything a deploy makes, so an empty one, a path given in its
// place or a separator in it would name resources under no stage or under another one's prefix.
export function isStageName(stage: string) {
    return /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(stage)
}

const topLevelAwsKeys = ['accountId', 'slots', 'stage', 'region', 'newTimers']

function accountIdOf(aws: object, glueFile: string) {
    if (!('accountId' in aws)) {
        return undefined
    }
    if (typeof aws.accountId !== 'string' || !/^\d{12}$/u.test(aws.accountId)) {
        throw new Error(`aws.accountId in ${glueFile} must be a string of twelve digits.`)
    }
    return aws.accountId
}

function slotsOf(aws: object, glueFile: string) {
    if (!('slots' in aws)) {
        return []
    }
    const slots = Array.isArray(aws.slots)
        ? aws.slots.filter((slot): slot is string => typeof slot === 'string' && isSlot(slot))
        : []
    if (!Array.isArray(aws.slots) || slots.length !== aws.slots.length) {
        throw new Error(`aws.slots in ${glueFile} must be a list of slot names, w1 to w9.`)
    }
    return slots
}

// A slot is never the stage a file belongs to: it is deployed with that stage's file, which
// lists it in `slots`.
function stageOf(aws: object, glueFile: string) {
    if (!('stage' in aws)) {
        return undefined
    }
    if (typeof aws.stage !== 'string' || !isStageName(aws.stage) || isSlot(aws.stage)) {
        throw new Error(
            `aws.stage in ${glueFile} must name the stage the file belongs to, and no slot: a slot is listed in aws.slots.`,
        )
    }
    return aws.stage
}

function regionOf(aws: object, glueFile: string) {
    if (!('region' in aws)) {
        return undefined
    }
    if (typeof aws.region !== 'string' || !/^[a-z]{2}(?:-[a-z]+)+-\d$/u.test(aws.region)) {
        throw new Error(`aws.region in ${glueFile} must name an AWS region, like eu-north-1.`)
    }
    return aws.region
}

function newTimersOf(aws: object, glueFile: string) {
    if (!('newTimers' in aws)) {
        return undefined
    }
    if (aws.newTimers !== 'disabled') {
        throw new Error(`aws.newTimers in ${glueFile} must be "disabled" or left out.`)
    }
    return 'disabled' as const
}

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
            publicKeyOf(
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                env[service!]?.[key!] ??
                    variableError(
                        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                        `Private key for ${service!} not found. Has it been deployed?`,
                    ),
            ),
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

function publicKeyOf(privateKey: string) {
    return createPublicKey(
        `-----BEGIN EC PRIVATE KEY-----\n${privateKey}\n-----END EC PRIVATE KEY-----\n`,
    )
        .export({ type: 'spki', format: 'pem' })
        .toString()
        .split('\n')
        .slice(1, -2)
        .join('')
}

/**
A reference to a parameter is the whole value, `$PARAMETER()` or `$PARAMETER(<service>,<KEY>)`.
It is not one of `variables`, which are replaced wherever they occur, in a deployed value too: a
reference is recognized once, on the glue text.
*/
export const parameterReference = /^\$PARAMETER\((?:([^,()]+),([^,()]+))?\)$/u

export function referenceOf(
    value: string,
): undefined | { own: true } | { own?: undefined; service: string; key: string } {
    const match = parameterReference.exec(value)
    if (!match) {
        return undefined
    }
    const [, service, key] = match
    if (service === undefined || key === undefined) {
        return { own: true }
    }
    if (!isServiceName(service) || !isKeyName(key)) {
        return undefined
    }
    return { service, key }
}

export function isKeyName(key: string) {
    return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)
}

export function parameterName(stage: string, service: string, key: string) {
    return `/${stage}/${service}/${key}`
}

const tripwire = 'PARAMETERS'
const versionsKey = 'PARAMETER_VERSIONS'
const copy = /\$(SAME_AS|PUBLIC_KEY)\(([^,]+),([^)]+)\)/gu

type Block = 'env' | 'secrets'

type Prepared = {
    prefix: string
    service: string
    resolver: Resolver
    glue: GlueFile
    texts: { [key: string]: string }
    blocks: { [key: string]: Block }
    fetched: { [key: string]: string }
    versions: { [key: string]: number }
}

export async function resolveEnv(
    clear: { [key: string]: unknown },
    secrets: { [key: string]: unknown },
    prefix: string,
    service: string,
    resolver: Resolver,
    glue: GlueFile,
) {
    return await expandEnv(await prepareEnv(clear, secrets, prefix, service, resolver, glue))
}

/**
What is settled before a deploy builds or writes anything: the block's refusals, none of which
shows a value, and the parameters the block refers to. No value fetched here is handed to the
passes that expand variables: a credential may hold any text, a variable's among them.
*/
async function prepareEnv(
    clear: { [key: string]: unknown },
    secrets: { [key: string]: unknown },
    prefix: string,
    service: string,
    resolver: Resolver,
    glue: GlueFile,
): Promise<Prepared> {
    const entries = checkedBlock(clear, secrets, service)
    for (const { block, key, value } of entries) {
        refuseCopyOfReference(glue.services, service, block, key, value)
    }
    const from = parametersFrom(glue)
    const references = entries.flatMap(({ key, value }) => {
        const reference = referenceOf(value)
        return reference ? [{ key, reference }] : []
    })
    const [first] = references
    // The service's name is a segment of a parameter's path, as its keys are.
    if (first && !isServiceName(service)) {
        throw new Error(
            `${JSON.stringify(service)}, the name in package.json, cannot name a parameter: ${service}.secrets.${first.key} is a parameter reference.`,
        )
    }
    if (first && isSlot(prefix)) {
        refuseSlotWithoutSource(glue, from, `${service}.secrets.${first.key}`)
    }
    // Without an account the account check only warns, and the credentials would be read from
    // whichever account the profile reaches.
    if (first && glue.accountId === undefined) {
        throw new Error(
            `${service}.secrets.${first.key} is a parameter reference, and ${glue.file} declares no AWS account: ${prefix} reads its parameters only in the account its glue declares. Give it "aws": { "accountId": "…" }. Nothing was changed.`,
        )
    }
    const others = entries.filter(({ value }) => !referenceOf(value))
    for (const { block, key, value } of others) {
        const name = unknownVariable(value)
        if (name !== undefined) {
            throw new Error(`${service}.${block}.${key}: unknown variable $${name}`)
        }
    }
    const stage = parameterStage(prefix, from ?? prefix)
    const parameters = await fetchParameters(
        references.map(({ key, reference }) => ({
            key,
            name: reference.own
                ? parameterName(stage, service, key)
                : parameterName(stage, reference.service, reference.key),
        })),
        prefix,
        stage,
        resolver,
        glue.file,
    )
    return {
        prefix,
        service,
        resolver,
        glue,
        texts: Object.fromEntries(others.map(({ key, value }) => [key, value])),
        blocks: Object.fromEntries(entries.map(({ key, block }) => [key, block])),
        fetched: Object.fromEntries(parameters.map(({ key, value }) => [key, value])),
        versions: Object.fromEntries(parameters.map(({ key, version }) => [key, version])),
    }
}

// The order is the order a reader is told of what is wrong: the reserved name before a value
// that is no string, since the tripwire is the one value that is none.
function checkedBlock(
    clear: { [key: string]: unknown },
    secrets: { [key: string]: unknown },
    service: string,
) {
    if (Object.hasOwn(clear, tripwire)) {
        throw new Error(reservedTripwire(service, 'env'))
    }
    const guarded = Object.hasOwn(secrets, tripwire)
    if (guarded && secrets[tripwire] !== true) {
        throw new Error(reservedTripwire(service, 'secrets'))
    }
    const entries = [
        ...Object.entries(clear).map(([key, value]) => ({ block: 'env' as const, key, value })),
        ...Object.entries(secrets)
            .filter(([key]) => key !== tripwire)
            .map(([key, value]) => ({ block: 'secrets' as const, key, value })),
    ].map(({ block, key, value }) => {
        if (typeof value !== 'string') {
            throw new TypeError(`${service}.${block}.${key} must be a string.`)
        }
        return { block, key, value }
    })
    const holding = entries.filter(
        ({ block, value }) => block === 'secrets' && value.includes('$PARAMETER'),
    )
    if (!guarded && holding.length !== 0) {
        throw new Error(
            `${service}.secrets holds a parameter reference (${holding.map(({ key }) => key).join(', ')}) and no "PARAMETERS": true. Add it to that block: it is what stops a tool older than 0.6.2, which would deploy the reference's text as the credential. Nothing was changed.`,
        )
    }
    for (const { block, key, value } of entries) {
        if (block === 'env' && value.includes('$PARAMETER')) {
            throw new Error(
                `${service}.env.${key} holds $PARAMETER: a parameter reference is written in secrets only.`,
            )
        }
    }
    for (const { key, value } of holding) {
        const reference = referenceOf(value)
        if (!reference) {
            throw new Error(
                `${service}.secrets.${key} holds $PARAMETER and is not exactly $PARAMETER() or $PARAMETER(<service>,<KEY>). A reference is the whole value. The value is not shown.`,
            )
        }
        // The key of $PARAMETER() ends the parameter's path.
        if (reference.own && !isKeyName(key)) {
            throw new Error(
                `${service}.secrets.${key} is $PARAMETER() under a key that cannot name a parameter: letters, digits and _ only, not starting with a digit.`,
            )
        }
    }
    const stamp = entries.find(({ key }) => key === versionsKey)
    if (stamp) {
        throw new Error(
            `${service}.${stamp.block}.${versionsKey} is reserved: the tool writes that variable itself, with the versions of the parameters it read.`,
        )
    }
    return entries
}

function reservedTripwire(service: string, block: Block) {
    return `${service}.${block}.${tripwire} is reserved. It is written "PARAMETERS": true, in secrets, and nowhere else.`
}

// A copy of another service's reference would be a credential with no version stamp, which no
// check could see go stale. The other block is read for this alone, and as glue wrote it.
function refuseCopyOfReference(
    services: { [service: string]: unknown },
    service: string,
    block: Block,
    key: string,
    value: string,
) {
    for (const [, kind, other, copied] of value.matchAll(copy)) {
        if (other === undefined || copied === undefined || other === service) {
            continue
        }
        const end = referenceBehind(textsOf(services[other]), other, copied, [])
        if (!end) {
            continue
        }
        if (kind === 'PUBLIC_KEY') {
            throw new Error(
                `${service}.${block}.${key} reads ${copied} of ${other} with $PUBLIC_KEY, and ${copied} there is a parameter reference. A public key cannot be derived from a reference in another service's block: ${copied} must stay a value ${other}'s functions hold.`,
            )
        }
        throw new Error(
            `${service}.${block}.${key} copies ${copied} of ${other} with $SAME_AS, and ${copied} there is a parameter reference (or a copy of one): the copy would carry no version. Write "$PARAMETER(${end.service},${end.key})" in secrets, with "PARAMETERS": true.`,
        )
    }
}

function textsOf(block: unknown): { [key: string]: unknown } {
    if (block === null || typeof block !== 'object') {
        return {}
    }
    return {
        ...('env' in block && typeof block.env === 'object' && block.env),
        ...('secrets' in block && typeof block.secrets === 'object' && block.secrets),
    }
}

// Whatever holds $PARAMETER counts as a reference here, well-formed or not: its own deploy says
// what is wrong with it. `seen` ends a chain of copies that names itself.
function referenceBehind(
    texts: { [key: string]: unknown },
    service: string,
    key: string,
    seen: string[],
): { service: string; key: string } | undefined {
    const value = texts[key]
    if (typeof value !== 'string' || seen.includes(key)) {
        return undefined
    }
    if (value.includes('$PARAMETER')) {
        const reference = referenceOf(value)
        return reference && !reference.own
            ? { service: reference.service, key: reference.key }
            : { service, key }
    }
    for (const [, kind, other, copied] of value.matchAll(copy)) {
        if (kind !== 'SAME_AS' || other !== service || copied === undefined) {
            continue
        }
        const end = referenceBehind(texts, service, copied, [...seen, key])
        if (end) {
            return end
        }
    }
    return undefined
}

function parametersFrom({ slotParametersFrom: from, file }: GlueFile) {
    if (from === undefined) {
        return undefined
    }
    if (typeof from !== 'string' || !isStageName(from) || isSlot(from)) {
        throw new Error(
            `slotParametersFrom in ${file} must name a stage that is not a slot, not ${typeof from === 'string' ? from : JSON.stringify(from)}.`,
        )
    }
    return from
}

// Without an account the account check only warns, and a slot would read another stage's
// parameters in whichever account its credentials reach.
function refuseSlotWithoutSource(
    { file, accountId }: GlueFile,
    from: string | undefined,
    key: string,
) {
    if (from === undefined) {
        throw new Error(
            `${key} is a parameter reference, and ${file} does not say whose parameters a slot reads. Give it "slotParametersFrom": "<stage>" at the top level. Nothing was changed.`,
        )
    }
    if (accountId === undefined) {
        throw new Error(
            `${key} is a parameter reference, and ${file} declares no AWS account: a slot reads another stage's parameters only in the account its glue declares. Give it "aws": { "accountId": "…" }. Nothing was changed.`,
        )
    }
}

// Only the name is answered, never the bracket's content or the text around it: the value may
// be a secret that happens to hold a dollar sign.
function unknownVariable(value: string) {
    const rest = variables.reduce((text, { pattern }) => text.replaceAll(pattern, ' '), value)
    return /\$([A-Z_]+)(?:\(|(?![A-Za-z0-9_]))/u.exec(rest)?.[1]
}

async function fetchParameters(
    references: { key: string; name: string }[],
    prefix: string,
    stage: string,
    resolver: Resolver,
    glueFile: string,
) {
    if (references.length === 0) {
        return []
    }
    const names = [...new Set(references.map(({ name }) => name))]
    const slot = isSlot(prefix) ? prefix : undefined
    const parameters = await readParameters(names, slot, resolver)
    const absent = names.filter(name => parameters.every(parameter => parameter.name !== name))
    if (absent.length !== 0) {
        throw new Error(
            [
                ...absent.map(
                    name =>
                        `Parameter ${name} is missing. Put it: deploy secret put ${name.split('/').slice(1).join(' ')} --glue ${glueFile}`,
                ),
                ...(slot === undefined
                    ? []
                    : [
                          `(${slot} reads ${stage}'s parameters. Put it from a session with ${stage}'s own credentials, not a slot's.)`,
                      ]),
            ].join('\n'),
        )
    }
    return references.flatMap(({ key, name }) =>
        parameters
            .filter(parameter => parameter.name === name)
            .map(({ value, version }) => ({ key, value, version })),
    )
}

// A refused read is never called missing: the parameter may well be there.
async function readParameters(names: string[], slot: string | undefined, resolver: Resolver) {
    try {
        return await resolver.getParameters(names)
    } catch (e) {
        if (!(e instanceof AwsError) || e.code !== 'AccessDeniedException') {
            throw e
        }
        throw new Error(
            [
                `Not allowed to read or decrypt ${names.join(', ')}: check the deployer's policy and the stage key's Deployers.`,
                ...(slot === undefined
                    ? []
                    : [
                          `For ${slot}: the slot runner's two policies and the key's SlotReaders (RUNBOOK).`,
                      ]),
            ].join('\n'),
            { cause: e },
        )
    }
}

async function expandEnv({
    prefix,
    service,
    resolver,
    glue,
    texts,
    blocks,
    fetched,
    versions,
}: Prepared): Promise<{ [key: string]: string }> {
    // A copy of a fetched value is held out of the passes behind a placeholder no pattern
    // matches, and put in after them: a pattern that comes after $SAME_AS would otherwise
    // expand what the credential's own text happens to hold.
    const held: { kind: string; key: string }[] = []
    const marker = `\u{0}${randomBytes(8).toString('hex')}:`
    const env = Object.fromEntries(
        Object.entries(texts).map(([key, value]) => [
            key,
            value.replaceAll(copy, (text: string, kind: string, source: string, copied: string) => {
                if (source !== service || !Object.hasOwn(fetched, copied)) {
                    return text
                }
                held.push({ kind, key: copied })
                return `${marker}${held.length - 1}\u{0}`
            }),
        ]),
    )
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
    const [deployed, baseUrls] = await Promise.all([
        fetchEnvironments(prefix, referencedEnvironments, resolver),
        fetchBaseUrls(prefix, referencedBaseUrls, resolver),
    ])
    const environments = withoutOwnReferenceText(deployed, prefix, service, glue)
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

    for (const [key, value] of Object.entries(env)) {
        if (value.includes('$PARAMETER(')) {
            const other = sourceOfReferenceText(texts[key] ?? '', service, environments)
            throw new Error(
                `${service}.${blocks[key] ?? 'env'}.${key} resolved to the text of a parameter reference: the functions of ${other} hold that text in place of the value, as a tool older than 0.6.2 leaves it. Redeploy ${other} with 0.6.2 or later, then this service. Nothing was changed.`,
            )
        }
    }

    // Nothing runs over a value after this: the replacer is a function, so that `$&` or `$1`
    // in a credential means nothing.
    const heldOut = new RegExp(`${marker}(\\d+)\u{0}`, 'gu')
    const resolved = Object.fromEntries(
        Object.entries(env).map(([key, value]) => [
            key,
            value.replaceAll(heldOut, (_text: string, index: string) => {
                const copied = held[Number(index)]
                const credential = copied === undefined ? undefined : fetched[copied.key]
                if (copied === undefined || credential === undefined) {
                    return variableError(`Variable for ${service} not found.`)
                }
                return copied.kind === 'PUBLIC_KEY' ? publicKeyOf(credential) : credential
            }),
        ]),
    )
    return {
        ...resolved,
        ...fetched,
        ...(Object.keys(versions).length !== 0 && { [versionsKey]: JSON.stringify(versions) }),
    }
}

// The text of a reference in the service's own functions is what a tool older than 0.6.2 left
// there. It is ignored, not refused: this deploy is the one that repairs it.
function withoutOwnReferenceText(
    environments: { [service: string]: { [key: string]: string } },
    prefix: string,
    service: string,
    glue: GlueFile,
) {
    const deployed = environments[service]
    if (!deployed) {
        return environments
    }
    const kept = Object.entries(deployed).filter(([key, value]) => {
        if (!value.includes('$PARAMETER(')) {
            return true
        }
        glue.warn(
            `${service}: the deployed value of ${key} is the text of a parameter reference and is ignored. Run "deploy secret check ${prefix} ${service} --glue ${glue.file}"; redeploy the services that read it.`,
        )
        return false
    })
    return { ...environments, [service]: Object.fromEntries(kept) }
}

function sourceOfReferenceText(
    text: string,
    service: string,
    environments: { [service: string]: { [key: string]: string } },
) {
    const holdsText = (other: string, key?: string) =>
        Object.entries(environments[other] ?? {}).some(
            ([deployedKey, value]) =>
                (key === undefined || key === deployedKey) && value.includes('$PARAMETER('),
        )
    const direct = text
        .matchAll(copy)
        .find(
            ([, , other, key]) => other !== undefined && other !== service && holdsText(other, key),
        )?.[2]
    return (
        direct ??
        Object.keys(environments).find(other => other !== service && holdsText(other)) ??
        'another service'
    )
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
