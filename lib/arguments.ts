import { parseArgs } from 'node:util'
import { isServiceName } from './aws/destroy.js'
import { isKeyName, isSlot, isStageName } from './glue.js'

export const usage = `Usage:
  deploy [<path>] <stage> [<glue file>] [--stage-dir <dir>]

    Deploys the service in <path> (default: the current directory) to <stage>.
    Credentials are those of the profile AWS_PROFILE names, else of the profile named
    like the stage; keys in the environment win over both.

    --stage-dir <dir>   Build in <dir>/<service> instead of
                        $TMPDIR/riddance/stage/<stage>/<service>. Two deploys of one
                        service at the same time must not share a <dir>.

    DEPLOY_PERMISSIONS_BOUNDARY, or services.<service>.aws.permissionsBoundary in the glue
    (where $ENV stands for the stage), is the ARN of the IAM policy set as permissions
    boundary on a role the deploy creates. An existing role is not changed.

    aws.accountId at the top level of the glue file is the AWS account the stage lives in.
    A deploy under credentials of another account is refused before it changes anything;
    a glue file without it deploys with a warning, repeated as the last line. Another key in
    that aws object is refused.

    aws.slots beside it lists the slots (w1 to w9) that account may hold. A deploy to a slot
    is refused unless the glue file lists that slot; other stages need no entry.

  deploy destroy <stage> --glue <file> [--service <name>] [--dry-run]

    Deletes what deploys made on the slot <stage>, which must be one of w1 to w9: rules and
    their targets, functions, APIs, topics and subscriptions, roles and log groups, each only
    when its name starts with the stage and its environment tag names it. Tables are kept,
    and so are the layer versions its functions ran with, which other stages may share.
    The whole list is printed first, with what was skipped and why, and only that list is
    deleted.

    --glue <file>       The stage's glue file, required: destroy guesses none. It must list
                        <stage> in aws.slots and declare aws.accountId, and the credentials
                        must be of that account.
    --service <name>    Only what belongs to that service; topics are kept.
    --dry-run           Stop after printing the list.

  deploy secret --help

    Prints the secret commands.

  deploy --help

    Prints this text.`

export const secretUsage = `Usage:
  deploy secret <command> <stage> [<service> [<KEY> [<version>]]] --glue <file> [flags]

    Keeps a stage's credentials in the parameter store, where a deploy reads those its glue
    refers to with "$PARAMETER()" or "$PARAMETER(<service>,<KEY>)". No command prints a
    value. <stage> is never a slot (w1 to w9): a slot reads the parameters of the stage its
    glue names in slotParametersFrom.

    --glue <file>       The stage's glue file, required: no command guesses one. It must
                        declare aws.accountId, and the credentials must be of that account.

  init <stage> --admin <arn>... --operator <arn>... --deployer <arn>... [--slot-reader <arn>...]
       [--key <id>] [--update-policy]
    Makes the stage's key, alias/<stage>-secrets, or checks its policy. Run by one of at
    least two administrators. --slot-reader names the roles of the slots that read this
    stage's parameters. --key resumes with a key that was made without its alias;
    --update-policy replaces a policy that differs.

  init-key <stage> <service> <name> [--key <id>] [--update-policy]
    Makes alias/<stage>-<service>-<name>, a key only that service's functions may use, and
    prints its ARN. The service must have been deployed once.

  put <stage> <service> <KEY> [--replace] [--multiline]
    Puts the value typed without echo, or read from standard input, as the parameter
    /<stage>/<service>/<KEY>, which the glue must refer to. --replace overwrites an
    existing one; --multiline allows newlines. Typed by a person, never run by an agent.

  import <stage> <service> <KEY>
    Copies the value the service's functions hold into the parameter.

  list <stage> [<service>]
    One line a parameter: name, version, last change, who made it, and what is odd about it
    (unreferenced, missing, not SecureString, other key).

  check <stage> [<service>]
    One line for each function that runs with another version than the current one, and
    exit code 1 if there is any.

  restore <stage> <service> <KEY> <version>
    Puts an earlier version's value as the newest version.

  rm <stage> <service> <KEY> [--yes]
    Deletes a parameter the glue no longer refers to, with all its versions.

  Exit code 0: done. 1: a refusal, wrong usage, or check found something. 3: an AWS error
  or anything unexpected.

  deploy secret --help

    Prints this text.`

export function parseArguments(args: string[]) {
    // Before the deploy's own strict parse, which knows none of a secret command's flags and
    // answers --help with the deploy's usage.
    if (args[0] === 'secret') {
        return parseSecretArguments(args.slice(1))
    }
    const { positionals, values } = parseArgs({
        args,
        options: {
            'stage-dir': { type: 'string' },
            glue: { type: 'string' },
            service: { type: 'string' },
            'dry-run': { type: 'boolean' },
            help: { type: 'boolean', short: 'h' },
        },
        allowPositionals: true,
        strict: true,
    })
    if (values.help === true) {
        return { command: 'help' as const }
    }
    if (positionals[0] === 'destroy') {
        return destroyArguments(positionals.slice(1), values)
    }
    const misplaced = positionals.find(isCommandLike)
    if (misplaced !== undefined) {
        const command = misplaced.trim().toLowerCase()
        throw new Error(
            `${JSON.stringify(misplaced)} is neither a deploy nor a ${command === 'secret' ? 'secret command' : command}: ${command} is written exactly so and comes first. A directory of that name is deployed as ./${misplaced.trim()}.\n\n${usage}`,
        )
    }
    if (values.service !== undefined || values['dry-run'] !== undefined) {
        throw new Error(`--service and --dry-run belong to destroy.\n\n${usage}`)
    }
    if (values.glue !== undefined) {
        throw new Error(`--glue belongs to destroy; a deploy names its glue file last.\n\n${usage}`)
    }
    const [pathOrStage, stage, glueFile, ...surplus] = positionals
    if (pathOrStage === undefined) {
        throw new Error(`Please specify target environment name.\n\n${usage}`)
    }
    if (surplus.length !== 0) {
        throw new Error(`Unexpected argument ${surplus.join(' ')}.\n\n${usage}`)
    }
    return {
        command: 'deploy' as const,
        path: stage === undefined ? undefined : pathOrStage,
        stage: stageName(stage ?? pathOrStage),
        glueFile,
        stageDir: values['stage-dir'],
    }
}

// A deploy must not be what a mistyped destroy or secret command turns into, nor either of
// them what a deploy does.
function isCommandLike(argument: string) {
    return ['destroy', 'secret'].includes(argument.trim().toLowerCase())
}

export function stageName(stage: string, usageText = usage) {
    if (!isStageName(stage)) {
        throw new Error(
            `${JSON.stringify(stage)} is not a stage name: letters, digits, - and _ only.\n\n${usageText}`,
        )
    }
    return stage
}

const secretCommands = {
    init: { positionals: [] },
    'init-key': { positionals: ['<service>', '<name>'] },
    put: { positionals: ['<service>', '<KEY>'] },
    import: { positionals: ['<service>', '<KEY>'] },
    list: { positionals: ['[<service>]'] },
    check: { positionals: ['[<service>]'] },
    restore: { positionals: ['<service>', '<KEY>', '<version>'] },
    rm: { positionals: ['<service>', '<KEY>'] },
} as const

export type SecretCommand = keyof typeof secretCommands

const secretFlags: { [flag: string]: SecretCommand[] } = {
    key: ['init', 'init-key'],
    admin: ['init'],
    operator: ['init'],
    deployer: ['init'],
    'slot-reader': ['init'],
    'update-policy': ['init', 'init-key'],
    replace: ['put'],
    multiline: ['put'],
    yes: ['rm'],
}

export function parseSecretArguments(args: string[]) {
    const { positionals, values } = parseArgs({
        args,
        options: {
            glue: { type: 'string' },
            key: { type: 'string' },
            admin: { type: 'string', multiple: true },
            operator: { type: 'string', multiple: true },
            deployer: { type: 'string', multiple: true },
            'slot-reader': { type: 'string', multiple: true },
            'update-policy': { type: 'boolean' },
            replace: { type: 'boolean' },
            multiline: { type: 'boolean' },
            yes: { type: 'boolean' },
            help: { type: 'boolean', short: 'h' },
        },
        allowPositionals: true,
        strict: true,
    })
    if (values.help === true) {
        return { command: 'secret-help' as const }
    }
    const [name, stage, ...rest] = positionals
    if (!isSecretCommand(name)) {
        throw new Error(
            `${name === undefined ? 'Please name a secret command' : `Unknown secret command ${name}`}.\n\n${secretUsage}`,
        )
    }
    const shape = ['<stage>', ...secretCommands[name].positionals]
    if (stage === undefined) {
        throw new Error(`secret ${name} needs ${shape.join(' ')}.\n\n${secretUsage}`)
    }
    stageName(stage, secretUsage)
    // Before a file or a credential is read: a slot has nothing a secret command could act on.
    if (isSlot(stage)) {
        throw new Error(
            `secret ${name} takes no slot: ${stage} has no parameters and no key of its own; a deploy to it reads those of the stage its glue names. Run the command for that stage.\n\n${secretUsage}`,
        )
    }
    const { service, key, version } = secretPositionals(name, shape, rest)
    if (values.glue === undefined) {
        throw new Error(
            `secret ${name} needs --glue <file>, the stage's glue file; it guesses none.\n\n${secretUsage}`,
        )
    }
    for (const [flag, commands] of Object.entries(secretFlags)) {
        if (Object.keys(values).includes(flag) && !commands.includes(name)) {
            throw new Error(`--${flag} belongs to ${commands.join(' and ')}.\n\n${secretUsage}`)
        }
    }
    return {
        command: 'secret' as const,
        name,
        stage,
        service,
        key,
        version,
        glueFile: values.glue,
        keyId: values.key,
        admins: values.admin ?? [],
        operators: values.operator ?? [],
        deployers: values.deployer ?? [],
        slotReaders: values['slot-reader'] ?? [],
        updatePolicy: values['update-policy'] ?? false,
        replace: values.replace ?? false,
        multiline: values.multiline ?? false,
        yes: values.yes ?? false,
    }
}

export type SecretArguments = Exclude<
    ReturnType<typeof parseSecretArguments>,
    { command: 'secret-help' }
>

function isSecretCommand(name: string | undefined): name is SecretCommand {
    return name !== undefined && Object.keys(secretCommands).includes(name)
}

function secretPositionals(name: SecretCommand, shape: string[], rest: string[]) {
    const { positionals } = secretCommands[name]
    const surplus = rest.slice(positionals.length)
    if (surplus.length !== 0) {
        throw new Error(`Unexpected argument ${surplus.join(' ')}.\n\n${secretUsage}`)
    }
    const [service, key, version] = rest
    if (rest.length < positionals.filter(positional => !positional.startsWith('[')).length) {
        throw new Error(`secret ${name} needs ${shape.join(' ')}.\n\n${secretUsage}`)
    }
    if (service !== undefined && !isServiceName(service)) {
        throw new Error(
            `<service> must name a service, not ${JSON.stringify(service)}.\n\n${secretUsage}`,
        )
    }
    // A key's name ends an alias: letters, digits, - and _ as a service's name.
    if (key !== undefined && !(name === 'init-key' ? isServiceName(key) : isKeyName(key))) {
        throw new Error(
            `${JSON.stringify(key)} is no ${name === 'init-key' ? 'name of a key' : 'key: letters, digits and _ only, not starting with a digit'}.\n\n${secretUsage}`,
        )
    }
    if (version !== undefined && !/^[1-9]\d*$/u.test(version)) {
        throw new Error(
            `<version> must be a number, not ${JSON.stringify(version)}.\n\n${secretUsage}`,
        )
    }
    return { service, key, version: version === undefined ? undefined : Number(version) }
}

function destroyArguments(
    [stage, ...surplus]: string[],
    values: { 'stage-dir'?: string; glue?: string; service?: string; 'dry-run'?: boolean },
) {
    if (stage === undefined || !isSlot(stage)) {
        throw new Error(
            `destroy only removes the slots w1 to w9, not ${JSON.stringify(stage ?? '')}.\n\n${usage}`,
        )
    }
    if (surplus.length !== 0) {
        throw new Error(`Unexpected argument ${surplus.join(' ')}.\n\n${usage}`)
    }
    if (values['stage-dir'] !== undefined) {
        throw new Error(`--stage-dir belongs to a deploy.\n\n${usage}`)
    }
    if (values.service !== undefined && !isServiceName(values.service)) {
        throw new Error(
            `--service must name a service, not ${JSON.stringify(values.service)}.\n\n${usage}`,
        )
    }
    if (values.glue === undefined) {
        throw new Error(
            `destroy needs --glue <file>, the glue file that lists ${stage} in aws.slots; it guesses none.\n\n${usage}`,
        )
    }
    return {
        command: 'destroy' as const,
        stage,
        glueFile: values.glue,
        service: values.service,
        dryRun: values['dry-run'] ?? false,
    }
}

export const publishLayerUsage = `Usage:
  publish-layer <zip> <name> [<bucket>] [--account <id>]

    Publishes <zip> as a new version of the layer <name> and prints the version's ARN.
    Credentials are the keys in the environment, else those of the profile AWS_PROFILE
    names, else of [default]. The caller's ARN is printed before anything is written.

    <bucket>            An S3 bucket in the same region, for a zip over 50 MB.
    --account <id>      The twelve-digit AWS account to publish in. Credentials of another
                        account are refused before anything is written.`

export function parsePublishLayerArguments(args: string[]) {
    const {
        positionals: [zipPath, name, bucket, ...surplus],
        values: { account },
    } = parseArgs({
        args,
        options: { account: { type: 'string' } },
        allowPositionals: true,
        strict: true,
    })
    if (!zipPath || !name) {
        throw new Error(`Please name the zip and the layer.\n\n${publishLayerUsage}`)
    }
    if (surplus.length !== 0) {
        throw new Error(`Unexpected argument ${surplus.join(' ')}.\n\n${publishLayerUsage}`)
    }
    if (account !== undefined && !/^\d{12}$/u.test(account)) {
        throw new Error(
            `--account must be twelve digits, not ${JSON.stringify(account)}.\n\n${publishLayerUsage}`,
        )
    }
    return { zipPath, name, bucket, account }
}
