
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
# fleet 8.1.0 (#75, ADR-1319): the bubblewrap sandbox of the gate test runs. Not run by the workflow:
# cover_diff.py, mutants.py and scratch_copy.py sandbox-run start it as python3 -I sandbox.py <mode> <spec>
# after checking its sha256 against their own pin. <spec> is a JSON file in the caller's private dir:
#   {worktree, cwd, argv, env (the child's whole env), copy (a dir), rw [dirs], ro [dirs], git (bool),
#    check (bool), result (a file path)}
#   run: run argv in the sandbox (stdout and stderr inherited); write {started, exit, reason} to result.
#     started false: the sandbox did not start (no bwrap, the self-check failed, a mount failed); no
#     test process ran. With check, the same mounts run python -I -S -c '' first (the self-check).
#   dbreset: for each *_TEST_DSN, drop the DSN's own database and the ones named <it>_* that its user sees,
#     never another (the role users share the repo's test_db_prefix grants in one container, so another
#     role's or run's database stays), and every other database that is not in spec keep (the dbsnap names
#     from before the tree run: a <test_db_prefix>* database the tree run made) and is not a fleet_* one,
#     then create the DSN's own database again (the base re-run, ADR-1318); write {ok, reason} to result.
#     A *_TEST_DSN that names no database, or no keep list: ok false.
#   dbsnap: write {ok, names, reason} (every database the *_TEST_DSN users see) to result.
#   plan: print {argv} (the bwrap arguments; tests).
# The sandbox: --unshare-all (net included), --die-with-parent, --new-session; / read-only, a new /dev,
# /proc and /tmp; tmpfs over /run (host unix sockets: podman, docker, D-Bus, agents), HOME, the held-out
# store, the cache, data and runtime dirs, the worktree, its fleet root and the main checkout. From /run only
# RUN_BACK comes back (NixOS: the system profile and the wrappers). Writable, each run fresh (--tmp-overlay, nothing persists): the
# copy and the env's private dirs under <root>/scratch/build or uv-cache. Written through (--bind): rw only.
# Read-only again: an env PATH dir a tmpfs hides only when its real path is outside every hidden dir and
# holds none (a symlink into /nix/store, say; never HOME, a secret dir, the worktree or the checkout; a
# refused dir is dropped), the toolchain dirs in TOOLS and sys.base_prefix (the allowlist; none may hold a
# hidden dir), the copy's git dir (git true). The DB: each 127.0.0.1 port of a *_TEST_DSN reaches the host through a
# unix-socket relay pair, that port only.
# 8.2.0 (#80): bwrap runs only when its real path is under /nix/store, or the file and every dir above it
# are root-owned and not group- or other-writable. A tmpfs over /var/lib. With git true, refs/fleet,
# logs/refs/fleet and every worktrees/<x> but the copy's own are a tmpfs again (the objects and packed-refs
# stay readable). Every host unix socket under SCAN_ROOTS (and a spec's scan roots) that no tmpfs hides
# yet: a tmpfs over its dir, or /dev/null bound over the socket when its dir must stay (STAY, or it holds a
# dir bound back); a dir the scan cannot read is a tmpfs; a scan that fails or runs past its caps refuses
# the run ("socket scan ..."). The relay dir is 0700.
import json, os, re, shutil, socket, stat, subprocess, sys, tempfile, threading
DSN = re.compile(r'mysql://([A-Za-z0-9_]{1,64}):([^@/\s]*)@127\.0\.0\.1:([0-9]{1,5})/([A-Za-z0-9_]{1,64})')
DSN_KEY = re.compile(r'[A-Z][A-Z0-9_]{0,40}_TEST_DSN')
# the env vars whose dir is the child's own (made fresh per run when under the run's scratch)
DIRS = ('HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'CARGO_TARGET_DIR', 'PYTHONPYCACHEPREFIX', 'MYPY_CACHE_DIR', 'RUFF_CACHE_DIR', 'TURBO_CACHE_DIR', 'UV_PROJECT_ENVIRONMENT', 'UV_CACHE_DIR')
# toolchains under HOME a test run reads (no credential file in any of them)
TOOLS = ('.local/share/uv/python', '.rustup', '.cargo/bin', '.cargo/registry', 'go/pkg/mod')
SYSTEM = ('information_schema', 'mysql', 'performance_schema', 'sys')
SOCK = '/tmp/.fleet-db'
# what comes back from the hidden /run, by exact path (NixOS needs them for its binaries)
RUN_BACK = ('/run/current-system', '/run/wrappers')
def NIX_SOCKETS():
    # every dir under /nix/var/nix named *-socket or holding a socket (daemon-socket, gc-socket)
    out = []
    try:
        ents = list(os.scandir('/nix/var/nix'))[:256]
    except OSError:
        return out
    for d in ents:
        try:
            if not d.is_dir(follow_symlinks=False):
                continue
            if d.name.endswith('-socket') or any(stat.S_ISSOCK(e.stat(follow_symlinks=False).st_mode) for e in list(os.scandir(d.path))[:64]):
                out.append(d.path)
        except OSError:
            continue
    return out
# 8.2.0 (#80): where plan() looks for host unix sockets (a socket under /run, /tmp, HOME or another hidden
# dir is hidden already); /nix/store is never walked
SCAN_ROOTS = ('/var', '/srv', '/opt', '/nix/var', '/etc')
SCAN_CAP = (200000, 5.0)
def STAY(d):
    # a socket's dir that stays visible (a tmpfs there would hide config or the nix profiles): /dev/null
    # goes over the socket instead
    return d in SCAN_ROOTS or d in ('/', '/nix', '/nix/var/nix') or any(d == r or d.startswith(r + '/') for r in ('/etc', '/nix/var/nix/profiles', '/nix/var/nix/gcroots'))
def scan(roots, prune):
    # ([socket paths], [unreadable dirs]) under roots, no symlink followed, no dir in prune walked; or a reason
    import time
    t0, n, socks, closed = time.monotonic(), 0, [], []
    for root in roots:
        if not os.path.isabs(root):
            return None, None, 'socket scan: a relative root ' + root
        if not os.path.lexists(root) or os.path.islink(root):
            continue
        # a dir to prune holds the root: the walk under this root prunes none of it (a spec scan root)
        pr = [h for h in prune if not under(root, h)]
        st = [root]
        while st:
            d = st.pop()
            try:
                ents = list(os.scandir(d))
            except PermissionError:
                closed.append(d)
                continue
            except OSError as e:
                return None, None, 'socket scan failed at %s: %s' % (d, e)
            for e in ents:
                n += 1
                if n > SCAN_CAP[0] or time.monotonic() - t0 > SCAN_CAP[1]:
                    return None, None, 'socket scan over its caps (%d entries, %.0f s)' % SCAN_CAP
                try:
                    m = e.stat(follow_symlinks=False).st_mode
                except OSError:
                    continue
                if stat.S_ISDIR(m):
                    if not any(under(e.path, h) for h in pr):
                        st.append(e.path)
                elif stat.S_ISSOCK(m):
                    socks.append(e.path)
    return socks, closed, None
def trusted(bw):
    # None, or why the bwrap binary is not trusted: its real path under /nix/store, or the file and every
    # dir above it root-owned and not group- or other-writable. FLEET_SANDBOX_TEST_BWRAP (tests) names one
    # exact real path to accept: whoever sets this program's env already chooses its PATH.
    r = real(bw)
    if r.startswith('/nix/store/') or os.environ.get('FLEET_SANDBOX_TEST_BWRAP') == r:
        return None
    p = r
    while True:
        try:
            st = os.stat(p)
        except OSError:
            st = None
        if not st or st.st_uid != 0 or st.st_mode & 0o022:
            return 'bwrap at %s is not under /nix/store or in a root-owned dir others cannot write' % r
        if p == '/':
            return None
        p = os.path.dirname(p)
# the PATH dirs plan() refused (named on stderr when the command is then not found)
DROPPED = []
# the launcher inside: one listener per DB port, relayed to the bound unix socket; then the argv
INNER = r'''import json, socket, subprocess, sys, threading
def pump(a, b):
    try:
        while True:
            d = a.recv(65536)
            if not d:
                break
            b.sendall(d)
    except OSError:
        pass
    for s in (a, b):
        try:
            s.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
def serve(ls, path):
    while True:
        c = ls.accept()[0]
        u = socket.socket(socket.AF_UNIX)
        try:
            u.connect(path)
        except OSError:
            c.close()
            continue
        for x, y in ((c, u), (u, c)):
            threading.Thread(target=pump, args=(x, y), daemon=True).start()
for port, path in json.loads(sys.argv[1]).items():
    ls = socket.socket()
    ls.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    ls.bind(('127.0.0.1', int(port)))
    ls.listen(16)
    threading.Thread(target=serve, args=(ls, path), daemon=True).start()
try:
    c = subprocess.call(sys.argv[2:])
except OSError:
    c = 127
sys.exit(c if c >= 0 else 128 - c)
'''
def real(p):
    return os.path.realpath(p)
def under(p, d):
    p, d = real(p), real(d)
    return p == d or p.startswith(d.rstrip('/') + '/')
def lift():
    # bwrap and the code under test are not bound by this program's caps
    for k in (_r.RLIMIT_AS, _r.RLIMIT_CPU):
        _r.setrlimit(k, (_r.getrlimit(k)[1],) * 2)
def dsns(env):
    out = []
    for k, v in env.items():
        m = DSN.fullmatch(v) if DSN_KEY.fullmatch(k) else None
        if m:
            out.append((m.group(1), m.group(2), int(m.group(3)), m.group(4)))
    return out
def git_common(wt):
    r = subprocess.run(['git', '-c', 'core.fsmonitor=false', '-C', wt, 'rev-parse', '--path-format=absolute', '--git-common-dir'], capture_output=True, stdin=subprocess.DEVNULL)
    p = r.stdout.decode('utf-8', 'replace').strip()
    return real(p) if r.returncode == 0 and os.path.isabs(p) and os.path.isdir(p) else None
def plan(spec, sockdir=None):
    # (bwrap argv up to the command, the reason it cannot run or None)
    wt = real(spec['worktree'])
    root = os.path.dirname(wt)
    scratch = os.path.join(root, 'scratch')
    env = spec['env']
    home = os.path.expanduser('~')
    x = os.environ.get
    cfg = x('XDG_CONFIG_HOME') if os.path.isabs(x('XDG_CONFIG_HOME') or '') else os.path.join(home, '.config')
    cache = x('XDG_CACHE_HOME') if os.path.isabs(x('XDG_CACHE_HOME') or '') else os.path.join(home, '.cache')
    data = x('XDG_DATA_HOME') if os.path.isabs(x('XDG_DATA_HOME') or '') else os.path.join(home, '.local', 'share')
    run_dir = x('XDG_RUNTIME_DIR') if os.path.isabs(x('XDG_RUNTIME_DIR') or '') else '/run/user/%d' % os.getuid()
    gc = git_common(wt)
    # never visible again: the held-out store, the caches (fleet's among them), data, runtime and ssh dirs, the worktree, the git dir
    secret = [cfg, os.path.join(cfg, 'fleet', 'held-out'), cache, os.path.join(cache, 'fleet'), data, run_dir, os.path.join(home, '.ssh'), os.path.join(home, '.gnupg'), wt] + ([gc] if gc else [])
    hide = ['/run', home, root, run_dir] + secret + ([os.path.dirname(gc)] if gc else [])
    if os.path.isdir('/var/run') and not os.path.islink('/var/run'):
        hide.append('/var/run')
    # /var/tmp: a channel from the host's unsandboxed runs into the sandbox
    if os.path.isdir('/var/tmp') and not os.path.islink('/var/tmp'):
        hide.append('/var/tmp')
    # 8.2.0 (#80): /var/lib (container stores, databases, their sockets); nothing comes back
    if os.path.isdir('/var/lib') and not os.path.islink('/var/lib'):
        hide.append('/var/lib')
    # the nix daemon (and gc) sockets: the daemon writes the host store and fetches URLs (not /nix/var
    # itself: the profiles resolve through /nix/var/nix/profiles)
    hide += NIX_SOCKETS()
    hide = sorted({real(h) for h in hide if os.path.isdir(h)}, key=len)
    if '/' in hide:
        return None, 'a dir to hide is /'
    hide = [h for i, h in enumerate(hide) if not any(under(h, g) for g in hide[:i])]
    def hidden(p):
        return any(under(p, h) for h in hide + ['/tmp'])
    def secretly(p):
        # under a secret dir or the fleet root, and not under <root>/scratch
        return any(under(p, s) for s in secret) or (under(p, root) and not under(p, scratch))
    keep = hide + [real(x) for x in secret if os.path.isdir(x)] + [wt]
    def holds(src):
        # src is, or holds, a hidden or secret dir, the worktree or the main checkout
        return any(under(k, src) for k in keep)
    a = ['--unshare-all', '--die-with-parent', '--new-session', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp']
    for h in hide:
        a += ['--tmpfs', h]
    back = []
    for b in RUN_BACK:
        if os.path.islink(b):
            a += ['--symlink', os.readlink(b), b]
            back.append(b)
        elif os.path.isdir(b) and not holds(real(b)):
            a += ['--ro-bind', real(b), b]
            back.append(b)
    ro = []
    # the allowlist: the toolchain dirs and the interpreter's prefix; never one that holds a hidden dir
    tools = [os.path.join(home, t) for t in TOOLS if os.path.isdir(os.path.join(home, t))]
    if hidden(real(sys.executable)):
        tools.append(sys.base_prefix)
    for d in tools:
        r = real(d)
        if not holds(r) and not (secretly(r) and not any(under(r, os.path.join(home, t)) for t in TOOLS)):
            ro.append((r, d))
    del DROPPED[:]
    for e in (env.get('PATH') or '').split(':'):
        n = os.path.normpath(e) if os.path.isabs(e) else ''
        # the entry as written (a link under HOME to /nix/store, say) or its real path lies under a tmpfs
        if not (n and os.path.isdir(n) and (hidden(n) or any(n == h or n.startswith(h.rstrip('/') + '/') for h in hide + ['/tmp']))) or any(n == b or n.startswith(b + '/') or under(n, b) for b in back):
            continue
        r = real(e)
        # a PATH dir comes back only when its real path is outside every hidden dir (and /tmp) and holds none
        if hidden(r) or holds(r):
            DROPPED.append(e)
        else:
            ro.append((r, e))
    for r, d in ro:
        a += ['--ro-bind', r, d]
    if spec.get('git'):
        if not gc:
            return None, 'no git dir for the copy'
        a += ['--ro-bind', gc, gc]
        # 8.2.0 (#80): the other tasks' refs and the other worktrees' admin dirs (index, HEAD, logs) are not
        # visible; the copy's own admin dir is (its .git file names it)
        own = None
        try:
            with open(os.path.join(spec.get('copy') or spec['cwd'], '.git')) as fh:
                t = fh.read(4096).strip()
            own = real(t[8:]) if t.startswith('gitdir: ') else None
        except OSError:
            pass
        mask = [os.path.join(gc, 'refs', 'fleet'), os.path.join(gc, 'logs', 'refs', 'fleet')]
        try:
            mask += sorted(e.path for e in os.scandir(os.path.join(gc, 'worktrees')) if e.is_dir(follow_symlinks=False) and real(e.path) != own)
        except OSError:
            pass
        for m in mask:
            if os.path.isdir(m) and not os.path.islink(m):
                a += ['--tmpfs', m]
    over = [spec['copy']] if spec.get('copy') else []
    for k in DIRS:
        v = env.get(k) or ''
        if os.path.isabs(v) and (under(v, os.path.join(scratch, 'build')) or under(v, os.path.join(scratch, 'uv-cache'))):
            os.makedirs(v, exist_ok=True)
            over.append(v)
    for d in over:
        if not os.path.isdir(d):
            return None, 'no dir ' + d
        a += ['--overlay-src', real(d), '--tmp-overlay', real(d)]
    for k, flag in (('rw', '--bind'), ('ro', '--ro-bind')):
        for d in spec.get(k) or []:
            if not os.path.isabs(d) or not os.path.isdir(d):
                return None, 'no dir ' + d
            a += [flag, real(d), real(d)]
    # 8.2.0 (#80): every host unix socket left visible: a tmpfs over its dir, or /dev/null over it when the
    # dir stays (STAY, or the dir is or holds a dir bound back above); an unreadable dir: a tmpfs
    roots = list(SCAN_ROOTS) + list(spec.get('scan') or [])
    socks, closed, why = scan(roots, hide + ['/tmp', '/nix/store'])
    if why:
        return None, why
    bound = [a[i + 2] for i, v in enumerate(a) if v in ('--ro-bind', '--bind', '--symlink') and i + 2 < len(a)] + [a[i + 1] for i, v in enumerate(a) if v == '--tmp-overlay']
    done = []
    for p in sorted(set(socks)):
        d = os.path.dirname(p)
        if any(under(p, x) for x in done):
            continue
        if not STAY(d) and not any(under(b, d) for b in bound):
            a += ['--tmpfs', d]
            done.append(d)
        else:
            a += ['--ro-bind', '/dev/null', p]
    # 8.2.0 review (MED b): a dir the scan cannot list but the child can enter (a socket name in it is
    # reachable): a tmpfs over it, never a fail-open skip; when it is a kept path (a scan root, the nix
    # profiles or gcroots, or it is or holds a dir bound back) the run is refused. A dir the child cannot
    # enter needs nothing.
    for d in sorted(set(closed)):
        if any(under(d, x) for x in done) or not os.access(d, os.X_OK):
            continue
        if d in roots or d in ('/', '/etc', '/nix', '/nix/var/nix') or any(under(d, k) for k in ('/nix/var/nix/profiles', '/nix/var/nix/gcroots')) or any(under(b, d) for b in bound):
            return None, 'socket scan: unreadable dir %s under a kept path' % d
        a += ['--tmpfs', d]
        done.append(d)
    if sockdir:
        a += ['--ro-bind', sockdir, SOCK]
    # nix: the local store (read-only here) and no daemon; with the socket hidden every NIX_REMOTE fails closed
    a += ['--setenv', 'NIX_REMOTE', 'local', '--chdir', real(spec['cwd'])]
    return a, None
def relay(ls, port):
    # host side: the unix socket to 127.0.0.1:<port>, nothing else
    def pump(p, q):
        try:
            while True:
                d = p.recv(65536)
                if not d:
                    break
                q.sendall(d)
        except OSError:
            pass
        for s in (p, q):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
    while True:
        c = ls.accept()[0]
        t = socket.socket()
        try:
            t.connect(('127.0.0.1', port))
        except OSError:
            c.close()
            continue
        for p, q in ((c, t), (t, c)):
            threading.Thread(target=pump, args=(p, q), daemon=True).start()
def put(spec, out):
    if out.get('started'):
        out['bwrap'] = bw
    with open(spec['result'], 'w') as fh:
        json.dump(out, fh)
def bwrap_run(bw, a, argv, env, out=None):
    # (started, exit code); started: bwrap wrote child-pid to its status fd
    rfd, wfd = os.pipe()
    try:
        p = subprocess.Popen([bw, '--json-status-fd', str(wfd)] + a + ['--'] + argv, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT if out else None, pass_fds=(wfd,), preexec_fn=lift)
    except OSError as e:
        os.close(rfd)
        os.close(wfd)
        return False, str(e)
    os.close(wfd)
    with os.fdopen(rfd, 'rb') as fh:
        st = fh.read(1 << 16).decode('utf-8', 'replace')
    c = p.wait()
    return '"child-pid"' in st, (c if c >= 0 else 128 - c)
mode = sys.argv[1] if len(sys.argv) > 1 else ''
if mode not in ('run', 'dbreset', 'dbsnap', 'plan') or len(sys.argv) != 3:
    sys.exit('usage: sandbox.py run|dbreset|dbsnap|plan <spec json file>')
with open(sys.argv[2], 'rb') as fh:
    spec = json.loads(fh.read(1 << 22).decode('utf-8'))
if not isinstance(spec.get('env'), dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in spec['env'].items()):
    sys.exit('spec env is not a JSON object of strings')
if mode == 'plan':
    a, why = plan(spec, SOCK if dsns(spec['env']) else None)
    print(json.dumps({'argv': a, 'reason': why, 'dropped': DROPPED}))
    sys.exit(0)
if mode in ('dbreset', 'dbsnap'):
    cl = shutil.which('mariadb', path=_RAW_PATH) or shutil.which('mysql', path=_RAW_PATH)
    for k, v in spec['env'].items():
        if DSN_KEY.fullmatch(k) and v.startswith('mysql://') and not DSN.fullmatch(v):
            put(spec, {'ok': False, 'reason': k + ' names no test database to reset'})
            sys.exit(0)
    own = {d[3] for d in dsns(spec['env'])}
    keep = spec.get('keep')
    if mode == 'dbreset' and own and not (isinstance(keep, list) and all(isinstance(n, str) for n in keep)):
        put(spec, {'ok': False, 'reason': 'no database list from before the tree run'})
        sys.exit(0)
    seen = []
    for user, pw, port, db in dsns(spec['env']):
        if not cl:
            put(spec, {'ok': False, 'reason': 'no mariadb or mysql client on PATH to reset the test database'})
            sys.exit(0)
        base = [cl, '--protocol=tcp', '-h127.0.0.1', '-P%d' % port, '-u' + user, '-N', '-B', '-e']
        e = dict(os.environ, MYSQL_PWD=pw)
        r = subprocess.run(base + ['SHOW DATABASES'], capture_output=True, env=e, stdin=subprocess.DEVNULL, timeout=60, preexec_fn=lift)
        names = [n for n in r.stdout.decode('utf-8', 'replace').split() if n not in SYSTEM]
        if r.returncode != 0 or not all(re.fullmatch(r'[A-Za-z0-9_]{1,64}', n) for n in names):
            put(spec, {'ok': False, 'reason': 'SHOW DATABASES failed: ' + r.stderr.decode('utf-8', 'replace')[-300:]})
            sys.exit(0)
        if mode == 'dbsnap':
            seen += [n for n in names if n not in seen]
            continue
        # the DSN's own database and its <db>_* databases (never another DSN's own database), and a database
        # the tree run made (not in keep; a <test_db_prefix>* one, never a fleet_* one)
        names = [n for n in names if n == db or (n.startswith(db + '_') and n not in own) or (n not in keep and n not in own and not n.startswith('fleet_'))]
        r = subprocess.run(base + [' '.join('DROP DATABASE `%s`;' % n for n in names) + ' CREATE DATABASE `%s`;' % db], capture_output=True, env=e, stdin=subprocess.DEVNULL, timeout=60, preexec_fn=lift)
        if r.returncode != 0:
            put(spec, {'ok': False, 'reason': 'the database reset failed: ' + r.stderr.decode('utf-8', 'replace')[-300:]})
            sys.exit(0)
    put(spec, {'ok': True, 'names': seen, 'reason': None} if mode == 'dbsnap' else {'ok': True, 'reason': None})
    sys.exit(0)
# run
def fail(why):
    put(spec, {'started': False, 'exit': None, 'reason': why})
    sys.exit(0)
argv = spec.get('argv')
if not isinstance(argv, list) or not argv or not all(isinstance(x, str) for x in argv):
    fail('argv is not a non-empty JSON list of strings')
# never the env PATH (a venv bin the tree can write): the agent PATH only
bw = shutil.which('bwrap', path=_RAW_PATH)
if not bw:
    fail('bwrap is not on PATH')
# 8.2.0 review (MED a): resolved once; the trust check, the self-check and the run use this one path
bw = real(bw)
# 8.2.0 (#80): a bwrap the tree (or another user) could have planted on the agent PATH is never run
why = trusted(bw)
if why:
    fail(why)
db = dsns(spec['env'])
work = tempfile.mkdtemp(prefix='fleet-sbx-')
try:
    socks = {}
    if db:
        # 8.2.0 (#80): no other user reaches the relay sockets
        os.chmod(work, 0o700)
        for port in sorted({d[2] for d in db}):
            ls = socket.socket(socket.AF_UNIX)
            ls.bind(os.path.join(work, str(port)))
            ls.listen(16)
            socks[str(port)] = SOCK + '/' + str(port)
            threading.Thread(target=relay, args=(ls, port), daemon=True).start()
    a, why = plan(spec, work if db else None)
    if why:
        fail(why)
    py = real(sys.executable)
    if spec.get('check'):
        with tempfile.TemporaryFile() as fh:
            ok, code = bwrap_run(bw, a, [py, '-I', '-S', '-c', ''], spec['env'], fh)
            fh.seek(0)
            tail = fh.read(4000).decode('utf-8', 'replace').strip()[-300:]
        if not ok or code != 0:
            fail('the bwrap self-check failed (exit %s): %s' % (code, tail))
    cmd = [py, '-I', '-S', '-c', INNER, json.dumps(socks)] + argv if db else argv
    sys.stdout.flush()
    ok, code = bwrap_run(bw, a, cmd, spec['env'])
    if not ok:
        fail('bwrap did not start the command (exit %s)' % code)
    if code == 127 and DROPPED:
        print('sandbox: command not found; PATH dirs not in the sandbox (under a hidden dir): ' + ', '.join(DROPPED), file=sys.stderr)
    put(spec, {'started': True, 'exit': code, 'reason': None})
finally:
    shutil.rmtree(work, ignore_errors=True)
