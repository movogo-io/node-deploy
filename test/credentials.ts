import assert from 'node:assert/strict'
import { resolveCredentials } from '../lib/aws/credentials.js'
import { callerArn } from '../lib/aws/services/sts.js'
import { context, stubAws } from './lib/aws.js'

const exportCredentials = () => Promise.reject(new Error('not expected'))

describe('credentials', () => {
    const files: { [path: string]: string } = {
        '/aws/credentials': `
[default]
aws_access_key_id = default-id
aws_secret_access_key = default-secret
region = eu-west-1

[dev]
aws_access_key_id = dev-id
aws_secret_access_key = dev-secret
aws_session_token = dev-token
`,
        '/aws/config': `
[default]
region = eu-west-1

[profile dev]
region = eu-north-1

# a role profile holds no keys of its own
[profile w1]
role_arn = arn:aws:iam::123456789012:role/slot-runner-w1
source_profile = keys
region = eu-north-1
`,
    }
    const paths = {
        AWS_CONFIG_FILE: '/aws/config',
        AWS_SHARED_CREDENTIALS_FILE: '/aws/credentials',
    }
    const readFile = (path: string) => Promise.resolve(files[path])

    it('refuses a stage without a profile instead of falling back to [default]', async () => {
        await assert.rejects(
            resolveCredentials(undefined, 'staging', { env: paths, readFile, exportCredentials }),
            {
                message:
                    'AWS profile staging not found in /aws/config or /aws/credentials. Add a profile named like the stage or set AWS_PROFILE; [default] is never used in its place.',
            },
        )
    })

    it('refuses a profile that is in neither file when the files are missing', async () => {
        await assert.rejects(
            resolveCredentials(undefined, 'dev', {
                env: paths,
                readFile: () => Promise.resolve(undefined),
                exportCredentials,
            }),
            { message: /^AWS profile dev not found/u },
        )
    })

    it('refuses to guess a region', async () => {
        await assert.rejects(
            resolveCredentials(undefined, 'staging', {
                env: { ...paths, AWS_ACCESS_KEY_ID: 'env-id', AWS_SECRET_ACCESS_KEY: 'env-secret' },
                readFile,
                exportCredentials,
            }),
            { message: 'No AWS region: set AWS_REGION or give profile staging a region.' },
        )
    })

    it('reads the profile named like the stage', async () => {
        assert.deepStrictEqual(
            await resolveCredentials(undefined, 'dev', { env: paths, readFile, exportCredentials }),
            {
                AWS_REGION: 'eu-north-1',
                AWS_ACCESS_KEY_ID: 'dev-id',
                AWS_SECRET_ACCESS_KEY: 'dev-secret',
                AWS_SESSION_TOKEN: 'dev-token',
            },
        )
    })

    it('reads AWS_PROFILE in place of the stage name', async () => {
        assert.deepStrictEqual(
            await resolveCredentials(undefined, 'w1', {
                env: { ...paths, AWS_PROFILE: 'dev' },
                readFile,
                exportCredentials,
            }),
            {
                AWS_REGION: 'eu-north-1',
                AWS_ACCESS_KEY_ID: 'dev-id',
                AWS_SECRET_ACCESS_KEY: 'dev-secret',
                AWS_SESSION_TOKEN: 'dev-token',
            },
        )
    })

    it('uses environment keys whenever present, without reading a file', async () => {
        assert.deepStrictEqual(
            await resolveCredentials(undefined, 'dev', {
                env: {
                    ...paths,
                    AWS_REGION: 'us-east-1',
                    AWS_ACCESS_KEY_ID: 'env-id',
                    AWS_SECRET_ACCESS_KEY: 'env-secret',
                    AWS_SESSION_TOKEN: 'env-token',
                },
                readFile: () => Promise.reject(new Error('not expected')),
                exportCredentials,
            }),
            {
                AWS_REGION: 'us-east-1',
                AWS_ACCESS_KEY_ID: 'env-id',
                AWS_SECRET_ACCESS_KEY: 'env-secret',
                AWS_SESSION_TOKEN: 'env-token',
            },
        )
    })

    it('takes only the region from the profile when environment keys lack one', async () => {
        assert.deepStrictEqual(
            await resolveCredentials(undefined, 'dev', {
                env: { ...paths, AWS_ACCESS_KEY_ID: 'env-id', AWS_SECRET_ACCESS_KEY: 'env-secret' },
                readFile,
                exportCredentials,
            }),
            {
                AWS_REGION: 'eu-north-1',
                AWS_ACCESS_KEY_ID: 'env-id',
                AWS_SECRET_ACCESS_KEY: 'env-secret',
                AWS_SESSION_TOKEN: undefined,
            },
        )
    })

    it('resolves a role profile through the CLI', async () => {
        const exportedFor: string[] = []
        assert.deepStrictEqual(
            await resolveCredentials(undefined, 'w1', {
                env: paths,
                readFile,
                exportCredentials: profile => {
                    exportedFor.push(profile)
                    return Promise.resolve(
                        JSON.stringify({
                            Version: 1,
                            AccessKeyId: 'role-id',
                            SecretAccessKey: 'role-secret',
                            SessionToken: 'role-token',
                            Expiration: '2026-11-12T20:00:00+00:00',
                        }),
                    )
                },
            }),
            {
                AWS_REGION: 'eu-north-1',
                AWS_ACCESS_KEY_ID: 'role-id',
                AWS_SECRET_ACCESS_KEY: 'role-secret',
                AWS_SESSION_TOKEN: 'role-token',
            },
        )
        assert.deepStrictEqual(exportedFor, ['w1'])
    })

    it('never quotes what the CLI exported when it cannot be read', async () => {
        await assert.rejects(
            resolveCredentials(undefined, 'w1', {
                env: paths,
                readFile,
                exportCredentials: () =>
                    Promise.resolve('{"SecretAccessKey":"role-secret","AccessKeyId":'),
            }),
            { message: 'aws configure export-credentials gave no access key for profile w1.' },
        )
    })
})

describe('caller identity', () => {
    it('asks STS who the caller is', async () => {
        const aws = stubAws(() => ({
            GetCallerIdentityResponse: {
                GetCallerIdentityResult: {
                    Account: '123456789012',
                    Arn: 'arn:aws:sts::123456789012:assumed-role/slot-runner-w1/session',
                    UserId: 'id',
                },
            },
        }))
        try {
            assert.strictEqual(
                await callerArn(context),
                'arn:aws:sts::123456789012:assumed-role/slot-runner-w1/session',
            )
            assert.deepStrictEqual(aws.calls, [
                {
                    method: 'POST',
                    service: 'sts',
                    path: '/',
                    action: 'GetCallerIdentity',
                    parameters: { Action: 'GetCallerIdentity', Version: '2011-06-15' },
                },
            ])
        } finally {
            aws.restore()
        }
    })
})
