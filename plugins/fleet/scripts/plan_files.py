
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
import hashlib, json, os, subprocess, sys
os.environ['GIT_CONFIG_NOSYSTEM'] = '1'
# 6.0.0 (ledger 2042): the files of <commit> (the dangling plan commit) against its parent
wt, commit = sys.argv[1], sys.argv[2]
os.chdir('/')
G = ['git', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-C', wt]
def run(*a):
    r = subprocess.run(G + list(a), capture_output=True)
    if r.returncode != 0:
        sys.exit(r.stderr.decode('utf-8', 'replace') or 'git ' + a[0] + ' exited ' + str(r.returncode))
    return r.stdout
head = run('rev-parse', '--verify', 'HEAD^{commit}').decode().strip()
pc = run('rev-parse', '--verify', commit + '^{commit}').decode().strip()
parent = run('rev-parse', '--verify', pc + '^').decode().strip()
raw = [x for x in run('diff-tree', '-r', '--no-commit-id', '--name-only', '-z', '--no-renames', parent, pc).split(b'\0') if x]
files = [x.decode('utf-8', 'replace') for x in raw]
# fleet 4.0.0 review: the committed files that hold a test DSN (mysql://,
# any case); a blob over 8 MiB is listed unread (fail closed); a path the
# commit deletes has no blob and is skipped
dsn_paths = []
for b, f in zip(raw, files):
    s = subprocess.run(G + ['cat-file', '-s', pc + ':' + b.decode('utf-8', 'surrogateescape')], capture_output=True)
    if s.returncode != 0:
        continue
    if int(s.stdout.strip() or 0) > (8 << 20):
        dsn_paths.append(f)
        continue
    d = subprocess.run(G + ['cat-file', 'blob', pc + ':' + b.decode('utf-8', 'surrogateescape')], capture_output=True)
    if d.returncode != 0 or b'mysql://' in d.stdout.lower():
        dsn_paths.append(f)
out = {'head': head, 'commit': pc, 'parent': parent, 'files': files, 'args': [wt, commit], 'dsn_paths': dsn_paths}
out['program'] = _PROG
out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
print(json.dumps(out, ensure_ascii=False))
