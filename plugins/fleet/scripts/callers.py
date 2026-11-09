
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
import hashlib, json, os, subprocess, sys
os.environ['GIT_CONFIG_NOSYSTEM'] = '1'
wt, plan_path, syms, cap = sys.argv[1], sys.argv[2], json.loads(sys.argv[3]), int(sys.argv[4])
G = ['git', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-C', wt]
occ = {}
capped = []
for s in syms:
    r = subprocess.run(G + ['grep', '-n', '-z', '-I', '-w', '-F', '--full-name', '--no-color', '-e', s, '--', '.', ':(exclude,literal)' + plan_path], capture_output=True)
    if r.returncode not in (0, 1):
        sys.exit(r.stderr.decode('utf-8', 'replace'))
    hits = set()
    for rec in r.stdout.split(b'\n'):
        if not rec:
            continue
        parts = rec.split(b'\0', 2)
        if len(parts) != 3 or not parts[1].isdigit():
            sys.exit('unparseable git grep output: ' + repr(rec[:200]))
        hits.add(parts[0].decode('utf-8', 'replace') + ':' + str(int(parts[1])))
    if len(hits) > cap:
        capped.append(s)
        occ[s] = []
    else:
        occ[s] = sorted(hits)
out = {'occurrences': occ, 'capped': sorted(capped)}
out['program'] = _PROG
out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
print(json.dumps(out, sort_keys=True, ensure_ascii=False))
