import { type Context } from '../aws/lite.js'
import { type AwsFunction, listFunctions } from '../aws/services/lambda.js'
import { isServiceName } from '../aws/destroy.js'
import { isKeyName, parameterName, referenceOf } from '../glue.js'
import { type SecretIo } from './cli.js'
import { Refusal } from './refusal.js'

export type Command = {
    context: Context
    io: SecretIo
    caller: { arn: string; account: string }
    stage: string
    glueFile: string
    services: { [service: string]: unknown }
}

export function servicesOf(glue: unknown): { [service: string]: unknown } {
    if (
        glue === null ||
        typeof glue !== 'object' ||
        !('services' in glue) ||
        glue.services === null ||
        typeof glue.services !== 'object'
    ) {
        return {}
    }
    return { ...glue.services }
}

/**
Every reference the glue file holds: the service whose block it stands in, under which key, and
the parameter it names. The tripwire is no string and so no key here.
*/
export function referencesIn(services: { [service: string]: unknown }, stage: string) {
    return Object.entries(services).flatMap(([reader, block]) =>
        Object.entries(secretsOf(block)).flatMap(([key, value]) => {
            const reference = typeof value === 'string' ? referenceOf(value) : undefined
            // What a deploy refuses is no reference here either: its name would be no path.
            if (!reference || !isServiceName(reader) || (reference.own && !isKeyName(key))) {
                return []
            }
            const service = reference.own ? reader : reference.service
            const name = parameterName(stage, service, reference.own ? key : reference.key)
            return [{ reader, key, service, name }]
        }),
    )
}

function secretsOf(block: unknown): { [key: string]: unknown } {
    if (
        block === null ||
        typeof block !== 'object' ||
        !('secrets' in block) ||
        block.secrets === null ||
        typeof block.secrets !== 'object'
    ) {
        return {}
    }
    return { ...block.secrets }
}

export function readersOf({ services, stage }: Command, name: string) {
    return [
        ...new Set(
            referencesIn(services, stage)
                .filter(reference => reference.name === name)
                .map(({ reader }) => reader),
        ),
    ]
}

export function requireService({ services, glueFile }: Command, service: string) {
    if (!Object.hasOwn(services, service)) {
        throw new Refusal(`${service} is not a service in ${glueFile}`)
    }
}

/**
The functions of one service on the stage. The listing is a name-prefix match, so those of
another service of the glue file whose name starts the same (rentals-v2 beside rentals) are
taken out: their values and stamps are that service's.
*/
export function serviceFunctions(
    all: AwsFunction[],
    { stage, services }: Command,
    service: string,
) {
    const others = Object.keys(services)
        .filter(other => other.startsWith(`${service}-`))
        .map(other => `${other.slice(service.length + 1)}-`.toLowerCase())
    return listFunctions(all, stage, service)
        .filter(fn => others.every(other => !fn.name.toLowerCase().startsWith(other)))
        .map(fn => ({ name: `${stage}-${service}-${fn.name}`, env: fn.env }))
        .toSorted((a, b) => a.name.localeCompare(b.name))
}
