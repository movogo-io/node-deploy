#!/usr/bin/env node
// Runs one command of the dev proofs (PLAN-DEPLOY-0.6.2.proofs.md) and appends its command line,
// exit code and output to the proof record.
//
//   node test/data/proofs/run.mjs [--cwd <dir>] '<shell command>'
//   node test/data/proofs/run.mjs --put <label> '<shell command that reads a value on stdin>'
//   node test/data/proofs/run.mjs --learn <label> <sha256>
//   node test/data/proofs/run.mjs --note '<markdown>'
//
// --put makes a random throwaway value (64 hex characters), pipes it to the command and keeps
// only its SHA-256, in PROOF_STATE. The value is never an argument, never printed and never
// written to a file. --learn registers the SHA-256 of a value this script never held (one the
// tool generated into a function).
//
// Before any output is printed or recorded it is searched for every known value: each run of 64
// hex characters in it is hashed and compared with the known hashes. On a hit the output is
// withheld and the exit code is 99.

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFile, readFile, writeFile } from 'node:fs/promises'

const valueLength = 64
const record = process.env.PROOF_RECORD ?? missing('PROOF_RECORD')
const stateFile = process.env.PROOF_STATE ?? missing('PROOF_STATE')

const args = process.argv.slice(2)
const state = await readState()

if (args[0] === '--note') {
    await appendFile(record, `\n${args[1]}\n`)
    process.exit(0)
}
if (args[0] === '--learn') {
    state[args[1]] = args[2]
    await writeFile(stateFile, JSON.stringify(state, undefined, 2))
    process.exit(0)
}

const options = { cwd: process.cwd(), put: undefined }
while (args[0]?.startsWith('--')) {
    const flag = args.shift()
    if (flag === '--cwd') {
        options.cwd = args.shift()
    } else if (flag === '--put') {
        options.put = args.shift()
    } else {
        throw new Error(`Unknown flag ${flag}`)
    }
}
const [command] = args
if (!command || args.length !== 1) {
    throw new Error('Give the command as one argument.')
}

if (options.put !== undefined) {
    // Registered before the command runs, so that its own output is searched for it.
    const value = randomBytes(valueLength / 2).toString('hex')
    state[options.put] = sha256(value)
    await writeFile(stateFile, JSON.stringify(state, undefined, 2))
    await finish(await run(command, options.cwd, value), `(a throwaway value on stdin, sha256 ${state[options.put]})`)
} else {
    await finish(await run(command, options.cwd), '')
}

async function finish({ code, output }, remark) {
    const at = new Date().toISOString()
    const where = options.cwd === process.cwd() ? '' : ` (in ${options.cwd})`
    const head = `\n\`${at}\`${where} ${remark}\n\n\`\`\`sh\n${command}\n\`\`\`\n\n`
    if (leaks(output)) {
        const text = `${head}exit ${code}; **LEAK CHECK FAILED: the output holds a throwaway value and is withheld.**\n`
        await appendFile(record, text)
        console.log(text)
        process.exit(99)
    }
    const text = `${head}exit ${code}, leak check passed; output:\n\n\`\`\`\n${output.trimEnd()}\n\`\`\`\n`
    await appendFile(record, text)
    console.log(text)
    process.exit(0)
}

function run(command, cwd, input) {
    return new Promise((resolve, reject) => {
        const child = spawn('bash', ['-c', command], {
            cwd,
            stdio: [input === undefined ? 'inherit' : 'pipe', 'pipe', 'pipe'],
        })
        const chunks = []
        child.stdout.on('data', chunk => chunks.push(chunk))
        child.stderr.on('data', chunk => chunks.push(chunk))
        child.on('error', reject)
        child.on('close', code => {
            resolve({ code, output: Buffer.concat(chunks).toString() })
        })
        if (input !== undefined) {
            child.stdin.on('error', () => {
                // A command that refuses before it reads closes the pipe; its exit code says so.
            })
            child.stdin.end(`${input}\n`)
        }
    })
}

function leaks(output) {
    const known = new Set(Object.values(state))
    for (const [hexRun] of output.matchAll(/[0-9a-f]{64,}/giu)) {
        for (let start = 0; start + valueLength <= hexRun.length; ++start) {
            const window = hexRun.slice(start, start + valueLength)
            if (known.has(sha256(window)) || known.has(sha256(window.toLowerCase()))) {
                return true
            }
        }
    }
    return false
}

function sha256(value) {
    return createHash('sha256').update(value).digest('hex')
}

async function readState() {
    try {
        return JSON.parse(await readFile(stateFile, 'utf8'))
    } catch (e) {
        if (e.code === 'ENOENT') {
            return {}
        }
        throw e
    }
}

function missing(name) {
    throw new Error(`Set ${name}.`)
}
