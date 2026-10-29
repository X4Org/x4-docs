# X4 Env Contract v0

This page describes X4's file-backed environment contract: key requirements,
private installation and runtime injection. Configured session bundles may
also use Control and Azure Key Vault; see [sandbox configuration](sandbox.md#env-bundles-defined-in-x4-control).
Secret owners remain responsible for the approved values and their rotation.

For the BTA application's exact bundle, ownership, worker URLs and start/test
commands, use the [K12 Prevent setup guide](k12-prevent-setup.md).

## Model

Developers may keep using local `.env` files for personal devbox work. Remote
test and preview jobs should use worker-local, non-production env bundles such
as:

```text
/etc/x4/env/mastra-pilot.env
```

X4 validates the bundle by key name before the job runs. Installation and
runtime injection create private files; they do not print values or rotate
credentials. Empty assignments count as present keys. A successful key-name
check does not verify nonempty values, provider credentials or real sign-in.

## Registry Contract

The registry may define reusable bundles:

```yaml
repoSets:
  x4-mastra-pilot:
    envBundle: mastra-pilot

envBundles:
  mastra-pilot:
    path: /etc/x4/env/mastra-pilot.env
    allowMissing: true
    required:
      - MASTRA_API_URL
    optional:
      - AZURE_OPENAI_ENDPOINT
    forbiddenPatterns:
      - "[Pp][Rr][Oo][Dd]([Uu][Cc][Tt][Ii][Oo][Nn])?"
```

For the current POC registry, the bundle is declared with no required keys and
`allowMissing: true` so existing remote tests keep working while the real
Mastra non-production key list is discovered.

## Commands

```bash
x4 env doctor --entry "$PWD"
x4 env doctor --bundle mastra-pilot
x4 env doctor --bundle mastra-pilot --file /etc/x4/env/mastra-pilot.env
x4 env doctor --bundle mastra-pilot --json
x4 env install-bundle \
  --bundle mastra-pilot \
  --source /home/dev/dev/.env \
  --target x4-testbox-standard-1 \
  --filter-forbidden
x4 env install-bundle \
  --bundle mastra-pilot \
  --source /tmp/pasted.env \
  --registry ./registry.yaml \
  --repo-set x4-mastra-pilot \
  --local \
  --filter-forbidden
```

The command reports only file path, counts, missing key names, and forbidden key
names. It never prints values.

### `x4 env doctor --json`

`--json` emits exactly one JSON object to stdout and nothing else:

```json
{
  "bundleId": "mastra-pilot",
  "filePath": "/etc/x4/env/mastra-pilot.env",
  "configured": true,
  "present": ["AZURE_INFERENCE_ENDPOINT", "MASTRA_API_URL"],
  "required": ["MASTRA_API_URL"],
  "optional": [],
  "missing": [],
  "forbidden": []
}
```

`present` is the set of key names found in the bundle file — **names only, never
values** (a missing file yields `present: []`). `configured` is `true` only when
the file exists, no required key is missing, and no forbidden key is present.
Unlike the human form, `--json` exits `0` even when the bundle is not configured
(missing file / missing required key / forbidden key present); the caller reads
`configured`. It exits non-zero only if the command itself errored (e.g. unknown
bundle). The human output is unchanged when `--json` is absent.

### `x4 env install-bundle --local`

`--local` writes the sanitized bundle directly to `bundle.path` on the current
host — no execution model, no worker resolution, no SSH. This is the path the
x4-control-center dashboard uses because it runs on the same host as the
sandboxes. `--local` and `--target` are mutually exclusive.

It prints the same lead lines as the SSH path (`env bundle:`, `registry:`,
`source:`, `target: local`, `destination:`, `keys:`, `removed forbidden-key
lines:`) and the same `fail missing required key:` / `fail forbidden key/pattern
present:` lines with a non-zero exit when a required key is missing or a
forbidden key is present (no file is written in that case). `--dry-run` prints
the plan followed by `dry run: no file written` and returns.

Otherwise it creates `dirname(bundle.path)` and writes the file with the
`--mode` bits (default `640`). `--owner` / `--group` are applied best-effort
**only** when explicitly passed and the process is root; a `chown`/`chmod`
failure is a `warn` line, not fatal (the common case is the file is already
owned correctly). On success: `ok installed env bundle <id>`.

`x4 env install-bundle` is the v0 operator workflow for turning a local
developer-provided dotenv file into a worker-local bundle. It reads the bundle
path and forbidden patterns from the registry, reads the target worker from the
execution model, normalizes CRLF line endings, optionally removes forbidden-key
lines, streams the sanitized file to the worker over SSH stdin, and sets the
destination owner/group/mode. It does not print secret values. By default it
refuses forbidden keys; `--filter-forbidden` must be explicit for the POC
sanitization behavior.

Remote jobs can opt into a bundle explicitly:

```bash
x4 remote test --execute --env-bundle mastra-pilot
x4 control test --execute --env-bundle mastra-pilot
```

If a repo set declares `envBundle`, remote/control test jobs use that bundle by
default.

## Worker Runtime

The env file stays on the worker VPS. The generated remote job script:

1. checks that the file exists when required;
2. validates required and forbidden key names;
3. parses the worker-local env file into a shell-safe, run-scoped runtime file;
4. sources only that generated runtime file for the job process tree;
5. runs workspace bootstrap and `x4 test`;
6. removes the generated runtime env file and cleans remote workspaces/artifacts
   according to normal remote cleanup policy.

This lets Docker Compose or child test processes receive values from the worker
environment without copying the env file back to devboxes, GitHub comments, or
artifacts.

For sandbox services, X4 treats the bundle as one whole runtime env file rather
than classifying every key. `x4 sandbox up --env-source <file>` copies a
sanitized, CRLF-normalized, job/workspace-scoped env file into
`.x4/sandbox/env/` and generated Compose services receive it through `env_file`.
The runtime copy is not tracked, printed, posted, or copied into artifacts.

The parser handles common dotenv files with CRLF line endings, `export KEY=...`
prefixes, comments, quoted values, and unquoted values containing spaces. The
original bundle file remains worker-local trusted configuration; the generated
runtime file is job-scoped and is removed by the remote job exit trap.

## Other providers

The worker file is one source. Session bundles configured in Control can
already resolve declared values and Azure Key Vault references at startup;
see [environment bundles in sandbox configuration](sandbox.md#env-bundles-defined-in-x4-control).
A registry that declares only a file path, including `k12-prevent-testing`,
still requires that worker file. Other secret providers need their own
integration; declaring a bundle ID alone does not configure them.
