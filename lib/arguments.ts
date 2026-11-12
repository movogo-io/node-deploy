import { parseArgs } from 'node:util'

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
    boundary on a role the deploy creates. An existing role is not changed.`

export function parseArguments(args: string[]) {
    const { positionals, values } = parseArgs({
        args,
        options: { 'stage-dir': { type: 'string' } },
        allowPositionals: true,
        strict: true,
    })
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
