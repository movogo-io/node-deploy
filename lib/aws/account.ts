import { declaredAccount } from '../glue.js'
import { type Context } from './lite.js'
import { callerIdentity } from './services/sts.js'

/**
Whether the credentials reach the account the stage's glue file says the stage lives in. Callers
run it before their first write: a profile pointing at another account would otherwise deploy a
stage's resources there, or destroy what carries the stage's name there. A destroy refuses a glue
file that declares no account; a deploy warns and goes on, as before the glue could declare one,
and gets the warning back to repeat where its output ends.
*/
export async function checkAccount(
    context: Context,
    intent: string,
    glueFile: string,
    credentials: string,
    undeclared: 'warn' | 'refuse',
) {
    const declared = await declaredAccount(glueFile)
    if (declared === undefined && undeclared === 'refuse') {
        throw new Error(
            `Refusing to ${intent}: ${glueFile} declares no AWS account. Give it "aws": { "accountId": "<the stage's twelve-digit account id>" } at the top level.`,
        )
    }
    const caller = await callerIdentity(context)
    if (declared === undefined) {
        const warning = `${glueFile} declares no AWS account, so nothing checks that ${credentials} (account ${caller.account}) is where to ${intent}. Give it "aws": { "accountId": "<the stage's twelve-digit account id>" } at the top level.`
        context.log.warn(warning)
        return { ...caller, warning }
    }
    if (declared !== caller.account) {
        throw new Error(
            `Refusing to ${intent}: ${glueFile} declares AWS account ${declared}, but ${credentials} reaches account ${caller.account} as ${caller.arn}. Nothing was changed.`,
        )
    }
    return { ...caller, warning: undefined }
}
