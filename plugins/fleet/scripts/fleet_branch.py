
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
# fleet 7.3.0 (#43, L2177): fleet_branch.py <repo> <task id>: the slugs of the
# local branches refs/heads/fleet/<task id>-<slug>, sorted. Read only.
if len(sys.argv) != 3:
    sys.exit('usage: <repo> <task id>')
repo, tid = sys.argv[1], sys.argv[2]
if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,31}', tid):
    sys.exit('bad task id: ' + tid)
os.environ['GIT_TERMINAL_PROMPT'] = '0'
r = subprocess.run(['git', '-c', 'core.fsmonitor=', '-C', repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/fleet/'], capture_output=True, timeout=60)
if r.returncode != 0:
    sys.exit(r.stderr.decode('utf-8', 'replace')[-2000:] or 'git for-each-ref failed')
pre = 'refs/heads/fleet/' + tid + '-'
slugs = sorted(set(n[len(pre):] for n in r.stdout.decode('utf-8', 'replace').splitlines() if n.startswith(pre) and len(n) > len(pre)))[:50]
out = {'slugs': slugs, 'args': [repo, tid]}
out['program'] = _PROG
out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
print(json.dumps(out, ensure_ascii=False))
