import { declaredAws, isSlot } from '../glue.js'
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
    const { accountId: declared } = await declaredAws(glueFile)
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

/**
Whether the glue file is one the slot may be deployed or destroyed with: it lists the slot in
`aws.slots`. The account check alone passes any glue file whose account the credentials reach, so
a destroy of w1 given the production glue under a production profile would go through. It asks
AWS nothing, and callers run it first. A stage that is no slot is not the glue's to list.
*/
export async function checkSlot(intent: string, stage: string, glueFile: string) {
    if (!isSlot(stage)) {
        return
    }
    const { slots } = await declaredAws(glueFile)
    if (!slots.includes(stage)) {
        throw new Error(
            `Refusing to ${intent}: ${glueFile} does not list ${stage} in aws.slots (it lists ${slots.length === 0 ? 'none' : slots.join(', ')}). A slot is deployed and destroyed only with the glue file of the account that holds it: "aws": { "slots": ["${stage}"] } at the top level. Nothing was changed.`,
        )
    }
}
