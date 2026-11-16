
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
os.environ['GIT_CONFIG_NOSYSTEM'] = '1'
# fleet 7.2.0 (L2178): an output over INLINE_CAP is not relayed inline. File mode writes it to a
# content-addressed file in the run scratch and prints a summary of counts and hashes; read mode
# prints 50-entry pages of that file. Every added line is a new def or one column-0 statement.
INLINE_CAP = 8192
SUMMARY_CAP = 4096
PAGE = 50
def list_sha(xs):
    return hashlib.sha256(json.dumps(sorted(xs), separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
def hit_paths(hits):
    return sorted(set(h.rsplit(':', 1)[0] for h in hits))
def digest_of(o):
    return hashlib.sha256(json.dumps(o, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
def read_mode(argv):
    def no(msg):
        sys.exit('FLEET_CALLERS_READ: ' + msg)
    if len(argv) != 4:
        no('read mode takes <file> <part> <symbols json> <page>')
    f, part, syms_s, page_s = argv
    m = re.fullmatch(r'callers-([0-9a-f]{64})\.json', os.path.basename(f))
    if not m:
        no('the file name is not callers-<64 lowercase hex>.json: ' + f)
    try:
        with open(f, 'rb') as fh:
            data = fh.read(1 << 24)
    except OSError as e:
        no('cannot read ' + f + ' (' + str(e) + ')')
    if hashlib.sha256(data).hexdigest() != m.group(1):
        no('the bytes of ' + f + ' do not hash to its name')
    try:
        obj = json.loads(data.decode('utf-8'))
    except ValueError:
        obj = None
    occ = obj.get('occurrences') if isinstance(obj, dict) else None
    adc = obj.get('auto_dont_care') if isinstance(obj, dict) else None
    if not isinstance(occ, dict) or not isinstance(adc, dict):
        no('the file is not a callers object')
    if part not in ('all', 'auto', 'paths'):
        no('part is not all, auto or paths: ' + part)
    try:
        syms = json.loads(syms_s)
    except ValueError:
        syms = None
    if not isinstance(syms, list) or not syms or not all(isinstance(s, str) for s in syms) or len(set(syms)) != len(syms):
        no('symbols are not a non-empty JSON list of distinct strings')
    for s in syms:
        if not isinstance(occ.get(s), list) or not isinstance(adc.get(s, []), list):
            no('symbol ' + s + ' is not in the file')
    if not re.fullmatch(r'[0-9]+', page_s):
        no('page is not an integer >= 0: ' + page_s)
    entries = []
    for s in sorted(syms):
        lst = sorted(occ[s]) if part == 'all' else sorted(adc.get(s, [])) if part == 'auto' else hit_paths(occ[s])
        entries.extend((s, e) for e in lst)
    count = max(1, -(-len(entries) // PAGE))
    k = int(page_s)
    if k >= count:
        no('page %d is not below the page count %d' % (k, count))
    hits = {}
    for s, e in entries[PAGE * k:PAGE * k + PAGE]:
        hits.setdefault(s, []).append(e)
    o = {'part': part, 'page': {'index': k, 'count': count}, 'hits': hits, 'args': list(argv), 'program': _PROG}
    o['digest'] = digest_of(o)
    print(json.dumps(o, sort_keys=True, ensure_ascii=False))
    sys.exit(0)
def file_args(argv):
    if len(argv) != 6:
        sys.exit('FLEET_CALLERS_FILE: file mode takes <worktree> <plan_path> <symbols json> <cap> <scratch_dir>')
    return list(argv[1:])
def file_mode(text, out, syms, args):
    import tempfile
    data = text.encode('utf-8')
    path = os.path.join(args[4], 'callers', 'callers-' + hashlib.sha256(data).hexdigest() + '.json')
    symbols = {}
    for s in syms:
        hits = out['occurrences'][s]
        paths = hit_paths(hits)
        symbols[s] = {'count': len(hits), 'sha256': list_sha(hits), 'auto_count': len(out['auto_dont_care'][s]), 'path_count': len(paths), 'paths_sha256': list_sha(paths)}
    o = {'symbols': symbols, 'capped': out['capped'], 'doctest_md': out['doctest_md'], 'file': path, 'args': list(args), 'program': _PROG}
    o['digest'] = digest_of(o)
    t = json.dumps(o, sort_keys=True, ensure_ascii=False)
    n = len(t.encode('utf-8'))
    if n > SUMMARY_CAP:
        sys.exit('FLEET_CALLERS_RELAY_CAP: the callers summary is over the %d-byte summary cap (%d bytes; symbols: %s)' % (SUMMARY_CAP, n, ', '.join(syms)[:300]))
    tmp = None
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix='.callers-', suffix='.tmp')
        with os.fdopen(fd, 'wb') as fh:
            fh.write(data)
        os.replace(tmp, path)
    except OSError as e:
        if tmp and os.path.exists(tmp):
            os.unlink(tmp)
        sys.exit('FLEET_CALLERS_FILE: cannot write the callers file %s (%s)' % (path, e))
    print(t)
    sys.exit(0)
if len(sys.argv) > 1 and sys.argv[1] == 'read': read_mode(sys.argv[2:])
FILE_MODE = len(sys.argv) > 1 and sys.argv[1] == 'file'
FILE_ARGS = file_args(sys.argv[1:]) if FILE_MODE else None
if FILE_MODE: sys.argv[1:] = FILE_ARGS[:4]
wt, plan_path, syms, cap = sys.argv[1], sys.argv[2], json.loads(sys.argv[3]), int(sys.argv[4])
G = ['git', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-C', wt]
occ = {}
capped = []
for s in syms:
    r = subprocess.run(G + ['grep', '-n', '-z', '-I', '-w', '-F', '--full-name', '--no-color', '-e', s, '--', '.', ':(exclude,literal)' + plan_path], capture_output=True)
    if r.returncode not in (0, 1):
        sys.exit(r.stderr.decode('utf-8', 'replace'))
    hits = set()
    for rec in r.stdout.split(b'\n'):
        if not rec:
            continue
        parts = rec.split(b'\0', 2)
        if len(parts) != 3 or not parts[1].isdigit():
            sys.exit('unparseable git grep output: ' + repr(rec[:200]))
        hits.add(parts[0].decode('utf-8', 'replace') + ':' + str(int(parts[1])))
    if len(hits) > cap:
        capped.append(s)
        occ[s] = []
    else:
        occ[s] = sorted(hits)
# fleet 4.0.0 (1989, ADR-1185): hits in doc and lock files are auto
# dont_care, unless the doc is collected as a doctest: (a) a pytest config or
# conftest.py names --doctest-glob or doctest_optionflags (every doc stays
# mapped), (b) a tracked .rs file include_str!s a file of that basename.
DOC_RE = re.compile(r'.*\.(md|rst|adoc)', re.I)
NOTE_RE = re.compile(r'(CHANGELOG|LICENSE)([-_][A-Za-z0-9-]+)*(\.[0-9]+)*(\.(md|rst|adoc|txt))?', re.I)
LOCKS = ('Cargo.lock', 'uv.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock', 'Gemfile.lock', 'go.sum')
def base(p):
    return p.rsplit('/', 1)[-1]
def doc_or_lock(p):
    b = base(p)
    return bool(DOC_RE.fullmatch(b) or NOTE_RE.fullmatch(b)) or b in LOCKS
def grep(args):
    r = subprocess.run(G + ['grep', '-I', '--no-color'] + args, capture_output=True)
    if r.returncode not in (0, 1):
        sys.exit(r.stderr.decode('utf-8', 'replace'))
    return r.stdout.decode('utf-8', 'replace')
cfg = grep(['-l', '--full-name', '-F', '-e', '--doctest-glob', '-e', 'doctest_optionflags', '--', ':(top,literal)pyproject.toml', ':(top,literal)pytest.ini', ':(top,literal)setup.cfg', ':(top,literal)tox.ini', ':(top,glob)**/conftest.py'])
all_docs = bool(cfg.strip())
included = set()
for line in grep(['-h', '-o', '-E', '-e', 'include_str![[:space:]]*\\([[:space:]]*"[^"]*"', '--', ':(top,glob)**/*.rs']).splitlines():
    for m in re.findall(r'"([^"]*)"', line):
        included.add(base(m))
doctest = set()
auto = {}
for s in syms:
    auto[s] = []
    for h in occ[s]:
        p = h.rsplit(':', 1)[0]
        if DOC_RE.fullmatch(base(p)) and (all_docs or base(p) in included):
            doctest.add(p)
        elif doc_or_lock(p):
            auto[s].append(h)
out = {'occurrences': occ, 'capped': sorted(capped), 'auto_dont_care': auto, 'doctest_md': sorted(doctest)}
out['program'] = _PROG
out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
text = json.dumps(out, sort_keys=True, ensure_ascii=False)
# fleet 7.2.0 (L2178): file mode always exits here; an inline output over INLINE_CAP takes the on-disk handoff
if FILE_MODE: file_mode(text, out, syms, FILE_ARGS)
if len(text.encode('utf-8')) > INLINE_CAP: sys.exit('FLEET_CALLERS_ON_DISK: the callers output is over the %d-byte inline cap (%d bytes; symbols: %s)' % (INLINE_CAP, len(text.encode('utf-8')), ', '.join(syms)[:300]))
# fleet 6.3.0 (review M1): a relay agent cannot copy an output this size; a fixed marker, and the workflow splits the batch
RELAY_CAP = 65536
if len(text.encode('utf-8')) > RELAY_CAP:
    sys.exit('FLEET_CALLERS_RELAY_CAP: the callers output is over the %d-byte relay cap (%d bytes; symbols: %s)' % (RELAY_CAP, len(text.encode('utf-8')), ', '.join(syms)[:300]))
print(text)
