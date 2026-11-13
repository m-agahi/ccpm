
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
# fleet 6.0.0 (ledger 2033): the per-owner policy. Args: <host> <owner/repo>.
# Reads $XDG_CONFIG_HOME/fleet/policy.json (default ~/.config/fleet/policy.json),
# strict JSON: duplicate or unknown keys and wrong types are an error, never
# the default. First profile whose match.hosts (when listed) holds the host and
# whose match.owners holds the owner (fnmatch, any case) wins; its first
# repos glob that matches owner/repo overrides caps. No file or no match:
# the default caps. Prints {profile, file, policy_sha256, caps, matched, error,
# now, args, program, digest}; now (epoch seconds) starts the build's wall
# time (2044). Read only.
import fnmatch, hashlib, json, os, re, sys, time
args = sys.argv[1:]
if len(args) != 2 or not re.match(r'^[A-Za-z0-9._-]{1,255}$', args[0]) or not re.match(r'^[A-Za-z0-9._-]{1,100}(/[A-Za-z0-9._-]{1,100})+$', args[1]):
    sys.exit('usage: policy.py <host> <owner/repo>')
host, slug = args[0].lower(), args[1].lower()
owner = slug.split('/', 1)[0]
DEFAULT = {'pr_ready': True, 'ci_watch': True, 'ci_watch_minutes': 60, 'stats': True, 'merge': 'never', 'update_branch': 'never', 'ci_trigger': False, 'review_post': 'none'}
ENUMS = {'merge': ('never', 'auto'), 'update_branch': ('never', 'once'), 'review_post': ('none', 'own_pr')}
# 6.2.2 (2107, ADR-1237): a repos override may list the hook ids the fleet runs
# on the writers' test files before the freeze; no list, no hook (not a default cap)
REPO_ONLY = ('pre_freeze_hooks',)
path = os.path.join(os.environ.get('XDG_CONFIG_HOME') or os.path.expanduser('~/.config'), 'fleet', 'policy.json')


class Bad(Exception):
    pass


def pairs(kv):
    d = {}
    for k, v in kv:
        if k in d:
            raise Bad('duplicate key ' + json.dumps(k))
        d[k] = v
    return d


def keys(o, allowed, at):
    if not isinstance(o, dict):
        raise Bad(at + ' must be an object')
    for k in o:
        if k not in allowed:
            raise Bad(at + ': unknown key ' + json.dumps(k))


def strs(v, at):
    if not isinstance(v, list) or not v or any(not isinstance(x, str) or not x for x in v):
        raise Bad(at + ' must be a non-empty list of strings')
    return [x.lower() for x in v]


def caps_of(o, at):
    c = {}
    for k, v in o.items():
        if k == 'pre_freeze_hooks':
            if not isinstance(v, list) or any(not isinstance(x, str) or not x or len(x) > 128 or x.startswith('-') or re.search(r'[\s\x00-\x1f\x7f]', x) for x in v):
                raise Bad(at + '.pre_freeze_hooks must be a list of hook ids (non-empty strings, no whitespace, no leading -, at most 128 characters)')
            c[k] = list(v)
            continue
        if k not in DEFAULT:
            continue
        if k in ENUMS:
            ok = v in ENUMS[k]
        elif k == 'ci_watch_minutes':
            ok = isinstance(v, int) and not isinstance(v, bool) and 1 <= v <= 600
        else:
            ok = isinstance(v, bool)
        if not ok:
            raise Bad(at + '.' + k + ' must be ' + ('one of ' + '|'.join(ENUMS[k]) if k in ENUMS else 'an integer 1-600' if k == 'ci_watch_minutes' else 'true or false'))
        c[k] = v
    return c


out = {'profile': None, 'file': path, 'policy_sha256': None, 'caps': dict(DEFAULT), 'matched': 'no policy file', 'error': None}
try:
    if os.path.exists(path):
        if not os.path.isfile(path) or os.path.getsize(path) > 65536:
            raise Bad('not a regular file of at most 64 KiB')
        with open(path, 'rb') as f:
            raw = f.read(65537)
        out['policy_sha256'] = hashlib.sha256(raw).hexdigest()
        try:
            doc = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs)
        except ValueError as e:
            raise Bad('not valid JSON: ' + str(e)[:200])
        keys(doc, ('version', 'profiles'), 'policy')
        if doc.get('version') != 1:
            raise Bad('version must be 1')
        if not isinstance(doc.get('profiles'), list):
            raise Bad('profiles must be a list')
        hit = None
        for i, p in enumerate(doc['profiles']):
            at = 'profiles[%d]' % i
            keys(p, ('name', 'match', 'repos') + tuple(DEFAULT), at)
            if not isinstance(p.get('name'), str) or not p['name']:
                raise Bad(at + '.name must be a non-empty string')
            m = p.get('match')
            keys(m, ('hosts', 'owners'), at + '.match')
            owners = strs(m.get('owners'), at + '.match.owners')
            hosts = strs(m['hosts'], at + '.match.hosts') if 'hosts' in m else None
            caps = caps_of(p, at)
            repos = p.get('repos', {})
            if not isinstance(repos, dict):
                raise Bad(at + '.repos must be an object')
            over = []
            for g, rc in repos.items():
                ra = at + '.repos[' + json.dumps(g) + ']'
                keys(rc, tuple(DEFAULT) + REPO_ONLY, ra)
                over.append((g, caps_of(rc, ra)))
            if hit is None and (hosts is None or host in hosts) and any(fnmatch.fnmatchcase(owner, o) for o in owners):
                hit = (p['name'], caps, over)
        if hit is None:
            out['matched'] = 'no profile matches ' + host + ' ' + slug
        else:
            out['profile'], out['matched'] = hit[0], 'profile ' + hit[0]
            out['caps'].update(hit[1])
            for g, rc in hit[2]:
                if fnmatch.fnmatchcase(slug, g.lower()):
                    out['caps'].update(rc)
                    out['matched'] += ', repos[' + json.dumps(g) + ']'
                    break
except (Bad, OSError, UnicodeDecodeError) as e:
    # 6.3.0: an invalid file is the strict default (no pre_freeze_hooks list), with the error
    out.update(profile=None, caps=dict(DEFAULT), matched=None, error='policy file ' + path + ': ' + str(e))
out['now'] = int(time.time())
out['args'] = args
out['program'] = _PROG
out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
print(json.dumps(out, ensure_ascii=False))
