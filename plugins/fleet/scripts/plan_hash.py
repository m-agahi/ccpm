
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
import hashlib, json, os, re, subprocess, sys
# 6.0.0 (ledger 2042): <rev> "" hashes the worktree file as it is
wt, rev, path = sys.argv[1:4]
def confined(wt, rel):
    # security review (6.0.0): <wt>/<rel> with no '..', NUL, backslash or symlinked component, inside wt
    if not re.fullmatch(r'[A-Za-z0-9._/-]+', rel) or rel.startswith('/') or '..' in rel.split('/'):
        return None
    base = os.path.realpath(wt)
    cur = base
    for part in rel.split('/'):
        cur = os.path.join(cur, part)
        if os.path.islink(cur):
            return None
    return cur if os.path.realpath(cur).startswith(base + '/') else None
if rev == '':
    f = confined(wt, path)
    if f is None or not os.path.isfile(f):
        sys.exit('no plan doc at ' + wt + '/' + path)
    with open(f, 'rb') as fh:
        d = fh.read()
    blob = None
else:
    blob = subprocess.run(['git', '-C', wt, 'rev-parse', '--verify', rev + ':' + path], capture_output=True, check=True).stdout.decode().strip()
    d = subprocess.run(['git', '-C', wt, 'cat-file', 'blob', blob], capture_output=True, check=True).stdout
print(json.dumps({'plan_sha256': hashlib.sha256(d).hexdigest(), 'blob': blob, 'program': _PROG}))
