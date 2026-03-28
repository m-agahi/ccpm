"""Codeberg / Forgejo API client using only stdlib."""

import json
import os
import re
import urllib.error
import urllib.request

API_BASE = os.environ.get("FORGEJO_API_BASE", "https://codeberg.org/api/v1")
MAX_RESPONSE_BYTES = 10 * 1024 * 1024  # 10 MiB


class APIError(RuntimeError):
    """Raised when the Forgejo API returns an HTTP error."""

    def __init__(self, method, url, status_code, body):
        super().__init__(f"API {method} {url} failed ({status_code}): {body}")
        self.status_code = status_code


def _token():
    val = os.environ.get("FORGEJO_TOKEN")
    if not val:
        raise RuntimeError(
            "Required environment variable FORGEJO_TOKEN is not set. "
            "Add it as a repository secret and expose it via the workflow env: block."
        )
    return val


def _repo():
    repo = os.environ.get("FORGEJO_REPOSITORY") or os.environ["GITHUB_REPOSITORY"]
    if not re.fullmatch(r"[a-zA-Z0-9_.\-]+/[a-zA-Z0-9_.\-]+", repo):
        raise ValueError(f"Invalid repository format: {repo!r}")
    return repo


def _request(method, path, body=None, token=None):
    """Make an authenticated API request. Returns parsed JSON or None."""
    url = f"{API_BASE}{path}" if path.startswith("/") else f"{API_BASE}/{path}"
    if not url.startswith(API_BASE):
        raise ValueError(f"Refusing request to URL outside API_BASE: {url!r}")
    headers = {
        "Authorization": f"Bearer {token or _token()}",
        "Content-Type": "application/json",
    }
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise RuntimeError(
                    f"API {method} {url} response exceeds {MAX_RESPONSE_BYTES} bytes"
                )
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="replace") if e.fp else ""
        raise APIError(method, url, e.code, error_body[:500]) from e


def get(path, token=None):
    return _request("GET", path, token=token)


def post(path, body, token=None):
    return _request("POST", path, body, token=token)


def patch(path, body, token=None):
    return _request("PATCH", path, body, token=token)


def delete(path, token=None):
    return _request("DELETE", path, token=token)


def repo_path(suffix=""):
    """Build /repos/{owner}/{repo}{suffix} path."""
    return f"/repos/{_repo()}{suffix}"


def issue_labels_path(number):
    return repo_path(f"/issues/{number}/labels")


def issue_comments_path(number):
    return repo_path(f"/issues/{number}/comments")
