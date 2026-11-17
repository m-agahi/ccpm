
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
import json, os, shutil, subprocess, sys, tempfile
# fleet 7.3.0 (#54, L2189): the throwaway copy a role runs stubs, reverts, mutants and probes
# in, with fixed git arguments and no shell. Every <tmp> is a new dir under <scratch_dir>.
#   make <worktree> <scratch_dir> [<rev>]: a detached worktree (hooks off). No rev: at HEAD,
#     with every changed and untracked path of <worktree> copied in and every deleted path
#     deleted (the CURRENT working tree). A rev: that commit, nothing copied.
#     Prints {tmp, rev, copied, deleted, args}.
#   run <scratch_dir> <tmp> <argv json> [<env json>]: argv with cwd <tmp> and env added; the
#     program's caps are lifted for the child. Prints {exit_code, tail, args}.
#   remove <worktree> <scratch_dir> <tmp>: worktree remove --force, then prune. Prints {removed, args}.
TAIL = 6000
G = ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.quotePath=false']
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
def under(tmp, scratch):
    # <tmp> is a dir strictly below <scratch_dir> (real paths)
    s = os.path.realpath(scratch)
    t = os.path.realpath(tmp)
    if not os.path.isabs(tmp) or not t.startswith(s.rstrip('/') + '/'):
        sys.exit('refusing a copy outside the scratch dir: ' + tmp)
    return t
def names(b):
    return [x.decode('utf-8', 'replace') for x in b.split(b'\0') if x]
mode = sys.argv[1] if len(sys.argv) > 1 else ''
args = sys.argv[2:]
if mode == 'make' and len(args) in (2, 3):
    wt, scratch = args[0], args[1]
    rev = args[2] if len(args) == 3 else 'HEAD'
    if rev.startswith('-'):
        sys.exit('bad rev: ' + rev)
    os.makedirs(scratch, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix='copy-', dir=scratch)
    git(wt, 'worktree', 'add', '--detach', tmp, rev + '^{commit}')
    copied, deleted = [], []
    if len(args) == 2:
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
            if not os.path.realpath(os.path.dirname(dst)).startswith(rt):
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
    tmp = under(args[1], args[0])
    try:
        argv = json.loads(args[2])
        env = json.loads(args[3]) if len(args) == 4 else {}
    except ValueError:
        argv, env = None, None
    if not isinstance(argv, list) or not argv or not all(isinstance(x, str) for x in argv):
        sys.exit('argv is not a non-empty JSON list of strings')
    if not isinstance(env, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in env.items()):
        sys.exit('env is not a JSON object of strings')
    def lift():
        # the repo's own commands are not bound by this program's caps
        for k in (_r.RLIMIT_AS, _r.RLIMIT_CPU):
            _r.setrlimit(k, (_r.getrlimit(k)[1],) * 2)
    try:
        p = subprocess.run(argv, cwd=tmp, env=dict(os.environ, PATH=_RAW_PATH, **env), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, preexec_fn=lift)
        code, text = p.returncode, p.stdout.decode('utf-8', 'replace')
    except OSError as e:
        code, text = 127, str(e)
    emit({'exit_code': code, 'tail': text[-TAIL:], 'args': args})
elif mode == 'remove' and len(args) == 3:
    wt, tmp = args[0], under(args[2], args[1])
    git(wt, 'worktree', 'remove', '--force', tmp, check=False)
    shutil.rmtree(tmp, ignore_errors=True)
    git(wt, 'worktree', 'prune', check=False)
    emit({'removed': not os.path.lexists(tmp), 'args': args})
else:
    sys.exit('usage: make <worktree> <scratch_dir> [<rev>] | run <scratch_dir> <tmp> <argv json> [<env json>] | remove <worktree> <scratch_dir> <tmp>')
