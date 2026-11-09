
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
import base64, hashlib, json, os, re, shutil, subprocess, sys
os.environ['GIT_CONFIG_NOSYSTEM'] = '1'
if len(sys.argv) != 7:
    sys.exit('usage: <worktree> <task id> <chunk dir> <n> <expected sha256> <chunk sha256 list>')
wt, target, cdir, n_arg, expected, shas_arg = sys.argv[1:]
if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', target):
    sys.exit('bad task id: ' + target)
if not re.fullmatch(r'[1-9][0-9]{0,2}', n_arg):
    sys.exit('bad chunk count: ' + n_arg)
n = int(n_arg)
if not re.fullmatch(r'[0-9a-f]{64}', expected):
    sys.exit('bad expected sha256: ' + expected)
try:
    shas = json.loads(shas_arg)
except ValueError:
    sys.exit('bad chunk sha256 list')
if not isinstance(shas, list) or len(shas) != n or any(not isinstance(e, dict) or e.get('i') != k or not isinstance(e.get('sha256'), str) or not re.fullmatch(r'[0-9a-f]{64}', e['sha256']) for k, e in enumerate(shas)):
    sys.exit('bad chunk sha256 list: ' + shas_arg[:200])
# the chunks live in a directory of the run's scratch dir (a sibling of the worktree)
scratch = os.path.realpath(os.path.join(os.path.dirname(os.path.realpath(wt)), 'scratch'))
real = os.path.realpath(cdir)
if not real.startswith(scratch + '/'):
    sys.exit('chunk dir ' + cdir + ' is not under ' + scratch)
bad, parts = [], []
for e in shas:
    p = os.path.join(real, '%d.b64' % e['i'])
    b = None
    try:
        if os.path.isfile(p) and not os.path.islink(p) and os.path.getsize(p) <= 8192:
            with open(p, 'rb') as f:
                b = f.read(8193)
    except OSError:
        b = None
    if b is None or len(b) > 8192 or hashlib.sha256(b).hexdigest() != e['sha256']:
        bad.append(e['i'])
    else:
        parts.append(b)
if bad:
    # exit 3: rewrite only these chunks; nothing was written
    print(json.dumps({'bad_chunks': bad}))
    sys.exit(3)
try:
    msg = base64.b64decode(b''.join(parts), validate=True)
except ValueError:
    sys.exit('the chunks do not decode as base64')
if hashlib.sha256(msg).hexdigest() != expected:
    sys.exit('the decoded message hashes ' + hashlib.sha256(msg).hexdigest() + ', not ' + expected)
# no hook runs (hooksPath /dev/null also stops reference-transaction)
G = ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', wt]
def git(*a, inp=None):
    r = subprocess.run(G + list(a), input=inp, capture_output=True)
    if r.returncode != 0:
        sys.exit(r.stderr.decode('utf-8', 'replace')[-2000:] or 'git ' + a[0] + ' failed')
    return r.stdout.decode().strip()
def has(ref):
    r = subprocess.run(G + ['rev-parse', '-q', '--verify', ref], capture_output=True)
    return r.stdout.decode().strip() if r.returncode == 0 else None
head = git('rev-parse', '--verify', 'HEAD^{commit}')
tag = git('mktag', inp=b'object ' + head.encode() + b'\ntype commit\ntag fleet-plan\ntagger fleet <fleet@localhost> 0 +0000\n\n' + msg)
ref = 'refs/fleet/' + target + '/plan'
old = has(ref)
if old and old != tag:
    # a different earlier value is kept as refs/fleet/<task id>/plan-<n>
    k = 1
    while has(ref + '-%d' % k):
        k += 1
    git('update-ref', ref + '-%d' % k, old)
git('update-ref', ref, tag)
shutil.rmtree(real, ignore_errors=True)
out = {'head': head, 'tag_sha': tag}
out['program'] = _PROG
out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
print(json.dumps(out, ensure_ascii=False))
