
# resource caps (3.1.0): every embedded program bounds its own address space
# and CPU time, and git's children are tuned to stay inside them
import os as _o, resource as _r
for _k, _v in ((_r.RLIMIT_AS, 1 << 30), (_r.RLIMIT_CPU, 300)):
    _h = _r.getrlimit(_k)[1]
    _r.setrlimit(_k, (_v if _h == _r.RLIM_INFINITY else min(_v, _h), _h))
_o.environ['MALLOC_ARENA_MAX'] = '2'
# 6.0.0 security review: git never reads refs/replace/* objects in place of sealed ids
_o.environ['GIT_NO_REPLACE_OBJECTS'] = '1'
_n = int(_o.environ.get('GIT_CONFIG_COUNT') or 0)
for _i, _kv in enumerate((('core.packedGitWindowSize', '32m'), ('core.packedGitLimit', '256m'), ('core.bigFileThreshold', '16m'), ('pack.threads', '1'))):
    _o.environ['GIT_CONFIG_KEY_%d' % (_n + _i)], _o.environ['GIT_CONFIG_VALUE_%d' % (_n + _i)] = _kv
_o.environ['GIT_CONFIG_COUNT'] = str(_n + 4)
_RAW_PATH = _o.environ.get('PATH', '')
def clean_path(inside=()):
    # PATH for children: absolute entries only, none inside the given dirs
    keep = []
    for e in _RAW_PATH.split(':'):
        if not e or not _o.path.isabs(e):
            continue
        r = _o.path.realpath(e)
        if any(r == _o.path.realpath(d) or r.startswith(_o.path.realpath(d).rstrip('/') + '/') for d in inside):
            continue
        keep.append(e)
    return ':'.join(keep)
_o.environ['PATH'] = clean_path()
# fleet 4.0.0 (1993): the program hashes its own file. The workflow compares
# the name and the sha256 with the shipped copy; a pasted or re-typed copy
# has no file and prints nulls.
import hashlib as _hl
try:
    with open(globals()['__file__'], 'rb') as _fh:
        _PROG = {'name': _o.path.basename(_fh.name)[:-3], 'sha256': _hl.sha256(_fh.read(1 << 22)).hexdigest()}
except Exception:
    _PROG = {'name': None, 'sha256': None}
import hashlib, json, os, re, shutil, subprocess, sys, time
def lift():
    # podman (a Go binary) is not bound by this program's caps
    for k in (_r.RLIMIT_AS, _r.RLIMIT_CPU):
        _r.setrlimit(k, (_r.getrlimit(k)[1],) * 2)
# fleet 4.0.0 (1981): the only containers these programs touch
NAME = re.compile(r'fleet-db-[a-z0-9-]{1,80}')
def name_ok(n):
    return isinstance(n, str) and NAME.fullmatch(n) is not None and 'tf-local' not in n
def done(out):
    out['program'] = _PROG
    out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0)
def fail(code, msg):
    sys.stderr.write(msg + '\n')
    sys.exit(code)
PM = shutil.which('podman')
def pm(*a, timeout=120):
    return subprocess.run([PM] + list(a), capture_output=True, timeout=timeout, preexec_fn=lift)
def tail(r):
    return (r.stderr or b'').decode('utf-8', 'replace')[-400:]
# Removes only containers with the label fleet.db=1, a name fleet-db-*, and
# a fleet.expires time in the past. Any other container is never touched.
out = {'podman': PM is not None, 'removed': [], 'kept': [], 'errors': []}
if PM:
    r = pm('ps', '-a', '--filter', 'label=fleet.db=1', '--format', 'json')
    rows = None
    if r.returncode == 0:
        try:
            rows = json.loads(r.stdout.decode('utf-8') or '[]') or []
        except ValueError:
            rows = None
    if not isinstance(rows, list):
        out['errors'].append('podman ps: ' + tail(r))
        rows = []
    now = int(time.time())
    for c in rows:
        names = c.get('Names') if isinstance(c, dict) else None
        n = names[0] if isinstance(names, list) and names and isinstance(names[0], str) else ''
        labels = c.get('Labels') if isinstance(c, dict) and isinstance(c.get('Labels'), dict) else {}
        exp = labels.get('fleet.expires')
        expired = isinstance(exp, str) and re.fullmatch(r'[0-9]{1,12}', exp) is not None and int(exp) < now
        if labels.get('fleet.db') != '1' or not name_ok(n) or not expired:
            if n:
                out['kept'].append(n)
            continue
        rr = pm('rm', '-f', n)
        if rr.returncode == 0:
            out['removed'].append(n)
        else:
            out['errors'].append(n + ': ' + tail(rr))
done(out)
