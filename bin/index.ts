#!/usr/bin/env node

import { deploy } from '../index.js'
import { localAwsEnv } from '../lib/aws/lite.js'
import { parseArguments } from '../lib/arguments.js'

const { path = process.cwd(), stage: envName, glueFile, stageDir } = parsed()

try {
    const { logLink, host } = await deploy(
        {
            env: {
                ...(await localAwsEnv(undefined, envName)),
                DEPLOY_PERMISSIONS_BOUNDARY: process.env.DEPLOY_PERMISSIONS_BOUNDARY,
            },
            log: {
                trace: (message: string) => {
                    console.log(message)
                },
                warn: (message: string) => {
                    console.warn(message)
                },
                error: (message: string) => {
                    console.error(message)
                },
            },
        },
        envName,
        path,
        glueFile,
        undefined,
        stageDir,
    )

    console.log('done.')

    if (host) {
        console.log()
        console.log(`hosting on ${host}`)
    }

    if (logLink) {
        console.log()
        console.log(`See logs here: ${logLink}`)
    }
} catch (e) {
    const fileError = e as { code?: string; path?: string }
    if (fileError.code === 'ENOENT' && fileError.path?.endsWith('glue.json')) {
        console.error(
            "Glue not found. Try to see if there isn't a glue project you can clone next to this project.",
        )
        process.exit(1)
    }
    throw e
}

function parsed() {
    try {
        return parseArguments(process.argv.slice(2))
    } catch (e) {
        console.error(Error.isError(e) ? e.message : e)
        process.exit(1)
    }
}
