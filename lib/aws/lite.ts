import { jsonResponse, thrownHasStatus } from '@riddance/fetch'
import { SignatureV4 } from '@smithy/signature-v4'
import { createHash, createHmac } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { type AwsEnv, resolveCredentials } from './credentials.js'

export function localAwsEnv(
    region: string | undefined,
    stage: string,
    missingProfileRemedy?: string,
): Promise<AwsEnv> {
    return resolveCredentials(region, stage, undefined, missingProfileRemedy)
}

export type Context = {
    log: { trace: (message: string) => void; warn: (message: string) => void }
    env: { [key: string]: string | undefined }
}

export function awsRequest(
    context: Context,
    method: string,
    service: string,
    path: string,
    body?: unknown,
    target?: string,
    contentType?: string,
) {
    return awsStringRequest(
        context,
        method,
        service,
        path,
        body ? JSON.stringify(body) : '',
        contentType ?? 'application/json',
        target,
    )
}

export function awsFormRequest(
    context: Context,
    method: string,
    service: string,
    path: string,
    body: URLSearchParams,
) {
    return awsStringRequest(
        context,
        method,
        service,
        path,
        body.toString(),
        'application/x-www-form-urlencoded',
    )
}

export function awsBinaryRequest(
    context: Context,
    method: string,
    service: string,
    path: string,
    body: Uint8Array,
    contentType: string,
) {
    return awsStringRequest(context, method, service, path, body, contentType)
}

async function awsStringRequest(
    { env, log }: Context,
    method: string,
    service: string,
    path: string,
    body: string | Uint8Array,
    contentType: string,
    target?: string,
) {
    const region = service === 'iam' ? 'us-east-1' : (env.AWS_REGION ?? missing('AWS_REGION'))
    const signer = new SignatureV4({
        service,
        region,
        sha256: AwsHash,
        credentials: {
            accessKeyId: env.AWS_ACCESS_KEY_ID ?? missing('AWS_ACCESS_KEY_ID'),
            secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? missing('AWS_SECRET_ACCESS_KEY'),
            sessionToken: env.AWS_SESSION_TOKEN,
        },
    })
    const uri = new URL(`https://${subdomain(service, region)}.amazonaws.com${path}`)
    const query: { [key: string]: string } = {}
    uri.searchParams.forEach((value, key) => {
        query[key] = value
    })
    const { headers } = await signer.sign({
        method,
        protocol: 'https:',
        hostname: uri.hostname,
        path: uri.pathname,
        query,
        headers: {
            host: uri.hostname,
            'content-type': contentType,
            accept: 'application/json',
            ...(target && { 'X-Amz-Target': target }),
        },
        body,
    })
    for (let retries = 0; ; ++retries) {
        const response = await fetch(uri, {
            method,
            headers,
            body: body || undefined,
        })
        if (retries < throttleRetriesMax && (await isThrottled(response))) {
            await response.arrayBuffer()
            const after = response.headers.get('retry-after') ?? undefined
            log.trace(`  throttled, retrying #${retries + 1}${after ? ` (after ${after})` : ''}...`)
            await setTimeout(throttleDelayMs(retries, after, Math.random()))
            continue
        }
        return response
    }
}

const throttleRetriesMax = 8

/**
Full jitter over an exponential ceiling of 0.5 s doubling to 16 s, so the many requests of one
deploy that a throttle met spread out instead of returning together. A `Retry-After` is a floor up
to the same 16 s. One request waits 63.5 s at most, or 128 s if every throttle asks for 16 s, which
keeps its signature, made once, inside its five minutes.
*/
export function throttleDelayMs(retries: number, retryAfter: string | undefined, random: number) {
    const jittered = Math.round(random * Math.min(16_000, 500 * 2 ** retries))
    return Math.max(jittered, Math.min(16_000, retryAfterMs(retryAfter)))
}

function retryAfterMs(value: string | undefined) {
    if (!value) {
        return 0
    }
    const seconds = Number(value)
    if (Number.isFinite(seconds)) {
        return seconds * 1000
    }
    const time = new Date(value).getTime()
    if (Number.isFinite(time)) {
        return Math.max(0, time - Date.now())
    }
    return 0
}

/**
Lambda throttles with a 429; IAM, EventBridge and DynamoDB with a 400 told apart from a real
client error only by the error code in the body, as JSON (`__type`, `Error.Code`) or as XML.
*/
export async function isThrottled(response: Response) {
    if (response.status === 429) {
        return true
    }
    if (response.status !== 400) {
        return false
    }
    return throttlingErrors.has(errorCode(await response.clone().text()) ?? '')
}

const throttlingErrors = new Set([
    'Throttling',
    'ThrottlingException',
    'TooManyRequestsException',
    'RequestLimitExceeded',
    'ProvisionedThroughputExceededException',
])

function errorCode(body: string) {
    const xmlCode = /<Code>([^<]*)<\/Code>/u.exec(body)?.[1]
    if (xmlCode !== undefined) {
        return xmlCode
    }
    try {
        return jsonErrorCode(JSON.parse(body))
    } catch {
        return undefined
    }
}

function jsonErrorCode(body: unknown) {
    if (typeof body !== 'object' || body === null) {
        return undefined
    }
    if ('__type' in body && typeof body.__type === 'string') {
        return body.__type.split('#').at(-1)
    }
    if (
        'Error' in body &&
        typeof body.Error === 'object' &&
        body.Error !== null &&
        'Code' in body.Error &&
        typeof body.Error.Code === 'string'
    ) {
        return body.Error.Code
    }
    return undefined
}

/**
A failed call of the parameter store or of KMS. It names the operation, AWS's error code and the
parameters or keys the call was about, and nothing else: a request or a response body can hold a
secret value, and AWS's message can quote one, so none of the three is attached, logged or kept.
*/
export class AwsError extends Error {
    name = 'AwsError'
    readonly service: string
    readonly operation: string
    readonly code: string
    readonly names: string[]

    constructor({
        service,
        operation,
        code,
        names,
    }: {
        service: string
        operation: string
        code: string
        names: string[]
    }) {
        super(
            `${service} ${operation} failed: ${code}${names.length === 0 ? '' : ` (${names.join(', ')})`}`,
        )
        this.service = service
        this.operation = operation
        this.code = code
        this.names = names
    }
}

const jsonTargets = { ssm: 'AmazonSSM', kms: 'TrentService' }

const retryAttemptsMax = 5
const retryDelayMs = 500

/**
The JSON protocol of SSM and KMS. A throttle is ridden out by awsRequest beneath, so it is not
retried here again: stacked, the two loops would multiply. `names` are what an error may say the
call was about, never a value.
*/

export async function awsJson<T>(
    context: Context,
    service: keyof typeof jsonTargets,
    operation: string,
    body: { [key: string]: unknown },
    { names, delayMs = retryDelayMs }: { names: string[]; delayMs?: number },
): Promise<T> {
    for (let retries = 0; ; ++retries) {
        const response = await awsRequest(
            context,
            'POST',
            service,
            '/',
            body,
            `${jsonTargets[service]}.${operation}`,
            'application/x-amz-json-1.1',
        )
        const text = await response.text()
        if (response.ok) {
            return parsedAnswer<T>(text, { service, operation, names })
        }
        const code = errorCode(text) ?? `HTTP ${response.status}`
        if (
            // A put that failed may have succeeded: retried, it would answer that the name
            // exists, or make a second version.
            operation !== 'PutParameter' &&
            retries < retryAttemptsMax &&
            (response.status >= 500 || code.endsWith('TooManyUpdates'))
        ) {
            context.log.trace(`retrying #${retries + 1} (${code})`)
            await setTimeout(delayMs * 2 ** retries + Math.round(Math.random() * delayMs))
            continue
        }
        throw new AwsError({ service, operation, code, names })
    }
}

// A SyntaxError quotes the start of what it could not parse, which here may be a value.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function parsedAnswer<T>(
    text: string,
    call: { service: string; operation: string; names: string[] },
): T {
    try {
        return (text ? JSON.parse(text) : {}) as T
    } catch (e) {
        if (e instanceof SyntaxError) {
            throw new AwsError({ ...call, code: 'UnreadableAnswer' })
        }
        throw e
    }
}

/**
For a request whose body carries a function's environment, credentials among it: Lambda can quote
the request in the error it answers, so a failure keeps the status and the error's type and
nothing of the body, in the trace and in what is thrown. The status is where retryConflict and
its like look for it.
*/
export async function withoutBody(
    log: Context['log'],
    request: () => Promise<Response>,
    message: string,
    retriesMax: (status: number) => number = () => 0,
) {
    for (let retries = 0; ; ++retries) {
        const response = await request()
        if (response.ok) {
            return response
        }
        const type =
            response.headers.get('x-amzn-errortype')?.split(':', 1)[0] ??
            errorCode(await response.text())
        if (retries < retriesMax(response.status)) {
            log.trace(`  retrying #${retries + 1}... (${response.status} ${type ?? 'no type'})`)
            await setTimeout(500)
            continue
        }
        throw Object.assign(new Error(message), { response: { status: response.status, type } })
    }
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export async function* pages<T, S>(
    context: Context,
    service: string,
    path: string,
    itemMap: (items: T[]) => S[],
    errorMessage: string,
) {
    for (let next = ''; ;) {
        const page = await jsonResponse<{ items: T[]; nextToken?: string }>(
            awsRequest(context, 'GET', service, path + next),
            errorMessage,
        )
        for (const item of itemMap(page.items)) {
            yield item
        }
        if (!page.nextToken) {
            break
        }
        next = `?nextToken=${encodeURIComponent(page.nextToken)}`
    }
}

function subdomain(service: string, region: string) {
    switch (service) {
        case 'iam':
            return 'iam'
        default:
            return `${service}.${region}`
    }
}

export async function retry<T extends { url: string; text: () => Promise<string> }>(
    log: Context['log'],
    request: () => Promise<T>,
    when: (response: T) => number | undefined | Promise<number | undefined>,
    delayMs = (_retries: number) => 500,
) {
    for (let retries = 0; ; ++retries) {
        const response = await request()
        const maxRetries = await when(response)
        if (maxRetries === undefined || maxRetries <= retries) {
            return response
        }
        log.trace(`  retrying #${retries + 1}... (${response.url} -> ${await response.text()})`)
        await setTimeout(delayMs(retries))
    }
}

export function isNotFound(e: unknown) {
    return thrownHasStatus(e, 404)
}

export function isConflict(e: unknown) {
    return thrownHasStatus(e, 409)
}

export async function retryConflict<T>(fn: () => Promise<T>): Promise<T> {
    const deadline = new Date()
    deadline.setUTCSeconds(deadline.getUTCSeconds() + 90)
    for (;;) {
        try {
            return await fn()
        } catch (e) {
            if (!isConflict(e) || new Date() > deadline) {
                throw e
            }
            await setTimeout((Math.random() + 0.5) * 1000)
        }
    }
}

type SourceData = string | ArrayBuffer | ArrayBufferView

class AwsHash {
    readonly #secret?: SourceData
    #hash: ReturnType<typeof createHash> | ReturnType<typeof createHmac>

    constructor(secret?: SourceData) {
        this.#secret = secret
        this.#hash = makeHash(this.#secret)
    }

    digest() {
        return Promise.resolve(this.#hash.digest())
    }

    reset() {
        this.#hash = makeHash(this.#secret)
    }

    update(chunk: Uint8Array) {
        this.#hash.update(new Uint8Array(Buffer.from(chunk)))
    }
}

function makeHash(secret?: SourceData) {
    return secret ? createHmac('sha256', castSourceData(secret)) : createHash('sha256')
}

function castSourceData(data: SourceData) {
    if (Buffer.isBuffer(data)) {
        return data
    }
    if (typeof data === 'string') {
        return Buffer.from(data)
    }
    if (ArrayBuffer.isView(data)) {
        return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    }
    return Buffer.from(data)
}

function missing(what?: string): never {
    throw new Error(what ? `Missing ${what}.` : 'Missing.')
}
