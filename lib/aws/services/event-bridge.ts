import { jsonResponse, okResponse } from '@riddance/fetch'
import type { Reflection } from '@movogo-io/host/reflect'
import { awsRequest, type Context } from '../lite.js'
import { selectOwnFunctions } from './lambda.js'

/**
Makes the stage's schedule rules of this service what the reflected timers are. A rule keeps the
state it has: PutRule without a State enables the rule, which would switch a stage's timers back
on with every deploy. A timer the code no longer has loses its rule and target.
*/
export async function syncEventBridge(
    context: Context,
    region: string,
    account: string,
    prefix: string,
    service: string,
    reflection: Pick<Reflection, 'timers'>,
) {
    const { put, remove } = ruleChanges(
        reflection.timers,
        await getOwnRules(
            context,
            prefix,
            service,
            reflection.timers.map(fn => fn.name),
        ),
    )
    for (const name of remove) {
        await deleteRule(context, name, `${prefix}-${service}-${name}`)
    }
    for (const { name, schedule, state } of put) {
        const fullName = `${prefix}-${service}-${name}`
        await putRule(context, prefix, name, service, fullName, schedule, state)
        await createTarget(context, region, account, name, fullName)
    }
}

/**
A new rule takes the state the service's other rules on the stage have, so a stage whose timers
are switched off does not start one with a deploy. Where they differ it is enabled: one rule
disabled by hand must not keep every later timer from ever running.
*/
export function ruleChanges(
    timers: { name: string; schedule: string }[],
    current: { name: string; state: string }[],
) {
    const allDisabled = current.length !== 0 && current.every(rule => rule.state === 'DISABLED')
    const stateOfNew = allDisabled ? 'DISABLED' : 'ENABLED'
    return {
        put: timers.map(({ name, schedule }) => ({
            name,
            schedule,
            state: current.find(rule => rule.name === name)?.state ?? stateOfNew,
        })),
        remove: current
            .filter(rule => timers.every(timer => timer.name !== rule.name))
            .map(rule => rule.name),
    }
}

// The name prefix of `rentals` also matches the rules of `rentals-v2`, so ownership is decided
// as it is for functions: by a reflected name, else by the tags putRule wrote.
async function getOwnRules(
    context: Context,
    prefix: string,
    service: string,
    reflectedNames: string[],
) {
    const namePrefix = `${prefix}-${service}-`
    const candidates = (await listRules(context, namePrefix)).map(rule => ({
        FunctionName: rule.Name,
        ...rule,
    }))
    const ours = await selectOwnFunctions(candidates, namePrefix, reflectedNames, {
        service,
        environment: prefix,
        tagsOf: rule => getRuleTags(context, rule),
        leftAlone: (rule, tags) => {
            if (typeof tags?.service === 'string' && tags.service !== service) {
                context.log.trace(`left alone: rule ${rule.Name} belongs to ${tags.service}`)
                return
            }
            context.log.warn(
                `left alone: rule ${rule.Name} is not tagged service=${service} environment=${prefix} (tags: ${JSON.stringify(tags ?? {})}); delete or re-tag it by hand if it is a leftover of this service`,
            )
        },
    })
    return ours.map(rule => ({ name: rule.Name.slice(namePrefix.length), state: rule.State }))
}

async function putRule(
    context: Context,
    prefix: string,
    name: string,
    service: string,
    fullName: string,
    schedule: string,
    state: string,
) {
    context.log.trace(`putting event bridge rule ${name} for ${schedule}, ${state}`)
    const r = await events<{ RuleArn: string }>(
        context,
        'PutRule',
        {
            Name: fullName,
            ScheduleExpression: scheduleExpression(schedule),
            State: state,
            Tags: [
                { Key: 'framework', Value: 'riddance' },
                { Key: 'environment', Value: prefix },
                { Key: 'service', Value: service },
            ],
        },
        'creating event bridge schedule',
    )
    if (!r.RuleArn) {
        throw new Error('Unexpected schedule rule response')
    }
}

// A rule cannot be deleted while it has targets.
async function deleteRule(context: Context, name: string, fullName: string) {
    context.log.trace(`deleting event bridge rule ${name}, whose timer is gone`)
    const ids = await listRuleTargetIds(context, fullName)
    if (ids.length !== 0) {
        await removeRuleTargets(context, fullName, ids)
    }
    await deleteRuleByName(context, fullName)
}

export async function listRules(context: Context, namePrefix: string) {
    const rules = []
    for (let next: string | undefined; ;) {
        const page = await events<{
            Rules: { Name: string; Arn: string; State: string }[]
            NextToken?: string
        }>(context, 'ListRules', { NamePrefix: namePrefix, NextToken: next }, 'listing rules')
        rules.push(...page.Rules)
        if (!page.NextToken) {
            return rules
        }
        next = page.NextToken
    }
}

export async function getRuleTags(context: Context, rule: { Name: string; Arn: string }) {
    const { Tags: tags } = await events<{ Tags?: { Key: string; Value: string }[] }>(
        context,
        'ListTagsForResource',
        { ResourceARN: rule.Arn },
        `reading tags of rule ${rule.Name}`,
    )
    return Object.fromEntries((tags ?? []).map(tag => [tag.Key, tag.Value]))
}

export async function listRuleTargetIds(context: Context, fullName: string) {
    const { Targets: targets } = await events<{ Targets: { Id: string }[] }>(
        context,
        'ListTargetsByRule',
        { Rule: fullName },
        `listing targets of rule ${fullName}`,
    )
    return targets.map(target => target.Id)
}

export async function removeRuleTargets(context: Context, fullName: string, ids: string[]) {
    const removed = await events<{ FailedEntryCount: number }>(
        context,
        'RemoveTargets',
        { Rule: fullName, Ids: ids },
        `removing targets of rule ${fullName}`,
    )
    if (removed.FailedEntryCount !== 0) {
        throw new Error(`Could not remove the targets of rule ${fullName}.`)
    }
}

export async function deleteRuleByName(context: Context, fullName: string) {
    await okResponse(
        eventsRequest(context, 'DeleteRule', { Name: fullName }),
        `Error deleting rule ${fullName}.`,
    )
}

function events<T>(context: Context, action: string, body: unknown, doing: string) {
    return jsonResponse<T>(eventsRequest(context, action, body), `Error ${doing}.`)
}

function eventsRequest(context: Context, action: string, body: unknown) {
    return awsRequest(
        context,
        'POST',
        'events',
        '',
        body,
        `AWSEvents.${action}`,
        'application/x-amz-json-1.1',
    )
}

async function createTarget(
    context: Context,
    region: string,
    account: string,
    name: string,
    fullName: string,
) {
    context.log.trace(`creating event bridge target ${name}`)
    const r = await jsonResponse<{ FailedEntryCount: number }>(
        awsRequest(
            context,
            'POST',
            'events',
            '',
            {
                Rule: fullName,
                Targets: [
                    {
                        Id: fullName,
                        Arn: `arn:aws:lambda:${region}:${account}:function:${fullName}`,
                    },
                ],
            },
            'AWSEvents.PutTargets',
            'application/x-amz-json-1.1',
        ),
        'Error creating event bridge schedule.',
    )
    if (r.FailedEntryCount !== 0) {
        throw new Error('Unexpected schedule rule response')
    }
}

function scheduleExpression(schedule: string) {
    const [min, h, dom, m, dow] = schedule.split(' ', 5)
    if (!min || !h || !dom || !m || !dow) {
        throw new Error('Invalid cron expression: ' + schedule)
    }
    return `cron(${min} ${h} ${dom} ${m} ${dow.replace('*', '?')} *)`
}
