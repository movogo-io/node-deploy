import { parseArgs } from 'node:util'
import { isServiceName, isSlot } from './aws/destroy.js'

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

  deploy destroy <stage> [--glue <file>] [--service <name>] [--dry-run]

    Deletes what deploys made on the slot <stage>, which must be one of w1 to w9: rules and
    their targets, functions, APIs, topics and subscriptions, roles and log groups, each only
    when its name starts with the stage and its environment tag names it. Tables are kept,
    and so are the layer versions its functions ran with, which other stages may share.
    The whole list is printed first, with what was skipped and why, and only that list is
    deleted.

    --glue <file>       The stage's glue file (default: ../glue/glue.json). It must declare
                        aws.accountId, and the credentials must be of that account.
    --service <name>    Only what belongs to that service; topics are kept.
    --dry-run           Stop after printing the list.`

export function parseArguments(args: string[]) {
    const { positionals, values } = parseArgs({
        args,
        options: {
            'stage-dir': { type: 'string' },
            glue: { type: 'string' },
            service: { type: 'string' },
            'dry-run': { type: 'boolean' },
        },
        allowPositionals: true,
        strict: true,
    })
    if (positionals[0] === 'destroy') {
        return destroyArguments(positionals.slice(1), values)
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
    const misplaced = positionals.find(isDestroyLike)
    if (misplaced !== undefined) {
        throw new Error(
            `${JSON.stringify(misplaced)} is neither a deploy nor a destroy: destroy is written exactly so and comes first. A directory of that name is deployed as ./${misplaced.trim()}.\n\n${usage}`,
        )
    }
    return {
        command: 'deploy' as const,
        path: stage === undefined ? undefined : pathOrStage,
        stage: stageName(stage ?? pathOrStage),
        glueFile,
        stageDir: values['stage-dir'],
    }
}

// A deploy must not be what a mistyped destroy turns into, nor a destroy what a deploy does.
function isDestroyLike(argument: string) {
    return argument.trim().toLowerCase() === 'destroy'
}

// The stage starts the name of everything a deploy makes, so an empty one, a path given in its
// place or a separator in it would name resources under no stage or under another one's prefix.
function stageName(stage: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(stage)) {
        throw new Error(
            `${JSON.stringify(stage)} is not a stage name: letters, digits, - and _ only.\n\n${usage}`,
        )
    }
    return stage
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
    return {
        command: 'destroy' as const,
        stage,
        glueFile: values.glue,
        service: values.service,
        dryRun: values['dry-run'] ?? false,
    }
}
