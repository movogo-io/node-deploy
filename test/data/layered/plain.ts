import { get } from '@riddance/service/http'

get('plain', () => ({ body: { message: 'Bundled whole.' } }))
