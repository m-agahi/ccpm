
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
# 8.9.13 (yaadgaar #121): a generic Rust impl header (impl<T> X<T>, impl<T: Into<U>> Trait for X<T>)
# is named like a plain one: the first name after the generics
RS_IMPL = re.compile(r'^\s*(?:unsafe\s+)?impl\s*<(?:[^<>-]|<(?:[^<>-]|<[^<>-]*>)*>)*>\s*(?:!\s*)?(?:[A-Za-z_][A-Za-z0-9_]*::)*([A-Za-z_][A-Za-z0-9_]*)')
# 8.9.13: a comment-only line; never a Rust #[attr], a #! line or a C #include
COMMENT = {'py': re.compile(r'^\s*#(?![!\[])'), 'sh': re.compile(r'^\s*#(?!!)'), 'js': re.compile(r'^\s*//'), 'kw': re.compile(r'^\s*//'), 'c': re.compile(r'^\s*//')}
def defname(lang, line):
    first = line.split()[0] if line.strip() else ''
    for rx in ([KEYWORD_DEF, JS_ARROW, JS_MEMBER_FN, JS_METHOD] if lang == 'js' else [SH_FUNC, KEYWORD_DEF] if lang == 'sh'
               else [KEYWORD_DEF, C_FUNC] if lang == 'c' else [KEYWORD_DEF, RS_IMPL] if lang == 'kw' else [KEYWORD_DEF]):
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
GEN_DIST = 'plugins/ccpmcwf/workflows/build-engine.js'
GEN_SRC = 'plugins/ccpmcwf/src/build-engine.js'
GEN_MARK = re.compile(r'// [A-Z0-9_]+_(BEGIN|END)\Z')
generated = set()
# 8.6.0 (ADR-1403): port of collapse (scripts/build-workflow.mjs), char for char (8.9.4, yaadgaar #114: trailing-dot numbers, ++ and --, property names, statement heads)
GEN_RX_AFTER = {'return', 'typeof', 'instanceof', 'in', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await'}
GEN_HEADS = {'if', 'while', 'with', 'for'}
GEN_DECLS = {'const', 'let', 'var'}
GEN_JOINS = {'++', '--', '//', '/*', '*/', '->', '<!'}
GEN_WORD = re.compile('[A-Za-z0-9_$\\\\#\x80-\U0010ffff]+')
GEN_SPACE = re.compile('[ \t]+')
def gen_isword(c):
    return c != '' and (c >= '\x80' or (c.isascii() and (c.isalnum() or c in '_$\\#')))
def gen_collapse(t):
    # each space or tab run outside string, template, regex and comment text dropped, or cut to one
    # space where the chars on both sides could join; ValueError on a literal that does not close
    out, tpl, n, parens = [], [], len(t), []
    i, last, word, prev = 0, '', '', ''
    def tpl_text():
        nonlocal i, last
        s = i
        while True:
            if i >= n:
                raise ValueError('template')
            c = t[i]
            if c == '\\':
                i += 2
            elif c == '`':
                i += 1
                out.append(t[s:i])
                last = 'v'
                return
            elif c == '$' and t[i + 1:i + 2] == '{':
                i += 2
                out.append(t[s:i])
                tpl.append(0)
                last = 'p'
                return
            else:
                i += 1
    while i < n:
        c = t[i]
        if c == ' ' or c == '\t':
            j = GEN_SPACE.match(t, i).end()
            a = out[-1][-1] if out else ''
            b = t[j] if j < n else ''
            if a not in ('', '\n') and b not in ('', '\n') and ((gen_isword(a) and gen_isword(b)) or a + b in GEN_JOINS or ('0' <= a <= '9' and b == '.')
                                                              or (a == '?' and b == '.') or (last == 'r' and a == '/' and gen_isword(b))
                                                              or (last == 'w' and a == '.' and gen_isword(b))):
                out.append(' ')
            i = j
        elif c == '\n':
            out.append(c)
            i += 1
        elif c == '"' or c == "'":
            j = i + 1
            while j >= n or t[j] != c:
                if j >= n or t[j] == '\n':
                    raise ValueError('string')
                j += 2 if t[j] == '\\' else 1
            j += 1
            out.append(t[i:j])
            i, last = j, 'v'
        elif c == '`':
            out.append(c)
            i += 1
            tpl_text()
        elif c == '/' and t[i + 1:i + 2] == '/':
            j = t.find('\n', i)
            j = n if j < 0 else j
            out.append(t[i:j])
            i = j
        elif c == '/' and t[i + 1:i + 2] == '*':
            j = t.find('*/', i + 2)
            if j < 0:
                raise ValueError('comment')
            out.append(t[i:j + 2])
            i = j + 2
        elif c == '/' and ((word in GEN_RX_AFTER or word == 'of') if last == 'w' else last not in ('v', 'r')):
            j, cls = i + 1, False
            while j < n and t[j] != '\n' and (cls or t[j] != '/'):
                if t[j] == '\\':
                    j += 1
                elif t[j] == '[':
                    cls = True
                elif t[j] == ']':
                    cls = False
                j += 1
            if t[j:j + 1] != '/':
                raise ValueError('regex')
            m = GEN_WORD.match(t, j + 1)
            j = m.end() if m else j + 1
            out.append(t[i:j])
            i, last = j, 'r'
        elif gen_isword(c):
            j = GEN_WORD.match(t, i).end()
            if '0' <= c <= '9' and t[j:j + 1] == '.':
                m = GEN_WORD.match(t, j + 1)
                j = m.end() if m else j + 1
            w = t[i:j]
            kw = w == 'of' and parens[-1:] == ['f'] and (last == 'v' or (last == 'w' and word not in GEN_RX_AFTER and word not in GEN_DECLS))
            if kw:
                parens[-1] = 'F'
            plain = last == 'd' or (w == 'of' and not kw)
            prev = word if last == 'w' else ''
            word = '' if plain else w
            out.append(w)
            i, last = j, 'w'
        elif c in '+-' and t[i + 1:i + 2] == c:
            out.append(c + c)
            i, last = i + 2, 'v'
        else:
            i += 1
            if c == '}' and tpl and tpl[-1] == 0:
                tpl.pop()
                out.append(c)
                tpl_text()
                continue
            if c == '{' and tpl:
                tpl[-1] += 1
            if c == '}' and tpl:
                tpl[-1] -= 1
            out.append(c)
            head = (parens.pop() if parens else '') if c == ')' else ''
            if c == '(':
                parens.append('' if last != 'w' else 'f' if word == 'for' or (word == 'await' and prev == 'for') else 'c' if word in GEN_HEADS else '')
            if c == '.' and last != 'd' and (len(out) < 2 or out[-2] != '.'):
                last = 'd'
            elif c == ')':
                last = 'p' if head else 'v'
            else:
                last = 'v' if c in ']}' else 'p'
    if tpl:
        raise ValueError('template')
    return ''.join(out)
def gen_build(src):
    # port of buildWorkflow (scripts/build-workflow.mjs): keep the meta block, cut each body line's indent, drop blank and
    # comment-only lines, then collapse the whitespace of each run of lines outside the BEGIN..END marker tables (8.6.0)
    head, tail = b'export const meta = {\n', b'\n};\n'
    i = src.find(tail)
    if not src.startswith(head) or i < 0:
        return None
    i += len(tail)
    kept = []
    for t in src[i:].decode('utf-8', 'surrogateescape').split('\n'):
        t = t.lstrip(' \t')
        if t and (not t.startswith('//') or GEN_MARK.match(t)):
            kept.append(t)
    out, run_, table = [], [], False
    try:
        for t in kept:
            if not table and GEN_MARK.match(t) and t.endswith('_BEGIN'):
                if run_:
                    out.append(gen_collapse('\n'.join(run_)))
                run_, table = [], True
            (out if table else run_).append(t)
            if table and GEN_MARK.match(t) and t.endswith('_END'):
                table = False
        if run_:
            out.append(gen_collapse('\n'.join(run_)))
    except ValueError:
        # a literal that does not close: no build, so the dist is scanned
        return None
    return src[:i] + '\n'.join(out).encode('utf-8', 'surrogateescape') + b'\n'
def gen_blob(rev, p):
    r = subprocess.run(G + ['cat-file', 'blob', rev + ':' + p], capture_output=True)
    return r.stdout if r.returncode == 0 else None
def gen_fresh(rev):
    # the dist at rev is the build of the src at rev
    s, d = gen_blob(rev, GEN_SRC), gen_blob(rev, GEN_DIST)
    return s is not None and d is not None and gen_build(s) == d
def gitlink(rev, p):
    return run('ls-tree', '-z', rev, '--', p).startswith(b'160000 ')
entries = []
# 7.4.0 (X1): the repo's diff.ignoreSubmodules cannot hide a gitlink bump
st = run('diff', '--ignore-submodules=none', '--name-status', '-z', '-M', base, tree, '--').split(b'\0')
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
    # fresh at BOTH ends (review S1): then every changed dist line comes from a changed src line,
    # which is scanned; a stale base dist could hide dist-only definitions, so it is scanned
    if path == GEN_DIST and status in ('M', 'T') and gen_fresh(base) and gen_fresh(tree):
        generated.add(esc(path))
        continue
    # a gitlink (a submodule commit) at either end has no blob to scan
    if gitlink(base, path) or gitlink(tree, newpath or path):
        unclassified.add(esc(path))
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
        out = run('diff', '--ignore-submodules=none', '-U0', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', base, tree, '--', path)
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
        cur, pending, notes = None, [], []
        note = None if os.path.splitext(path)[1].lower() in ('.rb', '.pl', '.pm', '.lua') else COMMENT.get(lang)
        # review r129: the base line after the hunk must end a member (a definition, decorator,
        # comment or close-only line); else a new member may take over existing lines (a body
        # tail, string text) and the shipped attribution applies
        # (comment lines are stepped over: a comment then a body tail is a body tail)
        nq = next((q for q in range(a - 1 + b if b > 0 else a, len(lines)) if lines[q].strip() and not (note and note.match(lines[q]))), None)
        nb = lines[nq] if nq is not None else None
        ok = nb is None or bool(dn(nb) or deco(nb) or CLOSE_ONLY.match(nb))
        if not ok:
            note = None
        for t in added:
            if not t.strip():
                continue
            ind = indent(t)
            if cur is not None and ind > cur[0]:
                # the body of a new definition: a column-0 one is an addition;
                # a nested one already named its enclosing definition
                continue
            if ok and cur is not None and cur[2] and ind == cur[0] and SIG_CLOSE.match(t) and parens(t) < 0:
                # 8.9.13 (yaadgaar #121): the closing line of the new definition's
                # multi-line signature (") -> T {") is part of that definition
                cur = (cur[0], cur[1], False) if opens_block(t) else None
                continue
            cur = None
            if lang != 'mk' and CLOSE_ONLY.match(t):
                # a line that only closes a block adds no behaviour; the lines it
                # moves in or out of a block are changed lines of their own
                for x in notes:
                    attribute(start, indent(x), max(a, 1))
                pending, notes = [], []
                continue
            if deco(t):
                pending.append(t)
                continue
            if note and ind > 0 and note.match(t) and not t.rstrip().endswith('\\'):
                # 8.9.13: an indented comment above a plain new member of a container
                # belongs to that addition; anywhere else it counts as a changed line,
                # as before. A column-0 comment (a coding cookie, a pragma) always counts
                notes.append(t)
                continue
            d = dn(t)
            if d:
                for n in by_name.get(d, []):
                    record(d, n)
                if ind == 0:
                    skip = True
                    for x in notes:
                        attribute(start, indent(x), max(a, 1))
                else:
                    e = enclosing(start, ind)
                    # a plain new member of a class-like container is an addition;
                    # a decorated one, or a new nested container, changes the class
                    skip = ok and e is not None and bool(CONTAINER.match(lines[e[1]])) and not CONTAINER.match(t) and not pending and not (lang == 'kw' and re.match(r'^\s*(?:pub(?:\([^)]*\))?\s+)?type\b', t))
                    if not skip:
                        for x in pending + notes + [t]:
                            attribute(start, indent(x), max(a, 1))
                    else:
                        for x in notes:
                            if indent(x) != ind:
                                attribute(start, indent(x), max(a, 1))
                pending, notes = [], []
                cur = (ind, skip, parens(t) > 0) if opens_block(t) else None
                continue
            for x in pending + notes + [t]:
                attribute(start, indent(x), max(a, 1))
            pending, notes = [], []
        for x in notes:
            attribute(start, indent(x), max(a, 1))
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
o['generated'] = sorted(generated)
o['program'] = _PROG
o['digest'] = hashlib.sha256(json.dumps(o, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
print(json.dumps(o, sort_keys=True, ensure_ascii=False))
