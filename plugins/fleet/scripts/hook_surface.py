
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
import ast, hashlib, json, os, re, shutil, subprocess, sys
wt, rev, targets_arg = sys.argv[1], sys.argv[2], sys.argv[3]
targets = [t for t in json.loads(targets_arg) if isinstance(t, str)]
# argv[4] == 'no-yaml' (tests only): behave as if no Python had PyYAML
no_yaml = len(sys.argv) > 4 and sys.argv[4] == 'no-yaml'
os.chdir('/')
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
def values(raw):
    # (names, None) or (None, why), as the fixer program reads the config
    if len(raw) > 262144:
        return None, 'the config is over 256 KiB'
    cands = []
    pc = shutil.which('pre-commit')
    if pc:
        cands.extend(interpreters(os.path.realpath(pc)))
        cands.extend(interpreters(pc))
    cands.append((sys.executable, []))
    tried = set()
    for c, sites in cands:
        if not c or (c, tuple(sites)) in tried or os.path.basename(c) in SHELLS or os.path.basename(c) == 'env' or no_yaml:
            continue
        tried.add((c, tuple(sites)))
        try:
            r = subprocess.run([c, '-I', '-c', LOADER] + sites, input=raw, capture_output=True, timeout=60, cwd='/')
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
        names = []
        for h in json.loads(r.stdout):
            if isinstance(h.get('entry'), str):
                names.append(h['entry'])
            names.extend(h.get('args') or [])
        return names, None
    return None, 'no Python with PyYAML found'
configs = []
r = subprocess.run(['git', '-C', wt, 'show', rev + ':.pre-commit-config.yaml'], capture_output=True)
if r.returncode == 0:
    configs.append(r.stdout)
p = os.path.join(wt, '.pre-commit-config.yaml')
if os.path.isfile(p):
    with open(p, 'rb') as fh:
        configs.append(fh.read(262145))
ls = subprocess.run(['git', '-C', wt, 'ls-files', '-z'], capture_output=True)
tracked = set(x.decode('utf-8', 'replace') for x in ls.stdout.split(b'\0') if x)
SCRIPT_EXT = ('.py', '.sh', '.bash', '.zsh', '.js', '.mjs', '.cjs', '.ts', '.rb', '.pl')
FILE_CAP = 1 << 20
MAX_FILES = 500
def norm(tok):
    q = os.path.normpath(tok)
    return None if q in ('.', '') or q == '..' or q.startswith('../') or q.startswith('/') else q
def read(rel):
    # bounded; None when absent or over FILE_CAP
    try:
        with open(os.path.join(wt, rel), 'rb') as fh:
            data = fh.read(FILE_CAP + 1)
    except OSError:
        return None
    return None if len(data) > FILE_CAP else data.decode('utf-8', 'replace')
def is_script(rel):
    if rel.lower().endswith(SCRIPT_EXT):
        return True
    t = read(rel)
    return t is not None and t.startswith('#!')
def makefiles():
    return [x for x in tracked if x.split('/')[-1] in ('Makefile', 'makefile', 'GNUmakefile') or x.endswith('.mk')]
surface, error = set(), None
def add_command(v):
    # every name in a hook command; a --flag=value only when the value is a script
    for tok in re.findall(r'[A-Za-z0-9_.][A-Za-z0-9_./=-]*', v):
        if '=' in tok:
            q = norm(tok.split('=', 1)[1])
            if q and is_script(q):
                surface.add(q)
            continue
        q = norm(tok)
        if q:
            surface.add(q)
    for mod in re.findall(r'(?:^|\s)-[A-Za-z]*m\s*([A-Za-z_][A-Za-z0-9_.]*)', v):
        parts = mod.split('.')
        for k in range(1, len(parts) + 1):
            surface.add('/'.join(parts[:k]) + '/__init__.py')
        surface.add('/'.join(parts) + '.py')
        surface.add('/'.join(parts) + '/__main__.py')
    if re.search(r'(?:^|[\s;&|(])make(?:\s|$)', v):
        surface.update(makefiles())
for raw in configs:
    names, error = values(raw)
    if error:
        break
    for v in names:
        add_command(v)
# CI files and hook-manager files (actions, husky, githooks, lefthook, the
# hooksPath dir, package.json scripts): the repo scripts they name
CI = re.compile(r'^(\.github/workflows/.*\.ya?ml|\.github/actions/.*|\.gitea/workflows/.*|\.forgejo/workflows/.*|\.gitlab-ci\.yml|\.gitlab/.*\.ya?ml|\.circleci/.*|\.woodpecker.*|Jenkinsfile|azure-pipelines\.ya?ml|bitbucket-pipelines\.ya?ml|\.buildkite/.*|\.husky/.*|\.githooks/.*|(.*/)?lefthook[^/]*\.ya?ml|\.lefthook.*|(.*/)?package\.json)$', re.I)
hp_raw = subprocess.run(['git', '-C', wt, 'config', 'core.hooksPath'], capture_output=True).stdout.decode('utf-8', 'replace').strip()
hp_rel = None
if hp_raw:
    hp_abs = os.path.expanduser(hp_raw)
    hp_rel = norm(hp_raw) if not os.path.isabs(hp_abs) else os.path.relpath(os.path.realpath(hp_abs), os.path.realpath(wt))
    if hp_rel and hp_rel.startswith('..'):
        hp_rel = None
for c in sorted(x for x in tracked if CI.match(x) or (hp_rel and x.startswith(hp_rel.rstrip('/') + '/'))):
    if c.split('/')[-1] == 'package.json' and ('node_modules/' in c):
        continue
    t = read(c)
    if t is None:
        error = error or ('hook or CI file ' + c + ' is over 1 MiB or unreadable')
        continue
    if c.split('/')[-1] == 'package.json':
        try:
            sc = json.loads(t).get('scripts') or {}
            t = '\n'.join(v for v in sc.values() if isinstance(v, str)) if isinstance(sc, dict) else ''
        except (ValueError, AttributeError):
            error = error or (c + ' does not parse')
            continue
    for tok in re.findall(r'[A-Za-z0-9_.][A-Za-z0-9_./-]*', t):
        q = norm(tok)
        if q and q in tracked and is_script(q):
            surface.add(q)
# symlinks in the surface: their targets inside the repo too
for q in list(surface):
    fp = os.path.join(wt, q)
    if os.path.islink(fp):
        tgt = os.path.relpath(os.path.realpath(fp), os.path.realpath(wt))
        if not tgt.startswith('..'):
            surface.add(tgt)
# one level of what the hook scripts load: repo-local Python imports (from the
# repo root and from the script's own dir) and shell source/. of repo paths.
# A Python script that does not parse puts its whole directory in the surface.
def resolve(cands):
    for c in cands:
        q = norm(c)
        if q and q in tracked:
            surface.add(q)
level1 = sorted(q for q in surface if q in tracked)
if len(level1) > MAX_FILES:
    error = error or ('more than ' + str(MAX_FILES) + ' hook files')
for q in level1[:MAX_FILES]:
    t = read(q)
    if t is None:
        error = error or ('hook file ' + q + ' is over 1 MiB or unreadable')
        continue
    d = os.path.dirname(q)
    if q.endswith('.py'):
        try:
            tree = ast.parse(t)
        except (SyntaxError, ValueError, RecursionError, MemoryError):
            surface.add((d + '/') if d else './')
            continue
        for node in ast.walk(tree):
            mods = []
            if isinstance(node, ast.Import):
                mods = [(a.name, 0) for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                mods = [(node.module or '', node.level)] + [((node.module + '.' if node.module else '') + a.name, node.level) for a in node.names]
            for m, lvl in mods:
                path = m.replace('.', '/')
                bases = [d] if lvl else ['', d]
                if lvl > 1:
                    bases = ['/'.join(d.split('/')[:max(0, len(d.split('/')) - (lvl - 1))])]
                for b in bases:
                    stem = os.path.join(b, path) if path else b
                    resolve([stem + '.py', os.path.join(stem, '__init__.py')])
    elif t.startswith('#!') and re.match(r'#!\S*(?:/|env\s+)(?:ba|z|da|k)?sh\b', t) or q.endswith(('.sh', '.bash')):
        for m in re.findall(r'(?:^|[;&|][ \t]*)(?:source|\.)[ \t]+([^\s;&|]+)', t, re.M):
            resolve([m, os.path.join(d, m)])
        # scripts the hook runs directly: an interpreter with a file, or ./file
        for m in re.findall(r'(?:^|[\s;&|(])(?:bash|sh|zsh|dash|ksh|python[0-9.]*|node|ruby|perl)[ \t]+(?:-[A-Za-z]+[ \t]+)*([^\s;&|)]+)', t, re.M):
            resolve([m, os.path.join(d, m)])
        for m in re.findall(r'(?:^|[\s;&|(])(\./[^\s;&|)]+)', t, re.M):
            resolve([m, os.path.join(d, m)])
# core.hooksPath inside the repo: the whole dir
hp = subprocess.run(['git', '-C', wt, 'config', 'core.hooksPath'], capture_output=True).stdout.decode('utf-8', 'replace').strip()
if hp and not os.path.isabs(os.path.expanduser(hp)):
    q = norm(hp)
    if q:
        surface.add(q.rstrip('/') + '/')
elif hp:
    rel = os.path.relpath(os.path.realpath(os.path.expanduser(hp)), os.path.realpath(wt))
    if not rel.startswith('..'):
        surface.add(rel.rstrip('/') + '/')
# F2: the repo paths each make target's recipe names, in the root Makefile at <rev>
make_paths = {}
mk = None
for name in ('GNUmakefile', 'makefile', 'Makefile'):
    r = subprocess.run(['git', '-C', wt, 'show', rev + ':' + name], capture_output=True)
    if r.returncode == 0:
        mk = r.stdout[:FILE_CAP].decode('utf-8', 'replace')
        break
for tgt in targets:
    paths = set()
    if mk is not None:
        lines = mk.splitlines()
        for i, line in enumerate(lines):
            m = re.match(r'^([^:=#\t][^:=#]*):(?!=)', line)
            if m and tgt in m.group(1).split():
                for rl in lines[i + 1:]:
                    if not rl.startswith('\t'):
                        break
                    for tok in re.findall(r'[A-Za-z0-9_.][A-Za-z0-9_./-]*', rl):
                        q = norm(tok)
                        if q and q in tracked:
                            paths.add(q)
    make_paths[tgt] = sorted(paths)
out = {'surface': [] if error else sorted(surface), 'make_paths': {} if error else make_paths, 'error': error, 'args': [wt, rev, targets_arg]}
out['program'] = _PROG
out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
print(json.dumps(out, ensure_ascii=False))
