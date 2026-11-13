
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
import glob, hashlib, json, os, re, shutil, stat, subprocess, sys, tempfile
wt, sel = sys.argv[1], json.loads(sys.argv[2])
FROZEN_SHA = None
def frozen_of(a, scratch):
    # 5.0.7 (ledger 2020): a JSON list of paths, or @<12 hex>: the handle of
    # the hasher's files map <scratch>/hashes/files-<prefix><52 hex>.json
    # (exactly one; its bytes must hash to its name), whose keys are the
    # frozen paths. The full sha256 is printed (frozen_map) for the workflow
    # to check; no agent types a 64-hex value.
    global FROZEN_SHA
    if not a.startswith('@'):
        return set(json.loads(a))
    pre = a[1:]
    d = os.path.join(scratch, 'hashes')
    if not re.match(r'^[0-9a-f]{12}$', pre) or os.path.islink(d) or not os.path.isdir(d):
        sys.exit('frozen map handle is not 12 hex, or no hashes dir: ' + a)
    hits = [n for n in os.listdir(d) if re.match(r'^files-' + pre + r'[0-9a-f]{52}\.json$', n)]
    if len(hits) != 1:
        sys.exit(str(len(hits)) + ' files match the frozen map handle ' + a)
    p = os.path.join(d, hits[0])
    if os.path.islink(p):
        sys.exit('frozen map is a symlink: ' + p)
    with open(p, 'rb') as fh:
        data = fh.read()
    FROZEN_SHA = hits[0][6:-5]
    if hashlib.sha256(data).hexdigest() != FROZEN_SHA:
        sys.exit('frozen map does not match its sha256: ' + p)
    d = json.loads(data)
    if not isinstance(d, dict):
        sys.exit('frozen map is not a JSON object: ' + p)
    return set(d)
frozen = frozen_of(sys.argv[3], sys.argv[4])
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
# 6.1.0 review B3: index writes and worktree add/remove run no repo hook
G = ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.quotePath=false']
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
# the caches purge_caches() deleted (5.0.4), printed with every result
PURGED = []
PURGED_CAP = 50
def done(**k):
    # 6.2.2 (2107, ADR-1237; review M2, L1, L2, L3): the listed pre-freeze hooks' result:
    # hook_failures [[file, id]], a short printable head and the sha256 of their output
    # (no free text to copy), hook_timeout [id], unknown_hooks ['id: why']
    out = {'ran': False, 'note': '', 'runs': 0, 'stable': True, 'files': [], 'changed': [], 'refused': [], 'purged': len(PURGED), 'purged_paths': sorted(PURGED)[:PURGED_CAP],
           'hook_failed': False, 'hook_failures': [], 'hook_head': '', 'hook_sha256': '', 'hook_timeout': [], 'fix_timeout': False, 'unknown_hooks': []}
    out.update(k)
    # 5.0.7: the changed paths that are frozen (the workflow stops on any)
    out['frozen_changed'] = sorted(set(out['changed']) & frozen)
    out['frozen_map'] = FROZEN_SHA
    out['program'] = _PROG
    out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
    print(json.dumps(out, sort_keys=True, ensure_ascii=False))
    sys.exit(0)
# 6.2.2 (2107, ADR-1237): select.check_hooks, the policy's pre_freeze_hooks: after the
# fixer runs, each listed hook runs once more alone on the files (`pre-commit run <id>
# --files`); a non-zero exit is a failure. No list: no check, as in 6.2.1.
CHECK = sel.get('check_hooks') or []
if not isinstance(CHECK, list) or any(not isinstance(x, str) or not x or x.startswith('-') for x in CHECK):
    sys.exit('select.check_hooks must be a list of hook ids')
HOOK_IDS = {}
# [(file, id)] of the listed hooks that failed (file '': the whole tree), their outputs,
# [id] that timed out, ['id: why'] not runnable
FAILED, OUTPUTS, TIMED_OUT, NOT_RUN = [], [], [], []
# re-review D-L1: the fixers keep their 5.x budget (3 runs of at most tmo s each); the
# listed checks get CHECK_BUDGET s of their own, and never run past STEP_CEILING s from
# the start of this program (under the agent's 600 s Bash call)
CHECK_BUDGET = 240
STEP_CEILING = 570
import time
STARTED = time.monotonic()
FIX_TIMEOUT = [False]
# 6.3.0 (6.2.2 carry-over low 1): the fixer time and the check budget, named in a timeout note
TIMING = ['']
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
sel_set = set(cand)
def linked(p):
    # a symlink at p or at any parent of p (lstat, never followed)
    segs = p.split('/')
    return any(os.path.islink(os.path.join(wt, *segs[:k])) for k in range(1, len(segs) + 1))
def head_tree(p):
    r = git(wt, 'cat-file', '-t', 'HEAD:' + p, check=False)
    return r.returncode == 0 and r.stdout.strip() == b'tree'
def is_dir_path(p):
    # 5.0.4 (ledger 2013): a directory a hook entry names (pytest tests/)
    fp = os.path.join(wt, p)
    return p not in tracked and (head_tree(p) or (os.path.isdir(fp) and not os.path.islink(fp)))
def others(p):
    # untracked paths under p, ignored ones included; git never descends a symlink
    return names(git(wt, 'ls-files', '-z', '--others', '--', p).stdout)
SNAP = []
def snap():
    # the worktree in a temporary index, taken once after the purge: no
    # assume-unchanged or skip-worktree bit hides an edit (review S1)
    if not SNAP:
        SNAP.append(snapshot(wt))
    return SNAP[0]
def gitlinks(tree, p):
    out = git(wt, 'ls-tree', '-r', '-z', tree, '--', p).stdout.split(b'\0')
    return [r.partition(b'\t')[2].decode('utf-8', 'replace') for r in out if r.split(b' ')[0] == b'160000']
def dir_offenders(p):
    # what under directory hook path p is not HEAD's: a path that differs
    # between HEAD and the snapshot, any untracked or ignored path (selected
    # paths included: a conftest.py or module there runs inside the hook). A
    # symlinked or replaced directory, or a gitlink under p at HEAD or in the
    # snapshot (its untracked content is invisible here), is the offender.
    fp = os.path.join(wt, p)
    if linked(p) or not os.path.isdir(fp):
        return [p]
    links = gitlinks('HEAD', p) + gitlinks(snap(), p)
    if links:
        return sorted(set(links))
    out = names(git(wt, 'diff-tree', '-r', '-z', '--name-only', '--no-renames', 'HEAD^{tree}', snap(), '--', p).stdout) + others(p)
    return sorted(set(out))
OFFENDERS = []
def differs(p):
    if p not in tracked:
        if is_dir_path(p):
            hit = dir_offenders(p)
            OFFENDERS.extend(hit)
            return bool(hit)
        return os.path.lexists(os.path.join(wt, p))
    return git(wt, 'diff', '--quiet', 'HEAD', '--', p, check=False).returncode != 0
CACHE_DIRS = ('__pycache__', '.pytest_cache')
def purge_caches():
    # 5.0.4 (ledger 2013): a hook run in the worktree (format-plan, the commit
    # step) leaves __pycache__ / .pytest_cache under a hook directory such as
    # `pytest scripts/tests/`. Under the directory hook paths only, delete the
    # untracked or ignored cache files: a path under a __pycache__ or
    # .pytest_cache dir, or a *.pyc / *.pyo file. Never a tracked file (git
    # lists only untracked ones), never a selected path, never through a
    # symlink (every component lstat'ed; a link is left for the check, which
    # refuses it), never outside the worktree. Emptied cache dirs go too.
    rw = os.path.realpath(wt)
    for p in sorted(surface):
        if not is_dir_path(p) or linked(p) or not os.path.isdir(os.path.join(wt, p)):
            continue
        for q in others(p):
            segs = q.split('/')
            if q in sel_set or not (any(x in CACHE_DIRS for x in segs[:-1]) or segs[-1].endswith(('.pyc', '.pyo'))):
                continue
            if linked(q):
                continue
            full = os.path.join(wt, q)
            try:
                if not stat.S_ISREG(os.lstat(full).st_mode):
                    continue
            except OSError:
                continue
            if not os.path.realpath(full).startswith(rw + os.sep):
                continue
            os.unlink(full)
            PURGED.append(q)
            # the emptied cache dirs (a cache dir or a dir inside one), deepest
            # first, never p itself or a dir above it
            top = len(p.split('/'))
            for k in range(len(segs) - 1, top, -1):
                if any(x in CACHE_DIRS for x in segs[top:k]):
                    try:
                        os.rmdir(os.path.join(wt, *segs[:k]))
                    except OSError:
                        pass
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
    # 6.2.2 review L1: each hook's stages, and the config's default_stages
    "def strs(v):\n    if v is not None and not (isinstance(v, list) and all(isinstance(x, str) for x in v)):\n        sys.exit(8)\n    for x in v or []:\n        grow(len(x))\n    return v\n"
    "out = []\n"
    "for r in (d.get('repos') if isinstance(d, dict) else None) or []:\n"
    "    for h in (r.get('hooks') if isinstance(r, dict) else None) or []:\n"
    "        if isinstance(h, dict):\n"
    "            a = h.get('args')\n"
    "            if a is not None and not (isinstance(a, list) and all(isinstance(x, str) for x in a)):\n"
    "                sys.exit(7)\n"
    "            for x in a or []:\n                grow(len(x))\n"
    "            out.append({'id': s(h, 'id'), 'entry': s(h, 'entry'), 'args': a or [], 'language': s(h, 'language'), 'stages': strs(h.get('stages'))})\n"
    "print(json.dumps({'hooks': out, 'default_stages': strs(d.get('default_stages')) if isinstance(d, dict) else None}))\n"
)
LOADER_EXITS = {4: 'the loader output over 1 MiB', 5: 'the config is over 256 KiB', 6: 'a hook entry or language is not a string', 7: 'a hook args is not a list of strings', 8: 'a stages or default_stages is not a list of strings'}
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
        ds = hooks.get('default_stages') if isinstance(hooks, dict) else None
        for h in (hooks.get('hooks') if isinstance(hooks, dict) else None) or []:
            if isinstance(h, dict):
                if isinstance(h.get('id'), str):
                    # 6.2.2 review L1: the stages the hook runs at (its own, else default_stages; None: all)
                    HOOK_IDS.setdefault(h['id'], []).append(h.get('stages') if h.get('stages') is not None else ds)
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
        done(note='hook surface unknown: ' + why + '; no hook was run', refused=['.pre-commit-config.yaml'])
# 6.2.2 (2107, ADR-1237): every listed id must be a hook id of the config at HEAD
# and run at the pre-commit stage (`commit` is its legacy name)
PRE_COMMIT_STAGES = ('pre-commit', 'commit')
def why_not(i):
    if i not in HOOK_IDS:
        return 'not in .pre-commit-config.yaml'
    if any(st is None or any(x in PRE_COMMIT_STAGES for x in st) for st in HOOK_IDS[i]):
        return None
    return 'its stages (' + ', '.join(sorted(set(x for st in HOOK_IDS[i] for x in st))) + ') exclude pre-commit'
if CHECK and shutil.which('pre-commit') is not None:
    unknown = [i + ': ' + why_not(i) for i in CHECK if why_not(i)]
    if unknown:
        done(note='pre-freeze hook id(s) cannot run: ' + '; '.join(unknown) + '; no hook was run', unknown_hooks=unknown)
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
purge_caches()
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
    done(note='hook surface differs from HEAD, or a selected path goes through a symlink' + (': ' + ', '.join(sorted(set(OFFENDERS))[:20]) if OFFENDERS else ''), files=files, refused=sorted(set(refused)))
if head_cfg.returncode != 0:
    done(note='no .pre-commit-config.yaml', files=files)
if not files:
    done(note='no files to format', files=files)
if shutil.which('pre-commit') is None:
    done(note='pre-commit is not installed', files=files)
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
            # re-review D-L1: the fixer phase ran out of time (reported as such)
            FIX_TIMEOUT[0] = True
            prev = delta()
            break
        now = delta()
        if now == prev:
            stable = True
            break
        prev = now
    # 6.2.2 (2107, ADR-1237; re-review D-M1): each listed hook runs once on all the settled
    # files. Only when it fails is each file re-run alone, in a scratch checkout of HEAD plus
    # that one file, so a whole-tree hook (pass_filenames: false, always_run) blames only the
    # files that fail alone; none failing alone is a whole-tree failure (file ''). A timeout
    # (a run's own, or the check budget) is reported as one, never as a failure.
    NO_STAGE = re.compile(rb'No hook with id `[^`]*` in stage')
    t_fix = time.monotonic()
    full = t_fix + CHECK_BUDGET
    check_end = min(full, STARTED + STEP_CEILING)
    TIMING[0] = '; the fixer runs took %d s, so the check phase had %d s%s' % (
        int(t_fix - STARTED), max(0, int(check_end - t_fix)), ' (cut by the %d s step ceiling)' % STEP_CEILING if check_end < full else '')
    cenv = dict(env, PATH=clean_path([wt, scratch_root]), PRE_COMMIT_COLOR='never')
    def check(hid, cwd, paths):
        # (returncode, output), or None on a timeout
        rest = check_end - time.monotonic()
        if rest < 1:
            return None
        try:
            pr = subprocess.run(['pre-commit', 'run', hid, '--files'] + paths, cwd=cwd, capture_output=True, timeout=min(tmo, rest), env=cenv, preexec_fn=lift)
        except subprocess.TimeoutExpired:
            return None
        return pr.returncode, pr.stdout + pr.stderr
    def isolated(hid, f):
        # 6.3.0 (low 1): no isolated checkout once the check budget is spent
        if check_end - time.monotonic() < 1:
            return None
        iso = tempfile.mkdtemp(prefix='fmt-iso-', dir=scratch_root)
        os.rmdir(iso)
        git(wt, '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', iso, 'HEAD')
        try:
            dst = os.path.join(iso, f)
            if not os.path.realpath(dst).startswith(os.path.realpath(iso) + os.sep):
                return 1, b''
            os.makedirs(os.path.dirname(dst) or iso, exist_ok=True)
            shutil.copy2(os.path.join(scratch, f), dst)
            return check(hid, iso, [f])
        finally:
            git(wt, 'worktree', 'remove', '--force', iso, check=False)
            shutil.rmtree(iso, ignore_errors=True)
    for hid in CHECK if stable else []:
        res = check(hid, scratch, files)
        if res is None:
            TIMED_OUT.append(hid)
            continue
        if res[0] == 0:
            continue
        if NO_STAGE.search(res[1]):
            NOT_RUN.append(hid + ': pre-commit has no such hook at the pre-commit stage')
            continue
        OUTPUTS.append(b'[' + hid.encode() + b'] ' + res[1])
        bad = []
        for f in files:
            one = isolated(hid, f)
            if one is None:
                TIMED_OUT.append(hid)
                break
            if one[0] != 0:
                bad.append(f)
        else:
            FAILED.extend([(f, hid) for f in bad] if bad else [('', hid)])
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
    done(note='a selected path resolves outside the checkout', files=files, refused=sorted(set(refused)))
# 6.2.2 (2107, ADR-1237; review M2): the failing hooks' output is relayed as its sha256 and its
# first HOOK_HEAD_CAP characters as printable ASCII; the writers re-run the hook for the rest
HOOK_HEAD_CAP = 300
def head_text(b):
    t = re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', b.decode('utf-8', 'replace'))
    t = ''.join(c if c == '\n' or ' ' <= c <= '~' else '?' for c in t.replace('\r\n', '\n').replace('\t', ' ')).strip()
    return t[:HOOK_HEAD_CAP]
# the output of each failing hook's run on all the files
allout = b'\n'.join(OUTPUTS) if FAILED else b''
done(ran=not NOT_RUN, note=('pre-freeze hook id(s) cannot run: ' + '; '.join(NOT_RUN) if NOT_RUN else 'ran pre-commit run --files in a scratch checkout of HEAD') + (TIMING[0] if TIMED_OUT else ''),
     runs=runs, stable=stable, files=files, changed=changed,
     hook_failed=bool(FAILED), hook_failures=[[f, h] for f, h in FAILED], hook_head=head_text(allout), hook_sha256=hashlib.sha256(allout).hexdigest() if FAILED else '',
     hook_timeout=sorted(set(TIMED_OUT)), fix_timeout=FIX_TIMEOUT[0], unknown_hooks=NOT_RUN)
