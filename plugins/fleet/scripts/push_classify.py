
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
path, code = sys.argv[1], int(sys.argv[2])
os.chdir('/')
with open(path, 'rb') as fh:
    # bounded: git's own lines come last, so the last 1 MiB is read
    fh.seek(max(0, os.fstat(fh.fileno()).st_size - (1 << 20)))
    lines = fh.read(1 << 20).decode('utf-8', 'replace').splitlines()
own = [x for x in lines if x.startswith(('error:', 'fatal:', ' ! ['))]
def has(p):
    return any(x.startswith(p) for x in own)
tail = ''
if code == 0:
    res = 'ok'
elif has(' ! [rejected]'):
    res = 'non_ff'
elif has(' ! [remote rejected]'):
    res = 'remote_rejected'
elif has('error: failed to push some refs'):
    # git-lfs runs as a pre-push hook and prints its own transport errors
    lfs = any(re.match(r'(batch (request|response):|LFS: )', x) for x in lines)
    if code != 1 or has(' ! [') or has('fatal:') or has('error: RPC failed') or lfs:
        res = 'ambiguous'
    else:
        res = 'hook_rejected'
        tail = '\n'.join(lines[-60:])
else:
    res = 'network'
out = {'push_result': res, 'exit_code': code, 'hook_tail': tail, 'args': [path, sys.argv[2]]}
out['program'] = _PROG
out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
print(json.dumps(out, ensure_ascii=False))
