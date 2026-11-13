import { get } from '@movogo-io/service/http'
import { SignatureV4 } from '@smithy/signature-v4'
import { createHash, createHmac, randomBytes } from 'node:crypto'

// Encrypts a random seed under the service key (unless a ciphertext is handed in), decrypts it
// with the same encryption context and answers the seed's hash, or the error type KMS refused
// with. A ciphertext is no secret; the seed never leaves the function.
get('seal', async (_context, request) => {
    const keyId = process.env.SEEDS_KEY_ARN
    if (!keyId) {
        return { body: { refused: 'no SEEDS_KEY_ARN' } }
    }
    const record = request.url.searchParams.get('record')
    const context = {
        service: request.url.searchParams.get('service') ?? 'param-user',
        ...(record !== null && { record }),
    }
    const seed = randomBytes(32).toString('base64')
    const sealed =
        request.url.searchParams.get('ciphertext') ??
        (await kms('Encrypt', { KeyId: keyId, Plaintext: seed, EncryptionContext: context }))
    if (typeof sealed !== 'string') {
        return { body: { step: 'encrypt', ...sealed } }
    }
    const opened = await kms('Decrypt', {
        KeyId: keyId,
        CiphertextBlob: sealed,
        EncryptionContext: context,
    })
    if (typeof opened !== 'string') {
        return { body: { step: 'decrypt', ciphertext: sealed, ...opened } }
    }
    return {
        body: {
            ciphertext: sealed,
            opened: createHash('sha256').update(opened).digest('hex'),
            same: request.url.searchParams.get('ciphertext') === null ? opened === seed : null,
        },
    }
})

async function kms(operation: 'Encrypt' | 'Decrypt', body: { [key: string]: unknown }) {
    const region = process.env.AWS_REGION ?? ''
    const hostname = `kms.${region}.amazonaws.com`
    const text = JSON.stringify(body)
    const { headers } = await new SignatureV4({
        service: 'kms',
        region,
        sha256: Hash,
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
            sessionToken: process.env.AWS_SESSION_TOKEN,
        },
    }).sign({
        method: 'POST',
        protocol: 'https:',
        hostname,
        path: '/',
        headers: {
            host: hostname,
            'content-type': 'application/x-amz-json-1.1',
            'x-amz-target': `TrentService.${operation}`,
        },
        body: text,
    })
    const response = await fetch(`https://${hostname}/`, { method: 'POST', headers, body: text })
    const answer = (await response.json()) as { [key: string]: unknown }
    if (!response.ok) {
        return { refused: String(answer.__type).split('#').at(-1) ?? 'unknown' }
    }
    const result = operation === 'Encrypt' ? answer.CiphertextBlob : answer.Plaintext
    return typeof result === 'string' ? result : { refused: 'no result' }
}

class Hash {
    readonly #secret?: string | ArrayBuffer | ArrayBufferView
    #hash: ReturnType<typeof createHash> | ReturnType<typeof createHmac>

    constructor(secret?: string | ArrayBuffer | ArrayBufferView) {
        this.#secret = secret
        this.#hash = make(secret)
    }

    update(data: string | ArrayBuffer | ArrayBufferView) {
        this.#hash.update(bytes(data))
    }

    digest() {
        return Promise.resolve(new Uint8Array(this.#hash.digest()))
    }

    reset() {
        this.#hash = make(this.#secret)
    }
}

function make(secret?: string | ArrayBuffer | ArrayBufferView) {
    return secret === undefined ? createHash('sha256') : createHmac('sha256', bytes(secret))
}

function bytes(data: string | ArrayBuffer | ArrayBufferView) {
    if (typeof data === 'string') {
        return Buffer.from(data)
    }
    if (ArrayBuffer.isView(data)) {
        return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    }
    return Buffer.from(data)
}
