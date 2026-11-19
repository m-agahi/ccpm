
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
# fleet 7.1.0 (L2145): the script-written test block of the fleet's own PR
# body. Args: <gh_cmd> <owner/repo> <pr> <block_b64> <headers_json>. Only the
# text from START to END changes; with none, the block is appended. The first
# block becomes the new one and every other block is removed. The body is
# re-read: the block must be there once, the rest unchanged, and every header
# in <headers_json> and every markdown heading of the old body still present.
# claims: the test-count phrases of the final body outside every block (the
# stats block included; only the '<n> test rounds)' cell of its '| tests written |'
# row is dropped), listed
# until their UTF-8 bytes would pass LIMIT, then claims_truncated is true.
# Prints {replaced, edited, block_sha256, claims, claims_truncated,
# body_sha256_before, body_sha256_after, headers_missing, error, args,
# program, digest}.
import base64, hashlib, json, os, re, subprocess, sys, tempfile
def lift():
    # 6.3.2 (2130): gh (a Go binary) is not bound by this program's caps
    for k in (_r.RLIMIT_AS, _r.RLIMIT_CPU):
        _r.setrlimit(k, (_r.getrlimit(k)[1],) * 2)
START, END = '<!-- ccpm-fleet-tests -->', '<!-- /ccpm-fleet-tests -->'
args = sys.argv[1:]
SLUG = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,99}/[A-Za-z0-9._-]{1,100}$')
if len(args) != 5 or args[0] not in ('gh', 'gh-personal') or not SLUG.match(args[1]) or not re.match(r'^[1-9][0-9]{0,9}$', args[2]):
    sys.exit('usage: pr_test_block.py <gh|gh-personal> <owner/repo> <pr> <block_b64> <headers_json>')
gh, slug, pr, b64, hj = args
try:
    block = base64.b64decode(b64, validate=True).decode('utf-8')
    headers = json.loads(hj)
except ValueError:
    sys.exit('the block is not base64 UTF-8 or the headers are not JSON')
if not isinstance(headers, list) or any(not isinstance(h, str) for h in headers):
    sys.exit('headers must be a list of strings')
if not block.startswith(START) or not block.endswith(END) or block.count(START) != 1 or block.count(END) != 1:
    sys.exit('the block must start with the start marker, end with the end marker and hold each once')
os.chdir('/')
for k, v in (('GH_PROMPT_DISABLED', '1'), ('NO_COLOR', '1'), ('GH_NO_UPDATE_NOTIFIER', '1')):
    os.environ[k] = v
out = {'replaced': None, 'edited': False, 'block_sha256': hashlib.sha256(block.encode('utf-8')).hexdigest(), 'claims': [], 'claims_truncated': False, 'body_sha256_before': None, 'body_sha256_after': None, 'headers_missing': [], 'error': None}
REGION = re.compile(re.escape(START) + r'.*?' + re.escape(END), re.S)
HEAD = re.compile(r'^#{1,6}[ \t]+\S.*$', re.M)
P1 = re.compile(r'(?<![0-9A-Za-z_.,])[0-9][0-9,]*[ \t]+(?:tests?|passed|passing|failed|failing)\b', re.I)
P2 = re.compile(r'\b(?:tests?|pass(?:ed)?|fail(?:ed)?)(?:[ \t]*[:=][ \t]*|[ \t]+)[0-9]+(?![0-9]|[.,][0-9])', re.I)
# 7.4.0 (#64): more count forms, added to P1/P2 (each only adds claims): markdown around the
# number, n+, one word before the noun, pass|fail, passing, NBSP or one newline before the word;
# n/m and "n of m" with a test word on the line within 40 characters
SP = '[ \\t' + chr(0xa0) + ']'
WS = '(?:' + SP + '+\\n?' + SP + '*|\\n' + SP + '*)'
NOUN = r'(?:tests?|pass(?:ed|ing)?|fail(?:ed|ing)?)\b'
P1N = re.compile(r'(?<![0-9A-Za-z_.,*`~#])[*_`~]*[0-9][0-9,]*\+?[*_`~]*' + WS + '(?:[A-Za-z][A-Za-z-]*' + WS + ')?' + NOUN, re.I)
P2N = re.compile(r'\b' + NOUN[:-2] + r'(?:[ \t]*[:=][ \t]*|[ \t]+)[0-9]+(?![0-9]|[.,][0-9])', re.I)
P3 = re.compile(r'(?<![0-9A-Za-z_.,/])[0-9]+(?:[ \t]*/[ \t]*|[ \t]+of[ \t]+)[0-9]+(?![0-9/]|[.,][0-9])', re.I)
NEAR = re.compile(r'\b' + NOUN, re.I)
# 7.4.0 car 6 (#64 item 2, Max ruling): two exact ordinal forms are no count claim: "test N of
# AC<k>" and "Step N tests" / "step N tests" followed by a word that is not a number. Only a
# claim that lies wholly inside such a span is dropped; every other claim stays.
ORDINAL = (re.compile(r'(?<![A-Za-z0-9_])[Tt]est[ \t]+[0-9]+[ \t]+of[ \t]+AC[0-9]+(?![A-Za-z0-9_])'),
           re.compile(r'(?<![A-Za-z0-9_])[Ss]tep[ \t]+[0-9]+[ \t]+tests[ \t]+(?=[A-Za-z])'))
# 8.0.0 (#74): three forms are no count claim: a claim wholly inside an inline code span (a backtick
# run, text on one line, a run of the same length) or a closed fenced code block (3+ backticks or
# tildes, up to 3 spaces indent; closed by a line of the same character at least as long; an unclosed
# fence exempts nothing), and a claim right after the word `timeout` (`timeout 1800 npm test`)
FENCE = re.compile(r'^ {0,3}(`{3,}|~{3,})')
FENCE_END = re.compile(r'^ {0,3}(`+|~+)[ \t]*$')
CODE = re.compile(r'(?<!`)(`+)(?!`)[^\n]*?(?<!`)\1(?!`)')
TIMEOUT = re.compile(r'(?<![A-Za-z0-9_-])timeout[ \t]+\Z')
def code_spans(text):
    out, at, fence = [], 0, None
    for line in text.split('\n'):
        m = (FENCE_END if fence else FENCE).match(line)
        if not fence and m and not (m.group(1)[0] == '`' and '`' in line[m.end():]):
            fence = (m.group(1)[0], len(m.group(1)), at)
        elif fence and m and m.group(1)[0] == fence[0] and len(m.group(1)) >= fence[1]:
            out.append((fence[2], at + len(line)))
            fence = None
        at += len(line) + 1
    return out + [m.span() for m in CODE.finditer(text)]
# the stats block's '| tests written | <n> (<m> test rounds) |' cell, only on that row of the stats region
ROUNDS = ' rounds)'
STATS = re.compile(re.escape('<details><summary>Built with ') + r'(?:ccpm fleet|ccpmcwf).*?' + re.escape('<!-- ccpm-fleet-stats -->'), re.S)
LIMIT = 16384


def body():
    r = subprocess.run([gh, 'pr', 'view', pr, '-R', slug, '--json', 'body'], capture_output=True, timeout=120, preexec_fn=lift)
    if r.returncode != 0:
        raise RuntimeError('gh pr view: ' + r.stderr.decode('utf-8', 'replace')[-500:])
    b = json.loads(r.stdout.decode('utf-8')).get('body')
    return (b if isinstance(b, str) else '').replace('\r\n', '\n')


def claims_of(text):
    # every block region becomes one LF, so no phrase spans a removed block
    text = REGION.sub('\n', text)
    stats = [m.span() for m in STATS.finditer(text)]
    def rounds_cell(m):
        ls = text.rfind('\n', 0, m.start()) + 1
        return text.startswith(ROUNDS, m.end()) and text.startswith('| tests written |', ls) and any(a <= m.start() < b for a, b in stats)
    def near(m):
        ls = text.rfind('\n', 0, m.start()) + 1
        le = text.find('\n', m.end())
        return NEAR.search(text[max(ls, m.start() - 40):min(len(text) if le < 0 else le, m.end() + 40)]) is not None
    hits, at = [], set()
    ords = [o.span() for r in ORDINAL for o in r.finditer(text)]
    code = code_spans(text)
    for p in (P1, P2, P1N, P2N, P3):
        for m in p.finditer(text):
            if any(a <= m.start() and m.end() <= b for a, b in ords):
                continue
            if any(a <= m.start() and m.end() <= b for a, b in code) or TIMEOUT.search(text[max(0, m.start() - 200):m.start()]):
                continue
            if p in (P1, P1N) and rounds_cell(m):
                continue
            if p is P3 and not near(m):
                continue
            # a new form adds a claim only where no shipped form starts
            if p in (P1N, P2N, P3) and m.start() in at:
                continue
            at.add(m.start())
            hits.append((m.start(), ' '.join(m.group(0).split())[:80]))
    seen, size = [], 0
    for _, c in sorted(hits, key=lambda h: h[0]):
        if c in seen:
            continue
        n = len(c.encode('utf-8'))
        if size + n > LIMIT:
            return seen, True
        seen.append(c)
        size += n
    return seen, False


try:
    before = body()
    out['body_sha256_before'] = hashlib.sha256(before.encode('utf-8')).hexdigest()
    hits = REGION.findall(before)
    rest = REGION.sub('', before)
    if START in rest or END in rest or any(START in h[len(START):] for h in hits):
        raise ValueError('the PR body holds an unpaired test block marker')
    out['replaced'] = bool(hits)
    if hits:
        # the first block becomes the new one; every other one is removed
        seen = []
        want = REGION.sub(lambda m: '' if seen else seen.append(1) or block, before)
    else:
        want = before.rstrip('\n') + ('\n\n' if before.strip() else '') + block + '\n'
    final = before
    if want == before:
        out['body_sha256_after'] = out['body_sha256_before']
    else:
        fd, tmp = tempfile.mkstemp(prefix='fleet-pr-body-', suffix='.md')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                f.write(want)
            r = subprocess.run([gh, 'pr', 'edit', pr, '-R', slug, '--body-file', tmp], capture_output=True, timeout=120, preexec_fn=lift)
        finally:
            os.unlink(tmp)
        if r.returncode != 0:
            raise RuntimeError('gh pr edit: ' + r.stderr.decode('utf-8', 'replace')[-500:])
        out['edited'] = True
        final = body()
        out['body_sha256_after'] = hashlib.sha256(final.encode('utf-8')).hexdigest()
        lines = set(x.strip() for x in final.split('\n'))
        out['headers_missing'] = sorted(set(h for h in headers + [x.strip() for x in HEAD.findall(before)] if h.strip() not in lines))
        if out['headers_missing']:
            raise ValueError('the re-read body lost header(s): ' + ', '.join(out['headers_missing']))
        if final.count(block) != 1 or final.rstrip('\n') != want.rstrip('\n'):
            raise ValueError('the re-read body is not the body written (the block is missing, doubled or the rest changed)')
    out['claims'], out['claims_truncated'] = claims_of(final)
except (RuntimeError, ValueError, OSError, subprocess.SubprocessError) as e:
    out['error'] = str(e)[:600]
    out['claims'] = []
    out['claims_truncated'] = False
out['args'] = args
out['program'] = _PROG
out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
print(json.dumps(out, ensure_ascii=False))
