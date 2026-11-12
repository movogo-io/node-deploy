import assert from 'node:assert/strict'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDirectory } from '../lib/stage.js'

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
            ],
            ['/builds/base/rentals', '/builds/base/rentals', '/builds/base/@movogo-io/rentals'],
        )
    })
})
