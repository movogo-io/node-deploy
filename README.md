# @movogo-io/deploy

Deploys a Riddance service to AWS: every root entrypoint becomes one Lambda function, bundled with
its dependencies into a single `index.js`.

```sh
deploy [<path>] <stage> [<glue file>] [--stage-dir <dir>]
deploy destroy <stage> --glue <file> [--service <name>] [--dry-run]
deploy secret <command> <stage> [<service> [<KEY> [<version>]]] --glue <file> [flags]
deploy --help
```

`<path>` defaults to the current directory and the glue file to `../glue/glue.json` beside it.

## Upgrading from 0.6.1

**Before your first deploy**

Nothing is asked of a service whose glue block holds no parameter reference: it deploys as with
0.6.1 and needs no new permission.

**Credentials from the parameter store**

- A value of `secrets` can be a reference to a parameter: `"$PARAMETER()"` or
  `"$PARAMETER(<service>,<KEY>)"`. It is legal in `secrets` only and is the whole value. See
  [Credentials from the parameter store](#credentials-from-the-parameter-store).
- Every `secrets` block that holds a reference also holds `"PARAMETERS": true`.
- A function of such a service gets one more variable, `PARAMETER_VERSIONS`, with the versions
  of the parameters the deploy read.
- The deploying identity then needs `ssm:GetParameters` on `/<stage>/*` and a place in the
  `Deployers` statement of the stage key's policy.
- The `secret` commands put, list and check the parameters; see
  [The secret commands](#the-secret-commands).

**What 0.6.2 refuses that 0.6.1 deployed**

- An unknown `$CAPS` variable in any value of `env` or `secrets`: a `$` followed by capitals or
  underscores that is none of the tool's variables. 0.6.1 deployed such text as it stood.
- A value of `env` or `secrets` that is not a string. 0.6.1 ended on a `TypeError`; 0.6.2 names
  the key.
- The keys `PARAMETERS` and `PARAMETER_VERSIONS` used as variables.
- A top-level `slotParametersFrom` that names no stage, or names a slot.
- A function whose environment cannot be read. It is now fatal; before, it was read as a
  function with no variables.
- A service whose environment is over 4,096 bytes as JSON, before anything is written. Before,
  Lambda refused it at the first function.
- `secret` as the first argument, which is now a command. A directory of that name is deployed
  as `./secret`.

**Older versions and a block with references**

- A tool below 0.6.2 stops on `"PARAMETERS": true` with
  `TypeError: value.matchAll is not a function` and changes nothing. Move its pin to 0.6.2.
- 0.6.0 and older may print nothing and exit 0 when they stop there, so a deploy without a
  `done.` line did not happen.
- A block with a reference and without the entry must never be committed: an older tool would
  deploy the reference's text as the credential. 0.6.2 refuses such a block.

**Slots**

- A deploy to a slot reads the parameters of the stage that `slotParametersFrom` names at the
  glue's top level.
- A block that holds a reference needs `aws.accountId` declared in its glue, on every stage. A
  slot whose block holds one also needs the slot
  runner's permissions to read and decrypt that stage's parameters.
- The `secret` commands take no slot.

**Exit codes**

- A deploy, a `destroy` and a `publish-layer` exit 1 on every failure, as in 0.6.1.
- A `secret` command exits 0, 1 or 3; see [The secret commands](#the-secret-commands).

## Upgrading from 0.6.0

0.6.1 asks nothing of a 0.6.0 user before its first deploy. What changes:

- On a slot (`w1` to `w9`) a new timer rule is created disabled, and the deploy says so in one
  line. Enable a slot's timers once the slot is complete; see [Timer rules](#timer-rules). Rules
  that exist keep their state, and no other stage changes.
- A slot built with 0.6.0 keeps the timer rules it has enabled, since existing rules keep their
  state. Disable each by hand with `aws events disable-rule --name <stage>-<service>-<timer>`, or
  destroy the slot and build it again.
- A deploy, a `destroy` or a `publish-layer` that fails prints the error to stderr and exits 1,
  always. Before, a deploy that failed after it had read the service's entrypoints could print
  nothing and exit 0: the entrypoints are imported into the deploying process, and a service
  whose imports reach `@movogo-io/host/context`, directly or through a package, registers
  listeners there that kept Node from reporting the error. `done.` is printed only by a command
  that completed, so a caller may rely on the exit code alone.
- A throttled AWS request is retried up to eight times, with exponential backoff and jitter, for
  at most about a minute: a Lambda 429 as before, and now also the 400 that IAM and EventBridge
  throttle with (`Throttling`, `ThrottlingException`). A deploy creates, updates and
  deletes at most eight functions at a time, so a service with many functions no longer meets
  Lambda's rate limit (`CallerRateLimitExceeded`) all at once.

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

A deploy to a slot differs from a deploy to any other stage in three ways: it creates a new
[timer rule](#timer-rules) disabled, it reserves
[no concurrency](#per-function-settings-in-the-glue), and it reads the
[parameters of the stage its glue names](#what-a-slot-reads).

## Credentials from the parameter store

```json
{
  "aws": { "accountId": "123456789012", "slots": ["w1"] },
  "slotParametersFrom": "dev",
  "services": {
    "slack": {
      "secrets": {
        "PARAMETERS": true,
        "SLACK_SIGNING_SECRET": "$PARAMETER()",
        "MAILGUN_API_PASSWORD": "$PARAMETER(mails,MAILGUN_API_PASSWORD)"
      }
    }
  }
}
```

A value of `secrets` can refer to a `SecureString` parameter of the stage instead of holding the
credential. At deploy the tool fetches the value and puts it into the functions' environment.

- **`$PARAMETER()`** is the parameter `/<stage>/<service>/<KEY>`: the service being deployed and
  the key's own name.
- **`$PARAMETER(<service>,<KEY>)`** is `/<stage>/<service>/<KEY>` of the service named, for a
  credential two services share. It is written without a space, as `$SAME_AS(<service>,<KEY>)`
  is. `<KEY>` holds letters, digits and `_` and does not start with a digit.
- A reference is the whole value and is legal in `secrets` only. A credential is one parameter
  with one version.
- **`"PARAMETERS": true`**, the JSON boolean, stands in every `secrets` block that holds a
  reference. It never becomes a variable of a function. It is there for older tools: a tool below
  0.6.2 stops on it and changes nothing, where it would otherwise deploy the reference's text as
  the credential. A block may hold the entry without a reference, so it can be committed first.
- **`PARAMETER_VERSIONS`** is one more variable of the function: JSON of the version read for
  each key that is a reference, such as `{"SLACK_SIGNING_SECRET":3}`. `deploy secret check`
  compares it with the parameters as they stand.
- `$SAME_AS` and `$PUBLIC_KEY` on a reference of the service's own block give the fetched value
  and its public key. On a reference of another service's block they are refused: the copy would
  carry no version. Write `$PARAMETER(<service>,<KEY>)` instead. A key that another service
  reads with `$PUBLIC_KEY` cannot become a reference.

A deploy checks the block of the service it deploys, and no other, before it builds or changes
anything. It refuses, naming the key and never showing a value: `$PARAMETER` in `env`; a value of
`secrets` that holds `$PARAMETER` and is not exactly one of the two forms; a reference without
`"PARAMETERS": true`; `PARAMETERS` anywhere else or with another value; `PARAMETER_VERSIONS` as a
key; a value that is not a string; an unknown `$CAPS` variable. A parameter that is missing,
empty or no `SecureString` fails the deploy with the `deploy secret put` that fixes it; a read
that AWS refuses says "not allowed", never "missing".

A block that holds a reference is refused, on every stage and before any parameter is read, when
its glue file declares no `aws.accountId`: without it nothing checks which account the credentials
would be read from. A block without a reference still deploys with the warning. A stage's glue
must gain the account id before its first reference.

The deploying identity needs `ssm:GetParameters` on
`arn:aws:ssm:<region>:<account>:parameter/<stage>/*` and `kms:Decrypt` through the stage key's
policy, where `deploy secret init` names it with `--deployer`.

### What a slot reads

A slot (`w1` to `w9`) has no parameters and no key of its own. A deploy to a slot reads the
parameters of the stage that **`slotParametersFrom`** names, at the top level of the glue file
beside `aws` and `services`: with `"slotParametersFrom": "dev"`, a reference deployed to `w1` is
read from `/dev/…`.

- Only parameter names are mapped. Function names, `$SAME_AS` lookups, base URLs and generated
  values keep the slot's own name.
- The value must name a stage that is not a slot. Anything else is refused by every deploy from
  that file. Tools up to 0.6.1 do not read the key, so it can be added at any time.
- A slot whose block holds a reference is refused before any parameter is read when the glue has
  no `slotParametersFrom`.
- The slot's role needs `ssm:GetParameters` on that stage's parameters and a place in the stage
  key's policy, where `deploy secret init` names it with `--slot-reader`. It needs no write, and
  a parameter is put from a session with the stage's own credentials, not a slot's.
- A slot without a reference in its block deploys as before.

## The secret commands

```sh
deploy secret <command> <stage> [<service> [<KEY> [<version>]]] --glue <file> [flags]
deploy secret --help
```

They keep a stage's credentials in the parameter store. No command prints a value.

- `--glue <file>` is required for every command; none guesses a file. The file must declare
  `aws.accountId`, and each command first checks that its credentials reach that account.
  Credentials are found as for a deploy.
- `<stage>` is never a slot: every command refuses `w1` to `w9`.
- `PARAMETERS` is the entry that marks a block with references and no key: `put`, `import`,
  `restore` and `rm` refuse it.

| Command | What it does |
|---|---|
| `init <stage> --admin <arn>… --operator <arn>… --deployer <arn>… [--slot-reader <arn>…] [--key <id>] [--update-policy]` | Makes the stage's key, `alias/<stage>-secrets`, or compares its policy with the one the flags give. It needs at least two `--admin`, and the caller must be one of them. A policy that differs is refused unless `--update-policy`. `--key <id>` resumes with a key that was made without its alias. |
| `init-key <stage> <service> <name> [--key <id>] [--update-policy]` | Makes `alias/<stage>-<service>-<name>`, a key only that service's functions may use, and prints its ARN for the service's `env`. The caller must be an administrator of the stage key, and the service must have been deployed once. A caller sends the encryption context `{ "service": "<service>", "record": "<the record's id>" }`. |
| `put <stage> <service> <KEY> [--replace] [--multiline]` | Puts a value as `/<stage>/<service>/<KEY>`, which the glue must refer to. The value is never an argument: it is typed without echo, or read from standard input less one trailing line break. An empty value, one over 4,096 bytes, a typed one with a control character and, without `--multiline`, one with a line break are refused. An existing name needs `--replace`. It ends with the services to redeploy. |
| `import <stage> <service> <KEY>` | Copies the value the service's functions hold into the parameter and prints the version. It needs no reference in the glue, so the value can be in place before the glue changes. It refuses functions that hold different values, and a parameter that already holds another value. |
| `list <stage> [<service>]` | One line a parameter, fields separated by a tab: name, `v<version>`, the last change, who made it, and `unreferenced`, `missing`, `not SecureString`, `other key` or `-`. |
| `check <stage> [<service>]` | One line for each key of a function that is not current: function, key, `deployed v<n>`, `current v<m>`, and `stale`, `not deployed since the reference` or `parameter missing`. It prints nothing and exits 0 when all is current, and exits 1 otherwise. The cure is a deploy. |
| `restore <stage> <service> <KEY> <version>` | Puts an earlier version's value as the newest version. |
| `rm <stage> <service> <KEY> [--yes]` | Deletes a parameter with all its versions. It refuses one the glue refers to, and without `--yes` only says how many versions would go. |

**A known limit.** The commands check the account, not that the glue file belongs to the stage
named: `deploy secret list staging --glue glue.dev.json` passes the check when both stages live in
one account, as a deploy with the wrong glue file does. Name the stage's own glue file.

**`put`, `init` and `init-key` are run by a person, never by an agent session**: a value typed
into `put` would pass through the session, and the keys are made by one of their administrators.

**Exit codes.** 0: done, and `check` found nothing. 1: wrong usage, a refusal, or `check` found
something. 3: an AWS error, or anything unexpected. The line is whether AWS was asked: what is
found wrong on this machine is 1, a missing profile and expired credentials included; what AWS
refuses is 3. A refusal and an AWS error print one line, `error: …`. A script can so tell "`check`
found something" from "`check` could not run".

**Keys.** All use of a key is granted in its key policy. Neither policy has a statement for the
plain account principal, so no IAM policy can add use or management of a key. Lock-out is covered
by at least two administrators and a statement confined to the account's root user. Key material
is not rotated automatically; an administrator can turn that on. A role that is deleted and
created again is locked out of a key that names it until `init` or `init-key` is rerun with
`--update-policy`. `init` adopts an alias that already exists, and a key given with `--key`, as it
is: it compares the key's policy and nothing else of it. `init` refuses a principal of another
account than the stage's. The order of adoption, and what each message means, is in
[RUNBOOK.md](RUNBOOK.md).

**Permissions.** An administrator needs `kms:CreateKey`, `kms:CreateAlias` on
`alias/<stage>-*` and `iam:GetRole`. An operator needs `ssm:PutParameter`, `ssm:GetParameter`,
`ssm:GetParameters` and `ssm:DeleteParameter` on the stage's parameters,
`ssm:DescribeParameters`, and `lambda:ListFunctions` for `import` and `check`.

## The build directory

A service is built in `$TMPDIR/riddance/stage/<stage>/<service>`, so one service can be deployed to
two stages at the same time. With `--stage-dir <dir>` it is built in `<dir>/<service>`. Several
stages may share one `<dir>` to reuse a build, but not at the same time. `<dir>` may not be `/`,
the home directory, an existing file, or a directory inside or around the project.

## Timer rules

An existing rule keeps its state, enabled or disabled. A new rule is enabled, unless the service
has other timer rules on that stage and every one of them is disabled; then it is disabled too.
A timer removed from the code has its rule and target deleted.

**On a slot** (`w1` to `w9`) a new rule is instead always created disabled, whatever state the
service's other rules have. A slot is built by many deploys before its tables and data are ready,
and a timer firing in between would run against a half-built stage. A deploy that creates rules
there says so in one line (`new timers of … created disabled (…): … is a slot`). Enable them once
the slot is complete, with `aws events enable-rule --name <stage>-<service>-<timer>`; from then on
each rule keeps its state like on any other stage, so redeploys leave an enabled timer enabled. A
removed timer's rule and target are deleted on a slot too.

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
