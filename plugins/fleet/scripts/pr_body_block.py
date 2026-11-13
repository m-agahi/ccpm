
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
# fleet 6.0.0 (ledger 2044): the stats block of the fleet's own PR body. Args:
# <gh_cmd> <owner/repo> <pr> <block_b64> <t0|-> <headers_json>. The block is a
# template with one @@WALL@@, which becomes the wall time since <t0> (epoch
# seconds). Only the text from START to END changes; with none, the block is
# appended. The body is re-read: the block must be there once, the rest
# unchanged, and every header in <headers_json> and every markdown heading of
# the old body still present. Prints {replaced, wall_s, block_sha256,
# body_sha256_before, body_sha256_after, headers_missing, error, args,
# program, digest}.
import base64, hashlib, json, os, re, subprocess, sys, tempfile, time
def lift():
    # 6.3.2 (2130): gh (a Go binary) is not bound by this program's caps
    for k in (_r.RLIMIT_AS, _r.RLIMIT_CPU):
        _r.setrlimit(k, (_r.getrlimit(k)[1],) * 2)
START, END, WALL = '<details><summary>Built with ccpm fleet', '<!-- ccpm-fleet-stats -->', '@@WALL@@'
args = sys.argv[1:]
SLUG = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,99}/[A-Za-z0-9._-]{1,100}$')
if len(args) != 6 or args[0] not in ('gh', 'gh-personal') or not SLUG.match(args[1]) or not re.match(r'^[1-9][0-9]{0,9}$', args[2]) or not re.match(r'^(-|[0-9]{1,12})$', args[4]):
    sys.exit('usage: pr_body_block.py <gh|gh-personal> <owner/repo> <pr> <block_b64> <t0|-> <headers_json>')
gh, slug, pr, b64, t0, hj = args
try:
    tpl = base64.b64decode(b64, validate=True).decode('utf-8')
    headers = json.loads(hj)
except ValueError:
    sys.exit('the block is not base64 UTF-8 or the headers are not JSON')
if not isinstance(headers, list) or any(not isinstance(h, str) for h in headers):
    sys.exit('headers must be a list of strings')
if tpl.count(WALL) != 1 or not tpl.startswith(START) or not tpl.endswith(END) or tpl.count(START) != 1 or tpl.count(END) != 1:
    sys.exit('the block must start with the start marker, end with the end marker and hold one ' + WALL)
os.chdir('/')
for k, v in (('GH_PROMPT_DISABLED', '1'), ('NO_COLOR', '1'), ('GH_NO_UPDATE_NOTIFIER', '1')):
    os.environ[k] = v


def dur(s):
    if s is None or s < 0:
        return 'not measured'
    return '%ds' % s if s < 60 else '%dm' % (s // 60) if s < 3600 else '%dh %dm' % (s // 3600, s % 3600 // 60)


wall = None if t0 == '-' else int(time.time()) - int(t0)
block = tpl.replace(WALL, dur(wall))
out = {'replaced': None, 'wall_s': wall, 'block_sha256': hashlib.sha256(block.encode('utf-8')).hexdigest(), 'body_sha256_before': None, 'body_sha256_after': None, 'headers_missing': [], 'error': None}
REGION = re.compile(re.escape(START) + r'.*?' + re.escape(END), re.S)
HEAD = re.compile(r'^#{1,6}[ \t]+\S.*$', re.M)


def body():
    r = subprocess.run([gh, 'pr', 'view', pr, '-R', slug, '--json', 'body'], capture_output=True, timeout=120, preexec_fn=lift)
    if r.returncode != 0:
        raise RuntimeError('gh pr view: ' + r.stderr.decode('utf-8', 'replace')[-500:])
    b = json.loads(r.stdout.decode('utf-8')).get('body')
    return (b if isinstance(b, str) else '').replace('\r\n', '\n')


try:
    before = body()
    out['body_sha256_before'] = hashlib.sha256(before.encode('utf-8')).hexdigest()
    hits = REGION.findall(before)
    out['replaced'] = bool(hits)
    if hits:
        # the first block becomes the new one; any other is dropped
        seen = []
        want = REGION.sub(lambda m: '' if seen else seen.append(1) or block, before)
    else:
        want = before.rstrip('\n') + ('\n\n' if before.strip() else '') + block + '\n'
    fd, tmp = tempfile.mkstemp(prefix='fleet-pr-body-', suffix='.md')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(want)
        r = subprocess.run([gh, 'pr', 'edit', pr, '-R', slug, '--body-file', tmp], capture_output=True, timeout=120, preexec_fn=lift)
    finally:
        os.unlink(tmp)
    if r.returncode != 0:
        raise RuntimeError('gh pr edit: ' + r.stderr.decode('utf-8', 'replace')[-500:])
    after = body()
    out['body_sha256_after'] = hashlib.sha256(after.encode('utf-8')).hexdigest()
    lines = set(x.strip() for x in after.split('\n'))
    out['headers_missing'] = sorted(set(h for h in headers + [x.strip() for x in HEAD.findall(before)] if h.strip() not in lines))
    if out['headers_missing']:
        out['error'] = 'the re-read body lost header(s): ' + ', '.join(out['headers_missing'])
    elif after.count(block) != 1 or after.rstrip('\n') != want.rstrip('\n'):
        out['error'] = 'the re-read body is not the body written (the block is missing, doubled or the rest changed)'
except (RuntimeError, ValueError, OSError, subprocess.SubprocessError) as e:
    out['error'] = str(e)[:600]
out['args'] = args
out['program'] = _PROG
out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
print(json.dumps(out, ensure_ascii=False))
