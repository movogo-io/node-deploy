#!/usr/bin/env node
// Calls a scratch service's seal handler and prints its answer with the ciphertext replaced by
// its SHA-256, so that no ciphertext reaches the proof record.
//
//   node test/data/proofs/seal.mjs <url> [--save <file>] [--with <file>]
//
// --save keeps the ciphertext in a file for a later call; --with hands the ciphertext of such a
// file to the handler, which then only decrypts.

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

const [address, flag, file] = process.argv.slice(2)
const url = new URL(address)
if (flag === '--with') {
    url.searchParams.set('ciphertext', (await readFile(file, 'utf8')).trim())
}
const response = await fetch(url)
const { ciphertext, ...answer } = await response.json()
if (flag === '--save' && typeof ciphertext === 'string') {
    await writeFile(file, ciphertext)
}
console.log(
    JSON.stringify({
        status: response.status,
        ...answer,
        ...(typeof ciphertext === 'string' && {
            ciphertextSha256: createHash('sha256').update(ciphertext).digest('hex'),
        }),
    }),
)
