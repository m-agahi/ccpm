"""GitHub Actions I/O helpers."""

import os
import sys


def set_output(key, value):
    """Write a step output to $GITHUB_OUTPUT."""
    output_file = os.environ.get("GITHUB_OUTPUT")
    if not output_file:
        print(
            f"WARNING: GITHUB_OUTPUT not set, would output {key}={value}",
            file=sys.stderr,
        )
        return
    safe_value = (
        str(value).replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    )
    with open(output_file, "a") as f:
        f.write(f"{key}={safe_value}\n")


def error(msg):
    """Emit a GitHub Actions error annotation."""
    print(f"::error::{msg}")


def require_env(name):
    """Get a required environment variable or exit with a descriptive message."""
    val = os.environ.get(name)
    if val is None:
        error(f"Required environment variable {name} is not set")
        sys.exit(1)
    if val == "":
        error(f"Required environment variable {name} is set but empty")
        sys.exit(1)
    return val
