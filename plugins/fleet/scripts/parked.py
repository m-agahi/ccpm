
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
import base64, hashlib, json, os, re, shutil, sys
NAME_RE = re.compile(r'[A-Za-z0-9_.:-]{1,64}')
CHUNK = 1000
CAP = 1 << 20
def emit(out):
    out['program'] = _PROG
    out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
    print(json.dumps(out, ensure_ascii=False))
def read_text(p):
    # a regular file (no symlink), at most CAP bytes of UTF-8, else None
    try:
        if os.path.islink(p) or not os.path.isfile(p) or os.path.getsize(p) > CAP:
            return None
        with open(p, 'rb') as f:
            b = f.read(CAP + 1)
        return b.decode('utf-8') if len(b) <= CAP else None
    except (OSError, UnicodeDecodeError):
        return None
def pieces(t):
    return [t[i:i + CHUNK] for i in range(0, len(t), CHUNK)]
mode = sys.argv[1] if len(sys.argv) > 1 else ''
if mode == 'read':
    # read <scratch> <plan tip time|null>: the newest parked/<run>/ folder
    # newer than the last plan commit (its newest file's mtime); parked/used/
    # and symlinks are skipped
    if len(sys.argv) != 4:
        sys.exit('usage: read <scratch> <plan tip time|null>')
    scratch, tip_arg = sys.argv[2], sys.argv[3]
    if tip_arg != 'null' and not re.fullmatch(r'[0-9]{1,12}', tip_arg):
        sys.exit('bad plan tip time: ' + tip_arg)
    tip = None if tip_arg == 'null' else int(tip_arg)
    root = os.path.join(scratch, 'parked')
    best = None
    if os.path.isdir(root) and not os.path.islink(root):
        for name in sorted(os.listdir(root)):
            d = os.path.join(root, name)
            if name == 'used' or not NAME_RE.fullmatch(name) or os.path.islink(d) or not os.path.isdir(d):
                continue
            files = []
            for dp, dns, fns in os.walk(d):
                dns[:] = sorted(x for x in dns if not os.path.islink(os.path.join(dp, x)))
                for fn in sorted(fns):
                    fp = os.path.join(dp, fn)
                    if not os.path.islink(fp) and os.path.isfile(fp):
                        files.append(os.path.relpath(fp, d))
            if not files:
                continue
            t = max(os.path.getmtime(os.path.join(d, f)) for f in files)
            if tip is not None and t <= tip:
                continue
            if best is None or (t, name) > (best[0], best[1]):
                best = (t, name, files)
    parked = None
    if best:
        t, name, files = best
        d = os.path.join(root, name)
        findings = read_text(os.path.join(d, 'findings.json')) if 'findings.json' in files else None
        pp = None
        if findings is not None:
            try:
                fj = json.loads(findings)
                pp = fj.get('plan_path') if isinstance(fj, dict) else None
            except ValueError:
                pp = None
        mds = [f for f in files if f.endswith('.md')]
        if not (isinstance(pp, str) and pp in mds):
            pp = mds[0] if len(mds) == 1 else None
        draft = read_text(os.path.join(d, pp)) if pp else None
        if draft is not None or findings is not None:
            parked = {'run': name, 'plan_path': pp if draft is not None else None,
                      'draft_chunks': pieces(draft) if draft is not None else [],
                      'findings_chunks': pieces(findings) if findings is not None else []}
    emit({'parked': parked, 'args': [scratch, tip_arg]})
elif mode == 'write':
    # write <scratch> <run> <chunk dir> <n> <expected sha256> <chunk sha256 list>:
    # parked/<run>/findings.json from checked base64 chunks (exit 3 + bad_chunks)
    if len(sys.argv) != 8:
        sys.exit('usage: write <scratch> <run> <chunk dir> <n> <expected sha256> <chunk sha256 list>')
    scratch, run, cdir, n_arg, expected, shas_arg = sys.argv[2:]
    if not NAME_RE.fullmatch(run) or run == 'used':
        sys.exit('bad run name: ' + run)
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
    sreal = os.path.realpath(scratch)
    real = os.path.realpath(cdir)
    if not real.startswith(sreal + '/'):
        sys.exit('chunk dir ' + cdir + ' is not under ' + sreal)
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
        print(json.dumps({'bad_chunks': bad}))
        sys.exit(3)
    try:
        msg = base64.b64decode(b''.join(parts), validate=True)
    except ValueError:
        sys.exit('the chunks do not decode as base64')
    if hashlib.sha256(msg).hexdigest() != expected:
        sys.exit('the decoded findings hash ' + hashlib.sha256(msg).hexdigest() + ', not ' + expected)
    folder = os.path.join(sreal, 'parked', run)
    os.makedirs(folder, exist_ok=True)
    dest = os.path.join(folder, 'findings.json')
    if os.path.islink(dest) or os.path.islink(folder):
        sys.exit('refusing a symlink at ' + dest)
    with open(dest, 'wb') as f:
        f.write(msg)
    shutil.rmtree(real, ignore_errors=True)
    emit({'written': dest, 'sha256': expected, 'args': [scratch, run]})
elif mode == 'park':
    # fleet 5.0.2 (ledger 2004): park <worktree> <plan path> <scratch> <run>:
    # move the stopped run's draft plan to <scratch>/parked/<run>/<plan path>
    # and leave the worktree as HEAD has it, with fixed git arguments and no
    # shell. Any dirty path other than the plan stops before a change (dirty).
    import subprocess
    if len(sys.argv) != 6:
        sys.exit('usage: park <worktree> <plan path> <scratch> <run>')
    wt, plan, scratch, run = sys.argv[2:]
    parts = plan.split('/')
    if not plan or plan.startswith('/') or '\0' in plan or any(p in ('', '.', '..') for p in parts):
        sys.exit('bad plan path: ' + plan)
    if not NAME_RE.fullmatch(run) or run == 'used':
        sys.exit('bad run name: ' + run)
    G = ['git', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-C', wt]
    def git(*a, ok=(0,)):
        r = subprocess.run(G + list(a), capture_output=True)
        if r.returncode not in ok:
            sys.exit('git ' + ' '.join(a) + ': ' + r.stderr.decode('utf-8', 'replace'))
        return r
    def dirty():
        recs = git('status', '--porcelain', '-z', '--untracked-files=all').stdout.split(b'\0')
        out, i = [], 0
        while i < len(recs):
            rec = recs[i].decode('utf-8', 'replace')
            i += 1
            if not rec:
                continue
            out.append(rec[3:])
            if rec[0] in 'RC':
                i += 1  # a rename's source path follows
        return out
    args = [wt, plan, scratch, run]
    now = dirty()
    if not now:
        emit({'target': None, 'clean': True, 'dirty': [], 'args': args})
        sys.exit(0)
    other = sorted(p for p in set(now) if p != plan)
    if other:
        emit({'target': None, 'clean': False, 'dirty': other, 'args': args})
        sys.exit(0)
    src = os.path.join(wt, plan)
    dest = os.path.join(scratch, 'parked', run, plan)
    target = None
    if os.path.islink(src):
        sys.exit('refusing a symlink at ' + src)
    if os.path.isfile(src):
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if os.path.islink(dest):
            sys.exit('refusing a symlink at ' + dest)
        shutil.copy2(src, dest)
        target = dest
    spec = ':(literal)' + plan
    if git('cat-file', '-e', 'HEAD:' + plan, ok=(0, 1, 128)).returncode == 0:
        git('restore', '--staged', '--worktree', '--source=HEAD', '--', spec)
    else:
        git('rm', '-q', '--cached', '--ignore-unmatch', '--', spec)
        if os.path.lexists(src):
            os.unlink(src)
    emit({'target': target, 'clean': not dirty(), 'dirty': [], 'args': args})
else:
    sys.exit('usage: read <scratch> <tip> | write <scratch> <run> <chunk dir> <n> <expected> <shas> | park <worktree> <plan path> <scratch> <run>')
