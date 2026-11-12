import assert from 'node:assert/strict'
import { parseArguments } from '../lib/arguments.js'

describe('arguments', () => {
    it('refuses a command line without a stage', () => {
        assert.throws(() => parseArguments([]), {
            message: /^Please specify target environment name\./u,
        })
    })

    it('refuses an option it does not know and an option without its value', () => {
        assert.throws(() => parseArguments(['dev', '--force']), { message: /--force/u })
        assert.throws(() => parseArguments(['dev', '--stage-dir']), { message: /--stage-dir/u })
        assert.throws(() => parseArguments(['dev', '--stage-dir', '--other']), {
            message: /--stage-dir/u,
        })
    })

    it('refuses more arguments than it reads', () => {
        assert.throws(() => parseArguments(['.', 'dev', 'glue.json', 'extra']), {
            message: /^Unexpected argument extra\./u,
        })
    })

    it('reads a stage alone, or a path, a stage and a glue file', () => {
        assert.deepStrictEqual(parseArguments(['dev']), {
            command: 'deploy',
            path: undefined,
            stage: 'dev',
            glueFile: undefined,
            stageDir: undefined,
        })
        assert.deepStrictEqual(parseArguments(['../api-rentals', 'w1', '../glue/glue.dev.json']), {
            command: 'deploy',
            path: '../api-rentals',
            stage: 'w1',
            glueFile: '../glue/glue.dev.json',
            stageDir: undefined,
        })
    })

    it('reads the build root wherever it stands', () => {
        assert.deepStrictEqual(parseArguments(['--stage-dir', '/builds/base', 'w1']), {
            command: 'deploy',
            path: undefined,
            stage: 'w1',
            glueFile: undefined,
            stageDir: '/builds/base',
        })
        assert.deepStrictEqual(parseArguments(['.', 'w1', '--stage-dir=/builds/base']), {
            command: 'deploy',
            path: '.',
            stage: 'w1',
            glueFile: undefined,
            stageDir: '/builds/base',
        })
    })
})
