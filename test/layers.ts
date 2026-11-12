/* eslint-disable unicorn/no-global-object-property-assignment */
// spell-checker: ignore rendr AKIDEXAMPLE
import assert from 'node:assert/strict'
import { desiredLayers, publishLayer } from '../lib/aws/services/layers.js'

describe('layers', () => {
    const functionNames = ['render', 'get']
    const chromium = 'arn:aws:lambda:eu-north-1:123456789012:layer:chromium:3'
    const fonts = 'arn:aws:lambda:eu-north-1:123456789012:layer:fonts:12'

    it('refuses layers that are no map of function names', () => {
        assert.throws(() => desiredLayers(functionNames, { layers: [chromium] }), {
            message: 'aws.layers must map function names to lists of layer version ARNs.',
        })
        assert.throws(() => desiredLayers(functionNames, { layers: 'chromium' }), {
            message: 'aws.layers must map function names to lists of layer version ARNs.',
        })
    })

    it('refuses a function name the service has no function of', () => {
        assert.throws(() => desiredLayers(functionNames, { layers: { rendr: [chromium] } }), {
            message: 'aws.layers names rendr, which the service has no function of.',
        })
    })

    it('refuses anything but a list of layer version ARNs', () => {
        assert.throws(() => desiredLayers(functionNames, { layers: { render: chromium } }), {
            message: 'aws.layers of render must be a list of layer version ARNs.',
        })
        assert.throws(() => desiredLayers(functionNames, { layers: { render: [3] } }), {
            message: 'aws.layers of render must be a list of layer version ARNs.',
        })
        assert.throws(
            () =>
                desiredLayers(functionNames, {
                    layers: { render: ['arn:aws:lambda:eu-north-1:123456789012:layer:chromium'] },
                }),
            {
                message:
                    'aws.layers of render has arn:aws:lambda:eu-north-1:123456789012:layer:chromium, which is no layer version ARN (arn:aws:lambda:<region>:<account>:layer:<name>:<version>).',
            },
        )
    })

    it('refuses a layer version named twice, and more layers than Lambda takes', () => {
        assert.throws(
            () => desiredLayers(functionNames, { layers: { render: [chromium, chromium] } }),
            { message: 'aws.layers of render names a layer version twice.' },
        )
        assert.throws(
            () =>
                desiredLayers(functionNames, {
                    layers: { render: [1, 2, 3, 4, 5, 6].map(v => `${chromium.slice(0, -1)}${v}`) },
                }),
            { message: 'aws.layers of render names 6 layers; Lambda takes at most 5.' },
        )
    })

    it('has no layers when the glue names none', () => {
        assert.deepStrictEqual(desiredLayers(functionNames, undefined), {})
        assert.deepStrictEqual(desiredLayers(functionNames, { concurrency: { get: 2 } }), {})
    })

    it("takes each function's layers in the order the glue names them", () => {
        assert.deepStrictEqual(
            desiredLayers(functionNames, { layers: { render: [fonts, chromium], get: [] } }),
            { render: [fonts, chromium], get: [] },
        )
    })
})

describe('publish layer', () => {
    const context = {
        log: {
            trace() {
                //
            },
            warn() {
                //
            },
        },
        env: {
            AWS_REGION: 'eu-north-1',
            AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE',
            AWS_SECRET_ACCESS_KEY: 'secret',
        },
    }
    const zip = Buffer.from('a zip')
    const zipSha256 = '9a44557465efc644b7117e93eaf13c33cd956f5f4f12ca21bd51ae94ea97169a'
    const versions = 'https://lambda.eu-north-1.amazonaws.com/2018-10-31/layers/chromium/versions'
    const realFetch = fetch
    let requests: { method: string; url: string; body: unknown }[] = []

    function answer(responses: unknown[]) {
        requests = []
        globalThis.fetch = (input, init) => {
            const body = init?.body
            requests.push({
                method: init?.method ?? 'GET',
                url: new URL(input instanceof Request ? input.url : input).href,
                body: typeof body === 'string' ? JSON.parse(body) : body,
            })
            const response: unknown = responses[requests.length - 1]
            return Promise.resolve(
                response instanceof Response ? response : Response.json(response),
            )
        }
    }

    afterEach(() => {
        globalThis.fetch = realFetch
    })

    it('refuses a name Lambda would refuse', async () => {
        await assert.rejects(publishLayer(context, zip, 'chromium:1', undefined), {
            message: 'chromium:1 is no layer name: letters, digits, - and _, at most 140.',
        })
    })

    it('refuses a zip over 50 MB without a bucket to upload it through', async () => {
        await assert.rejects(
            publishLayer(context, Buffer.alloc(50 * 1024 * 1024 + 1), 'chromium', undefined),
            {
                message:
                    'The zip is 51 MB; Lambda takes at most 50 MB in the request, so name an S3 bucket in the same region to upload it through.',
            },
        )
    })

    it('publishes the zip in the request and returns the version ARN', async () => {
        answer([
            { LayerVersions: [] },
            { LayerVersionArn: 'arn:aws:lambda:eu-north-1:123456789012:layer:chromium:1' },
        ])

        const arn = await publishLayer(context, zip, 'chromium', undefined)

        assert.strictEqual(arn, 'arn:aws:lambda:eu-north-1:123456789012:layer:chromium:1')
        assert.deepStrictEqual(requests, [
            { method: 'GET', url: versions, body: undefined },
            {
                method: 'POST',
                url: versions,
                body: {
                    Content: { ZipFile: zip.toString('base64') },
                    Description: `sha256:${zipSha256}`,
                },
            },
        ])
    })

    it('returns the version already published from the same zip', async () => {
        answer([
            {
                LayerVersions: [{ LayerVersionArn: 'arn:other', Description: 'sha256:00' }],
                NextMarker: 'next',
            },
            {
                LayerVersions: [
                    { LayerVersionArn: 'arn:same', Description: `sha256:${zipSha256}` },
                ],
            },
        ])

        const arn = await publishLayer(context, zip, 'chromium', undefined)

        assert.strictEqual(arn, 'arn:same')
        assert.deepStrictEqual(
            requests.map(r => `${r.method} ${r.url}`),
            [`GET ${versions}`, `GET ${versions}?Marker=next`],
        )
    })

    it('uploads a zip over 50 MB through the bucket and removes it once published', async () => {
        const big = Buffer.alloc(50 * 1024 * 1024 + 1)
        const bigSha256 = '50dac11b8750f1398495b580e1f6158fef5ddbdc7f6500e7117c2e12f59c88e9'
        const object = `https://s3.eu-north-1.amazonaws.com/layer-uploads/layers/chromium/${bigSha256}.zip`
        answer([
            { LayerVersions: [] },
            {},
            { LayerVersionArn: 'arn:aws:lambda:eu-north-1:123456789012:layer:chromium:2' },
            {},
        ])

        const arn = await publishLayer(context, big, 'chromium', 'layer-uploads')

        assert.strictEqual(arn, 'arn:aws:lambda:eu-north-1:123456789012:layer:chromium:2')
        assert.deepStrictEqual(requests, [
            { method: 'GET', url: versions, body: undefined },
            { method: 'PUT', url: object, body: big },
            {
                method: 'POST',
                url: versions,
                body: {
                    Content: {
                        S3Bucket: 'layer-uploads',
                        S3Key: `layers/chromium/${bigSha256}.zip`,
                    },
                    Description: `sha256:${bigSha256}`,
                },
            },
            { method: 'DELETE', url: object, body: undefined },
        ])
    })

    it('refuses a bucket name S3 would refuse', async () => {
        await assert.rejects(publishLayer(context, zip, 'chromium', 'Layer_Uploads'), {
            message: 'Layer_Uploads is no S3 bucket name.',
        })
    })

    it('removes an upload a run left behind when the version is already published', async () => {
        const big = Buffer.alloc(50 * 1024 * 1024 + 1)
        answer([
            {
                LayerVersions: [
                    {
                        LayerVersionArn: 'arn:published',
                        Description:
                            'sha256:50dac11b8750f1398495b580e1f6158fef5ddbdc7f6500e7117c2e12f59c88e9',
                    },
                ],
            },
            {},
        ])

        const arn = await publishLayer(context, big, 'chromium', 'layer-uploads')

        assert.strictEqual(arn, 'arn:published')
        assert.deepStrictEqual(
            requests.map(r => r.method),
            ['GET', 'DELETE'],
        )
    })

    it('removes the uploaded zip when publishing fails', async () => {
        const big = Buffer.alloc(50 * 1024 * 1024 + 1)
        answer([
            Response.json({ LayerVersions: [] }),
            Response.json({}),
            Response.json({ message: 'Denied' }, { status: 403 }),
            Response.json({}),
        ])

        await assert.rejects(publishLayer(context, big, 'chromium', 'layer-uploads'), {
            message: 'Error publishing a version of layer chromium',
        })
        assert.deepStrictEqual(
            requests.map(r => r.method),
            ['GET', 'PUT', 'POST', 'DELETE'],
        )
    })
})
