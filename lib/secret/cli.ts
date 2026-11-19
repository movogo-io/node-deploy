import { type SecretArguments } from '../arguments.js'
import { checkAccount, checkStage } from '../aws/account.js'
import { type AwsEnv, credentialsSource } from '../aws/credentials.js'
import { AwsError, localAwsEnv } from '../aws/lite.js'
import { GlueFileError, isSlot, readGlueFile } from '../glue.js'
import { init, initKey } from './keys.js'
import { check, importValue, list, put, restore, rm } from './parameters.js'
import { servicesOf } from './references.js'
import { Refusal, refusing } from './refusal.js'

export type SecretIo = {
    out: (line: string) => void
    log: {
        trace: (message: string) => void
        warn: (message: string) => void
        error: (message: string) => void
    }
    readValue: () => Promise<string>
}

/**
Runs one secret command and answers its exit code. Nothing is rethrown: the command decides its
own code, where a deploy's failure is always 1.
*/
export async function runSecret(
    args: SecretArguments,
    io: SecretIo,
    awsEnv: () => Promise<AwsEnv> = () => localAwsEnv(undefined, args.stage),
) {
    try {
        return await secret(args, io, awsEnv)
    } catch (e) {
        if (e instanceof Refusal || e instanceof AwsError) {
            io.log.error(`error: ${e.message}`)
            return e instanceof Refusal ? 1 : 3
        }
        if (e instanceof GlueFileError) {
            io.log.error(e.message)
            return 1
        }
        io.log.error(Error.isError(e) ? (e.stack ?? e.message) : String(e))
        return 3
    }
}

async function secret(args: SecretArguments, io: SecretIo, awsEnv: () => Promise<AwsEnv>) {
    if (args.key === 'PARAMETERS' && args.name !== 'init-key') {
        throw new Refusal(
            'PARAMETERS is the entry that marks a block with references, not a parameter',
        )
    }
    // checkStage passes a slot whatever aws.stage says, leaving the slot to a check of
    // aws.slots that no secret command runs.
    if (isSlot(args.stage)) {
        throw new Refusal(
            `secret ${args.name} takes no slot: ${args.stage} has no parameters and no key of its own; a deploy to it reads those of the stage its glue names. Run the command for that stage`,
        )
    }
    const context = { env: await refusing(awsEnv), log: io.log }
    await refusing(() =>
        checkStage(context, `secret ${args.name} on ${args.stage}`, args.stage, args.glueFile),
    )
    const caller = await refusing(() =>
        checkAccount(
            context,
            `secret ${args.name} on ${args.stage}`,
            args.glueFile,
            credentialsSource(args.stage),
            'refuse',
        ),
    )
    io.log.trace(`secret ${args.name} on ${args.stage} as ${caller.arn}`)
    const command = {
        context,
        io,
        caller,
        stage: args.stage,
        glueFile: args.glueFile,
        services: servicesOf(await readGlueFile(args.glueFile)),
    }
    switch (args.name) {
        case 'init':
            return await init(command, args)
        case 'init-key':
            return await initKey(command, args)
        case 'put':
            return await put(command, args)
        case 'import':
            return await importValue(command, args)
        case 'list':
            return await list(command, args)
        case 'check':
            return await check(command, args)
        case 'restore':
            return await restore(command, args)
        case 'rm':
            return await rm(command, args)
    }
}
