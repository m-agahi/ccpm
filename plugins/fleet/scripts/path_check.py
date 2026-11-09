
# resource caps (3.1.0): every embedded program bounds its own address space
# and CPU time, and git's children are tuned to stay inside them
import os as _o, resource as _r
for _k, _v in ((_r.RLIMIT_AS, 1 << 30), (_r.RLIMIT_CPU, 300)):
    _h = _r.getrlimit(_k)[1]
    _r.setrlimit(_k, (_v if _h == _r.RLIM_INFINITY else min(_v, _h), _h))
_o.environ['MALLOC_ARENA_MAX'] = '2'
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
import hashlib, json, os, shutil, sys
os.chdir('/')
MARKER = b'fleet-agent-shim: hard-rules'
NAMES = ('terra' + 'form', 'to' + 'fu', 't' + 'fp', 'terra' + 'grunt', 'dig' + 'ger', 'atlan' + 'tis')
store = '/nix/store/'
repo = None
for a in sys.argv[1:]:
    if a.startswith('--store-prefix='):
        store = a[len('--store-prefix='):]
    elif repo is None:
        repo = a
# the agent's shell resolves an empty or relative PATH entry against its cwd
# (the worktree), and an entry inside the repo is a role's own dir: refuse both
problems = []
rr = os.path.realpath(repo) if repo else None
for e in _RAW_PATH.split(':'):
    if e == '':
        problems.append('empty PATH entry')
    elif not os.path.isabs(e):
        problems.append('relative PATH entry ' + json.dumps(e))
    elif rr and (os.path.realpath(e) == rr or os.path.realpath(e).startswith(rr.rstrip('/') + '/')):
        problems.append('PATH entry ' + json.dumps(e) + ' is inside the repo ' + json.dumps(repo))
tools = {}
for name in NAMES:
    p = shutil.which(name, path=':'.join(e for e in _RAW_PATH.split(':') if e and os.path.isabs(e)))
    if p is None:
        tools[name] = None
        continue
    real = os.path.realpath(p)
    try:
        with open(real, 'rb') as fh:
            head = fh.read(65536)
    except OSError:
        head = b''
    tools[name] = {'path': p, 'real': real, 'shim': real.startswith(store) and MARKER in head}
out = {'tools': tools, 'args': sys.argv[1:], 'path_problems': problems}
out['program'] = _PROG
out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
print(json.dumps(out, ensure_ascii=False))
