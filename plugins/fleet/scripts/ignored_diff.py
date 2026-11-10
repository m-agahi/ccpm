
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
import hashlib, json, os, sys
# fleet 5.0.5 (ledger 2018): the ignored paths that differ between two hasher
# states. The hasher writes each state's full ignored map to a file and relays
# {count, sha256, settings, file}; the workflow stops on a digest or count
# change by itself and runs this program only for the stop text.
# args: <file a> <sha256 a> <count a> <file b> <sha256 b> <count b>
# Each file must hold a JSON object of string values whose entries but the
# fleet's settings file hash to the relayed sha256 and number the relayed
# count; else error names why and no path is listed (a missing or
# forged file never reads as "no change"). The settings file is left out: the
# workflow compares its hash inline. Prints {paths: the first CAP differing
# paths, sorted; total: how many differ (null on error); error; args}.
SETTINGS_LOCAL = '.claude/settings.local.json'
CAP = 20
MAX_BYTES = 64 << 20
args = sys.argv[1:]
os.chdir('/')

def canon(obj):
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')

def load(path, digest, count):
    try:
        with open(path, 'rb') as fh:
            data = fh.read(MAX_BYTES + 1)
    except OSError as e:
        raise ValueError('cannot read ' + path + ': ' + e.strerror)
    if len(data) > MAX_BYTES:
        raise ValueError(path + ' is over ' + str(MAX_BYTES) + ' bytes')
    try:
        m = json.loads(data)
    except ValueError:
        raise ValueError(path + ' is not JSON')
    if not isinstance(m, dict) or not all(isinstance(v, str) for v in m.values()):
        raise ValueError(path + ' is not a map of strings')
    rest = dict((k, v) for k, v in m.items() if k != SETTINGS_LOCAL)
    if hashlib.sha256(canon(rest)).hexdigest() != digest:
        raise ValueError(path + ' does not match its digest')
    if str(len(rest)) != count:
        raise ValueError(path + ' holds ' + str(len(rest)) + ' entries, not the count ' + count)
    return rest

out = {'paths': [], 'total': None, 'error': None, 'args': args}
try:
    if len(args) != 6:
        raise ValueError('need 6 arguments, got ' + str(len(args)))
    a = load(args[0], args[1], args[2])
    b = load(args[3], args[4], args[5])
    diff = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))
    out['paths'], out['total'] = diff[:CAP], len(diff)
except ValueError as e:
    out['error'] = str(e)
out['program'] = _PROG
out['digest'] = hashlib.sha256(canon(out)).hexdigest()
print(json.dumps(out, ensure_ascii=False))
