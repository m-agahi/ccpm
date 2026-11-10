
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
# fleet 5.0.8 (ledger 2030): which GitHub command the run uses for a repo,
# decided here, not by an agent. Args: <repo> (a local checkout whose origin
# names the repo; "-" for none), then any further <owner>/<name> slugs. For
# each repo (origin first, then the slugs, without repeats), each candidate in
# order [gh-personal when installed, gh] runs
# `<cand> api repos/<owner>/<name> --jq .permissions.push`. The first that
# prints true is gh_cmd (push true); else the first that read the repo (push
# false); else gh_cmd null. Prints {origin, repos: {<slug>: {gh_cmd, push,
# tried: [{cmd, installed, push}]}}, args, program, digest}; tried push is
# true, false or null (not installed, or the read failed). No token is read,
# passed or printed; the commands run as they are. Read only.
import hashlib, json, os, re, shutil, subprocess, sys, time
args = sys.argv[1:]
if not args:
    sys.exit('usage: gh_identity.py <repo|-> [<owner>/<name> ...]')
SLUG = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,99}/[A-Za-z0-9._-]{1,100}$')
for s in args[1:]:
    if not SLUG.match(s) or s.endswith('.git'):
        sys.exit('bad repo slug: ' + json.dumps(s))
os.chdir('/')
os.environ['GIT_TERMINAL_PROMPT'] = '0'
os.environ['GH_PROMPT_DISABLED'] = '1'
os.environ['NO_COLOR'] = '1'
os.environ['GH_NO_UPDATE_NOTIFIER'] = '1'
origin = None
if args[0] != '-':
    if not os.path.isabs(args[0]):
        sys.exit('repo must be an absolute path or -')
    # the URL after any insteadOf rewrite, as the workspace step parses remote_slug
    r = subprocess.run(['git', '-c', 'core.fsmonitor=', '-C', args[0], 'remote', 'get-url', 'origin'], capture_output=True, timeout=60)
    if r.returncode == 0 and len(r.stdout) <= 4096:
        m = re.search(r'[:/]([A-Za-z0-9][A-Za-z0-9._-]*)/([A-Za-z0-9._-]+?)(?:\.git)?/?$', r.stdout.decode('utf-8', 'replace').strip())
        if m and SLUG.match(m.group(1) + '/' + m.group(2)):
            origin = m.group(1) + '/' + m.group(2)
slugs = []
for s in ([origin] if origin else []) + args[1:]:
    if s not in slugs:
        slugs.append(s)
cands = [c for c in ('gh-personal', 'gh') if c == 'gh' or shutil.which(c)]


def push_of(cmd, slug):
    # true / false, or None when the repo could not be read; a failure that is
    # not an HTTP 4xx answer is tried once more after 3 s
    for attempt in (0, 1):
        try:
            p = subprocess.run([cmd, 'api', 'repos/' + slug, '--jq', '.permissions.push'], capture_output=True, timeout=60, stdin=subprocess.DEVNULL)
        except (OSError, subprocess.TimeoutExpired):
            p = None
        if p is not None and p.returncode == 0:
            v = p.stdout.decode('utf-8', 'replace').strip()
            return True if v == 'true' else False if v in ('false', 'null', '') else None
        if p is not None and re.search(rb'HTTP 4\d\d', p.stderr or b''):
            return None
        if attempt == 0:
            time.sleep(3)
    return None


repos = {}
for s in slugs:
    tried = []
    for c in ('gh-personal', 'gh'):
        if c not in cands:
            tried.append({'cmd': c, 'installed': False, 'push': None})
        else:
            tried.append({'cmd': c, 'installed': True, 'push': push_of(c, s)})
    pick = next((t for t in tried if t['push'] is True), None) or next((t for t in tried if t['push'] is False), None)
    repos[s] = {'gh_cmd': pick['cmd'] if pick else None, 'push': bool(pick and pick['push']), 'tried': tried}
out = {'origin': origin, 'repos': repos, 'args': args}
out['program'] = _PROG
out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
print(json.dumps(out, ensure_ascii=False))
