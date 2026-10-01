import { type Context } from './lite.js'
import { getApis } from './services/api-gateway.js'
import { listFunctions } from './services/lambda.js'

export class Resolver {
    readonly #context
    readonly #endpointCache: { [prefix: string]: Promise<{ [apiName: string]: string }> }

    constructor(context: Context) {
        this.#context = context
        this.#endpointCache = {}
    }

    async getEnvironment(prefix: string, service: string): Promise<{ [key: string]: string }> {
        // Reads env only, so the prefix listing is enough and costs no tag lookups.
        const functions = await listFunctions(this.#context, prefix, service)
        return Object.fromEntries(functions.flatMap(fn => Object.entries(fn.env)))
    }

    async getBaseUrl(prefix: string, service: string) {
        const cached = await (this.#endpointCache[prefix] ??= getServiceApis(this.#context, prefix))
        const name = `${prefix}-${service}`
        return cached[name]
    }
}

async function getServiceApis(context: Context, prefix: string) {
    const serviceApis: { [name: string]: string } = {}
    for await (const api of getApis(context, prefix)) {
        serviceApis[api.name] = `${api.apiEndpoint}/`
    }
    return serviceApis
}
