# @movogo-io/deploy

Deploys a Riddance service to AWS: every root entrypoint becomes one Lambda function, bundled with
its dependencies into a single `index.js`.

```sh
deploy [<path>] <stage> [<glue file>] [--stage-dir <dir>]
deploy destroy <stage> --glue <file> [--service <name>] [--dry-run]
deploy --help
```

`<path>` defaults to the current directory and the glue file to `../glue/glue.json` beside it.

## Upgrading from 0.5.0

Check each point before the first deploy with 0.6.0.

**Credentials**

- `[default]` is never used. The profile is the one `AWS_PROFILE` names, else the one named like
  the stage. If neither exists the deploy fails. Before, a stage without a profile deployed as
  `[default]`.
- `AWS_PROFILE` wins over the stage name. `AWS_PROFILE=staging deploy dev` deploys the stage `dev`
  with the credentials of `staging`. Unset it, or set it on purpose.
- Keys in the environment (`AWS_ACCESS_KEY_ID` with `AWS_SECRET_ACCESS_KEY`) win over any profile.
- Half a key pair in the environment is refused. Set both variables or neither.
- A role profile (`role_arn`, SSO) is resolved with `aws configure export-credentials`, so the AWS
  CLI must be on `PATH`. A profile with static keys and no `role_arn` needs no CLI.

**Command line**

- An unknown flag, a flag without its value and a surplus argument are refused. Before, they were
  read as a path or a stage.
- A stage name holds letters, digits, `-` and `_` only, and starts with a letter or digit. A path,
  an empty name or a name with a dot is refused.
- The build directory moved from `$TMPDIR/riddance/stage/<service>` to
  `$TMPDIR/riddance/stage/<stage>/<service>`. The first deploy of each service builds from scratch.
  `--stage-dir <dir>` builds in `<dir>/<service>` instead.

**Timers**

- A deploy no longer enables a disabled timer rule. Each rule keeps its state.
- The rule of a timer removed from the code is deleted with its target.
- The deploying identity now also needs `events:ListRules`, `events:ListTagsForResource`,
  `events:ListTargetsByRule`, `events:RemoveTargets` and `events:DeleteRule`.

**Policy statements in the glue** (`services.<service>.aws.policyStatements`)

- A statement with a key other than `Effect`, `Action`, `Resource` and `Condition` is refused.
  This hits every statement that carries `Principal`: 0.5.0 dropped that key silently. Remedy:
  delete the `Principal` key from the statement in the glue. The deployed role does not change,
  because the key never reached it.
- A statement that still holds a `$` after substitution is refused. Only `$REGION`, `$ACCOUNT` and
  `$ENV` are substituted. Remedy: use one of the three, or write the value out.

**The glue's top-level `aws` object**

- It takes `accountId` and `slots` only. Any other key is refused, a misspelt `accountID` too.
- A glue file without `aws.accountId` still deploys, with a warning that is repeated as the last
  line. Add the account id to end the warning.
- A deploy to a slot (`w1` to `w9`) is refused unless the glue file lists the slot in `aws.slots`.

## Credentials

In this order: the key pair in the environment; the profile `AWS_PROFILE` names; the profile named
like the stage. The region is `AWS_REGION`, else `AWS_DEFAULT_REGION`, else the profile's; without
one the deploy fails. The deploy prints the caller's ARN before it changes anything.

## The account a stage lives in, and its slots

```json
{
  "aws": { "accountId": "123456789012", "slots": ["w1", "w2"] },
  "implementations": {},
  "services": {}
}
```

A glue file is per stage. `aws` at its top level holds two settings:

- **`accountId`**: the AWS account of the stage, as a string of twelve digits. Before a deploy
  changes anything it asks STS which account its credentials reach. If that is another account it
  refuses, and names both accounts and the profile. A glue file without `accountId` deploys with a
  warning, printed at the start and again as the last line. `destroy` refuses such a file.
- **`slots`**: the slots this account may hold, each one of `w1` to `w9`. A deploy to a slot and a
  `destroy` of a slot are refused unless the glue file they were given lists that slot. A glue
  file without `slots` permits no slot. Stages that are not slots (`dev`, `staging`, `production`)
  need no entry.

Any other key in that object is refused.

A slot differs from every other stage in two ways: a deploy to it creates a new
[timer rule](#timer-rules) disabled, and it reserves
[no concurrency](#per-function-settings-in-the-glue).

## The build directory

A service is built in `$TMPDIR/riddance/stage/<stage>/<service>`, so one service can be deployed to
two stages at the same time. With `--stage-dir <dir>` it is built in `<dir>/<service>`. Several
stages may share one `<dir>` to reuse a build, but not at the same time. `<dir>` may not be `/`,
the home directory, an existing file, or a directory inside or around the project.

## Timer rules

An existing rule keeps its state, enabled or disabled. A new rule is disabled only when every
other timer rule of the service on that stage is disabled; otherwise it is enabled. A timer removed
from the code has its rule and target deleted.

**On a slot** (`w1` to `w9`) a new rule is always created disabled, whatever state the service's
other rules have. A slot is built by many deploys before its tables and data are ready, and a
timer firing in between would run against a half-built stage. A deploy that creates rules there
says so in one line (`new timers of … created disabled (…): … is a slot`). Enable them once the
slot is complete, with `aws events enable-rule --name <stage>-<service>-<timer>`; from then on
each rule keeps its state like on any other stage, so redeploys leave an enabled timer enabled.
A removed timer's rule and target are deleted on a slot too.

## Policy statements and the permissions boundary

```json
{
  "services": {
    "files": {
      "aws": {
        "policyStatements": [
          { "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::$ENV-files/*" }
        ],
        "permissionsBoundary": "arn:aws:iam::123456789012:policy/$ENV-boundary"
      }
    }
  }
}
```

- **`policyStatements`** are added to the role of the service's functions. A statement holds
  `Effect`, `Action`, `Resource` and optionally `Condition`. In `Resource` and in `Condition`
  values, `$REGION`, `$ACCOUNT` and `$ENV` stand for the region, the account and the stage.
- **`permissionsBoundary`** is the ARN of the IAM policy set as permissions boundary on a role the
  deploy creates. Only `$ENV` is substituted there. An existing role is not changed. The environment
  variable `DEPLOY_PERMISSIONS_BOUNDARY` sets the same. If both are set they must name the same
  policy, or the deploy is refused.

## Destroying a slot

```sh
deploy destroy w1 --glue ../glue/glue.w1.json --dry-run
deploy destroy w1 --glue ../glue/glue.w1.json
deploy destroy w1 --glue ../glue/glue.w1.json --service crew
```

`destroy` removes what deploys made on one slot. The stage must be one of `w1` to `w9`; any other
stage is removed by hand.

- `--glue <file>` is required. The file must list the slot in `aws.slots` and declare
  `aws.accountId`, and the credentials must reach that account. Otherwise nothing is requested or
  deleted. A missing file is reported in one line with its path.
- It deletes timer rules and their targets, functions, APIs, topics and subscriptions, roles and
  log groups. Each is deleted only when its name starts with the stage and its `environment` tag
  names the stage.
- It never deletes tables, layer versions, anything untagged, or anything whose name and tag
  disagree. What it skips is printed with the reason.
- The whole list is printed first, and only that list is deleted.
- `--dry-run` stops after printing the list.
- A log group carries no tags. It goes when its function goes or is already gone, and stays when
  its function is skipped.
- `--service <name>` takes only what belongs to that service, and keeps the topics. A log group
  whose function is gone is taken by name: it stays only when it is named like one of another
  service that starts the same (`crew-v2` beside `crew`) and still has a tagged function on the
  slot.
- It stops at the first delete that fails. Run it again to continue.

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
  `concurrencyMax`. **Not on a slot:** a deploy to `w1` to `w9` reserves nothing, whatever the
  handler or the glue declares, and says so in one line (`reserved concurrency skipped for …`). A
  reservation is taken out of the pool every stage of the account runs on, and IAM cannot limit
  the amount, so a slot's role is not granted `lambda:PutFunctionConcurrency` at all. A
  reservation a slot function already holds is still removed. A slot's event functions therefore
  run uncapped; every other stage is unchanged.

A function named in neither `layers` nor `external` is bundled and deployed as before. The glue
owns a function's layers: a layer attached by hand, to any function of the service, is removed by
the next deploy. A function gaining a layer has its configuration updated before its code, so a
layer Lambda refuses fails the deploy with that function still running the code it had (its
siblings may already be updated). A function gaining none has its code updated first, so one that
only loses layers stops importing from them before they go. The deploy principal needs
`lambda:GetLayerVersion` on the layers it attaches.

## Publishing a layer

```sh
publish-layer <zip> <name> [<bucket>] [--account <id>]
```

Publishes the zip as a new version of the layer `<name>` and prints the version's ARN, for the glue.
A version already published from the same zip is printed instead of publishing another, bucket or
not. Lambda takes at most 50 MB in the request; a larger zip needs an S3 bucket in the same region,
which it is uploaded to and removed from once published. Credentials come from the environment, or
from the profile `AWS_PROFILE` names (else `default`), a role profile included, and a profile that
is not there is refused. It prints the caller's ARN before it writes anything, and with
`--account <twelve digits>` it refuses credentials of another account before any write; the printed
layer ARN names the account it went to. It needs `lambda:ListLayerVersions` and
`lambda:PublishLayerVersion`, and `s3:PutObject` and `s3:DeleteObject` on the bucket; asking STS
who the caller is needs no permission.

A Node.js layer zip has its packages under `nodejs/node_modules/`. For Chromium:

```sh
mkdir -p layer/nodejs && cd layer/nodejs
npm init -y && npm install --omit=dev @sparticuz/chromium puppeteer-core && rm package*.json
cd .. && zip -qr chromium.zip nodejs   # about 78 MB, so publish it through a bucket
```

It is proven on x86_64 (give the function `compute: 'high'`, which also gives it 3008 MB). It
unpacks about 220 MB into `/tmp`, within Lambda's default 512 MB of ephemeral storage, the only
size the deploy sets.
