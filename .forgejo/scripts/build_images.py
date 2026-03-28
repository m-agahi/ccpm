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
from lib import workflow_io


def run(cmd, **kwargs):
    """Run a command, printing it and streaming output."""
    print(f"$ {' '.join(cmd)}")
    result = subprocess.run(cmd, **kwargs)
    if result.returncode != 0:
        print(f"ERROR: command exited with {result.returncode}", file=sys.stderr)
    return result


def main():
    releases_path = pathlib.Path(".ci-outputs/releases.json")
    if not releases_path.exists():
        print("No releases.json found, nothing to build.")
        return

    releases = json.loads(releases_path.read_text())
    if not releases:
        print("Empty release list, nothing to build.")
        return

    repo = os.environ.get("FORGEJO_REPOSITORY") or os.environ.get("GITHUB_REPOSITORY", "")
    token = workflow_io.require_env("FORGEJO_TOKEN")

    if not repo:
        print("ERROR: FORGEJO_REPOSITORY not set", file=sys.stderr)
        sys.exit(1)

    registry = "codeberg.org"
    built = []

    # Login to container registry
    login = run(
        ["docker", "login", registry, "-u", "token", "--password-stdin"],
        input=token,
        text=True,
        capture_output=True,
    )
    if login.returncode != 0:
        print(f"ERROR: Docker login failed: {login.stderr}", file=sys.stderr)
        sys.exit(1)
    print("Logged in to container registry.")

    for rel in releases:
        name = rel["name"]
        version = rel["version"]
        dockerfile_dir = pathlib.Path(f"plugins/{name}/docker")

        if not (dockerfile_dir / "Dockerfile").exists():
            print(f"Skipping {name} — no Dockerfile found.")
            continue

        image_base = f"{registry}/{repo}/{name}"
        image_versioned = f"{image_base}:{version}"
        image_latest = f"{image_base}:latest"

        print(f"\nBuilding {image_versioned}...")
        build = run(
            [
                "docker", "build",
                "-t", image_versioned,
                "-t", image_latest,
                str(dockerfile_dir),
            ],
        )
        if build.returncode != 0:
            print(f"ERROR: Failed to build {name}", file=sys.stderr)
            continue

        print(f"Pushing {image_versioned}...")
        push_v = run(["docker", "push", image_versioned])
        push_l = run(["docker", "push", image_latest])

        if push_v.returncode == 0 and push_l.returncode == 0:
            print(f"Pushed {image_versioned} and {image_latest}")
            built.append(name)
        else:
            print(f"WARNING: Push failed for {name}", file=sys.stderr)

    if built:
        print(f"\nBuilt and pushed images for: {', '.join(built)}")
    else:
        print("\nNo images to build.")


if __name__ == "__main__":
    main()
