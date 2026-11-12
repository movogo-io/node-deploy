import { jsonResponse, okResponse } from '@riddance/fetch'
import { createHash } from 'node:crypto'
import { functionLists } from '../../glue.js'
import { type Context, awsBinaryRequest, awsRequest } from '../lite.js'

export type Layers = { [functionName: string]: string[] }

const layerVersionArnPattern = /^arn:aws[a-z-]*:lambda:[a-z0-9-]+:\d{12}:layer:[\w-]+:\d+$/u
const layersPerFunctionMax = 5
// Lambda takes a zip this large in the request itself; a larger one goes through S3.
const inlineZipBytesMax = 50 * 1024 * 1024

/**
The layer version ARNs each function is deployed with, from the glue's `aws.layers`, keyed by
function name. A glue file is per stage, so it holds that stage's ARNs. The order is kept: a
later layer's files overwrite an earlier one's in `/opt`.
*/
export function desiredLayers(functionNames: string[], glueAws: unknown): Layers {
    const layers = functionLists(functionNames, glueAws, 'layers', 'layer version ARNs')
    for (const [name, arns] of Object.entries(layers)) {
        const malformed = arns.filter(arn => !layerVersionArnPattern.test(arn))
        if (malformed.length !== 0) {
            throw new Error(
                `aws.layers of ${name} has ${malformed.join(', ')}, which is no layer version ARN (arn:aws:lambda:<region>:<account>:layer:<name>:<version>).`,
            )
        }
        if (new Set(arns).size !== arns.length) {
            throw new Error(`aws.layers of ${name} names a layer version twice.`)
        }
        if (layersPerFunctionMax < arns.length) {
            throw new Error(
                `aws.layers of ${name} names ${arns.length} layers; Lambda takes at most ${layersPerFunctionMax}.`,
            )
        }
    }
    return layers
}

/**
Publishes the zip as a version of the layer and returns that version's ARN. A version already
published from the same zip is returned instead, so a rerun converges on it. A zip over 50 MB
is uploaded to the bucket first, and removed from it once Lambda has its copy.
*/
export async function publishLayer(
    context: Context,
    zip: Buffer,
    name: string,
    bucket: string | undefined,
) {
    if (!/^[\w-]{1,140}$/u.test(name)) {
        throw new Error(`${name} is no layer name: letters, digits, - and _, at most 140.`)
    }
    if (bucket !== undefined && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket)) {
        throw new Error(`${bucket} is no S3 bucket name.`)
    }
    const description = `sha256:${createHash('sha256').update(zip).digest('hex')}`
    const published = await findVersion(context, name, description)
    if (zip.length <= inlineZipBytesMax) {
        return (
            published ??
            (await publishVersion(context, name, description, {
                ZipFile: zip.toString('base64'),
            }))
        )
    }
    if (bucket) {
        return await publishThroughBucket(context, name, description, zip, bucket, published)
    }
    if (published) {
        return published
    }
    throw new Error(
        `The zip is ${Math.ceil(zip.length / 1024 / 1024)} MB; Lambda takes at most 50 MB in the request, so name an S3 bucket in the same region to upload it through.`,
    )
}

async function publishThroughBucket(
    context: Context,
    name: string,
    description: string,
    zip: Buffer,
    bucket: string,
    published: string | undefined,
) {
    const key = `layers/${name}/${description.slice('sha256:'.length)}.zip`
    const objectPath = `/${bucket}/${key}`
    const removeUpload = () =>
        okResponse(
            awsRequest(context, 'DELETE', 's3', objectPath),
            `Error removing the uploaded layer ${name} from ${bucket}`,
        )
    if (published) {
        // A run that died between publishing and removing left the upload behind.
        await removeUpload()
        return published
    }
    context.log.trace(`uploading ${name} to s3://${bucket}/${key}`)
    await okResponse(
        awsBinaryRequest(context, 'PUT', 's3', objectPath, zip, 'application/zip'),
        `Error uploading layer ${name} to ${bucket}`,
    )
    const arn = await publishUploaded(context, name, description, bucket, key, removeUpload)
    await removeUpload()
    return arn
}

async function publishUploaded(
    context: Context,
    name: string,
    description: string,
    bucket: string,
    key: string,
    removeUpload: () => Promise<void>,
) {
    try {
        return await publishVersion(context, name, description, { S3Bucket: bucket, S3Key: key })
    } catch (e) {
        try {
            await removeUpload()
        } catch (cleanup) {
            throw new AggregateError(
                [e, cleanup],
                `Error publishing a version of layer ${name}, and removing its upload`,
                { cause: cleanup },
            )
        }
        throw e
    }
}

async function publishVersion(
    context: Context,
    name: string,
    description: string,
    content: { ZipFile: string } | { S3Bucket: string; S3Key: string },
) {
    context.log.trace(`publishing a version of ${name}`)
    const { LayerVersionArn } = await jsonResponse<{ LayerVersionArn: string }>(
        awsRequest(context, 'POST', 'lambda', `/2018-10-31/layers/${name}/versions`, {
            Content: content,
            Description: description,
        }),
        'Error publishing a version of layer ' + name,
    )
    return LayerVersionArn
}

async function findVersion(context: Context, name: string, description: string) {
    for (let marker = ''; ;) {
        const page = await jsonResponse<{
            LayerVersions: { LayerVersionArn: string; Description?: string }[]
            NextMarker?: string | null
        }>(
            awsRequest(context, 'GET', 'lambda', `/2018-10-31/layers/${name}/versions${marker}`),
            'Error listing versions of layer ' + name,
        )
        const version = page.LayerVersions.find(v => v.Description === description)
        if (version) {
            context.log.trace(`${name} already has a version published from this zip`)
            return version.LayerVersionArn
        }
        if (!page.NextMarker) {
            return undefined
        }
        marker = `?Marker=${encodeURIComponent(page.NextMarker)}`
    }
}
