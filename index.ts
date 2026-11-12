import { validateEventFilter } from '@movogo-io/host/attributes'
import { type Reflection, reflect } from '@movogo-io/host/reflect'
import { Resolver } from './lib/aws/resolve.js'
import { callerArn } from './lib/aws/services/sts.js'
import { getCurrentState, sync } from './lib/aws/sync.js'
import { getGlue } from './lib/glue.js'
import { buildDirectory, stage } from './lib/stage.js'

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
) {
    context.log.trace(`deploying to ${envName} as ${await callerArn(context)}`)
    const resolver = new Resolver(context)
    const [{ service, implementations, publishTopics, corsSites, env, ...provider }, reflection] =
        await Promise.all([getGlue(path, envName, resolver, glueFile), reflect(path)])
    validateEventFilters(reflection)
    const [currentState, code] = await Promise.all([
        getCurrentState(
            context,
            envName,
            service,
            [...reflection.http, ...reflection.timers, ...reflection.events].map(fn => fn.name),
            resolver.accountFunctions(),
        ),
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
        Object.fromEntries(code.map(c => [c.fn, c.code])),
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
