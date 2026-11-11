
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
import hashlib, json, os, stat, sys
# fleet 5.0.3 (ledger 2010): does the plan doc in the worktree hold mysql://?
# The same test as the plan commit gate (plan_files.py): the bytes, lowered,
# hold b'mysql://'; a file over 8 MiB holds it unread (fail closed). It runs
# on the plan doc after the repo's hooks, before the audit and the commit.
# A path that is absolute, leaves the worktree, is a symlink or is no regular
# file exits non-zero and prints no JSON.
wt, rel = sys.argv[1], sys.argv[2]
os.chdir('/')
if os.path.isabs(rel) or '..' in rel.split('/') or '\0' in rel:
    sys.exit('plan path must be relative inside the worktree: ' + rel)
root = os.path.realpath(wt)
p = os.path.join(root, rel)
parent = os.path.realpath(os.path.dirname(p))
if parent != root and not parent.startswith(root.rstrip('/') + '/'):
    sys.exit('plan path leaves the worktree: ' + rel)
try:
    st = os.lstat(p)
except OSError as e:
    sys.exit('cannot read the plan doc: ' + str(e))
if not stat.S_ISREG(st.st_mode):
    sys.exit('the plan doc is not a regular file (no symlink): ' + rel)
lines = []
if st.st_size > (8 << 20):
    holds = True
else:
    fd = os.open(p, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(fd, 'rb') as fh:
        data = fh.read((8 << 20) + 1)
    holds = b'mysql://' in data.lower()
    lines = [i + 1 for i, x in enumerate(data.split(b'\n')) if b'mysql://' in x.lower()]
out = {'holds': holds, 'lines': lines, 'args': [wt, rel]}
out['program'] = _PROG
out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
print(json.dumps(out, ensure_ascii=False))
