
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
import hashlib, json, os, re, sys
# fleet 5.0.7 (ledger 2020): the keys that differ between two hasher states,
# map by map. The hasher writes every map to <scratch>/hashes/<map>-<sha256
# of the file>.json and relays {count, sha256, file}; the workflow compares
# the summaries itself and runs this program only for a map whose summary
# changed, to route by key or to name the keys in a stop.
# args: <scratch> then one or more triples <map> <old> <new>, where <old> and
# <new> are the first 12 hex of a map file's sha256 (no agent types a 64-hex
# value). Each resolves to exactly one regular file
# <scratch>/hashes/<map>-<prefix><52 hex>.json; none or more than one exits
# non-zero. Each file must hold exactly the canonical JSON of a map of strings
# whose sha256 is the hex in its name; else error names why and no key is
# listed (a forged file never reads as "no change"). The ignored map's fleet
# settings file is left out (the workflow compares its hash inline). Prints
# {changed: the first CAP [map, key, kind] rows (kind added, removed or
# changed), sorted; total (null on error); counts: {map: [entries a, b]};
# resolved: {map: [full sha256 a, b]} (the workflow checks them against the
# summaries it holds); error; args}.
SETTINGS_LOCAL = '.claude/settings.local.json'
MAPS = ('files', 'sections', 'git', 'symlinks', 'ignored')
CAP = 50
MAX_BYTES = 64 << 20
args = sys.argv[1:]
os.chdir('/')

def canon(obj):
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')

def resolve(scratch, m, prefix):
    # exit, not error: a handle that names no file, or two, is a broken call
    if not re.match(r'^[0-9a-f]{12}$', prefix):
        sys.exit('handle is not 12 lowercase hex: ' + repr(prefix))
    d = os.path.join(scratch, 'hashes')
    if os.path.islink(scratch) or os.path.islink(d) or not os.path.isdir(d):
        sys.exit('no hashes dir (or a symlinked one) under ' + scratch)
    hits = sorted(n for n in os.listdir(d) if re.match(r'^' + m + '-' + prefix + r'[0-9a-f]{52}\.json$', n))
    if len(hits) != 1:
        sys.exit(str(len(hits)) + ' files match ' + m + '-' + prefix + '*.json in ' + d + ': need exactly one, so a missing state never reads as no change')
    p = os.path.join(d, hits[0])
    if os.path.islink(p) or not os.path.isfile(p):
        sys.exit('map file is not a regular file: ' + p)
    return p, hits[0][len(m) + 1:-5]

def load(m, path, hexname):
    try:
        with open(path, 'rb') as fh:
            data = fh.read(MAX_BYTES + 1)
    except OSError as e:
        raise ValueError('cannot read ' + path + ': ' + e.strerror)
    if len(data) > MAX_BYTES:
        raise ValueError(path + ' is over ' + str(MAX_BYTES) + ' bytes')
    if hashlib.sha256(data).hexdigest() != hexname:
        raise ValueError(path + ' does not match its sha256')
    try:
        d = json.loads(data)
    except ValueError:
        raise ValueError(path + ' is not JSON')
    if not isinstance(d, dict) or not all(isinstance(v, str) for v in d.values()):
        raise ValueError(path + ' is not a map of strings')
    if canon(d) != data:
        raise ValueError(path + ' is not canonical JSON')
    if m == 'ignored':
        d.pop(SETTINGS_LOCAL, None)
    return d

if len(args) < 4 or (len(args) - 1) % 3 or len(args) > 1 + 3 * len(MAPS) or not os.path.isabs(args[0]):
    sys.exit('need <absolute scratch> and 1 to 5 triples <map> <old> <new>, got ' + str(len(args)) + ' arguments')
scratch = args[0]
triples, seen = [], set()
for i in range(1, len(args), 3):
    m = args[i]
    if m not in MAPS or m in seen:
        sys.exit('unknown or repeated map ' + repr(m))
    seen.add(m)
    triples.append((m, resolve(scratch, m, args[i + 1]), resolve(scratch, m, args[i + 2])))
out = {'changed': [], 'total': None, 'counts': {}, 'error': None,
       'resolved': dict((m, [a[1], b[1]]) for m, a, b in triples), 'args': args}
try:
    rows = []
    for m, (pa, ha), (pb, hb) in triples:
        a, b = load(m, pa, ha), load(m, pb, hb)
        out['counts'][m] = [len(a), len(b)]
        for k in sorted(set(a) | set(b)):
            if a.get(k) != b.get(k):
                rows.append([m, k, 'added' if k not in a else 'removed' if k not in b else 'changed'])
    out['changed'], out['total'] = rows[:CAP], len(rows)
except ValueError as e:
    out['error'] = str(e)
    out['counts'] = {}
out['program'] = _PROG
out['digest'] = hashlib.sha256(canon(out)).hexdigest()
print(json.dumps(out, ensure_ascii=False))
