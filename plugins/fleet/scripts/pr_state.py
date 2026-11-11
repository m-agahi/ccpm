
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
# fleet 6.0.0 (ledgers 2045, 2034): state changes of the fleet's own PR, one
# mode per call; gh runs with -R from / (never inside a checkout).
#   ready <gh> <owner/repo> <pr> <sha>: `gh pr ready` when the PR is an open
#     draft whose head is <sha>; re-read. Prints {mode, was_draft, is_draft,
#     head, state, error, args, program, digest}.
import hashlib, json, os, re, subprocess, sys
args = sys.argv[1:]
SLUG = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,99}/[A-Za-z0-9._-]{1,100}$')
SHA = re.compile(r'^[0-9a-f]{40}$')
mode = args[0] if args else None


def bad():
    sys.exit('usage: pr_state.py ready <gh|gh-personal> <owner/repo> <pr> <sha>')


if mode == 'ready':
    if len(args) != 5 or args[1] not in ('gh', 'gh-personal') or not SLUG.match(args[2]) or not re.match(r'^[1-9][0-9]{0,9}$', args[3]) or not SHA.match(args[4]):
        bad()
else:
    bad()
os.chdir('/')
for k, v in (('GH_PROMPT_DISABLED', '1'), ('NO_COLOR', '1'), ('GH_NO_UPDATE_NOTIFIER', '1')):
    os.environ[k] = v
gh, slug, pr = args[1], args[2], args[3]


class Fail(Exception):
    pass


def run(*a, timeout=120):
    r = subprocess.run([gh] + list(a), capture_output=True, timeout=timeout)
    if r.returncode != 0:
        raise Fail('gh ' + ' '.join(a[:2]) + ': ' + r.stderr.decode('utf-8', 'replace').strip()[-500:])
    return r.stdout.decode('utf-8', 'replace')


def view(fields):
    return json.loads(run('pr', 'view', pr, '-R', slug, '--json', fields))


out = {'mode': mode}
try:
    if mode == 'ready':
        sha = args[4]
        out.update(was_draft=None, is_draft=None, head=None, state=None, error=None)
        v = view('isDraft,headRefOid,state')
        out.update(was_draft=v.get('isDraft'), is_draft=v.get('isDraft'), head=v.get('headRefOid'), state=v.get('state'))
        if v.get('state') != 'OPEN':
            raise Fail('the PR is ' + str(v.get('state')) + ', not OPEN')
        if v.get('headRefOid') != sha:
            raise Fail('the PR head is ' + str(v.get('headRefOid')) + ', not ' + sha + '; not marked ready')
        if v.get('isDraft'):
            run('pr', 'ready', pr, '-R', slug)
            w = view('isDraft,headRefOid,state')
            out.update(is_draft=w.get('isDraft'), head=w.get('headRefOid'), state=w.get('state'))
except (Fail, ValueError, OSError, subprocess.SubprocessError) as e:
    out['error'] = str(e)[:600]
out['args'] = args
out['program'] = _PROG
out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
print(json.dumps(out, ensure_ascii=False))
