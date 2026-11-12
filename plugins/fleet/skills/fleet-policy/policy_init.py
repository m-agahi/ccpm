#!/usr/bin/env python3
"""Create or change the fleet policy file (fleet 6.2.1, ledger 2097).

Max's ruling: "yes it should create on first use". The /build-task, /plan-task
and /fleet-policy skills run this helper with `python3 -I`, and only after Max
answered their AskUserQuestion. Stdlib only. Every command prints one JSON
object; exit 0 on success, 1 on a refusal, 2 on bad arguments.

  status                 read only: the path, whether it exists, its text, the
                         policy.py verdict on it, the don't-ask marker, the
                         shipped template text
  create shown|never     write the file from policy.example.json: byte for
                         byte (shown), or with every merge set to "never"
                         (never). Refuses when anything is at the path.
  marker                 write the don't-ask marker next to the policy path
  set-merge-never        back up the file, then set every merge to "never"
  recreate shown|never   back up the file, then write it from the template

The path is the one scripts/policy.py reads (its "file" field), so the two
cannot drift. Every result is checked with scripts/policy.py itself before it
lands: a file that parser refuses is never written. A new file is linked into
place (os.link fails on any existing entry, so there is no overwrite race); a
change writes a mode 0600 backup first, then replaces the file atomically.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

PLUGIN = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
POLICY_PY = os.path.join(PLUGIN, "scripts", "policy.py")
TEMPLATE = os.path.join(PLUGIN, "policy.example.json")
MARKER_SUFFIX = ".dont-ask"
MAX_BYTES = 65536


class Refuse(Exception):
    pass


def emit(obj, code):
    print(json.dumps(obj, ensure_ascii=False))
    sys.exit(code)


def policy_py(xdg):
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ.get("HOME", "/")}
    if xdg is not None:
        env["XDG_CONFIG_HOME"] = xdg
    try:
        r = subprocess.run([sys.executable, "-I", POLICY_PY, "github.com", "fleet/policy-check"], env=env, capture_output=True, text=True, timeout=60)
        out = json.loads(r.stdout)
    except (OSError, ValueError, subprocess.SubprocessError) as e:
        raise Refuse("policy.py did not run: " + str(e)[:200])
    if r.returncode != 0 or not isinstance(out, dict) or "file" not in out:
        raise Refuse("policy.py did not run: " + (r.stderr or r.stdout)[:200])
    return out


def xdg_env():
    # 6.2.1 review L1: a relative XDG_CONFIG_HOME resolves against the cwd, and the
    # helper and the workflow run in different dirs: refuse it
    x = os.environ.get("XDG_CONFIG_HOME")
    if x and not os.path.isabs(x):
        raise Refuse("XDG_CONFIG_HOME is relative (" + x[:100] + "); the helper and the workflow would resolve it differently. Set it to an absolute path or unset it")
    return x


def policy_path():
    return policy_py(xdg_env())["file"]


def write_new(path, raw):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.fchmod(fd, 0o600)
        os.write(fd, raw)
        os.fsync(fd)
    finally:
        os.close(fd)


def check(raw, fleet_dir):
    """Run policy.py on these bytes in a staging dir; the dir is removed on every path."""
    stage = tempfile.mkdtemp(prefix=".policy-init-", dir=fleet_dir)
    try:
        os.makedirs(os.path.join(stage, "fleet"))
        staged = os.path.join(stage, "fleet", "policy.json")
        write_new(staged, raw)
        out = policy_py(stage)
        if out.get("error") is not None:
            raise Refuse("policy.py refuses it: " + str(out["error"]).replace(staged, "<staged>")[:300])
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def temp_copy(raw, fleet_dir):
    """A mode 0600 temp file in the target dir holding exactly the checked bytes."""
    fd, tmp = tempfile.mkstemp(prefix=".policy-init-", suffix=".json", dir=fleet_dir)
    try:
        os.fchmod(fd, 0o600)
        os.write(fd, raw)
        os.fsync(fd)
    finally:
        os.close(fd)
    return tmp


def merge_never(raw):
    try:
        doc = json.loads(raw.decode("utf-8"))
        for p in doc["profiles"]:
            p["merge"] = "never"
            for rc in (p.get("repos") or {}).values():
                if "merge" in rc:
                    rc["merge"] = "never"
    except (ValueError, KeyError, TypeError, AttributeError, UnicodeDecodeError) as e:
        raise Refuse("cannot set merge to never: " + str(e)[:200])
    return (json.dumps(doc, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def read_regular(path):
    if not os.path.lexists(path):
        raise Refuse("no policy file at " + path)
    if os.path.islink(path) or not os.path.isfile(path):
        raise Refuse(path + " is not a regular file")
    if os.path.getsize(path) > MAX_BYTES:
        raise Refuse(path + " is over 64 KiB")
    with open(path, "rb") as f:
        return f.read(MAX_BYTES + 1)


def template_bytes():
    with open(TEMPLATE, "rb") as f:
        return f.read(MAX_BYTES + 1)


def fleet_dir_of(path):
    d = os.path.dirname(path)
    if not os.path.isdir(d):
        os.makedirs(d, mode=0o700, exist_ok=True)
        os.chmod(d, 0o700)
    return d


def content_for(how, fleet_dir):
    raw = template_bytes()
    # the source itself must pass the parser (a duplicate key would vanish in a re-dump)
    check(raw, fleet_dir)
    return raw if how == "shown" else merge_never(raw)


def write_backup(path, raw):
    stamp = path + ".bak-" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    for n in range(100):
        bak = stamp + ("-%d" % n if n else "")
        try:
            fd = os.open(bak, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            break
        except FileExistsError:
            continue
    else:
        raise Refuse("no free backup name for " + stamp)
    try:
        os.fchmod(fd, 0o600)
        os.write(fd, raw)
        os.fsync(fd)
    finally:
        os.close(fd)
    return bak


def cmd_status():
    path = policy_path()
    marker = path + MARKER_SUFFIX
    out = {"file": path, "exists": os.path.lexists(path), "content": None, "error": None, "marker_file": marker, "marker": os.path.lexists(marker), "template_file": TEMPLATE, "template": template_bytes().decode("utf-8")}
    if out["exists"]:
        out["error"] = policy_py(xdg_env())["error"]
        raw = read_regular(path)
        try:
            out["content"] = raw.decode("utf-8")
        except UnicodeDecodeError as e:
            # 6.2.1 review L1: a clear refusal, not a quiet null
            raise Refuse(path + " is not UTF-8 text (byte " + str(e.start) + "); fix or re-create it with /fleet-policy")
    return out


def cmd_create(how):
    path = policy_path()
    if os.path.lexists(path):
        raise Refuse(path + " exists; /fleet-policy changes it")
    d = fleet_dir_of(path)
    raw = content_for(how, d)
    check(raw, d)
    tmp = temp_copy(raw, d)
    try:
        try:
            os.link(tmp, path)
        except FileExistsError:
            raise Refuse(path + " exists; /fleet-policy changes it")
    finally:
        os.unlink(tmp)
    return {"written": path, "mode": how}


def cmd_marker():
    path = policy_path()
    marker = path + MARKER_SUFFIX
    fleet_dir_of(path)
    if not os.path.lexists(marker):
        fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            os.fchmod(fd, 0o600)
            os.write(fd, b"fleet: do not offer to create policy.json (delete this file to be asked again)\n")
        finally:
            os.close(fd)
    return {"written": marker}


def cmd_change(how):
    path = policy_path()
    old = read_regular(path)
    d = os.path.dirname(path)
    if how == "merge-never":
        check(old, d)
        raw = merge_never(old)
    else:
        raw = content_for(how, d)
    check(raw, d)
    tmp = temp_copy(raw, d)
    try:
        bak = write_backup(path, old)
        os.replace(tmp, path)
    finally:
        if os.path.lexists(tmp):
            os.unlink(tmp)
    return {"written": path, "backup": bak, "mode": how}


def main(argv):
    if argv == ["status"]:
        return cmd_status()
    if len(argv) == 2 and argv[0] == "create" and argv[1] in ("shown", "never"):
        return cmd_create(argv[1])
    if argv == ["marker"]:
        return cmd_marker()
    if argv == ["set-merge-never"]:
        return cmd_change("merge-never")
    if len(argv) == 2 and argv[0] == "recreate" and argv[1] in ("shown", "never"):
        return cmd_change(argv[1])
    emit({"error": "usage: policy_init.py status | create shown|never | marker | set-merge-never | recreate shown|never"}, 2)


if __name__ == "__main__":
    try:
        emit(main(sys.argv[1:]), 0)
    except (Refuse, OSError) as e:
        emit({"error": str(e)}, 1)
