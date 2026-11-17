
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
import base64, json, os, re, shutil, subprocess, sys, tempfile
# fleet 7.3.0 (#54, L2189): the throwaway copy a role runs stubs, reverts, mutants and probes
# in, with fixed git arguments and no shell. The scratch dir is derived here from the
# worktree (<dirname(worktree)>/scratch, the fleet layout), never taken from the caller.
#   make <worktree> [<rev>]: a detached worktree <scratch>/copy-* (hooks off). No rev: at HEAD,
#     with every changed and untracked path of <worktree> copied in and every deleted path
#     deleted (the CURRENT working tree). A rev: that commit, nothing copied.
#     Prints {tmp, rev, copied, deleted, args}.
#   run <worktree> <tmp> <argv json> [<env json>]: argv with cwd <tmp> and env added; the
#     program's caps are lifted for the child. Prints {exit_code, tail, args}.
#   patch <worktree> <tmp> <file> <old b64> <new b64>: replace the one occurrence of old by new
#     in <tmp>/<file> (a regular file). Prints {patched, args}. The judges have no Edit tool.
#   remove <worktree> <tmp>: worktree remove --force, then prune. Prints {removed, args}.
# 7.3.0 review (M1): run, patch and remove act only on a <tmp> that is a direct child
# copy-* of the derived scratch dir AND a worktree <worktree> registers.
TAIL = 6000
G = ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.quotePath=false']
# no terraform-family program anywhere in argv (a wrapper such as timeout or env is no way
# around it), and no shell given a command string
REFUSED = {'terraform', 'tofu', 'tfp', 'terragrunt', 'digger', 'atlantis'}
SHELLS = {'sh', 'bash', 'zsh', 'dash', 'ksh'}
os.environ['GIT_TERMINAL_PROMPT'] = '0'
def emit(out):
    out['program'] = _PROG
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0)
def git(cwd, *a, env=None, check=True):
    r = subprocess.run(G + ['-C', cwd] + list(a), capture_output=True, env=env)
    if check and r.returncode != 0:
        sys.exit(r.stderr.decode('utf-8', 'replace')[-2000:] or 'git ' + ' '.join(a[:2]) + ' failed')
    return r
def scratch_of(wt):
    if not os.path.isabs(wt) or not os.path.isdir(wt):
        sys.exit('bad worktree: ' + wt)
    return os.path.join(os.path.realpath(os.path.dirname(os.path.realpath(wt))), 'scratch')
def copy_of(wt, tmp):
    # <tmp>: a direct child copy-* of the derived scratch dir, registered as a worktree of <wt>
    s = scratch_of(wt)
    t = os.path.realpath(tmp)
    if not os.path.isabs(tmp) or os.path.dirname(t) != s or not os.path.basename(t).startswith('copy-') or not os.path.isdir(t):
        sys.exit('refusing a copy that is not ' + s + '/copy-*: ' + tmp)
    reg = set()
    for line in git(wt, 'worktree', 'list', '--porcelain', '-z').stdout.split(b'\0'):
        if line.startswith(b'worktree '):
            reg.add(os.path.realpath(line[9:].decode('utf-8', 'replace')))
    if t not in reg:
        sys.exit('refusing a copy no worktree of ' + wt + ' registers: ' + tmp)
    return t
def names(b):
    return [x.decode('utf-8', 'replace') for x in b.split(b'\0') if x]
mode = sys.argv[1] if len(sys.argv) > 1 else ''
args = sys.argv[2:]
if mode == 'make' and len(args) in (1, 2):
    wt = args[0]
    scratch = scratch_of(wt)
    rev = args[1] if len(args) == 2 else 'HEAD'
    if rev.startswith('-'):
        sys.exit('bad rev: ' + rev)
    os.makedirs(scratch, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix='copy-', dir=scratch)
    git(wt, 'worktree', 'add', '--detach', tmp, rev + '^{commit}')
    copied, deleted = [], []
    if len(args) == 1:
        # the working tree in a temporary index: changed and untracked paths (ignored ones not)
        fd, idx = tempfile.mkstemp(dir=scratch)
        os.close(fd)
        try:
            env = dict(os.environ, GIT_INDEX_FILE=idx)
            git(wt, 'read-tree', 'HEAD', env=env)
            git(wt, 'add', '-A', env=env)
            tree = git(wt, 'write-tree', env=env).stdout.decode().strip()
        finally:
            os.unlink(idx)
        out = names(git(wt, 'diff-tree', '-r', '-z', '--name-status', '--no-renames', 'HEAD^{tree}', tree).stdout)
        rt = os.path.realpath(tmp)
        for k in range(0, len(out) - 1, 2):
            st, p = out[k], out[k + 1]
            dst = os.path.join(tmp, p)
            d = os.path.realpath(os.path.dirname(dst))
            if d != rt and not d.startswith(rt + os.sep):
                sys.exit('refusing a path outside the copy: ' + p)
            if st == 'D':
                if os.path.lexists(dst):
                    os.unlink(dst)
                deleted.append(p)
                continue
            src = os.path.join(wt, p)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            if os.path.lexists(dst):
                os.unlink(dst)
            if os.path.islink(src):
                os.symlink(os.readlink(src), dst)
            else:
                shutil.copy2(src, dst)
            copied.append(p)
    emit({'tmp': tmp, 'rev': rev, 'copied': sorted(copied), 'deleted': sorted(deleted), 'args': args})
elif mode == 'run' and len(args) in (3, 4):
    tmp = copy_of(args[0], args[1])
    try:
        argv = json.loads(args[2])
        env = json.loads(args[3]) if len(args) == 4 else {}
    except ValueError:
        argv, env = None, None
    if not isinstance(argv, list) or not argv or not all(isinstance(x, str) for x in argv):
        sys.exit('argv is not a non-empty JSON list of strings')
    if not isinstance(env, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in env.items()):
        sys.exit('env is not a JSON object of strings')
    # an env PATH (test_cmd.env, a venv's bin) goes first, then this program's PATH; its
    # entries must be absolute (a relative one would resolve against the copy).
    # The primary guard (security review): the child's PATH lookup of a terraform-family
    # name resolves exactly as the agent PATH does (the nix shim path_check verified, or
    # nothing), so an env PATH dir that holds such a name is refused.
    path = _RAW_PATH
    if 'PATH' in env:
        ents = [e for e in env.pop('PATH').split(':') if e]
        if not all(os.path.isabs(e) for e in ents):
            sys.exit('refusing a relative PATH entry in env')
        bad = [os.path.join(e, n) for e in ents for n in sorted(REFUSED) if os.path.lexists(os.path.join(e, n))]
        if bad:
            sys.exit('refusing an env PATH dir that holds ' + ', '.join(bad) + ' (it would shadow the agent PATH)')
        path = ':'.join(ents + ([_RAW_PATH] if _RAW_PATH else []))
    if any(shutil.which(n, path=path) != shutil.which(n, path=_RAW_PATH) for n in REFUSED):
        sys.exit('refusing a PATH that resolves a terraform-family name differently from the agent PATH')
    # defense in depth only: argv forms that run a program string inline. Only the options
    # before the program's first operand count (a script's or module's own args do not; a shell: all).
    VAL = {'python': ('-W', '-X', '-Q'), 'node': ('-r', '--require', '--import', '--loader'), 'git': ('-c', '-C', '--config-env', '--git-dir', '--work-tree', '--namespace'), 'env': ('-u', '--unset', '-C', '--chdir')}
    # 7.4.0 (#70): more value-taking options; the scan with the old table runs too (either refuses)
    VAL2 = dict(VAL, python=VAL['python'] + ('--check-hash-based-pycs',), node=VAL['node'] + ('-C', '--conditions', '--title', '--input-type'), perl=('-I', '-r'), ruby=('-I', '-r'))
    def lead(rest, kind, val=VAL):
        # [(option, value or None)] up to the first operand; python stops at -m
        out, k = [], 0
        while k < len(rest) and rest[k].startswith('-') and rest[k] != '--':
            o = rest[k]
            if kind == 'python' and o == '-m':
                break
            v = rest[k + 1] if o in val.get(kind, ()) and k + 1 < len(rest) else None
            out.append((o, v))
            k += 2 if v is not None else 1
        if kind == 'env':
            # env NAME=VALUE ... before the command
            while k < len(rest) and '=' in rest[k] and not rest[k].startswith('-'):
                k += 1
        return out
    def cluster(x, letters):
        return re.fullmatch(r'-[A-Za-z]*[' + letters + r'][A-Za-z]*', x) is not None
    for i, a in enumerate(argv):
        b, rest = os.path.basename(a), argv[i + 1:]
        if b in REFUSED:
            sys.exit('refusing ' + b + ' (no terraform-family program runs here)')
        py = re.fullmatch(r'python[0-9.]*', b) is not None
        kind = 'sh' if b in SHELLS else 'python' if py else 'node' if b in ('node', 'nodejs') else b
        opts = lead(rest, kind) + lead(rest, kind, VAL2) if kind in ('python', 'node', 'perl', 'ruby', 'env', 'git') else []
        if kind == 'sh':
            # 7.4.0 (#70): a shell's whole argv (+O/+o and value options no longer end the scan)
            opts = [(x, None) for x in rest]
        inline = (
            (kind in ('sh', 'python') and any(cluster(o, 'c') for o, v in opts))
            or (kind == 'node' and any(cluster(o, 'ep') or o.split('=')[0] in ('--eval', '--print') for o, v in opts))
            or (kind == 'perl' and any(cluster(o, 'eE') for o, v in opts))
            or (kind == 'ruby' and any(cluster(o, 'e') for o, v in opts))
            or (kind == 'env' and any(cluster(o, 'S') or o.startswith('--split-string') for o, v in opts))
            or (kind == 'git' and any(re.match(r'(-c)?alias\.', (v or o).lower()) or (o.startswith('--config-env') and 'alias.' in (v or o).lower()) for o, v in opts))
        )
        if inline:
            sys.exit('refusing ' + b + ' with an inline program string (run an argv list or a script file)')
    exe = shutil.which(argv[0], path=path)
    if exe and os.path.basename(os.path.realpath(exe)) in REFUSED:
        sys.exit('refusing ' + argv[0] + ': it resolves to ' + os.path.realpath(exe))
    # a guard dir goes first: one link per terraform-family name to what the agent PATH
    # resolves it to (the shim), else to false, so a file the child writes into an env PATH
    # dir later (a venv bin) never shadows it
    guard = tempfile.mkdtemp(prefix='guard-', dir=scratch_of(args[0]))
    stop = shutil.which('false', path=_RAW_PATH) or '/bin/false'
    for n in REFUSED:
        os.symlink(shutil.which(n, path=_RAW_PATH) or stop, os.path.join(guard, n))
    path = guard + (':' + path if path else '')
    def lift():
        # the repo's own commands are not bound by this program's caps
        for k in (_r.RLIMIT_AS, _r.RLIMIT_CPU):
            _r.setrlimit(k, (_r.getrlimit(k)[1],) * 2)
    try:
        p = subprocess.run(argv, cwd=tmp, env=dict(os.environ, **env, PATH=path), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, preexec_fn=lift)
        code, text = p.returncode, p.stdout.decode('utf-8', 'replace')
    except OSError as e:
        code, text = 127, str(e)
    finally:
        shutil.rmtree(guard, ignore_errors=True)
    emit({'exit_code': code, 'tail': text[-TAIL:], 'args': args})
elif mode == 'patch' and len(args) == 5:
    tmp = copy_of(args[0], args[1])
    rel = args[2]
    try:
        old = base64.b64decode(args[3], validate=True)
        new = base64.b64decode(args[4], validate=True)
    except ValueError:
        sys.exit('old and new must be base64')
    if not old:
        sys.exit('old is empty')
    f = os.path.join(tmp, rel)
    real = os.path.realpath(f)
    if os.path.isabs(rel) or not real.startswith(tmp + os.sep) or os.path.islink(f) or not os.path.isfile(f):
        sys.exit('refusing a file that is not a regular file inside the copy: ' + rel)
    with open(real, 'rb') as fh:
        data = fh.read()
    n = data.count(old)
    if n != 1:
        sys.exit('old occurs %d times in %s (needs exactly 1)' % (n, rel))
    with open(real, 'wb') as fh:
        fh.write(data.replace(old, new, 1))
    emit({'patched': rel, 'args': args[:3]})
elif mode == 'remove' and len(args) == 2:
    wt, tmp = args[0], copy_of(args[0], args[1])
    git(wt, 'worktree', 'remove', '--force', tmp, check=False)
    shutil.rmtree(tmp, ignore_errors=True)
    git(wt, 'worktree', 'prune', check=False)
    emit({'removed': not os.path.lexists(tmp), 'args': args})
else:
    sys.exit('usage: make <worktree> [<rev>] | run <worktree> <tmp> <argv json> [<env json>] | patch <worktree> <tmp> <file> <old b64> <new b64> | remove <worktree> <tmp>')
