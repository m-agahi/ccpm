
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
# fleet 8.0.0 (G2, ADR-1316): the coverage gate. Args: <worktree> <base> <tree> <test_cmd> <env json> <exclude json>.
# A throwaway detached worktree <dirname(worktree)>/scratch/copy-* at <base> with the judged <tree>
# read in (read-tree -u --reset; the main worktree is never touched). The test_cmd (a pytest
# shape only, <paths> dropped) runs once plain (red: once more at <base>, not_run either way, "tree
# red, base green" when the base is green) and once under the coverage
# module with this program's own rcfile (no repo omit list, no pragma exclusion), within one
# 540 s deadline (hit: partial). Findings: the added lines of the changed .py files (git diff
# -U0 <base> <tree>, the <exclude> paths aside) the run did not execute; a changed file the
# report lacks counts every added line that is not blank or a comment. Prints {status: ran|
# partial|not_run, reason, findings: [{path, lines}], args}. No coverage tool: not_run. A tool
# that errors after a good probe and a green baseline: a non-zero exit (the workflow retries
# once, then stops at gate gates). The child runs with the caps lifted, in its own process
# group, behind the PATH guard of scratch_copy.py run (no terraform-family name resolves
# other than on the agent PATH).
# 8.1.0 (#75): every test run is a sandbox.py run (bwrap; no network, HOME and the worktree hidden), each in a
# fresh sandbox (the copy a fresh overlay each time); the coverage data dir is writable in the run step only,
# the report dir in the json step only; the base re-run follows a reset of the test database. No sandbox (no
# bwrap, a failed self-check, sandbox.py off its pin): not_run "sandbox unavailable: ...", no test run.
# 8.9.7 (#110, option a): an optional 7th arg <tier>, the python coverage row of the digest-checked gate census
# (gate_tools.py) the workflow passes. When it is exactly UV_TIER, a bare pytest or a python -m pytest test_cmd runs
# coverage as `uv run --frozen coverage` (no uv on PATH: not_run); a uv run test_cmd keeps its own flags, and any
# other tier value, or none, keeps the shapes below.
# Security review of #123: uv resolves coverage from the judged tree's uv.lock and config, which the coder writes
# (the census read the repo at preflight, not this tree). Before any run, the uv tier fails closed (not_run "uv
# tier refused: ...") unless the judged tree's uv.lock pins coverage from PyPI with an entry equal to the plan
# base's, its pyproject.toml [tool.uv] table equals the base's and its [tool.uv.sources] does not name coverage,
# and uv.toml and .python-version equal the base's, and no tree path is named coverage (a package or module that
# could shadow the locked one); every non-PyPI lock entry but the root project's is the base's, and the judged
# pyproject declares no coverage script or entry point, with [build-system] and every [tool.*] table but [tool.uv]
# as at the base. Every run of the uv tier gets UV_NO_CONFIG=1.
import hashlib, json, os, re, shlex, shutil, signal, subprocess, sys, tempfile, time
DEADLINE, CAP = 540, 400
SANDBOX_SHA256 = '6ef231433b0333775fc85b0762caff74edd2ae862a3a1bd4b5a73264cfb3fd43'
UV_TIER = 'uv run --frozen coverage'
PYPI = {'registry': 'https://pypi.org/simple'}
SBX = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'sandbox.py')
# the python -m pytest shape's coverage launcher: coverage from the interpreter (-I: no cwd) or a PYTHONPATH dir
# outside the copy, then the PYTHONPATH dirs in the copy for the tests
LAUNCH = ("import os, sys\nsys.argv[0] = 'coverage'\nc = os.getcwd()\n"
          "pp = [os.path.abspath(p) for p in os.environ.get('PYTHONPATH', '').split(os.pathsep) if p]\n"
          "out = [p for p in pp if p != c and not p.startswith(c + os.sep)]\nsys.path[:0] = out\nimport coverage\n"
          "sys.path[:0] = [p for p in pp if p not in out]\n"
          "sys.dont_write_bytecode = sys.dont_write_bytecode or bool(os.environ.get('PYTHONDONTWRITEBYTECODE'))\n"
          "import runpy\nrunpy.run_module('coverage', run_name='__main__', alter_sys=True)\n")
# security review: no attributes file, no system attributes, and every diff as text with no
# textconv or external driver, so no git attribute (binary, -diff, a diff driver) hides a line
G = ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.quotePath=false', '-c', 'core.attributesFile=/dev/null']
D = ['--text', '--no-textconv', '--no-ext-diff', '--no-renames', '--no-color']
CODE = ('.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.go', '.rs', '.sh', '.bash', '.rb', '.java', '.kt', '.c', '.h', '.cc', '.cpp', '.php', '.pl', '.lua', '.swift', '.scala', '.cs')
REFUSED = {'terraform', 'tofu', 'tfp', 'terragrunt', 'digger', 'atlantis'}
os.environ['GIT_TERMINAL_PROMPT'] = '0'
os.environ['GIT_ATTR_NOSYSTEM'] = '1'
# G7b: a changed name is never a pathspec (`:(glob)*.py`, `a[1].py`); the test child gets the old value
_LIT = os.environ.get('GIT_LITERAL_PATHSPECS')
os.environ['GIT_LITERAL_PATHSPECS'] = '1'
def show(o):
    # a name that is not UTF-8 holds surrogates (os.fsdecode): shown as \\x.. escapes, never merged
    if isinstance(o, str):
        return os.fsencode(o).decode('utf-8', 'backslashreplace')
    if isinstance(o, list):
        return [show(x) for x in o]
    if isinstance(o, dict):
        return {k: show(v) for k, v in o.items()}
    return o
start = time.monotonic()
left = lambda: DEADLINE - (time.monotonic() - start)
def emit(status, reason, findings=()):
    out = {'status': status, 'reason': show(reason), 'findings': show(list(findings)), 'args': sys.argv[1:], 'program': _PROG}
    out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0)
def git(cwd, *a):
    r = subprocess.run(G + ['-C', cwd] + list(a), capture_output=True, stdin=subprocess.DEVNULL)
    if r.returncode != 0:
        sys.exit('git ' + ' '.join(a[:2]) + ' failed: ' + r.stderr.decode('utf-8', 'replace')[-1000:])
    return r.stdout
def lift():
    # the repo's own commands are not bound by this program's caps
    for k in (_r.RLIMIT_AS, _r.RLIMIT_CPU):
        _r.setrlimit(k, (_r.getrlimit(k)[1],) * 2)
class Late(Exception):
    pass
def helper(mode, spec):
    # sandbox.py <mode> <spec> (the result file it writes, or None); the bytes must match the pin
    try:
        with open(SBX, 'rb') as fh:
            ok = hashlib.sha256(fh.read()).hexdigest() == SANDBOX_SHA256
    except OSError:
        ok = False
    if not ok:
        emit('not_run', 'sandbox unavailable: sandbox.py does not hash to its pinned sha256')
    spec = dict(spec, worktree=wt, result=os.path.join(work, 'res.json'))
    if os.path.lexists(spec['result']):
        os.unlink(spec['result'])
    with open(os.path.join(work, 'spec.json'), 'w') as fh:
        json.dump(spec, fh)
    return [sys.executable, '-I', SBX, mode, os.path.join(work, 'spec.json')], spec['result']
def result(f):
    try:
        with open(f) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None
def dbsnap(env):
    # 8.1.0 review (M1): the databases before the tree run; the reset drops one the tree run made
    cmd, res = helper('dbsnap', {'env': env})
    try:
        subprocess.run(cmd, env=os.environ, stdin=subprocess.DEVNULL, capture_output=True, preexec_fn=lift, timeout=max(1, left()))
    except subprocess.TimeoutExpired:
        return None
    r = result(res)
    return r.get('names') if r and r.get('ok') else None
checked = []
def run(argv, cwd, env, log, rw=(), ro=()):
    # the exit code and the output tail; the whole process group dies at the deadline
    if left() <= 1:
        raise Late()
    cmd, res = helper('run', {'cwd': cwd, 'copy': tmp, 'argv': argv, 'env': env, 'rw': list(rw), 'ro': list(ro), 'git': True, 'check': not checked})
    with open(log, 'wb') as fh:
        try:
            p = subprocess.Popen(cmd, env=os.environ, stdin=subprocess.DEVNULL, stdout=fh, stderr=subprocess.STDOUT, preexec_fn=lift, start_new_session=True)
        except OSError as e:
            return 127, str(e)
        try:
            code = p.wait(timeout=left())
        except subprocess.TimeoutExpired:
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except OSError:
                pass
            p.wait()
            raise Late()
    r = result(res)
    if not r or not r.get('started'):
        emit('not_run', 'sandbox unavailable: ' + (r['reason'] if r else 'sandbox.py gave no result (exit %d)' % code))
    checked.append(1)
    with open(log, 'rb') as fh:
        return r['exit'], fh.read()[-2000:].decode('utf-8', 'replace')
a = sys.argv[1:]
if len(a) not in (6, 7):
    sys.exit('usage: cover_diff.py <worktree> <base> <tree> <test_cmd> <env json> <exclude json> [<tier>]')
wt, base, tree, cmd = a[0], a[1], a[2], a[3]
uv_tier = len(a) == 7 and a[6] == UV_TIER
try:
    env_in, exclude = json.loads(a[4]), json.loads(a[5])
except ValueError:
    env_in, exclude = None, None
if not os.path.isabs(wt) or not os.path.isdir(wt) or not all(re.match(r'^[0-9a-f]{40}$', x) for x in (base, tree)):
    sys.exit('bad worktree, base or tree')
if not isinstance(env_in, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in env_in.items()) or not isinstance(exclude, list) or not all(isinstance(x, str) for x in exclude):
    sys.exit('env is not a JSON object of strings or exclude is not a JSON list of strings')
# the pytest shapes of the workflow's testRunnerPrefix: pytest | python[3] -m pytest | uv run [--frozen|--no-sync|--extra X]... pytest
try:
    argv = [x for x in shlex.split(cmd) if x != '<paths>']
except ValueError:
    argv = []
i = 0
if argv[:2] == ['uv', 'run']:
    i = 2
    while i < len(argv) and (argv[i] in ('--frozen', '--no-sync') or (argv[i] == '--extra' and i + 1 < len(argv))):
        i += 2 if argv[i] == '--extra' else 1
if argv[i:i + 1] == ['pytest']:
    head = argv[:i] + ['coverage'] if i or not uv_tier else ['uv', 'run', '--frozen', 'coverage']
    shown = ' '.join(head)
elif uv_tier and argv[:1] in (['python'], ['python3']) and argv[1:3] == ['-m', 'pytest']:
    head, i = ['uv', 'run', '--frozen', 'coverage'], 2
    shown = ' '.join(head)
elif argv[:1] in (['python'], ['python3']) and argv[1:3] == ['-m', 'pytest']:
    # car F (A-M3): never python -m coverage (the copy is first on sys.path, so a tree-local coverage
    # package is the tool); 8.1.0 (#75): an inline -I launcher, no file the tests can rewrite; coverage run
    # still gives the test run the cwd, as python -m pytest does
    head, i, shown = argv[:1] + ['-I', '-c', LAUNCH], 2, argv[0] + ' -m coverage'
else:
    emit('not_run', 'unsupported: the coverage gate runs a pytest test_cmd only (got ' + cmd + ')')
if any(os.path.basename(x) in REFUSED for x in argv):
    sys.exit('refusing a terraform-family program in test_cmd')
# the child PATH: an env PATH (absolute entries, none holding a terraform-family name) first, then
# this program's PATH with no entry inside the worktree or the scratch dir; a guard dir before both
scratch = os.path.join(os.path.realpath(os.path.dirname(os.path.realpath(wt))), 'scratch')
path = clean_path((wt, scratch))
if 'PATH' in env_in:
    ents = [e for e in env_in.pop('PATH').split(':') if e]
    if not all(os.path.isabs(e) for e in ents) or any(os.path.lexists(os.path.join(e, n)) for e in ents for n in REFUSED):
        sys.exit('refusing an env PATH with a relative entry or a terraform-family name')
    path = ':'.join(ents + [path])
if any(shutil.which(n, path=path) != shutil.which(n, path=_RAW_PATH) for n in REFUSED):
    sys.exit('refusing a PATH that resolves a terraform-family name differently from the agent PATH')
if head[0] == 'coverage' and not shutil.which('coverage', path=path):
    emit('not_run', 'no coverage tool: coverage is not on PATH')
uv_route = uv_tier and head[0] == 'uv' and argv[:2] != ['uv', 'run']
if uv_route and not shutil.which('uv', path=path):
    emit('not_run', 'no coverage tool: uv is not on PATH')
def uv_refusal():
    # the reason the judged tree may not run coverage through uv, or None (read from git objects, never from the copy)
    def blob(rev, n):
        r = subprocess.run(G + ['-C', wt, 'cat-file', 'blob', rev + ':' + n], capture_output=True, stdin=subprocess.DEVNULL)
        return r.stdout if r.returncode == 0 else None
    def toml(b):
        try:
            import tomllib
            if len(b) > 16777216:
                return None
            t = tomllib.loads(b.decode('utf-8'))
            return t if isinstance(t, dict) else None
        except Exception:
            return None
    # an editable install can put the tree on sys.path: no tree-local coverage package or module may shadow the lock's
    for n in os.fsdecode(git(wt, 'ls-tree', '-r', '-z', '--name-only', tree)).split('\0'):
        if any(c == 'coverage' or re.match(r'^coverage\.(py|pyc|pth|so|pyd)$|^coverage\..*\.(so|pyd)$', c) for c in n.split('/')):
            return 'the judged tree has a path named coverage (' + n + '), which could shadow the locked coverage'
    lb, lt = blob(base, 'uv.lock'), blob(tree, 'uv.lock')
    if lt is None:
        return 'the judged tree has no uv.lock'
    if lb is None:
        return 'the plan base has no uv.lock'
    tb, tt = toml(lb), toml(lt)
    if tt is None:
        return 'the judged uv.lock is not TOML'
    if tb is None:
        return 'the plan base uv.lock is not TOML'
    cov = lambda t: [e for e in t.get('package')] if isinstance(t.get('package'), list) else []
    ct = [e for e in cov(tt) if isinstance(e, dict) and e.get('name') == 'coverage']
    cb = [e for e in cov(tb) if isinstance(e, dict) and e.get('name') == 'coverage']
    if not ct or not all(e.get('source') == PYPI for e in ct):
        return 'the judged uv.lock does not pin coverage from PyPI'
    if ct != cb:
        return 'the judged uv.lock coverage entry differs from the plan base'
    # a path, git, url or directory entry can ship its own coverage script: each must be the base's, as it is
    for e in cov(tt):
        if isinstance(e, dict) and e.get('source') != PYPI and e.get('source') not in ({'editable': '.'}, {'virtual': '.'}) and e not in cov(tb):
            return 'the judged uv.lock has a non-PyPI entry the plan base lacks (' + str(e.get('name')) + ')'
    pp = []
    for rev in (base, tree):
        b = blob(rev, 'pyproject.toml')
        t = {} if b is None else toml(b)
        if t is None:
            return 'pyproject.toml is not TOML'
        pp.append(t)
    tool = [t.get('tool') if isinstance(t.get('tool'), dict) else {} for t in pp]
    uvs = [x.get('uv') for x in tool]
    if uvs[0] != uvs[1]:
        return 'pyproject.toml [tool.uv] differs from the plan base'
    if isinstance(uvs[1], dict) and (not isinstance(uvs[1].get('sources', {}), dict) or 'coverage' in uvs[1].get('sources', {})):
        return 'pyproject.toml [tool.uv.sources] names coverage'
    # the editable install of the judged project: no coverage command of its own, and (broad, fail closed) the
    # build backend and every [tool.*] table but [tool.uv] as at the base, so no package-dir or wheel remap
    pj = pp[1].get('project') if isinstance(pp[1].get('project'), dict) else {}
    eps = [pj.get('scripts'), pj.get('gui-scripts')] + (list(pj.get('entry-points').values()) if isinstance(pj.get('entry-points'), dict) else [pj.get('entry-points')])
    if any(x is not None and (not isinstance(x, dict) or 'coverage' in x) for x in eps):
        return 'pyproject.toml declares a coverage script or entry point'
    if pp[0].get('build-system') != pp[1].get('build-system') or {k: v for k, v in tool[0].items() if k != 'uv'} != {k: v for k, v in tool[1].items() if k != 'uv'}:
        return 'pyproject.toml [build-system] or a [tool] table other than [tool.uv] differs from the plan base'
    for n in ('uv.toml', '.python-version'):
        if blob(base, n) != blob(tree, n):
            return n + ' differs from the plan base'
    return None
if uv_route:
    why = uv_refusal()
    if why:
        emit('not_run', 'uv tier refused: ' + why)
# the added lines of the changed production .py files (added, modified, type-changed); other
# changed source files are listed as not measured
want, other = {}, []
for n in os.fsdecode(git(wt, 'diff', '--name-only', '-z', '--diff-filter=AMT', *D, base, tree)).split('\0'):
    if not n or n in exclude:
        continue
    if not n.endswith('.py'):
        if n.endswith(CODE):
            other.append(n)
        continue
    out = git(wt, 'diff', '-U0', *D, base, tree, '--', n)
    if not out.startswith(b'diff --git '):
        sys.exit('no diff section for a listed path: ' + show(n))
    hunks = list(re.finditer(r'^@@ -\S+ \+(\d+)(?:,(\d+))? @@', out.decode('utf-8', 'replace'), re.M))
    if hunks:
        rows = [x for m in hunks for x in range(int(m.group(1)), int(m.group(1)) + int(m.group(2) if m.group(2) is not None else 1))]
    else:
        # listed but no hunk to parse: fail closed, the whole file is added
        rows = list(range(1, len(git(wt, 'cat-file', 'blob', tree + ':' + n).decode('utf-8', 'replace').rstrip('\n').split('\n')) + 1))
    if rows:
        want[n] = rows
miss_note = 'not measured (not python): ' + ', '.join(other) if other else None
if not want:
    emit('partial' if other else 'ran', miss_note or 'no added line in a production .py file')
os.makedirs(scratch, exist_ok=True)
# security review: the data file and the report live in a random dir outside the scratch dir
# and the copy (never in the child's env), so no test finds them by walking up from the copy
work = tempfile.mkdtemp()
guard = tempfile.mkdtemp(prefix='guard-', dir=scratch)
tmp = tempfile.mkdtemp(prefix='copy-', dir=scratch)
added = False
try:
    for n in REFUSED:
        os.symlink(shutil.which(n, path=_RAW_PATH) or shutil.which('false', path=_RAW_PATH) or '/bin/false', os.path.join(guard, n))
    git(wt, 'worktree', 'add', '--detach', tmp, base + '^{commit}')
    added = True
    git(tmp, 'read-tree', '-u', '--reset', tree)
    # 8.1.0 (#75): the rcfile read-only, the data dir writable in the run step only, the report dir in the json step only
    dirs = [os.path.join(work, x) for x in ('ro', 'data', 'rep')]
    for x in dirs:
        os.mkdir(x)
    rc, data, log, rep = os.path.join(dirs[0], 'rc'), os.path.join(dirs[1], 'data'), os.path.join(work, 'log'), os.path.join(dirs[2], 'cov.json')
    with open(rc, 'w') as fh:
        fh.write('[run]\nsource = .\nrelative_files = True\n[report]\nexclude_lines =\n    (?!x)x\n')
    # no COVERAGE_* variable reaches the child (the build env's COVERAGE_FILE among them): only argv names them
    env = dict(os.environ)
    del env['GIT_LITERAL_PATHSPECS']
    env.update({} if _LIT is None else {'GIT_LITERAL_PATHSPECS': _LIT}, **env_in)
    for k in [k for k in env if k.startswith('COVERAGE_')]:
        del env[k]
    env['PATH'] = guard + ':' + path
    if uv_route:
        env['UV_NO_CONFIG'] = '1'
    cov = ['--rcfile=' + rc, '--data-file=' + data]
    keep = dbsnap(env)
    try:
        code, tail = run(head + ['--version'], tmp, env, log)
        if code != 0:
            emit('not_run', 'no coverage tool: ' + shown + ' --version exit %d' % code)
        code, tail = run(argv, tmp, env, log)
        if code != 0:
            # car F (G2 ruling): once more at the plan base; green there is the change's fault (the workflow stops)
            git(tmp, 'read-tree', '-u', '--reset', base)
            # security review: no untracked or ignored file of the tree's run reaches the base run
            git(tmp, 'clean', '-ffdxq')
            # 8.1.0 (#75, bypass 1): the test database dropped and created again; a fresh sandbox (HOME, /tmp, private dirs)
            cmd2, res = helper('dbreset', {'env': env, 'keep': keep})
            subprocess.run(cmd2, env=os.environ, stdin=subprocess.DEVNULL, capture_output=True, preexec_fn=lift, timeout=max(1, left()))
            r = result(res)
            if not r or not r.get('ok'):
                emit('not_run', 'tree red, base not re-run: ' + (r['reason'] if r else 'the database reset gave no result'))
            bc, tail = run(argv, tmp, env, log)
            if bc == 0:
                emit('not_run', 'tree red, base green: the judged tree fails test_cmd in the scratch copy (exit %d)' % code)
            emit('not_run', 'baseline red in scratch copy at the tree and at the base (exit %d, %d): the environment' % (code, bc))
        code, tail = run(head + ['run'] + cov + ['-m', 'pytest'] + argv[i + 1:], tmp, env, log, [dirs[1]], [dirs[0]])
        if code != 0:
            sys.exit('coverage run exit %d with a green baseline: %s' % (code, tail[-500:]))
        code, tail = run(head + ['json'] + cov + ['-o', rep], tmp, env, log, [dirs[2]], [dirs[0], dirs[1]])
        if code != 0:
            sys.exit('coverage json exit %d: %s' % (code, tail[-500:]))
    except Late:
        emit('partial', 'the %d s deadline was hit before the coverage report' % DEADLINE)
    try:
        with open(rep, 'rb') as fh:
            files = json.loads(fh.read().decode('utf-8')).get('files')
    except (OSError, ValueError, AttributeError):
        files = None
    if not isinstance(files, dict):
        sys.exit('coverage json has no files map')
    got = {}
    for k, v in files.items():
        p = os.path.relpath(k, tmp) if os.path.isabs(k) else os.path.normpath(k)
        # a file with no executed line has no records of its own: not measured (wholly uncovered)
        got[p] = set((v.get('missing_lines') or []) + (v.get('excluded_lines') or [])) if isinstance(v, dict) and v.get('executed_lines') else None
    findings, n = [], 0
    for p in sorted(want):
        miss = got.get(p)
        if miss is None:
            # not measured: every added line that is not blank or a comment
            with open(os.path.join(tmp, p), 'rb') as fh:
                text = fh.read().decode('utf-8', 'replace').split('\n')
            lines = [x for x in want[p] if x <= len(text) and text[x - 1].strip() and not text[x - 1].strip().startswith('#')]
        else:
            lines = [x for x in want[p] if x in miss]
        if lines and n < CAP:
            findings.append({'path': p, 'lines': lines[:CAP - n]})
        n += len(lines)
        if n > CAP:
            emit('partial', 'more than %d uncovered added lines: the first %d are listed' % (CAP, CAP), findings)
    note = '%d uncovered added line(s) in %d file(s)' % (n, len(findings)) if n else None
    emit('partial' if other else 'ran', '; '.join(x for x in (note, miss_note) if x) or None, findings)
finally:
    if added:
        subprocess.run(G + ['-C', wt, 'worktree', 'remove', '--force', tmp], capture_output=True)
    shutil.rmtree(tmp, ignore_errors=True)
    shutil.rmtree(work, ignore_errors=True)
    shutil.rmtree(guard, ignore_errors=True)
    subprocess.run(G + ['-C', wt, 'worktree', 'prune'], capture_output=True)
