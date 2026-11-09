
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
import hashlib, json, os, re, subprocess, sys
os.environ['GIT_CONFIG_NOSYSTEM'] = '1'
wt, base, tree, excl = sys.argv[1], sys.argv[2], sys.argv[3], set(json.loads(sys.argv[4]))
G = ['git', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-C', wt]
def run(*a):
    r = subprocess.run(G + list(a), capture_output=True)
    if r.returncode != 0:
        sys.exit(r.stderr.decode('utf-8', 'replace'))
    return r.stdout
LANG = {}
for k, exts in (('py', '.py .pyi'), ('js', '.js .mjs .cjs .jsx .ts .tsx .mts .cts'), ('sh', '.sh .bash .zsh .ksh .bats'),
                ('kw', '.go .rs .rb .kt .kts .scala .swift .php .pl .pm .lua'), ('c', '.c .h .cc .cpp .cxx .hpp .java .cs')):
    for e in exts.split():
        LANG[e] = k
IDENT = re.compile(r'[A-Za-z_][A-Za-z0-9_]{0,127}$')
KW = {'if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'elif', 'new', 'sizeof', 'function', 'do', 'try', 'with', 'match', 'when', 'until', 'unless', 'case', 'throw', 'await', 'yield', 'typeof', 'delete', 'void',
      'and', 'or', 'not', 'in', 'is', 'as', 'goto', 'puts', 'print', 'echo', 'defer', 'go', 'raise', 'assert', 'pass'}
KEYWORD_DEF = re.compile(r'^\s*(?:(?:export|default|pub(?:\([^)]*\))?|public|private|protected|internal|static|async|unsafe|extern|override|abstract|final|open|inline|suspend|local)\s+)*'
                         r'(?:def|fn|func|fun|function|sub|proc|class|struct|enum|trait|interface|impl|module|type|object|record|union)\b\s*\*?\s*'
                         r'(?:\([^)]*\)\s*)?(?:self\.)?([A-Za-z_][A-Za-z0-9_]*)')
TOP_ASSIGN = {
    'py': re.compile(r'^([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]*)?=(?!=)'),
    'js': re.compile(r'^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[=:]'),
    'sh': re.compile(r'^(?:readonly\s+|export\s+|declare\s+(?:-\w+\s+)*)?([A-Za-z_][A-Za-z0-9_]*)='),
    'kw': re.compile(r'^(?:pub\s+)?(?:const|var|let|static|val)\s+(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)|^([A-Z][A-Za-z0-9_]*)\s*=(?!=)'),
    'c': re.compile(r'^(?:(?:static|const|extern|public|private|protected|final|readonly)\s+)+[A-Za-z_][\w<>\[\],.*&:?]*\s+\*?([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|;|\[)'),
}
JS_METHOD = re.compile(r'^\s+(?:(?:static|async|get|set|public|private|protected|readonly|override)\s+)*\*?([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^;]*\)\s*(?::[^{;]*)?\{\s*$')
JS_ARROW = re.compile(r'^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][A-Za-z0-9_$]*\s*=>)')
JS_MEMBER_FN = re.compile(r'^\s*(?:[A-Za-z_$][A-Za-z0-9_$]*\.)+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][A-Za-z0-9_$]*\s*=>)')
SH_FUNC = re.compile(r'^\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(\)')
C_FUNC = re.compile(r'^\s*(?:[A-Za-z_][\w<>\[\],.*&:?]*\s+)+[*&]?([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*$')
def defname(lang, line):
    first = line.split()[0] if line.strip() else ''
    for rx in ([KEYWORD_DEF, JS_ARROW, JS_MEMBER_FN, JS_METHOD] if lang == 'js' else [SH_FUNC, KEYWORD_DEF] if lang == 'sh'
               else [KEYWORD_DEF, C_FUNC] if lang == 'c' else [KEYWORD_DEF]):
        m = rx.match(line)
        if m and m.group(1) not in KW and (rx is not C_FUNC or first not in KW):
            return m.group(1)
    m = TOP_ASSIGN[lang].match(line)
    n = m and next((g for g in m.groups() if g), None)
    if n and n not in KW:
        return n
    return None
def indent(line):
    return len(line) - len(line.lstrip(' \t'))
HUNK = re.compile(rb'^@@ -([0-9]+)(?:,([0-9]+))? \+[0-9]+(?:,[0-9]+)? @@')
DECO = re.compile(r'^\s*(?:@[A-Za-z_]|#\[)')
MAKE_TARGET = re.compile(r'^([A-Za-z_][A-Za-z0-9_.-]*)\s*::?(?!=)')
MAKE_VAR = re.compile(r'^(?:override\s+|export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[:?+!]?=')
def mk_defname(line):
    m = MAKE_TARGET.match(line) or MAKE_VAR.match(line)
    return m.group(1) if m else None
def lang_of(path, blob):
    base_name = path.rsplit('/', 1)[-1]
    if base_name in ('Makefile', 'makefile', 'GNUmakefile') or base_name.endswith('.mk'):
        return 'mk'
    ext = os.path.splitext(base_name)[1].lower()
    if ext:
        return LANG.get(ext)
    first = blob.split(b'\n', 1)[0]
    if first.startswith(b'#!'):
        if b'python' in first:
            return 'py'
        if b'node' in first:
            return 'js'
        if re.search(rb'\b(ba|z|da|k)?sh\b', first):
            return 'sh'
    return None
def esc(p):
    # a path name is printed with every non-printable character escaped
    return ''.join(c if c.isprintable() else '\\u%04x' % ord(c) for c in p)
CONTAINER = re.compile(r'^\s*(?:(?:export|default|pub(?:\([^)]*\))?|public|private|protected|internal|abstract|final|sealed|open|data|static|partial)\s+)*(?:class|struct|impl|interface|trait|object|enum|module)\b')
# a line that only closes a block (brace languages; a lone ) or ] too)
CLOSE_ONLY = re.compile(r'^\s*[)}\]]+[;,]?\s*$')
# a line that only opens a block (Allman style: the brace under its signature)
OPEN_ONLY = re.compile(r'^\s*\{\s*$')
# the closing line of a multi-line signature: ")", ") -> T:", "):", ") {", "): T {", ") T {"
SIG_CLOSE = re.compile(r'^\s*\)\s*(?:->\s*[^:{]+)?(?::\s*[^{]*)?(?:[A-Za-z_][\w.\[\]*<>, ]*)?\s*[:{]?\s*$')
def parens(line):
    return line.count('(') - line.count(')')
def opener_of(lines, k):
    # the line that opens the parenthesis lines[k] closes, or None
    depth = 0
    for q in range(k, -1, -1):
        depth += parens(lines[q])
        if depth >= 0 and q < k:
            return q
    return None
def span(lines, i):
    # 1-based last line of the definition at lines[i]: a multi-line signature,
    # then every deeper-indented line after it
    d, k = indent(lines[i]), i
    depth = parens(lines[i])
    while depth > 0 and k + 1 < len(lines):
        k += 1
        depth += parens(lines[k])
    end = k
    for q in range(k + 1, len(lines)):
        if not lines[q].strip():
            continue
        if indent(lines[q]) <= d:
            break
        end = q
    return end + 1
defs, excluded, unclassified, unattributed = {}, set(), set(), set()
entries = []
st = run('diff', '--name-status', '-z', '-M', base, tree, '--').split(b'\0')
i = 0
while i < len(st) and st[i]:
    status = st[i].decode()
    if status[:1] in ('R', 'C'):
        entries.append((status[:1], st[i + 1].decode('utf-8', 'replace'), st[i + 2].decode('utf-8', 'replace')))
        i += 3
    else:
        entries.append((status[:1], st[i + 1].decode('utf-8', 'replace'), None))
        i += 2
for status, path, newpath in entries:
    # a rename is diffed old blob -> new blob at the base path; a copy, like an add, is new code
    if status not in ('M', 'T', 'D', 'R'):
        continue
    # a rename onto an excluded path (a test, the plan doc): the old file is gone
    if status == 'R' and newpath in excl and path not in excl:
        status, newpath = 'D', None
    if path in excl or (newpath is not None and newpath in excl):
        excluded.add(esc(path))
        continue
    blob = run('cat-file', 'blob', base + ':' + path)
    lang = lang_of(path, blob)
    if lang is None or b'\0' in blob:
        unclassified.add(esc(path))
        continue
    dn = mk_defname if lang == 'mk' else (lambda x, _l=lang: defname(_l, x))
    braces = lang in ('js', 'kw', 'c')
    lines = blob.decode('utf-8', 'replace').split('\n')
    by_name = {}
    for n, t in enumerate(lines):
        d = dn(t)
        if d:
            by_name.setdefault(d, []).append(n)
    deco = (lambda x: False) if lang in ('mk', 'sh') else (lambda x: bool(DECO.match(x)))
    def next_base_def(k):
        # the definition a decorator above lines[k] belongs to, or None
        for q in range(max(k, 0), len(lines)):
            t = lines[q]
            if not t.strip() or deco(t):
                continue
            d = dn(t)
            return (d, q) if d else None
        return None
    def record(name, n):
        defs[(name, esc(path) + ':' + str(n + 1))] = span(lines, n)
    def sig_name(q, closer):
        # a multi-line signature opened at lines[q]: its definition name
        d = dn(lines[q])
        if d:
            return d
        if braces and closer.rstrip().endswith('{'):
            m = re.match(r'^\s*(?:(?:static|async|get|set|public|private|protected|readonly|override|func)\s+)*\*?([A-Za-z_$][A-Za-z0-9_$]*)\s*\($', lines[q].rstrip())
            if m and m.group(1) not in KW:
                return m.group(1)
        return None
    def enclosing(L, ind):
        # (name, index) of the innermost definition above lines[L] with a smaller indent, or None
        k = L
        while k >= 0:
            t = lines[k]
            if not t.strip() or indent(t) >= ind:
                k -= 1
                continue
            d = dn(t)
            if d:
                return (d, k)
            if SIG_CLOSE.match(t) and parens(t) < 0:
                q = opener_of(lines, k)
                if q is not None:
                    d = sig_name(q, t)
                    if d and indent(lines[q]) < ind:
                        return (d, q)
                    k = q - 1
                    continue
            if braces and OPEN_ONLY.match(t):
                # an Allman brace: its signature is the line above
                k -= 1
                continue
            if indent(t) == 0:
                return None
            ind = indent(t)
            k -= 1
        return None
    def attribute(L, ind, at_line):
        e = enclosing(L, ind)
        if e:
            record(*e)
        else:
            unattributed.add(esc(path) + ':' + str(at_line))
    def opens_block(t):
        x = t.rstrip()
        return x.endswith((':', '{', '(', '[', ',', '=>', '\\')) or (lang == 'mk')
    if status == 'R':
        out = run('diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', base + ':' + path, tree + ':' + newpath)
    else:
        out = run('diff', '-U0', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', base, tree, '--', path)
    if b'\nBinary files ' in out or out.startswith(b'Binary files '):
        unclassified.add(esc(path))
        continue
    hunks = []
    for raw in out.split(b'\n'):
        m = HUNK.match(raw)
        if m:
            hunks.append([int(m.group(1)), 1 if m.group(2) is None else int(m.group(2)), []])
        elif hunks and raw.startswith(b'+') and not raw.startswith(b'+++ '):
            hunks[-1][2].append(raw[1:].decode('utf-8', 'replace'))
    for a, b, added in hunks:
        for L in range(a - 1, a - 1 + b):
            t = lines[L] if L < len(lines) else ''
            if not t.strip():
                continue
            d = dn(t)
            if d:
                record(d, L)
            elif deco(t):
                nd = next_base_def(L + 1)
                if nd:
                    record(*nd)
                else:
                    attribute(L - 1, indent(t), L + 1)
            elif braces and indent(t) == 0 and CLOSE_ONLY.match(t):
                # the closing brace of a column-0 block: that block changed
                e = enclosing(L - 1, 1)
                if e:
                    record(*e)
            else:
                attribute(L - 1, indent(t), L + 1)
        # every added non-blank line. A new definition at column 0 that opens a
        # block is an addition: its deeper lines are its body. Anything at
        # indent > 0 belongs to the enclosing base definition (a nested
        # definition included, with its decorators), except a new member of a
        # class-like container (a plain new method; known limit: it may override an
        # inherited one; a decorated member or a nested container names the class).
        # A re-added definition line names every base definition of that name.
        # Lines that only close a block are skipped.
        start = a - 2 if b > 0 else a - 1
        cur, pending = None, []
        for t in added:
            if not t.strip():
                continue
            ind = indent(t)
            if cur is not None and ind > cur[0]:
                # the body of a new definition: a column-0 one is an addition;
                # a nested one already named its enclosing definition
                continue
            cur = None
            if lang != 'mk' and CLOSE_ONLY.match(t):
                # a line that only closes a block adds no behaviour; the lines it
                # moves in or out of a block are changed lines of their own
                pending = []
                continue
            if deco(t):
                pending.append(t)
                continue
            d = dn(t)
            if d:
                for n in by_name.get(d, []):
                    record(d, n)
                if ind == 0:
                    skip = True
                else:
                    e = enclosing(start, ind)
                    # a plain new member of a class-like container is an addition;
                    # a decorated one, or a new nested container, changes the class
                    skip = e is not None and bool(CONTAINER.match(lines[e[1]])) and not CONTAINER.match(t) and not pending
                    if not skip:
                        for x in pending + [t]:
                            attribute(start, indent(x), max(a, 1))
                pending = []
                cur = (ind, skip) if opens_block(t) else None
                continue
            for x in pending + [t]:
                attribute(start, indent(x), max(a, 1))
            pending = []
        if pending:
            nd = next_base_def(a - 1 + b if b > 0 else a)
            if nd:
                record(*nd)
            else:
                for x in pending:
                    attribute(start, indent(x), max(a, 1))
o = {
    'defs': [{'name': n, 'at': at, 'end': e} for (n, at), e in sorted(defs.items(), key=lambda x: (x[0][1], x[0][0]))],
    'excluded': sorted(excluded),
    'unclassified': sorted(unclassified),
    'unattributed': sorted(unattributed),
}
o['program'] = _PROG
o['digest'] = hashlib.sha256(json.dumps(o, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
print(json.dumps(o, sort_keys=True, ensure_ascii=False))
