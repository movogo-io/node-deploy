# Runbook: credentials from the parameter store

For `@movogo-io/deploy` 0.6.2 and later. The commands and the reference are described in the
[README](README.md#credentials-from-the-parameter-store); this is the order in which they are
used, and what to do when something reads wrong.

The `secret` commands check the account and, where the glue file declares `aws.stage` and
`aws.region`, that the file belongs to the stage named and the region used. Without `aws.stage`
two stages in one account are told apart only by naming the right file.

`put`, `init` and `init-key` are run by a person, never by an agent session: a value typed into
`put` would pass through the session's context, and the keys are made by one of their
administrators. An agent session may run `list`, `check`, `import`, `restore` and `rm`.

## Rules before a reference is written for `<service>.<KEY>`

None of these is what keeps a wrong credential out: the tripwire, `"PARAMETERS": true`, is. A tool
below 0.6.2 that meets a converted block stops with
`TypeError: value.matchAll is not a function` and changes nothing. The rules are the order in
which a conversion leaves every lane working: a pin that is missed means a lane that cannot deploy
the service until the pin moves.

1. **The service's own scripts.** Its `deploy:dev` scripts are at `@0.6.2` in every worktree and
   branch.
   - A script at 0.6.1 crosses nothing but this release.
   - A script below 0.6.0 crosses 0.6.0 and 0.6.1 on the way. Such a worktree is first redeployed
     at 0.6.2 with no reference, and its functions' memory, reserved concurrency and layers and
     each timer rule's state are compared with before.
   - A missed script fails closed. At 0.6.1 it prints the `TypeError` and exits 1. At 0.6.0 and
     below it may print nothing and exit 0: a deploy that prints no `done.` line did not happen.
   - A shell with `AWS_PROFILE` set to another profile deploys the stage under it.
2. **Every other command that deploys it**, each failing closed when missed: a fleet manifest's
   command for the service, a literal in a workflow script, the `deploy` field of a feature
   manifest, the tool a slot manager runs.
3. **Its readers.** `grep` glue for `$SAME_AS(<service>,<KEY>)` and
   `$PUBLIC_KEY(<service>,<KEY>)`. Each `$SAME_AS` reader is rewritten as
   `$PARAMETER(<service>,<KEY>)` in the same commit, moved to `secrets` if it sits in `env`, its
   block given `"PARAMETERS": true`, and its own pins brought under rules 1 and 2; otherwise 0.6.2
   refuses its deploy. **A key read by a `$PUBLIC_KEY` is not converted at all.**
4. **The account.** The stage's glue declares `aws.accountId`: 0.6.2 refuses a block with a
   reference without it, on every stage. A glue file that has none yet gains it before the
   stage's first converted secret.
5. **Slots.** A slot that deploys the service needs, in its glue, `slotParametersFrom` and
   `aws.accountId`; its role's permissions released (below); and the tool that deploys the slot
   at 0.6.2. Until then the service cannot be created or redeployed on a slot built from a glue
   that holds the conversion: at 0.6.2 the deploy fails, naming the refusal, and changes nothing;
   below 0.6.2 the tool stops on the tripwire. A slot built before keeps the functions it has. The
   parameter is the named stage's: nothing is put for a slot.
   - `slotParametersFrom` may be committed at any time, before or after any pin moves: no tool
     up to 0.6.1 reads it.
   - A slot's new timer rules are created disabled and stay so until someone enables them. A
     converted secret changes nothing in that, and a slot whose timers are off does not show
     whether a timer function reads its value.
6. **Its suites** are read for a check that compares the block's key names with a fixed list or
   with the functions' variables. `PARAMETERS` is a key of the glue block and never a variable of
   a function; `PARAMETER_VERSIONS` is a variable of a function and never a key of glue. Such a
   check is made to leave out `PARAMETERS` on glue's side and `PARAMETER_VERSIONS` on the
   function's.

## One existing secret of one service

Each step is a state in which every lane with a moved pin still deploys.

1. The rules above hold and the service has been deployed at 0.6.2 with no reference.
2. Glue: `"PARAMETERS": true` is added to the service's `secrets` block, alone, as a commit. The
   service is deployed at 0.6.2: nothing about its functions changes, and none has a variable
   `PARAMETERS`.
3. `deploy secret import <stage> <service> <KEY> --glue …`. Glue still holds the literal; `list`
   shows the parameter as `unreferenced`.
4. Glue: the literal becomes `"$PARAMETER()"`, as a commit. **Never before step 2's commit.** For
   a service that is deployed to slots, not before `slotParametersFrom` is in the glue and the
   slots' permissions are released.
5. Deploy; `deploy secret check <stage> <service> --glue …` prints nothing and exits 0.

Half-way:

- after 2, a lane of that service whose pin was missed stops on the tripwire and deploys nothing:
  the missed pins show themselves here, before a credential depends on them;
- after 3 alone nothing more has changed for any deploy;
- after 4, a slot whose permissions are not released fails at 0.6.2 with the access-denied message
  and changes nothing;
- **what must never be:** a reference in a block without the entry. 0.6.2 refuses it; an older
  tool that got there first would have deployed the text `$PARAMETER(…)` as the credential.

## A new service

1. Its pin is at 0.6.2, and so is every other command that deploys it.
2. Its block with references **and `"PARAMETERS": true`** is committed.
3. A person runs `deploy secret put` for each reference. Between 2 and 3 a deploy of it, to the
   stage or to a slot, fails naming the missing parameter and changes nothing: safe, and expected.
4. Its first deploy. A service key adds a second: `init-key` needs the role the first deploy
   makes, and the function needs the key's ARN in its `env`.

## The owner, by hand

Per stage: (a) names two or more administrators, the operators and the deployers as ARNs of IAM
roles or users of the stage's account; (b) attaches their IAM policies; (c) runs
`deploy secret init <stage> …` as an administrator; (d) runs `init-key` for a service that needs
one, after that service's first deploy; (e) runs every `put`. Per slot: (f) releases the slot
role's permissions once the role exists. Once: (g) commits `"slotParametersFrom": "<stage>"` to
the glue file its slots are built from.

## What a message means

**`TypeError: value.matchAll is not a function`.** A tool older than 0.6.2 met a converted block.
Nothing was changed. Move the pin to 0.6.2. 0.6.0 and older may say nothing and exit 0 instead, so
a deploy without a `done.` line is not one.

**A function holds the text `$PARAMETER(`.** A block had a reference and no tripwire, and an older
tool deployed it. Its sign is the service's provider calls failing. It is found with
`deploy secret check`, which reports the function as `not deployed since the reference`, and
undone by adding the entry and redeploying with 0.6.2; the value is still in the parameter.
`import` refuses to copy such text, and a 0.6.2 deploy of a service that reads it refuses too.

**`Parameter /<stage>/<service>/<KEY> is missing. Put it: deploy secret put …`.** The parameter is
not there, is empty, or is no `SecureString`. Nothing was changed. A person puts it and the deploy
is run again.

**`Not allowed to read or decrypt …`.** AWS refused the read; the parameter may well be there.
Check the deploying identity's `ssm:GetParameters` on `/<stage>/*` and its place in the stage
key's `Deployers`, written by `deploy secret init … --deployer`.

**On a slot.** `(w1 reads dev's parameters. Put it from a session with dev's own credentials, not
a slot's.)` follows a missing parameter: the parameter is the named stage's. **In a slot session
the profile of that stage can be the slot's role**, so the hinted `deploy secret put dev …` typed
there passes the account check and is then refused by IAM with exit code 3 and nothing put. It is
put from a session with the stage's own credentials. A refused read on a slot names the slot
runner's two policies and the key's `SlotReaders`: see the next section.

## Releasing parameter reads for a slot

A slot reads and decrypts the parameters of the stage its glue names, and nothing else: it can
put, delete and encrypt nothing. For a slot whose role exists, the owner:

1. gives the slot runner's allow policy `ssm:GetParameters` on that stage's parameters, and its
   deny policy the matching exceptions and nothing wider, as a new version of each, the deny half
   first;
2. reruns `init` for the stage with the whole list of principals and the slot's role as a
   `--slot-reader`, with `--update-policy`:

   ```sh
   deploy secret init dev --admin … --admin … --operator … --deployer … \
     --slot-reader arn:aws:iam::<account>:role/slot-runner-<slot> --update-policy --glue <file>
   ```

`init` takes the whole list each time: a slot left out is removed from `SlotReaders`, and with
none the statement goes. A slot role that is deleted and created again is locked out until the
command is rerun, as any role named in a key policy is.

## Restoring an earlier value

`deploy secret restore <stage> <service> <KEY> <version>` puts that version's value as the newest
version and names the services to redeploy. `check` exits 1 for them until they are.

## A key without its alias

When `init` or `init-key` made a key and could not name it, it says
`key <id> has no alias; rerun with --key <id>`. Rerun the same command with `--key <id>`.

A key whose creation was answered but the answer lost cannot be found by the tool, since no
listing is granted, and the rerun makes another. An administrator finds the first by its
description (`<stage> secrets`, or `<stage> <service> <name>`) in the console and schedules its
deletion.

`init` takes an alias that already exists, and a key given with `--key`, as they are: it compares
the policy and nothing else of the key.
