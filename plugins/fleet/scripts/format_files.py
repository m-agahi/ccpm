
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
import glob, hashlib, json, os, re, shutil, subprocess, sys, tempfile
wt, sel, frozen = sys.argv[1], json.loads(sys.argv[2]), set(json.loads(sys.argv[3]))
scratch_root, tmo = sys.argv[4], int(sys.argv[5])
# no PATH entry inside the worktree or the scratch dir: pre-commit and the
# hooks it runs resolve their tools as the agent's shell would, minus the repo
os.environ['PATH'] = clean_path([wt, scratch_root])
# argv[6] (tests only): 'no-yaml' behaves as if no Python had PyYAML;
# 'no-local-yaml' skips only this python3 as a fallback
no_yaml = len(sys.argv) > 6 and sys.argv[6] == 'no-yaml'
no_local_yaml = len(sys.argv) > 6 and sys.argv[6] == 'no-local-yaml'
def lift():
    # the repo's own hooks (node, linters) are not bound by this program's caps
    for k in (_r.RLIMIT_AS, _r.RLIMIT_CPU):
        _r.setrlimit(k, (_r.getrlimit(k)[1],) * 2)
G = ['git', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false']
def git(cwd, *a, env=None, check=True):
    r = subprocess.run(G + ['-C', cwd] + list(a), capture_output=True, env=env)
    if check and r.returncode != 0:
        sys.exit(r.stderr.decode('utf-8', 'replace'))
    return r
def snapshot(cwd):
    fd, idx = tempfile.mkstemp()
    os.close(fd)
    try:
        env = dict(os.environ, GIT_INDEX_FILE=idx, GIT_CONFIG_NOSYSTEM='1')
        git(cwd, 'read-tree', 'HEAD', env=env)
        git(cwd, 'add', '-A', env=env)
        return git(cwd, 'write-tree', env=env).stdout.decode().strip()
    finally:
        os.unlink(idx)
def names(b):
    return [x.decode('utf-8', 'replace') for x in b.split(b'\0') if x]
def done(**k):
    out = {'ran': False, 'reason': '', 'runs': 0, 'stable': True, 'files': [], 'changed': [], 'refused': []}
    out.update(k)
    out['program'] = _PROG
    out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
    print(json.dumps(out, sort_keys=True, ensure_ascii=False))
    sys.exit(0)
before = snapshot(wt)
if sel.get('dirty') is True:
    cand = names(git(wt, 'diff-tree', '-r', '-z', '--name-only', '--no-renames', 'HEAD^{tree}', before).stdout)
else:
    cand = list(sel.get('paths') or [])
tracked, links = set(), set()
for rec in git(wt, 'ls-tree', '-r', '-z', 'HEAD').stdout.split(b'\0'):
    if not rec:
        continue
    meta, _, path = rec.partition(b'\t')
    path = path.decode('utf-8', 'replace')
    tracked.add(path)
    if meta.split()[0] == b'120000':
        links.add(path)
def differs(p):
    if p not in tracked:
        return os.path.lexists(os.path.join(wt, p))
    return git(wt, 'diff', '--quiet', 'HEAD', '--', p, check=False).returncode != 0
# the hook surface: the config, every path its hook entries and args name
# exactly, and the module files of every -m module an entry runs (paths in a
# files:/exclude: regex are not hook code and stay formattable)
head_cfg = git(wt, 'show', 'HEAD:.pre-commit-config.yaml', check=False)
surface = {'.pre-commit-config.yaml'}
# The config is read with PyYAML, never by a line parser: pre-commit's own
# interpreter has it (pre-commit depends on PyYAML). Follow the pre-commit
# executable's shebang, and a shell wrapper's exec target (pipx, nix), to that
# Python; then this python3 if it has PyYAML. None found: nothing runs.
LOADER = (
    "import json, site, sys\n"
    "import resource\n"
    "for k, v in ((resource.RLIMIT_AS, 1 << 30), (resource.RLIMIT_CPU, 60)):\n"
    "    h = resource.getrlimit(k)[1]\n"
    "    resource.setrlimit(k, (v if h == resource.RLIM_INFINITY else min(v, h), h))\n"
    "for p in sys.argv[1:]:\n"
    "    if p.startswith('/nix/store/'):\n"
    "        site.addsitedir(p)\n"
    "try:\n    import yaml\nexcept ImportError:\n    sys.exit(3)\n"
    # 3.1.0 security review: alias amplification. At most 256 KiB in, only
    # strings out (an alias is never walked or stringified), at most 1 MiB out.
    "raw = sys.stdin.buffer.read(262145)\n"
    "if len(raw) > 262144:\n    sys.exit(5)\n"
    "d = yaml.safe_load(raw)\n"
    "n = [0]\n"
    "def grow(k):\n    n[0] += k\n    if n[0] > 1048576:\n        sys.exit(4)\n"
    "def s(h, k):\n    v = h.get(k)\n    if v is None:\n        return None\n    if not isinstance(v, str):\n        sys.exit(6)\n    grow(len(v))\n    return v\n"
    "out = []\n"
    "for r in (d.get('repos') if isinstance(d, dict) else None) or []:\n"
    "    for h in (r.get('hooks') if isinstance(r, dict) else None) or []:\n"
    "        if isinstance(h, dict):\n"
    "            a = h.get('args')\n"
    "            if a is not None and not (isinstance(a, list) and all(isinstance(x, str) for x in a)):\n"
    "                sys.exit(7)\n"
    "            for x in a or []:\n                grow(len(x))\n"
    "            out.append({'entry': s(h, 'entry'), 'args': a or [], 'language': s(h, 'language')})\n"
    "print(json.dumps(out))\n"
)
LOADER_EXITS = {4: 'the loader output over 1 MiB', 5: 'the config is over 256 KiB', 6: 'a hook entry or language is not a string', 7: 'a hook args is not a list of strings'}
SHELLS = ('sh', 'bash', 'dash', 'zsh', 'ksh')
NIX_SITE = re.compile(r"'(/nix/store/[^'\s]+/site-packages)'")
def interpreters(path, depth=0):
    # [(interpreter, site dirs)]: a script's shebang interpreter, with the
    # /nix/store site-packages a nix wrapped script adds to sys.path itself
    try:
        with open(path, 'rb') as fh:
            head = fh.read(262144)
    except OSError:
        return []
    if not head.startswith(b'#!'):
        return []
    words = head.split(b'\n', 1)[0][2:].decode('utf-8', 'replace').split()
    if not words:
        return []
    interp = words[0]
    if os.path.basename(interp) == 'env':
        prog = next((w for w in words[1:] if not w.startswith('-') and '=' not in w), None)
        interp = shutil.which(prog) if prog else None
    text = head.decode('utf-8', 'replace')
    sites = [m for line in text.splitlines()[:12] if 'site.addsitedir' in line or 'sys.path' in line for m in NIX_SITE.findall(line)]
    out = [(interp, sites)] if interp else []
    if interp and os.path.basename(interp) in SHELLS and depth < 3:
        for t in re.findall(rb'exec\s+(?:-a\s+\S+\s+)?["\']?(/[^\s"\']+)', head):
            t = t.decode('utf-8', 'replace')
            if not os.path.isfile(t):
                continue
            # a script target names its interpreter; a binary target may be one
            with open(t, 'rb') as fh:
                script = fh.read(2) == b'#!'
            if script:
                out.extend(interpreters(t, depth + 1))
            else:
                out.append((t, []))
    return out
def hook_values():
    # (values, None) or (None, why). The loader runs isolated (-I) from /, so
    # no yaml.py, json.py or site.py in the worktree can shadow a module.
    cands = []
    pc = shutil.which('pre-commit')
    if pc:
        cands.extend(interpreters(os.path.realpath(pc)))
        cands.extend(interpreters(pc))
    if not no_local_yaml:
        cands.append((sys.executable, []))
    seen = set()
    if len(head_cfg.stdout) > 262144:
        return None, 'the config is over 256 KiB'
    for c, sites in cands:
        if not c or (c, tuple(sites)) in seen or os.path.basename(c) in SHELLS or os.path.basename(c) == 'env':
            continue
        seen.add((c, tuple(sites)))
        if no_yaml:
            continue
        try:
            r = subprocess.run([c, '-I', '-c', LOADER] + sites, input=head_cfg.stdout, capture_output=True, timeout=60, cwd='/')
        except OSError:
            continue
        except subprocess.TimeoutExpired:
            return None, 'the YAML loader timed out (' + c + ')'
        if r.returncode in LOADER_EXITS:
            return None, LOADER_EXITS[r.returncode]
        if r.returncode == 3 or (r.returncode != 0 and b'No module named' in r.stderr):
            continue
        if r.returncode != 0:
            return None, 'the config does not parse with PyYAML (' + c + '): ' + (r.stderr.decode('utf-8', 'replace').strip().splitlines() or [''])[-1]
        try:
            hooks = json.loads(r.stdout)
        except ValueError:
            continue
        vals = []
        for h in hooks if isinstance(hooks, list) else []:
            if isinstance(h, dict):
                if isinstance(h.get('entry'), str):
                    vals.append(h['entry'])
                for x in h.get('args') or []:
                    vals.append(x)
        return vals, None
    return None, 'no Python with PyYAML found (tried pre-commit\'s interpreter' + ('' if no_local_yaml else ' and ' + sys.executable) + ')'
vals = []
if head_cfg.returncode == 0 and shutil.which('pre-commit') is not None:
    vals, why = hook_values()
    if why:
        done(reason='hook surface unknown: ' + why + '; no hook was run', refused=['.pre-commit-config.yaml'])
for v in vals:
    for tok in re.findall(r'[A-Za-z0-9_.][A-Za-z0-9_./-]*', v):
        q = os.path.normpath(tok)
        if q != '.' and not q.startswith('..'):
            surface.add(q)
    for mod in re.findall(r'-m\s+([A-Za-z_][A-Za-z0-9_.]*)', v):
        parts = mod.split('.')
        for k in range(1, len(parts) + 1):
            surface.add('/'.join(parts[:k]) + '/__init__.py')
        surface.add('/'.join(parts) + '.py')
refused = sorted(p for p in surface if (p == '.pre-commit-config.yaml' and head_cfg.returncode != 0 and os.path.lexists(os.path.join(wt, p)))
                 or (p in tracked or os.path.lexists(os.path.join(wt, p))) and differs(p))
# a selected path through a symlink (at HEAD or in the worktree) is refused
def through_link(p):
    segs = p.split('/')
    for k in range(1, len(segs) + 1):
        pre = '/'.join(segs[:k])
        if pre in links or os.path.islink(os.path.join(wt, pre)):
            return True
    return False
files = []
for p in sorted(set(cand)):
    if p in frozen or p in surface:
        continue
    if through_link(p):
        refused.append(p)
        continue
    if os.path.isfile(os.path.join(wt, p)):
        files.append(p)
if refused:
    done(reason='hook surface differs from HEAD, or a selected path goes through a symlink', files=files, refused=sorted(set(refused)))
if head_cfg.returncode != 0:
    done(reason='no .pre-commit-config.yaml', files=files)
if not files:
    done(reason='no files to format', files=files)
if shutil.which('pre-commit') is None:
    done(reason='pre-commit is not installed', files=files)
# a scratch checkout a killed run left behind is removed first
os.makedirs(scratch_root, exist_ok=True)
for old in glob.glob(os.path.join(scratch_root, 'fmt-*')):
    git(wt, 'worktree', 'remove', '--force', old, check=False)
    shutil.rmtree(old, ignore_errors=True)
git(wt, 'worktree', 'prune', check=False)
# the hooks run in a scratch checkout of HEAD (hooks off for the checkout
# itself): only the selected files are copied in, and only they come back
scratch = tempfile.mkdtemp(prefix='fmt-', dir=scratch_root)
os.rmdir(scratch)
git(wt, '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', scratch, 'HEAD')
try:
    rs, rw = os.path.realpath(scratch), os.path.realpath(wt)
    for f in files:
        if not os.path.realpath(os.path.join(scratch, f)).startswith(rs + os.sep) or not os.path.realpath(os.path.join(wt, f)).startswith(rw + os.sep):
            refused.append(f)
    if refused:
        raise StopIteration
    for f in files:
        dst = os.path.join(scratch, f)
        os.makedirs(os.path.dirname(dst) or scratch, exist_ok=True)
        shutil.copy2(os.path.join(wt, f), dst)
    start = snapshot(scratch)
    # what a run changed: tracked or selected paths only (a cache a hook leaves
    # in the scratch checkout is never copied back), with their blob ids
    def delta():
        out = git(scratch, 'diff-tree', '-r', '-z', '--no-renames', start, snapshot(scratch)).stdout.split(b'\0')
        d = {}
        for k in range(0, len(out) - 1, 2):
            q = out[k + 1].decode('utf-8', 'replace')
            if q in tracked or q in files:
                d[q] = out[k].decode()
        return d
    prev = {}
    runs, stable = 0, False
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1')
    while runs < 3:
        runs += 1
        try:
            subprocess.run(['pre-commit', 'run', '--files'] + files, cwd=scratch, capture_output=True, timeout=tmo, env=dict(env, PATH=clean_path([wt, scratch_root])), preexec_fn=lift)
        except subprocess.TimeoutExpired:
            prev = delta()
            break
        now = delta()
        if now == prev:
            stable = True
            break
        prev = now
    changed = sorted(prev)
    for f in changed:
        if f in files:
            src, dst = os.path.join(scratch, f), os.path.join(wt, f)
            if os.path.realpath(src).startswith(rs + os.sep) and os.path.realpath(dst).startswith(rw + os.sep):
                shutil.copy2(src, dst)
except StopIteration:
    pass
finally:
    git(wt, 'worktree', 'remove', '--force', scratch, check=False)
    shutil.rmtree(scratch, ignore_errors=True)
    git(wt, 'worktree', 'prune', check=False)
if refused:
    done(reason='a selected path resolves outside the checkout', files=files, refused=sorted(set(refused)))
done(ran=True, reason='ran pre-commit run --files in a scratch checkout of HEAD', runs=runs, stable=stable, files=files, changed=changed)
