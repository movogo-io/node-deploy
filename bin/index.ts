#!/usr/bin/env node

import { deploy, destroy } from '../index.js'
import { localAwsEnv } from '../lib/aws/lite.js'
import { parseArguments, usage } from '../lib/arguments.js'
import { GlueFileError } from '../lib/glue.js'

const log = {
    trace: (message: string) => {
        console.log(message)
    },
    warn: (message: string) => {
        console.warn(message)
    },
    error: (message: string) => {
        console.error(message)
    },
}

const args = parsed()
try {
    if (args.command === 'destroy') {
        await destroy({ env: await localAwsEnv(undefined, args.stage), log }, args.stage, {
            service: args.service,
            dryRun: args.dryRun,
            glueFile: args.glueFile,
        })
        console.log('done.')
    } else {
        await deployService(args)
    }
} catch (e) {
    if (!(e instanceof GlueFileError)) {
        throw e
    }
    console.error(e.message)
    if (args.command === 'deploy' && args.glueFile === undefined) {
        console.error(
            "Try to see if there isn't a glue project you can clone next to this project, or name the glue file last.",
        )
    }
    process.exit(1)
}

async function deployService({
    path = process.cwd(),
    stage: envName,
    glueFile,
    stageDir,
}: {
    path?: string
    stage: string
    glueFile?: string
    stageDir?: string
}) {
    const { logLink, host, accountWarning } = await deploy(
        {
            env: {
                ...(await localAwsEnv(undefined, envName)),
                DEPLOY_PERMISSIONS_BOUNDARY: process.env.DEPLOY_PERMISSIONS_BOUNDARY,
            },
            log,
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

    // Printed last: the first time it stood above everything the deploy traced.
    if (accountWarning !== undefined) {
        console.log()
        console.warn(accountWarning)
    }
}

function parsed() {
    const command = parseOrExit()
    if (command.command === 'help') {
        console.log(usage)
        process.exit(0)
    }
    return command
}

function parseOrExit() {
    try {
        return parseArguments(process.argv.slice(2))
    } catch (e) {
        console.error(Error.isError(e) ? e.message : e)
        process.exit(1)
    }
}
