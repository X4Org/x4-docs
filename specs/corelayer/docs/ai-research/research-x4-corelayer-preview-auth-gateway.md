# Research: X4/CoreLayer preview authentication gateway

**Historical design assessment:** this research predates the custom-domain rollout and standalone gateway implementation. Its worker-port constraints and near-term pool recommendation describe that earlier decision point. Use the [versioned CoreLayer integration specification](../specs/corelayer-preview-auth-integration-v1.md) for the current proposal, implemented-versus-planned scope, and acceptance requirements.

**Investigated:** 2026-10-26. Primary OAuth/OIDC standards, official Ory documentation, and Hydra source; local X4 source inspected in this checkout. Ory citations pin docs revision `4a8e1bb690e9538235095595eabd3fa72a82d571` and Hydra revision `4174065ffb052799890f7480f5360a877a67ffc1`. CoreLayer's deployed version/configuration and K12 Prevent's OIDC implementation were not inspected. Its requirement for real CoreLayer OIDC is supplied task context. No application/configuration changes or end-to-end authentication tests were performed.

**Conclusion — design assessment:** Yes, one fixed gateway OIDC callback and one fixed post-logout callback can serve many parallel previews while retaining Hydra's exact redirect matching. Preview selection becomes gateway transaction/session routing after the registered callback. This requires either a broker with an app session adapter or a carefully integrated callback relay; it is not evidence that the existing K12 integration will work unchanged.

## Established constraints

- **X4 URLs vary by worker and port.** The [session publisher](../../src/session-sandbox.ts#L537) reads the worker's Tailscale DNS name, chooses available HTTPS ports from a workspace-derived starting point, and records `https://<worker>:<port>/<path>` routes. It can reuse an owned route or honor `service.preview.port`; the latter fails if occupied. [Port selection and publication](../../src/session-sandbox.ts#L551), [explicit-port schema](../../src/sandbox-manifest.ts#L15).
- **Exact matching includes the port and query.** OIDC requires a registered, exactly matching redirect URI. OAuth's current security BCP requires exact string matching, with a native-app loopback-port exception that does not cover HTTPS worker DNS names. Ory explicitly rejects wildcard redirect patterns; Hydra's matcher compares strings and separately handles HTTP loopback addresses. A dynamic `?return_to=<preview>` cannot be added to the registered callback URI without changing its match. [OIDC §3.1.2.1][oidc-auth], [RFC 9700 §2.1][bcp], [Ory redirect requirements][ory-clients], [Hydra matcher][hydra-match].
- **Code exchange preserves the original redirect URI and client.** If authorization used gateway callback `G`, token exchange must also send `redirect_uri=G`, even if the gateway subsequently delivered the response to preview callback `A`. Hydra checks both client identity and redirect equality. Merely forwarding a code to `A` does not make `redirect_uri=A` valid. [RFC 6749 §4.1.3][oauth-code], [Hydra token handler][hydra-token].
- **Logout has a separate exact allowlist.** RP-Initiated Logout requires an exactly registered `post_logout_redirect_uri`; opaque logout `state` can correlate the eventual return. Hydra performs a string comparison against `post_logout_redirect_uris`. [Logout §§2–3][logout], [Hydra logout validation][hydra-logout].

## Two different gateway designs

The following are **design options**, not existing X4 capabilities:

| Design | Who owns CoreLayer OIDC? | Required app integration |
| --- | --- | --- |
| Auth broker/BFF with one confidential client | Gateway owns authorization, code exchange, token validation, refresh, and upstream logout. Its credential and refresh tokens stay on the server. | A trusted handoff adapter establishes each preview's local app session. API access must use a gateway/backend path or an explicitly designed token arrangement. |
| Callback relay | Each app owns its OIDC transaction, PKCE verifier, nonce, token exchange, and refresh. Gateway routes the callback response. | App/library must authorize and redeem with the fixed gateway redirect URI while resuming its transaction at its own preview origin. This may need library changes beyond configuration. |

### Broker/BFF: recommended shape if apps can accept a local session

**Proposed flow:** preview starts a browser-bound local login transaction → gateway authenticates with CoreLayer → fixed gateway callback completes OIDC → browser carries a short-lived handoff ticket to the originating preview → preview backend redeems it and establishes its own session.

Use independent, unpredictable transaction records for concurrent tabs/previews. Store the validated preview identity, current lease/generation, local transaction binding, expiry, `state`, nonce, and PKCE material server-side. Bind each upstream transaction to the gateway's browser session. Use PKCE `S256`, verify `state`, and validate ID-token issuer, signature, audience, expiry, and nonce. The BCP mandates PKCE for public clients and recommends it for confidential clients; choosing state, nonce, and PKCE together here is a design recommendation. [RFC 9700 §§2.1–2.1.1][bcp], [RFC 7636 §4][pkce], [OIDC §3.1.3.7][oidc-validation].

The handoff ticket should be opaque, single-use, short-lived, bound to the intended preview/lease and initiating browser transaction, and redeemable only by its authenticated backend. Atomically consume it, rotate the local session, remove it from the browser URL, and avoid logging it. Do not put CoreLayer access/refresh tokens in redirect URLs. This is a **new trust protocol requiring review**, not a standardized OIDC feature. Its browser binding prevents an attacker's valid login ticket from signing a victim into the attacker's account; related CSRF, code-leakage, and session-fixation concerns are established in [RFC 9700][bcp] and [RFC 6265 §8.4][cookie-fixation].

K12 must explicitly trust this adapter and map CoreLayer identity/authorization into its own session. A gateway ID token is audience-bound to the gateway client, so it cannot simply substitute for an ID token expected by K12's existing client. Putting an authenticating proxy in front of a SPA also does not supply the tokens its existing API code expects. [OIDC audience validation][oidc-validation]. Building a downstream OIDC provider to preserve unchanged app OIDC would be additional broker infrastructure, outside a simple handoff.

### Relay: possible, but not a transparent redirect trick

The fixed callback must be registered on the client actually used by the app, or the app must adopt a dedicated preview client of the appropriate public/confidential type. The gateway must route through a trusted transaction mapping while preserving the app's `state`, nonce/PKCE association, authorization errors, and other response parameters. The original preview must recover its own browser-bound transaction and redeem the code **once**, as the original client, with `redirect_uri=G` and the original verifier. A code issued to the gateway client cannot be redeemed as another app client. [RFC 6749 §§4.1.2–4.1.3][oauth-code], [Hydra checks][hydra-token], [RFC 9700][bcp].

Libraries may derive the token request's redirect URI from the local callback URL or assume that the callback and initiation share an origin. Check these behaviors explicitly. Browser-owned SPA OIDC can require a significant new callback/storage flow, public-client configuration, and CORS work. A SPA cannot hold a confidential client secret. [Ory client types][ory-clients]. A modest backend adapter/configuration change is plausible for a server-session app; it is not a validated estimate for K12.

## Cookies, return targets, logout, and refresh

- **Cookies require two distinct considerations.** A gateway cannot set a host-only session cookie for another worker hostname; a `Domain` cookie can cover only an allowed parent domain, not an arbitrary different host. Each preview should issue its own session cookie after handoff. Conversely, cookies **are not isolated by port**: previews on the same worker can receive or overwrite cookies with the same name/domain/path. Distinct cookie names and session namespaces reduce accidental collisions but do not isolate mutually distrusting previews. Keep gateway cookies off preview-worker hosts; stronger preview isolation needs separate hostnames or another architecture. [RFC 6265 §4.1.2.3][cookie-domain], [§8.5][cookie-ports].
- **Validate return destinations independently of OIDC.** Recommended: select an active X4-managed preview ID from a trusted registry, bind its exact HTTPS host/port/path and lease generation to the transaction, and recheck ownership before handoff/redemption. Reject arbitrary `return_to` URLs, scheme-relative URLs, suffix tricks, and stale/reassigned ports; apply this to login and logout. A signed user-supplied URL still needs destination validation. OAuth prohibits open redirectors. [RFC 9700 §§2.1, 4.11][bcp], [X4 route ownership](../../src/session-sandbox.ts#L505).
- **One logout callback solves routing, not session propagation.** For broker logout, send the gateway's CoreLayer ID token as `id_token_hint`, the fixed post-logout URI, and fresh correlated logout state. The inspected Hydra source rejects `state`/`post_logout_redirect_uri` without a hint, although the standard permits other ways of identifying the client. Define whether logout ends one preview session or all gateway-linked sessions; invalidate server-side sessions and specify token revocation separately. The gateway cannot clear other hosts' cookies by redirect alone. Front/back-channel logout can notify the gateway, which must propagate invalidation to its downstream sessions. [Logout standard][logout], [Hydra behavior][hydra-logout], [Ory logout][ory-logout], [RFC 7009 §2][revocation].
- **Refresh stays with the OAuth client.** Broker: retain refresh credentials centrally and coordinate rotation; relay: each app keeps its own refresh flow. Refresh tokens are client-bound. Ory documents `authorization_code`/`refresh_token` grants plus requested and granted `offline_access` for refresh issuance. Confirm CoreLayer's actual consent, rotation, TTL, and revocation behavior rather than copying refresh tokens into previews. [RFC 6749 §6][refresh], [Ory refresh requirements][ory-refresh].
- **CORS is independent of redirect registration.** Server-to-server broker token exchange needs no browser CORS permission. If a SPA exchanges or refreshes tokens directly, its actual preview origin, including port, needs applicable CORS permission. Ory documents client `allowed_cors_origins`, enabled public CORS, and global origin configuration for preflight requests. Authorization uses browser navigation, not CORS AJAX. Apply corresponding rules to browser API/BFF calls too. [Ory CORS][ory-cors], [origin definition, RFC 6454 §4][origin].

## Configuration and near-term choice

**CoreLayer-side design recommendation:** provision a dedicated testing/preview OAuth client instead of altering production-client behavior. Standard Hydra client configuration supports `redirect_uris=[G]`, `post_logout_redirect_uris=[L]`, `response_types=[code]`, `grant_types=[authorization_code]` plus `refresh_token` if needed, an appropriate `token_endpoint_auth_method`, and allowed `scope`/`audience`. Use only K12-required scopes/audiences; add `offline_access` when needed. This is ordinary client provisioning/configuration, with no wildcard redirect or OAuth protocol change required. CoreLayer-specific login/consent and API policies must accept that client; browser flows may additionally need CORS configuration. This does **not** make app adaptation configuration-only. [Ory client management][ory-clients], [Hydra client fields][hydra-client], [Ory refresh][ory-refresh].

**Automated-registration alternative:** Ory also recommends adding exact preview redirect URIs through its client-management API on deployment and removing them on teardown. If CoreLayer offers an approved management integration, X4 could automate registration instead of introducing a broker. That depends on CoreLayer's access policy; no such integration was verified here. Keep administrative credentials in a trusted controller, outside previews, and coordinate updates so concurrent sessions do not overwrite each other's URI lists. [Ory preview guidance][ory-clients].

**Bounded near-term alternative:** pre-register exact login and post-logout callback URIs for a fixed pool of **10 HTTPS preview ports**, and let K12 keep its existing OIDC flow if it supports the selected external URL. Register each callback path and each allowed worker hostname; ten ports on several workers require the corresponding host/port combinations. Ory explicitly supports finite URI lists. [Ory preview guidance][ory-clients].

X4 already honors an [explicit preview port](../../src/session-sandbox.ts#L585), but this publisher has no ten-slot lease allocator: it detects occupied ports, while its [operation lock](../../src/session-sandbox.ts#L685) is checkout-scoped. The pool therefore needs atomic allocation across concurrent sessions, exhaustion/queue behavior, renewal/recovery, release, and protection against stale transactions on a reused slot. Cookie collisions and any SPA CORS requirements still apply. **Recommendation:** validate this bounded option first if ten simultaneous auth-enabled origins suffice; use the broker when broader scale and its reusable app adapter justify operating a central credential/session service. Neither option is implemented or validated here.

## Unresolved K12/CoreLayer assumptions

1. Does K12 use a backend session/BFF or browser-owned OIDC? Which library controls callback handling, verifier/state/nonce storage, and token-request `redirect_uri`? Can its external HTTPS URL/proxy settings be supplied at runtime, or are preview URLs compiled into the SPA?
2. Can K12 accept a trusted handoff into its existing session and authorization model? Does its API require CoreLayer access tokens, particular audiences/scopes/roles, or client-specific claims? Will a new client/subject configuration preserve user identity mapping?
3. Can CoreLayer provision the dedicated client through configuration alone, including login/consent policy, required claims/audiences, refresh, logout hints/notifications, and any browser CORS origins? Which Hydra version is deployed?
4. What logout scope, session lifetime, worker trust boundary, and concurrent-preview limit are required? Before claiming support, test parallel tabs/previews, wrong/replayed state and tickets, port reassignment, refresh/expiry, and local versus global logout against real K12/CoreLayer.

[oidc-auth]: https://openid.net/specs/openid-connect-core-1_0.html#AuthRequest
[oidc-validation]: https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation
[bcp]: https://www.rfc-editor.org/rfc/rfc9700.html#section-2.1
[oauth-code]: https://www.rfc-editor.org/rfc/rfc6749.html#section-4.1.3
[pkce]: https://www.rfc-editor.org/rfc/rfc7636.html#section-4
[logout]: https://openid.net/specs/openid-connect-rpinitiated-1_0.html#RPLogout
[cookie-domain]: https://www.rfc-editor.org/rfc/rfc6265.html#section-4.1.2.3
[cookie-fixation]: https://www.rfc-editor.org/rfc/rfc6265.html#section-8.4
[cookie-ports]: https://www.rfc-editor.org/rfc/rfc6265.html#section-8.5
[refresh]: https://www.rfc-editor.org/rfc/rfc6749.html#section-6
[revocation]: https://www.rfc-editor.org/rfc/rfc7009.html#section-2
[origin]: https://www.rfc-editor.org/rfc/rfc6454.html#section-4
[ory-clients]: https://github.com/ory/docs/blob/4a8e1bb690e9538235095595eabd3fa72a82d571/docs/hydra/guides/oauth2-clients.mdx#redirect-uri-requirements
[ory-cors]: https://github.com/ory/docs/blob/4a8e1bb690e9538235095595eabd3fa72a82d571/docs/hydra/guides/cors.mdx#configure-cors-in-ory-hydra
[ory-refresh]: https://github.com/ory/docs/blob/4a8e1bb690e9538235095595eabd3fa72a82d571/docs/oauth2-oidc/refresh-token-grant.mdx#requirements-for-obtaining-a-refresh-token
[ory-logout]: https://github.com/ory/docs/blob/4a8e1bb690e9538235095595eabd3fa72a82d571/docs/oauth2-oidc/logout.mdx
[hydra-match]: https://github.com/ory/hydra/blob/4174065ffb052799890f7480f5360a877a67ffc1/fosite/authorize_helper.go#L66
[hydra-token]: https://github.com/ory/hydra/blob/4174065ffb052799890f7480f5360a877a67ffc1/fosite/handler/oauth2/flow_authorize_code_token.go#L68
[hydra-logout]: https://github.com/ory/hydra/blob/4174065ffb052799890f7480f5360a877a67ffc1/consent/strategy_default.go#L798
[hydra-client]: https://github.com/ory/hydra/blob/4174065ffb052799890f7480f5360a877a67ffc1/client/client.go#L61
