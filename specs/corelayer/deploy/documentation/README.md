# Publish X4 docs on Control

Control serves a private copy of the docs at `https://control.x4app.dev/x4/`.
The canonical public site is `https://docs.x4app.dev/`; the existing GitHub
Actions workflow publishes that site separately. Publishing to Control does
not restart Fleet, Gateway, ingress, or any preview.

The helper copies a validated static build into an immutable release beneath
`/srv/x4/documentation/releases/`, switches `documentation/current` atomically,
and mounts it through `/srv/x4/fleet/dist/x4`. The existing Control static-file
handler reads that link before its SPA fallback. Complete directories and
public files are installed with modes 0755 and 0644; deployment records are
root-only. Real credentials must never appear in a static docs build.

Build from a reviewed source revision:

```sh
npm --prefix documentation ci
DOCUSAURUS_URL=https://control.x4app.dev \
DOCUSAURUS_BASE_URL=/x4/ \
  npm --prefix documentation run build -- --out-dir build-control
python3 -m unittest discover -s deploy/documentation -p 'test_*.py'
```

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

Use the machine's configured trusted SSH host key; do not disable host-key
verification. When the machine is already trusted under its original name,
`-o HostKeyAlias=x4-control-1` permits the DNS alias to use that existing pin.

Record the JSON result, including `rollback_record`. Before and after
publication, compare the Control process ID/start time, Gateway container
ID/start time, and existing ingress/static route responses. Check the actual
documentation content, not only HTTP 200: Control's SPA fallback can return
200 for an absent doc. Verify at least:

- `/x4/reference/corelayer-preview-authentication/` contains the updated spec.
- `/x4/operations/k12-prevent-setup/` contains the K12 setup guide.
- `/x4/operations/documentation-publication/` contains the publication runbook.
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

Every future Fleet `dist` replacement must preserve `dist/x4` or reattach the
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
