import commonjs from '@rollup/plugin-commonjs'
import json from '@rollup/plugin-json'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import virtual from '@rollup/plugin-virtual'
import { rollup, RollupCache, SourceMap, type Plugin } from '@rollup/wasm-node'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import zlib from 'node:zlib'
// eslint-disable-next-line camelcase
import { minify_sync } from 'terser'
import { functionLists } from './glue.js'
import { install } from './npm.js'

type Implementation = {
    implementation: string
    version: string
}

const aws = {
    entry: (
        type: string,
        service: string,
        fn: string,
        revision: string | undefined,
        config: unknown,
        hostPackage: string,
    ) => `
import { awsHandler } from '${hostPackage}/${type}'
import * as host from '${hostPackage}/${type}'
if('setMeta' in host) {
    host.setMeta(${[
        `'${service.replaceAll("'", "\\'")}'`,
        `'${fn}'`,
        revision ? `'${revision}'` : undefined,
        JSON.stringify(config),
    ].join(',')})
}

import('./${fn}.js')

export const handler = awsHandler
`,
    patch: (code: string) => `/*global fetch AbortController*/${code}`,
}

/**
Where a service is built. The stage is part of the default so that one service deployed to two
stages at once does not build in one directory. A root from the command line is the caller's to
share or not: it replaces the stage level too, since a bundle does not depend on the stage.
*/
export async function buildDirectory(
    root: string | undefined,
    stageName: string,
    service: string,
    path: string,
) {
    if (root === undefined) {
        const base = join(tmpdir(), 'riddance', 'stage')
        return inside(base, join(base, stageName, service), `stage ${stageName}`)
    }
    if (!root) {
        throw new Error('--stage-dir needs a directory.')
    }
    const base = resolvePath(root)
    if (base === resolvePath('/') || base === resolvePath(homedir())) {
        throw new Error(`--stage-dir ${root} is not a directory to build in.`)
    }
    if (isWithin(base, resolvePath(path)) || isWithin(resolvePath(path), base)) {
        throw new Error(`--stage-dir ${root} overlaps the project being deployed.`)
    }
    if (!(await isDirectoryOrAbsent(base))) {
        throw new Error(`--stage-dir ${root} exists and is not a directory.`)
    }
    return inside(base, join(base, service), `service ${service}`)
}

function inside(base: string, directory: string, what: string) {
    if (directory === base || !isWithin(base, directory)) {
        throw new Error(`The name of ${what} would put its build outside ${base}.`)
    }
    return directory
}

function isWithin(base: string, directory: string) {
    const fromBase = relative(base, directory)
    return fromBase !== '..' && !fromBase.startsWith(`..${sep}`) && !isAbsolute(fromBase)
}

async function isDirectoryOrAbsent(directory: string) {
    try {
        return (await stat(directory)).isDirectory()
    } catch (e) {
        if (typeof e === 'object' && e !== null && 'code' in e && e.code === 'ENOENT') {
            return true
        }
        throw e
    }
}

export async function stage(
    log: {
        trace: (message: string) => void
        warn: (message: string) => void
        error: (message: string) => void
    },
    stagePath: string,
    path: string,
    revision: string | undefined,
    implementations: { [fromPackage: string]: Implementation },
    service: string,
    types: { [name: string]: 'http' | 'timer' | 'event' },
    external: External,
) {
    log.trace(`stage dir: ${stagePath}`)
    // The Lambda entry imports the host from whatever the glue substitutes for the service
    // package; every glue block is keyed `@riddance/service` until the fleet is repointed.
    const hostPackage =
        implementations['@movogo-io/service']?.implementation ??
        implementations['@riddance/service']?.implementation
    if (!hostPackage) {
        throw new Error(
            'No implementation for @movogo-io/service (or @riddance/service) in the glue; the Lambda entry needs the host package.',
        )
    }
    log.trace('staging...')
    const { functions, hashes, config, dependencies } = await copyAndPatchProject(
        log,
        path,
        stagePath,
        implementations,
    )

    log.trace('syncing dependencies...')
    await install(stagePath)
    const lockFile = await readFile(join(stagePath, 'package-lock.json'))
    hashes['package-lock.json'] = createHash('sha256').update(lockFile).digest('base64')
    for (const [fn, modules] of Object.entries(external)) {
        if (modules.length !== 0) {
            // A function staged with other externals is bundled again.
            hashes[fn + '.js'] = `${hashes[fn + '.js'] ?? ''} external ${modules.join(' ')}`
        }
    }
    assertSingleHost(
        JSON.parse(lockFile.toString('utf-8')),
        implementations,
        hostPackage,
        dependencies,
    )

    let previous: { [source: string]: string } = {}
    try {
        previous = JSON.parse(await readFile(join(stagePath, '.hashes.json'), 'utf-8')) as {
            [source: string]: string
        }
    } catch (e) {
        if ((e as { code?: string }).code !== 'ENOENT') {
            throw e
        }
    }

    const packageChange =
        previous['package.json'] !== hashes['package.json'] ||
        previous['package-lock.json'] !== hashes['package-lock.json']

    const hashesJson = JSON.stringify(hashes, undefined, '  ')
    const changed = []
    const unchanged = []
    for (const fn of functions) {
        const file = fn + '.js'
        if (packageChange || previous[file] !== hashes[file]) {
            changed.push(fn)
        } else {
            unchanged.push(fn)
        }
        delete previous[file]
        delete hashes[file]
    }
    const nonFunctionFilesUnchanged = isDeepStrictEqual(previous, hashes)
    // Bundles are written one by one; a run failing half way must not leave hashes that vouch
    // for them, or a later run zips an ES module bundle as CommonJS.
    await rm(join(stagePath, '.hashes.json'), { force: true })
    if (nonFunctionFilesUnchanged) {
        const code = [
            ...(await rollupAndMinify(
                log,
                aws,
                hostPackage,
                path,
                stagePath,
                service,
                revision,
                config,
                changed,
                types,
                external,
            )),
            ...(await Promise.all(
                unchanged.map(async fn => ({
                    fn,
                    fileName: handlerFileName(external[fn] ?? []),
                    code: await readFile(join(stagePath, fn + '.min.js'), 'utf-8'),
                })),
            )),
        ]
        await writeFile(join(stagePath, '.hashes.json'), hashesJson)
        return code
    }
    const code = await rollupAndMinify(
        log,
        aws,
        hostPackage,
        path,
        stagePath,
        service,
        revision,
        config,
        functions,
        types,
        external,
    )
    await writeFile(join(stagePath, '.hashes.json'), hashesJson)
    return code
}

type External = { [functionName: string]: string[] }

/**
A function leaving modules out of its bundle is bundled as an ES module: Lambda's Node.js runtime
cannot `require` an ES module (it runs with `--no-experimental-require-module`), while an ES module
imports CommonJS and ES modules alike, from a layer's `/opt/nodejs/node_modules` too.
*/
function handlerFileName(modules: string[]) {
    return modules.length === 0 ? 'index.js' : 'index.mjs'
}

// What bundled CommonJS code expects to find, for an ES module bundle. Globals rather than
// bindings, so a bundled module declaring its own `require` shadows them instead of clashing.
const commonJsGlobals = [
    "import{createRequire as riddanceCreateRequire}from'node:module'",
    'globalThis.require??=riddanceCreateRequire(import.meta.url)',
    'globalThis.__filename??=new URL(import.meta.url).pathname',
    "globalThis.__dirname??=new URL('.',import.meta.url).pathname",
].join(';')

const packageNamePattern = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/iu

/**
The modules each function leaves out of its bundle, from the glue's `aws.external`, keyed by
function name: a layer (or the runtime) provides them, and the bundle imports them at run
time. A module's subpaths are left out with it.
*/
export function externalModules(functionNames: string[], glueAws: unknown): External {
    const external = functionLists(functionNames, glueAws, 'external', 'package names')
    for (const [name, modules] of Object.entries(external)) {
        if (modules.some(m => !packageNamePattern.test(m))) {
            throw new Error(`aws.external of ${name} must be a list of package names.`)
        }
        if (new Set(modules).size !== modules.length) {
            throw new Error(`aws.external of ${name} names a package twice.`)
        }
    }
    return external
}

const hostPathPattern = /(^|\/)node_modules\/@(riddance|movogo-io)\/host$/u
const servicePackagePattern = /^@(riddance|movogo-io)\/service$/u

// A service on @movogo-io/service whose peers still pull @riddance/host stages two hosts;
// the entry then registers its handlers in one and the Lambda is invoked through the other,
// so nothing is found. Nested copies count: npm puts one under a dependency whose peer range
// the hoisted host does not satisfy. And the host the entry imports must be the one the
// staged install contains, which it is not when the glue block is keyed by the service
// package the service no longer depends on. Everything resolves from the staged lockfile and
// package.json, so refuse there, before bundling fails on an unresolved import.
function assertSingleHost(
    lock: unknown,
    implementations: { [fromPackage: string]: Implementation },
    hostPackage: string,
    dependencies: { [packageName: string]: string },
) {
    const packages = (lock as { packages?: { [path: string]: unknown } }).packages ?? {}
    const hosts = Object.keys(packages).filter(path => hostPathPattern.test(path))
    if (hosts.length === 0) {
        throw new Error(
            'No host in the staged lockfile (neither @riddance/host nor @movogo-io/host).',
        )
    }
    const glue = Object.entries(implementations)
        .map(([pkg, sub]) => `${pkg} -> ${sub.implementation} ${sub.version}`)
        .join(', ')
    if (hosts.length !== 1) {
        throw new Error(
            `More than one host in the staged lockfile: ${hosts.join(', ')}. Pin @movogo-io/service and repoint every peer that still names @riddance/service or @riddance/host, so one host instance registers the handlers; glue implementations: ${glue}`,
        )
    }
    if (!Object.hasOwn(packages, `node_modules/${hostPackage}`)) {
        const servicePackages = Object.entries(dependencies)
            .filter(([name]) => servicePackagePattern.test(name))
            .map(([name, version]) => `${name} ${version}`)
            .join(', ')
        throw new Error(
            `The Lambda entry imports ${hostPackage}, which the staged install does not contain: the service depends on ${servicePackages || 'no service package'} while the glue implementations are keyed ${glue}, so the glue block must be keyed by the service package the service depends on.`,
        )
    }
}

async function copyAndPatchProject(
    log: { trace: (message: string) => void },
    path: string,
    target: string,
    implementations: { [fromPackage: string]: Implementation },
) {
    const hashes: { [source: string]: string } = {}
    const sourceFiles = (await find(path)).map(f => f.slice(path.length + 1))
    const serviceFiles = sourceFiles.filter(f => f.endsWith('.js') && !f.includes('/'))

    for (const sf of sourceFiles) {
        hashes[sf] = await mkDirCopyFile(join(path, sf), join(target, sf), implementations)
    }

    const packageFile = join(target, 'package.json')
    const packageJson = JSON.parse(await readFile(packageFile, 'utf-8')) as {
        name: string
        config?: unknown
        dependencies: { [packageName: string]: string }
        devDependencies?: unknown
    }
    // As the service declares them, before the glue substitutes the host for the service package.
    const dependencies = { ...packageJson.dependencies }

    const substitutions = []
    for (const [pkg, sub] of Object.entries(implementations)) {
        if (!Object.hasOwn(packageJson.dependencies, pkg)) {
            continue
        }

        delete packageJson.dependencies[pkg]
        packageJson.dependencies[sub.implementation] = sub.version
        substitutions.push(`  ${pkg} -> ${sub.implementation} ${sub.version}`)
    }
    delete packageJson.devDependencies
    if (substitutions.length !== 0) {
        log.trace('substituting')
        for (const s of substitutions) {
            log.trace(s)
        }
    }

    const updated = JSON.stringify(packageJson)
    hashes['package.json'] = createHash('sha256').update(updated).digest('base64')
    await writeFile(packageFile, updated)

    return {
        functions: serviceFiles.map(f => f.slice(0, -3)),
        hashes,
        config: packageJson.config,
        dependencies,
    }
}

async function mkDirCopyFile(
    source: string,
    target: string,
    implementations: { [fromPackage: string]: Implementation },
) {
    let code = await readFile(source, 'utf-8')
    for (const [fromPackage, toPackage] of Object.entries(implementations)) {
        code = code.replaceAll(
            new RegExp(
                `import \\{ ([^}]+) \\} from '${RegExp.escape(fromPackage)}(|/[^']+)';`,
                'gu',
            ),
            (_, i: string, p: string) => `import { ${i} } from '${toPackage.implementation}${p}';`,
        )
    }
    try {
        await writeFile(target, code)
    } catch {
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, code)
    }
    return createHash('sha256').update(code).digest('base64')
}

async function find(dir: string): Promise<string[]> {
    let results: string[] = []
    let i = 0
    for (;;) {
        const list = (await readdir(dir)).filter(
            f =>
                !f.startsWith('.') &&
                !f.endsWith('.ts') &&
                !f.endsWith('.gz') &&
                !f.endsWith('.min.js') &&
                f !== 'tsconfig.json' &&
                f !== 'cspell.json' &&
                f !== 'eslint.config.mjs' &&
                f !== 'dictionary.txt' &&
                f !== 'node_modules' &&
                f !== 'test' &&
                f !== 'bin',
        )
        let file = list[i++]
        if (!file) {
            return results
        }
        file = dir + '/' + file
        const stats = await stat(file)
        if (stats.isDirectory()) {
            results = [...results, ...(await find(file))]
        } else {
            results.push(file)
        }
    }
}

type Host = {
    entry: (
        type: string,
        service: string,
        name: string,
        revision: string | undefined,
        config: unknown,
        hostPackage: string,
    ) => string
    patch?: (bundled: string) => string
}

async function rollupAndMinify(
    log: {
        trace: (message: string) => void
        warn: (message: string) => void
        error: (message: string) => void
    },
    host: Host,
    hostPackage: string,
    _path: string,
    stagePath: string,
    service: string,
    revision: string | undefined,
    config: unknown,
    functions: string[],
    types: { [name: string]: 'http' | 'timer' | 'event' },
    external: External,
) {
    const minified = []
    // A cached module keeps how its imports were resolved, external or bundled, so functions
    // leaving different modules out of their bundles must not share a cache.
    const rollupCaches = new Map<string, RollupCache | undefined>()
    for (const fn of functions) {
        const modules = external[fn] ?? []
        const cacheKey = modules.join(' ')
        const functionType = types[fn]
        if (!functionType) {
            throw new Error(`Type of function ${fn} not determined.`)
        }
        let seriousWarnings = false
        const bundler = await rollup({
            input: 'entry',
            cache: rollupCaches.get(cacheKey),
            external: id => modules.some(m => id === m || id.startsWith(m + '/')),
            treeshake: {
                correctVarValueBeforeDeclaration: false,
                propertyReadSideEffects: false,
                unknownGlobalSideEffects: false,
                moduleSideEffects: true,
            },
            plugins: [
                (virtual as unknown as (options: unknown) => Plugin)({
                    entry: host.entry(functionType, service, fn, revision, config, hostPackage),
                }),
                nodeResolve({
                    exportConditions: ['node'],
                    rootDir: stagePath,
                }),
                (commonjs as unknown as () => Plugin)(),
                (json as unknown as () => Plugin)(),
            ],
            onwarn: warning => {
                if (warning.code === 'THIS_IS_UNDEFINED') {
                    return
                }
                if (
                    warning.code === 'MISSING_EXPORT' &&
                    warning.id === '\u{0}virtual:entry' &&
                    warning.binding === 'setMeta'
                ) {
                    return
                }
                log.warn(`${warning.code ?? warning.message} [${fn}]`)
                if (
                    warning.code === 'CIRCULAR_DEPENDENCY' &&
                    warning.ids &&
                    warning.ids.length !== 0
                ) {
                    log.warn(warning.ids.map(p => relative(stagePath, p)).join(' -> '))
                } else {
                    if (warning.code) {
                        log.warn(warning.message)
                    }
                    if (warning.frame) {
                        log.warn(warning.frame)
                    }
                }
                if (warning.code === 'UNRESOLVED_IMPORT') {
                    seriousWarnings = true
                }
            },
        })
        rollupCaches.set(cacheKey, bundler.cache)
        const {
            output: [{ code, map }, virtualEntry, more],
        } = await bundler.generate({
            format: modules.length === 0 ? 'cjs' : 'es',
            banner: modules.length === 0 ? undefined : commonJsGlobals,
            compact: true,
            sourcemap: true,
            manualChunks: () => 'entry.js',
            generatedCode: {
                preset: 'es2015',
                arrowFunctions: true,
                constBindings: true,
                objectShorthand: true,
            },
        })
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (seriousWarnings) {
            throw new Error('Suspicious bundler warnings.')
        }
        const { type, fileName } = virtualEntry ?? {}
        if (type !== 'asset' || fileName !== '_virtual_entry.js.map') {
            log.error(JSON.stringify(more))
            throw new Error('Weird')
        }
        if (map?.version !== 3) {
            throw new Error('Source map missing.')
        }
        minified.push(
            pack(log, host, stagePath, fn, handlerFileName(modules), code, { ...map, version: 3 }),
        )
    }
    return await Promise.all(minified)
}

async function pack(
    log: { trace: (message: string) => void },
    host: Host,
    stagePath: string,
    fn: string,
    fileName: string,
    source: string,
    map: SourceMap & { version: 3 },
) {
    log.trace(`minifying ${fn}`)
    const min = minify_sync(
        { [`${fn}.js`]: source },
        {
            compress: {
                module: true,
                ecma: 2020,
                // eslint-disable-next-line camelcase
                hoist_funs: true,
                passes: 2,
            },
            mangle: {
                module: true,
            },
            sourceMap: {
                content: map,
                filename: `${fn}.js.map`,
            },
            format: {
                ecma: 2020,
                comments: false,
            },
        },
    )
    if (!min.code) {
        throw new Error('Weird')
    }
    const code = host.patch ? host.patch(min.code) : min.code
    log.trace(`${fn} minified`)
    await Promise.all([
        writeFile(join(stagePath, fn + '.min.js'), code),
        writeFile(
            join(stagePath, fn + '.min.js.map.gz'),
            await gzip(min.map as unknown as ArrayBuffer),
        ),
    ])

    return { fn, fileName, code }
}

function gzip(data: ArrayBuffer) {
    return new Promise<Buffer>((resolve, reject) => {
        zlib.gzip(data, { level: 9 }, (err, buf) => {
            if (err) {
                reject(err)
                return
            }
            resolve(buf)
        })
    })
}
