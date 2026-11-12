import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type AwsEnv = {
    AWS_REGION: string
    AWS_ACCESS_KEY_ID: string
    AWS_SECRET_ACCESS_KEY: string
    AWS_SESSION_TOKEN?: string
}

export type CredentialSources = {
    env: { [key: string]: string | undefined }
    readFile: (path: string) => Promise<string | undefined>
    exportCredentials: (profile: string) => Promise<string>
}

/**
Whose credentials a deploy to `stage` runs under. The profile is `AWS_PROFILE`, else the stage's
own name, and never `[default]`: a stage without a profile of its own must fail here, not deploy
as whoever the default happens to be. Keys in the environment win over any profile.
*/
export async function resolveCredentials(
    region: string | undefined,
    stage: string,
    sources: CredentialSources = localSources,
): Promise<AwsEnv> {
    const { env } = sources
    const profile = profileFor(env, stage)
    const half = halfKey(env)
    if (half) {
        throw new Error(
            `The environment holds ${half}. Set both or neither: half a key is not passed over in favour of profile ${profile}.`,
        )
    }
    const regionGiven = region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION
    if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
        return {
            AWS_REGION:
                regionGiven ??
                (await profileSettings(sources, profile))?.region ??
                noRegion(profile),
            AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
            AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
            AWS_SESSION_TOKEN: env.AWS_SESSION_TOKEN,
        }
    }
    const settings = await profileSettings(sources, profile)
    if (!settings) {
        throw new Error(
            `AWS profile ${profile} not found in ${configFile(env)} or ${credentialsFile(env)}. Add a profile named like the stage or set AWS_PROFILE; [default] is never used in its place.`,
        )
    }
    const AWS_REGION = regionGiven ?? settings.region ?? noRegion(profile)
    // The CLI assumes the role of a profile that names one even when the profile holds keys too
    // (they are then the role's source), so the keys alone would be another, wider identity.
    if (!settings.role_arn && settings.aws_access_key_id && settings.aws_secret_access_key) {
        return {
            AWS_REGION,
            AWS_ACCESS_KEY_ID: settings.aws_access_key_id,
            AWS_SECRET_ACCESS_KEY: settings.aws_secret_access_key,
            AWS_SESSION_TOKEN: settings.aws_session_token,
        }
    }
    return { AWS_REGION, ...parseExported(await sources.exportCredentials(profile), profile) }
}

function halfKey(env: CredentialSources['env']) {
    if (env.AWS_ACCESS_KEY_ID && !env.AWS_SECRET_ACCESS_KEY) {
        return 'AWS_ACCESS_KEY_ID without AWS_SECRET_ACCESS_KEY'
    }
    if (env.AWS_SECRET_ACCESS_KEY && !env.AWS_ACCESS_KEY_ID) {
        return 'AWS_SECRET_ACCESS_KEY without AWS_ACCESS_KEY_ID'
    }
    return undefined
}

function profileFor(env: CredentialSources['env'], stage: string) {
    if (env.AWS_PROFILE) {
        return env.AWS_PROFILE
    }
    return stage
}

async function profileSettings(sources: CredentialSources, profile: string) {
    const [config, credentials] = await Promise.all([
        sources.readFile(configFile(sources.env)),
        sources.readFile(credentialsFile(sources.env)),
    ])
    const sections = [config, credentials].flatMap(text => sectionsOf(text ?? '', profile))
    if (sections.length === 0) {
        return undefined
    }
    return Object.fromEntries(sections.flat())
}

// A config file heads a profile `[profile name]` and a credentials file `[name]`; one file may
// serve as both, so either heading is read in either file.
function sectionsOf(text: string, profile: string) {
    const sections: [string, string][][] = []
    let current: [string, string][] | undefined
    for (const line of text.split('\n').map(l => l.trim())) {
        if (!line || line.startsWith('#') || line.startsWith(';')) {
            continue
        }
        if (line.startsWith('[')) {
            current = undefined
            if (line === `[${profile}]` || line === `[profile ${profile}]`) {
                current = []
                sections.push(current)
            }
            continue
        }
        const separatorIx = line.indexOf('=')
        if (current && separatorIx !== -1) {
            current.push([line.slice(0, separatorIx).trim(), line.slice(separatorIx + 1).trim()])
        }
    }
    return sections
}

// The output holds the secret key, so no error here may quote it.
function parseExported(output: string, profile: string) {
    const exported = parseJson(output)
    if (
        typeof exported !== 'object' ||
        exported === null ||
        !('AccessKeyId' in exported) ||
        !('SecretAccessKey' in exported) ||
        typeof exported.AccessKeyId !== 'string' ||
        typeof exported.SecretAccessKey !== 'string'
    ) {
        throw new Error(
            `aws configure export-credentials gave no access key for profile ${profile}.`,
        )
    }
    if (
        'Expiration' in exported &&
        typeof exported.Expiration === 'string' &&
        new Date(exported.Expiration).getTime() < Date.now()
    ) {
        throw new Error(
            `aws configure export-credentials gave credentials for profile ${profile} that expired at ${exported.Expiration}.`,
        )
    }
    return {
        AWS_ACCESS_KEY_ID: exported.AccessKeyId,
        AWS_SECRET_ACCESS_KEY: exported.SecretAccessKey,
        AWS_SESSION_TOKEN:
            'SessionToken' in exported && typeof exported.SessionToken === 'string'
                ? exported.SessionToken
                : undefined,
    }
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text)
    } catch {
        return undefined
    }
}

function configFile(env: CredentialSources['env']) {
    return env.AWS_CONFIG_FILE ?? join(homedir(), '.aws', 'config')
}

function credentialsFile(env: CredentialSources['env']) {
    return env.AWS_SHARED_CREDENTIALS_FILE ?? join(homedir(), '.aws', 'credentials')
}

function noRegion(profile: string): never {
    throw new Error(`No AWS region: set AWS_REGION or give profile ${profile} a region.`)
}

const localSources: CredentialSources = {
    env: process.env,
    readFile: async path => {
        try {
            return await readFile(path, 'utf-8')
        } catch (e) {
            if (typeof e === 'object' && e !== null && 'code' in e && e.code === 'ENOENT') {
                return undefined
            }
            throw e
        }
    },
    exportCredentials: profile =>
        new Promise((resolve, reject) => {
            execFile(
                'aws',
                ['configure', 'export-credentials', '--profile', profile, '--format', 'process'],
                (error, stdout, stderr) => {
                    if (error) {
                        reject(
                            new Error(
                                `Profile ${profile} has no static keys, and aws configure export-credentials could not resolve it: ${stderr.trim() || error.message}`,
                            ),
                        )
                        return
                    }
                    resolve(stdout)
                },
            )
        }),
}
