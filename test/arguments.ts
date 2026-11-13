import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { parseArguments, secretUsage, usage } from '../lib/arguments.js'

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

    it('refuses a stage that is empty, a path or holds a separator', () => {
        for (const stage of ['', ' ', '.', '../api-rentals', 'dev.rentals', 'dev/x', 'w1 ']) {
            assert.throws(() => parseArguments(['.', stage]), {
                message: new RegExp(
                    `^${RegExp.escape(JSON.stringify(stage))} is not a stage name`,
                    'u',
                ),
            })
        }
        assert.throws(() => parseArguments(['../api-rentals']), {
            message: /^"\.\.\/api-rentals" is not a stage name/u,
        })
    })

    it('refuses a deploy that reads like a mistyped destroy', () => {
        for (const args of [
            ['w1', 'destroy'],
            ['.', 'w1', 'destroy'],
            ['Destroy', 'w1'],
            ['DESTROY', 'w1'],
            [' destroy', 'w1'],
            ['destroy ', 'w1'],
        ]) {
            assert.throws(() => parseArguments(args), {
                message: /is neither a deploy nor a destroy/u,
            })
        }
    })

    it('deploys a directory named destroy when it is written as a path', () => {
        assert.deepStrictEqual(parseArguments(['./destroy', 'dev']), {
            command: 'deploy',
            path: './destroy',
            stage: 'dev',
            glueFile: undefined,
            stageDir: undefined,
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

    it('reads a request for help in a deploy and in a destroy, whatever else is missing', () => {
        for (const args of [
            ['--help'],
            ['-h'],
            ['dev', '--help'],
            ['.', 'dev', 'glue.json', '--stage-dir', '/builds', '--help'],
            ['destroy', '--help'],
            ['destroy', 'w1', '--help'],
            ['destroy', 'dev', '--dry-run', '-h'],
        ]) {
            assert.deepStrictEqual(parseArguments(args), { command: 'help' })
        }
    })

    it('prints the usage and exits 0 when asked for help, before it reads any credentials', () => {
        for (const args of [['--help'], ['destroy', '--help'], ['destroy', 'w1', '-h']]) {
            const { status, stdout, stderr } = spawnSync(
                process.execPath,
                [join(process.cwd(), 'bin/index.js'), ...args],
                { env: {}, encoding: 'utf-8' },
            )
            assert.deepStrictEqual(
                { status, stdout, stderr },
                {
                    status: 0,
                    stdout: `${usage}\n`,
                    stderr: '',
                },
            )
        }
    })

    it('refuses a deploy that reads like a mistyped secret command, or that names it after a flag', () => {
        for (const args of [
            ['Secret', 'list', 'dev'],
            [' secret ', 'dev'],
            ['dev', 'SECRET'],
            ['--stage-dir', 'x', 'secret', 'dev'],
        ]) {
            assert.throws(() => parseArguments(args), {
                message:
                    /is neither a deploy nor a secret command: secret is written exactly so and comes first\. A directory of that name is deployed as \.\/\w+\.\n\nUsage:\n {2}deploy \[<path>\]/u,
            })
        }
        assert.throws(() => parseArguments(['--glue', 'f', 'secret', 'list', 'dev']), {
            message: /^"secret" is neither a deploy nor a secret command/u,
        })
        assert.deepStrictEqual(parseArguments(['./secret', 'dev']).command, 'deploy')
    })

    it('still refuses the flags of a secret command on a deploy', () => {
        assert.throws(() => parseArguments(['dev', '--admin', 'a']), { message: /--admin/u })
        assert.throws(() => parseArguments(['dev', '--replace']), { message: /--replace/u })
    })
})

describe('secret arguments', () => {
    const none = {
        command: 'secret',
        service: undefined,
        key: undefined,
        version: undefined,
        glueFile: 'f',
        keyId: undefined,
        admins: [],
        operators: [],
        deployers: [],
        slotReaders: [],
        updatePolicy: false,
        replace: false,
        multiline: false,
        yes: false,
    }

    it('reads a request for help whatever else is missing or wrong, and leaves the deploy’s alone', () => {
        for (const args of [
            ['secret', '--help'],
            ['secret', 'put', '--help'],
            ['secret', '-h'],
            ['secret', 'nonsense', 'w1', '--help'],
        ]) {
            assert.deepStrictEqual(parseArguments(args), { command: 'secret-help' })
        }
        assert.deepStrictEqual(parseArguments(['--help']), { command: 'help' })
    })

    it('refuses a command it does not know, and none', () => {
        assert.throws(() => parseArguments(['secret', 'show', 'dev', '--glue', 'f']), {
            message: `Unknown secret command show.\n\n${secretUsage}`,
        })
        assert.throws(() => parseArguments(['secret']), {
            message: `Please name a secret command.\n\n${secretUsage}`,
        })
    })

    it('refuses a bad stage name with its own usage, where a deploy keeps the deploy’s', () => {
        assert.throws(() => parseArguments(['secret', 'list', 'dev/x', '--glue', 'f']), {
            message: `"dev/x" is not a stage name: letters, digits, - and _ only.\n\n${secretUsage}`,
        })
        assert.throws(() => parseArguments(['.', 'dev/x']), {
            message: `"dev/x" is not a stage name: letters, digits, - and _ only.\n\n${usage}`,
        })
    })

    it('refuses every command on a slot', () => {
        for (const args of [
            ['init', 'w1', '--admin', 'a', '--admin', 'b'],
            ['init-key', 'w1', 'svc', 'seeds'],
            ['put', 'w1', 'svc', 'KEY'],
            ['import', 'w1', 'svc', 'KEY'],
            ['list', 'w1'],
            ['check', 'w1'],
            ['restore', 'w1', 'svc', 'KEY', '1'],
            ['rm', 'w1', 'svc', 'KEY'],
        ]) {
            assert.throws(() => parseArguments(['secret', ...args, '--glue', 'f']), {
                message: `secret ${args[0]} takes no slot: w1 has no parameters and no key of its own; a deploy to it reads those of the stage its glue names. Run the command for that stage.\n\n${secretUsage}`,
            })
        }
    })

    it('reads each command’s positionals', () => {
        assert.deepStrictEqual(
            [
                ['init', 'dev'],
                ['init-key', 'dev', 'svc', 'seed-key'],
                ['put', 'dev', 'svc', 'KEY'],
                ['import', 'dev', 'svc', 'KEY'],
                ['list', 'dev'],
                ['list', 'dev', 'svc'],
                ['check', 'dev'],
                ['check', 'dev', 'rentals-v2'],
                ['restore', 'dev', 'svc', 'KEY', '12'],
                ['rm', 'dev', 'svc', 'KEY'],
            ].map(args => parseArguments(['secret', ...args, '--glue', 'f'])),
            [
                { ...none, name: 'init', stage: 'dev' },
                { ...none, name: 'init-key', stage: 'dev', service: 'svc', key: 'seed-key' },
                { ...none, name: 'put', stage: 'dev', service: 'svc', key: 'KEY' },
                { ...none, name: 'import', stage: 'dev', service: 'svc', key: 'KEY' },
                { ...none, name: 'list', stage: 'dev' },
                { ...none, name: 'list', stage: 'dev', service: 'svc' },
                { ...none, name: 'check', stage: 'dev' },
                { ...none, name: 'check', stage: 'dev', service: 'rentals-v2' },
                { ...none, name: 'restore', stage: 'dev', service: 'svc', key: 'KEY', version: 12 },
                { ...none, name: 'rm', stage: 'dev', service: 'svc', key: 'KEY' },
            ],
        )
    })

    it('refuses a positional that is missing, surplus or of the wrong kind', () => {
        for (const [args, message] of [
            [['put'], 'secret put needs <stage> <service> <KEY>.'],
            [['put', 'dev', 'svc'], 'secret put needs <stage> <service> <KEY>.'],
            [
                ['restore', 'dev', 'svc', 'KEY'],
                'secret restore needs <stage> <service> <KEY> <version>.',
            ],
            [['init-key', 'dev', 'svc'], 'secret init-key needs <stage> <service> <name>.'],
            [['list', 'dev', 'svc', 'KEY'], 'Unexpected argument KEY.'],
            [['init', 'dev', 'svc'], 'Unexpected argument svc.'],
            [['rm', 'dev', 'svc', 'KEY', '1', '2'], 'Unexpected argument 1 2.'],
            [['put', 'dev', 'a/b', 'KEY'], '<service> must name a service, not "a/b".'],
            [
                ['put', 'dev', 'svc', '1KEY'],
                '"1KEY" is no key: letters, digits and _ only, not starting with a digit.',
            ],
            [
                ['put', 'dev', 'svc', 'MY-KEY'],
                '"MY-KEY" is no key: letters, digits and _ only, not starting with a digit.',
            ],
            [['restore', 'dev', 'svc', 'KEY', 'v2'], '<version> must be a number, not "v2".'],
            [['restore', 'dev', 'svc', 'KEY', '0'], '<version> must be a number, not "0".'],
        ] as const) {
            assert.throws(() => parseArguments(['secret', ...args, '--glue', 'f']), {
                message: `${message}\n\n${secretUsage}`,
            })
        }
    })

    it('requires --glue of every command', () => {
        for (const args of [
            ['init', 'dev'],
            ['init-key', 'dev', 'svc', 'seeds'],
            ['put', 'dev', 'svc', 'KEY'],
            ['import', 'dev', 'svc', 'KEY'],
            ['list', 'dev'],
            ['check', 'dev'],
            ['restore', 'dev', 'svc', 'KEY', '1'],
            ['rm', 'dev', 'svc', 'KEY'],
        ]) {
            assert.throws(() => parseArguments(['secret', ...args]), {
                message: `secret ${args[0]} needs --glue <file>, the stage's glue file; it guesses none.\n\n${secretUsage}`,
            })
        }
    })

    it('reads the principals of init, each as often as it is given, and the flags of the others', () => {
        assert.deepStrictEqual(
            [
                'init dev --admin a --admin b --operator c --deployer d --deployer e --slot-reader g --slot-reader h --glue f',
                'init dev --key k --update-policy --glue=f',
                'init-key dev svc seeds --key k --update-policy --glue f',
                'put dev svc KEY --replace --multiline --glue f',
                'rm dev svc KEY --yes --glue f',
            ].map(line => parseArguments(['secret', ...line.split(' ')])),
            [
                {
                    ...none,
                    name: 'init',
                    stage: 'dev',
                    admins: ['a', 'b'],
                    operators: ['c'],
                    deployers: ['d', 'e'],
                    slotReaders: ['g', 'h'],
                },
                { ...none, name: 'init', stage: 'dev', keyId: 'k', updatePolicy: true },
                {
                    ...none,
                    name: 'init-key',
                    stage: 'dev',
                    service: 'svc',
                    key: 'seeds',
                    keyId: 'k',
                    updatePolicy: true,
                },
                {
                    ...none,
                    name: 'put',
                    stage: 'dev',
                    service: 'svc',
                    key: 'KEY',
                    replace: true,
                    multiline: true,
                },
                { ...none, name: 'rm', stage: 'dev', service: 'svc', key: 'KEY', yes: true },
            ],
        )
    })

    it('refuses a flag on a command it does not belong to', () => {
        for (const [line, message] of [
            ['put dev svc KEY --slot-reader g', '--slot-reader belongs to init.'],
            ['list dev --admin a', '--admin belongs to init.'],
            ['put dev svc KEY --key k', '--key belongs to init and init-key.'],
            ['rm dev svc KEY --update-policy', '--update-policy belongs to init and init-key.'],
            ['import dev svc KEY --replace', '--replace belongs to put.'],
            ['restore dev svc KEY 1 --multiline', '--multiline belongs to put.'],
            ['put dev svc KEY --yes', '--yes belongs to rm.'],
        ] as const) {
            assert.throws(() => parseArguments(['secret', ...line.split(' '), '--glue', 'f']), {
                message: `${message}\n\n${secretUsage}`,
            })
        }
    })

    it('leaves an unknown flag and a flag without its value to the parser, with no usage', () => {
        for (const args of [
            ['list', 'dev', '--force'],
            ['list', 'dev', '--glue'],
            ['list', 'dev', '--stage-dir', 'x', '--glue', 'f'],
        ]) {
            assert.throws(
                () => parseArguments(['secret', ...args]),
                (e: unknown) => Error.isError(e) && !e.message.includes('Usage:'),
            )
        }
    })
})
