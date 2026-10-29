# Sandbox service URLs under x4app.dev

Each HTTP service in a sandbox can have its own HTTPS origin. A reviewer opens a normal URL on port 443; X4's private ingress sends the request to that sandbox's service on its worker. Containers still listen on their declared ports, and separate sandboxes still receive different internal host ports.

For a five-service Handbook deployment, the addresses can look like this:

| Service | Address |
| --- | --- |
| Frontend | `https://frontend-handbook-<sandbox>.preview.x4app.dev` |
| Backend API | `https://backend-handbook-<sandbox>.preview.x4app.dev` |
| Mastra | `https://mastra-handbook-<sandbox>.preview.x4app.dev` |
| Ingestion HTTP server | `https://ingestion-handbook-<sandbox>.preview.x4app.dev` |
| Admin UI | `https://admin-handbook-<sandbox>.preview.x4app.dev` |

`<sandbox>` is a stable 24-character digest of X4's workspace ID. Restarting the same workspace with the same hostname template preserves its URLs even when internal ports change. A new workspace gets a different digest. One label contains the service alias and sandbox identifier so a single `*.preview.x4app.dev` certificate covers every service. A name such as `frontend.handbook-123.preview.x4app.dev` would require an additional certificate.

The shareable Handbook registry example declares two services: `app` and `runtime`. It gives them `frontend-handbook-{sandbox}.{domain}` and `mastra-handbook-{sandbox}.{domain}` hostname templates. The app serves the web client and application API together, and the runtime runs Mastra. Creating five separate URLs requires declaring five actual HTTP services with their real startup commands and health checks. Splitting a name alone does not split the application into processes. Publish only the HTTP services that people or browser clients need; databases and service-to-service connections can keep their Docker-network addresses.

Browser configuration must use the published HTTPS URLs. For example, a separately hosted frontend calls the published backend origin, and the backend allows the frontend origin in its CORS settings. Server-to-server calls can continue using Docker service names. Development servers must accept their published hostname, and applications that generate redirects must know their external HTTPS origin.

## Registry and sandbox integration

The publisher applies to session sandboxes and the older `x4 preview serve` / `x4 sandbox up --serve-preview` commands on a configured execution host. A service gets an origin when it declares `containerPort` and either `kind: frontend`, `kind: api`, or an explicit `preview` block. Databases and workers without an HTTP preview remain internal. Unpinned domain services receive their own origins and automatically allocated internal transport ports. Explicit `preview.port` selects the pinned worker-origin compatibility contract described below.

X4 resolves references in each service's `environment` and `buildArgs` before creating Compose or building browser bundles. For example, these fields can be added to runnable services, using the variable names their application reads:

```yaml
- id: frontend
  kind: frontend
  containerPort: 3000
  preview: { mode: origin, hostname: "frontend-handbook-{sandbox}.{domain}" }
  environment:
    VITE_API_URL: "{{preview.backend.origin}}"
    INTERNAL_API_URL: http://backend:3001
  buildArgs:
    VITE_API_URL: "{{preview.backend.origin}}"
- id: backend
  kind: api
  containerPort: 3001
  preview: { mode: origin, hostname: "backend-handbook-{sandbox}.{domain}" }
  environment:
    PUBLIC_ORIGIN: "{{preview.backend.origin}}"
    CORS_ALLOWED_ORIGINS: "{{preview.frontend.origin}},{{preview.admin.origin}}"
```

The optional `preview.hostname` field is a template for a hostname, without `https://`, a port, or a path. The same service field works in the shared session registry, a repository's `.x4/sandbox.yaml`, and a full workspace registry's `sandboxProfiles`. Available variables are:

| Variable | Value |
| --- | --- |
| `{service}` | Lowercase DNS form of the service ID, shortened with a digest if longer than 18 characters |
| `{profile}` | Lowercase DNS form of the selected profile, shortened with a digest if longer than 12 characters |
| `{sandbox}` | Stable 24-character workspace digest |
| `{domain}` | Execution worker's operator-configured base domain, such as `preview.x4app.dev` |

A generic template is `"{service}-{profile}-{sandbox}.{domain}"`. A registry can choose an alias, such as `"mastra-handbook-{sandbox}.{domain}"`, without changing the container service ID. `{sandbox}` must appear exactly once, after `-` at the end of the label. The suffix can be omitted (for example, `"frontend-handbook-{sandbox}"`), `{domain}`, or the literal configured base domain; the expanded hostname must be one valid DNS label beneath that domain and fit DNS length limits. Unknown variables, fixed singleton names, another domain, and duplicate service hostnames fail before containers start. These restrictions preserve sandbox separation and the existing wildcard certificate coverage. DNS, TLS, and publisher credentials remain operator configuration.

Omitting both `hostname` and `port` preserves the existing automatic `{service}-{profile}-{sandbox}` naming, including shortening long names. On workers without domain publishing, a custom hostname cannot be honored: configure domain publishing before using a profile that declares it.

X4 does not add CORS middleware or change application authentication. `allowedHostEnv`, when declared, receives the service's external hostname. Unknown/unexposed service references fail before containers start. Generated-domain references require domain configuration; pinned services use their selected worker origins when those origins can be resolved.

The complete [five-service fixture](../examples/sandbox-service-domains/.x4/sandbox.yaml) demonstrates frontend/backend/Mastra/ingestion/admin origins and CORS between siblings. These are sample Node HTTP services, not Handbook. Its [verification program](../examples/sandbox-service-domains/verify.mjs) starts two stacks, checks ten HTTPS URLs and CORS isolation, then cleans up both.

Each worker needs the updated X4 CLI and an operator-owned configuration. Configuration is loaded from `X4_PREVIEW_DOMAINS_CONFIG`, otherwise `/etc/x4/preview-domains.json` if present, otherwise `~/.config/x4/preview-domains.json`:

```json
{
  "baseDomain": "preview.x4app.dev",
  "publisherUrl": "https://routes.x4app.dev",
  "tokenFile": "/absolute/operator/path/preview-publisher.token"
}
```

Provision the credential separately, scoped on the control server to that worker's exact Tailscale hostname and transport port range. It stays outside repository files, Docker mounts, generated Compose, command arguments and workspace metadata. `X4_PREVIEW_DOMAINS_CONFIG=off` selects the existing Tailscale URL publisher; restore domain configuration before stopping an already published domain sandbox.

On a configured worker:

```bash
x4 sandbox session start --entry /absolute/path/to/checkout --profile handbook --target local --preview-sudo
x4 sandbox session inspect --entry /absolute/path/to/checkout
x4 sandbox session stop --entry /absolute/path/to/checkout --preview-sudo
```

Omit `--preview-sudo` when the account can configure Tailscale Serve directly. Remote sandboxes use their execution worker's configuration; the submitting laptop does not forward publishing credentials. Existing stacks need republishing; new build/runtime URL settings also need a restart.

## Explicit fixed worker ports

For applications with already registered OIDC callback URLs or browser bundles configured with fixed worker URLs, an explicit preview port is authoritative:

```yaml
- id: frontend
  kind: frontend
  containerPort: 3100
  preview: { mode: origin, port: 13100 }
- id: backend
  kind: api
  containerPort: 5000
  preview: { mode: origin, port: 15000 }
```

These fields are excerpts to add to runnable services. On domain-configured execution hosts they produce `https://<worker>.ts.net:13100` and `https://<worker>.ts.net:15000`, while session publication also uses HTTPS. Those services bypass central domain publication; unpinned services in the same profile still receive generated domains. `{{preview.<service>.origin}}` uses the selected address when available. `allowedHostEnv` receives the corresponding external hostname.

Do not combine `preview.hostname` and `preview.port` on a service. An occupied explicit port fails instead of silently moving the application to an unregistered URL. The pinned pair is therefore limited to one stack per worker unless its ports, worker env URLs and CoreLayer registrations are changed together. Ports on a single hostname do not isolate cookies; distinct generated domains remain the default for concurrent previews and are required for separate broker registrations.

The [K12 Prevent registry](../registry/k12-prevent.registry.yaml) runs the BTA product separately from the Mastra `k12` profile. It uses the application's direct `eduforge-shell` OIDC/PKCE and portal/BTA-token flow. CoreLayer must confirm the exact frontend-origin login/logout registrations, browser endpoint/CORS permissions and existing BTA authorization, and the worker needs its completed K12 testing bundle. Real K12/CoreLayer sign-in has not been verified. Follow the [K12 Prevent setup and testing guide](k12-prevent-setup.md) for the complete operator sequence and application acceptance checklist.

Without domain configuration, the older generic `x4 preview serve` path retains its existing backend/protocol behavior; explicit ports do not enable domain publishing.

## Multiple previews of the same project

The examples in this section use unpinned generated domains.

Start the same profile from two separate X4 workspaces/checkouts. Each workspace has its own identity, Compose project, containers, allocated transport ports, and route publication. The lifecycle currently tracks one active sandbox/profile per workspace; use another workspace for another simultaneous preview.

For example, two Handbook workspaces using the same registry can produce these URLs:

| Service | Preview A | Preview B |
| --- | --- | --- |
| Web app/API | `https://frontend-handbook-4d6a2b9c10e74f86a39d5b21.preview.x4app.dev` | `https://frontend-handbook-b07e49ac81d3562f4c90a813.preview.x4app.dev` |
| Mastra | `https://mastra-handbook-4d6a2b9c10e74f86a39d5b21.preview.x4app.dev` | `https://mastra-handbook-b07e49ac81d3562f4c90a813.preview.x4app.dev` |

The differing digests distinguish the previews; the registry is unchanged. Share Preview A's frontend URL in its PR and Preview B's URL in its PR. With the five-service fixture, `{{preview.backend.origin}}` in A resolves to A's backend, and the same reference in B resolves to B's backend. Each backend's exact frontend/admin CORS origins follow its own workspace. Stopping A removes A's routes and listeners while B continues. Restarting A with the same template preserves A's URLs.

URL and container isolation do not isolate external data. The maintained Handbook, SDAC, K12, and TAP profiles inherit `sharedData: true` and the `mastra-testing` bundle: concurrent previews still use shared testing data/providers. Use dedicated databases/storage and appropriately scoped credentials when the work requires data isolation. The `sdac-isolated-preview` profile demonstrates a sandbox-local PostgreSQL and fake providers.

## Routing and authentication

Generated preview names resolve to X4's control ingress; pinned worker URLs go directly through the worker's HTTPS listener. The hostname selects an exact, registered route to a service on a worker. Wildcard DNS and TLS make new names possible without issuing a certificate or editing DNS for each sandbox; the route registry decides which names actually exist.

`routes.x4app.dev` hosts the authenticated publication interface. A publication owns every service route for one sandbox. The worker reserves upstream endpoints before activating listeners, writes a recovery journal for interrupted operations, and serializes listener changes across checkouts. Replacement is atomic at the ingress. Generation checks prevent a stale stop from deleting a newer publication; workers cannot overwrite another sandbox's hostname or transport endpoint.

Stopping removes ingress routes and worker listeners. The session reaper also attempts cleanup and retains the stack/checkout on failure so it can retry. Registrations persist across ingress restarts. This version has no independent route lease or abandoned-worker reconciliation: operators must retire abandoned publications before reusing their reserved endpoints. A Docker TTL label alone does not stop containers; the X4 reaper must run. Preview routes use the control host's Tailscale port-443 access policy; applications retain responsibility for application authorization.

`auth.x4app.dev` remains the shared authentication gateway, deployed in setup mode pending CoreLayer details. The proposed callbacks remain `https://auth.x4app.dev/callback` and `https://auth.x4app.dev/logout-callback`. The proof of concept associates login transactions with their originating preview. Applications adopting the broker need its receiving adapter and their own session. Applications retaining direct OIDC keep their existing client and exact app-origin callbacks instead. Custom hostnames alone do not integrate either authentication contract, CoreLayer's portal token exchange or BTA API authentication.

The [illustrated CoreLayer integration specification](specs/corelayer-preview-auth-integration-v1.html), also available as [Markdown](specs/corelayer-preview-auth-integration-v1.md), is the handoff document for CoreLayer and consuming application teams. It includes exact client registration settings, ownership, the existing X4 broker interface, unresolved portal/BTA requirements, and real-provider acceptance gates. K12 is one example consumer. The [client registration example](specs/corelayer-preview-client.example.json) contains no secret.

## DNS and certificate prerequisites

The control server is `control01.x4app.dev`, tailnet address `100.94.115.83`. These DNS-only Cloudflare records point to it:

| Record | Type | Value |
| --- | --- | --- |
| `*.preview.x4app.dev` | A | `100.94.115.83` |
| `routes.x4app.dev` | A | `100.94.115.83` |

The services remain private to authorized Tailscale clients. Public DNS can resolve a tailnet address; the address itself still requires tailnet connectivity and the ingress access checks.

The preview wildcard has its own certificate, covering `*.preview.x4app.dev`. The existing `*.x4app.dev` certificate covers `routes.x4app.dev` and `auth.x4app.dev`. The preview renewal script validates the wildcard SAN, remaining validity, certificate trust, and matching key before installing a generation. The certificate and key are root-owned with mode `0600`; an atomic `preview-current` symlink selects the installed generation.

Files on the control server:

| Purpose | Path |
| --- | --- |
| Preview certificate | `/var/lib/x4-domains/certificates/preview.crt` |
| Preview private key | `/var/lib/x4-domains/certificates/preview.key` |
| Current pair | `/var/lib/x4-domains/certificates/preview-current` |
| Renewal script | `/usr/local/sbin/x4-preview-domain-renew` |
| Renewal service | `/etc/systemd/system/x4-preview-domain-renew.service` |
| Daily renewal timer | `/etc/systemd/system/x4-preview-domain-renew.timer` |
| Cloudflare credentials | `/etc/x4-domains/cloudflare.env` (root only) |

The preview timer is independent of the existing fleet certificate timer. Both renewals coordinate access to the shared ACME account through `/run/x4-domain-renew.lock`. The ingress can reload the certificate on a new TLS handshake. A TLS loader requiring a strict certificate/key snapshot should resolve `preview-current` once and read both files from that resolved generation.

To reproduce these prerequisites, copy the four `deploy/domains/preview-*` scripts/units to the control server and run `bash preview-prerequisites.sh` as root from their directory. It reads the server's existing Cloudflare credential file, refuses conflicting DNS records, installs its own renewal units, and starts the initial issuance. It does not configure sandbox routes; publication is the next layer.

Verify the prerequisite state with:

```bash
systemctl status x4-preview-domain-renew.timer
systemctl status x4-preview-domain-renew.service
openssl x509 -in /var/lib/x4-domains/certificates/preview.crt -noout -dates -ext subjectAltName
```

## Runtime installation and verification

The worker needs an X4 CLI that supports hostname templates, explicit preview ports and effective service origins. Control needs the corresponding ingress runtime. Loading a project registry does not install either runtime; verify the installed versions and routing behavior before starting the application.

The controlled ingress installer is `deploy/domains/preview-install-routing.py`. It provisions `dev04.x4app.dev`; adapt its explicit worker identity and operator paths when extending to another worker. It preserves existing static routes, validates staged configuration, takes backups, and rolls back if existing service responses or authentication health change. Record the source revision, backup location, rollback command and verification results with each deployment.

Run the live routing check from the X4 checkout on the configured worker:

```bash
node examples/sandbox-service-domains/verify.mjs /tmp/x4-sandbox-domain-live-verification.json
```

The fixture checks generated-domain HTTPS routing, effective service origins, CORS isolation and cleanup using synthetic services. Re-run routing verification after runtime changes and confirm that existing previews remain available. Application capability grants do not authorize TCP traffic; unknown network constraints fail closed.

For direct K12 login, follow the [K12 setup guide](k12-prevent-setup.md) to install the private testing bundle, confirm CoreLayer registrations, start the stack and run real health, sign-in, logout and case-opening acceptance. Roster data requires a CoreLayer sync. Passing synthetic routing checks does not complete these application tests. The optional broker at `auth.x4app.dev` remains in setup mode with real login disabled.
