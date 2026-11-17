
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
# fleet 7.3.0 (#43, L2177): fleet_branch.py <repo> <task id> <source>: the slugs of the
# local branches refs/heads/fleet/<task id>-<slug>, sorted, and (review fix) the ones proven
# to be this task's, in owned. The prefix alone also matches another task's branch (task id
# acme-api-2 sees fleet/acme-api-2-7-fix-x of task acme-api-2-7). A slug is owned when the
# sealed refs/fleet/<task id>/plan names its branch and lists <source> (kind:ref) in its
# brief, or when a parked findings.json of its worktree names <task id> and <source>. Read only.
if len(sys.argv) != 4:
    sys.exit('usage: <repo> <task id> <source>')
repo, tid, source = sys.argv[1], sys.argv[2], sys.argv[3]
if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,31}', tid):
    sys.exit('bad task id: ' + tid)
if not source or len(source) > 512:
    sys.exit('bad source: ' + source[:80])
os.environ['GIT_TERMINAL_PROMPT'] = '0'
G = ['git', '-c', 'core.fsmonitor=', '-C', repo]
r = subprocess.run(G + ['for-each-ref', '--format=%(refname)', 'refs/heads/fleet/'], capture_output=True, timeout=60)
if r.returncode != 0:
    sys.exit(r.stderr.decode('utf-8', 'replace')[-2000:] or 'git for-each-ref failed')
pre = 'refs/heads/fleet/' + tid + '-'
slugs = sorted(set(n[len(pre):] for n in r.stdout.decode('utf-8', 'replace').splitlines() if n.startswith(pre) and len(n) > len(pre)))[:50]
def canon(v):
    return json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
def sealed_branch():
    # the branch of a sealed plan ref whose brief lists <source>, else None
    t = subprocess.run(G + ['cat-file', 'tag', 'refs/fleet/' + tid + '/plan'], capture_output=True, timeout=60)
    if t.returncode != 0:
        return None
    try:
        m = json.loads(t.stdout.partition(b'\n\n')[2].decode('utf-8'))
        o = dict(m)
        seal = o.pop('seal')
        srcs = m['brief']['sources']
        if seal != hashlib.sha256(canon(o).encode('utf-8')).hexdigest() or m.get('task_id') != tid:
            return None
        if not any(isinstance(x, dict) and '%s:%s' % (x.get('kind'), x.get('ref')) == source for x in srcs):
            return None
        return m['branch'] if isinstance(m.get('branch'), str) else None
    except Exception:
        return None
def parked_owns(slug):
    # a parked/<run>/findings.json of the candidate's worktree that names this task and source
    d = os.path.join(repo, '.claude', 'worktrees', 'fleet-' + tid + '-' + slug, 'scratch', 'parked')
    if os.path.islink(d) or not os.path.isdir(d):
        return False
    for run in sorted(os.listdir(d))[:50]:
        f = os.path.join(d, run, 'findings.json')
        if run == 'used' or os.path.islink(os.path.join(d, run)) or os.path.islink(f) or not os.path.isfile(f) or os.path.getsize(f) > (1 << 20):
            continue
        try:
            with open(f, 'rb') as fh:
                j = json.loads(fh.read().decode('utf-8'))
        except (OSError, ValueError):
            continue
        if isinstance(j, dict) and j.get('task_id') == tid and j.get('source') == source:
            return True
    return False
sb = sealed_branch()
owned = [s for s in slugs if sb == 'fleet/' + tid + '-' + s or parked_owns(s)]
out = {'slugs': slugs, 'owned': owned, 'args': [repo, tid, source]}
out['program'] = _PROG
out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
print(json.dumps(out, ensure_ascii=False))
