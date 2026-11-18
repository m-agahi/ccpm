
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
# fleet 8.0.0 (G7, ADR-1315, ADR-1316): the security gate. Args: <worktree> <base> <tree> <exclude json>
# <est_diff_lines> <image>. Findings are on the added lines (git diff -U0 <base> <tree>) of the changed
# production files (the <exclude> paths, the frozen tests, aside): [{path, lines, rule, kind: code|secret}].
# Always on: a risky-API grep, a size check (added lines > 1.5 x est_diff_lines: path <diff>, line 0)
# and the string literals of the frozen tests found in added lines. The container part: semgrep and
# gitleaks run only in the image pinned by digest, with podman (else docker), never pulled here, network
# off, read-only, as this uid, no capability; the mounts are read-only: a scan dir that holds only the
# judged blobs of the changed production files (no ignore or scanner config file of the judged tree)
# and a rules dir: the plugin's rule file (RULES_SHA256) plus the repo's rules read from <base>. No
# runtime, no image or no pinned digest: partial (always-on checks only). A tool that errors, or output
# that does not parse: a non-zero exit (the workflow retries once, then stops at gate gates). This
# program runs git and the runtime only (EXE); it runs no repo code and no host scanner.
# G7b: every git pathspec is literal (GIT_LITERAL_PATHSPECS), names round-trip as bytes (os.fsdecode)
# and are shown with backslashreplace; a listed name with no diff section, or more than CAP non-secret
# findings (a human reviews such a diff), is a non-zero exit.
import hashlib, json, os, re, secrets, shutil, subprocess, sys, tempfile, time
EXE = ('podman', 'docker', 'git')
RULES = os.path.join(os.path.dirname(os.path.dirname(os.path.realpath(globals()['__file__']))), 'skills', 'build-task', 'sec-rules.yml')
RULES_SHA256 = 'd342475a6e8afd3bcb31cdf74f8c4c88bb0c16a4e2630d88a29f029f46a22620'
DEADLINE, CAP, BIG, LEAKS = 540, 200, 4 << 20, 99
# the attribute-safe diff of G2: no attributes file, no system attributes, text, no textconv or driver
G = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.quotePath=false', '-c', 'core.attributesFile=/dev/null']
D = ['--text', '--no-textconv', '--no-ext-diff', '--no-renames', '--no-color']
# names a scanner reads from the scanned dir (ignore lists, configs): scanned under a renamed path
# (_fleet_<name>), mapped back; the scan dir's own .semgrepignore is empty (semgrep's default ignore
# list off), and a file semgrep's paths.scanned lacks makes the result partial
SKIP = {'.semgrepignore', '.gitignore', '.gitleaksignore', '.gitleaks.toml', '.semgrep.yml', '.semgrep.yaml', '.semgrep'}
LANG = ('.py', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx')
RISKY = (
    ('grep: shell=True', r'\bshell\s*=\s*True\b', 'code'),
    ('grep: eval/exec', r'(?<![\w.])(eval|exec)\s*\(', 'code'),
    ('grep: yaml.load without SafeLoader', r'\byaml\.load\s*\((?!.*Safe)', 'code'),
    ('grep: pickle/marshal load', r'\b(c?[Pp]ickle|marshal|dill)\.loads?\s*\(', 'code'),
    ('grep: SQL built from strings', r'\.(execute|executemany|executescript|raw)\s*\(\s*(f["\']|["\'][^"\']*["\']\s*(%|\+|\.format\b))', 'code'),
    ('grep: TLS verification off', r'verify\s*=\s*False|CERT_NONE|_create_unverified_context|check_hostname\s*=\s*False|rejectUnauthorized\s*:\s*false|InsecureSkipVerify\s*:\s*true|NODE_TLS_REJECT_UNAUTHORIZED', 'code'),
    ('grep: os.system/popen', r'\bos\.(system|popen)\s*\(', 'code'),
    ('grep: nosemgrep marker', r'nosemgrep', 'code'),
    ('grep: gitleaks:allow marker', r'gitleaks:allow', 'secret'),
)
os.environ['GIT_TERMINAL_PROMPT'] = '0'
os.environ['GIT_ATTR_NOSYSTEM'] = '1'
# a changed name is never a pathspec (`:(glob)*.py`, `a[1].py`)
os.environ['GIT_LITERAL_PATHSPECS'] = '1'
start = time.monotonic()
def show(o):
    # a name that is not UTF-8 holds surrogates (os.fsdecode): shown as \\x.. escapes, never merged
    if isinstance(o, str):
        return os.fsencode(o).decode('utf-8', 'backslashreplace')
    if isinstance(o, list):
        return [show(x) for x in o]
    if isinstance(o, dict):
        return {k: show(v) for k, v in o.items()}
    return o
def emit(status, reason, findings):
    out = show({'status': status, 'reason': reason, 'findings': findings, 'args': sys.argv[1:], 'program': _PROG})
    out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0)
def lift():
    # the runtime (a Go program) needs more address space than this program's cap
    for k in (_r.RLIMIT_AS, _r.RLIMIT_CPU):
        _r.setrlimit(k, (_r.getrlimit(k)[1],) * 2)
def call(argv, timeout):
    # the one way this program starts another: an allowlisted executable on the clean PATH
    if argv[0] not in EXE or not shutil.which(argv[0]):
        sys.exit('refusing an executable outside the allowlist: ' + argv[0])
    return subprocess.run([shutil.which(argv[0])] + argv[1:], capture_output=True, stdin=subprocess.DEVNULL, timeout=timeout, preexec_fn=lift)
def git(*a, ok=False):
    r = call(['git'] + G + ['-C', wt] + list(a), 120)
    if r.returncode != 0 and not ok:
        sys.exit('git ' + ' '.join(a[:2]) + ' failed: ' + r.stderr.decode('utf-8', 'replace')[-1000:])
    return r.stdout if r.returncode == 0 else None
a = sys.argv[1:]
if len(a) != 6:
    sys.exit('usage: sec_scan.py <worktree> <base> <tree> <exclude json> <est_diff_lines> <image>')
wt, base, tree, est, image = a[0], a[1], a[2], a[4], a[5]
try:
    exclude = json.loads(a[3])
except ValueError:
    exclude = None
if not os.path.isabs(wt) or not os.path.isdir(wt) or not all(re.match(r'^[0-9a-f]{40}$', x) for x in (base, tree)):
    sys.exit('bad worktree, base or tree')
if not isinstance(exclude, list) or not all(isinstance(x, str) for x in exclude) or not re.match(r'^(null|[0-9]+(\.[0-9]+)?)$', est):
    sys.exit('exclude is not a JSON list of strings or est_diff_lines is not a number or null')
scratch = os.path.join(os.path.realpath(os.path.dirname(os.path.realpath(wt))), 'scratch')
os.environ['PATH'] = clean_path((wt, scratch))
# the added lines {path: {line: text}} of the changed production files
added = {}
for n in os.fsdecode(git('diff', '--name-only', '-z', '--diff-filter=AMT', *D, base, tree)).split('\0'):
    if not n or n in exclude:
        continue
    rows, cur, out = {}, None, git('diff', '-U0', *D, base, tree, '--', n)
    if not out.startswith(b'diff --git '):
        sys.exit('no diff section for a listed path: ' + show(n))
    for t in out.decode('utf-8', 'replace').split('\n'):
        h = re.match(r'^@@ -\S+ \+(\d+)(?:,\d+)? @@', t)
        if h:
            cur = int(h.group(1))
        elif cur is not None and t[:1] == '+':
            rows[cur] = t[1:]
            cur += 1
    if rows:
        added[n] = rows
found, notes = {}, []
def hit(path, line, rule, kind):
    found.setdefault((path, rule, kind), set()).add(line)
def span(path, a, b, rule, kind):
    # a tool result counts when any line of its span is added; it records those lines
    if path in added and isinstance(a, int):
        for ln in range(a, (b if isinstance(b, int) and b >= a else a) + 1):
            if ln in added[path]:
                hit(path, ln, rule, kind)
for p, rows in added.items():
    for ln, t in rows.items():
        for rule, rx, kind in RISKY:
            if re.search(rx, t):
                hit(p, ln, rule, kind)
total = sum(len(r) for r in added.values())
if est == 'null':
    notes.append('no est_diff_lines: size not checked')
elif total > 1.5 * float(est):
    hit('<diff>', 0, 'size: %d added production lines > 1.5 x est_diff_lines %s' % (total, est), 'code')
# the string literals (8 to 200 characters) of the frozen test files in the judged tree
lits = set()
for f in exclude:
    b = git('cat-file', 'blob', tree + ':' + f, ok=True)
    if b:
        lits.update(m.group(2) for m in re.finditer(r'(["\'])([^"\'\\\n]{8,200})\1', b.decode('utf-8', 'replace')))
for p, rows in added.items():
    for ln, t in rows.items():
        for s in lits:
            if '"' + s + '"' in t or "'" + s + "'" in t:
                hit(p, ln, 'frozen-test literal: ' + s[:60], 'code')
def result(status, reason):
    # every secret first; more than CAP others is an error (never a cut list): a human reviews the diff
    out = sorted(({'path': p, 'lines': sorted(ls), 'rule': r, 'kind': k} for (p, r, k), ls in found.items()), key=lambda f: (f['kind'] != 'secret', f['path'], f['rule']))
    n = sum(f['kind'] != 'secret' for f in out)
    if n > CAP:
        sys.exit('more than %d non-secret findings (%d): a human reviews this diff' % (CAP, n))
    emit(status, '; '.join(x for x in [reason] + notes if x) or None, out)
def skip(why):
    result('partial', 'container scan not run: ' + why + '; always-on checks only')
rt = next((t for t in ('podman', 'docker') if shutil.which(t)), None)
if not re.match(r'^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$', image):
    skip('image digest not pinned')
if rt is None:
    skip('no container runtime (podman or docker)')
try:
    code = call([rt, 'image', 'exists' if rt == 'podman' else 'inspect', image], 30).returncode
except subprocess.TimeoutExpired:
    code = 'timeout'
if code != 0:
    skip('image not present locally (exit %s)' % code)
with open(RULES, 'rb') as fh:
    rules = fh.read()
if hashlib.sha256(rules).hexdigest() != RULES_SHA256:
    sys.exit('the plugin rule file differs from RULES_SHA256: ' + RULES)
if not added:
    result('ran', 'no added production line')
def safe(c):
    # a scan-dir name: SKIP names renamed; a name that is not UTF-8 gets an ASCII one (_fleet_x<hex>, the
    # extension kept so semgrep picks the language), since the Go tools print such a name with U+FFFD
    try:
        os.fsencode(c).decode('utf-8')
    except UnicodeDecodeError:
        e = os.path.splitext(c)[1]
        return '_fleet_x' + os.fsencode(c).hex() + (e if e.isascii() else '')
    return '_fleet_' + c if c in SKIP else c
# scan-dir path -> changed path
dst = {'/'.join(safe(c) for c in p.split('/')): p for p in added}
if len(dst) != len(added):
    sys.exit('two changed paths map to one scan path')
os.makedirs(scratch, exist_ok=True)
tmp = tempfile.mkdtemp(prefix='sec-', dir=scratch)
name = 'fleet-sec-' + secrets.token_hex(6)
def put(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as fh:
        fh.write(data)
def scan(argv, ok):
    tool = argv[argv.index('--entrypoint') + 1]
    try:
        r = call(argv, max(1, DEADLINE - (time.monotonic() - start)))
    except subprocess.TimeoutExpired:
        call([rt, 'rm', '-f', name], 60)
        sys.exit('%s: the %d s deadline was hit' % (tool, DEADLINE))
    try:
        out = json.loads(r.stdout.decode('utf-8')) if r.returncode in ok else None
    except ValueError:
        out = None
    if out is None:
        sys.exit('%s exit %d: %s' % (tool, r.returncode, r.stderr.decode('utf-8', 'replace')[-1000:]))
    return out
try:
    src, rd = os.path.join(tmp, 'src'), os.path.join(tmp, 'rules')
    for d, p in dst.items():
        if '..' in p.split('/') or os.path.isabs(p):
            sys.exit('bad path in the diff: ' + p)
        b = git('cat-file', 'blob', tree + ':' + p)
        if len(b) > BIG:
            notes.append('not scanned (over 4 MiB): ' + p)
            del added[p]
        else:
            put(os.path.join(src, d), b)
    put(os.path.join(src, '.semgrepignore'), b'')
    put(os.path.join(rd, 'fleet.yml'), rules)
    # the repo's own rules, from the base only (the judged tree never sets the rules)
    ls = git('ls-tree', '-r', '-z', '--name-only', base, '--', '.semgrep.yml', '.semgrep.yaml', '.semgrep').decode('utf-8', 'replace').split('\0')
    for i, n in enumerate(sorted(x for x in ls if x.endswith(('.yml', '.yaml')))):
        put(os.path.join(rd, 'repo-%d.yml' % i), git('cat-file', 'blob', base + ':' + n))
    # world-readable: a rootless runtime maps this uid to another one inside the container
    for r, ds, ns in os.walk(tmp):
        os.chmod(r, 0o755)
        for n in ns:
            os.chmod(os.path.join(r, n), 0o644)
    pre = [rt, 'run', '--rm', '--pull=never', '--network', 'none', '--read-only', '--tmpfs', '/tmp', '--user', '%d:%d' % (os.getuid(), os.getgid()),
           '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL', '-e', 'HOME=/tmp', '-w', '/tmp', '--name', name, '-v', src + ':/src:ro', '-v', rd + ':/rules:ro']
    # semgrep: exit 0 with a results list (findings do not change the exit without --error); any other exit is an error
    sg = scan(pre + ['--entrypoint', 'semgrep', image, 'scan', '--metrics=off', '--disable-version-check', '--disable-nosem', '--max-target-bytes=0', '--config', '/rules', '--json', '/src'], (0,))
    # gitleaks 8.30.1: 0 clean, LEAKS findings, 1 an error (also with findings), 126 a bad flag; secrets redacted
    gl = scan(pre + ['--entrypoint', 'gitleaks', image, 'dir', '--no-banner', '--redact=100', '--exit-code', str(LEAKS), '-f', 'json', '-r', '-', '/src'], (0, LEAKS))
    if not isinstance(sg, dict) or not isinstance(sg.get('results'), list) or not isinstance((sg.get('paths') or {}).get('scanned'), list) or not isinstance(gl, list):
        sys.exit('scanner output has no results or paths.scanned list')
    rel = lambda p: dst.get(p[5:]) if isinstance(p, str) and p.startswith('/src/') else None
    for x in sg['results']:
        if isinstance(x, dict):
            span(rel(x.get('path')), (x.get('start') or {}).get('line'), (x.get('end') or {}).get('line'), 'semgrep: ' + re.sub(r'^.*?(fleet\.)', r'\1', str(x.get('check_id'))), 'code')
    for x in gl:
        if isinstance(x, dict):
            span(rel(x.get('File')), x.get('StartLine'), x.get('EndLine'), 'gitleaks: ' + str(x.get('RuleID')), 'secret')
    seen = {rel(p) for p in sg['paths']['scanned']}
    miss = sorted(dst[d] for d in dst if dst[d] in added and d.endswith(LANG) and dst[d] not in seen)
    if miss:
        notes.append('not scanned by semgrep: ' + ', '.join(miss))
    errs = sg.get('errors') or []
    result('partial' if errs or notes else 'ran', 'semgrep reported %d error(s)' % len(errs) if errs else None)
finally:
    shutil.rmtree(tmp, ignore_errors=True)
