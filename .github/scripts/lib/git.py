"""Thin subprocess wrappers for git."""

import subprocess


def run(*args):
    """Run a git command and return stdout as stripped string."""
    try:
        result = subprocess.run(
            ["git"] + list(args), capture_output=True, text=True, check=True
        )
        return result.stdout.strip()
    except subprocess.CalledProcessError as e:
        stderr = e.stderr.strip() if e.stderr else "(no stderr)"
        raise RuntimeError(
            f"git {' '.join(args)} failed (exit {e.returncode}): {stderr}"
        ) from e


def diff_names(target):
    """Return list of files changed compared to target."""
    output = run("diff", "--name-only", target)
    return output.splitlines() if output else []


def show_file(ref, path):
    """Return file contents at a given git ref, or None if missing.

    Callers must validate ``ref`` first (see commit_sha): an unknown ref
    also yields None here.
    """
    try:
        return run("show", f"{ref}:{path}")
    except (subprocess.CalledProcessError, RuntimeError):
        return None


def commit_sha(ref):
    """Return the full sha of the commit ``ref`` names, or None if unknown."""
    if not ref or ref.startswith("-"):
        return None
    result = subprocess.run(
        ["git", "rev-parse", "--verify", "--quiet", "--end-of-options", f"{ref}^{{commit}}"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return None
    return result.stdout.strip() or None


def is_ancestor(ancestor, descendant="HEAD"):
    """True when ``ancestor`` is reachable from ``descendant``."""
    result = subprocess.run(
        ["git", "merge-base", "--is-ancestor", ancestor, descendant],
        capture_output=True,
        text=True,
    )
    if result.returncode in (0, 1):
        return result.returncode == 0
    stderr = result.stderr.strip() or "(no stderr)"
    raise RuntimeError(
        f"git merge-base --is-ancestor failed (exit {result.returncode}): {stderr}"
    )
