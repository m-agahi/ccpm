#!/usr/bin/env python3
"""Build and attach binary assets for released plugins that contain a Rust indexer.

For each plugin in .ci-outputs/releases.json, checks if an indexer/Cargo.toml
exists under plugins/<name>/. If so, compiles release binaries for both
linux/amd64 and linux/arm64, and uploads both assets to the matching GitHub
release.

Asset naming: <plugin-name>-indexer-linux-amd64 / <plugin-name>-indexer-linux-arm64
"""

import json
import os
import pathlib
import subprocess
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(__file__))
from lib import github_api


def run(cmd, **kwargs):
    """Run a command, printing it and streaming output."""
    print(f"$ {' '.join(str(c) for c in cmd)}")
    result = subprocess.run(cmd, **kwargs)
    if result.returncode != 0:
        print(f"ERROR: command exited with {result.returncode}", file=sys.stderr)
    return result


def find_release(tag):
    """Return the GitHub release object for a given tag, or None if not found."""
    encoded_tag = urllib.parse.quote(tag, safe="")
    try:
        return github_api.get(github_api.repo_path(f"/releases/tags/{encoded_tag}"))
    except github_api.APIError as e:
        print(f"  WARNING: could not find release for tag {tag!r}: {e}", file=sys.stderr)
        return None


TARGETS = [
    ("x86_64-unknown-linux-gnu", "amd64"),
    ("aarch64-unknown-linux-gnu", "arm64"),
]


def get_bin_name(cargo_toml):
    """Return the binary name from Cargo.toml package name."""
    content = pathlib.Path(cargo_toml).read_text()
    for line in content.splitlines():
        if line.strip().startswith("name") and "=" in line:
            return line.split("=", 1)[1].strip().strip('"')
    return "repo-indexer"


def build_binary(cargo_toml, triple):
    """Compile a release binary for the given rust target triple.

    Returns path to the binary or None on failure.
    """
    indexer_dir = pathlib.Path(cargo_toml).resolve().parent
    result = run(
        ["cargo", "build", "--release", "--locked", "--target", triple],
        cwd=indexer_dir,
    )
    if result.returncode != 0:
        return None
    bin_name = get_bin_name(cargo_toml)
    binary = indexer_dir / "target" / triple / "release" / bin_name
    if not binary.exists():
        print(f"  ERROR: expected binary not found at {binary}", file=sys.stderr)
        return None
    return binary


def upload_binary(release, binary, asset_name):
    """Upload ``binary`` as ``asset_name``. Returns True on success or skip.

    On a 422 ``already_exists`` the asset list is re-read: an asset left in a
    non-``uploaded`` state by an interrupted run is deleted and uploaded once
    more; a fully uploaded asset is kept as-is.
    """
    try:
        github_api.upload_asset(release, binary, asset_name)
        print(f"  Uploaded {asset_name}")
        return True
    except github_api.APIError as e:
        if not github_api.is_already_exists(e):
            print(f"  ERROR uploading asset: {e}", file=sys.stderr)
            return False

    try:
        assets = github_api.get(
            github_api.repo_path(f"/releases/{release['id']}/assets?per_page=100")
        ) or []
    except github_api.APIError as e:
        print(f"  ERROR listing assets: {e}", file=sys.stderr)
        return False
    existing = next((a for a in assets if a.get("name") == asset_name), None)
    if existing is None:
        print(
            f"  ERROR: upload of {asset_name} reported already_exists, "
            "but the asset is not listed on the release",
            file=sys.stderr,
        )
        return False
    if existing.get("state") == "uploaded":
        print(f"  Asset {asset_name} already exists on release, skipping")
        return True

    print(
        f"  Asset {asset_name} exists in state {existing.get('state')!r}; "
        "deleting and uploading again"
    )
    try:
        github_api.delete(github_api.repo_path(f"/releases/assets/{existing['id']}"))
        github_api.upload_asset(release, binary, asset_name)
    except github_api.APIError as e:
        print(f"  ERROR replacing asset: {e}", file=sys.stderr)
        return False
    print(f"  Uploaded {asset_name}")
    return True


def main():
    releases_path = pathlib.Path(".ci-outputs/releases.json")
    if not releases_path.exists():
        print("No releases.json found, nothing to build.")
        return

    releases = json.loads(releases_path.read_text())
    if not releases:
        print("Empty release list, nothing to do.")
        return

    built = []
    failed = []
    skipped = []

    for rel in releases:
        name = rel["name"]
        version = rel["version"]
        cargo_toml = pathlib.Path(f"plugins/{name}/indexer/Cargo.toml")

        if not cargo_toml.exists():
            skipped.append(name)
            continue

        tag = f"{name}/v{version}"
        release = find_release(tag)
        if not release:
            print(f"  ERROR: release not found for tag {tag!r}", file=sys.stderr)
            failed.append(name)
            continue

        plugin_had_failure = False

        for triple, arch in TARGETS:
            print(f"\nBuilding {name} v{version} for {triple}...")
            binary = build_binary(cargo_toml, triple)
            if binary is None:
                failed.append(f"{name}:{arch}")
                plugin_had_failure = True
                continue

            asset_name = f"{name}-indexer-linux-{arch}"
            print(f"  Uploading {asset_name} to release {tag} (id={release.get('id')})...")
            if not upload_binary(release, binary, asset_name):
                failed.append(f"{name}:{arch}")
                plugin_had_failure = True

        if not plugin_had_failure:
            built.append(name)

    if skipped:
        print(f"\nSkipped (no indexer): {', '.join(skipped)}")
    if built:
        print(f"\nBuilt and uploaded binaries for: {', '.join(built)}")
    if failed:
        print(f"\nFailed targets: {', '.join(failed)}", file=sys.stderr)
        sys.exit(1)
    if not built and not failed:
        print("\nNo binaries to build.")


if __name__ == "__main__":
    main()
