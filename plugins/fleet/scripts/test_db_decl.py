
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
import hashlib, json, os, re, subprocess, sys
os.environ['GIT_CONFIG_NOSYSTEM'] = '1'
# fleet 4.0.0 (1981): the throwaway test database declaration, read at
# origin/<default branch> (never the worktree: a role cannot declare it)
wt, branch = sys.argv[1], sys.argv[2]
out = {'decl': None, 'error': None, 'args': [wt, branch]}
def done():
    out['program'] = _PROG
    out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0)
# fleet 5.0.3 (2011): the one optional key; db_up.py and the workflow check the same
SYSTEM_SCHEMAS = ('mysql', 'sys', 'information_schema', 'performance_schema')
def prefix_problem(p):
    if not isinstance(p, str) or not re.fullmatch(r'[a-z][a-z0-9_]{0,30}_', p):
        return 'test_db_prefix must be a string matching ^[a-z][a-z0-9_]{0,30}_$'
    if p.startswith('fleet_'):
        return 'test_db_prefix must not start with fleet_ (the role databases)'
    like = re.compile(re.escape(p).replace('_', '.') + '.*')
    if any(s.startswith(p) or p.startswith(s) or like.fullmatch(s) for s in SYSTEM_SCHEMAS):
        return 'test_db_prefix must not match or start a system schema (' + ', '.join(SYSTEM_SCHEMAS) + ')'
    return None
def problem(d):
    if not isinstance(d, dict):
        return 'not a JSON object'
    if sorted(k for k in d if k != 'test_db_prefix') != ['engine', 'env', 'major', 'version']:
        return 'keys must be exactly version, engine, major, env (and optionally test_db_prefix)'
    if isinstance(d['version'], bool) or d['version'] != 1:
        return 'version must be 1'
    if d['engine'] != 'mariadb':
        return 'engine must be mariadb'
    if not isinstance(d['major'], str) or not re.fullmatch(r'[0-9]{1,3}\.[0-9]{1,3}', d['major']):
        return 'major must be a string like 11.4'
    if not isinstance(d['env'], str) or not re.fullmatch(r'[A-Z][A-Z0-9_]{0,40}_TEST_DSN', d['env']):
        return 'env must match ^[A-Z][A-Z0-9_]{0,40}_TEST_DSN$'
    if 'test_db_prefix' in d:
        return prefix_problem(d['test_db_prefix'])
    return None
if not re.fullmatch(r'[A-Za-z0-9._/-]{1,200}', branch) or '..' in branch or branch.startswith(('-', '/')):
    out['error'] = 'default branch name refused'
    done()
G = ['git', '-c', 'core.fsmonitor=false', '-C', wt]
base = 'refs/remotes/origin/' + branch
if subprocess.run(G + ['rev-parse', '--verify', '-q', base + '^{commit}'], capture_output=True).returncode != 0:
    out['error'] = 'origin/' + branch + ' not found'
    done()
spec = base + ':.fleet-test-db.json'
t = subprocess.run(G + ['cat-file', '-t', spec], capture_output=True)
if t.returncode != 0:
    done()
if t.stdout.strip() != b'blob':
    out['error'] = '.fleet-test-db.json is not a file'
    done()
raw = subprocess.run(G + ['cat-file', 'blob', spec], capture_output=True).stdout
if len(raw) > 4096:
    out['error'] = '.fleet-test-db.json is larger than 4096 bytes'
    done()
try:
    d = json.loads(raw.decode('utf-8'))
except ValueError:
    out['error'] = '.fleet-test-db.json is not JSON'
    done()
p = problem(d)
if p:
    out['error'] = p
else:
    out['decl'] = d
done()
