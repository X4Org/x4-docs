# CoreLayer preview integration: contract audit

**Reviewed:** 2026-10-26. This note supports the [integration specification](../specs/corelayer-preview-auth-integration-v1.md). It compares the local proof of concept with primary OAuth/OIDC sources. CoreLayer's deployed Hydra version, client configuration, portal exchange, BTA API and real K12 integration were not inspected or exercised. Findings about those systems are questions or proposed requirements, not verified capabilities.

## Decision and implementation boundary

The viable design is a **confidential authentication broker with an application session adapter**. The gateway owns one CoreLayer OIDC client and code exchange; each preview owns its local browser session. OAuth `state` correlates a server-side transaction to a previously registered preview. A separate, single-use handoff protocol establishes the preview session after OIDC completes. This is not a transparent callback relay and does not preserve an existing K12 client integration without application work. A gateway-client ID token cannot replace an ID token whose audience is K12's existing client. [OIDC Core §§3.1.3.7, 8–9][oidc-validation]

The [gateway](../../examples/preview-auth-gateway/gateway.mjs), [service wrapper](../../examples/preview-auth-gateway/service.mjs) and [sample preview adapter](../../examples/preview-auth-gateway/preview.mjs) implement this pattern against a mock issuer. [Deployment documentation](../../examples/preview-auth-gateway/deploy/README.md) records `auth.x4app.dev` in setup mode, with authentication disabled pending real credentials. The [domain publisher](../../src/preview-domains.ts) and [registry hostname configuration](../sandbox-custom-domains.md) provide routing; they do not automatically register previews with the authentication gateway. There are no gateway lifecycle calls in `src/` at this audit point.

## CoreLayer client configuration to agree

| Setting | Required integration profile / current implementation |
| --- | --- |
| Client ownership | Dedicated non-production X4 preview client; confidential backend credentials held by the gateway, never registry YAML, a browser bundle or an untrusted preview. |
| Issuer | CoreLayer must supply the exact HTTPS issuer. Discovery must return the same issuer and usable authorization, token and JWKS endpoints. Do not guess an issuer from a portal URL. [Discovery §§3–4][discovery] |
| `redirect_uris` | Exactly `["https://auth.x4app.dev/callback"]`. No wildcard, preview hostname, varying port or `return_to` parameter. OAuth's resulting `?code=…&state=…` response is normal; it is not an additional registered callback. [RFC 9700 §2.1][bcp], [OIDC §3.1.2.1][oidc-auth] |
| `response_types`, `grant_types` | `["code"]`, `["authorization_code"]`. The gateway uses code exchange plus PKCE `S256`, independent `state` and nonce. It is not an implicit-flow or browser-secret client. [RFC 7636 §4][pkce], [RFC 9700 §2.1.1][bcp] |
| `token_endpoint_auth_method` | `client_secret_basic`, matching the explicit `openid-client` configuration. Supporting `private_key_jwt` or another method requires gateway configuration/code changes; it is not currently selectable. [OIDC §9][client-auth] |
| Scopes and claims | Default request is `openid profile email`; agree a least-privilege list. `openid` is required. Profile/email values need not be present in the ID token merely because those scopes were requested; the current adapter does not call UserInfo. Identify required claims and their delivery location explicitly. [OIDC §§5.3–5.4][claims] |
| Audience | Agree the API audience and its actual request mechanism. `OIDC_AUDIENCE` currently adds one literal `audience` authorization parameter. This is not an implementation of RFC 8707 `resource`, and does not prove a resulting access token is accepted by BTA. |
| `post_logout_redirect_uris` | Exactly `["https://auth.x4app.dev/logout-callback"]` if upstream logout is enabled. Require and test an `end_session_endpoint`, accepted `id_token_hint`, logout `state`, and the desired SSO behavior. RP-initiated logout is separately specified; discovery of login endpoints alone does not establish it. [RP-Initiated Logout §§2–3][logout] |
| Refresh | Not implemented. Do not request `offline_access` or promise silent refresh in the initial profile. If later required, agree `refresh_token` grant, consent, token rotation, reuse detection, TTL and revocation before implementation. Ory documents allowed/requested/granted `offline_access` plus the appropriate grants for refresh issuance. [RFC 6749 §6][refresh], [Ory refresh requirements][ory-refresh] |

CoreLayer should confirm the dedicated client's login/consent policy permits the intended testers. This architecture requires ordinary exact client registration; it does not require wildcard matching or an OAuth protocol extension. The separate CoreLayer portal/BTA policies may still require changes. Ory explicitly rejects wildcard redirect patterns and documents managing exact URI lists. [Ory client documentation][ory-clients]

The browser must reach the private gateway and preview hostnames, currently through Tailscale; the gateway must reach CoreLayer discovery/token/JWKS endpoints. The authorization server returns the callback through browser navigation, so this alone does not require CoreLayer's server to connect to the private callback. A future back-channel logout endpoint would create a separate server-reachability requirement. Server-to-server code exchange needs no browser CORS permission. Browser calls to BTA or another API still need their own origin/CORS policy. [Ory CORS documentation][ory-cors]

## Exact current X4-side contract

These routes describe the **experimental implementation**, not a new CoreLayer API. JSON `expiresAt` values are Unix epoch milliseconds. All gateway responses use `Cache-Control: no-store`.

| Route | Caller and request | Result / binding |
| --- | --- | --- |
| `POST /previews` | Trusted controller; administrative bearer credential. `{id, generation, origin, redeemSecret, leaseMs?}` | `201 {id,generation,origin,expiresAt}`. Default/max lease one hour; min one second. Same-generation renewal requires unchanged origin/credential; replacement purges old transactions and sessions. Active previews must have distinct hostnames, including when ports differ. |
| `DELETE /previews/:id` | Controller administrative bearer; JSON `{generation}` | Removes the matching generation and invalidates its records. An old generation cannot delete a replacement. |
| `POST /login/start` | Preview backend's per-generation bearer; `{previewId,generation,returnState,challenge}` | `{loginUrl}` containing a random opaque request. `challenge` is base64url SHA-256 of the preview-held handoff verifier; `returnState` identifies its local browser transaction. |
| `GET /login?request=…` | Browser | Consumes the start request, creates separate upstream state/nonce/PKCE/browser binding and redirects to CoreLayer with the fixed `redirect_uri`. |
| `GET /callback?code=…&state=…` | Browser returning from CoreLayer | Checks gateway browser cookie/state, exchanges the code server-side with its original PKCE verifier and fixed redirect URI, validates the ID token, then redirects only to the registered origin's `/auth/callback?ticket=…&transaction=…`. Access/refresh tokens are not handed to the preview or placed in that URL. |
| `POST /handoff/redeem` | Preview backend bearer; `{previewId,generation,ticket,verifier}` | Atomically consumes a matching ticket; returns `{identity,sessionId,expiresAt}`. `identity` contains `iss`, `sub`, optional `name`/`email`. It contains no BTA access token, tenant, roles or `email_verified`. |
| `POST /session/validate` | Preview backend bearer; `{previewId,generation,sessionId}` | `{active:false}` or `{active:true,identity,expiresAt}`. Checks the gateway's local session and registration, not current upstream SSO, token revocation, introspection or BTA authorization. |
| `POST /session/logout` | Preview backend bearer; `{previewId,generation,sessionId}` | Invalidates this gateway session and returns `{logoutUrl}`. |
| `GET /logout?request=…` | Browser | Consumes an opaque start, creates browser-bound logout state and requests upstream RP logout with `id_token_hint` and the fixed post-logout callback. |
| `GET /logout-callback?state=…` | Browser | Validates logout state/cookie and active preview generation, then returns to that registered preview origin. |

The sample preview provides same-origin `POST /login`, browser `GET /auth/callback`, same-origin `POST /logout`, `GET /session` and a sample root page. It rotates the local session on successful handoff and validates it with the gateway on each authenticated request. It currently returns to `/`; preserving an arbitrary PR-linked deep path requires a locally stored, validated relative destination, not an unvalidated gateway `return_to` parameter.

Current default lifetimes are five minutes for each login/start transaction, 30 seconds for a handoff ticket, 15 minutes for a gateway session capped by the recorded access-token expiry, and 60 seconds for each logout transaction/start. If the provider omits `expires_in`, the code assumes a five-minute token lifetime; that assumption is not evidence of an opaque token's real validity. Agree an authoritative lifetime policy before production API use. All registrations, tokens, transactions and sessions are in memory; restart loses them, and multiple replicas do not share them.

## Security decisions and unresolved gaps

1. **Stable identity:** persist `(iss, sub)`, not email or display name. A new client/redirect sector may produce a different pairwise `sub`; CoreLayer must define how an existing K12/BTA principal maps to this client without linking accounts merely by matching email. The current proof passes `iss/sub` but does not implement that application mapping. [OIDC §5.7][identity], [§8.1][pairwise]
2. **State and handoff serve different bindings:** upstream `state` indexes unpredictable gateway state and is checked against a gateway-host browser cookie. The preview's independent transaction cookie and verifier bind handoff redemption to its initiating browser. A preview URL encoded in `state` alone is insufficient. Enforce single use, expiry, generation/lease and preview credential checks; keep codes, tickets and tokens out of logs and remove handoff parameters immediately after use. The handoff is a custom trust protocol needing security review, not a standardized OAuth token exchange. [RFC 9700 §§2.1, 4.7, 4.11][bcp]
3. **Routing is not registration or authorization:** the registry's unique `{sandbox}` label and dynamic ingress establish where a service is reachable. Authentication registration separately establishes which preview/generation may receive a handoff. X4 still needs trusted register/renew/remove hooks, retry/recovery behavior, credential delivery and expiry handling for local/remote sandbox lifecycles. The current gateway registration accepts controller-authorized HTTPS origins, not only the configured X4 preview suffix; the controller must validate route ownership, or the gateway must enforce the approved domain/ownership itself.
4. **Hostname isolation is necessary but same-site remains:** ports do not isolate cookies. `auth.x4app.dev` and `*.preview.x4app.dev` are separate origins but are same-site HTTPS contexts under `x4app.dev`. `SameSite=Lax` alone therefore does not stop a sibling preview from initiating authenticated mutation requests. Preserve exact-origin/CSRF checks for every state-changing application route and strict CORS; do not treat CORS as CSRF protection. The sample checks `Origin`/`Referer` on login/logout. Gateway HTTPS binding cookies use `__Host-`, `Secure`, `HttpOnly`, no `Domain`, `Path=/`; the subsequent polish pass applies the same protection to preview session/transaction cookies and rejects unprefixed/duplicate bindings. This is tested source, not a claim that the installed setup service runs the updated adapter. Separate preview hostnames still share a registrable-domain resource/trust boundary; a separate registrable auth/control domain is stronger isolation for mutually hostile arbitrary code. [Cookie draft §§4.1.2.7, 4.1.3.2, 5.2, 8.6–8.8][cookies]
5. **Logout scope must be named:** current logout removes the initiating preview session and asks CoreLayer to end upstream SSO. It does not revoke tokens, notify other previews, or implement front/back-channel logout. Other gateway sessions can remain locally active until expiry even after upstream logout. Their cookies cannot be cleared across hostnames by the gateway. Define whether local-only logout, upstream SSO logout and all-preview invalidation are separate actions; do not promise both preserved independent sessions and global sign-out without a policy. [RP-Initiated Logout][logout], [RFC 7009][revocation]
6. **Central sessions are an availability/security boundary:** validation fails closed on gateway outage. Production readiness requires an agreed capacity, persistence/replication or intentional restart invalidation policy, protected server-side token storage, secret rotation, rate controls, operational telemetry and recovery tests. `GET /readyz` currently proves discovery/required login endpoint metadata only; it does not prove a successful grant, working logout, user policy, portal exchange or BTA permissions.

## Portal token exchange and BTA: decisions required before compatibility claims

No portal exchange or BTA endpoint, request, credential or response schema is implemented in this example. The handoff delivers identity and an opaque gateway session, **not** CoreLayer tokens. Before implementation, CoreLayer/K12 owners must provide:

- The supported portal exchange contract, if required: endpoint/method, authenticated caller, credential/token type, token issuer/audience/scope, subject and tenant mapping, response schema, error handling, TTL, rotation and revocation semantics.
- BTA's accepted token types, issuers, audiences, scopes/permissions, tenant enforcement and whether authorization is client-specific. Explain the user-token versus service-token distinction; user login must not become a broad shared service identity.
- The permitted topology: gateway-held tokens with protected backend API calls, or a separately designed restricted backend credential exchange. No proxy or token-distribution endpoint exists yet. A SPA expecting existing browser-owned tokens needs explicit application changes.
- The required verified claims and policy for denied users, missing tenant/role, disabled accounts and expired/revoked credentials. Email/name in the demo are display attributes, not authorization evidence.

Do not describe the handoff as RFC 8693 token exchange without an actual RFC 8693 implementation. The CoreLayer portal may use a different protocol; its contract remains an input from its owners.

## Acceptance evidence required from the real integration

Before enabling real users, record these against the actual client and K12 revision:

1. Discovery issuer, supported client authentication/signing/PKCE/logout features and the exact two callback registrations; reject altered scheme, host, port and path.
2. Two concurrent previews of the same project, two users, interleaved tabs and one shared callback. Each callback/handoff lands in the initiating browser/preview; a PR link preserves its approved local destination.
3. Wrong/replayed state, nonce, verifier and ticket; forged/expired/signature-invalid/wrong-issuer/wrong-audience ID tokens; duplicate callback parameters; cross-preview redemption and stale generation; callback errors/cancellation.
4. Sibling-domain cookie injection and cross-origin mutation requests, including same-site sibling previews. Confirm host-prefixed cookies and actual browser behavior in addition to HTTP test jars.
5. Successful permitted BTA request for each real K12 preview and denied requests for missing/wrong audience, scope, tenant, user authorization or client. Record the real portal exchange where applicable without capturing secrets.
6. Provider token expiry, declared no-refresh behavior or agreed refresh/rotation, upstream revocation policy, local versus upstream/global logout, and another preview's expected session behavior.
7. Register/renew/remove, lease expiry, stop/replacement during login, gateway restart/outage, remote-worker failure, unauthorized registrations and cleanup retry. Route availability alone is not authentication readiness.

## Primary sources checked

The standards and pinned Ory documentation below were retrieved directly for this audit on 2026-10-26. The cookie source is an IETF working draft, not a claim that RFC 6265 already specifies `SameSite` or cookie prefixes. The earlier [architecture research](research-x4-corelayer-preview-auth-gateway.md) remains historical analysis; its worker-port constraints predate the custom-domain implementation.

[oidc-auth]: https://openid.net/specs/openid-connect-core-1_0.html#AuthRequest
[oidc-validation]: https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation
[client-auth]: https://openid.net/specs/openid-connect-core-1_0.html#ClientAuthentication
[claims]: https://openid.net/specs/openid-connect-core-1_0.html#ScopeClaims
[identity]: https://openid.net/specs/openid-connect-core-1_0.html#ClaimStability
[pairwise]: https://openid.net/specs/openid-connect-core-1_0.html#PairwiseAlg
[discovery]: https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderConfig
[bcp]: https://www.rfc-editor.org/rfc/rfc9700.html
[pkce]: https://www.rfc-editor.org/rfc/rfc7636.html#section-4
[refresh]: https://www.rfc-editor.org/rfc/rfc6749.html#section-6
[logout]: https://openid.net/specs/openid-connect-rpinitiated-1_0.html
[revocation]: https://www.rfc-editor.org/rfc/rfc7009.html
[cookies]: https://www.ietf.org/archive/id/draft-ietf-httpbis-rfc6265bis-22.html
[ory-clients]: https://github.com/ory/docs/blob/4a8e1bb690e9538235095595eabd3fa72a82d571/docs/hydra/guides/oauth2-clients.mdx#redirect-uri-requirements
[ory-refresh]: https://github.com/ory/docs/blob/4a8e1bb690e9538235095595eabd3fa72a82d571/docs/oauth2-oidc/refresh-token-grant.mdx#requirements-for-obtaining-a-refresh-token
[ory-cors]: https://github.com/ory/docs/blob/4a8e1bb690e9538235095595eabd3fa72a82d571/docs/hydra/guides/cors.mdx
