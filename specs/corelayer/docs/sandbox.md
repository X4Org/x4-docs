# Sandboxes

Put a versioned sandbox manifest in `.x4/sandbox.yaml` when a repository should
carry its own repeatable development environment:

```yaml
schemaVersion: 1
profiles:
  base:
    services:
      - id: api
        repo: self
        buildContext: services/api
        mountRepoPath: services/api
        mountTarget: /workspace/api
        containerPort: 8080
        health:
          type: http
          path: /ready
  development:
    extends: base
    services:
      - id: web
        repo: self
        buildContext: apps/web
        containerPort: 3000
        dependsOn: [api]
        preview:
          mode: origin
```

Inspect the exact result without contacting Docker:

```bash
x4 sandbox explain --profile development
```

Start it locally and wait for application readiness:

```bash
x4 sandbox up --profile development --wait
```

## Existing Factory and X4 Code sessions

Each project service can have its own generated `preview.x4app.dev` hostname
on an enrolled preview worker. Starting another project leaves the machine's
`devNN.x4app.dev` primary service unchanged. Machine HTTPS enrollment and
preview-worker enrollment are separate. See [Project HTTPS routing](../deploy/domains/project-routing.md)
for setup requirements, changing upstreams and stable project environments.

A session can attach its existing Git checkout to a profile without creating a
worktree, switching branches, or installing dependencies:

```bash
x4 sandbox session inspect --entry /path/to/session/checkout
x4 sandbox session bind --entry /path/to/session/checkout --profile development
x4 sandbox session start --entry /path/to/session/checkout
x4 sandbox session logs --entry /path/to/session/checkout
x4 sandbox session stop --entry /path/to/session/checkout
```

In X4 Code, open the thread's workspace details and use **Sandbox** to select
and start a profile. **Open preview** opens each ready browser service in the
integrated Browser. Configuration lives in `.x4/sandbox.yaml`; selection and
runtime state live in the checkout's `.x4/workspace.yaml`, shared with Factory
agents using that checkout. Stop the stack before changing profiles or moving
it between hosts.

`logs` prints the last 150 lines per service. `--tail <n>` (1-10000) changes
that, and `--timestamps` starts each line with its time, as in
`runtime-1  | 2026-10-29T07:24:44.292451234Z message`. stdout carries only the
logs; the `sandbox log copy: <path>` notice goes to stderr. Both options reach
a stack on a worker too.

`inspect` reports where the profiles come from in `configSource`:
`repository` (`.x4/sandbox.yaml`), `registry` (X4 Control's
`repos.<id>.sessionSandbox`, with that id in `registryRepo`), or `template`
(the templates file that ships with X4, or `X4_SESSION_SANDBOXES`).

### Inspect output and X4 Code

X4 Code's Sandbox panel reads `inspect`'s JSON with its `SandboxSnapshot`
schema (X4Org/x4-code, `packages/contracts/src/sandbox.ts`) and refuses a
snapshot it cannot decode, so the whole panel breaks on every devbox. That
happened on 2026-11-04, when previews moved to `*.preview.x4app.dev` and X4 Code
still accepted only `*.ts.net`.

`test/fixtures/sandbox-inspect/` holds what `inspect` prints for each kind of
stack: no stack yet, a running stack with pinned-port `*.ts.net` previews, one
with `*.preview.x4app.dev` previews and named links, a stopped stack, a
Factory session's stack on the testbox worker, reachable and unreachable, and
a profile offering a choice of environment.
`test/sandbox-inspect-fixtures.test.mjs` produces them with the real CLI and
fails when its output no longer matches them. X4 Code keeps a copy and its CI
decodes every file.

When you change what `inspect` prints (a field, a status, a URL form):

1. Regenerate the fixtures and review the diff:

   ```bash
   pnpm fixtures:sandbox-inspect
   ```

2. In an X4 Code checkout, copy them in and run its contract test. Change
   `SandboxSnapshot` in the same X4 Code pull request if the test fails:

   ```bash
   node scripts/sync-sandbox-inspect-fixtures.ts --from /path/to/x4   # or --ref <branch> to read X4Org/x4 with gh
   cd packages/contracts && pnpm exec vp test run --config ../../vite.config.ts src/sandbox.test.ts
   ```

3. Merge and release the X4 Code change before the x4 change reaches devboxes
   or workers.

Neither repository's CI can read the other, so nothing checks that the two
copies agree. `node scripts/sync-sandbox-inspect-fixtures.ts --check` in X4
Code compares them using your `gh` login.

### Where session stacks run

By default `start` runs the stack on the execution model's sandbox worker
(`x4-testbox-standard-1`), not on the host that holds the checkout:

```bash
x4 sandbox session start --entry /path/to/session/checkout                # testbox, exact HEAD
x4 sandbox session start --entry /path/to/session/checkout --sync-working-tree
x4 sandbox session start --entry /path/to/session/checkout --target local  # this machine
```

- The worker receives the checkout's exact `HEAD` commit as a Git bundle,
  whether or not the branch is pushed, and runs it detached. Restarts send
  only new commits and reset the worker copy to the exact commit.
- `--sync-working-tree` also copies uncommitted and untracked (non-ignored)
  files and applies local deletions. The stack is then a mutable development
  preview. `.env*` files (other than `*.example`/`*.schema`) and `.x4/` are
  never copied with the code; env files reach the worker only through
  `env-set` (below).
- The session's `.x4/sandbox.yaml` is shipped as is, committed or not.
- The worker keeps its copy in `<workRoot>/<workspaceId>/checkout`, runs the
  local session commands there, and publishes previews on its own `*.ts.net`
  name. `inspect`, `logs` and `stop` on the session host are forwarded to it;
  `inspect` adds a `placement` object (target, revision, mutable, expiry).
- Session stacks expire one week after their last start
  (`jobTypes.sessionSandbox.ttlMinutes`, override with `--ttl-minutes`, `0`
  never expires). `x4 control gc --reap-sandboxes` stops expired worker stacks,
  retires their preview routes and removes their worker directory. On the
  worker itself, `x4 sandbox stacks gc --apply` does the same, hourly from a
  systemd timer ([deploy/testbox](../deploy/testbox/README.md)).

### Start progress

A start reports what it is doing while it runs, for any profile and on either
host, when the caller sets `X4_SANDBOX_PROGRESS=1`. Each event is one stderr
line, `x4-progress ` followed by JSON. Stdout and the other stderr lines are
unchanged, and a terminal without the variable sees no events.

```text
x4-progress {"v":1,"step":"deliver","detail":"my-app @ 1a2b3c4","host":"x4-testbox-standard-1","at":"…"}
x4-progress {"v":1,"step":"containers","line":"#7 [api 3/6] RUN pnpm install","host":"x4-testbox-standard-1","at":"…"}
x4-progress {"v":1,"step":"readiness","services":{"postgres":"healthy","api":"starting"},"host":"x4-testbox-standard-1","at":"…"}
```

- `step`, in order: `deliver` (copy each repository to the worker), `env`
  (install the env file), `sync` (`--sync-working-tree`), `dependencies` (a
  repository's setup command), `containers` (build images and start
  containers), `readiness` (health checks) and `preview` (publish URLs). A
  start skips the steps it does not need.
- An event with `detail` starts a step. An event with `line` carries one line
  of the step's command output (dependency installs, image builds), without
  terminal escapes and cut at 400 characters. A `readiness` event with
  `services` gives each service's state whenever one changes.
- `host` names the worker a step ran on. A start on a worker passes the
  worker's own events back as they happen, so the caller sees the build and
  readiness there too.
- Parse with `parseSandboxProgressLine` (`src/sandbox-progress.ts`) and ignore
  lines it rejects. `v` changes only if an existing field changes meaning.

### Where previews are listed and how they end

X4 Control's **Projects → Previews** lists every session stack on the testbox
workers, and each product and repository page shows its own: status, expiry,
profile, commit, who started it and from where, and its preview links. A
remote start writes `x4-session.json` next to the stack on the worker for this;
stacks started before it show as "Not linked to a project". Owners, admins and
the person who started a stack can stop it there.

A stack ends when it is stopped (the sandbox panel, `x4 sandbox session stop`,
or Control), when its X4 Code product conversation is deleted or all its pull
requests merge (`x4 workspace thread remove`), or when
`x4 control gc --reap-sandboxes` runs after its expiry. On a worker,
`x4 sandbox stacks list` and `x4 sandbox stacks stop <id>` do the same as
Control. `x4 sandbox stacks logs <id> [--service <name>] [--tail <lines>]`
prints the newest lines of each container as JSON; a preview's page in Control
shows them.

A stopped stack keeps its workspace folder (checkout, env file and start
record) and its Docker volumes, and Control lists it as Stopped. Deleting it in
Control, or `x4 sandbox stacks delete <id>` on the worker, stops it if needed
and removes those too; it then disappears from the list.

`x4 sandbox stacks gc` reports the stacks that need cleaning up: expired ones,
and ones whose containers still run although their state says stopped (a
stopped preview, a stopped sandbox, or a missing workspace folder). It is a
dry run unless you pass `--apply`, which deletes the expired stacks and stops
the others. A stack that changed in the last hour (`--grace-minutes`) or is in
the middle of another operation is left alone. Its JSON report and the hourly
timer are described in [deploy/testbox](../deploy/testbox/README.md).

### Preview smoke test

`x4 sandbox smoke` checks the whole path from starting a session stack to its
previews, the way a person in X4 Code uses it. Run it from a devbox (or any
host with SSH access to the worker) after a deploy that touches session stacks,
and a timer runs it daily ([deploy/preview-smoke](../deploy/preview-smoke/README.md)):

```bash
scripts/preview-smoke.sh                # keeps the summary in ~/.local/state/x4/preview-smoke
x4 sandbox smoke --preview-sudo         # the same, summary on stdout
x4 sandbox smoke --target x4-testbox-standard-2
```

It makes two throwaway checkouts of the `smoke` profile
([registry/preview-smoke.sandboxes.yaml](../registry/preview-smoke.sandboxes.yaml),
files in [examples/preview-smoke](../examples/preview-smoke/README.md)): a static
`web` service and an `app` whose env is `{{preview.web.origin}}` and
`{{preview.app.origin}}`. Then it:

1. starts both at once with `x4 sandbox session start --entry <checkout> --profile smoke`,
   the command X4 Code runs, on the execution model's sandbox worker
   (`--target` picks another). `--cli` chooses the x4 that runs these commands:
   by default `X4_SANDBOX_CLI`, the one X4 Code runs, else the x4 running the smoke;
2. runs `inspect` on both and decodes the whole output as X4 Code does, with
   a copy of its contract ([src/x4-code-sandbox-contract.ts](../src/x4-code-sandbox-contract.ts));
3. fetches every preview URL, preview link and health path over HTTPS, and
   checks that each page belongs to its own checkout, that the two stacks have
   different origins, and that the app's env holds its own stack's origins;
4. stops both, checks that their previews stop answering, and deletes the
   worker's copies (`x4 sandbox stacks delete`) so Control's Previews view does
   not keep them. This runs even after a failure or Ctrl-C. Each stack also
   expires after 60 minutes (`--ttl-minutes`) in case cleanup cannot reach the
   worker.

It prints a JSON summary (`ok`, every check, `failures`) and exits 1 when any
check fails. The profiles come only from the smoke file (`X4_SESSION_SANDBOXES`),
so X4 Control's registry is neither read nor changed. The profile has no env
bundle and no secrets. A green run takes under a minute.

The smoke catches the failures of 2026-11-04: two stacks of one profile
colliding on a worker ("The requested sandbox preview port is already in use"),
and preview URLs that X4 Code cannot decode, which make its panel say "Update the
X4 sandbox tools on this environment." while the stack runs. A test also
refuses a pinned `preview.port` in any session profile shipped in `registry/`.
When X4 Code changes `packages/contracts/src/sandbox.ts`, update the contract copy.
Shared inspect fixtures from X4 Code will replace it.

Run it after:

| Deploy | Why |
| --- | --- |
| A worker's x4 (`scripts/update-worker.sh`) or a new preview-domain worker | The worker starts the stacks and publishes their routes. Pass `--target` for a new worker. |
| A devbox bundle | It carries the x4 that X4 Code runs. Run from a devbox that has it. |
| An X4 Code release | It decodes `inspect`. Update the contract copy first if its contract changed. |
| Control's web server, or a registry apply that edits `sessionSandbox` or env bundles | Control lists and stops stacks. The smoke shows that the path to the worker still works; check the changed profiles themselves in X4 Code. |
| Preview domain routing (`deploy/domains`) | Every preview URL goes through it. |

### Profiles X4 offers every session

X4 lists sandbox profiles per repository, matched by the checkout's `origin`
remote, and the keys each env bundle must provide. Every session checkout of a
listed repository offers those profiles, with `defaultProfile` preselected.

The list comes from one place, checked in this order:

1. `X4_SESSION_SANDBOXES`, a file in the format of
   `registry/session-sandboxes.yaml`.
2. X4 Control's Projects registry, when `X4_REGISTRY_URL` is set (devboxes set
   it for X4 Code). A repository's `sessionSandbox` holds its
   `defaultProfile` and `profiles`, matched by its `canonicalRemote` and
   `aliases`; `envBundles` lists the keys each bundle must provide. Nothing
   falls back to the shipped file, so a repository without `sessionSandbox`
   offers no template profiles.
3. `registry/session-sandboxes.yaml`, shipped with X4.

In X4 Control a product may choose the profile its conversations start with:
`repoSets.<product>.product.repos.<repo>.sessionProfile`. A product workspace's
entry checkout records its product, so an SDAC conversation preselects `sdac`
while a plain Mastra-Agent-Framework checkout uses the repository's
`defaultProfile`.

```yaml
repos:
  mastra-agent-framework:
    # ...repository settings
    sessionSandbox:
      defaultProfile: sdac
      profiles:
        mastra: { ... }
        sdac: { extends: mastra, ... }
repoSets:
  handbook:
    product:
      repos:
        mastra-agent-framework:
          sessionProfile: handbook
envBundles:
  mastra-testing:
    required: [POSTGRES_CONNECTION_STRING, ...]
```

Profiles may set `displayName`, such as `displayName: X4 Website`, for the name
shown in X4 Code. Set it in Control’s repository preview-profile editor or a
registry YAML import. The profile ID stays stable for commands and saved
selections. Names belong to each profile and are not inherited; without one,
X4 Code formats the ID as a readable label.

Control's own `sandboxProfiles` are a different catalogue: the central profiles
`x4 workspace bootstrap` and remote sandboxes use. A session's own `.x4/sandbox.yaml` adds profiles
or replaces template profiles by id, and may `extend` them. Starting a stack on
a worker sends it both as one manifest.

For Mastra-Agent-Framework the template has a `mastra` base (the runtime with
container wiring and the `mastra-testing` bundle) and `sdac`, `k12`, `tap` and
`handbook` profiles that run each target's `dev:*` script; `sdac` adds the
widget with links to test districts. These use the shared testing environment
(`sharedData: true`), so changes are visible to others; X4 never runs
migrations there. `sdac-isolated-preview` uses fake providers and its own
database.

A profile may set `sharedData: true` to say its stack uses data shared with
other people, and a service's `preview.links` lists named pages
(`{ label, path }`, paths starting with `/`) offered next to its preview.

### Env bundles defined in X4 Control

Create environments from their product page in
[X4 Control](https://control.x4app.dev/projects/). A product can have several;
each has a `productId` owner and a stable bundle ID used by preview profiles.
Existing unassigned bundles remain usable while ownership is assigned. Choosing
a product's default environment supplies a workspace fallback; a profile's
explicit bundle still takes precedence.

With `X4_REGISTRY_URL` set, an env bundle in X4 Control's registry can define
its contents, so no machine keeps its own copy of the env file:

```yaml
envBundles:
  mastra-testing:
    required: [POSTGRES_CONNECTION_STRING, AZURE_AI_FOUNDRY_API_KEY]
    values:                  # plain settings, stored in Control
      DATABASE_BACKEND: postgres
    keyVault:                # secrets, read from Azure Key Vault at start
      vault: test-aitools-llfckv
      secrets:
        POSTGRES_CONNECTION_STRING: postgres-connection-string
        AZURE_AI_FOUNDRY_API_KEY: azure-ai-foundry-api-key
```

At start the host that starts the stack reads each secret with its Azure login
(`az login`; `X4_KEYVAULT_TOKEN` overrides the token), adds the values, checks
the required keys and sends the file to the stack's host. Control stores no
secret values: its history keeps full copies, so it refuses a value whose key
name looks like a secret (`*_PASSWORD`, `*_API_KEY`, `*_TOKEN`,
`*CONNECTION_STRING`, `*_KEYS_JSON` and similar). A bundle without `values` or
`keyVault` keeps using the host's file described below.

### Stacks built from several repositories

A product conversation's workspace holds the product's other repositories
under `.x4/repos/<repo>` (docs/product-workspaces.md). The Sandbox panel
offers the registry's sandbox profiles whose services all build from the
workspace's repositories, so a product such as K12 Prevent (frontend from
`ruunis-ui-modules`, API from `bta-poc`) can start its whole stack. They come
after the entry repository's own profiles, which keep their default and win on
a shared id: a K12 Prevent ticket routed to `bta-poc` offers `k12-prevent-api`
(its default) and the whole-product `k12-prevent`. A checkout outside a product
workspace offers only its repository's profiles.

On a worker, a start then:

- sends each repository the stack builds from at its own HEAD (a git bundle,
  incremental on restart), to `<stack>/repos/<repo id>` next to the checkout,
  overlays its uncommitted files with `--sync-working-tree`, and runs its
  dependency recipe;
- sends the chosen stack in the worker's manifest, with the entry repository
  as `repo: self` and the others under their registry ids;
- starts it with `x4 sandbox session start ... --repo <id>=<path>` for each,
  so the worker's workspace lists them and each service mounts its own;
- records each repository's commit in the stack's state and in the record X4
  Control's Previews view reads.

A repository manifest may name these repositories as well as `self`; the
worker refuses a service whose repository was not delivered. Workers need an
`x4` with `--repo` before a product starts such a stack on them. To try a new
`x4` on a worker before replacing the installed one, set
`X4_SESSION_WORKER_X4=<absolute path to its cli.js>` on the host that starts
the stack.

### Private GitHub code for installs

Some projects install code from other private repositories (K12 Prevent's
apps depend on `X4Org/bta-contracts`). An environment in X4 Control can list
them in `githubAccess` with the variable its install step reads:

```yaml
envBundles:
  k12-prevent-testing:
    githubAccess: { repositories: [X4Org/bta-contracts], variable: BTA_CONTRACTS_TOKEN }
```

At each stack start, the host that starts it asks X4 Control
(`POST /api/projects/env-bundles/<id>/github-access`, with its registry
token). Control asks X4's GitHub App for a token that can only read those
repositories and expires within an hour. `x4` adds it to that start's env
file only: on a worker it travels on the SSH session's stdin
(`x4 sandbox session start --extra-env-stdin`), never on a command line, and
it is never written to the installed bundle in `/etc/x4/env`. Nobody creates,
stores or rotates a token. The project's install step reads the variable
(K12 Prevent's start commands pass it to `npm ci`/`bun install` and remove it
before the app runs).

### Environment files for session stacks

A profile that needs secrets names an env bundle and opts services in:

```yaml
profiles:
  sdac-testing:
    extends: sdac-isolated-preview
    envBundle: sdac-test
    services:
      - id: runtime
        injectEnvFile: true
        environment:
          HOST: 0.0.0.0
          PORT: "4111"
```

A service listed without `repo` overrides only the fields it names on the
parent's service of the same id. `environment` is replaced as a whole, and a
service's `environment` wins over the env file, so a testing profile restates
only container settings (host, port, service URLs) and leaves out the parent's
placeholder credentials.

The bundle is a dotenv file on the host that runs the stack, at
`<env dir>/<bundle>.env`: `X4_ENV_DIR`, else `/etc/x4/env` (workers), else
`~/.x4/env`. No registry entry is needed; one can still add required keys or
forbidden patterns. Install or replace it, and check it, with:

```bash
x4 sandbox session env-set --entry . --profile sdac-testing --source .env   # testbox
x4 sandbox session env-set --entry . --profile sdac-testing --source .env --target local
x4 sandbox session env-status --entry . --profile sdac-testing
```

The host that starts stacks can keep the source copy instead, in
`~/.x4/secrets/<bundle>.env` (`X4_SECRETS_DIR`), readable only by its owner.
Every start then checks it for the template's required keys (names only are
reported) and sends it to the stack's host, so hosts never drift. This folder
is a placeholder for a secret store.

The file goes to the stack's host (the running stack's, else where `start`
would place it) and is shared by every session stack on that host that names
the bundle. Values are never printed: status reports presence, key count and
update time. In X4 Code, the Sandbox panel shows the same status and **Set env
file** uploads one. A stack whose bundle is missing fails to start with the
install command.

### Choosing an environment

A profile is the stack: its containers, commands, ports and health checks. An
environment is the values those containers get. One profile can start with
more than one environment: `envBundle` is its default, and `envBundles` lists
the others a session may choose instead.

```yaml
sandboxProfiles:
  k12-prevent:
    envBundle: k12-prevent-testing        # the default
    envBundles: [k12-prevent-imported]    # also offered
    services: [ ... ]
```

Each environment must exist and define every group the profile's containers
take with `bundleEnv`. In X4 Control, tick the profile under **Instead of their
own** on the environment's page, or under **Other environments** when editing a
repository's preview profile. Control lists profiles whose own environment
belongs to the same product.

A session's choice is kept with its checkout (`sandboxEnvBundle` in
`.x4/workspace.yaml`) and applies to every profile that accepts it; others use
their default. X4 Code's Sandbox panel shows an **Environment** menu under the
profile when there is a choice. From the command line:

```bash
x4 sandbox session bind  --entry . --profile k12-prevent --env-bundle k12-prevent-imported
x4 sandbox session start --entry . --profile k12-prevent --env-bundle k12-prevent-imported
```

`inspect` reports the session's environment as the profile's `envBundle` and,
when there is a choice, every option under `envBundles` (default first, each
with its `envSource` status). A running stack keeps the environment it started
with; stop it to change environment. The stack's host receives one
environment, written into the profile as its `envBundle`, so workers need no
update for this. Control's Previews view shows each stack's environment.

Previews require Tailscale on the host that runs the stack. X4
publishes HTTPS `*.ts.net` origins on isolated ports and verifies the route and
service status before offering a link. A service's `preview.port` reserves an
explicit HTTPS port; startup refuses an occupied port, so the profile runs once
per worker. Registries must mark such a service `preview.exclusive: true`
([registry guide](registry-guide.md#ports)). Non-browser services
still appear with status and dependencies. Stopping removes only routes that
still point at this sandbox. Routes created by other sessions remain intact.

The X4 Code environment needs `x4` on its PATH and SSH access to the worker
(local stacks also need Docker and non-interactive permission to manage
Tailscale Serve). The worker needs a current `x4` (`scripts/update-worker.sh`),
Docker, Git and Tailscale Serve permission for its SSH user. Operators can set
`X4_SANDBOX_CLI` to an executable or `.js` CLI path, `X4_SANDBOX_NODE` to its
external Node interpreter, and `X4_SANDBOX_PREVIEW_SUDO=1` when Serve requires
passwordless sudo. With remote X4 connections, these tools and the checkout
belong on the connected server.

### Legacy own values per container

An environment set in X4 Control can give one container its own value for a
variable, so two containers read the same name with different values. The
environment keeps them by container name, and they apply to that container in
every preview profile that uses the environment:

```yaml
envBundles:
  k12-prevent-testing:
    values: { OIDC_ISSUER: https://login.example/shared }
    keyVault: { vault: test-aitools-llfckv, secrets: { OPENAI_API_KEY: openai-api-key } }
    containers:
      k12-prevent:
        values: { OIDC_ISSUER: https://login.example/web }   # its own plain value
        secrets: { OPENAI_API_KEY: openai-api-key-web }     # its own secret, same vault
        omit: [LINEAR_API_KEY]                              # not given to it
```

These entries are retained for compatibility. They are keyed by service name
across every profile using the environment, so new edits should use the scoped
service variable selections below. Control shows existing overrides without
changing every service with the same name. To give services different values,
define separate source keys in the environment and map each service's variable
to the source key it needs.

A legacy override still takes precedence at its destination name, including
when a scoped selection maps a different source to that name. To migrate an
existing override, configure the affected profiles' distinct source mappings,
then remove the legacy entry through YAML import. The editor displays the
effective legacy source until that migration is complete.

The host that starts the stack resolves them with the shared values and carries
them in the prepared file under reserved names (`X4_CONTAINER__<CONTAINER>__<KEY>`
and `X4_CONTAINER_OMIT__<CONTAINER>`). The stack's host then writes each
container that gets the environment its own file,
`.x4/sandbox/env/service-<id>.env`, with its own values in place of the shared
ones; the shared file keeps no container's own lines. Container names that
differ only in `-` and `_` are refused. Forbidden key patterns apply to the
variable a line sets, not to the container's name.

Own values need values set in Control: an environment kept in the host's env
file has one value per name. Both the host that starts stacks and the stack's
host need an `x4` with this support before an environment uses it; an older
host that starts stacks ignores own values, and an older stack host would give
every container the reserved lines. Update workers with
`scripts/update-worker.sh` and devboxes' X4 Code release first.

### Per-service env

Existing services that omit both `bundleEnv` and `injectEnvFile: false` keep
receiving the whole bundle until explicitly converted. New services created in
Control start with an empty selection. A service with `bundleEnv` receives only the values it names, in
its own env file, so a frontend gets no database password and two services can
read the same variable name with different values:

```yaml
envBundles:
  mastra-testing:
    groups:                     # names only; values stay in the bundle
      ai: [AZURE_AI_FOUNDRY_ENDPOINT, AZURE_AI_FOUNDRY_API_KEY]
profiles:
  split:
    envBundle: mastra-testing
    services:
      - id: api
        bundleEnv:
          groups: [ai]                                # under their own names
          keys: [TAVILY_API_KEY]
          map: { DATABASE_URL: CORE_DATABASE_URL }    # name in the container: bundle key
      - id: worker
        bundleEnv:
          map: { DATABASE_URL: ANALYTICS_DATABASE_URL }
      - id: widget
        bundleEnv: {}                                 # nothing from the bundle
```

- Groups belong to the bundle: `envBundles.<id>.groups` in X4 Control (the
  **Groups** column of an environment's variables), in the templates file, or at the top
  level of `.x4/sandbox.yaml`. A manifest's group replaces a group of the same
  id. Control checks that a Control-defined bundle provides every grouped key.
  The manifest sent to a worker carries the groups, so the worker needs no
  access to Control.
- Every variable has one source. Two sources for one name, a name also set in
  the service's `environment`, or an unknown group stop the start. Only keys
  used by the selected profile's services are resolved. A missing or blank
  required service input stops the start; an explicitly optional input may be
  absent or blank. A selected key not declared optional remains required for
  compatibility. Unselected keys, including Key Vault references belonging to
  other services, do not block that profile.
- A service sets `bundleEnv` or `injectEnvFile`, not both. In a child profile,
  an override that names one drops the other inherited from the parent.
- The files are `.x4/sandbox/env/service-<id>.env`, mode 0600, rewritten at
  every start. `x4 sandbox explain` lists each service's variables
  (`DATABASE_URL <- CORE_DATABASE_URL`), never values.
- Hosts that start or run stacks need an `x4` that knows `bundleEnv` before a
  profile in Control uses it; an older `x4` refuses the profile. Update workers
  with `scripts/update-worker.sh` and devboxes' X4 Code release first. Groups
  alone are safe to add: they reach a worker only with a profile that uses them.

### Configure one service in Control

Open **Projects → Environments**, choose the environment, and use **Service
variables**. Select the exact stack profile and service. Repository-owned
profiles and global sandbox profiles are listed separately, so saving one
`api` service does not change another profile's `api` service.

Choose source keys and, when necessary, change their destination names. Saving
writes that service's `bundleEnv.keys` and `bundleEnv.map` in its profile;
profile inheritance and the other services are preserved. An empty selection
gives the service nothing from the environment. Ordinary fixed settings in the
profile remain separate.

This works for both supported sources:

- A private dotenv file supplies its existing named values. Control stores
  names and selections, and never needs the dotenv contents. K12 Prevent can
  keep this source without an Azure Key Vault.
- A Control-defined environment supplies ordinary values and Key Vault
  references. The initiating devbox reads only the selected secrets using its
  Azure login. Control does not persist their values.

For example, an environment can define `API_OIDC_ISSUER` and
`WIDGET_OIDC_ISSUER`. Each service maps its chosen source to `OIDC_ISSUER`.
The same mapping works when those two source keys are in a private dotenv file.

GitHub dependency access is configured separately. Select its token variable
only for services that install the listed private repositories. The token is
short-lived, but it is still present in those services' prepared files and
container configuration. Dropping it before launching the application does
not provide installation-only isolation; that needs a separate setup phase.

The existing applied environment receipt lists each service's names, sources,
references, and startup status. Missing optional selected inputs are recorded
as missing. Changing selections takes effect on the next start; restart a
running preview to apply it. Explicit bundle doctor/install commands continue
to validate the complete bundle rather than one service selection.

Update the initiating devbox and workers together. A start checks that its
worker supports private per-service preparation before sending any values;
an older worker reports that it needs an update.

## Mastra Docker execution runtime

The maintained `registry/x4-pilot-registry.yaml` provides `mastra-pilot` and
`mastra-stack` profiles for the registered Mastra repository. Use disposable
worktrees and a non-production environment when validating them. The shared
worker registry is not automatically updated by changing this file.

New sandboxes use Mastra Docker by default with the existing sandbox workflow:

```bash
x4 sandbox up --profile development --wait
x4 sandbox exec --service api -- node --version
x4 sandbox exec --service api --timeout-seconds 60 -- sh -lc 'npm test'
x4 sandbox status
x4 sandbox logs
x4 sandbox down
```

For a registry or repository-owned profile, set `executionRuntime: mastra-docker`
at profile level. It inherits through `extends`. Selection is explicit `--runtime`,
then profile configuration, then recorded sandbox runtime, then `mastra-docker`
for a workspace without sandbox state. Existing state without a runtime field
continues using Compose; upgrading X4 does not switch existing sandboxes.
`--backend local|ssh` selects the execution host independently. Remote startup
forwards the runtime to the worker, which needs this version of X4 and its pinned
dependencies. Upgrade workers along with the client: remote startup sends the
resolved runtime explicitly, including Compose for legacy sandboxes.

X4 still prepares the exact service configuration through `docker compose create
--build`: image builds, environment, host UID/GID, mounts, health checks, private
port bindings, service networks, and X4 inventory/expiry labels. A Mastra
`DockerSandbox` attaches to each prepared container and starts services in
dependency order. X4 continues checking application readiness and publishing
previews. Missing containers and ownership mismatches fail explicitly; Mastra
cannot create an unconfigured replacement or fall back to host execution.

`sandbox exec` uses Mastra's process manager in an already-running service. It
preserves argument boundaries, working directory and container environment,
streams stdout/stderr, returns the command exit code, and writes a log under
`.x4/sandbox/logs`. Timeout returns 124; cancellation terminates the command's
process group without stopping the service. Output from repository commands is
raw, like existing sandbox logs; X4's log scanner warns about possible secrets.
The existing `x4 test` host execution path is unaffected; select `sandbox exec`
explicitly when tests should execute inside a service container.

Execution is non-interactive. SSH streams output and uses a separate stdin
liveness channel to cancel the worker command when the client disconnects;
the command timeout also bounds execution if a network outage delays disconnect
detection. Both client and worker retain command logs.

Mastra stops service containers before X4's existing Compose teardown. Compose
remains responsible for removal and volume policy: Mastra's unconditional volume
removal would change the meaning of X4's non-force cleanup. The label sweep,
failure bundles, rollback, inventory, and TTL cleanup keep their existing role.
Cleanup through Compose remains possible if the SDK is unavailable.

This integration supports Unix Docker sockets, including rootless sockets,
on the selected host. Docker contexts and `DOCKER_HOST` must select a Unix
endpoint; unsupported endpoint types fail before provisioning. Use X4's SSH
backend for a remote worker. Select `--runtime compose` for other Docker transports.

To return an existing workspace to Compose, stop it first:

```bash
x4 sandbox down
x4 sandbox up --profile development --runtime compose --wait
```

Changing runtime on a running sandbox is refused. Update a profile's
`executionRuntime` too if Compose should remain the profile default. Old state
without a runtime field is treated as Compose. Metadata-only profiles still
start no containers and do not require a Docker connection.

Run `pnpm test:sandbox` for the runtime contract and real Docker parity suite;
see [testing](testing.md) for the rollout gates.

Use an explicit file for a one-off selection:

```bash
x4 sandbox explain --config ./sandbox.alternate.yaml --profile development
```

An explicit file replaces normal discovery for that command. It is not merged
with `.x4/sandbox.yaml` or central profiles. If no repository manifest exists,
legacy central `sandboxProfiles` continue to work.

To publish private tester URLs, choose shared paths or distinct origins per
service in the manifest, then run:

```bash
x4 preview serve \
  --profile development \
  --backend tailnet-proxy \
  --host 100.64.0.10 \
  --http-port 3000
```

Only tailnet hosts are accepted. `preview.mode: origin` services use separate
ports; path-mode services share the requested origin. Stop and inspect the
sandbox with the existing lifecycle commands:

```bash
x4 sandbox status
x4 sandbox logs
x4 sandbox down
x4 sandbox destroy --force
```

## Sandbox ownership

Every sandbox `x4 sandbox up` starts is stamped with a `com.x4.owner` container
label, surfaced by `x4 sandbox list`.

- **`--owner <label>`** — the label, used verbatim. Pass a developer or
  automation identity when starting a sandbox from the CLI to attribute it to
  that owner.
- **no `--owner`** — the `machine-id` strategy: `<os-user>@<first 8 chars of a
  UUID persisted at `~/.x4/machine-id`>`. Identifies the machine, not a person —
  the fallback for a plain CLI `sandbox up`.

Also stamped: `com.x4.created-at`, and `com.x4.expires-at` (unless
`--ttl-minutes 0`) — see `x4 control gc --reap-sandboxes`.

## Concurrent previews and ports

Two workspaces can preview at the same time on one machine. The CLI's two
preview paths select ports independently:

**Sandboxed services (`x4 sandbox up`).** Host ports are derived from a hash of
the workspace id (`sandboxPorts()`), starting at `14000 + offset`, and any port
already bound is skipped. Two different workspaces therefore never collide here.
The one exception is a service that pins an explicit `hostPort` in its profile:
two workspaces pinning the same `hostPort` *will* clash — leave `hostPort` unset
unless you genuinely need a fixed port.

**Dev-server preview (`x4 preview up --start`).** The port starts from the
repo's `registry.yaml` `preview.port`. If that port is already listening on
`127.0.0.1`, X4 probes upward for the next free one (up to +100), starts the dev
server on it via `$PORT`, and advertises the resolved port in the tester URL and
`.x4/workspace.lock.yaml`.

> The dev command must honour `$PORT` for the remap to take effect. Most Node
> servers and Next.js / CRA already do. **Vite does not by default** — add
> `server: { port: Number(process.env.PORT) || 5173 }` to `vite.config`.
> When a command ignores `$PORT`, X4 prints a `warn` line and the server keeps
> its hard-coded port, so two such workspaces still collide.

The standalone `x4-control-center` also had a per-project dashboard preview
proxy. That behavior is historical; see [repository
consolidation](x4-repository-consolidation.md) for its retirement. The CLI port
rules above describe the current commands.

## Last-known-good profiles

Every time `x4 sandbox up --wait` sees a profile's services reach readiness,
X4 snapshots that exact profile to `.x4/last-good-profiles/<profileId>.json`.
This survives `sandbox destroy --prune-artifacts` (it lives outside `.x4/sandbox/`).

```bash
x4 sandbox profile show-last-good --profile local-preview
x4 sandbox profile restore-last-good --profile local-preview   # overwrite the registry profile with the snapshot
x4 sandbox profile snapshot-good --profile local-preview       # record the current profile by hand
```

When `x4 ai sandbox-profile --write --feedback …` revises a profile after a
failure and a last-known-good snapshot exists that differs from what's on the
registry, the snapshot is injected into the prompt: the model is told to restore
it and apply only the minimal change the failure requires, rather than
re-deriving the whole profile from the repo scan.

`x4 ai sandbox-profile --verify` also records `docs/ai-registry-lessons.md`
entries as it goes — not only when the whole loop converges, but whenever
feeding one attempt's failure back gets the sandbox *past* it and the next
attempt fails on something else. That partial-progress lesson (symptom = the
blocker that was cleared, fix = the profile change that cleared it, scoped to
the workspace signatures) means a re-run — or a `--verify` for a similar
repo — starts past that first blocker instead of re-proposing the same broken
thing. A run that keeps hitting the identical failure records nothing.
