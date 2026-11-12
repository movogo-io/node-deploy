import { get } from '@riddance/service/http'
// @ts-expect-error A layer provides it at run time.
import browser from '@layer/browser'

get('render', async () => {
    // @ts-expect-error A layer provides it at run time.
    const { print } = await import('@layer/browser/pdf')
    return { body: { bytes: (await print(browser.path)).length } }
})
