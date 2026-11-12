import assert from 'node:assert/strict'

/**
Preloaded with `node --import` into a command a test spawns, where stubAws cannot reach: the
caller's identity is answered and every other request fails, so the command never reaches AWS.
*/

// @riddance/fetch extends the dispatcher that the built-in fetch installs with its first call.
await assert.rejects(fetch(''))

// eslint-disable-next-line unicorn/no-global-object-property-assignment -- the stub is the point
globalThis.fetch = (input, init) => {
    const url = URL.parse(input instanceof Request ? input.url : input.toString())
    if (
        url?.hostname.startsWith('sts.') === true &&
        init?.body === 'Action=GetCallerIdentity&Version=2011-06-15'
    ) {
        return Promise.resolve(
            Response.json({
                GetCallerIdentityResponse: {
                    GetCallerIdentityResult: {
                        Arn: 'arn:aws:iam::123456789012:user/offline',
                        Account: '123456789012',
                    },
                },
            }),
        )
    }
    return Promise.reject(
        new Error(`Offline: no answer for ${init?.method ?? 'GET'} ${url?.href ?? 'no URL'}`),
    )
}
