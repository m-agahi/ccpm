
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
os.environ['GIT_CONFIG_NOSYSTEM'] = '1'
# 8.9.14 (yaadgaar #119): the repo's runtime-doc globs (.md files that code loads, so code and not docs),
# read at origin/<default branch> like .fleet-test-db.json (never the worktree: a role cannot shrink the list).
# The workflow checks each glob (runtimeDocsProblem) and adds its default roles/**/*.md.
wt, branch = sys.argv[1], sys.argv[2]
out = {'docs': None, 'error': None, 'args': [wt, branch]}
def done():
    out['program'] = _PROG
    out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0)
if not re.fullmatch(r'[A-Za-z0-9._/-]{1,200}', branch) or '..' in branch or branch.startswith(('-', '/')):
    out['error'] = 'default branch name refused'
    done()
G = ['git', '-c', 'core.fsmonitor=false', '-C', wt]
base = 'refs/remotes/origin/' + branch
if subprocess.run(G + ['rev-parse', '--verify', '-q', base + '^{commit}'], capture_output=True).returncode != 0:
    out['error'] = 'origin/' + branch + ' not found'
    done()
# review of 3d945e5 (2): only an empty listing of the root tree means "no file"; any git failure is an error
ls = subprocess.run(G + ['ls-tree', '-z', '--full-tree', base, '--', '.fleet-runtime-docs.json'], capture_output=True)
if ls.returncode != 0:
    out['error'] = 'git cannot list the tree of origin/' + branch
    done()
if not ls.stdout:
    done()
meta = ls.stdout.split(b'\t', 1)[0].split(b' ')
if len(meta) != 3 or meta[1] != b'blob' or meta[0] not in (b'100644', b'100755'):
    out['error'] = '.fleet-runtime-docs.json is not a file'
    done()
b = subprocess.run(G + ['cat-file', 'blob', meta[2].decode('ascii', 'replace')], capture_output=True)
if b.returncode != 0:
    out['error'] = 'git cannot read .fleet-runtime-docs.json at origin/' + branch
    done()
raw = b.stdout
if len(raw) > 4096:
    out['error'] = '.fleet-runtime-docs.json is larger than 4096 bytes'
    done()
try:
    d = json.loads(raw.decode('utf-8'))
except ValueError:
    out['error'] = '.fleet-runtime-docs.json is not JSON'
    done()
if not isinstance(d, dict) or sorted(d) != ['runtime_docs', 'version']:
    out['error'] = 'keys must be exactly version, runtime_docs'
elif isinstance(d['version'], bool) or d['version'] != 1:
    out['error'] = 'version must be 1'
elif not isinstance(d['runtime_docs'], list) or not all(isinstance(g, str) for g in d['runtime_docs']):
    out['error'] = 'runtime_docs must be a list of strings'
else:
    out['docs'] = d['runtime_docs']
done()
