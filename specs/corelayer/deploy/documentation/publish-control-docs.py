#!/usr/bin/env python3
"""Publish a static /x4/ docs build on Control without restarting services."""

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile
import uuid


DEFAULT_ROOT = Path("/srv/x4/documentation")
DEFAULT_MOUNT = Path("/srv/x4/fleet/dist/x4")
MANIFEST = ".x4-docs-release.json"
REQUIRED = (
    "index.html",
    "reference/corelayer-preview-authentication/index.html",
    "specs/corelayer/docs/specs/corelayer-preview-auth-integration-v1.md",
    "specs/corelayer/docs/specs/corelayer-preview-auth-integration-v1.html",
    "specs/corelayer/docs/specs/corelayer-preview-client.example.json",
    "operations/k12-prevent-setup/index.html",
    "operations/documentation-publication/index.html",
)


class PublicationError(Exception):
    pass


def absolute(path):
    return Path(os.path.abspath(path))


def snapshot(path):
    if path.is_symlink():
        return os.readlink(path)
    if path.exists():
        raise PublicationError(f"Refusing to replace a non-symlink: {path}")
    return None


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def private_json(path, data):
    fd, temporary = tempfile.mkstemp(prefix=".docs-json-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(data, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        Path(temporary).unlink(missing_ok=True)


def read_private(path):
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise PublicationError(f"Expected a regular metadata file: {path}")
    value = json.loads(path.read_text()) if path.exists() else None
    if value is not None and not isinstance(value, dict):
        raise PublicationError(f"Expected a metadata object: {path}")
    return value


def atomic_link(path, target):
    if target is None:
        path.unlink(missing_ok=True)
        sync_directory(path.parent)
        return
    temporary = path.parent / (".docs-link-" + uuid.uuid4().hex)
    try:
        temporary.symlink_to(target)
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def restore_active(path, value):
    if value is None:
        path.unlink(missing_ok=True)
    else:
        private_json(path, value)


def inspect_build(build, managed=False):
    if not build.is_dir() or build.is_symlink():
        raise PublicationError("Build must be a real static-output directory.")
    files = {}
    for path in build.rglob("*"):
        mode = path.lstat().st_mode
        if stat.S_ISLNK(mode) or not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
            raise PublicationError("Static builds may contain only regular files and directories.")
        if path.name == ".env" or path.name.startswith(".env."):
            raise PublicationError("Static builds must not contain private dotenv files.")
        if not path.is_file():
            continue
        relative = path.relative_to(build).as_posix()
        if relative == MANIFEST:
            if not managed:
                raise PublicationError("Build contains a reserved publisher manifest.")
            continue
        files[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    if any(name not in files for name in REQUIRED) or not any(name.startswith("assets/") for name in files):
        raise PublicationError("Build is missing the documentation page, assets or spec downloads.")
    index = (build / "index.html").read_text()
    if "docusaurus" not in index.lower() or "/x4/assets/" not in index:
        raise PublicationError("Expected a Docusaurus build with base URL /x4/.")
    if "CoreLayer" not in (build / REQUIRED[1]).read_text():
        raise PublicationError("Authentication reference page is not the expected specification.")
    json.loads((build / REQUIRED[4]).read_text())
    return files


def verify_release(path, root):
    if path.parent != root / "releases" or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,95}", path.name):
        raise PublicationError("Current documentation must point to a managed release.")
    manifest = read_private(path / MANIFEST)
    if not manifest or manifest.get("version") != 1 or manifest.get("release") != path.name:
        raise PublicationError("Release has no recognized publisher manifest.")
    if inspect_build(path, managed=True) != manifest.get("files"):
        raise PublicationError("A published release was modified; refusing to overwrite or roll it back.")
    return manifest


def layout(root, mount):
    root, mount = absolute(root), absolute(mount)
    if root.resolve() != root or mount.parent.resolve() != mount.parent:
        raise PublicationError("Publication directories must not traverse symlinks.")
    if mount.is_relative_to(root) or root.is_relative_to(mount):
        raise PublicationError("Control docs mount and publication root must be separate paths.")
    for directory, mode in [(root, 0o755), (root / "releases", 0o755), (root / "deployments", 0o700)]:
        if directory.is_symlink() or (directory.exists() and not directory.is_dir()):
            raise PublicationError(f"Expected a real publication directory: {directory}")
        directory.mkdir(parents=True, exist_ok=True, mode=mode)
        directory.chmod(mode)
    if not mount.parent.is_dir():
        raise PublicationError("Control dist directory must already exist.")
    return root, mount


@contextmanager
def locked(root):
    fd = os.open(root / "deploy.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        os.fchmod(fd, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise PublicationError("Another documentation publication is running.") from error
        yield
    finally:
        os.close(fd)


def current_state(root, mount):
    current = snapshot(root / "current")
    mounted = snapshot(mount)
    if current is not None:
        if current != str(absolute(current)):
            raise PublicationError("Current release link must use an absolute managed path.")
        verify_release(Path(current), root)
    if mounted not in (None, str(root / "current")):
        raise PublicationError("Control docs mount points somewhere unexpected.")
    active = read_private(root / "active.json")
    if active and (active.get("current") != current or active.get("mount") != str(mount)):
        raise PublicationError("Active publication metadata does not match the current release.")
    return {"current": current, "mounted": mounted, "active": active}


def restore(root, mount, before):
    # On initial-publication rollback, remove the public mount before its target.
    if before["mounted"] is None:
        atomic_link(mount, None)
    atomic_link(root / "current", before["current"])
    if before["mounted"] is not None:
        atomic_link(mount, before["mounted"])
    restore_active(root / "active.json", before["active"])


def publish(build, release, root=DEFAULT_ROOT, mount=DEFAULT_MOUNT, attach_existing=False):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,95}", release):
        raise PublicationError("Release must be a short filename-safe identifier.")
    if attach_existing:
        if build is not None:
            raise PublicationError("Attach-existing does not accept a build.")
        root, mount = layout(root, mount)
        files = verify_release(root / "releases" / release, root)["files"]
    else:
        build = absolute(build)
        files = inspect_build(build)
        root, mount = layout(root, mount)
    with locked(root):
        before = current_state(root, mount)
        destination = root / "releases" / release
        if attach_existing and before["current"] != str(destination):
            raise PublicationError("Attach-existing requires the currently active release identifier.")
        if destination.exists() or destination.is_symlink():
            if verify_release(destination, root)["files"] != files:
                raise PublicationError("Release identifier already exists with different content.")
        else:
            staged = Path(tempfile.mkdtemp(prefix=".staging-", dir=root / "releases"))
            try:
                shutil.copytree(build, staged, symlinks=True, dirs_exist_ok=True)
                if inspect_build(staged) != files:
                    raise PublicationError("Build changed while being copied.")
                for path in [staged, *staged.rglob("*")]:
                    path.chmod(0o755 if path.is_dir() else 0o644)
                private_json(staged / MANIFEST, {"version": 1, "release": release, "files": files})
                (staged / MANIFEST).chmod(0o644)
                os.rename(staged, destination)
                sync_directory(destination.parent)
            finally:
                if staged.exists():
                    shutil.rmtree(staged)
        if current_state(root, mount) != before:
            raise PublicationError("Documentation links changed while staging; refusing publication.")
        publication = uuid.uuid4().hex
        record_path = root / "deployments" / (publication + ".json")
        active = {"publication": publication, "current": str(destination), "mount": str(mount)}
        after = {"current": str(destination), "mounted": str(root / "current"), "active": active}
        record = {"version": 1, "status": "prepared", "root": str(root), "mount": str(mount),
                  "published_at": datetime.now(timezone.utc).isoformat(), "release": release,
                  "file_count": len(files), "before": before, "after": after}
        private_json(record_path, record)
        try:
            atomic_link(root / "current", after["current"])
            if before["mounted"] is None:
                atomic_link(mount, after["mounted"])
            private_json(root / "active.json", active)
            if current_state(root, mount) != after:
                raise PublicationError("Published links did not pass verification.")
            record["status"] = "published"
            private_json(record_path, record)
        except (OSError, PublicationError) as error:
            # Respect external edits even during failure recovery.
            observed = {"current": snapshot(root / "current"), "mounted": snapshot(mount),
                        "active": read_private(root / "active.json")}
            if any(observed[key] not in (before[key], after[key]) for key in before):
                raise PublicationError(f"Concurrent change prevents recovery; inspect {record_path}") from error
            restore(root, mount, before)
            record["status"] = "rolled_back"
            private_json(record_path, record)
            raise PublicationError(f"Publication failed and was rolled back; inspect {record_path}") from error
        return {"ok": True, "status": record["status"], "release": release,
                "current": str(destination), "mount": str(mount), "file_count": len(files),
                "rollback_record": str(record_path)}


def rollback(record_path, root=DEFAULT_ROOT, mount=DEFAULT_MOUNT):
    root, mount = layout(root, mount)
    record_path = absolute(record_path)
    if record_path.parent != root / "deployments":
        raise PublicationError("Rollback record must be in this publisher's deployments directory.")
    with locked(root):
        record = read_private(record_path)
        if not record or record.get("version") != 1 or record.get("root") != str(root) or record.get("mount") != str(mount):
            raise PublicationError("Rollback record belongs to another publication layout.")
        if record.get("status") != "published" or current_state(root, mount) != record["after"]:
            raise PublicationError("Publication changed since this record; refusing rollback.")
        before = record["before"]
        if before["mounted"] not in (None, str(root / "current")):
            raise PublicationError("Rollback contains an unexpected mount target.")
        if before["current"] is not None:
            verify_release(Path(before["current"]), root)
        restore(root, mount, before)
        record["status"] = "rolled_back"
        private_json(record_path, record)
        return {"ok": True, "status": "rolled_back", "rollback_record": str(record_path),
                "current": before["current"], "mount": str(mount)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--build", type=Path, help="Complete static docs output built for /x4/")
    action.add_argument("--attach-existing", action="store_true", help="Recreate the mount for the active, verified release")
    action.add_argument("--rollback", type=Path, help="Rollback record returned by a publication")
    parser.add_argument("--release", help="Immutable release identifier (required with --build or --attach-existing)")
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--mount", type=Path, default=DEFAULT_MOUNT)
    args = parser.parse_args()
    if bool(args.build or args.attach_existing) != bool(args.release):
        parser.error("--release is required with --build/--attach-existing and cannot accompany --rollback")
    try:
        if os.geteuid() != 0:
            raise PublicationError("Run this helper as root on control01.x4app.dev.")
        result = (rollback(args.rollback, args.root, args.mount) if args.rollback else
                  publish(args.build, args.release, args.root, args.mount, args.attach_existing))
    except (OSError, ValueError, PublicationError) as error:
        result = {"ok": False, "error": str(error) if isinstance(error, PublicationError) else "Unable to validate or access documentation publication files."}
    print(json.dumps(result, sort_keys=True))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
