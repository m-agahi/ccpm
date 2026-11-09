
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
import hashlib, json, os, re, shutil, subprocess, sys, time
def lift():
    # podman (a Go binary) is not bound by this program's caps
    for k in (_r.RLIMIT_AS, _r.RLIMIT_CPU):
        _r.setrlimit(k, (_r.getrlimit(k)[1],) * 2)
# fleet 4.0.0 (1981): the only containers these programs touch
NAME = re.compile(r'fleet-db-[a-z0-9-]{1,80}')
def name_ok(n):
    return isinstance(n, str) and NAME.fullmatch(n) is not None and 'tf-local' not in n
def done(out):
    out['program'] = _PROG
    out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0)
def fail(code, msg):
    sys.stderr.write(msg + '\n')
    sys.exit(code)
PM = shutil.which('podman')
def pm(*a, timeout=120):
    return subprocess.run([PM] + list(a), capture_output=True, timeout=timeout, preexec_fn=lift)
def tail(r):
    return (r.stderr or b'').decode('utf-8', 'replace')[-400:]
# usage: db_down.py <name> <nonce>. Removes the container only when it
# carries fleet.db=1 and this run's fleet.nonce.
argv = sys.argv[1:]
if len(argv) != 2:
    fail(2, 'usage: db_down.py <name> <nonce>')
name, nonce = argv
if not name_ok(name):
    fail(2, 'container name refused: ' + name)
out = {'removed': False, 'absent': False, 'error': None, 'args': argv}
if not PM:
    out['error'] = 'no podman on PATH'
    done(out)
i = pm('container', 'inspect', name)
if i.returncode != 0:
    out['absent'] = True
    done(out)
try:
    info = json.loads(i.stdout.decode('utf-8'))
    labels = info[0]['Config']['Labels'] or {}
except (ValueError, LookupError, TypeError):
    labels = {}
if labels.get('fleet.db') != '1' or labels.get('fleet.nonce') != nonce:
    out['error'] = 'not this run\'s fleet test database (labels fleet.db, fleet.nonce)'
    done(out)
r = pm('rm', '-f', name)
if r.returncode == 0:
    out['removed'] = True
else:
    out['error'] = 'podman rm: ' + tail(r)
done(out)
