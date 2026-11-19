import { validateEventFilter } from '@movogo-io/host/attributes'
import { type Reflection, reflect } from '@movogo-io/host/reflect'
import { checkAccount, checkSlot, checkStage } from './lib/aws/account.js'
import { credentialsSource } from './lib/aws/credentials.js'
import { Resolver } from './lib/aws/resolve.js'
import { checkEnvironmentSize } from './lib/aws/services/lambda.js'
import { desiredLayers } from './lib/aws/services/layers.js'
import { getCurrentState, sync } from './lib/aws/sync.js'
import { getGlue, glueFilePath, stageEntrypoints } from './lib/glue.js'
import { buildDirectory, externalModules, stage } from './lib/stage.js'

export { destroy } from './lib/aws/destroy.js'

export async function deploy(
    context: {
        log: {
            trace: (message: string) => void
            warn: (message: string) => void
            error: (message: string) => void
        }
        env: { [key: string]: string | undefined }
    },
    envName: string,
    path: string,
    glueFile?: string,
    stagePath?: string,
    stageDir?: string,
    credentials = credentialsSource(envName),
) {
    await checkSlot(`deploy to ${envName}`, envName, glueFilePath(path, glueFile))
    await checkStage(context, `deploy to ${envName}`, envName, glueFilePath(path, glueFile))
    const { arn, warning: accountWarning } = await checkAccount(
        context,
        `deploy to ${envName}`,
        glueFilePath(path, glueFile),
        credentials,
        'warn',
    )
    context.log.trace(`deploying to ${envName} as ${arn}`)
    try {
        return {
            ...(await deployChecked(context, envName, path, glueFile, stagePath, stageDir)),
            accountWarning,
        }
    } catch (e) {
        // The trace stream has long scrolled the warning away, and a deploy that failed half way
        // may have written to the unchecked account.
        if (accountWarning !== undefined) {
            context.log.warn(accountWarning)
        }
        throw e
    }
}

async function deployChecked(
    context: Parameters<typeof deploy>[0],
    envName: string,
    path: string,
    glueFile: string | undefined,
    stagePath: string | undefined,
    stageDir: string | undefined,
) {
    const resolver = new Resolver(context)
    const [
        { service, implementations, publishTopics, corsSites, env, omit, newTimers, ...provider },
        reflected,
    ] = await Promise.all([getGlue(path, envName, resolver, glueFile, context.log), reflect(path)])
    const entrypoints = stageEntrypoints(
        reflected,
        { omit, newTimers },
        service,
        glueFilePath(path, glueFile),
    )
    if (entrypoints.omitted.length !== 0) {
        context.log.trace(
            `left out of ${service} on ${envName}, as omit in its glue asks: ${entrypoints.omitted.join(', ')}`,
        )
    }
    validateEventFilters(entrypoints.kept)
    const glueAws = 'aws' in provider ? provider.aws : undefined
    const layers = desiredLayers(entrypoints.functionNames, glueAws)
    const external = externalModules(entrypoints.functionNames, glueAws)
    const [currentState, code] = await Promise.all([
        getCurrentState(
            context,
            envName,
            service,
            entrypoints.ownedNames,
            resolver.accountFunctions(),
        ),
        stage(
            context.log,
            stagePath ?? (await buildDirectory(stageDir, envName, service, path)),
            path,
            entrypoints.kept.revision,
            implementations,
            service,
            entrypoints.types,
            external,
            entrypoints.omitted,
        ),
    ])

    const environment = await env
    checkEnvironmentSize(service, environment)
    return await sync(
        context,
        envName,
        service,
        currentState,
        entrypoints.kept,
        publishTopics,
        corsSites,
        environment,
        Object.fromEntries(code.map(({ fn, ...c }) => [fn, c])),
        layers,
        provider,
        entrypoints.ownedTimerNames,
        entrypoints.newTimers,
    )
}

function validateEventFilters(reflection: Reflection) {
    for (const { name, config } of reflection.events) {
        if (!config.filter) {
            continue
        }
        try {
            validateEventFilter(config.filter)
        } catch (e) {
            throw new Error(`Invalid filter on event handler ${name}.`, { cause: e })
        }
    }
}
