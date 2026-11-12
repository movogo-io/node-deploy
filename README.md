# @movogo-io/deploy

Deploys a Riddance service to AWS: every root entrypoint becomes one Lambda function, bundled with
its dependencies into a single `index.js`.

```sh
deploy <path> <stage> <glue file>
```

## Per-function settings in the glue

A service's block in the stage's glue file can carry an `aws` object. Each setting below is keyed
by function name (the entrypoint file's name without `.ts`); a name the service has no function of
refuses the deploy.

```json
{
  "services": {
    "compose": {
      "aws": {
        "layers": {
          "internal-rasterize": ["arn:aws:lambda:eu-north-1:123456789012:layer:chromium:3"]
        },
        "external": {
          "internal-rasterize": ["@sparticuz/chromium", "puppeteer-core"]
        },
        "concurrency": { "document-changed": 10 }
      }
    }
  }
}
```

- **`layers`**: the layer version ARNs the function runs with, at most five, in order (a later
  layer's files overwrite an earlier one's). A glue file is per stage, so it names that stage's
  ARNs. Removing a function's entry, or emptying its list, removes its layers on the next deploy.
  A layer is built for one architecture: a function with `compute: 'high'` runs on x86_64, other
  functions on arm64 unless they are `GET` handlers without a `compute` setting.
- **`external`**: packages, and their subpaths, left out of the function's bundle and loaded at run
  time, because a layer (in `/opt/nodejs/node_modules`) or the runtime provides them. Without it,
  an import the staged install cannot resolve fails the deploy; what an external package imports
  itself is never bundled, so its optional peers do not either. A function with external packages
  is bundled as an ES module (`index.mjs`): Lambda's Node.js runtime cannot `require()` an ES
  module, and many layer packages (`@sparticuz/chromium`, `puppeteer-core`) are ES modules only.
  Import them statically or with `await import(...)`; both stay real imports in the bundle. The
  deploy loads every entrypoint to find its handlers, so the packages must be installed where it
  runs: keep them dev dependencies of the service, which the staged bundle leaves out.
- **`concurrency`**: the reserved concurrency of an event function, overriding the handler's
  `concurrencyMax`.

A function named in neither `layers` nor `external` is bundled and deployed as before. The glue
owns a function's layers: a layer attached by hand, to any function of the service, is removed by
the next deploy. A function gaining a layer has its configuration updated before its code, so a
layer Lambda refuses fails the deploy with that function still running the code it had (its
siblings may already be updated). A function gaining none has its code updated first, so one that
only loses layers stops importing from them before they go. The deploy principal needs
`lambda:GetLayerVersion` on the layers it attaches.

## Publishing a layer

```sh
publish-layer <zip> <name> [bucket]
```

Publishes the zip as a new version of the layer `<name>` and prints the version's ARN, for the glue.
A version already published from the same zip is printed instead of publishing another, bucket or
not. Lambda takes at most 50 MB in the request; a larger zip needs an S3 bucket in the same region,
which it is uploaded to and removed from once published. Credentials come from the environment, or
from the profile `AWS_PROFILE` names (else `default`), a role profile included, and a profile that
is not there is refused; the printed ARN names the account it went to. It needs
`lambda:ListLayerVersions` and `lambda:PublishLayerVersion`, and `s3:PutObject` and
`s3:DeleteObject` on the bucket.

A Node.js layer zip has its packages under `nodejs/node_modules/`. For Chromium:

```sh
mkdir -p layer/nodejs && cd layer/nodejs
npm init -y && npm install --omit=dev @sparticuz/chromium puppeteer-core && rm package*.json
cd .. && zip -qr chromium.zip nodejs   # about 78 MB, so publish it through a bucket
```

It is proven on x86_64 (give the function `compute: 'high'`, which also gives it 3008 MB). It
unpacks about 220 MB into `/tmp`, within Lambda's default 512 MB of ephemeral storage, the only
size the deploy sets.
