
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
# fleet 5.0.9 (ledger 2032): the yaadgaar project of the session, derived from
# the directory this program runs in (the session's start directory) by the
# yaadgaar client's rule (yadgar-client src/project.rs derive): the first
# .yadgar/project-id walking up wins unless empty; else remote.origin.url of
# the repository root, insteadOf applied to a fixed point, scheme and host
# stripped, trailing slashes, one .git and trailing slashes stripped,
# lowercased. No args. project is null when nothing resolves.
import hashlib, json, os, subprocess, sys
cwd = os.path.realpath(os.getcwd())
os.environ['GIT_TERMINAL_PROMPT'] = '0'
def git(args, at, hard=False):
    env = dict(os.environ)
    pre = []
    if hard:
        pre = ['-c', 'protocol.allow=never', '-c', 'protocol.file.allow=never', '-c', 'uploadpack.allowFilter=false']
        env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_SYSTEM='/dev/null')
    try:
        r = subprocess.run(['git', '-c', 'core.fsmonitor='] + pre + (['-C', at] if at else []) + args, capture_output=True, timeout=60, env=env, cwd=cwd)
    except Exception:
        return None
    t = r.stdout.decode('utf-8', 'replace').strip() if r.returncode == 0 else ''
    return t or None
def id_file(start):
    d = start
    while True:
        f = os.path.join(d, '.yadgar', 'project-id')
        if os.path.isfile(f):
            with open(f, 'rb') as fh:
                return fh.read(4096).decode('utf-8').strip()
        up = os.path.dirname(d)
        if up == d:
            return None
        d = up
def norm(url):
    s = url.strip()
    sch, sep, rest = s.partition('://')
    if sep and sch[:1].isalpha() and all(c.isalnum() or c in '+.-' for c in sch):
        s = rest.split('/', 1)[1] if '/' in rest else rest
    elif ':' in s:
        p = s[:s.index(':')]
        u, at, h = p.partition('@')
        if p and '/' not in p and not (at and (not u or not h or '@' in h)):
            s = s[len(p) + 1:]
    s = s.rstrip('/')
    if s.endswith('.git'):
        s = s[:-4]
    return s.rstrip('/').lower()
source = None
key = id_file(cwd)
if key:
    source = 'project-id'
else:
    root = git(['rev-parse', '--show-toplevel'], cwd, True) or cwd
    url = git(['config', 'remote.origin.url'], root)
    if url:
        rules = {}
        for line in (git(['config', '--get-regexp', r'^url\..*\.insteadof$'], None) or '').splitlines():
            k, sp, v = line.partition(' ')
            k = k.lower()
            if sp and k.startswith('url.') and k.endswith('.insteadof') and len(k) > 14:
                rules[k[4:-10]] = v
        for _ in range(64):
            for t in sorted(rules):
                if url.startswith(rules[t]) and url != t:
                    url = t + url[len(rules[t]):]
                    break
            else:
                break
        key = norm(url)
        source = 'origin'
out = {'project': key or None, 'source': source if key else None, 'cwd': cwd, 'args': sys.argv[1:]}
out['program'] = _PROG
out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
print(json.dumps(out, ensure_ascii=False))
