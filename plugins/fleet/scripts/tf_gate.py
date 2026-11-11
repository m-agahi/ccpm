
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
import hashlib, json, os, re, subprocess, sys
wt, default, sha, url = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
os.chdir('/')
import atexit, shutil, tempfile
URL_OK = re.compile(r'^(https://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._~/-]+|git@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+)$')
if not URL_OK.match(url):
    sys.exit('the sealed origin URL is not an https or git@host: URL')
# network git and every read run outside the repo's own config: a role can
# edit .git/config (sshCommand, uploadpack, insteadOf, helpers), so the URL is
# the one sealed at plan time and the command line overrides the rest; the
# user's global config and environment stay trusted (ADR-1152)
os.environ['GIT_TERMINAL_PROMPT'] = '0'
os.environ['GIT_CONFIG_NOSYSTEM'] = '1'
HARD = ['git', '-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/dev/null', '-c', 'core.sshCommand=ssh -o BatchMode=yes', '-c', 'core.askPass=',
        '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always', '-c', 'fetch.recurseSubmodules=false',
        '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'core.quotePath=false', '-c', 'remote.origin.uploadpack=git-upload-pack']
TF = 'terra' + 'form'
TO = 'to' + 'fu'
LOCK = '.' + TF + '.lock.hcl'
GRUNT = 'terra' + 'grunt.hcl'
ORCH = re.compile(r'(^|/)' + 'dig' + r'ger\.ya?ml$', re.I)
CLI = re.compile(r'(^|/)(\.' + TF + r'rc|[^/]*\.tfrc)$', re.I)
PLUGIN_DIR = re.compile(r'(^|/)(\.' + TF + r'|\.?' + TF + r'\.d)(/|$)', re.I)
HCL_EXT = ('.tf', '.' + TO)
JSON_EXT = ('.tf.json', '.' + TO + '.json')
VARS_EXT = ('.tfvars', '.tfvars.json', '.' + TO + 'vars', '.' + TO + 'vars.json')
CI = re.compile(r'^(\.github/|\.gitea/|\.forgejo/|\.circleci/|\.gitlab/|\.gitlab-ci\.yml$|\.buildkite/|\.woodpecker|Jenkinsfile$|azure-pipelines\.ya?ml$|bitbucket-pipelines\.ya?ml$)', re.I)
FILE_CAP = 1 << 20
BUDGET = 64 << 20
# reads run in a fresh bare repo that borrows the repo's objects (alternates):
# its config is empty, and a fetched commit never lands in the repo itself
cd = subprocess.run(HARD + ['-C', wt, 'rev-parse', '--path-format=absolute', '--git-common-dir'], capture_output=True)
if cd.returncode != 0:
    sys.exit(cd.stderr.decode('utf-8', 'replace'))
objects = os.path.join(cd.stdout.decode('utf-8', 'replace').strip(), 'objects')
scratch = tempfile.mkdtemp(prefix='fleet-tfgate-')
atexit.register(shutil.rmtree, scratch, True)
if subprocess.run(HARD + ['init', '-q', '--bare', scratch], capture_output=True).returncode != 0:
    sys.exit('cannot make the scratch repo')
open(os.path.join(scratch, 'objects', 'info', 'alternates'), 'w').write(objects + '\n')
G = HARD + ['--git-dir=' + scratch]
def run(*a):
    r = subprocess.run(G + list(a), capture_output=True)
    if r.returncode != 0:
        sys.exit(r.stderr.decode('utf-8', 'replace'))
    return r.stdout
# any .hcl (the lock file and the grunt configs included), backend and version
# files, the orchestrator config and spacelift's dir; names compared lower-cased
MORE_EXT = ('.hcl', '.hcl.json', '.tfbackend')
NAMES = ('.' + TF + '-version', '.open' + TO + '-version', '.' + TO + '-version', 'atlan' + 'tis.yaml', 'atlan' + 'tis.yml', LOCK, GRUNT)
ORCH_NAMES = ('atlan' + 'tis.yaml', 'atlan' + 'tis.yml')
VERSION_NAMES = ('.' + TF + '-version', '.open' + TO + '-version', '.' + TO + '-version')
def iac(p):
    segs = p.lower().split('/')
    b = segs[-1]
    return (b.endswith(HCL_EXT + JSON_EXT + VARS_EXT + MORE_EXT) or b in NAMES or '.spacelift' in segs[:-1]
            or bool(ORCH.search(p)) or bool(CLI.search(p)) or bool(PLUGIN_DIR.search(p)))
def code_file(p):
    return p.endswith(HCL_EXT + JSON_EXT)
spent = [0]
def blob(rev, p):
    # bounded: a blob over FILE_CAP, or past the budget, cannot be checked
    s = subprocess.run(G + ['cat-file', '-s', rev + ':' + p], capture_output=True)
    if s.returncode != 0:
        return None
    n = int(s.stdout.strip() or 0)
    spent[0] += n
    if n > FILE_CAP or spent[0] > BUDGET:
        return False
    return run('cat-file', 'blob', rev + ':' + p).decode('utf-8', 'replace')
# the base comes from origin itself (git ls-remote), never from the local
# refs/remotes/origin/<default>, which any role's shell can move; a commit the
# repo lacks is fetched by its sha. Either failing refuses (fail closed).
if not re.match(r'^[A-Za-z0-9._/-]+$', default) or default.startswith('-'):
    sys.exit('bad default branch name')
lr = subprocess.run(G + ['ls-remote', '--exit-code', '--upload-pack=git-upload-pack', url, 'refs/heads/' + default], capture_output=True)
if lr.returncode != 0:
    sys.exit('cannot read origin/' + default + ': ' + lr.stderr.decode('utf-8', 'replace'))
rows = [l.split('\t') for l in lr.stdout.decode('utf-8', 'replace').splitlines() if l.strip()]
if len(rows) != 1 or len(rows[0]) != 2 or rows[0][1] != 'refs/heads/' + default or not re.match(r'^[0-9a-f]{40}$', rows[0][0]):
    sys.exit('unexpected ls-remote output for origin/' + default)
remote = rows[0][0]
have = lambda: subprocess.run(G + ['cat-file', '-e', remote + '^{commit}'], capture_output=True).returncode == 0
if not have():
    # a full fetch of that one sha into the scratch repo (the repo's own
    # commits count as haves): --depth would leave a shallow history there
    fr = subprocess.run(G + ['fetch', '--no-tags', '--no-write-fetch-head', '--upload-pack=git-upload-pack', url, remote], capture_output=True)
    if fr.returncode != 0 or not have():
        sys.exit('cannot fetch origin/' + default + ' at ' + remote + ': ' + fr.stderr.decode('utf-8', 'replace'))
base = run('merge-base', remote, sha).decode().strip()
rng = base + '..' + sha
paths = [x.decode('utf-8', 'replace') for x in run('diff', '--name-only', '-z', '--no-renames', rng, '--').split(b'\0') if x]
iac_files = sorted(p for p in paths if iac(p))
touched = bool(iac_files)
# problems stop the run at iac; hints only inform Max at iac-push and never
# decide anything (ADR-1175: every IaC diff stops before the push)
problems, hints = [], []
# symlinks: a link at an IaC path, or one whose target lies in a provider
# plugin dir, is refused (modes from git diff --raw)
raw = run('diff', '--raw', '-z', '--no-renames', rng, '--').split(b'\0')
i = 0
while i + 1 < len(raw):
    meta, p = raw[i].decode('utf-8', 'replace'), raw[i + 1].decode('utf-8', 'replace')
    i += 2
    f = meta.lstrip(':').split()
    if len(f) < 5 or f[1] != '120000':
        continue
    t = blob(sha, p)
    t = t if isinstance(t, str) else ''
    target = os.path.normpath(os.path.join(os.path.dirname(p), t)) if t and not t.startswith('/') else t
    if iac(p) or not t or PLUGIN_DIR.search(t) or PLUGIN_DIR.search(target):
        problems.append('symlink ' + p + ' at an IaC path or into a provider plugin directory')
# HCL: quotes around labels are optional; a bare provisioner line opens a block
EXTRA = re.compile(r'data\s+"?external"?|\bprovisioner\b|local-exec|remote-exec|dev_overrides|provider_installation')
PROVIDER = re.compile(r'required_providers|^\s*"?(source|version)"?\s*[=:]')
BANNED = re.compile(r'hashicorp/(external|local|null)\b|\b(resource|data)\s+"?(local|null)_|\bprovider\s+"?(external|local|null)"?(\s|\{|$)')
def json_findings(doc):
    out = []
    def walk(o, path):
        if isinstance(o, dict):
            for k, v in o.items():
                if k == 'provisioner':
                    out.append('provisioner')
                if k in ('local-exec', 'remote-exec'):
                    out.append(k)
                walk(v, path + [k])
        elif isinstance(o, list):
            for v in o:
                walk(v, path)
    walk(doc, [])
    if isinstance(doc, dict):
        for kind in ('resource', 'data'):
            blk = doc.get(kind)
            if isinstance(blk, dict):
                if kind == 'data' and 'external' in blk:
                    out.append('data external')
                for t in blk:
                    if str(t).startswith(('local_', 'null_')):
                        out.append(kind + ' ' + str(t))
        pv = doc.get('provider')
        names = list(pv.keys()) if isinstance(pv, dict) else [k for x in pv for k in x] if isinstance(pv, list) and all(isinstance(x, dict) for x in pv) else []
        for n in names:
            if n in ('external', 'local', 'null'):
                out.append('provider ' + n)
    return out
def required_providers(doc):
    t = doc.get(TF) if isinstance(doc, dict) else None
    blocks = t if isinstance(t, list) else [t]
    return json.dumps([b.get('required_providers') for b in blocks if isinstance(b, dict)], sort_keys=True)
# code that existing IaC runs at plan time: the "exec stacks" at the base
EXEC_HINT = re.compile(r'data\s+"?external"?|\bprovisioner\b|local-exec|remote-exec|hashicorp/(local|null)\b|\b(resource|data)\s+"?(local|null)_|\bprovider\s+"?(local|null|external)"?')
REF = re.compile(r'(?:program\s*=\s*\[([^\]]*)\]|command\s*=\s*"([^"]*)"|(?:file|templatefile|filebase64|filemd5|filesha256)\(\s*"([^"]*)")', re.S)
STR = re.compile(r'"([^"]*)"')
exec_dirs, exec_refs = set(), set()
if touched or paths:
    tree = [x.decode('utf-8', 'replace') for x in run('ls-tree', '-r', '-z', '--name-only', base).split(b'\0') if x]
    tracked_base = set(tree)
    for p in tree:
        if not code_file(p):
            continue
        t = blob(base, p)
        if t is False:
            problems.append('IaC file ' + p + ' at the base is too large to check')
            continue
        if not t or not EXEC_HINT.search(t):
            continue
        d = os.path.dirname(p)
        exec_dirs.add(d)
        for m in REF.finditer(t):
            for chunk in m.groups():
                if not chunk:
                    continue
                for s in (STR.findall(chunk) if '"' in chunk else [chunk]):
                    for tok in s.split():
                        tok = re.sub(r'\$\{path\.(module|root|cwd)\}/?', '', tok)
                        for cand in (os.path.normpath(os.path.join(d, tok)), os.path.normpath(tok)):
                            if cand in tracked_base:
                                exec_refs.add(cand)
    for p in paths:
        if iac(p):
            continue
        inside = any(d == '' or p.startswith(d + '/') for d in exec_dirs)
        if inside or p in exec_refs:
            problems.append('changes code that existing IaC runs at plan time: ' + p)
if touched:
    for p in paths:
        if CI.match(p):
            hints.append('CI or workflow file ' + p + ' in the same diff')
    for p in paths:
        b = p.rsplit('/', 1)[-1]
        if not iac(p):
            continue
        if PLUGIN_DIR.search(p):
            problems.append('provider plugin directory change in ' + p)
            continue
        if ORCH.search(p):
            hints.append('orchestrator config change in ' + p)
            continue
        if CLI.search(p):
            hints.append('CLI config change in ' + p)
            continue
        # non-HCL IaC files (3.1.1): their own hint, never the HCL text scan
        if b.lower() in ORCH_NAMES or '.spacelift' in p.lower().split('/')[:-1]:
            hints.append('orchestrator config change in ' + p)
            continue
        if b.lower() in VERSION_NAMES:
            hints.append('IaC tool version file change in ' + p)
            continue
        if b == LOCK:
            hints.append('provider lock file change in ' + p)
            continue
        if p.endswith(JSON_EXT):
            new, old = blob(sha, p), blob(base, p)
            if new is False or old is False:
                hints.append(p + ' is too large to check')
                continue
            try:
                nd = json.loads(new) if new is not None else {}
                od = json.loads(old) if old is not None else {}
            except ValueError:
                hints.append(p + ' does not parse as JSON')
                continue
            for f in sorted(set(json_findings(nd)) | set(json_findings(od))):
                if json_findings(nd).count(f) != json_findings(od).count(f) or f in json_findings(nd):
                    hints.append(f + ' in ' + p)
            if required_providers(nd) != required_providers(od):
                hints.append('provider source or version change in ' + p)
            continue
        diff = run('diff', '-U0', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', rng, '--', p)
        if len(diff) > (8 << 20):
            hints.append('diff of ' + p + ' is too large to check')
            continue
        # a line counts only when it changed beyond whitespace: fmt (alignment,
        # indentation) never stops the push
        norm = lambda t: ' '.join(t.split())
        added, removed = [], []
        for line in diff.decode('utf-8', 'replace').splitlines():
            if line.startswith(('+++', '---')) or not line.startswith(('+', '-')):
                continue
            (added if line.startswith('+') else removed).append(line[1:])
        na, nr = set(norm(x) for x in added), set(norm(x) for x in removed)
        real_added = [x for x in added if norm(x) not in nr]
        real_removed = [x for x in removed if norm(x) not in na]
        for body in real_added:
            if EXTRA.search(body):
                hints.append('added ' + EXTRA.search(body).group(0) + ' in ' + p)
        for body in real_added + real_removed:
            if PROVIDER.search(body):
                hints.append('provider source or version change in ' + p)
            if BANNED.search(body):
                hints.append('external, local or null provider or local_/null_ resource change in ' + p)
problems, hints = sorted(set(problems)), sorted(set(hints))
out = {'touched': touched, 'iac_files': iac_files, 'problems': problems, 'hints': hints, 'args': [wt, default, sha, url]}
out['program'] = _PROG
out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
print(json.dumps(out, ensure_ascii=False))
