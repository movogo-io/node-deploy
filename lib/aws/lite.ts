import { jsonResponse, thrownHasStatus } from '@riddance/fetch'
import { SignatureV4 } from '@smithy/signature-v4'
import { createHash, createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'

let cachedConfigLines: string[] | undefined

export async function localAwsEnv(
    region: string | undefined,
    profile: string,
): Promise<{
    AWS_REGION: string
    AWS_ACCESS_KEY_ID: string
    AWS_SECRET_ACCESS_KEY: string
    AWS_SESSION_TOKEN?: string
}> {
    let { AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN } = {
        AWS_REGION: region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
        AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
        AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
    }
    if (AWS_REGION && AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY) {
        return { AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN }
    }
    const configLines =
        cachedConfigLines ??
        (
            await readFile(
                process.env.AWS_SHARED_CREDENTIALS_FILE ?? join(homedir(), '.aws', 'credentials'),
                'ascii',
            )
        )
            .split('\n')
            .map(line => line.trim())
            .filter(line => !!line && !line.startsWith('#'))
    // eslint-disable-next-line require-atomic-updates, unicorn/no-top-level-assignment-in-function
    cachedConfigLines = configLines

    let sectionBeginIx = -1
    const section = `[${profile}]`
    sectionBeginIx = configLines.indexOf(section)
    if (sectionBeginIx === -1) {
        sectionBeginIx = configLines.indexOf('[default]')
    }
    if (sectionBeginIx === -1) {
        throw new Error('Section not found.')
    }
    const sectionEndIx = configLines.findIndex(
        (line, ix) => ix > sectionBeginIx && line.startsWith('['),
    )
    const sectionLines = configLines
        .slice(sectionBeginIx + 1, sectionEndIx === -1 ? undefined : sectionEndIx)
        .map(line => line.split('='))
        .map(([k, v]) => [k?.trim(), v?.trim()])
    AWS_REGION ??= sectionLines.find(([k]) => k === 'region')?.[1]
    AWS_ACCESS_KEY_ID = sectionLines.find(([k]) => k === 'aws_access_key_id')?.[1]
    AWS_SECRET_ACCESS_KEY = sectionLines.find(([k]) => k === 'aws_secret_access_key')?.[1]
    AWS_SESSION_TOKEN = sectionLines.find(([k]) => k === 'aws_session_token')?.[1]
    if (!AWS_REGION || !AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
        throw new Error('Incomplete AWS credentials file.')
    }
    return { AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN }
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

async function awsStringRequest(
    { env, log }: Context,
    method: string,
    service: string,
    path: string,
    body: string,
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
        if (response.status === 429 && retries < 5) {
            await response.arrayBuffer()
            const after = response.headers.get('retry-after')
            log.trace(`  retrying #${retries + 1}${after ? ` (after ${after})` : ''}...`)
            await setTimeout(retryDelay(after))
            continue
        }
        return response
    }
}

function retryDelay(value: string | null, def = 1000, jitter = 1000) {
    const extra = Math.round(jitter * Math.random())
    if (!value) {
        return def + extra
    }
    const seconds = Number(value)
    if (Number.isFinite(seconds)) {
        return seconds * 1000 + extra
    }
    const time = new Date(value).getTime()
    if (Number.isFinite(time)) {
        return Math.max(0, time - Date.now()) + extra
    }
    return def + extra
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
    when: (response: T) => number | undefined,
) {
    for (let retries = 0; ; ++retries) {
        const response = await request()
        const maxRetries = when(response)
        if (maxRetries === undefined || maxRetries <= retries) {
            return response
        }
        log.trace(`  retrying #${retries + 1}... (${response.url} -> ${await response.text()})`)
        await setTimeout(500)
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
    deadline.setUTCSeconds(deadline.getUTCSeconds() + 30)
    for (;;) {
        try {
            return await fn()
        } catch (e) {
            if (!isConflict(e) || new Date() > deadline) {
                throw e
            }
            await setTimeout(((Math.random() + 0.5) * 500) / 2)
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
