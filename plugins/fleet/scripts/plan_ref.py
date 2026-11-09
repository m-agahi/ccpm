
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
if len(sys.argv) != 4:
    sys.exit('usage: <worktree> <task id> meta|chunks:<plan ref name>')
# mode: 'meta' (no content) or 'chunks:<plan ref name>' (no content in the
# entries; that ref's message as 'chunks' of <= 1000 chars). No mode prints
# message text whole (3.0.0, ledger 1952).
wt, tid, mode = sys.argv[1], sys.argv[2], sys.argv[3]
if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', tid):
    sys.exit('bad task id: ' + tid)
G = ['git', '-c', 'core.fsmonitor=false', '-C', wt]
def run(*a):
    return subprocess.run(G + list(a), capture_output=True)
pre = 'refs/fleet/' + tid + '/'
name_re = re.compile(re.escape(pre) + r'plan(-[0-9]+)?')
fe = run('for-each-ref', '--format=%(refname)', pre)
if fe.returncode != 0:
    sys.exit(fe.stderr.decode('utf-8', 'replace'))
out = []
for name in fe.stdout.decode().splitlines():
    if not name_re.fullmatch(name):
        continue
    e = {'name': name, 'tag_sha': '', 'type': '', 'target': '', 'target_type': '', 'sha256': None, 'content': None}
    e['tag_sha'] = run('rev-parse', '-q', '--verify', name).stdout.decode().strip()
    if e['tag_sha']:
        e['type'] = run('cat-file', '-t', e['tag_sha']).stdout.decode().strip()
    if e['type'] == 'tag':
        raw = run('cat-file', 'tag', e['tag_sha']).stdout
        hdr, sep, msg = raw.partition(b'\n\n')
        for line in hdr.decode('utf-8', 'replace').splitlines():
            if line.startswith('object '):
                e['target'] = line[7:]
            elif line.startswith('type '):
                e['target_type'] = line[5:]
        if sep:
            e['sha256'] = hashlib.sha256(msg).hexdigest()
            try:
                e['content'] = msg.decode('utf-8')
            except UnicodeDecodeError:
                e['content'] = None
    out.append(e)
out.sort(key=lambda x: x['name'])
res = {'refs': out}
want = None
if mode.startswith('chunks:'):
    want = mode[len('chunks:'):]
    if not name_re.fullmatch(want):
        sys.exit('bad chunks ref: ' + want)
elif mode != 'meta':
    sys.exit('bad mode: ' + mode)
for e in out:
    c = e.pop('content')
    if want is not None and e['name'] == want and c is not None:
        res['chunks'] = [c[i:i + 1000] for i in range(0, len(c), 1000)]
res['program'] = _PROG
print(json.dumps(res, ensure_ascii=False))
