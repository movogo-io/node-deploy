import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { compile } from './lib/compile.js'

describe('a command that fails', () => {
    const env = {
        PATH: process.env.PATH,
        AWS_REGION: 'eu-north-1',
        AWS_ACCESS_KEY_ID: 'test-key-id',
        AWS_SECRET_ACCESS_KEY: 'test-secret',
    }
    const offline = ['--import', join(process.cwd(), 'test/lib/offline.js')]

    it('exits 1 with the error when a deploy fails after the service registered listeners for uncaught errors', () => {
        const path = join(process.cwd(), 'test/data/listening')
        compile(path)

        const { status, stdout, stderr } = spawnSync(
            process.execPath,
            [...offline, join(process.cwd(), 'bin/index.js'), path, 'dev', join(path, 'glue.json')],
            { env, encoding: 'utf-8' },
        )

        assert.match(stderr, /aws\.layers names gone, which the service has no function of\./u)
        assert.deepStrictEqual(
            { status, stdout },
            {
                status: 1,
                stdout: 'deploying to dev as arn:aws:iam::123456789012:user/offline\n',
            },
        )
    }).timeout(60_000)

    // A destroy and a layer publish import no service code and exited 1 before the fix too: the two
    // below pin that exit code, and only the deploy above proves the fix.
    it('keeps exiting 1 with the error when a destroy fails', () => {
        const { status, stdout, stderr } = spawnSync(
            process.execPath,
            [
                ...offline,
                join(process.cwd(), 'bin/index.js'),
                'destroy',
                'w1',
                '--glue',
                join(process.cwd(), 'test/data/listening/glue.json'),
            ],
            { env, encoding: 'utf-8' },
        )

        assert.match(stderr, /does not list w1 in aws\.slots/u)
        assert.deepStrictEqual({ status, stdout }, { status: 1, stdout: '' })
    }).timeout(60_000)

    it('keeps exiting 1 with the error when a layer publish fails', () => {
        const { status, stdout, stderr } = spawnSync(
            process.execPath,
            [
                ...offline,
                join(process.cwd(), 'bin/publish-layer.js'),
                join(process.cwd(), 'test/data/listening/no.zip'),
                'offline-layer',
            ],
            { env, encoding: 'utf-8' },
        )

        assert.match(stderr, /ENOENT: no such file or directory.*no\.zip/u)
        assert.deepStrictEqual({ status, stdout }, { status: 1, stdout: '' })
    }).timeout(60_000)
})
