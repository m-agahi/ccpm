"""Codeberg / Forgejo API client using only stdlib."""

import json
import os
import re
import time
import urllib.error
import urllib.request

API_BASE = os.environ.get("FORGEJO_API_BASE", "https://codeberg.org/api/v1")
MAX_RESPONSE_BYTES = 10 * 1024 * 1024  # 10 MiB
_RETRY_DELAYS = (2, 4)  # seconds to wait before 2nd and 3rd attempt on 5xx


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
    """Make an authenticated API request. Returns parsed JSON or None.

    Retries up to len(_RETRY_DELAYS) times on 5xx responses with delays
    defined by _RETRY_DELAYS before giving up and raising APIError.
    """
    url = f"{API_BASE}{path}" if path.startswith("/") else f"{API_BASE}/{path}"
    if not url.startswith(API_BASE):
        raise ValueError(f"Refusing request to URL outside API_BASE: {url!r}")
    headers = {
        "Authorization": f"Bearer {token or _token()}",
        "Content-Type": "application/json",
    }
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)

    last_err = None
    for delay in (*_RETRY_DELAYS, None):
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
            api_err = APIError(method, url, e.code, error_body[:500])
            if e.code < 500 or delay is None:
                raise api_err from e
            last_err = api_err
        if delay is not None:
            time.sleep(delay)

    raise last_err  # all retries exhausted


def get(path, token=None):
    return _request("GET", path, token=token)


def post(path, body, token=None):
    return _request("POST", path, body, token=token)


def patch(path, body, token=None):
    return _request("PATCH", path, body, token=token)


def delete(path, token=None):
    return _request("DELETE", path, token=token)


def upload_asset(release_id, file_path, asset_name, token=None):
    """Upload a binary file as a release asset (multipart/form-data)."""
    import pathlib
    import uuid

    url = f"{API_BASE}{repo_path(f'/releases/{release_id}/assets')}?name={asset_name}"
    if not url.startswith(API_BASE):
        raise ValueError(f"Refusing request to URL outside API_BASE: {url!r}")

    boundary = uuid.uuid4().hex
    file_bytes = pathlib.Path(file_path).read_bytes()

    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="attachment"; filename="{asset_name}"\r\n'
        f"Content-Type: application/octet-stream\r\n"
        f"\r\n"
    ).encode() + file_bytes + f"\r\n--{boundary}--\r\n".encode()

    headers = {
        "Authorization": f"Bearer {token or _token()}",
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "Content-Length": str(len(body)),
    }
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read(MAX_RESPONSE_BYTES + 1)
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="replace") if e.fp else ""
        raise APIError("POST", url, e.code, error_body[:500]) from e


def repo_path(suffix=""):
    """Build /repos/{owner}/{repo}{suffix} path."""
    return f"/repos/{_repo()}{suffix}"


def issue_labels_path(number):
    return repo_path(f"/issues/{number}/labels")


def issue_comments_path(number):
    return repo_path(f"/issues/{number}/comments")
