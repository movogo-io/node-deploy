import { isSlot } from '../glue.js'
import { checkAccount, checkSlot } from './account.js'
import { credentialsSource } from './credentials.js'
import { type Context } from './lite.js'
import { deleteApi, getApis } from './services/api-gateway.js'
import { deleteLogGroup, listLogGroups } from './services/cloud-watch.js'
import {
    deleteRuleByName,
    getRuleTags,
    listRuleTargetIds,
    listRules,
    removeRuleTargets,
} from './services/event-bridge.js'
import { deleteFunction, getFunctionTags, listAccountFunctions } from './services/lambda.js'
import {
    deleteRole,
    deleteRolePolicy,
    getRoleTags,
    listAttachedPolicyNames,
    listRoleNames,
    listRolePolicyNames,
} from './services/roles.js'
import {
    deleteTopic,
    getTopicTags,
    listSubscriptions,
    listTopicArns,
    unsubscribe,
} from './services/sns.js'

// `name` is always the stage-named thing the deletion belongs to; assertOfStage checks it.
export type Deletion =
    | { kind: 'rule targets'; name: string; ids: string[] }
    | { kind: 'rule'; name: string }
    | { kind: 'subscription'; name: string; arn: string; endpoint: string }
    | { kind: 'api'; name: string; id: string }
    | { kind: 'function'; name: string }
    | { kind: 'topic'; name: string; arn: string }
    | { kind: 'role policy'; name: string; policy: string }
    | { kind: 'role'; name: string }
    | { kind: 'log group'; name: string }

type Skipped = { kind: Deletion['kind']; name: string; reason: string }

type Plan = { deletions: Deletion[]; skipped: Skipped[] }

type Tags = { [key: string]: string } | undefined

/**
Removes what deploys made on a slot, or of one service on it: everything but its tables. The
whole list is built and printed first, and only that list is deleted; nothing is listed again
in between, so what gets deleted is what was shown. Layer versions are no deploy's: they are
published apart, untagged and under a name of the publisher's choosing, and the glue of any
stage may name them, so none is ever the slot's to delete, whatever it is called.
*/
export async function destroy(
    context: Context,
    stage: string,
    {
        service,
        dryRun,
        glueFile,
        credentials = credentialsSource(stage),
    }: { service?: string; dryRun: boolean; glueFile: string; credentials?: string },
) {
    assertSlot(stage)
    await checkSlot(`destroy ${stage}`, stage, glueFile)
    const caller = await checkAccount(context, `destroy ${stage}`, glueFile, credentials, 'refuse')
    context.log.trace(`destroying ${stage} as ${caller.arn}`)
    const plan = await planDestroy(context, stage, service)
    for (const { kind, name, reason } of plan.skipped) {
        context.log.trace(`skip ${kind} ${name}: ${reason}`)
    }
    for (const deletion of plan.deletions) {
        context.log.trace(`delete ${describe(deletion)}`)
    }
    context.log.trace(`${plan.deletions.length} to delete, ${plan.skipped.length} skipped`)
    if (dryRun) {
        context.log.trace('dry run: nothing deleted')
        return plan
    }
    await executeDestroy(context, stage, plan.deletions)
    return plan
}

// `stage-service-` is used as a name prefix, so the name may hold nothing that widens it.
export function isServiceName(service: string) {
    return /^[A-Za-z0-9][\w-]*$/u.test(service)
}

function assertSlot(stage: string) {
    if (!isSlot(stage)) {
        throw new Error(
            `destroy only removes the slots w1 to w9, not ${JSON.stringify(stage)}; any other stage is removed by hand.`,
        )
    }
}

/**
Reads only. A resource is planned when its name starts with the stage and its `environment` tag
names the stage too (and, for one service, its `service` tag the service): the name alone would
take whatever someone made by hand under the prefix. Topics carry no service tag and are shared
by publisher and subscribers, so for one service only its functions' subscriptions go.
*/
export async function planDestroy(
    context: Context,
    stage: string,
    service?: string,
): Promise<Plan> {
    assertSlot(stage)
    if (service !== undefined && !isServiceName(service)) {
        throw new Error(`--service must name a service, not ${JSON.stringify(service)}.`)
    }
    const scope = service === undefined ? `${stage}-` : `${stage}-${service}-`
    const functions = await planFunctions(context, stage, service, scope)
    const messaging = await planTopics(context, stage, service, functions.arns)
    const parts = [
        await planRules(context, stage, service, scope),
        messaging.subscriptions,
        await planApis(context, stage, service),
        functions.plan,
        messaging.topics,
        await planRoles(context, stage, service),
        await planLogGroups(context, stage, service, scope, functions),
    ]
    return {
        deletions: parts.flatMap(part => part.deletions),
        skipped: parts.flatMap(part => part.skipped),
    }
}

/**
Deletes exactly `deletions`, each by the identifiers it carries. Every entry is checked against
the stage before the first one is deleted, so a planning mistake cannot reach another stage.
*/
export async function executeDestroy(context: Context, stage: string, deletions: Deletion[]) {
    assertSlot(stage)
    for (const deletion of deletions) {
        assertOfStage(stage, deletion)
    }
    for (const deletion of deletions) {
        await remove(context, deletion)
        context.log.trace(`deleted ${describe(deletion)}`)
    }
}

function assertOfStage(stage: string, deletion: Deletion) {
    const reason = outsideStage(stage, deletion)
    if (reason) {
        throw new Error(`Refusing to delete ${describe(deletion)}: ${reason}. Nothing was deleted.`)
    }
}

// The name is what the plan matched and printed, but a delete is sent by ARN or id for some
// kinds, and by a URL path for others: each identifier must be the named thing's own, and no
// name may carry a character that would address something else.
function outsideStage(stage: string, deletion: Deletion) {
    const prefix = deletion.kind === 'log group' ? `/aws/lambda/${stage}-` : `${stage}-`
    if (!deletion.name.startsWith(prefix)) {
        return `its name does not start with ${prefix}`
    }
    if (!isDeployName(deletion.name.slice(prefix.length))) {
        return 'its name is not one a deploy gives'
    }
    switch (deletion.kind) {
        case 'topic':
            if (topicNameOf(deletion.arn) !== deletion.name) {
                return `its ARN is not that of a topic named ${deletion.name}`
            }
            return undefined
        case 'subscription':
            if (
                topicNameOf(deletion.arn.slice(0, deletion.arn.lastIndexOf(':'))) !== deletion.name
            ) {
                return `its ARN is not that of a subscription to ${deletion.name}`
            }
            return undefined
        case 'api':
            if (!/^[a-z0-9]+$/u.test(deletion.id)) {
                return 'its id is not an API id'
            }
            return undefined
        case 'role policy':
            if (!/^[\w+=,.@-]+$/u.test(deletion.policy)) {
                return 'its policy name is not one IAM gives'
            }
            return undefined
        case 'rule targets':
        case 'rule':
        case 'function':
        case 'role':
        case 'log group':
            return undefined
    }
}

function isDeployName(name: string) {
    return /^[\w.-]+$/u.test(name)
}

function topicNameOf(arn: string) {
    return /^arn:aws[a-z-]*:sns:[a-z0-9-]+:\d{12}:([^:]+)$/u.exec(arn)?.[1]
}

async function remove(context: Context, deletion: Deletion) {
    switch (deletion.kind) {
        case 'rule targets':
            await removeRuleTargets(context, deletion.name, deletion.ids)
            return
        case 'rule':
            await deleteRuleByName(context, deletion.name)
            return
        case 'subscription':
            await unsubscribe(context, deletion.arn)
            return
        case 'api':
            await deleteApi(context, deletion.id)
            return
        case 'function':
            await deleteFunction(context, deletion.name)
            return
        case 'topic':
            await deleteTopic(context, deletion.arn)
            return
        case 'role policy':
            await deleteRolePolicy(context, deletion.name, deletion.policy)
            return
        case 'role':
            await deleteRole(context, deletion.name)
            return
        case 'log group':
            await deleteLogGroup(context, deletion.name)
    }
}

function describe(deletion: Deletion) {
    switch (deletion.kind) {
        case 'rule targets':
            return `targets ${deletion.ids.join(', ')} of rule ${deletion.name}`
        case 'subscription':
            return `subscription ${deletion.arn} of ${deletion.endpoint}`
        case 'api':
            return `api ${deletion.name} (${deletion.id})`
        case 'topic':
            return `topic ${deletion.arn}`
        case 'role policy':
            return `policy ${deletion.policy} of role ${deletion.name}`
        case 'rule':
        case 'function':
        case 'role':
        case 'log group':
            return `${deletion.kind} ${deletion.name}`
    }
}

async function planRules(
    context: Context,
    stage: string,
    service: string | undefined,
    scope: string,
) {
    const plan: Plan = { deletions: [], skipped: [] }
    for (const rule of await listRules(context, scope)) {
        const reason =
            misnamed(rule.Name) ?? mismatch(await getRuleTags(context, rule), stage, service)
        if (reason) {
            plan.skipped.push({ kind: 'rule', name: rule.Name, reason })
            continue
        }
        const ids = await listRuleTargetIds(context, rule.Name)
        if (ids.length !== 0) {
            plan.deletions.push({ kind: 'rule targets', name: rule.Name, ids })
        }
        plan.deletions.push({ kind: 'rule', name: rule.Name })
    }
    return plan
}

async function planApis(context: Context, stage: string, service: string | undefined) {
    const plan: Plan = { deletions: [], skipped: [] }
    for await (const api of getApis(context, stage)) {
        if (service !== undefined && api.name !== `${stage}-${service}`) {
            continue
        }
        const reason = misnamed(api.name) ?? mismatch(api.tags, stage, service)
        if (reason) {
            plan.skipped.push({ kind: 'api', name: `${api.name} (${api.apiId})`, reason })
            continue
        }
        plan.deletions.push({ kind: 'api', name: api.name, id: api.apiId })
    }
    return plan
}

// Tags are read one function at a time: the Lambda control plane throttles at a low shared rate.
async function planFunctions(
    context: Context,
    stage: string,
    service: string | undefined,
    scope: string,
) {
    const plan: Plan = { deletions: [], skipped: [] }
    const arns = new Set<string>()
    const siblings = new Set<string>()
    for (const fn of await listAccountFunctions(context)) {
        if (!fn.FunctionName.startsWith(scope)) {
            continue
        }
        const tags = isDeployName(fn.FunctionName) ? await getFunctionTags(context, fn) : undefined
        if (tags?.service !== undefined && tags.service !== service) {
            siblings.add(tags.service)
        }
        const reason = misnamed(fn.FunctionName) ?? mismatch(tags, stage, service)
        if (reason) {
            plan.skipped.push({ kind: 'function', name: fn.FunctionName, reason })
            continue
        }
        plan.deletions.push({ kind: 'function', name: fn.FunctionName })
        arns.add(fn.FunctionArn)
    }
    return { plan, arns, siblings }
}

async function planTopics(
    context: Context,
    stage: string,
    service: string | undefined,
    functionArns: Set<string>,
) {
    const topics: Plan = { deletions: [], skipped: [] }
    const subscriptions: Plan = { deletions: [], skipped: [] }
    for (const arn of await listTopicArns(context)) {
        const name = topicNameOf(arn)
        if (!name?.startsWith(`${stage}-`)) {
            continue
        }
        const reason =
            misnamed(name) ?? mismatch(await getTopicTags(context, arn), stage, undefined)
        if (reason) {
            topics.skipped.push({ kind: 'topic', name: arn, reason })
            continue
        }
        for (const subscription of await listSubscriptions(context, arn)) {
            if (service !== undefined && !functionArns.has(subscription.Endpoint)) {
                continue
            }
            if (!subscription.SubscriptionArn.startsWith('arn:')) {
                subscriptions.skipped.push({
                    kind: 'subscription',
                    name: `of ${subscription.Endpoint} to ${name}`,
                    reason: `it is ${subscription.SubscriptionArn} and has no ARN to delete it by`,
                })
                continue
            }
            subscriptions.deletions.push({
                kind: 'subscription',
                name,
                arn: subscription.SubscriptionArn,
                endpoint: subscription.Endpoint,
            })
        }
        if (service === undefined) {
            topics.deletions.push({ kind: 'topic', name, arn })
        }
    }
    if (service !== undefined) {
        return { topics: { deletions: [], skipped: [] }, subscriptions }
    }
    return { topics, subscriptions }
}

async function planRoles(context: Context, stage: string, service: string | undefined) {
    const plan: Plan = { deletions: [], skipped: [] }
    for (const name of await listRoleNames(context)) {
        if (!name.startsWith(`${stage}-`)) {
            continue
        }
        if (service !== undefined && name !== `${stage}-${service}-role`) {
            continue
        }
        const reason = await roleMismatch(context, name, stage, service)
        if (reason) {
            plan.skipped.push({ kind: 'role', name, reason })
            continue
        }
        for (const policy of await listRolePolicyNames(context, name)) {
            plan.deletions.push({ kind: 'role policy', name, policy })
        }
        plan.deletions.push({ kind: 'role', name })
    }
    return plan
}

async function roleMismatch(
    context: Context,
    name: string,
    stage: string,
    service: string | undefined,
) {
    if (!name.endsWith('-role') || misnamed(name)) {
        return 'not named as a deploy names a role'
    }
    const reason = mismatch(await getRoleTags(context, name), stage, service)
    if (reason) {
        return reason
    }
    const attached = await listAttachedPolicyNames(context, name)
    if (attached.length !== 0) {
        return `managed policies were attached by hand (${attached.join(', ')})`
    }
    return undefined
}

// Log groups are untagged, so one goes by its function: kept when the function is skipped, taken
// when it is planned or gone. For one service, one named like a sibling's the prefix showed stays.
async function planLogGroups(
    context: Context,
    stage: string,
    service: string | undefined,
    scope: string,
    functions: { plan: Plan; siblings: Set<string> },
) {
    const plan: Plan = { deletions: [], skipped: [] }
    const planned = new Set(functions.plan.deletions.map(fn => `/aws/lambda/${fn.name}`))
    const kept = new Set(functions.plan.skipped.map(fn => `/aws/lambda/${fn.name}`))
    const siblings = service === undefined ? [] : [...functions.siblings]
    for (const name of await listLogGroups(context, `/aws/lambda/${scope}`)) {
        const reason = logGroupKept(name, stage, planned, kept, siblings)
        if (reason) {
            plan.skipped.push({ kind: 'log group', name, reason })
            continue
        }
        plan.deletions.push({ kind: 'log group', name })
    }
    return plan
}

function logGroupKept(
    name: string,
    stage: string,
    planned: Set<string>,
    kept: Set<string>,
    siblings: string[],
) {
    if (kept.has(name)) {
        return 'its function is skipped'
    }
    const sibling = siblings.find(s => name.startsWith(`/aws/lambda/${stage}-${s}-`))
    if (sibling !== undefined && !planned.has(name)) {
        return `its function is gone, and it is named like one of ${sibling}`
    }
    return misnamed(name.slice('/aws/lambda/'.length))
}

function misnamed(name: string) {
    if (isDeployName(name)) {
        return undefined
    }
    return 'not named as a deploy names things'
}

function mismatch(tags: Tags, stage: string, service: string | undefined) {
    if (tags?.environment !== stage) {
        return tags?.environment ? `tagged environment=${tags.environment}` : 'no environment tag'
    }
    if (service !== undefined && tags.service !== service) {
        return tags.service ? `tagged service=${tags.service}` : 'no service tag'
    }
    return undefined
}
