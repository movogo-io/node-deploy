import { validateEventFilter } from '@movogo-io/host/attributes'
import { type Reflection, reflect } from '@movogo-io/host/reflect'
import { checkAccount } from './lib/aws/account.js'
import { credentialsSource } from './lib/aws/credentials.js'
import { Resolver } from './lib/aws/resolve.js'
import { desiredLayers } from './lib/aws/services/layers.js'
import { getCurrentState, sync } from './lib/aws/sync.js'
import { getGlue, glueFilePath } from './lib/glue.js'
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
    const caller = await checkAccount(
        context,
        `deploy to ${envName}`,
        glueFilePath(path, glueFile),
        credentials,
        'warn',
    )
    context.log.trace(`deploying to ${envName} as ${caller.arn}`)
    const resolver = new Resolver(context)
    const [{ service, implementations, publishTopics, corsSites, env, ...provider }, reflection] =
        await Promise.all([getGlue(path, envName, resolver, glueFile), reflect(path)])
    validateEventFilters(reflection)
    const functionNames = [...reflection.http, ...reflection.timers, ...reflection.events].map(
        fn => fn.name,
    )
    const glueAws = 'aws' in provider ? provider.aws : undefined
    const layers = desiredLayers(functionNames, glueAws)
    const external = externalModules(functionNames, glueAws)
    const [currentState, code] = await Promise.all([
        getCurrentState(context, envName, service, functionNames, resolver.accountFunctions()),
        stage(
            context.log,
            stagePath ?? (await buildDirectory(stageDir, envName, service, path)),
            path,
            reflection.revision,
            implementations,
            service,
            Object.fromEntries([
                ...reflection.http.map(fn => [fn.name, 'http'] as const),
                ...reflection.timers.map(fn => [fn.name, 'timer'] as const),
                ...reflection.events.map(fn => [fn.name, 'event'] as const),
            ]),
            external,
        ),
    ])

    return await sync(
        context,
        envName,
        service,
        currentState,
        reflection,
        publishTopics,
        corsSites,
        await env,
        Object.fromEntries(code.map(({ fn, ...c }) => [fn, c])),
        layers,
        provider,
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
