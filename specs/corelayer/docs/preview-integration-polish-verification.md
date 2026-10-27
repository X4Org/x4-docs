# Preview integration polish and verification

**Date:** 2026-10-26. **Scope:** registry hostname templates, service-domain routing, publication lifecycle, standalone authentication broker, receiving example adapter, and CoreLayer handoff documentation.

The [illustrated CoreLayer specification](specs/corelayer-preview-auth-integration-v1.html), its [Markdown source](specs/corelayer-preview-auth-integration-v1.md), and the [client registration example](specs/corelayer-preview-client.example.json) are the documents to share with CoreLayer. The specification is an integration proposal for joint review, not a claim that real CoreLayer/K12/BTA acceptance has passed.

## Corrections made

| Area | Correction |
| --- | --- |
| Registry/runtime validation | Reject malformed/null preview mappings, null hostname templates and duplicate preview service IDs; preserve unique workspace suffixes and approved-domain rules. |
| Startup ordering | Validate browser URL references before preparing or overwriting runtime environment files and Compose state. |
| Route metadata | Validate controller generations, hostnames and transport origins, and bind publication inspection/cleanup to the current workspace so copied or corrupt metadata cannot retire another workspace's routes. |
| Worker lock | Publish a complete owner directory atomically. Recover empty/crashed locks without allowing two publishers into the critical section. A deterministic paused-process regression covers the race. |
| Ingress headers | Remove incoming spoofed `X-Real-IP` along with other untrusted forwarding/identity headers. |
| Browser cookies | Protect HTTPS preview session and transaction cookies with `__Host-`, `Secure`, `HttpOnly`, `Path=/` and no parent `Domain`; reject duplicate/unprefixed binding cookies. |
| Auth deadlines | Recheck transaction expiry and preview generation after asynchronous discovery/code exchange before redirecting or issuing a handoff. |
| Auth failures and shutdown | Return generic 503 for unavailable discovery; clear sensitive in-memory records when the gateway closes; normalize IPv6 loopback listener settings. |
| Documentation | Distinguish domain routes from auth registration; document local versus upstream SSO logout and remaining lifecycle/API work; mark earlier port-pool research as historical; replace a broken ingress runbook link. |

## Verification results

| Check | Result | Evidence |
| --- | --- | --- |
| TypeScript build | Passed | `/tmp/x4-preview-polish-build.log` |
| Preview/domain/schema/session tests | 84 passed | `/tmp/x4-preview-polish-node-tests.tap` |
| Existing registry tests | 6 passed | `/tmp/x4-preview-polish-registry-tests.tap` |
| Auth HTTP integration tests with mock issuer | 35 passed | `/tmp/x4-preview-polish-auth-tests.tap` |
| Go race tests and vet | Passed for ingress and compatibility packages | `/tmp/x4-preview-polish-go-tests.log` |
| Real ingress implementation with TLS/PROXY and mocked LocalAPI | 25 top-level tests plus 34 nested subtests passed | `/tmp/x4-preview-polish-ingress-tests.log` |
| Live two-preview routing/CORS/lifecycle | 17 checks passed across ten HTTPS service URLs; both sample stacks stopped | `/tmp/x4-preview-polish-live-verification.json` |
| Installed setup service and preserved static routes | 10 read-only HTTPS checks passed; auth health 200/configured false, auth paths/readiness 503 | `/tmp/x4-preview-polish-deployment-verification.json` |
| Cleanup | Central publication list empty after the live fixture | `/tmp/x4-preview-integration-polish-verification.json` |
| Documentation/client profile | Relative links resolved, JSON parsed and exact callbacks checked, `git diff --check` clean | Local verification during this pass |

The live domain test used the newly built source CLI with the existing deployed ingress. Its sample HTTP services are not real Handbook/K12 and do not perform CoreLayer sign-in. The ingress header fix was exercised by local Go tests; this pass did not deploy a new ingress binary. The auth tests use real local HTTP requests and signed mock OIDC responses, not the real CoreLayer service.

## Installed versus reviewed source

No CLI release, auth service or ingress binary was deployed or restarted during this polish pass. The installed worker release remains `/home/dev/x4-releases/registry-hostnames-20261026T214055Z`; `auth.x4app.dev` remains in setup mode. Source fixes are available in this checkout for review and release preparation. The older auth/browser verification records remain historical evidence.

When releasing the new worker lock implementation, avoid overlapping publication operations from old and new CLI versions. Preserve existing routes and workspaces, stage the release, retain the previous binary/configuration for rollback, and repeat the live fixture and static-route checks after deployment.

Real CoreLayer client credentials, real K12 session integration, automatic auth registration/renewal/removal, the portal/BTA adapter, and agreed expiry/logout semantics remain the acceptance work described in the specification. Existing routing and mock-auth checks do not establish those capabilities.

## Reproduce the source checks

From the repository root, install the repository's normal dependencies first. Build once before the dist-based tests; do not rebuild concurrently with them.

```bash
pnpm build
X4_PREVIEW_DOMAINS_CONFIG=off node --test \
  test/preview-hostname-schema.test.mjs test/preview-domains.test.mjs \
  test/preview-domains-compose.test.mjs test/preview-publication-lock.test.mjs \
  test/session-sandbox.test.mjs test/session-sandbox-remote.test.mjs \
  test/sandbox-manifest.test.mjs
X4_PREVIEW_DOMAINS_CONFIG=off node --test --test-name-pattern='^registry ' \
  test/cli.integration.test.mjs test/cli.safety.test.mjs
npm --prefix examples/preview-auth-gateway test
node examples/preview-auth-gateway/test/ingress/runner.mjs
git diff --check
```

Run `go test -race ./...` and `go vet ./...` from `apps/domain-ingress` with a compatible Go toolchain. The opt-in live fixture additionally needs the configured private publisher, Docker and Tailscale Serve permission:

```bash
node examples/sandbox-service-domains/verify.mjs /tmp/x4-preview-polish-live-verification.json
node examples/preview-auth-gateway/verify-deployment.mjs \
  --output /tmp/x4-preview-polish-deployment-verification.json
```

The deployment verifier deliberately expects setup mode; update its expected state only as part of a separately verified real-provider activation.
