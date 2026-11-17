
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
# fleet 7.3.0 (#9, L2008): exclude_add.py <repo> <pattern>...: keep fleet files and test caches
# out of git status. For each pattern git does not already ignore (probe: the pattern itself,
# or <pattern>probe for a dir pattern ending in /), append the line to info/exclude in the
# common git dir, once. Never a tracked .gitignore. Prints {added, exclude, args}.
if len(sys.argv) < 3:
    sys.exit('usage: <repo> <pattern>...')
repo, pats = sys.argv[1], sys.argv[2:]
for p in pats:
    if not p or p.startswith(('-', '!', '#')) or any(c in p for c in '\n\r\0'):
        sys.exit('bad pattern: ' + repr(p))
os.environ['GIT_TERMINAL_PROMPT'] = '0'
G = ['git', '-c', 'core.fsmonitor=false', '-C', repo]
r = subprocess.run(G + ['rev-parse', '--path-format=absolute', '--git-common-dir'], capture_output=True, timeout=60)
if r.returncode != 0:
    sys.exit(r.stderr.decode('utf-8', 'replace')[-2000:] or 'git rev-parse failed')
ex = os.path.join(r.stdout.decode('utf-8', 'replace').strip(), 'info', 'exclude')
try:
    with open(ex, 'rb') as f:
        have = f.read().decode('utf-8', 'replace')
except FileNotFoundError:
    have = ''
lines = set(have.splitlines())
added = []
for p in pats:
    probe = p + 'probe' if p.endswith('/') else p
    c = subprocess.run(G + ['check-ignore', '-q', '--no-index', '--', probe], capture_output=True, timeout=60)
    if c.returncode == 0 or p in lines or p in added:
        continue
    if c.returncode != 1:
        sys.exit(c.stderr.decode('utf-8', 'replace')[-2000:] or 'git check-ignore failed')
    added.append(p)
if added:
    if os.path.islink(ex):
        sys.exit('refusing a symlink at ' + ex)
    os.makedirs(os.path.dirname(ex), exist_ok=True)
    with open(ex, 'a', encoding='utf-8') as f:
        f.write(('' if not have or have.endswith('\n') else '\n') + ''.join(x + '\n' for x in added))
out = {'added': added, 'exclude': ex, 'args': [repo] + pats}
out['program'] = _PROG
out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
print(json.dumps(out, ensure_ascii=False))
