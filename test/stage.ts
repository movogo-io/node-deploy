// spell-checker: ignore rendr sparticuz
import assert from 'node:assert/strict'
import { readdir, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { install } from '../lib/npm.js'
import { buildDirectory, externalModules, stage } from '../lib/stage.js'
import { compile } from './lib/compile.js'

describe('build directory', () => {
    const project = join(tmpdir(), 'riddance', 'deploy-test-project')

    it('refuses a stage or service name that leaves the build root', async () => {
        await assert.rejects(buildDirectory(undefined, '../../elsewhere', 'rentals', project), {
            message: /^The name of stage \.\.\/\.\.\/elsewhere would put its build outside /u,
        })
        await assert.rejects(buildDirectory('/builds/base', 'w1', '../rentals', project), {
            message: 'The name of service ../rentals would put its build outside /builds/base.',
        })
        await assert.rejects(buildDirectory('/builds/base', 'w1', '.', project), {
            message: 'The name of service . would put its build outside /builds/base.',
        })
    })

    it('refuses a root that is no place to build in', async () => {
        await assert.rejects(buildDirectory('', 'w1', 'rentals', project), {
            message: '--stage-dir needs a directory.',
        })
        await assert.rejects(buildDirectory('/', 'w1', 'rentals', project), {
            message: '--stage-dir / is not a directory to build in.',
        })
        await assert.rejects(buildDirectory(homedir(), 'w1', 'rentals', project), {
            message: `--stage-dir ${homedir()} is not a directory to build in.`,
        })
        await assert.rejects(buildDirectory(import.meta.filename, 'w1', 'rentals', project), {
            message: `--stage-dir ${import.meta.filename} exists and is not a directory.`,
        })
    })

    it('refuses a root inside or around the project', async () => {
        await assert.rejects(buildDirectory(join(project, 'build'), 'w1', 'rentals', project), {
            message: `--stage-dir ${join(project, 'build')} overlaps the project being deployed.`,
        })
        await assert.rejects(buildDirectory(join(project, '..'), 'w1', 'rentals', project), {
            message: `--stage-dir ${join(project, '..')} overlaps the project being deployed.`,
        })
        await assert.rejects(
            buildDirectory(project, 'w1', 'rentals', join(project, '..dotted-project')),
            { message: `--stage-dir ${project} overlaps the project being deployed.` },
        )
    })

    it('builds each stage of a service in a directory of its own', async () => {
        assert.deepStrictEqual(
            [
                await buildDirectory(undefined, 'dev', 'rentals', project),
                await buildDirectory(undefined, 'w1', 'rentals', project),
            ],
            [
                join(tmpdir(), 'riddance', 'stage', 'dev', 'rentals'),
                join(tmpdir(), 'riddance', 'stage', 'w1', 'rentals'),
            ],
        )
    })

    it('builds under a given root without the stage, so stages can share a build', async () => {
        assert.deepStrictEqual(
            [
                await buildDirectory('/builds/base', 'w1', 'rentals', project),
                await buildDirectory('/builds/base', 'w2', 'rentals', project),
                await buildDirectory('/builds/base', 'w2', '@movogo-io/rentals', project),
                await buildDirectory('/builds/base', 'w2', '..rentals', project),
            ],
            [
                '/builds/base/rentals',
                '/builds/base/rentals',
                '/builds/base/@movogo-io/rentals',
                '/builds/base/..rentals',
            ],
        )
    })
})

describe('external modules', () => {
    const functionNames = ['render', 'get']

    it('refuses external that is no map of function names', () => {
        assert.throws(() => externalModules(functionNames, { external: ['puppeteer-core'] }), {
            message: 'aws.external must map function names to lists of package names.',
        })
    })

    it('refuses a function name the service has no function of', () => {
        assert.throws(
            () => externalModules(functionNames, { external: { rendr: ['puppeteer-core'] } }),
            { message: 'aws.external names rendr, which the service has no function of.' },
        )
    })

    it('refuses anything but a list of package names', () => {
        for (const modules of [
            'puppeteer-core',
            ['./lib/browser.js'],
            ['.'],
            ['..'],
            ['@scope/.'],
            ['/opt/nodejs'],
            [''],
            [1],
        ]) {
            assert.throws(() => externalModules(functionNames, { external: { render: modules } }), {
                message: 'aws.external of render must be a list of package names.',
            })
        }
        assert.throws(
            () =>
                externalModules(functionNames, {
                    external: { render: ['puppeteer-core', 'puppeteer-core'] },
                }),
            { message: 'aws.external of render names a package twice.' },
        )
    })

    it('has none when the glue names none', () => {
        assert.deepStrictEqual(externalModules(functionNames, undefined), {})
        assert.deepStrictEqual(externalModules(functionNames, { layers: {} }), {})
    })

    it("takes each function's external packages", () => {
        assert.deepStrictEqual(
            externalModules(functionNames, {
                external: { render: ['puppeteer-core', '@sparticuz/chromium'] },
            }),
            { render: ['puppeteer-core', '@sparticuz/chromium'] },
        )
    })
})

describe('stage', () => {
    const path = join(process.cwd(), 'test/data/layered')
    const implementations = {
        '@riddance/service': { implementation: '@riddance/aws-host', version: '0.2.0' },
    }
    const types = { render: 'http', plain: 'http' } as const
    const log = {
        trace() {
            //
        },
        warn() {
            //
        },
        error() {
            //
        },
    }

    before(async () => {
        await install(path)
        compile(path)
    })

    it('refuses a bundle with an import nothing provides', async () => {
        const stagePath = join(tmpdir(), 'riddance', 'stage-test', 'unprovided')
        await rm(stagePath, { recursive: true, force: true })

        await assert.rejects(
            stage(log, stagePath, path, 'test', implementations, 'layered', types, {}, []),
            { message: 'Suspicious bundler warnings.' },
        )
    }).timeout(120_000)

    it('bundles only the entrypoints it is given, into an empty build directory, and keeps no hash of the others', async () => {
        const stagePath = join(tmpdir(), 'riddance', 'stage-test', 'left-out')
        await rm(stagePath, { recursive: true, force: true })

        // render imports what nothing provides, so bundling it would be refused.
        const staged = await stage(
            log,
            stagePath,
            path,
            'test',
            implementations,
            'layered',
            { plain: 'http' },
            {},
            ['render'],
        )
        const hashes = JSON.parse(await readFile(join(stagePath, '.hashes.json'), 'utf-8')) as {
            [source: string]: string
        }

        assert.deepStrictEqual(
            {
                staged: staged.map(({ fn, fileName }) => ({ fn, fileName })),
                bundles: (await readdir(stagePath)).filter(file => file.endsWith('.min.js')),
                hashed: Object.keys(hashes).filter(file => file.endsWith('.js')),
            },
            {
                staged: [{ fn: 'plain', fileName: 'index.js' }],
                bundles: ['plain.min.js'],
                hashed: ['plain.js'],
            },
        )

        // Given the entrypoint later, it is built then, and not taken for built already.
        assert.deepStrictEqual(
            (
                await stage(
                    log,
                    stagePath,
                    path,
                    'test',
                    implementations,
                    'layered',
                    types,
                    { render: ['@layer/browser'] },
                    [],
                )
            ).map(({ fn }) => fn),
            ['render', 'plain'],
        )

        // Left out again, the hash that build kept of it does not make this one a changed build.
        assert.deepStrictEqual(
            await stage(
                log,
                stagePath,
                path,
                'test',
                implementations,
                'layered',
                { plain: 'http' },
                {},
                ['render'],
            ),
            staged,
        )
    }).timeout(120_000)

    it('refuses a root file that has no type and is not left out, from an empty build directory', async () => {
        const stagePath = join(tmpdir(), 'riddance', 'stage-test', 'untyped')
        await rm(stagePath, { recursive: true, force: true })

        await assert.rejects(
            stage(
                log,
                stagePath,
                path,
                'test',
                implementations,
                'layered',
                { plain: 'http' },
                {},
                [],
            ),
            { message: 'Type of function render not determined.' },
        )
    }).timeout(120_000)

    it('bundles a function leaving out external modules, their subpaths and dynamic imports as an ES module', async () => {
        const stagePath = join(tmpdir(), 'riddance', 'stage-test', 'external')
        await rm(stagePath, { recursive: true, force: true })

        const staged = await stage(
            log,
            stagePath,
            path,
            'test',
            implementations,
            'layered',
            types,
            {
                render: ['@layer/browser'],
            },
            [],
        )

        assert.deepStrictEqual(
            staged.map(({ fn, fileName, code }) => ({
                fn,
                fileName,
                layerReferences: code.match(/(from|require\(|import\()"@layer[^"]*"/gu) ?? [],
                commonJsGlobals: code.includes('import.meta'),
            })),
            [
                {
                    fn: 'plain',
                    fileName: 'index.js',
                    layerReferences: [],
                    commonJsGlobals: false,
                },
                {
                    fn: 'render',
                    fileName: 'index.mjs',
                    layerReferences: ['from"@layer/browser"', 'import("@layer/browser/pdf"'],
                    commonJsGlobals: true,
                },
            ],
        )

        // Staged again unchanged, the cached bundles are served as they were.
        assert.deepStrictEqual(
            await stage(
                log,
                stagePath,
                path,
                'test',
                implementations,
                'layered',
                types,
                { render: ['@layer/browser'] },
                [],
            ),
            staged,
        )

        // Staged again without the external, the cached bundle is not served.
        await assert.rejects(
            stage(log, stagePath, path, 'test', implementations, 'layered', types, {}, []),
            { message: 'Suspicious bundler warnings.' },
        )
    }).timeout(120_000)
})
