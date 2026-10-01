import { reflect } from '@movogo-io/host/reflect'
import { Resolver } from './lib/aws/resolve.js'
import { getCurrentState, sync } from './lib/aws/sync.js'
import { getGlue } from './lib/glue.js'
import { stage } from './lib/stage.js'

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
) {
    const resolver = new Resolver(context)
    const [{ service, implementations, publishTopics, corsSites, env, ...provider }, reflection] =
        await Promise.all([getGlue(path, envName, resolver, glueFile), reflect(path)])
    const [currentState, code] = await Promise.all([
        getCurrentState(
            context,
            envName,
            service,
            [...reflection.http, ...reflection.timers, ...reflection.events].map(fn => fn.name),
        ),
        stage(
            context.log,
            stagePath,
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
