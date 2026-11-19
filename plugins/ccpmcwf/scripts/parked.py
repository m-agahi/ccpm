
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
PART = 8000
def files_of(d):
    files = []
    for dp, dns, fns in os.walk(d):
        dns[:] = sorted(x for x in dns if not os.path.islink(os.path.join(dp, x)))
        for fn in sorted(fns):
            fp = os.path.join(dp, fn)
            if not os.path.islink(fp) and os.path.isfile(fp):
                files.append(os.path.relpath(fp, d))
    return files
def payload(d, files):
    # 7.3.0 (#42): (plan path, canonical JSON {draft, findings}) of a parked
    # run folder, or None; the on-disk layout is 7.2.0's
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
    if draft is None and findings is None:
        return None
    return (pp if draft is not None else None), json.dumps({'draft': draft, 'findings': findings}, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
mode = sys.argv[1] if len(sys.argv) > 1 else ''
if mode == 'read':
    # read <scratch> <plan tip time|null>: the newest parked/<run>/ folder
    # newer than the last plan commit (its newest file's mtime); parked/used/
    # and symlinks are skipped. 7.3.0 (#42): the meta only (payload sha256 and
    # part count); read-part prints the payload
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
            files = files_of(d)
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
        pl = payload(os.path.join(root, name), files)
        if pl:
            parked = {'run': name, 'plan_path': pl[0], 'payload_sha256': hashlib.sha256(pl[1].encode('utf-8')).hexdigest(), 'part_count': max(1, -(-len(pl[1]) // PART))}
    emit({'parked': parked, 'args': [scratch, tip_arg]})
elif mode == 'read-part':
    # read-part <scratch> <run> <k>: part k of the run's payload, PART code
    # points as chunks of CHUNK, with {index, count, sha256 of the part}
    if len(sys.argv) != 5:
        sys.exit('usage: read-part <scratch> <run> <k>')
    scratch, run, k_arg = sys.argv[2:]
    if not NAME_RE.fullmatch(run) or run in ('used', '.', '..'):
        sys.exit('bad run name: ' + run)
    if not re.fullmatch(r'[0-9]{1,3}', k_arg):
        sys.exit('bad part number: ' + k_arg)
    d = os.path.join(scratch, 'parked', run)
    if os.path.islink(os.path.join(scratch, 'parked')) or os.path.islink(d) or not os.path.isdir(d):
        sys.exit('no parked run ' + run)
    pl = payload(d, files_of(d))
    if not pl:
        sys.exit('parked run ' + run + ' holds no draft or findings')
    k, count = int(k_arg), max(1, -(-len(pl[1]) // PART))
    if k >= count:
        sys.exit('part %d of %d' % (k, count))
    p = pl[1][k * PART:(k + 1) * PART]
    emit({'part': {'index': k, 'count': count, 'sha256': hashlib.sha256(p.encode('utf-8')).hexdigest()}, 'chunks': pieces(p), 'args': [scratch, run, k_arg]})
elif mode == 'write':
    # write <scratch> <run> <chunk dir> <n> <expected sha256> <chunk sha256 list>:
    # parked/<run>/findings.json from checked base64 chunks (exit 3 + bad_chunks)
    if len(sys.argv) != 8:
        sys.exit('usage: write <scratch> <run> <chunk dir> <n> <expected sha256> <chunk sha256 list>')
    scratch, run, cdir, n_arg, expected, shas_arg = sys.argv[2:]
    if not NAME_RE.fullmatch(run) or run in ('used', '.', '..'):
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
    if not NAME_RE.fullmatch(run) or run in ('used', '.', '..'):
        sys.exit('bad run name: ' + run)
    # 6.1.0 review B3: git status may write the index (post-index-change): no hook runs
    G = ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.quotePath=false', '-C', wt]
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
    # security review: no symlink is followed and nothing is read, written or
    # removed outside the worktree or <scratch>/parked/<run>/
    def inside(path, root):
        r = os.path.realpath(path)
        return r == root or r.startswith(root.rstrip('/') + '/')
    def real_dirs(root, rel, create):
        # each directory of rel under root: a real directory, never a symlink;
        # create: make the missing ones, one at a time
        cur = root
        for part in rel:
            cur = os.path.join(cur, part)
            if os.path.islink(cur):
                sys.exit('refusing a symlink at ' + cur)
            if not os.path.lexists(cur):
                if not create:
                    return
                os.mkdir(cur, 0o700)
            if not os.path.isdir(cur):
                sys.exit('not a directory: ' + cur)
    wreal = os.path.realpath(wt)
    real_dirs(wt, parts[:-1], False)
    src = os.path.join(wt, plan)
    if os.path.islink(src):
        sys.exit('refusing a symlink at ' + src)
    if not inside(os.path.dirname(src), wreal):
        sys.exit('plan path resolves outside the worktree: ' + src)
    now = dirty()
    if not now:
        emit({'target': None, 'clean': True, 'dirty': [], 'args': args})
        sys.exit(0)
    other = sorted(p for p in set(now) if p != plan)
    if other:
        emit({'target': None, 'clean': False, 'dirty': other, 'args': args})
        sys.exit(0)
    sreal = os.path.realpath(scratch)
    dest = os.path.join(sreal, 'parked', run, plan)
    target = None
    if os.path.isfile(src):
        real_dirs(sreal, ['parked', run] + parts[:-1], True)
        if not inside(os.path.dirname(dest), os.path.join(sreal, 'parked', run)):
            sys.exit('park destination resolves outside ' + os.path.join(sreal, 'parked', run) + ': ' + dest)
        # a re-park of the same run replaces the regular file it left; a
        # symlink or anything else there is refused
        if os.path.islink(dest):
            sys.exit('refusing a symlink at ' + dest)
        if os.path.lexists(dest):
            if not os.path.isfile(dest):
                sys.exit('not a regular file: ' + dest)
            os.unlink(dest)
        fi = os.open(src, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            st = os.fstat(fi)
            data = b''
            while True:
                b = os.read(fi, 1 << 16)
                if not b:
                    break
                data += b
        finally:
            os.close(fi)
        fo = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            os.write(fo, data)
        finally:
            os.close(fo)
        # the draft's own mtime, as cp -p kept it (the read mode compares mtimes)
        os.utime(dest, ns=(st.st_atime_ns, st.st_mtime_ns), follow_symlinks=False)
        target = dest
    spec = ':(literal)' + plan
    if git('cat-file', '-e', 'HEAD:' + plan, ok=(0, 1, 128)).returncode == 0:
        git('restore', '--staged', '--worktree', '--source=HEAD', '--', spec)
    else:
        git('rm', '-q', '--cached', '--ignore-unmatch', '--', spec)
        if os.path.lexists(src):
            os.unlink(src)
    emit({'target': target, 'clean': not dirty(), 'dirty': [], 'args': args})
elif mode == 'retire' and len(sys.argv) == 4:
    # fleet 7.3.0 (#9): retire <dir> <used>: move the used parked run folder <dir> into <used>/
    # (made when missing), never over an existing <used>/<name>, never through a symlink.
    # Prints {moved, args}; nothing to move or a taken target is moved false, not an error.
    src, used = sys.argv[2], sys.argv[3]
    # 7.3.0 review (m3): src is <x>/scratch/parked/<run> and used is <x>/scratch/parked/used
    pk = os.path.dirname(os.path.realpath(src))
    name = os.path.basename(os.path.realpath(src))
    if os.path.basename(pk) != 'parked' or os.path.basename(os.path.dirname(pk)) != 'scratch' or not NAME_RE.fullmatch(name) or name in ('used', '.', '..') \
            or os.path.islink(pk) or os.path.realpath(used) != os.path.join(pk, 'used'):
        sys.exit('refusing a retire outside <scratch>/parked: ' + src + ' -> ' + used)
    dest = os.path.join(used, os.path.basename(src.rstrip('/')))
    moved = False
    if os.path.isdir(src) and not os.path.islink(src) and not os.path.islink(used):
        os.makedirs(used, exist_ok=True)
        if not os.path.lexists(dest):
            os.rename(src, dest)
            moved = True
    emit({'moved': moved, 'args': [src, used]})
elif mode in ('claim', 'release', 'beat'):
    # fleet 8.0.1 (#76): the per-task run lock <git-common-dir>/fleet/locks/<task id>.json.
    # claim <repo> <task id> <nonce> <plan|build>: O_CREAT|O_EXCL|O_NOFOLLOW, 0600; the same nonce
    # holds it again and refreshes its heartbeat; a lock whose heartbeat (else start) is over 12 h old
    # moves to .stale-<old>-<new> and is claimed once more. The heartbeat follows the run; the pid is
    # a short-lived helper's and says nothing about the run.
    # release <repo> <task id> <nonce>: unlinks the lock only when it holds this nonce.
    # beat <repo> <task id> <nonce> (8.3.2, #103): the hasher's per-gate heartbeat; rewrites the
    # heartbeat only of a lock that holds this nonce; never creates, moves or claims one.
    # The pid and host are for a human only; no symlink is followed on the way.
    import calendar, socket, subprocess, time
    n_args = 6 if mode == 'claim' else 5
    if len(sys.argv) != n_args:
        sys.exit('usage: claim <repo> <task id> <nonce> <plan|build> | release|beat <repo> <task id> <nonce>')
    repo, task, nonce = sys.argv[2:5]
    run_mode = sys.argv[5] if mode == 'claim' else None
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', task):
        sys.exit('bad task id: ' + task)
    if not re.fullmatch(r'[A-Za-z0-9_.:-]{6,64}', nonce):
        sys.exit('bad nonce: ' + nonce)
    if mode == 'claim' and run_mode not in ('plan', 'build'):
        sys.exit('bad mode: ' + str(run_mode))
    g = subprocess.run(['git', '-c', 'core.fsmonitor=false', '-C', repo, 'rev-parse', '--git-common-dir'], capture_output=True)
    if g.returncode != 0:
        sys.exit('not a git repo: ' + repo + ': ' + g.stderr.decode('utf-8', 'replace')[-500:])
    common = g.stdout.decode().strip()
    common = common if os.path.isabs(common) else os.path.join(repo, common)
    if os.path.islink(common) or not os.path.isdir(common):
        sys.exit('refusing the git common dir ' + common)
    d = common
    for part in ('fleet', 'locks'):
        d = os.path.join(d, part)
        if os.path.islink(d):
            sys.exit('refusing a symlink at ' + d)
        if not os.path.lexists(d):
            if mode != 'claim':
                break
            try:
                os.mkdir(d, 0o700)
            except FileExistsError:
                pass
        if os.path.islink(d) or (os.path.lexists(d) and not os.path.isdir(d)):
            sys.exit('refusing a symlink or file at ' + d)
    lock = os.path.join(common, 'fleet', 'locks', task + '.json')
    args = sys.argv[2:]
    def holder():
        # (fields or None, inode, age in seconds); a young unreadable lock is held (a claim mid-write)
        try:
            fd = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return None
        except OSError as e:
            sys.exit('refusing the lock ' + lock + ' (a symlink?): ' + str(e))
        try:
            st = os.fstat(fd)
            data = os.read(fd, 4096) if st.st_size <= 4096 else b''
        finally:
            os.close(fd)
        try:
            j = json.loads(data.decode('utf-8'))
            j = j if isinstance(j, dict) else None
        except ValueError:
            j = None
        h = {k: (j.get(k) if j and isinstance(j.get(k), str) else None) for k in ('nonce', 'mode', 'started', 'heartbeat', 'pid', 'host')}
        try:
            t0 = calendar.timegm(time.strptime(h['heartbeat'] or h['started'], '%Y-%m-%dT%H:%M:%SZ'))
        except (TypeError, ValueError):
            t0 = st.st_mtime
        return h, st.st_ino, time.time() - t0
    if os.path.islink(lock):
        sys.exit('refusing a symlink at ' + lock)
    if mode == 'release':
        h = holder()
        out = {'released': False, 'absent': h is None, 'held_by': None, 'lock': lock, 'args': args}
        if h and h[0]['nonce'] == nonce:
            os.unlink(lock)
            out['released'] = True
        elif h:
            out['held_by'] = h[0]
        emit(out)
        sys.exit(0)
    def stamp():
        return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    def beat(h):
        # the holder's own re-claim: rewrite the lock with a fresh heartbeat (temp file, then rename)
        tmp = lock + '.beat-' + str(os.getpid())
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as f:
            json.dump(dict({k: v for k, v in h.items() if v is not None}, heartbeat=stamp()), f)
        os.replace(tmp, lock)
    def create():
        try:
            fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            return False
        with os.fdopen(fd, 'w') as f:
            json.dump({'nonce': nonce, 'mode': run_mode, 'started': stamp(), 'heartbeat': stamp(), 'pid': str(os.getpid()), 'host': socket.gethostname()}, f)
        return True
    if mode == 'beat':
        h = holder()
        out = {'beat': False, 'absent': h is None, 'held_by': None, 'lock': lock, 'args': args}
        if h and h[0]['nonce'] == nonce:
            beat(h[0])
            out['beat'] = True
        elif h:
            out['held_by'] = h[0]
        emit(out)
        sys.exit(0)
    out = {'claimed': False, 'again': False, 'stale': None, 'held_by': None, 'lock': lock, 'args': args}
    if create():
        out['claimed'] = True
    else:
        h = holder()
        if h and h[0]['nonce'] == nonce:
            out['claimed'] = out['again'] = True
            beat(h[0])
        elif h and h[2] > 12 * 3600:
            moved = lock + '.stale-' + (h[0]['nonce'] if isinstance(h[0]['nonce'], str) and re.fullmatch(r'[A-Za-z0-9_.:-]{1,64}', h[0]['nonce']) else 'unknown') + '-' + nonce
            os.rename(lock, moved)
            # another claimer may have renamed the stale lock first and created a live one: that one is moved back
            if os.lstat(moved).st_ino != h[1]:
                try:
                    os.link(moved, lock)
                    os.unlink(moved)
                except FileExistsError:
                    pass
                out['held_by'] = (holder() or (None,))[0]
            else:
                out['stale'] = {'nonce': h[0]['nonce'], 'moved_to': moved}
                out['claimed'] = create()
                if not out['claimed']:
                    out['held_by'] = (holder() or (None,))[0]
        elif h:
            out['held_by'] = h[0]
        elif create():
            out['claimed'] = True
    emit(out)
else:
    sys.exit('usage: read <scratch> <tip> | read-part <scratch> <run> <k> | write <scratch> <run> <chunk dir> <n> <expected> <shas> | park <worktree> <plan path> <scratch> <run> | retire <dir> <used> | claim <repo> <task id> <nonce> <mode> | release <repo> <task id> <nonce> | beat <repo> <task id> <nonce>')
