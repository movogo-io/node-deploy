// spell-checker: ignore rendr sparticuz
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { install } from '../lib/npm.js'
import { externalModules, stage } from '../lib/stage.js'
import { compile } from './lib/compile.js'

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
            stage(log, stagePath, path, 'test', implementations, 'layered', types, {}),
            { message: 'Suspicious bundler warnings.' },
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
            await stage(log, stagePath, path, 'test', implementations, 'layered', types, {
                render: ['@layer/browser'],
            }),
            staged,
        )

        // Staged again without the external, the cached bundle is not served.
        await assert.rejects(
            stage(log, stagePath, path, 'test', implementations, 'layered', types, {}),
            { message: 'Suspicious bundler warnings.' },
        )
    }).timeout(120_000)
})
