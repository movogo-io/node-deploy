import { jsonResponse } from '@riddance/fetch'
import { type Context, awsFormRequest } from '../lite.js'

export async function callerIdentity(context: Context) {
    const {
        GetCallerIdentityResponse: {
            GetCallerIdentityResult: { Arn: arn, Account: account },
        },
    } = await jsonResponse<{
        GetCallerIdentityResponse: { GetCallerIdentityResult: { Arn: string; Account: string } }
    }>(
        awsFormRequest(
            context,
            'POST',
            'sts',
            '',
            new URLSearchParams({ Action: 'GetCallerIdentity', Version: '2011-06-15' }),
        ),
        'Error getting caller identity.',
    )
    return { arn, account }
}
