"""GitHub Actions I/O helpers."""

import os
import sys
import uuid


def set_output(key, value):
    """Write a step output to $GITHUB_OUTPUT."""
    output_file = os.environ.get("GITHUB_OUTPUT")
    if not output_file:
        print(
            f"WARNING: GITHUB_OUTPUT not set, would output {key}={value}",
            file=sys.stderr,
        )
        return
    value = str(value)
    if "\n" in value or "\r" in value:
        # Multiline values need the heredoc form; pick a delimiter that cannot
        # collide with the value.
        delim = f"ghadelimiter_{uuid.uuid4().hex}"
        while delim in value:
            delim = f"ghadelimiter_{uuid.uuid4().hex}"
        line = f"{key}<<{delim}\n{value}\n{delim}\n"
    else:
        line = f"{key}={value}\n"
    with open(output_file, "a") as f:
        f.write(line)


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
