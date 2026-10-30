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
  retires their preview routes and removes their worker directory.

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
Control.

A stopped stack keeps its workspace folder (checkout, env file and start
record) and its Docker volumes, and Control lists it as Stopped. Deleting it in
Control, or `x4 sandbox stacks delete <id>` on the worker, stops it if needed
and removes those too; it then disappears from the list.

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

Previews require Tailscale on the host that runs the stack. X4
publishes HTTPS `*.ts.net` origins on isolated ports and verifies the route and
service status before offering a link. A service's `preview.port` reserves an
explicit HTTPS port; startup refuses an occupied port. Non-browser services
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

### Per-service env

By default every service that does not set `injectEnvFile: false` receives the
whole bundle. A service with `bundleEnv` receives only the values it names, in
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
  **Key groups** field of an environment), in the templates file, or at the top
  level of `.x4/sandbox.yaml`. A manifest's group replaces a group of the same
  id. Control checks that a Control-defined bundle provides every grouped key.
  The manifest sent to a worker carries the groups, so the worker needs no
  access to Control.
- Every variable has one source. Two sources for one name, a name also set in
  the service's `environment`, or an unknown group stop the start. So does a
  bundle key missing from the env file, reported by name.
- A service sets `bundleEnv` or `injectEnvFile`, not both. In a child profile,
  an override that names one drops the other inherited from the parent.
- The files are `.x4/sandbox/env/service-<id>.env`, mode 0600, rewritten at
  every start. `x4 sandbox explain` lists each service's variables
  (`DATABASE_URL <- CORE_DATABASE_URL`), never values.
- Hosts that start or run stacks need an `x4` that knows `bundleEnv` before a
  profile in Control uses it; an older `x4` refuses the profile. Update workers
  with `scripts/update-worker.sh` and devboxes' X4 Code release first. Groups
  alone are safe to add: they reach a worker only with a profile that uses them.

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

- **`--owner <label>`** — the label, used verbatim. The x4-control-center
  dashboard passes the operator's **GitHub login** here (from its "Sign in with
  GitHub"), so a dashboard-run sandbox is attributed to a person.
- **no `--owner`** — the `machine-id` strategy: `<os-user>@<first 8 chars of a
  UUID persisted at `~/.x4/machine-id`>`. Identifies the machine, not a person —
  the fallback for a plain CLI `sandbox up`.

Also stamped: `com.x4.created-at`, and `com.x4.expires-at` (unless
`--ttl-minutes 0`) — see `x4 control gc --reap-sandboxes`.

## Concurrent previews and ports

Two workspaces can preview at the same time on one machine. Three separate
layers pick ports, and each isolates itself:

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

**Dashboard preview proxy (x4-control-center).** Each project's tailnet preview
proxy binds its own port, `8080 + hash(projectId) % 400` (overridable with
`"previewProxyPort"` in `config/projects.json`), so two projects' Live Preview
panels never contend for one port and one project's teardown never kills
another's proxy.

## Last-known-good profiles

Every time `x4 sandbox up --wait` (or the control-center self-heal loop) sees a
profile's services reach readiness, X4 snapshots that exact profile to
`.x4/last-good-profiles/<profileId>.json`. This survives `sandbox destroy
--prune-artifacts` (it lives outside `.x4/sandbox/`).

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
