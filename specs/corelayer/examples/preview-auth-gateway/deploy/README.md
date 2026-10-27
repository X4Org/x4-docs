# Private authentication gateway on x4-control-1

The standalone gateway is installed at **https://auth.x4app.dev/** in **setup
mode**. The service runs continuously and starts at boot. It accepts no sign-in,
callback, preview registration, ticket redemption or session operation until a
real CoreLayer client is configured. No mock identity provider is deployed.

## Installed configuration

| Setting | Value |
| --- | --- |
| Server | `x4-control-1` (`100.94.115.83`) |
| DNS | DNS-only A record, `auth.x4app.dev` → `100.94.115.83`, TTL 300 |
| HTTPS ingress | Existing `x4-domain-ingress.service`, port 443 over Tailscale |
| Certificate | Existing `*.x4app.dev` certificate and renewal timer |
| Backend | `http://127.0.0.1:4400`, external Host preserved |
| Service | `x4-preview-auth-gateway.service`, enabled at boot |
| Service account | `x4-auth`, unprivileged, no interactive login |
| Current application | `/srv/x4/preview-auth-gateway/current` |
| Initial release | `/srv/x4/preview-auth-gateway/releases/20261026T173018Z` |
| Private environment | `/etc/x4-auth/gateway.env`, root-owned mode 0600 |
| Ingress configuration | `/etc/x4-domains/ingress.json` |
| Deployment backup | `/var/lib/x4-auth/deploy/20261026T173018Z/` |

Only the gateway code and its dependencies are installed. The demo issuer and
preview applications remain local examples. Existing Control/Factory routes and
the Tailscale Serve configuration are preserved. The new route checks access
against the host's port-443 Tailscale policy and does not substitute Tailscale
identity for CoreLayer login. Reviewers still need Tailscale connectivity and
appropriate tailnet permissions.

## Verify and operate

From a device with Tailscale access:

```sh
curl https://auth.x4app.dev/health
curl -i https://auth.x4app.dev/readyz
```

In setup mode, health returns HTTP 200 with `mode: "setup"` and
`configured: false`; readiness returns HTTP 503. The root page explains that
CoreLayer setup is pending. Authentication endpoints also return HTTP 503. No
credentials or provider requests are used to produce these responses.

On the control server:

```sh
sudo systemctl status x4-preview-auth-gateway.service
sudo journalctl -u x4-preview-auth-gateway.service --since '10 minutes ago'
sudo systemctl restart x4-preview-auth-gateway.service
```

The gateway does not log request URLs, callback codes, handoff tickets or tokens.
Avoid adding query-string access logging at the proxy.

## Activate real CoreLayer authentication

Agree the [official integration proposal](../../../docs/specs/corelayer-preview-auth-integration-v1.md)
and its acceptance gates first. The [client registration example](../../../docs/specs/corelayer-preview-client.example.json)
contains the requested non-secret client settings. Configuration alone does not
implement the K12 receiving adapter, lifecycle hooks or portal/BTA API adapter.

The CoreLayer team needs to provision a dedicated preview OIDC client using the
authorization-code flow, PKCE S256 and `client_secret_basic`. Register exactly:

```text
Login redirect:       https://auth.x4app.dev/callback
Post-logout redirect: https://auth.x4app.dev/logout-callback
```

Confirm RP-initiated logout support and its configuration with CoreLayer. The
browser follows these redirects; it must be able to reach the private gateway.
The gateway needs outbound access to discovery, token and JWKS endpoints.

Supply these settings through the private environment file using secure secret
input; do not commit credentials or paste them into chat:

```dotenv
X4_AUTH_MODE=oidc
OIDC_ISSUER_URL=<real issuer URL>
OIDC_CLIENT_ID=<dedicated preview client ID>
OIDC_CLIENT_SECRET=<private client secret>
OIDC_SCOPE=openid profile email
# OIDC_AUDIENCE=<required audience, if supported>
```

Keep the existing `X4_AUTH_BASE_URL`, `X4_AUTH_REGISTRATION_TOKEN`, `LISTEN_HOST`
and `LISTEN_PORT` settings. The installer generated the registration token on
the server; it is not a CoreLayer client secret. Setup mode deliberately rejects
partially supplied OIDC credentials. In OIDC mode, missing credentials or invalid
configuration prevent startup.

Validate the private configuration without printing its contents:

```sh
sudo systemd-run --quiet --wait --pipe --collect \
  --property=User=x4-auth --property=Group=x4-auth \
  --property=EnvironmentFile=/etc/x4-auth/gateway.env \
  /usr/bin/node /srv/x4/preview-auth-gateway/current/gateway-cli.mjs --check
sudo systemctl restart x4-preview-auth-gateway.service
curl -i https://auth.x4app.dev/readyz
```

OIDC readiness reports whether discovery succeeded and the authorization, token
and JWKS endpoints were advertised. Successful discovery is cached in memory.
This check does not validate the client secret, registered callbacks, a real
login, K12 sessions, the portal exchange or BTA permissions.

## Remaining integration and limitations

The installed gateway is experimental and uses in-memory state. A restart loses
preview registrations, transactions and sessions. It has no refresh handling,
shared persistent store or global logout notifications. Real CoreLayer login
and logout have not been tested.

X4 must still register/renew/remove previews using the gateway contract, and
K12 needs the receiving session adapter and its portal/BTA integration. This
auth deployment adds only the auth hostname and service. X4's separate
[custom service-domain implementation](../../../docs/sandbox-custom-domains.md)
publishes preview subdomains on the configured worker, but does not connect them
to gateway registration or change K12 authentication code. See the
[example README](../README.md) for the backend contract and acceptance test.

The current logout endpoint invalidates the initiating broker session and then
requests upstream RP-initiated logout. Sibling broker sessions remain locally
active without global logout notifications. Confirm the intended effect on
CoreLayer SSO and other clients before enabling this behavior. The installed
setup-only release is unchanged by the source-level hardening in this example.

## Release installation and rollback

Extract a tested release under
`/srv/x4/preview-auth-gateway/releases/<release-id>/`, containing `gateway.mjs`,
`service.mjs`, `gateway-cli.mjs`, both package files, and `deploy/`. Run its
[`install-service.sh`](install-service.sh) as root. The installer preserves an
existing private environment file and installs the systemd unit. It does not
change DNS or ingress. Preview/session state is lost when the service restarts.

The initial deployment backup contains `ingress.before.json`,
`ingress.desired.json`, `serve.before.json`, and `dns.created.json`. The live
ingress was compared with the original immediately before its atomic update.

To roll back this initial deployment, remove only the `auth.x4app.dev` route
from the current ingress configuration, restart `x4-domain-ingress.service`,
remove the matching auth DNS record, and disable/stop
`x4-preview-auth-gateway.service`. Preserve later routes and unrelated changes;
restore the entire snapshot only after checking that no later changes would be
lost. No Tailscale Serve change is required for this rollback.
