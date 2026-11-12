#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { parsePublishLayerArguments } from '../lib/arguments.js'
import { localAwsEnv } from '../lib/aws/lite.js'
import { publishLayerAs } from '../lib/aws/services/layers.js'

const { zipPath, name, bucket, account } = parsed()

try {
    console.log(
        await publishLayerAs(
            {
                env: await localAwsEnv(
                    undefined,
                    'default',
                    'Set AWS_PROFILE to a profile that is there, add a [default] profile, or put an access key in the environment.',
                ),
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
            account,
        ),
    )
} catch (e) {
    console.error(e)
    process.exit(1)
}

function parsed() {
    try {
        return parsePublishLayerArguments(process.argv.slice(2))
    } catch (e) {
        console.error(Error.isError(e) ? e.message : e)
        process.exit(1)
    }
}
