
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
import hashlib, json, os, shutil, stat, sys
# fleet 7.3.0 (#9, L2008): purge.py <worktree>: delete every __pycache__ and .pytest_cache dir
# and every *.pyc and *.pyo file, as the 7.2.0 find pipeline did. .git, .venv, venv, .tox, .nox,
# node_modules and .claude/worktrees are skipped. Nothing is followed through a symlink: a
# symlink is never deleted or descended (lstat). A cache dir counts once. Prints {purged, args}.
if len(sys.argv) != 2:
    sys.exit('usage: <worktree>')
wt = sys.argv[1]
if not os.path.isdir(wt) or os.path.islink(wt):
    sys.exit('not a directory: ' + wt)
PRUNE = {'.git', '.venv', 'venv', '.tox', '.nox', 'node_modules'}
CACHES = {'__pycache__', '.pytest_cache'}
purged = 0
errors = []
def onerr(e):
    errors.append(str(e))
for dp, dns, fns in os.walk(wt, onerror=onerr):
    keep = []
    for d in dns:
        full = os.path.join(dp, d)
        try:
            st = os.lstat(full)
        except OSError as e:
            errors.append(str(e))
            continue
        if not stat.S_ISDIR(st.st_mode):
            continue
        rel = os.path.relpath(full, wt).replace(os.sep, '/')
        if d in PRUNE or rel == '.claude/worktrees' or rel.endswith('/.claude/worktrees'):
            continue
        if d in CACHES:
            shutil.rmtree(full, onerror=lambda f, p, x: errors.append(p + ': ' + str(x[1])))
            purged += 1
            continue
        keep.append(d)
    dns[:] = keep
    for f in fns:
        if f.endswith(('.pyc', '.pyo')):
            full = os.path.join(dp, f)
            try:
                if stat.S_ISREG(os.lstat(full).st_mode):
                    os.unlink(full)
                    purged += 1
            except OSError as e:
                errors.append(str(e))
if errors:
    sys.exit('purge failed: ' + '; '.join(errors)[:2000])
out = {'purged': purged, 'args': [wt]}
out['program'] = _PROG
out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
print(json.dumps(out, ensure_ascii=False))
