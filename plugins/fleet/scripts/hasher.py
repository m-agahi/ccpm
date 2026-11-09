
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
import fnmatch, hashlib, json, os, re, shlex, shutil, subprocess, sys, tempfile
try:
    import tomllib
except ImportError:
    try:
        import tomli as tomllib
    except ImportError:
        tomllib = None

CONFIG_GLOBS = ['conftest.py', 'pytest.ini', '.pytest.ini', 'pytest.toml', 'tox.ini', 'setup.cfg',
                'noxfile.py', 'sitecustomize.py', 'usercustomize.py', 'jest.config.*', 'vitest.config.*',
                'vitest.workspace*', 'karma.conf.*', '.mocharc*', '.babelrc*', 'babel.config.*',
                '.pre-commit-config.yaml', '.gitattributes']
ROOT_ONLY_GLOBS = ['*.pth']
SKIP_DIRS = {'.git', 'node_modules', '.venv', 'venv', '.tox', '.nox'}
# tool cache dirs: skipped only when git ignores them; runner config inside one is suspicious
CACHE_DIRS = {'__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.import_linter_cache', '.hypothesis'}
CACHE_ALARM_NAMES = ['pyproject.toml', 'package.json']
PACKAGE_KEYS = ['jest', 'vitest', 'mocha']

wt = sys.argv[1]
# every git call: no system config, no fsmonitor (a local config could name a program for it)
os.environ['GIT_CONFIG_NOSYSTEM'] = '1'
GIT = ['git', '-c', 'core.fsmonitor=false', '-C', wt]
explicit = json.loads(sys.argv[2]) if len(sys.argv) > 2 else []
# a tree sha: list the paths that differ between it and the tree now
base_tree = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None
# module names whose bytecode could shadow a frozen file (the purge removes
# all bytecode before every hash check, so any such pyc is planted)
FROZEN_STEMS = set(os.path.basename(f)[:-3] for f in explicit if f.endswith('.py')) | {'conftest'}

def frozen_pyc(name):
    return (name.endswith('.pyc') or name.endswith('.pyo')) and name.split('.')[0] in FROZEN_STEMS

def sha(data):
    return hashlib.sha256(data).hexdigest()

def git(*a):
    return subprocess.run(GIT + list(a), capture_output=True, check=True).stdout

def work_tree():
    # the tree of the worktree as git add -A would stage it (untracked and
    # not ignored files included), built in a temporary index: the real index
    # is never touched and no hook runs
    fd, tmp = tempfile.mkstemp(prefix='fleet-index-')
    os.close(fd)
    env = dict(os.environ, GIT_INDEX_FILE=tmp)
    try:
        for a in (['read-tree', 'HEAD'], ['add', '-A']):
            subprocess.run(GIT + a, capture_output=True, check=True, env=env)
        return subprocess.run(GIT + ['write-tree'], capture_output=True, check=True, env=env).stdout.decode().strip()
    finally:
        os.unlink(tmp)

def canon(obj):
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False, default=str).encode()

def sha_stream(fh):
    # bounded reads: 1 MiB at a time, whatever the file's size (3.1.0)
    h = hashlib.sha256()
    for chunk in iter(lambda: fh.read(1 << 20), b''):
        h.update(chunk)
    return h.hexdigest()

def file_hash(rel):
    p = os.path.join(wt, rel)
    if not os.path.isfile(p):
        return 'MISSING'
    with open(p, 'rb') as fh:
        return sha_stream(fh)

def abs_hash(path):
    if not path or not os.path.isfile(path):
        return 'MISSING'
    with open(path, 'rb') as fh:
        return sha_stream(fh)

LINKS = {}
SUSPICIOUS = []

def odd(rel):
    return ':' in rel or '#' in rel

def check_ignore(paths):
    # the subset of paths git ignores (exit 1 = none ignored)
    if not paths:
        return set()
    r = subprocess.run(GIT + ['check-ignore', '-z', '--stdin'],
                       input=b'\x00'.join(p.encode() for p in paths) + b'\x00', capture_output=True)
    if r.returncode not in (0, 1):
        sys.exit('git check-ignore failed: ' + r.stderr.decode(errors='replace'))
    return set(x.decode() for x in r.stdout.split(b'\x00') if x)

def scan_cache(reldir):
    # an ignored cache dir is not hashed; any runner config inside it is suspicious
    for dp, dns, fns in os.walk(os.path.join(wt, reldir)):
        for f in sorted(fns):
            rel = os.path.normpath(os.path.join(os.path.relpath(dp, wt), f))
            if any(fnmatch.fnmatch(f, g) for g in CONFIG_GLOBS) or f in CACHE_ALARM_NAMES:
                SUSPICIOUS.append('runner config in a skipped cache dir: ' + rel)
            if frozen_pyc(f):
                SUSPICIOUS.append('bytecode for a frozen file: ' + rel)

def walk_from(start, found, deferred):
    # never follows a symlink; every link outside the skipped dirs is recorded with its target
    for dp, dns, fns in os.walk(os.path.join(wt, start) if start else wt):
        reld = os.path.relpath(dp, wt)
        keep = []
        for d in sorted(dns):
            if d in SKIP_DIRS or os.path.join(reld, d) in ('./.claude/worktrees', '.claude/worktrees'):
                continue
            full = os.path.join(dp, d)
            reldir = os.path.normpath(os.path.join(reld, d))
            if odd(reldir):
                SUSPICIOUS.append(reldir + '/')
            if os.path.islink(full):
                LINKS[reldir] = os.readlink(full)
                continue
            if d in CACHE_DIRS:
                deferred.append(reldir)
                continue
            keep.append(d)
        dns[:] = keep
        for f in sorted(fns):
            rel = os.path.normpath(os.path.join(reld, f))
            full = os.path.join(dp, f)
            if os.path.islink(full):
                LINKS[rel] = os.readlink(full)
            if odd(rel):
                SUSPICIOUS.append(rel)
            if frozen_pyc(f):
                SUSPICIOUS.append('bytecode for a frozen file: ' + rel)
            found.append(rel)

def walk():
    # cache-named dirs are walked like any other dir unless git ignores them
    # (by an outside rule or by their own '*' .gitignore); ignored ones are only
    # scanned for runner config
    found, pending = [], []
    walk_from('', found, pending)
    while pending:
        ign = check_ignore(pending + [d + '/' for d in pending])
        nxt = []
        for d in pending:
            if d in ign or d + '/' in ign:
                scan_cache(d)
            else:
                walk_from(d, found, nxt)
        pending = nxt
    return found

def frozen_ignore_files(walked):
    # .gitignore files whose rules can matter: tracked or untracked-not-ignored
    # ones, plus any walked one whose directory no outside rule ignores (a
    # .gitignore that ignores itself still counts; git never reads one inside
    # an ignored dir)
    keep = set(f.decode() for f in git('ls-files', '-z', '--cached', '--others', '--exclude-standard',
                                       '--', ':(glob)**/.gitignore', '.gitignore').split(b'\x00') if f)
    cands = [rel for rel in walked if os.path.basename(rel) == '.gitignore']
    parents = sorted(set(os.path.dirname(rel) for rel in cands if os.path.dirname(rel)))
    ign = check_ignore(parents)
    for rel in cands:
        if os.path.dirname(rel) not in ign:
            keep.add(rel)
    return keep

def norm(rel):
    while rel.startswith('./'):
        rel = rel[2:]
    return rel.rstrip('/')

LAUNCHERS = {'uv', 'uvx', 'poetry', 'pipx', 'npx', 'pnpm', 'yarn', 'npm', 'hatch', 'pdm'}
LAUNCHER_WORDS = {'run', 'exec', '--'}

def root_json(name):
    try:
        with open(os.path.join(wt, name), 'rb') as fh:
            return json.load(fh)
    except FileNotFoundError:
        return None
    except Exception:
        return 'UNPARSEABLE'

def root_toml():
    p = os.path.join(wt, 'pyproject.toml')
    if not os.path.isfile(p):
        return None
    if tomllib is None:
        return 'UNPARSEABLE'
    try:
        with open(p, 'rb') as fh:
            return tomllib.load(fh)
    except Exception:
        return 'UNPARSEABLE'

def dig(d, *keys):
    for k in keys:
        if not isinstance(d, dict):
            return None
        d = d.get(k)
    return d

def hatch_scripts(pp):
    envs = dig(pp, 'tool', 'hatch', 'envs')
    if not isinstance(envs, dict):
        return None
    out = {k: v['scripts'] for k, v in envs.items() if isinstance(v, dict) and 'scripts' in v}
    return out or None

def launcher_tables():
    # the script tables a launcher hook runs, as canonical sections
    pj, pp = root_json('package.json'), root_toml()
    def sec(data, val):
        if data is None:
            return 'MISSING'
        if not isinstance(data, dict):
            return 'UNPARSEABLE'
        return 'ABSENT' if val is None else sha(canon(val))
    return {
        'package.json#scripts': sec(pj, dig(pj, 'scripts')),
        'pyproject.toml#project.scripts': sec(pp, dig(pp, 'project', 'scripts')),
        'pyproject.toml#tool.poetry.scripts': sec(pp, dig(pp, 'tool', 'poetry', 'scripts')),
        'pyproject.toml#tool.pdm.scripts': sec(pp, dig(pp, 'tool', 'pdm', 'scripts')),
        'pyproject.toml#tool.hatch.envs.*.scripts': sec(pp, hatch_scripts(pp)),
    }

def dist_name(x):
    m = re.match(r'[A-Za-z0-9][A-Za-z0-9._-]*', str(x).strip())
    return re.sub(r'[._]', '-', m.group(0).lower()) if m else None

def repo_names():
    # npm script names, Python script names, and the tools the repo declares
    pj, pp = root_json('package.json'), root_toml()
    npm = set(dig(pj, 'scripts') or {}) if isinstance(dig(pj, 'scripts'), dict) else set()
    py = set()
    for t in (dig(pp, 'project', 'scripts'), dig(pp, 'tool', 'poetry', 'scripts'), dig(pp, 'tool', 'pdm', 'scripts')):
        if isinstance(t, dict):
            py |= set(t)
    for t in (hatch_scripts(pp) or {}).values():
        if isinstance(t, dict):
            py |= set(t)
    tools = set()
    dev = dig(pj, 'devDependencies')
    if isinstance(dev, dict):
        tools |= set(dist_name(k) for k in dev)
    lists = [dig(pp, 'project', 'dependencies')]
    for grp in (dig(pp, 'project', 'optional-dependencies'), dig(pp, 'dependency-groups'), dig(pp, 'tool', 'pdm', 'dev-dependencies')):
        if isinstance(grp, dict):
            lists += list(grp.values())
    for l in lists:
        if isinstance(l, list):
            tools |= set(dist_name(x) for x in l if isinstance(x, str))
    tables = [dig(pp, 'tool', 'poetry', 'dependencies'), dig(pp, 'tool', 'poetry', 'dev-dependencies')]
    groups = dig(pp, 'tool', 'poetry', 'group')
    if isinstance(groups, dict):
        tables += [dig(g, 'dependencies') for g in groups.values()]
    for t in tables:
        if isinstance(t, dict):
            tools |= set(dist_name(k) for k in t)
    tools.discard(None)
    return npm, py, tools

def declared_tool(tool, tools):
    # npx/uvx: a repo-local bin or a declared dependency; never a PATH lookup alone
    for d in ('node_modules/.bin', '.venv/bin'):
        if os.path.lexists(os.path.join(wt, d, tool)):
            return True
    return dist_name(tool) in tools

def repo_file(tok):
    # a relative path to a regular file inside the worktree, else None
    if not tok or tok.startswith('/') or '..' in tok.split('/'):
        return None
    full = os.path.realpath(os.path.join(wt, tok))
    real_wt = os.path.realpath(wt)
    return norm(tok) if full.startswith(real_wt + os.sep) and os.path.isfile(full) else None

def local_hooks():
    # [(id, entry, args)] of the repo: local hooks in the root .pre-commit-config.yaml
    p = os.path.join(wt, '.pre-commit-config.yaml')
    if not os.path.isfile(p):
        return [], []
    with open(p, 'rb') as fh:
        raw = fh.read(262145)
    if len(raw) > 262144:
        return [], ['unresolvable local hook *: .pre-commit-config.yaml is over 256 KiB']
    out = []
    try:
        import yaml
    except ImportError:
        yaml = None
    if yaml is not None:
        try:
            data = yaml.safe_load(raw)
        except Exception:
            return [], ['unresolvable local hook *: .pre-commit-config.yaml does not parse']
        # only strings are read: an alias is never stringified (3.1.0)
        for repo in (data.get('repos') or []) if isinstance(data, dict) else []:
            if isinstance(repo, dict) and repo.get('repo') == 'local':
                for h in repo.get('hooks') or []:
                    if isinstance(h, dict):
                        hid = h.get('id') if isinstance(h.get('id'), str) else '?'
                        args = h.get('args')
                        if args is not None and not (isinstance(args, list) and all(isinstance(x, str) for x in args)):
                            return [], ['unresolvable local hook ' + hid + ': args is not a list of strings']
                        if h.get('entry') is not None and not isinstance(h.get('entry'), str):
                            return [], ['unresolvable local hook ' + hid + ': entry is not a string']
                        out.append((hid, h.get('entry') or '', list(args or [])))
        return out, []
    # no PyYAML: every entry: and inline args: [..] line, under the last id: line
    hid, cur = '?', None
    for line in raw.decode('utf-8', 'replace').splitlines():
        t = line.strip().lstrip('-').strip()
        if t.startswith('id:'):
            hid = t[3:].strip().strip('"').strip("'")
            cur = [hid, '', []]
            out.append(cur)
        elif t.startswith('entry:') and cur is not None:
            cur[1] = t[6:].strip().strip('"').strip("'")
        elif t.startswith('args:') and cur is not None:
            v = t[5:].strip()
            if v.startswith('[') and v.endswith(']'):
                cur[2] = [x.strip().strip('"').strip("'") for x in v[1:-1].split(',') if x.strip()]
    return [tuple(x) for x in out], []

def hook_refs():
    # repo files every local hook names (entry and args, shlex-split; -m mod
    # resolved to its file), and an alarm for any token that is neither a repo
    # file nor a binary on PATH, or an inline payload after -c. A launcher hook
    # also freezes the script tables (see launcher_tables).
    hooks, bad = local_hooks()
    refs = set()
    used_launcher = False
    npm_scripts, py_scripts, tools = repo_names()
    for hid, entry, args in hooks:
        try:
            toks = shlex.split(entry) + [t for x in args for t in shlex.split(x)]
        except ValueError:
            bad.append('unresolvable local hook ' + hid + ': entry or args do not shell-split')
            continue
        i = 0
        # lenient: the rest are the arguments of a frozen script or a declared tool
        lenient = False
        launcher = toks[0] if toks and toks[0] in LAUNCHERS else None
        if launcher:
            used_launcher = True
            i = 1
            sub = []
            while i < len(toks) and toks[i] in LAUNCHER_WORDS:
                sub.append(toks[i])
                i += 1
            name = toks[i] if i < len(toks) else None
            if launcher in ('npm', 'pnpm', 'yarn') and ('run' in sub or (launcher == 'yarn' and not sub)):
                if name not in npm_scripts:
                    bad.append('unresolvable local hook ' + hid + ': npm script missing: ' + str(name))
                    continue
                i += 1
                lenient = True
            elif launcher in ('npx', 'uvx') or (launcher == 'pnpm' and 'exec' in sub):
                if not name or not declared_tool(name, tools):
                    bad.append('unresolvable local hook ' + hid + ': ' + str(name))
                    continue
                i += 1
                lenient = True
            elif name in py_scripts:
                i += 1
                lenient = True
        while i < len(toks):
            t = toks[i]
            if t == '-c' and not lenient:
                bad.append('unresolvable local hook ' + hid + ': inline payload after -c')
                break
            if t == '-m' and not lenient:
                mod = toks[i + 1].replace('.', '/') if i + 1 < len(toks) else ''
                f = repo_file(mod + '.py') or repo_file(mod + '/__init__.py') if mod else None
                if f:
                    refs.add(f)
                else:
                    bad.append('unresolvable local hook ' + hid + ': module ' + (toks[i + 1] if i + 1 < len(toks) else '?'))
                i += 2
                continue
            if t.startswith('-'):
                i += 1
                continue
            f = repo_file(t)
            if f:
                refs.add(f)
            elif lenient or ('/' not in t and shutil.which(t)):
                pass
            else:
                bad.append('unresolvable local hook ' + hid + ': ' + t)
            i += 1
    # the whole dir tree of each referenced file (tracked and untracked-not-ignored)
    frozen = set()
    for f in refs:
        frozen.add(f)
        d = os.path.dirname(f)
        if d:
            for x in git('ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', d).split(b'\x00'):
                if x:
                    frozen.add(x.decode())
    return sorted(frozen), bad, used_launcher

def config_freeze(gitmap):
    # local (and worktree) git config, sorted with values, minus the keys
    # below; every include target
    def lst(*scope):
        r = subprocess.run(GIT + ['config'] + list(scope) + ['--list'], capture_output=True)
        return r.stdout.decode('utf-8', 'replace').splitlines() if r.returncode == 0 else []
    # left out: branch.* (the workflow's push -u) and transport settings a
    # human may fix between runs (remote.*, url.*, credential.*, http.*,
    # core.sshcommand); none of them weakens a test or a gate
    keep = lambda l: not re.match(r'(branch|remote|url|credential|http)\.|core\.sshcommand=', l)
    local = sorted(l for l in lst('--local') if keep(l))
    gitmap['config:local'] = sha('\n'.join(local).encode())
    on = subprocess.run(GIT + ['config', '--bool', 'extensions.worktreeConfig'], capture_output=True).stdout.strip()
    wtc = sorted(l for l in lst('--worktree') if keep(l)) if on == b'true' else None
    gitmap['config:worktree'] = sha('\n'.join(wtc).encode()) if wtc is not None else 'OFF'
    common = git('rev-parse', '--git-common-dir').decode().strip()
    common = common if os.path.isabs(common) else os.path.join(wt, common)
    for l in local + (wtc or []):
        k, _, v = l.partition('=')
        if k == 'include.path' or (k.startswith('includeif.') and k.endswith('.path')):
            path = os.path.expanduser(v)
            gitmap['config:include:' + v] = abs_hash(path if os.path.isabs(path) else os.path.join(common, path))
    ia = git('rev-parse', '--git-path', 'info/attributes').decode().strip()
    gitmap['info/attributes'] = abs_hash(ia if os.path.isabs(ia) else os.path.join(wt, ia))

IGNORED_CACHE = {'__pycache__', '.pytest_cache', '.hypothesis', '.ruff_cache', '.mypy_cache', '.import_linter_cache'}
# build and coverage output: these dirs at the top level only, these files at the root only;
# *.egg-info and EGG-INFO stay frozen anywhere (entry_points can register pytest plugins)
OUTPUT_DIRS = {'build', 'dist', 'htmlcov', '.eggs'}
OUTPUT_FILES = ['coverage.xml', '.coverage', '.coverage.*', 'junit*.xml']

def ignored_files():
    # every ignored file except tool caches and top-level build output; inside
    # a skipped dir (venv, node_modules, ...) only interpreter startup hooks
    out = {}
    for x in git('ls-files', '-z', '--others', '--ignored', '--exclude-standard').split(b'\x00'):
        if not x:
            continue
        rel = x.decode()
        segs = rel.split('/')
        base = segs[-1]
        if rel.startswith('.claude/worktrees/'):
            continue
        if any(s in SKIP_DIRS for s in segs[:-1]):
            if base.endswith('.pth') or base in ('sitecustomize.py', 'usercustomize.py'):
                out[rel] = file_hash(rel)
            # installed entry points (a pytest11 plugin) and editable-install links
            elif base.endswith('.egg-link') or (base == 'entry_points.txt' and len(segs) > 1 and (segs[-2].endswith('.dist-info') or segs[-2].endswith('.egg-info'))):
                out[rel] = file_hash(rel)
            continue
        if any(s.endswith('.egg-info') or s == 'EGG-INFO' for s in segs):
            out[rel] = file_hash(rel)
            continue
        if any(s in IGNORED_CACHE for s in segs):
            continue
        if (len(segs) > 1 and segs[0] in OUTPUT_DIRS) or (len(segs) == 1 and any(fnmatch.fnmatch(base, g) for g in OUTPUT_FILES)):
            continue
        out[rel] = file_hash(rel)
    return out

def hook_files(gitmap):
    # core.hooksPath (its value) and every file under the hooks dir git uses
    hp = subprocess.run(GIT + ['config', 'core.hooksPath'], capture_output=True).stdout.decode().strip()
    gitmap['core.hooksPath'] = hp or 'UNSET'
    if hp:
        d = hp if os.path.isabs(hp) else os.path.join(wt, hp)
    else:
        d = git('rev-parse', '--git-path', 'hooks').decode().strip()
        d = d if os.path.isabs(d) else os.path.join(wt, d)
    for dp, dns, fns in os.walk(d):
        dns.sort()
        for f in sorted(fns):
            full = os.path.join(dp, f)
            rel = os.path.relpath(full, d)
            gitmap['hooks/' + rel] = 'symlink:' + os.readlink(full) if os.path.islink(full) else abs_hash(full)

tree = work_tree()
out = {'fingerprint': {'head': git('rev-parse', 'HEAD').decode().strip(), 'tree': tree}}
if base_tree:
    out['changed'] = sorted(set(f.decode() for f in git('diff', '--name-only', '-z', '--no-renames', base_tree, tree).split(b'\x00') if f))

# one map per key kind, so a real file name can never mask a synthetic key
files, sections, gitmap, symlinks = {}, {}, {}, {}
walked = walk()
for rel in walked:
    base = os.path.basename(rel)
    if any(fnmatch.fnmatch(base, g) for g in CONFIG_GLOBS) or odd(rel):
        files[rel] = file_hash(rel)
    elif '/' not in rel and any(fnmatch.fnmatch(base, g) for g in ROOT_ONLY_GLOBS):
        files[rel] = file_hash(rel)
for rel in frozen_ignore_files(walked):
    files[rel] = file_hash(rel)
for rel in sorted(LINKS):
    symlinks[rel] = LINKS[rel]
ex = git('rev-parse', '--git-path', 'info/exclude').decode().strip()
gitmap['info/exclude'] = abs_hash(ex if os.path.isabs(ex) else os.path.join(wt, ex))
gx = subprocess.run(GIT + ['config', '--path', 'core.excludesFile'], capture_output=True)
gpath = gx.stdout.decode().strip()
if not gpath:
    gpath = os.path.join(os.environ.get('XDG_CONFIG_HOME') or os.path.expanduser('~/.config'), 'git', 'ignore')
gitmap['core.excludesFile'] = abs_hash(gpath)
hook_files(gitmap)
config_freeze(gitmap)
# every run-state ref (name -> target): only the workflow's own state write may move one
for line in git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/fleet/').decode().splitlines():
    name, _, obj = line.partition(' ')
    if name:
        gitmap['fleetref:' + name] = obj
hook_frozen, hook_bad, hook_launcher = hook_refs()
for rel in hook_frozen:
    files[rel] = file_hash(rel)
if hook_launcher:
    sections.update(launcher_tables())
SUSPICIOUS.extend(hook_bad)
listed = git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split(b'\x00')
for rel in sorted(set(f.decode() for f in listed if f)):
    base = os.path.basename(rel)
    if base == 'pyproject.toml':
        if tomllib is None:
            sys.exit('tomllib unavailable: need python >= 3.11 or tomli')
        try:
            with open(os.path.join(wt, rel), 'rb') as fh:
                data = tomllib.load(fh)
            sec = data.get('tool', {}).get('pytest')
            sections[rel + '#tool.pytest'] = 'ABSENT' if sec is None else sha(canon(sec))
        except FileNotFoundError:
            sections[rel + '#tool.pytest'] = 'MISSING'
        except Exception:
            sections[rel + '#tool.pytest'] = 'UNPARSEABLE'
    elif base == 'package.json':
        try:
            with open(os.path.join(wt, rel), 'rb') as fh:
                data = json.load(fh)
        except FileNotFoundError:
            data = None
        except Exception:
            data = 'UNPARSEABLE'
        for k in PACKAGE_KEYS + ['scripts.test']:
            if data is None:
                v = 'MISSING'
            elif not isinstance(data, dict):
                v = 'UNPARSEABLE'
            elif k == 'scripts.test':
                s = data.get('scripts')
                v = sha(canon(s['test'])) if isinstance(s, dict) and 'test' in s else 'ABSENT'
            else:
                v = sha(canon(data[k])) if k in data else 'ABSENT'
            sections[rel + '#' + k] = v
for rel in explicit:
    rel = norm(rel)
    files[rel] = file_hash(rel)
out['hashes'] = {'files': files, 'sections': sections, 'git': gitmap, 'symlinks': symlinks,
                 'ignored': ignored_files(),
                 'suspicious': sorted(set(SUSPICIOUS))}
# the script recomputes this over the relayed values: a dropped key fails
out['program'] = _PROG
out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()

print(json.dumps(out, sort_keys=True))
