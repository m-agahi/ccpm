
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
import hashlib, json, subprocess, sys
wt, rev = sys.argv[1], sys.argv[2]
# fleet 4.0.0 review: the hook ids feed the auto gate G2, so every path
# prints every key, the args and a digest the workflow checks
def emit(present, ids, parser, error):
    out = {'present': present, 'ids': ids, 'parser': parser, 'error': error, 'args': [wt, rev]}
    out['program'] = _PROG
    out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0)
r = subprocess.run(['git', '-C', wt, 'show', rev + ':.pre-commit-config.yaml'], capture_output=True)
if r.returncode != 0:
    emit(False, [], None, None)
try:
    import yaml
except ImportError:
    emit(True, [], None, 'PyYAML unavailable')
if len(r.stdout) > 262144:
    emit(True, [], None, 'the config is over 256 KiB')
try:
    data = yaml.safe_load(r.stdout)
except Exception as e:
    emit(True, [], 'yaml', 'unparseable: ' + str(e)[:2000])
ids = []
repos = data.get('repos') if isinstance(data, dict) else None
for repo in repos if isinstance(repos, list) else []:
    hooks = repo.get('hooks') if isinstance(repo, dict) else None
    for h in hooks if isinstance(hooks, list) else []:
        if isinstance(h, dict) and isinstance(h.get('id'), str):
            ids.append(h['id'])
emit(True, ids, 'yaml', None)
