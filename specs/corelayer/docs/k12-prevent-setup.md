# K12 Prevent preview setup and testing

Run the K12 Prevent frontend and BTA API on an X4 worker using their existing
direct CoreLayer login. The shared broker is optional and requires a separate
integration; see the [authentication specification](specs/corelayer-preview-auth-integration-v1.md).

This is the BTA product in `ruunis-ui-modules` and `BTA-POC`. The Mastra `k12`
example uses a different profile and environment bundle.

## Prerequisites and acceptance

- Use a worker CLI and Control ingress that support explicit HTTPS preview
  ports. See the [routing guide](sandbox-custom-domains.md#runtime-installation-and-verification).
- Use the [K12 Prevent registry](../registry/k12-prevent.registry.yaml) and its
  private testing bundle.
- Ask CoreLayer to confirm the testing client, callbacks, browser origins and
  BTA authorization settings below.

Real K12 sign-in and case opening have **not** been verified. Complete the
application tests below before treating the integration as ready; synthetic
routing checks do not prove sign-in.

## What the testing environment bundle is

The bundle is a private settings file on the worker:

```text
/etc/x4/env/k12-prevent-testing.env
```

X4 supplies its values to the containers. The registry's `allowMissing: false`
blocks startup when the file or a required key name is missing. HTTPS routing
does not create this file or register a CoreLayer client.

Complete the [blank template](../examples/registries/k12-prevent-testing.env.template)
privately. The [registry's `envBundles.k12-prevent-testing` declaration](../registry/k12-prevent.registry.yaml)
defines the required keys; do not substitute `mastra-testing`.

| Configuration | Owner |
| --- | --- |
| `OIDC_ISSUER`, `EXPECTED_AUDIENCE`, `VITE_OIDC_ISSUER`, `VITE_TOKEN_EXCHANGE_URL` | CoreLayer with the K12 owner: confirm the testing client and BTA contract |
| Login/logout callbacks, browser origins/CORS, test account and tenant permissions | CoreLayer with the K12 owner |
| `BTA_CONTRACTS_TOKEN` with read access to private `X4Org/bta-contracts` | K12/repository credential owner |
| `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `RESEND_API_KEY`, `LINEAR_API_KEY` | K12/provider credential owners: supply approved testing keys |
| `NOTIFICATION_EMAIL_TO`, `FEEDBACK_EMAIL_TO`; optional `RESEND_FROM_EMAIL` | K12 owner: choose the test inbox and approved sender |
| Worker URLs and private installation of the completed file | X4 operator |

The K12 owner runs the application tests. CoreLayer supports identity,
authorization and roster issues; X4 supports startup and routing. Send private
values to the operator through an approved private channel.

## Exact URLs for dev04

This deployment example uses `dev04.x4app.dev` for SSH. Connect to Tailscale;
the additional HTTPS service ports retain their Tailscale hostname:

| Purpose | Exact URL |
| --- | --- |
| K12 frontend | `https://x4-devbox-04.tail49b150.ts.net:13100` |
| BTA API / `VITE_BTA_API_URL` | `https://x4-devbox-04.tail49b150.ts.net:15000` |
| Login / `VITE_OIDC_REDIRECT_URI` | `https://x4-devbox-04.tail49b150.ts.net:13100/callback` |
| Logout / `VITE_OIDC_POST_LOGOUT_REDIRECT_URI` | `https://x4-devbox-04.tail49b150.ts.net:13100/logout-callback` |

CoreLayer must confirm both callbacks on the existing testing `eduforge-shell`
client, browser endpoint/CORS permissions and BTA issuer/audience/authorization.
These callbacks belong to the frontend; they do not use `auth.x4app.dev`.

The fixed ports allow **one K12 Prevent stack per worker**. For another worker,
update the bundle URLs and confirm its exact CoreLayer callbacks before starting.
Change registry ports, bundle URLs and registrations together. If a port is
occupied, use another worker or coordinate with the existing stack's owner.

## Install and validate the configuration

Run on `dev04.x4app.dev` as `dev` with its installed `x4` CLI, Docker, Tailscale
and Git access to both application repositories. `BTA_CONTRACTS_TOKEN` installs
a private dependency; cloning the repositories also needs working Git credentials.

Set the actual absolute path of `registry/k12-prevent.registry.yaml` in an X4
checkout on the worker:

```sh
k12_registry=/path/to/x4/registry/k12-prevent.registry.yaml
x4 registry validate --registry "$k12_registry"
x4 env doctor --registry "$k12_registry" --bundle k12-prevent-testing
```

`doctor` reports missing key names without printing values and fails if the file
is missing. With `--json`, it exits zero even for an unconfigured bundle:
automation must inspect `configured`.

Complete the template outside Git. Keep values out of chat, shell arguments,
commits and build artifacts. Set `k12_testing_source` to the completed private
file and install it:

```sh
k12_testing_source=/private/path/k12-prevent-testing.env
sudo /usr/local/bin/x4 env install-bundle \
  --registry "$k12_registry" \
  --bundle k12-prevent-testing \
  --source "$k12_testing_source" \
  --local --owner root --group dev --mode 640
x4 env doctor --registry "$k12_registry" --bundle k12-prevent-testing
```

Installation writes the file at the worker bundle path with owner `root:dev`
and mode `640`, so `dev` can read it. Missing required keys or forbidden key names
prevent installation. **Empty assignments count as present keys**: fill every
required value even if `doctor` passes. Neither command verifies credentials
or provider acceptance. See the [environment contract](env-contract.md).

This profile reads the worker file. Adding a generic managed bundle in Control
does not configure it.

## Start the isolated K12 stack

Create a dedicated checkout on the worker. Choose another empty destination
if the example path already exists:

```sh
k12_entry=/home/dev/x4-previews/k12-prevent
mkdir -p /home/dev/x4-previews
git clone --branch develop https://github.com/X4Org/ruunis-ui-modules.git "$k12_entry"
x4 workspace bootstrap \
  --entry "$k12_entry" \
  --repo-set k12-prevent \
  --registry "$k12_registry" \
  --install skip --feature k12-prevent-preview
x4 sandbox up \
  --entry "$k12_entry" --profile k12-prevent --runtime compose \
  --wait --wait-timeout-seconds 900
x4 preview serve --entry "$k12_entry" --profile k12-prevent --sudo
x4 status --entry "$k12_entry"
```

Bootstrap attaches `BTA-POC` under `.x4/repos/`. Startup creates isolated
PostgreSQL and Azurite services, runs BTA migrations and the incident seed,
then starts the API and frontend. Containers install their dependencies. The
registry excludes staging files; database and storage configuration belong to
this preview.

Record source commits, worker, workspace and returned URLs with the test results.
Do not capture container environments or secret files.

## Test the real application

From a Tailscale-connected device, check both services:

```sh
curl --fail --silent --show-error \
  https://x4-devbox-04.tail49b150.ts.net:15000/health
curl --fail --silent --show-error --head \
  https://x4-devbox-04.tail49b150.ts.net:13100/
```

The K12 owner then tests with CoreLayer support:

1. Sign in through the frontend with an approved testing account. Confirm the
   return to its `/callback`, bypassing the shared broker.
2. Check the user/tenant, portal token exchange and authorized BTA requests.
   Browser requests must succeed without CORS errors.
3. Open a seeded case and test the intended workflow. Email actions must use
   the approved test inbox; enabled providers make real service calls.
4. Confirm unauthorized accounts/tenants are denied. Test session expiry,
   reauthentication and logout against the agreed policy.
5. If a roster is needed, arrange a CoreLayer sync and retest it. Scheduled sync
   is disabled, and the incident seed does not supply a roster.
6. Record separate results for health, login, API authorization, case opening,
   logout and roster. A healthy API does not prove sign-in.

For authentication failures, CoreLayer and K12 check registration, issuer,
audience, exchange/CORS policy and permissions. For startup failures, X4 checks
missing keys, dependency installation and service health. Use real testing
sign-in, without identity injection or a tester-login bypass.

## Stop or repeat the preview

Stop this workspace's containers and owned HTTPS routes:

```sh
X4_SANDBOX_PREVIEW_SUDO=1 x4 sandbox down --entry "$k12_entry"
```

Repeat `sandbox up` and `preview serve` in the same workspace to restart.
Normal Compose handling retains the preview data. Restart after bundle changes
so the frontend and API receive them. Never reset the worker's whole Tailscale
Serve state to clean up one preview.
