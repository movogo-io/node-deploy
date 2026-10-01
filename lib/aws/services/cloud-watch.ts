import type { Json } from '@movogo-io/host/lib/context'

// spell-checker: ignore ispresent, CWLI

export function logQueryLink(
    region: string,
    prefix: string,
    service: string,
    names: string[],
    revision: string | undefined,
) {
    return `https://${region}.console.aws.amazon.com/cloudwatch/home?#logsV2:logs-insights$3FqueryDetail$3D${encodeURIComponent(
        serializeObject({
            end: 0,
            start: -1800,
            timeType: 'RELATIVE',
            tz: 'UTC',
            unit: 'seconds',
            editorString: `fields @timestamp, level, message, meta.fileName, error.message, request.uri
| filter ispresent(level) # and level != 'trace'
| filter message != "Measurement of flush time" and message != "Measurement of execution time"${
                revision
                    ? `
| filter meta.revision = "${revision}"`
                    : ''
            }
| sort @timestamp desc
| limit 10000`,
            source: names.map(name => `/aws/lambda/${prefix}-${service}-${name}`),
            lang: 'CWLI',
        }),
    ).replaceAll("'", '%27')}`
}

function serializeValue(v: Json): string {
    if (v === null) {
        return 'null'
    }
    if (typeof v === 'string') {
        return `'${awsEscape(v)}`
    }
    if (typeof v === 'number' || typeof v === 'boolean') {
        return v.toString()
    }
    if (Array.isArray(v)) {
        return serializeArray(v as Json[])
    }
    return serializeObject(v as { [key: string]: Json })
}

function serializeArray(a: Json[]): string {
    return `(~${a.map(x => serializeValue(x)).join('~')})`
}

function serializeObject(o: { [key: string]: Json }): string {
    return `~(${Object.entries(o)
        .map(([k, v]) => `${k}~${serializeValue(v)}`)
        .join('~')})`
}

function awsEscape(s: string): string {
    let out = ''
    for (const ch of s) {
        const code = ch.codePointAt(0)
        if (!code) {
            break
        }
        const isAlphaNum =
            (code >= 0x30 && code <= 0x39) ||
            (code >= 0x41 && code <= 0x5a) ||
            (code >= 0x61 && code <= 0x7a)
        if (isAlphaNum || ch === '-' || ch === '_' || ch === '.' || ch === '~') {
            out += ch
        } else {
            out += '*' + code.toString(16).padStart(2, '0')
        }
    }
    return out
}
