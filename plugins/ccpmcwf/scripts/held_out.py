
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
# fleet 8.0.0 (G3, ADR-1152): the held-out store. It keeps the planner's held-out examples out of the
# worktree, the plan ref and every role prompt; it blocks casual reads only (roles have a shell).
#   write <worktree> <task id> <plan_path> <plan_sha256> <chunk dir> <n> <expected sha256> <chunk sha256 list>
#     The payload {examples, visible (one examples list per criterion), ids (the criterion ids)} is in base64 chunk files under the
#     run's scratch dir; the dir is removed on every exit. An example for an id not in ids, one whose when and then both appear verbatim in the plan doc, or
#     whose given, when and then equal a visible example's, is dropped. The rest go to
#     $XDG_CONFIG_HOME/fleet/held-out/<task id>/<plan_sha256>.json (dir 0700, file 0600, a random salt).
#     Prints {sha256 (of the file bytes; null: nothing kept), count, per_criterion, dropped, args}.
#   show <task id> <plan_sha256> <sealed sha256>: the examples, only when the file hashes to the seal.
#     Prints {examples, sha256, store_digest (8.2.4: the same value as sha256, the key the runner relays), args, program, digest (of the output; never the store hash)}.
# No example text ever reaches stdout or stderr in write mode: dropped holds criterion and index only.
import atexit, base64, hashlib, json, os, re, secrets, shutil, sys
ARGC = {'write': 9, 'show': 4}
a = sys.argv[1:]
if not a or a[0] not in ARGC or len(a) != ARGC[a[0]]:
    sys.exit('usage: write <worktree> <task id> <plan_path> <plan_sha256> <chunk dir> <n> <expected sha256> <chunk sha256 list> | show <task id> <plan_sha256> <sealed sha256>')
mode = a[0]
if mode == 'write':
    # the chunks live in a directory of the run's scratch dir (a sibling of the worktree); only that dir
    # is removed, on every exit once it is proven under scratch (car F, A-L10: the early refusals too)
    wt, plan_path, cdir, n_arg, expected, shas_arg = a[1], a[3], a[5], a[6], a[7], a[8]
    scratch = os.path.realpath(os.path.join(os.path.dirname(os.path.realpath(wt)), 'scratch'))
    real = os.path.realpath(cdir)
    if not real.startswith(scratch + '/'):
        sys.exit('the chunk dir is not under the run scratch dir')
    atexit.register(shutil.rmtree, real, True)
HEX = re.compile(r'[0-9a-f]{64}')
CID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,31}')
task, psha = (a[2], a[4]) if mode == 'write' else (a[1], a[2])
if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', task):
    sys.exit('bad task id')
if not HEX.fullmatch(psha):
    sys.exit('bad plan_sha256')
def store_dir():
    # as policy_init: a relative XDG_CONFIG_HOME would resolve against the cwd
    x = os.environ.get('XDG_CONFIG_HOME')
    if x and not os.path.isabs(x):
        sys.exit('XDG_CONFIG_HOME is relative; set it to an absolute path or unset it')
    return os.path.join(x or os.path.expanduser('~/.config'), 'fleet', 'held-out', task)
def done(out):
    out['program'] = _PROG
    out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
    print(json.dumps(out, ensure_ascii=False))
if mode == 'show':
    sealed = a[3]
    if not HEX.fullmatch(sealed):
        sys.exit('bad sealed sha256')
    try:
        fd = os.open(os.path.join(store_dir(), psha + '.json'), os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        sys.exit('store file missing on this machine')
    except OSError:
        sys.exit('store file unreadable')
    with os.fdopen(fd, 'rb') as f:
        b = f.read(1 << 22)
    if hashlib.sha256(b).hexdigest() != sealed:
        sys.exit('the store file does not match the sealed sha256')
    d = json.loads(b.decode('utf-8'))
    if d.get('task_id') != task or d.get('plan_sha256') != psha or not isinstance(d.get('examples'), list):
        sys.exit('the store file is not this plan\'s')
    done({'examples': d['examples'], 'sha256': sealed, 'store_digest': sealed, 'args': a[1:]})
    sys.exit(0)
def write():
    if not re.fullmatch(r'[1-9][0-9]?', n_arg) or not HEX.fullmatch(expected):
        sys.exit('bad chunk count or expected sha256')
    try:
        shas = json.loads(shas_arg)
    except ValueError:
        shas = None
    if not isinstance(shas, list) or len(shas) != int(n_arg) or any(not isinstance(e, dict) or e.get('i') != k or not isinstance(e.get('sha256'), str) or not HEX.fullmatch(e['sha256']) for k, e in enumerate(shas)):
        sys.exit('bad chunk sha256 list')
    parts = []
    for e in shas:
        p = os.path.join(real, '%d.b64' % e['i'])
        try:
            with open(p, 'rb') as f:
                b = f.read(8193) if os.path.isfile(p) and not os.path.islink(p) else None
        except OSError:
            b = None
        if b is None or len(b) > 8192 or hashlib.sha256(b).hexdigest() != e['sha256']:
            sys.exit('chunk %d does not hash to its sha256' % e['i'])
        parts.append(b)
    try:
        msg = base64.b64decode(b''.join(parts), validate=True)
        pl = json.loads(msg.decode('utf-8')) if hashlib.sha256(msg).hexdigest() == expected else None
    except ValueError:
        pl = None
    if not isinstance(pl, dict) or not isinstance(pl.get('examples'), list) or not isinstance(pl.get('visible'), list):
        sys.exit('the payload is not {examples, visible} with the expected sha256')
    # the plan doc that gets sealed: <wt>/<plan_path>, no '..' or symlinked component, hashing to plan_sha256
    if not re.fullmatch(r'[A-Za-z0-9._/-]+', plan_path) or plan_path.startswith('/') or '..' in plan_path.split('/'):
        sys.exit('bad plan_path')
    cur = os.path.realpath(wt)
    for part in plan_path.split('/'):
        cur = os.path.join(cur, part)
        if os.path.islink(cur):
            sys.exit('bad plan_path')
    try:
        with open(cur, 'rb') as f:
            doc = f.read(1 << 24)
    except OSError:
        sys.exit('no plan doc at plan_path')
    if hashlib.sha256(doc).hexdigest() != psha:
        sys.exit('the plan doc does not hash to plan_sha256')
    doc = doc.decode('utf-8', 'replace')
    gwt = ('given', 'when', 'then')
    # visible: each criterion's examples list, as the plan holds it
    seen = [tuple(v.get(k) for k in gwt) for x in pl['visible'] if isinstance(x, list) for v in x if isinstance(v, dict)]
    # car F (A-L9): ids, the plan's criterion ids; an example for another id could never run
    ids = pl.get('ids')
    kept, dropped, per = [], [], {}
    for i, e in enumerate(pl['examples']):
        cid = e.get('criterion_id') if isinstance(e, dict) else None
        cid = cid if isinstance(cid, str) and CID.fullmatch(cid) else None
        why = None
        if cid is None or not all(isinstance(e.get(k), str) for k in gwt) or not e['when'] or not e['then']:
            why = 'malformed'
        elif isinstance(ids, list) and cid not in ids:
            why = 'unknown criterion'
        elif e['when'] in doc and e['then'] in doc:
            why = 'in the plan doc'
        elif tuple(e[k] for k in gwt) in seen:
            why = 'equals a visible example'
        if why:
            dropped.append({'criterion': cid, 'index': i, 'why': why})
            continue
        kept.append({'criterion_id': cid, 'given': e['given'], 'when': e['when'], 'then': e['then']})
        per[cid] = per.get(cid, 0) + 1
    sha = None
    if kept:
        d = store_dir()
        os.makedirs(os.path.dirname(os.path.dirname(d)), mode=0o700, exist_ok=True)
        for p in (os.path.dirname(d), d):
            try:
                os.mkdir(p, 0o700)
            except FileExistsError:
                pass
            if os.path.islink(p) or not os.path.isdir(p):
                sys.exit('the store dir is not a plain directory')
            os.chmod(p, 0o700)
        body = json.dumps({'salt': secrets.token_hex(16), 'task_id': task, 'plan_sha256': psha, 'examples': kept}, ensure_ascii=False, sort_keys=True).encode('utf-8')
        tmp = os.path.join(d, '.' + psha + '.' + secrets.token_hex(8) + '.tmp')
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as f:
            os.fchmod(f.fileno(), 0o600)
            f.write(body)
        os.replace(tmp, os.path.join(d, psha + '.json'))
        sha = hashlib.sha256(body).hexdigest()
    done({'sha256': sha, 'count': len(kept), 'per_criterion': per, 'dropped': dropped, 'args': a[1:]})
write()
