import { type Context, awsJson } from './lite.js'
import { getApis } from './services/api-gateway.js'
import { type AwsFunction, listAccountFunctions, listFunctions } from './services/lambda.js'

export class Resolver {
    readonly #context
    readonly #endpointCache: { [prefix: string]: Promise<{ [apiName: string]: string }> }
    #accountFunctions?: Promise<AwsFunction[]>

    constructor(context: Context) {
        this.#context = context
        this.#endpointCache = {}
    }

    accountFunctions() {
        this.#accountFunctions ??= listAccountFunctions(this.#context)
        return this.#accountFunctions
    }

    async getEnvironment(prefix: string, service: string): Promise<{ [key: string]: string }> {
        // Reads env only, so the prefix listing is enough and costs no tag lookups.
        const functions = listFunctions(await this.accountFunctions(), prefix, service)
        return Object.fromEntries(functions.flatMap(fn => Object.entries(fn.env)))
    }

    async getParameters(names: string[]) {
        const chunks = Array.from({ length: Math.ceil(names.length / 10) }, (_, ix) =>
            names.slice(ix * 10, ix * 10 + 10),
        )
        const answers = await Promise.all(
            chunks.map(chunk =>
                awsJson<{
                    Parameters?: { Name: string; Type: string; Value: string; Version: number }[]
                }>(
                    this.#context,
                    'ssm',
                    'GetParameters',
                    { Names: chunk, WithDecryption: true },
                    { names: chunk },
                ),
            ),
        )
        return answers
            .flatMap(({ Parameters }) => Parameters ?? [])
            .filter(({ Type, Value }) => Type === 'SecureString' && Value !== '')
            .map(({ Name, Value, Version }) => ({ name: Name, value: Value, version: Version }))
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
