import { parseArgs } from 'node:util'
import { isSlot } from './aws/destroy.js'

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

  deploy destroy <stage> [--service <name>] [--dry-run]

    Deletes what deploys made on the slot <stage>, which must be one of w1 to w9: rules and
    their targets, functions, APIs, topics and subscriptions, roles and log groups, each only
    when its name starts with the stage and its environment tag names it. Tables are kept.
    The whole list is printed first, with what was skipped and why, and only that list is
    deleted.

    --service <name>    Only what belongs to that service; topics are kept.
    --dry-run           Stop after printing the list.`

export function parseArguments(args: string[]) {
    const { positionals, values } = parseArgs({
        args,
        options: {
            'stage-dir': { type: 'string' },
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
    const [pathOrStage, stage, glueFile, ...surplus] = positionals
    if (!pathOrStage) {
        throw new Error(`Please specify target environment name.\n\n${usage}`)
    }
    if (surplus.length !== 0) {
        throw new Error(`Unexpected argument ${surplus.join(' ')}.\n\n${usage}`)
    }
    return {
        command: 'deploy' as const,
        path: stage ? pathOrStage : undefined,
        stage: stage ?? pathOrStage,
        glueFile,
        stageDir: values['stage-dir'],
    }
}

function destroyArguments(
    [stage, ...surplus]: string[],
    values: { 'stage-dir'?: string; service?: string; 'dry-run'?: boolean },
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
    return {
        command: 'destroy' as const,
        stage,
        service: values.service,
        dryRun: values['dry-run'] ?? false,
    }
}
