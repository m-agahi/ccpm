#!/usr/bin/env python3
"""Build and push Docker images for released plugins that contain a Dockerfile.

For each plugin in .ci-outputs/releases.json, checks if a Dockerfile exists
under plugins/<name>/docker/. If so, builds the image and pushes it to the
Codeberg container registry with both a version tag and :latest.

Registry format: codeberg.org/{owner}/{repo}/{plugin-name}:{tag}
"""

import json
import os
import pathlib
import subprocess
import sys

sys.path.insert(0, os.path.dirname(__file__))
from lib import git


def run(cmd, **kwargs):
    """Run a command, printing it and streaming output."""
    print(f"$ {' '.join(cmd)}")
    result = subprocess.run(cmd, **kwargs)
    if result.returncode != 0:
        print(f"ERROR: command exited with {result.returncode}", file=sys.stderr)
    return result


def main():
    releases_path = pathlib.Path(".ci-outputs/releases.json")
    if releases_path.exists():
        releases = json.loads(releases_path.read_text())
        if not releases:
            print("Empty release list, nothing to build.")
            return
    else:
        # Manual trigger — discover all plugins with a Dockerfile
        print("No releases.json found, discovering all plugins with Dockerfiles...")
        marketplace_path = pathlib.Path(".claude-plugin/marketplace.json")
        if not marketplace_path.exists():
            print("ERROR: marketplace.json not found", file=sys.stderr)
            sys.exit(1)
        marketplace = json.loads(marketplace_path.read_text())
        releases = [
            {"name": p["name"], "version": p.get("version", "latest")}
            for p in marketplace.get("plugins", [])
            if (pathlib.Path(f"plugins/{p['name']}/docker/Dockerfile")).exists()
        ]
        if not releases:
            print("No plugins with Dockerfiles found.")
            return
        print(f"Found {len(releases)} plugin(s): {', '.join(r['name'] for r in releases)}")

    repo = os.environ.get("FORGEJO_REPOSITORY") or os.environ.get("GITHUB_REPOSITORY", "")
    registry_user = os.environ.get("REGISTRY_USER", "")
    registry_token = os.environ.get("REGISTRY_TOKEN", "")

    if not repo:
        print("ERROR: FORGEJO_REPOSITORY not set", file=sys.stderr)
        sys.exit(1)

    if not registry_user or not registry_token:
        print("ERROR: REGISTRY_USER and REGISTRY_TOKEN must be set", file=sys.stderr)
        sys.exit(1)

    registry = "codeberg.org"
    dockerhub_token = os.environ.get("DOCKERHUB_TOKEN", "")
    dockerhub_user = "openfantasy"
    nvd_api_key = os.environ.get("NVD_API_KEY", "")
    built = []
    failed = []

    # Login to Codeberg container registry
    login = run(
        ["docker", "login", registry, "-u", registry_user, "--password-stdin"],
        input=registry_token,
        text=True,
        capture_output=True,
    )
    if login.returncode != 0:
        print(f"ERROR: Docker login failed: {login.stderr}", file=sys.stderr)
        sys.exit(1)
    print("Logged in to Codeberg container registry.")

    # Login to DockerHub
    if dockerhub_token:
        dh_login = run(
            ["docker", "login", "-u", dockerhub_user, "--password-stdin"],
            input=dockerhub_token,
            text=True,
            capture_output=True,
        )
        if dh_login.returncode != 0:
            print(f"ERROR: DockerHub login failed: {dh_login.stderr}", file=sys.stderr)
            sys.exit(1)
        print("Logged in to DockerHub.")
    else:
        print("WARNING: DOCKERHUB_TOKEN not set, skipping DockerHub push.", file=sys.stderr)

    # Detect which files changed vs previous commit (for automatic triggers).
    # workflow_dispatch always builds (manual trigger = explicit intent).
    is_manual = os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
    try:
        changed_files = git.diff_names("HEAD~1")
    except Exception:
        changed_files = []

    for rel in releases:
        name = rel["name"]
        version = rel["version"]
        dockerfile_dir = pathlib.Path(f"plugins/{name}/docker")

        if not (dockerfile_dir / "Dockerfile").exists():
            print(f"Skipping {name} — no Dockerfile found.")
            continue

        # Skip build if no docker-related files changed (unless manual trigger)
        if not is_manual:
            docker_prefix = f"plugins/{name}/docker/"
            docker_changed = any(f.startswith(docker_prefix) for f in changed_files)
            if not docker_changed:
                print(f"Skipping {name} — no changes in {docker_prefix}")
                continue

        image_base = f"{registry}/{repo}/{name}"
        image_versioned = f"{image_base}:{version}"
        image_latest = f"{image_base}:latest"

        dh_image_versioned = f"{dockerhub_user}/{name}:{version}"
        dh_image_latest = f"{dockerhub_user}/{name}:latest"

        platforms = os.environ.get("PLATFORMS", "linux/amd64")
        print(f"\nBuilding {image_versioned} for {platforms}...")

        build_args = []
        if nvd_api_key:
            build_args += ["--build-arg", f"NVD_API_KEY={nvd_api_key}"]

        # Collect all tags (Codeberg + DockerHub)
        tag_args = ["-t", image_versioned, "-t", image_latest]
        if dockerhub_token:
            tag_args += ["-t", dh_image_versioned, "-t", dh_image_latest]

        if "," in platforms:
            # Multi-platform: requires buildx with --push.
            # Registry cache works reliably here because the multiarch builder
            # (docker-container driver) handles credential forwarding via BuildKit.
            cache_ref = (
                f"{dockerhub_user}/{name}:buildcache"
                if dockerhub_token
                else f"{image_base}:buildcache"
            )
            cache_args = [
                "--cache-from", f"type=registry,ref={cache_ref}",
                "--cache-to", f"type=registry,ref={cache_ref},mode=min,ignore-error=true",
            ]
            build_cmd = [
                "docker", "buildx", "build",
                "--platform", platforms,
                *tag_args,
                "--push",
                *cache_args,
                *build_args,
                str(dockerfile_dir),
            ]
            build = run(build_cmd)
            if build.returncode != 0:
                print(f"ERROR: Failed to build {name}", file=sys.stderr)
                failed.append(name)
                continue
        else:
            # Single-platform: plain docker build + explicit per-registry pushes.
            # This is more reliable with DOCKER_HOST=tcp:// setups where buildx
            # credential forwarding for multi-registry --push can be unreliable
            # (the docker-container builder may not receive DockerHub credentials).
            build_cmd = [
                "docker", "build",
                *tag_args,
                *build_args,
                str(dockerfile_dir),
            ]
            build = run(build_cmd)
            if build.returncode != 0:
                print(f"ERROR: Failed to build {name}", file=sys.stderr)
                failed.append(name)
                continue
            push_failed = False
            for tag in [image_versioned, image_latest]:
                if run(["docker", "push", tag]).returncode != 0:
                    print(f"ERROR: Push failed for {tag}", file=sys.stderr)
                    push_failed = True
                    break
            if not push_failed and dockerhub_token:
                for tag in [dh_image_versioned, dh_image_latest]:
                    if run(["docker", "push", tag]).returncode != 0:
                        print(f"ERROR: DockerHub push failed for {tag}", file=sys.stderr)
                        push_failed = True
                        break
            if push_failed:
                failed.append(name)
                continue

        pushed_to = image_versioned
        if dockerhub_token:
            pushed_to += f" and {dh_image_versioned}"
        print(f"Pushed {pushed_to} (+ :latest tags)")
        built.append(name)

    if built:
        print(f"\nBuilt and pushed images for: {', '.join(built)}")
    if failed:
        print(f"\nFailed: {', '.join(failed)}", file=sys.stderr)
        sys.exit(1)
    if not built and not failed:
        print("\nNo images to build.")


if __name__ == "__main__":
    main()
