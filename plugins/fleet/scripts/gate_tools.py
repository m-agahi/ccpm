
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
# fleet 8.0.0 (G1, ADR-1315, ADR-1316): the gate tool census. Args: <repo> <image>.
# Languages come from marker files at the repo root; coverage tools from which()
# on PATH (no entry inside the repo). Mutation is the built-in mutator for the
# supported languages. The security scan is the pinned container image only: the
# runtime is podman, else docker; the one command it runs is the runtime's
# read-only image check, and only for an image pinned by digest. It pulls and
# runs no image and no scanner. Host scanners are never named here.
import hashlib, json, os, re, shutil, subprocess, sys
if len(sys.argv) != 3:
    sys.stderr.write('usage: gate_tools.py <repo> <image>\n')
    sys.exit(2)
repo, image = sys.argv[1], sys.argv[2]
os.chdir('/')
os.environ['PATH'] = clean_path((repo,) if os.path.isabs(repo) else ())
MARKERS = (('python', ('pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt')), ('node', ('package.json',)), ('go', ('go.mod',)), ('rust', ('Cargo.toml',)))
COVER = {'python': ('coverage',), 'node': ('jest', 'c8', 'nyc'), 'go': ('go',), 'rust': ('cargo-llvm-cov',), 'other': ()}
langs = [n for n, fs in MARKERS if os.path.isabs(repo) and any(os.path.isfile(os.path.join(repo, f)) for f in fs)] or ['other']
runtime = next((t for t in ('podman', 'docker') if shutil.which(t)), None)
present, reason = False, None
if not re.match(r'^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$', image):
    reason = 'image digest not pinned'
elif runtime is None:
    reason = 'no container runtime (podman or docker)'
else:
    argv = [shutil.which(runtime), 'image', 'exists' if runtime == 'podman' else 'inspect', image]
    try:
        r = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        present = r.returncode == 0
        reason = None if present else 'image not present locally (exit %d)' % r.returncode
    except Exception as e:
        reason = '%s image check failed: %s' % (runtime, type(e).__name__)
matrix = {}
for n in ('python', 'node', 'go', 'rust', 'other'):
    cov = next((t for t in COVER[n] if shutil.which(t)), None)
    matrix[n] = {'coverage': cov or 'unsupported', 'mutation': 'builtin' if n != 'other' else 'unsupported', 'security': 'container' if present else 'unsupported'}
out = {'languages': langs, 'matrix': matrix, 'container': {'runtime': runtime, 'image': image, 'present': present, 'reason': reason}, 'args': sys.argv[1:]}
out['program'] = _PROG
out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
print(json.dumps(out, ensure_ascii=False))
