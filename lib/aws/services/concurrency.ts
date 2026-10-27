import { jsonResponse, okResponse } from '@riddance/fetch'
import { type Context, awsRequest, retry } from '../lite.js'

export type Concurrency = { [functionName: string]: number }

/**
Makes each function's reserved concurrency what the glue's `aws.concurrency` names, and removes
it from every other function of the service, so the glue stays the only place it is set. An
event function at its cap leaves SNS's asynchronous invocations waiting in Lambda's own queue,
retried for up to six hours, instead of throttling the account's shared pool.
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

export function checkConcurrency(functionNames: string[], desired: Concurrency) {
    const unknown = Object.keys(desired).filter(name => !functionNames.includes(name))
    if (unknown.length !== 0) {
        throw new Error(
            `aws.concurrency names ${unknown.join(', ')}, which the service has no function of.`,
        )
    }
    for (const [name, reserved] of Object.entries(desired)) {
        if (!Number.isSafeInteger(reserved) || reserved < 1) {
            throw new Error(
                `aws.concurrency of ${name} must be a positive integer, not ${String(reserved)}.`,
            )
        }
    }
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
