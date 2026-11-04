# Publish X4 docs on Control

The docs are X4 Control's **Docs** service at `https://control.x4app.dev/docs/`,
listed in Control's service picker next to Fleet, Gateway and Projects. That
build carries Control's shared header. Control redirects old `/x4/` links to
the same page under `/docs/`. The public site is `https://docs.x4app.dev/`; the
existing GitHub Actions workflow publishes that site separately. Publishing to Control does
not restart Fleet, Gateway, ingress, or any preview.

The helper copies a validated static build into an immutable release beneath
`/srv/x4/documentation/releases/`, switches `documentation/current` atomically,
and mounts it through `/srv/x4/fleet/dist/docs`. The existing Control static-file
handler reads that link before its SPA fallback. Complete directories and
public files are installed with modes 0755 and 0644; deployment records are
root-only. Real credentials must never appear in a static docs build.

Build from a reviewed source revision:

```sh
npm --prefix documentation ci
npm --prefix documentation run clear
X4_DOCS_TARGET=control \
  npm --prefix documentation run build -- --out-dir build-control
python3 -m unittest discover -s deploy/documentation -p 'test_*.py'
```

The Control build also imports X4 Code's user docs from the private
`X4Org/x4-code` repository (`docs/user`) as its **X4 Code** section; see
`scripts/prepare-x4-code-docs.mjs`. Build on a machine whose Git can read that
repository (`gh auth setup-git`), or set `X4_CODE_DOCS_TOKEN` to a token with
**Contents: read** on it, or `X4_CODE_DOCS_DIR` to an X4 Code checkout.
`X4_CODE_DOCS_REF` picks another branch or tag than `main`. The build log names
the imported commit; record it with the release. The publisher refuses a build
without those pages, so a preview built with `X4_CODE_DOCS=skip` cannot be
published.

Use a release identifier containing the timestamp and source commit. Copy the
complete output and helper into a private staging directory on Control, then
run the helper there as root:

```sh
ssh root@control01.x4app.dev 'install -d -m 700 /root/x4-docs-stage'
scp -r documentation/build-control root@control01.x4app.dev:/root/x4-docs-stage/
scp deploy/documentation/publish-control-docs.py root@control01.x4app.dev:/root/x4-docs-stage/
ssh root@control01.x4app.dev \
  'python3 /root/x4-docs-stage/publish-control-docs.py --build /root/x4-docs-stage/build-control --release TIMESTAMP-COMMIT'
```

The publisher refuses a build without base URL `/docs/` or without Control's
header, so a public-site build cannot be published here by mistake.

Moving from `/x4/`: the first `/docs/` publication creates `dist/docs`.
Control's server redirects `/x4/` before it reads static files, so the old
`dist/x4` link is no longer served; remove it after checking the new address.

Use the machine's configured trusted SSH host key; do not disable host-key
verification. When the machine is already trusted under its original name,
`-o HostKeyAlias=x4-control-1` permits the DNS alias to use that existing pin.

Record the JSON result, including `rollback_record`. Before and after
publication, compare the Control process ID/start time, Gateway container
ID/start time, and existing ingress/static route responses. Check the actual
documentation content, not only HTTP 200: Control's SPA fallback can return
200 for an absent doc. Verify at least:

- `/docs/reference/corelayer-preview-authentication/` contains the updated spec.
- `/docs/operations/k12-prevent-setup/` contains the K12 setup guide.
- `/docs/operations/documentation-publication/` contains the publication runbook.
- Those pages show Control's header with **Docs** selected.
- `/docs/x4-code/` names the imported X4 Code commit, and
  `/docs/x4-code/x4-installation/` contains X4 Code's install guide.
- `/x4/operations/k12-prevent-setup/` redirects to the `/docs/` page.
- The stylesheet and script URLs from those pages return the expected files.
- The HTML, Markdown, JSON and dotenv-template downloads open correctly.
- An ordinary Fleet route and the existing Gateway and preview endpoints retain
  their previous behavior.

Rollback uses the exact record returned by publication:

```sh
ssh root@control01.x4app.dev \
  'python3 /root/x4-docs-stage/publish-control-docs.py --rollback /srv/x4/documentation/deployments/PUBLICATION.json'
```

Rollback refuses to undo a newer publication, changed links, or modified
release content. It retains immutable releases for inspection. On the first
publication, rollback removes the new docs links and restores the prior state.
The helper serializes writes using `/srv/x4/documentation/deploy.lock` and
refuses to replace an ordinary directory/file or an unexpected symlink at the
docs mount.

Every future Fleet `dist` replacement must preserve `dist/docs` or reattach the
active release with this helper. No original build directory is needed:

```sh
ssh root@control01.x4app.dev \
  'python3 /root/x4-docs-stage/publish-control-docs.py --attach-existing --release TIMESTAMP-COMMIT'
```

The identifier must match the currently active release, and its complete content
is verified against the publisher's manifest before recreating the missing mount.
Reapplying an unchanged build/release is also supported. Reusing a release
identifier with different content is refused. Do not edit the files in an
installed release, and do not copy docs over Control's `dist/index.html` or
`dist/assets`.

`--root` and `--mount` override the publication paths for isolated filesystem
tests or another explicitly configured Control installation. The production
CLI requires root; it never changes service definitions, app configuration,
Tailscale Serve state, ingress configuration, or authentication settings.
