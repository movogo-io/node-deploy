export type AwsCall = {
    method: string
    service: string
    path: string
    action?: string
    parameters: { [key: string]: unknown }
}

export const context = {
    log: {
        trace: () => {
            //
        },
        warn: () => {
            //
        },
    },
    env: {
        AWS_REGION: 'eu-north-1',
        AWS_ACCESS_KEY_ID: 'test-key-id',
        AWS_SECRET_ACCESS_KEY: 'test-secret',
    },
}

/**
Replaces the global fetch for one test, so that nothing can reach AWS: every request the code
under test signs is recorded and answered by `answer`. Restore it in a `finally`.
*/
export function stubAws(answer: (call: AwsCall) => unknown) {
    const original = fetch
    const calls: AwsCall[] = []
    // eslint-disable-next-line unicorn/no-global-object-property-assignment -- the stub is the point
    globalThis.fetch = (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input)
        const headers = new Headers(init?.headers)
        const body = typeof init?.body === 'string' ? init.body : ''
        const parameters = parametersOf(url, headers.get('content-type') ?? '', body)
        const call = {
            method: init?.method ?? 'GET',
            service: url.hostname.split('.', 1)[0] ?? '',
            path: url.pathname,
            action: headers.get('x-amz-target')?.split('.').at(-1) ?? actionOf(parameters),
            parameters,
        }
        calls.push(call)
        const answered = answer(call)
        return Promise.resolve(answered instanceof Response ? answered : Response.json(answered))
    }
    return {
        calls,
        restore: () => {
            // eslint-disable-next-line unicorn/no-global-object-property-assignment -- undoes the stub
            globalThis.fetch = original
        },
    }
}

function parametersOf(url: URL, contentType: string, body: string): { [key: string]: unknown } {
    if (!body) {
        return Object.fromEntries(url.searchParams)
    }
    if (contentType === 'application/x-www-form-urlencoded') {
        return Object.fromEntries(new URLSearchParams(body))
    }
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== 'object' || parsed === null) {
        throw new Error(`Unexpected request body ${body}`)
    }
    return { ...parsed }
}

function actionOf(parameters: { [key: string]: unknown }) {
    return typeof parameters.Action === 'string' ? parameters.Action : undefined
}

/**
A context whose trace and warning lines are kept, for a test that says what may not be in them.
*/
export function recording() {
    const lines: string[] = []
    const record = (line: string) => {
        lines.push(line)
    }
    return { lines, context: { ...context, log: { trace: record, warn: record } } }
}

export async function thrownBy(run: () => Promise<unknown>): Promise<unknown> {
    try {
        await run()
    } catch (e) {
        return e
    }
    return undefined
}
