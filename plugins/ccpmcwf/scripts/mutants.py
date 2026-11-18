
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
# fleet 8.0.0 (G5, ADR-1316): the mutation gate, a built-in diff-scoped mutator (no external tool).
# Args: <worktree> <base> <tree> <test_cmd> <env json> <exclude json> (those of cover_diff.py).
# A throwaway dir <private mkdtemp work dir>/copy with the files of the judged <tree> and no .git
# (car F, A-M4 and review; restore check: regular files only; the main worktree is never touched). The mutants: comparison flip, boolean swap,
# boundary +-1 and dropped negation, on the tokens (never a string or a comment) of the added
# lines of the changed .py files (git diff -U0 <base> <tree>, the <exclude> paths aside); at
# most 200, spread evenly over the lines (round-robin; a round larger than the room left takes
# evenly spaced lines). The test_cmd (a pytest shape only, <paths> dropped, plus -x and no cache
# plugin) runs once plain (red: once more at <base>; not_run, "tree red, base green" when the base
# is green) and once per mutant, within one 540 s deadline from the
# start (hit: partial, "N of M not run"); a mutant run is bounded by 4x the baseline + 5 s (at
# least 10 s; a timeout counts as killed). After each run the file is put back from its backup
# (a fresh file, never written through a link) and checked byte for byte, and a final hash check
# compares the mutated files with their blobs in the tree: a restore that does not hold exits non-zero. A copy
# a killed run left behind is removed by the next run. Prints {status: ran|partial|not_run,
# reason, killed, survived: [{id, path, line, op}], not_run, budget_hit, args}. No result cache
# (security review): code under test runs as this uid and can write the scratch dir, so a digest
# retry runs the gate again; a mutants-cache.json an older run left is deleted unread. A run that
# cannot start the test_cmd (126, 127) or a runner usage error (pytest 4, 5) exits non-zero; any
# other non-zero exit (a signal or the bound included) is a kill. The child: caps lifted, its own process group, scratch_copy run's
# PATH guard, no COVERAGE_* or FLEET_* var, no bytecode written (a fresh pycache prefix outside
# the scratch dir), no gate-data path. Changed non-python source: partial (python lines too) or
# not_run "unsupported" (none).
# 8.1.0 (#75): every test run is a sandbox.py run (bwrap; no network, HOME, the worktree and its git dir
# hidden), each in a fresh sandbox (the copy a fresh overlay each run, so no run leaves state for the next);
# the base re-run follows a reset of the test database. No sandbox (no bwrap, a failed self-check,
# sandbox.py off its pin): not_run "sandbox unavailable: ...", no test run.
import hashlib, io, json, os, re, shlex, shutil, signal, stat, subprocess, sys, tempfile, time, tokenize
CAP = 200
SANDBOX_SHA256 = '142e66c5318a6699250f656b31be5c5ae3cc155efe5a48d580e221c475d0f65a'
SBX = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'sandbox.py')
_dl = os.environ.get('FLEET_MUTANTS_DEADLINE') or ''
# a test may lower the deadline, never raise it
DEADLINE = min(540, int(_dl)) if re.match(r'^[1-9][0-9]{0,3}$', _dl) else 540
G = ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.quotePath=false', '-c', 'core.attributesFile=/dev/null']
D = ['--text', '--no-textconv', '--no-ext-diff', '--no-renames', '--no-color']
CODE = ('.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.go', '.rs', '.sh', '.bash', '.rb', '.java', '.kt', '.c', '.h', '.cc', '.cpp', '.php', '.pl', '.lua', '.swift', '.scala', '.cs')
REFUSED = {'terraform', 'tofu', 'tfp', 'terragrunt', 'digger', 'atlantis'}
FLIP = {'==': '!=', '!=': '==', '<': '>=', '>=': '<', '>': '<=', '<=': '>'}
BOUND = {'<': '<=', '<=': '<', '>': '>=', '>=': '>'}
BOOL = {'True': 'False', 'False': 'True', 'and': 'or', 'or': 'and'}
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
# a TERM unwinds through the finally blocks: the file is restored and the copy removed
signal.signal(signal.SIGTERM, lambda *_: sys.exit('mutants.py: terminated'))
def emit(status, reason, killed=0, survived=(), not_run=0, budget_hit=False):
    out = {'status': status, 'reason': show(reason), 'killed': killed, 'survived': show(list(survived)), 'not_run': not_run, 'budget_hit': budget_hit}
    out = dict(out, args=sys.argv[1:], program=_PROG)
    out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0)
def git(cwd, *a, env=None):
    r = subprocess.run(G + ['-C', cwd] + list(a), capture_output=True, stdin=subprocess.DEVNULL, env=env)
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
    # sandbox.py <mode> <spec> (the result file it writes); the bytes must match the pin
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
checked = []
def run(argv, cwd, env, log, cap=None):
    # the exit code; the process group dies at the deadline (Late) or at a mutant's own bound (-9: killed)
    if left() <= 1:
        raise Late()
    cmd, res = helper('run', {'cwd': cwd, 'copy': tmp, 'argv': argv, 'env': env, 'git': False, 'check': not checked})
    with open(log, 'wb') as fh:
        try:
            p = subprocess.Popen(cmd, env=os.environ, stdin=subprocess.DEVNULL, stdout=fh, stderr=subprocess.STDOUT, preexec_fn=lift, start_new_session=True)
        except OSError:
            # no runner: the baseline is red (not_run); a mutant run exits non-zero (below)
            return 127
        try:
            p.wait(timeout=left() if cap is None else min(left(), cap))
        except BaseException as e:
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except OSError:
                pass
            p.wait()
            if not isinstance(e, subprocess.TimeoutExpired):
                raise
            if left() <= 1:
                raise Late()
            return -9
    r = result(res)
    if not r or not r.get('started'):
        emit('not_run', 'sandbox unavailable: ' + (r['reason'] if r else 'sandbox.py gave no result (exit %d)' % p.returncode))
    checked.append(1)
    return r['exit']
a = sys.argv[1:]
if len(a) != 6:
    sys.exit('usage: mutants.py <worktree> <base> <tree> <test_cmd> <env json> <exclude json>')
wt, base, tree, cmd = a[0], a[1], a[2], a[3]
try:
    env_in, exclude = json.loads(a[4]), json.loads(a[5])
except ValueError:
    env_in, exclude = None, None
if not os.path.isabs(wt) or not os.path.isdir(wt) or not all(re.match(r'^[0-9a-f]{40}$', x) for x in (base, tree)):
    sys.exit('bad worktree, base or tree')
if not isinstance(env_in, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in env_in.items()) or not isinstance(exclude, list) or not all(isinstance(x, str) for x in exclude):
    sys.exit('env is not a JSON object of strings or exclude is not a JSON list of strings')
# the pytest shapes of the workflow's testRunnerPrefix (as cover_diff.py)
try:
    argv = [x for x in shlex.split(cmd) if x != '<paths>']
except ValueError:
    argv = []
i = 0
if argv[:2] == ['uv', 'run']:
    i = 2
    while i < len(argv) and (argv[i] in ('--frozen', '--no-sync') or (argv[i] == '--extra' and i + 1 < len(argv))):
        i += 2 if argv[i] == '--extra' else 1
if argv[i:i + 1] != ['pytest'] and not (argv[:1] in (['python'], ['python3']) and argv[1:3] == ['-m', 'pytest']):
    emit('not_run', 'unsupported: the mutation gate runs a pytest test_cmd only (got ' + cmd + ')')
if any(os.path.basename(x) in REFUSED for x in argv):
    sys.exit('refusing a terraform-family program in test_cmd')
scratch = os.path.join(os.path.realpath(os.path.dirname(os.path.realpath(wt))), 'scratch')
path = clean_path((wt, scratch))
if 'PATH' in env_in:
    ents = [e for e in env_in.pop('PATH').split(':') if e]
    if not all(os.path.isabs(e) for e in ents) or any(os.path.lexists(os.path.join(e, n)) for e in ents for n in REFUSED):
        sys.exit('refusing an env PATH with a relative entry or a terraform-family name')
    path = ':'.join(ents + [path])
if any(shutil.which(n, path=path) != shutil.which(n, path=_RAW_PATH) for n in REFUSED):
    sys.exit('refusing a PATH that resolves a terraform-family name differently from the agent PATH')
os.makedirs(scratch, exist_ok=True)
# the cache file of an earlier build of this program: never read, deleted
try:
    os.unlink(os.path.join(scratch, 'mutants-cache.json'))
except OSError:
    pass
# the added lines of the changed production .py files (added, modified, type-changed); a file
# with no hunk to parse counts as wholly added; other changed source files are not mutated
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
        rows = list(range(1, len(git(wt, 'cat-file', 'blob', tree + ':' + n).decode('utf-8', 'replace').rstrip('\n').split('\n')) + 1))
    if rows:
        want[n] = set(rows)
notes = ['not mutated (not python): ' + ', '.join(other)] if other else []
if not want:
    if other:
        emit('not_run', 'unsupported: no added line in a production .py file; ' + notes[0])
    emit('ran', 'no added line in a production .py file')
def cands(p, text, rows):
    # per line, in token order: (path, line, col0, col1, new, op)
    per = {}
    toks = list(tokenize.generate_tokens(io.StringIO(text).readline))
    for j, t in enumerate(toks):
        (l, c0), (l1, c1), s = t.start, t.end, t.string
        if l not in rows or l != l1:
            continue
        got = []
        if t.type == tokenize.OP:
            got += [(c1, FLIP[s], 'flip')] if s in FLIP else []
            got += [(c1, BOUND[s], 'boundary')] if s in BOUND else []
        elif t.type == tokenize.NAME and s in BOOL:
            got.append((c1, BOOL[s], 'bool'))
        elif t.type == tokenize.NAME and s == 'not' and j + 1 < len(toks) and toks[j + 1].start[0] == l:
            got.append((toks[j + 1].start[1], '', 'negation'))
        elif t.type == tokenize.NUMBER and re.match(r'^(0|[1-9][0-9]*)$', s):
            got += [(c1, str(int(s) + 1), 'boundary'), (c1, str(int(s) - 1), 'boundary')]
        for e, new, k in got:
            per.setdefault(l, []).append((p, l, c0, e, new, k + ': ' + ('drop not' if k == 'negation' else s + ' -> ' + new)))
    return per
def put(f, data, mode):
    # a fresh file in place of whatever is there (never written through a link), read back
    try:
        fd, t = tempfile.mkstemp(prefix='.mut-', dir=os.path.dirname(f))
        with os.fdopen(fd, 'wb') as fh:
            fh.write(data)
        os.chmod(t, mode)
        os.replace(t, f)
        with open(f, 'rb') as fh:
            ok = not os.path.islink(f) and fh.read() == data
    except OSError as e:
        sys.exit('restore of ' + f + ' failed: ' + str(e))
    if not ok:
        sys.exit('restore of ' + f + ' did not hold')
# the copies (and guard dirs) a killed run left behind
for n in os.listdir(scratch):
    if n.startswith('mut-') and os.path.isdir(os.path.join(scratch, n)):
        subprocess.run(G + ['-C', wt, 'worktree', 'remove', '--force', os.path.join(scratch, n)], capture_output=True)
        shutil.rmtree(os.path.join(scratch, n), ignore_errors=True)
subprocess.run(G + ['-C', wt, 'worktree', 'prune'], capture_output=True)
work = tempfile.mkdtemp()
guard = tempfile.mkdtemp(prefix='mut-guard-', dir=scratch)
# car F (review): the copy sits in the private work dir, not beside the worktree (8.1.0, #75: the sandbox
# hides the worktree and its git dir from code under test)
tmp = os.path.join(work, 'copy')
def fill(rev):
    # car F (A-M4): a plain dir with the files of <rev> and no .git (a temp index outside the copy), so
    # code under test cannot see a mutant with git diff; a fresh dir each time (the base run: no file of
    # the tree's run stays)
    shutil.rmtree(tmp, ignore_errors=True)
    os.mkdir(tmp, 0o700)
    e = dict(os.environ, GIT_INDEX_FILE=os.path.join(work, 'idx'))
    git(wt, 'read-tree', rev, env=e)
    git(wt, 'checkout-index', '-a', '-f', '--prefix=' + tmp + '/', env=e)
try:
    for n in REFUSED:
        os.symlink(shutil.which(n, path=_RAW_PATH) or shutil.which('false', path=_RAW_PATH) or '/bin/false', os.path.join(guard, n))
    fill(tree)
    # the mutants, from the copy's own files (what the tests import)
    orig, per, bad = {}, [], []
    for p in sorted(want):
        f = os.path.join(tmp, p)
        try:
            with open(f, 'rb') as fh:
                orig[p] = (fh.read(), os.stat(f).st_mode & 0o7777)
            c = cands(p, orig[p][0].decode('utf-8'), want[p])
        except (OSError, UnicodeDecodeError, SyntaxError, tokenize.TokenError):
            orig.pop(p, None)
            bad.append(p)
            continue
        per += [c[l] for l in sorted(c)]
    if bad:
        notes.append('not mutated (unreadable or not tokenizable): ' + ', '.join(bad))
    total = sum(len(x) for x in per)
    sel, r = [], 0
    while len(sel) < CAP and any(len(x) > r for x in per):
        row = [x[r] for x in per if len(x) > r]
        room = CAP - len(sel)
        sel += row if len(row) <= room else [row[(j * len(row)) // room] for j in range(room)]
        r += 1
    # stable: token order within a line
    sel.sort(key=lambda m: (m[0], m[1], m[2]))
    if total > len(sel):
        notes.append('%d of %d candidates sampled' % (len(sel), total))
    M = len(sel)
    st = 'partial' if other or bad else 'ran'
    if not M:
        emit(st, '; '.join(['no mutant on the added lines'] + notes))
    env = dict(os.environ)
    del env['GIT_LITERAL_PATHSPECS']
    env.update({} if _LIT is None else {'GIT_LITERAL_PATHSPECS': _LIT}, **env_in)
    for k in [k for k in env if k.startswith(('COVERAGE_', 'FLEET_'))]:
        del env[k]
    env['PATH'] = guard + ':' + path
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    env['PYTHONPYCACHEPREFIX'] = os.path.join(work, 'pyc')
    run_argv = argv + ['-x', '-p', 'no:cacheprovider']
    log = os.path.join(work, 'log')
    killed, surv, done = 0, [], 0
    late = lambda n: emit('partial', '; '.join(['%d of %d not run: the %d s deadline was hit' % (n, M, DEADLINE)] + notes), killed, surv, n, True)
    t0 = time.monotonic()
    try:
        code = run(run_argv, tmp, env, log)
    except Late:
        late(M)
    if code != 0:
        # car F (G2 ruling): once more at the plan base; green there is the change's fault (the workflow stops)
        # security review: a fresh copy, so no untracked or ignored file of the tree's run reaches the base run
        fill(base)
        # 8.1.0 (#75, bypass 1): the test database dropped and created again; a fresh sandbox (HOME, /tmp, private dirs)
        cmd2, res = helper('dbreset', {'env': env})
        subprocess.run(cmd2, env=os.environ, stdin=subprocess.DEVNULL, capture_output=True, preexec_fn=lift, timeout=max(1, left()))
        r = result(res)
        if not r or not r.get('ok'):
            emit('not_run', 'tree red, base not re-run: ' + (r['reason'] if r else 'the database reset gave no result'))
        try:
            bc = run(run_argv, tmp, env, log)
        except Late:
            late(M)
        if bc == 0:
            emit('not_run', 'tree red, base green: the judged tree fails test_cmd in the scratch copy (exit %d)' % code)
        emit('not_run', 'baseline red in scratch copy at the tree and at the base (exit %d, %d): the environment' % (code, bc))
    bound = max(10.0, 4 * (time.monotonic() - t0) + 5)
    try:
        for k, (p, l, c0, c1, new, op) in enumerate(sel):
            f = os.path.join(tmp, p)
            lines = orig[p][0].decode('utf-8').split('\n')
            lines[l - 1] = lines[l - 1][:c0] + new + lines[l - 1][c1:]
            put(f, '\n'.join(lines).encode('utf-8'), orig[p][1])
            try:
                code = run(run_argv, tmp, env, log, bound)
            finally:
                put(f, *orig[p])
            if code in (4, 5, 126, 127):
                sys.exit('a mutant run could not run the test_cmd: exit %d (a usage error or no runner)' % code)
            done += 1
            if code == 0:
                surv.append({'id': 'm%d' % (k + 1), 'path': p, 'line': l, 'op': op})
            else:
                killed += 1
    except Late:
        pass
    # the hash check (no .git in the copy): every mutated file hashes to its blob in the tree again
    ps = sorted(orig)
    for p in ps:
        try:
            reg = stat.S_ISREG(os.lstat(os.path.join(tmp, p)).st_mode)
        except OSError:
            reg = False
        if not reg:
            sys.exit('restore check: ' + p + ' is not a regular file in the copy after the mutant runs')
    if ps and git(wt, 'hash-object', '--no-filters', '--', *[os.path.join(tmp, p) for p in ps]).split() != git(wt, 'rev-parse', *[tree + ':' + p for p in ps]).split():
        sys.exit('restore check: the copy differs from the judged tree after the mutant runs')
    if done < M:
        late(M - done)
    emit(st, '; '.join(['%d killed, %d survived of %d mutant(s)' % (killed, len(surv), M)] + notes), killed, surv)
finally:
    shutil.rmtree(tmp, ignore_errors=True)
    shutil.rmtree(work, ignore_errors=True)
    shutil.rmtree(guard, ignore_errors=True)
    subprocess.run(G + ['-C', wt, 'worktree', 'prune'], capture_output=True)
