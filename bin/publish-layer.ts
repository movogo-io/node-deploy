#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { localAwsEnv } from '../lib/aws/lite.js'
import { publishLayer } from '../lib/aws/services/layers.js'

const [, , zipPath, name, bucket] = process.argv
if (!zipPath || !name) {
    throw new Error('Usage: publish-layer <zip> <name> [bucket for a zip over 50 MB]')
}

const arn = await publishLayer(
    {
        env: await localAwsEnv(undefined, 'default'),
        log: {
            trace: (message: string) => {
                console.error(message)
            },
            warn: (message: string) => {
                console.warn(message)
            },
        },
    },
    await readFile(zipPath),
    name,
    bucket,
)

console.log(arn)
