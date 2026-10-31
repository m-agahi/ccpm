"""GitHub REST API client using only stdlib."""

import json
import os
import pathlib
import re
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_API_BASE = "https://api.github.com"
DEFAULT_UPLOADS_BASE = "https://uploads.github.com"
API_BASE = os.environ.get("GITHUB_API_URL", DEFAULT_API_BASE).rstrip("/")
UPLOADS_BASE = os.environ.get("GITHUB_UPLOADS_URL", DEFAULT_UPLOADS_BASE).rstrip("/")
API_VERSION = "2022-11-28"
MAX_RESPONSE_BYTES = 10 * 1024 * 1024  # 10 MiB
_RETRY_DELAYS = (2, 4)  # seconds to wait before 2nd and 3rd attempt on 5xx


class APIError(RuntimeError):
    """Raised when the GitHub API returns an HTTP error."""

    def __init__(self, method, url, status_code, body):
        super().__init__(f"API {method} {url} failed ({status_code}): {body}")
        self.status_code = status_code
        self.body = body


def is_already_exists(err):
    """True when a 422 response reports an ``already_exists`` validation error.

    GitHub uses 422 for both "resource already exists" and genuine payload
    validation failures, so the status code alone is not enough to skip.
    """
    return err.status_code == 422 and "already_exists" in (err.body or "")


def _token():
    val = os.environ.get("GITHUB_TOKEN")
    if not val:
        raise RuntimeError(
            "Required environment variable GITHUB_TOKEN is not set. "
            "Expose it via the workflow env: block (GITHUB_TOKEN: ${{ github.token }})."
        )
    return val


def _repo():
    repo = os.environ["GITHUB_REPOSITORY"]
    if not re.fullmatch(r"[a-zA-Z0-9_.\-]+/[a-zA-Z0-9_.\-]+", repo):
        raise ValueError(f"Invalid repository format: {repo!r}")
    return repo


def _headers(token=None, content_type="application/json"):
    return {
        "Authorization": f"Bearer {token or _token()}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
        "Content-Type": content_type,
    }


def _http_error(method, url, e):
    error_body = e.read().decode("utf-8", errors="replace") if e.fp else ""
    return APIError(method, url, e.code, error_body[:500])


def _request(method, path, body=None, token=None):
    """Make an authenticated API request. Returns parsed JSON or None.

    Retries up to len(_RETRY_DELAYS) times on 5xx responses with delays
    defined by _RETRY_DELAYS before giving up and raising APIError.
    """
    url = f"{API_BASE}{path}" if path.startswith("/") else f"{API_BASE}/{path}"
    if not url.startswith(API_BASE + "/"):
        raise ValueError(f"Refusing request to URL outside API_BASE: {url!r}")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url, data=data, headers=_headers(token), method=method
    )

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
            api_err = _http_error(method, url, e)
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


def upload_asset(release, file_path, asset_name, token=None):
    """Upload a binary file as a release asset.

    GitHub takes the raw file bytes (not multipart) POSTed to the release's
    ``upload_url`` (a URI template on uploads.github.com).
    """
    base = release["upload_url"].split("{", 1)[0]
    if not base.startswith(UPLOADS_BASE + "/"):
        raise ValueError(f"Refusing upload to URL outside UPLOADS_BASE: {base!r}")
    url = f"{base}?name={urllib.parse.quote(asset_name, safe='')}"

    body = pathlib.Path(file_path).read_bytes()
    headers = _headers(token, content_type="application/octet-stream")
    headers["Content-Length"] = str(len(body))
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read(MAX_RESPONSE_BYTES + 1)
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raise _http_error("POST", url, e) from e


def repo_path(suffix=""):
    """Build /repos/{owner}/{repo}{suffix} path."""
    return f"/repos/{_repo()}{suffix}"


def issue_labels_path(number):
    return repo_path(f"/issues/{number}/labels")


def issue_comments_path(number):
    return repo_path(f"/issues/{number}/comments")
