
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
import hashlib, json, os, re, shutil, subprocess, sys, time
def lift():
    # podman (a Go binary) is not bound by this program's caps
    for k in (_r.RLIMIT_AS, _r.RLIMIT_CPU):
        _r.setrlimit(k, (_r.getrlimit(k)[1],) * 2)
# fleet 4.0.0 (1981): the only containers these programs touch
NAME = re.compile(r'fleet-db-[a-z0-9-]{1,80}')
def name_ok(n):
    return isinstance(n, str) and NAME.fullmatch(n) is not None and 'tf-local' not in n
def done(out):
    out['program'] = _PROG
    out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0)
def fail(code, msg):
    sys.stderr.write(msg + '\n')
    sys.exit(code)
PM = shutil.which('podman')
def pm(*a, timeout=120):
    return subprocess.run([PM] + list(a), capture_output=True, timeout=timeout, preexec_fn=lift)
def tail(r):
    return (r.stderr or b'').decode('utf-8', 'replace')[-400:]
# usage: db_up.py up <name> <image> <ttl> <nonce> <dbs json> [<test_db_prefix>] [grant:PROCESS]
#        db_up.py add <name> <dbs json> [<test_db_prefix>] [grant:PROCESS]
# One MariaDB user per database, granted on that database only, with a random
# password from this program. The root password is random too, lives only in
# the container, and is never printed.
import secrets
argv = sys.argv[1:]
mode = argv[0] if argv else ''
if mode not in ('up', 'add') or len(argv) - (6 if mode == 'up' else 3) not in (0, 1, 2):
    fail(2, 'usage: db_up.py up <name> <image> <ttl> <nonce> <dbs> [<test_db_prefix>] [grant:PROCESS] | add <name> <dbs> [<test_db_prefix>] [grant:PROCESS]')
name = argv[1]
if not name_ok(name):
    fail(2, 'container name refused: ' + name)
# fleet 5.0.3 (2011): the optional test_db_prefix of .fleet-test-db.json. Each
# role user also gets ALL on the databases the prefix starts, in this container
# only. The same check as test_db_decl.py and the workflow's testDbDeclProblem.
SYSTEM_SCHEMAS = ('mysql', 'sys', 'information_schema', 'performance_schema')
def prefix_problem(p):
    if not isinstance(p, str) or not re.fullmatch(r'[a-z][a-z0-9_]{0,30}_', p):
        return 'test_db_prefix must be a string matching ^[a-z][a-z0-9_]{0,30}_$'
    if p.startswith('fleet_'):
        return 'test_db_prefix must not start with fleet_ (the role databases)'
    like = re.compile(re.escape(p).replace('_', '.') + '.*')
    if any(s.startswith(p) or p.startswith(s) or like.fullmatch(s) for s in SYSTEM_SCHEMAS):
        return 'test_db_prefix must not match or start a system schema (' + ', '.join(SYSTEM_SCHEMAS) + ')'
    return None
# fleet 6.3.0 (ADR-1233): grant:PROCESS, the one extra grant, to this container's role users only
rest = argv[6 if mode == 'up' else 3:]
process = 'grant:PROCESS' in rest
if any(x.startswith('grant:') and x != 'grant:PROCESS' for x in rest) or rest.count('grant:PROCESS') > 1:
    fail(2, 'grants refused: only grant:PROCESS, once (ADR-1233)')
rest = [x for x in rest if x != 'grant:PROCESS']
if len(rest) > 1:
    fail(2, 'usage: one <test_db_prefix> at most')
prefix = rest[0] if rest else None
if prefix is not None and prefix_problem(prefix):
    fail(2, prefix_problem(prefix))
try:
    dbs = json.loads(argv[5 if mode == 'up' else 2])
except ValueError:
    dbs = None
if not isinstance(dbs, list) or not 1 <= len(dbs) <= 64 or len(set(map(str, dbs))) != len(dbs) or not all(isinstance(d, str) and re.fullmatch(r'fleet_[a-z0-9_]{1,48}', d) for d in dbs):
    fail(2, 'database names refused')
if not PM:
    fail(4, 'no podman on PATH: no container started')
users = {d: secrets.token_hex(16) for d in dbs}
out = {'name': name, 'port': None, 'dbs': dbs, 'users': None, 'expiry': None, 'args': argv}
def sql(root, stmt):
    return pm('exec', '-e', 'MYSQL_PWD=' + root, name, 'mariadb', '--protocol=tcp', '-h127.0.0.1', '-uroot', '-e', stmt, timeout=60)
def create(root):
    st = []
    for d in dbs:
        st.append('CREATE DATABASE IF NOT EXISTS ' + d + ';')
        st.append("CREATE OR REPLACE USER '" + d + "'@'%' IDENTIFIED BY '" + users[d] + "';")
        st.append("GRANT ALL PRIVILEGES ON " + d + ".* TO '" + d + "'@'%';")
        if prefix is not None:
            # a LIKE pattern in a backtick identifier: _ escaped as \_ is a literal _
            st.append("GRANT ALL PRIVILEGES ON `" + prefix.replace('_', '\\_') + "%`.* TO '" + d + "'@'%';")
        if process:
            st.append("GRANT PROCESS ON *.* TO '" + d + "'@'%';")
    return sql(root, ' '.join(st))
if mode == 'add':
    i = pm('container', 'inspect', '--format', '{{index .Config.Labels "fleet.db"}}', name)
    if i.returncode != 0 or i.stdout.strip() != b'1':
        fail(5, 'no fleet test database container ' + name)
    rp = pm('exec', name, 'printenv', 'MARIADB_ROOT_PASSWORD')
    root = rp.stdout.decode('utf-8', 'replace').strip()
    if rp.returncode != 0 or not re.fullmatch(r'[0-9a-f]{32}', root):
        fail(5, 'no root password in container ' + name)
    c = create(root)
    if c.returncode != 0:
        fail(6, 'CREATE DATABASE failed: ' + tail(c))
    out['users'] = users
    done(out)
image, ttl_s, nonce = argv[2], argv[3], argv[4]
if not re.fullmatch(r'[a-z0-9][a-z0-9./_-]{0,200}@sha256:[0-9a-f]{64}', image):
    fail(2, 'the image must be pinned by digest: ' + image)
if not re.fullmatch(r'[0-9]{2,5}', ttl_s) or not 60 <= int(ttl_s) <= 86400:
    fail(2, 'ttl refused')
if not re.fullmatch(r'[A-Za-z0-9._-]{1,64}', nonce):
    fail(2, 'nonce refused')
ttl = int(ttl_s)
root = secrets.token_hex(16)
# self-expiry first: podman run --timeout, else a systemd-run timer; neither -> no container
h = pm('run', '--help')
SR = shutil.which('systemd-run')
if h.returncode == 0 and b'--timeout' in h.stdout:
    mech = 'podman-timeout'
elif SR:
    mech = 'systemd-run'
else:
    fail(4, 'no expiry mechanism (podman run --timeout or systemd-run): no container started')
expires = int(time.time()) + ttl
cmd = ['run', '-d', '--rm', '--name', name, '--label', 'fleet.db=1', '--label', 'fleet.nonce=' + nonce, '--label', 'fleet.expires=' + str(expires),
       '-p', '127.0.0.1::3306', '--tmpfs', '/var/lib/mysql:size=1g', '--memory', '1g', '--cpus', '2', '--pids-limit', '512',
       '-e', 'MARIADB_ROOT_PASSWORD=' + root]
if mech == 'podman-timeout':
    cmd += ['--timeout', str(ttl)]
r = pm(*(cmd + [image]), timeout=900)
if r.returncode != 0:
    pm('rm', '-f', name)
    fail(5, 'podman run failed: ' + tail(r))
def gone(code, msg):
    pm('rm', '-f', name)
    fail(code, msg + '; container removed')
if mech == 'systemd-run':
    s = subprocess.run([SR, '--user', '--on-active=' + str(ttl) + 's', '--unit=' + name + '-expire', PM, 'rm', '-f', name], capture_output=True, timeout=60, preexec_fn=lift)
    if s.returncode != 0:
        gone(4, 'systemd-run expiry timer failed: ' + tail(s))
p = pm('port', name, '3306/tcp')
lines = [l.strip() for l in p.stdout.decode('utf-8', 'replace').splitlines() if l.strip()]
ports = [re.fullmatch(r'127\.0\.0\.1:([0-9]{1,5})', l) for l in lines]
if p.returncode != 0 or not ports or not all(ports) or len(set(m.group(1) for m in ports)) != 1:
    gone(5, 'port 3306 is not published on 127.0.0.1 only: ' + repr(lines))
port = int(ports[0].group(1))
deadline = time.time() + 60
while True:
    k = pm('exec', '-e', 'MYSQL_PWD=' + root, name, 'mariadb-admin', '--protocol=tcp', '-h127.0.0.1', '-uroot', 'ping', timeout=30)
    if k.returncode == 0:
        break
    if time.time() > deadline:
        gone(6, 'the database did not answer within 60 s: ' + tail(k))
    time.sleep(2)
c = create(root)
if c.returncode != 0:
    gone(6, 'CREATE DATABASE failed: ' + tail(c))
out['port'] = port
out['users'] = users
out['expiry'] = {'mechanism': mech, 'expires': expires}
done(out)
