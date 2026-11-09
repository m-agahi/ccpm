
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
wt, default, tid, kinds = sys.argv[1], sys.argv[2], sys.argv[3], json.loads(sys.argv[4])
if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', tid):
    sys.exit('bad task id: ' + tid)
G = ['git', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-C', wt]
def run(*a, check=True):
    r = subprocess.run(G + list(a), capture_output=True)
    if check and r.returncode != 0:
        sys.exit(r.stderr.decode('utf-8', 'replace'))
    return r
def names(b):
    return [x.decode('utf-8', 'replace') for x in b.split(b'\0') if x]
def canon(v):
    return json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
def sha(t):
    return hashlib.sha256(t.encode('utf-8')).hexdigest()
def norm(p):
    s = str(p).strip()
    while s.startswith('./'):
        s = s[2:]
    return s.rstrip('/')
def nonempty(o, k):
    return isinstance(o.get(k), str) and o.get(k) != ''
def brief_ok(b):
    if not isinstance(b, dict) or not isinstance(b.get('title'), str) or not b['title'].strip():
        return False
    src = b.get('sources')
    if not isinstance(src, list) or not src:
        return False
    for x in src:
        if not isinstance(x, dict) or x.get('kind') not in kinds or not nonempty(x, 'ref'):
            return False
    repo = b.get('repo')
    if not isinstance(repo, str) or not repo.rstrip('/').startswith('/'):
        return False
    pp = b.get('plan_path')
    if pp is not None:
        if not isinstance(pp, str) or not norm(pp) or pp.startswith('/') or '..' in norm(pp).split('/'):
            return False
    return True
def ref_ok(r):
    if not isinstance(r, dict) or not isinstance(r.get('seal'), str):
        return False
    o = dict(r)
    del o['seal']
    if r['seal'] != sha(canon(o)):
        return False
    if not all(nonempty(r, k) for k in ('branch', 'plan_path', 'plan_sha256', 'task_id', 'slug', 'tldr')):
        return False
    if not re.fullmatch(r'[0-9a-f]{64}', r['plan_sha256']) or not isinstance(r.get('criteria'), list):
        return False
    if not brief_ok(r.get('brief')) or r['branch'] != 'fleet/' + r['task_id'] + '-' + r['slug']:
        return False
    h = r.get('history')
    if not isinstance(h, (dict, list)):
        return False
    # 4.0.0: the sealed project and the optional history.preflight record
    if 'project' in r and r['project'] is not None and not (isinstance(r['project'], str) and r['project']):
        return False
    p = h.get('preflight') if isinstance(h, dict) else None
    if p is None:
        return True
    if not isinstance(p, dict) or not (isinstance(p.get('fleet_version'), str) and p['fleet_version']):
        return False
    return all(isinstance(p.get(k), dict) for k in ('versions', 'dispatch', 'contract'))
base = 'refs/remotes/origin/' + default
commits = []
for line in run('log', '--format=%H%x00%s', base + '..HEAD').stdout.decode('utf-8', 'replace').splitlines():
    c, _, subj = line.partition('\0')
    files = names(run('diff-tree', '-r', '-m', '--root', '--no-commit-id', '--name-only', '-z', '--no-renames', c).stdout)
    commits.append({'sha': c, 'subject': subj, 'files': sorted(set(files))})
pre = 'refs/fleet/' + tid + '/'
name_re = re.compile(re.escape(pre) + r'plan(-[0-9]+)?')
refs = []
for name in run('for-each-ref', '--format=%(refname)', pre).stdout.decode().splitlines():
    if not name_re.fullmatch(name):
        continue
    e = {'name': name, 'tag_sha': '', 'type': '', 'target': '', 'target_type': '', 'sha256': None, 'task_id': None, 'plan_path': None, 'ref_ok': False}
    e['tag_sha'] = run('rev-parse', '-q', '--verify', name, check=False).stdout.decode().strip()
    if e['tag_sha']:
        e['type'] = run('cat-file', '-t', e['tag_sha'], check=False).stdout.decode().strip()
    if e['type'] == 'tag':
        raw = run('cat-file', 'tag', e['tag_sha']).stdout
        hdr, sep, msg = raw.partition(b'\n\n')
        for h in hdr.decode('utf-8', 'replace').splitlines():
            if h.startswith('object '):
                e['target'] = h[7:]
            elif h.startswith('type '):
                e['target_type'] = h[5:]
        if sep:
            e['sha256'] = hashlib.sha256(msg).hexdigest()
            try:
                r = json.loads(msg.decode('utf-8'))
                e['ref_ok'] = ref_ok(r) and bool(re.fullmatch(r'[a-z0-9][a-z0-9-]*', r['task_id'])) \
                    and bool(re.fullmatch(r'[A-Za-z0-9._/-]+', r['plan_path']))
            except Exception:
                e['ref_ok'] = False
            # names only from a ref that passed every check
            if e['ref_ok']:
                e['task_id'], e['plan_path'] = r['task_id'], r['plan_path']
    refs.append(e)
refs.sort(key=lambda x: x['name'])
out = {'commits': commits, 'refs': refs}
out['program'] = _PROG
out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
print(json.dumps(out, ensure_ascii=False))
