import { jsonResponse } from '@riddance/fetch'
import { type Context, awsRequest, retry } from '../lite.js'

// The attribute @movogo-io/dynamodb-docs projects a document's expiry into, and the one it
// enables TTL on when it creates a table on first write.
const timeToLiveAttribute = 'expiresAt'

export type TimeToLiveDescription = {
    TimeToLiveStatus?: 'ENABLING' | 'DISABLING' | 'ENABLED' | 'DISABLED'
    AttributeName?: string
}

/**
Enables TTL on every table of the service that lacks it. The driver enables TTL right after it
creates a table, so a table whose creation failed half way (a role without DescribeTable or
UpdateTimeToLive) or that predates the driver doing so never gets it: no later write creates
the table again. Tables are read one at a time: the control plane throttles at a low shared rate.
*/
export async function syncTimeToLive(context: Context, prefix: string, service: string) {
    for (const table of await listTables(context, `${prefix}.${service}.`)) {
        const { TimeToLiveDescription: description } = await dynamoRequest<{
            TimeToLiveDescription?: TimeToLiveDescription
        }>(context, 'DescribeTimeToLive', { TableName: table })
        switch (timeToLiveAction(description)) {
            case 'none':
                continue
            case 'enable':
                context.log.trace(`enabling time to live on ${table}`)
                await dynamoRequest(context, 'UpdateTimeToLive', {
                    TableName: table,
                    TimeToLiveSpecification: { AttributeName: timeToLiveAttribute, Enabled: true },
                })
                continue
            case 'leave':
                context.log.warn(
                    `left alone: ${table} has time to live ${JSON.stringify(description)}, not on ${timeToLiveAttribute}; expired documents are kept until it is fixed by hand`,
                )
                continue
        }
    }
}

/**
A table with TTL on another attribute, or being disabled, was set up by hand: it is reported,
never changed.
*/
export function timeToLiveAction(description: TimeToLiveDescription | undefined) {
    switch (description?.TimeToLiveStatus) {
        case undefined:
        case 'DISABLED':
            return 'enable'
        case 'ENABLED':
        case 'ENABLING':
            if (description.AttributeName === timeToLiveAttribute) {
                return 'none'
            }
            return 'leave'
        case 'DISABLING':
            return 'leave'
    }
}

async function listTables(context: Context, tablePrefix: string) {
    const tables: string[] = []
    for (let start: string | undefined; ;) {
        const page = await dynamoRequest<{ TableNames: string[]; LastEvaluatedTableName?: string }>(
            context,
            'ListTables',
            { ExclusiveStartTableName: start },
        )
        tables.push(...page.TableNames.filter(name => name.startsWith(tablePrefix)))
        if (!page.LastEvaluatedTableName) {
            return tables
        }
        start = page.LastEvaluatedTableName
    }
}

function dynamoRequest<T>(context: Context, action: string, body: unknown) {
    return jsonResponse<T>(
        retry(
            context.log,
            () =>
                awsRequest(
                    context,
                    'POST',
                    'dynamodb',
                    '/',
                    body,
                    `DynamoDB_20120810.${action}`,
                    'application/x-amz-json-1.0',
                ),
            r => (r.status >= 500 ? 5 : undefined),
        ),
        `Error calling DynamoDB ${action}`,
    )
}
