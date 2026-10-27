import { jsonResponse, okResponse } from '@riddance/fetch'
import type { Reflection } from '@movogo-io/host/reflect'
import { type Context, awsRequest, retry } from '../lite.js'

export type Concurrency = { [functionName: string]: number }

/**
Makes each function's reserved concurrency what `desiredConcurrency` names, and removes it from
every other function of the service, so the handlers and the glue stay the only places it is
set. An event function at its cap leaves SNS's asynchronous invocations waiting in Lambda's own
queue, retried for up to six hours, instead of throttling the account's shared pool.
*/
export async function syncConcurrency(
    context: Context,
    prefix: string,
    service: string,
    functionNames: string[],
    desired: Concurrency,
) {
    const current: { [name: string]: number | undefined } = {}
    // One read at a time: the Lambda control plane throttles at a low shared rate.
    for (const name of functionNames) {
        current[name] = await reservedOf(context, `${prefix}-${service}-${name}`)
    }
    for (const change of concurrencyChanges(functionNames, current, desired)) {
        const path = `/2017-10-31/functions/${prefix}-${service}-${change.name}/concurrency`
        if (change.reserved === undefined) {
            context.log.trace(`removing reserved concurrency of lambda ${change.name}`)
            await okResponse(
                awsRequest(context, 'DELETE', 'lambda', path),
                'Error removing reserved concurrency of lambda ' + change.name,
            )
            continue
        }
        context.log.trace(`reserving concurrency ${change.reserved} for lambda ${change.name}`)
        await okResponse(
            awsRequest(context, 'PUT', 'lambda', path, {
                ReservedConcurrentExecutions: change.reserved,
            }),
            'Error reserving concurrency for lambda ' + change.name,
        )
    }
}

/**
What each event function's reserved concurrency should be: the glue's number where it names one,
else the handler's `concurrencyMax`. Only event functions are capped: at its cap an HTTP
function's gateway refuses requests, and a timer has nothing to queue.
*/
export function desiredConcurrency(
    reflection: Pick<Reflection, 'http' | 'events' | 'timers'>,
    glue: Concurrency,
): Concurrency {
    const neverCapped = [...reflection.http, ...reflection.timers]
    const declared = neverCapped.filter(fn => capOf(fn.config) !== undefined)
    if (declared.length !== 0) {
        throw new Error(
            `concurrencyMax is for event handlers only, not ${declared.map(fn => fn.name).join(', ')}.`,
        )
    }
    const eventNames = new Set(reflection.events.map(fn => fn.name))
    const unknown = Object.keys(glue).filter(name => !eventNames.has(name))
    if (unknown.length !== 0) {
        throw new Error(
            `aws.concurrency names ${unknown.join(', ')}, which the service has no event function of.`,
        )
    }
    for (const [name, reserved] of Object.entries(glue)) {
        if (!Number.isSafeInteger(reserved) || reserved < 1) {
            throw new Error(
                `aws.concurrency of ${name} must be a positive integer, not ${String(reserved)}.`,
            )
        }
    }
    return Object.fromEntries(
        reflection.events.flatMap(fn => {
            const reserved = glue[fn.name] ?? capOf(fn.config)
            return reserved === undefined ? [] : [[fn.name, reserved] as const]
        }),
    )
}

export function concurrencyChanges(
    functionNames: string[],
    current: { [name: string]: number | undefined },
    desired: Concurrency,
) {
    return functionNames
        .filter(name => current[name] !== desired[name])
        .map(name => ({ name, reserved: desired[name] }))
}

async function reservedOf(context: Context, functionName: string) {
    const { ReservedConcurrentExecutions } = await jsonResponse<{
        ReservedConcurrentExecutions: number | null
    }>(
        retry(
            context.log,
            () =>
                awsRequest(
                    context,
                    'GET',
                    'lambda',
                    `/2019-09-30/functions/${functionName}/concurrency`,
                ),
            r => (r.status === 429 || r.status >= 500 ? 5 : undefined),
        ),
        'Error reading reserved concurrency of lambda ' + functionName,
    )
    return ReservedConcurrentExecutions ?? undefined
}

// The host this deploy builds against predates the option, so it is read off the config as found.
function capOf(config: object) {
    if ('concurrencyMax' in config && typeof config.concurrencyMax === 'number') {
        return config.concurrencyMax
    }
    return undefined
}
