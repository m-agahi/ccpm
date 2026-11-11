
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
# fleet 5.0.8 (ledger 2030): which GitHub command the run uses for a repo,
# decided here, not by an agent. Args: <repo> (a local checkout whose origin
# names the repo; "-" for none), then any further <owner>/<name> slugs. The
# origin is probed only when GitHub-hosted: an https URL on github.com, or an
# ssh URL whose host is github.com or resolves to it (`ssh -G <host>`, its
# hostname line); a path, another host or an unparseable URL gives origin
# null and no probe. For each repo (origin first, then the slugs, without
# repeats), gh runs `gh api repos/<o>/<n> --jq .permissions.push`; only when
# gh has no push, gh-personal (if installed) runs the same. gh_cmd: the first
# with push, else the first that read the repo (push false), else null. Only
# exit 0 with stdout exactly true or false counts; anything else is unknown.
# Each call has 15 s; only a clearly transient error is tried once more.
# Prints {origin, repos: {<slug>: {gh_cmd, push, tried: [{cmd, installed,
# push}]}}, args, program, digest}. fleet 6.0.0 (ledger 2038): an installed
# command whose answer is unknown (push null) also carries exit_code (null on
# a timeout) and stderr (its first 200 characters, token-shaped text redacted). No token is read, passed or printed; the
# commands run as they are. Read only.
import hashlib, json, os, re, shutil, subprocess, sys, time
args = sys.argv[1:]
if not args:
    sys.exit('usage: gh_identity.py <repo|-> [<owner>/<name> ...]')
SLUG = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,99}/[A-Za-z0-9._-]{1,100}$')
for s in args[1:]:
    if not SLUG.match(s) or s.endswith('.git'):
        sys.exit('bad repo slug: ' + json.dumps(s))
if args[0] != '-' and not os.path.isabs(args[0]):
    sys.exit('repo must be an absolute path or -')
os.chdir('/')
os.environ['GIT_TERMINAL_PROMPT'] = '0'
os.environ['GH_PROMPT_DISABLED'] = '1'
os.environ['NO_COLOR'] = '1'
os.environ['GH_NO_UPDATE_NOTIFIER'] = '1'
CALL_TIMEOUT = 15
HOST = r'[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})'
PATH_PART = r'([A-Za-z0-9][A-Za-z0-9._-]*)/([A-Za-z0-9._-]+?)(?:\.git)?/?'


def ssh_host(alias):
    # the hostname `ssh -G` resolves an alias to (it reads the ssh config only)
    if alias.lower() == 'github.com':
        return 'github.com'
    try:
        p = subprocess.run(['ssh', '-G', alias], capture_output=True, timeout=CALL_TIMEOUT, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if p.returncode != 0:
        return None
    for line in p.stdout.decode('utf-8', 'replace').splitlines():
        k, _, v = line.partition(' ')
        if k == 'hostname':
            return v.strip().lower()
    return None


def github_slug(url):
    # <o>/<n> of a GitHub-hosted URL, else None
    m = re.match(r'^https://(?:[^@/]+@)?github\.com(?::443)?/' + PATH_PART + '$', url, re.I)
    if m:
        return m.group(1) + '/' + m.group(2)
    m = re.match(r'^ssh://(?:[^@/]+@)?(' + HOST + r')(?::[0-9]+)?/' + PATH_PART + '$', url) or \
        re.match(r'^(?:[^@/:]+@)?(' + HOST + r'):(?!/)' + PATH_PART + '$', url)
    if m and ssh_host(m.group(1)) == 'github.com':
        return m.group(2) + '/' + m.group(3)
    return None


origin = None
if args[0] != '-':
    # the URL after any insteadOf rewrite, as the workspace step parses remote_slug
    try:
        r = subprocess.run(['git', '-c', 'core.fsmonitor=', '-C', args[0], 'remote', 'get-url', 'origin'], capture_output=True, timeout=60)
        if r.returncode == 0 and len(r.stdout) <= 4096:
            g = github_slug(r.stdout.decode('utf-8', 'replace').strip())
            origin = g if g and SLUG.match(g) else None
    except (OSError, subprocess.TimeoutExpired):
        origin = None
slugs = []
for s in ([origin] if origin else []) + args[1:]:
    if s not in slugs:
        slugs.append(s)
TRANSIENT = re.compile(rb'(?i)timed? ?out|connection (reset|refused)|error connecting|temporary failure|EOF|TLS handshake|HTTP 5[0-9][0-9]|could not resolve host')


TOKEN = re.compile(r'(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|[A-Za-z0-9_-]{40,})')


def why(code, err):
    # the diagnostics of an unknown answer: exit code and a short, token-free stderr
    t = TOKEN.sub('[redacted]', ' '.join((err or b'').decode('utf-8', 'replace').split()))
    return {'exit_code': code, 'stderr': t[:200]}


def probe(cmd, slug):
    # {cmd, installed, push}: push True / False only on exit 0 with stdout
    # exactly true or false; None otherwise (unknown, not readable), with why()
    if not shutil.which(cmd):
        return {'cmd': cmd, 'installed': False, 'push': None}
    for attempt in (0, 1):
        try:
            p = subprocess.run([cmd, 'api', 'repos/' + slug, '--jq', '.permissions.push'], capture_output=True, timeout=CALL_TIMEOUT, stdin=subprocess.DEVNULL)
        except OSError:
            return {'cmd': cmd, 'installed': False, 'push': None}
        except subprocess.TimeoutExpired:
            return dict({'cmd': cmd, 'installed': True, 'push': None}, **why(None, b'timed out after %d s' % CALL_TIMEOUT))
        if p.returncode == 0:
            v = p.stdout.decode('utf-8', 'replace')
            push = True if v in ('true', 'true\n') else False if v in ('false', 'false\n') else None
            r = {'cmd': cmd, 'installed': True, 'push': push}
            return r if push is not None else dict(r, **why(0, p.stderr))
        if attempt == 0 and not re.search(rb'HTTP 4[0-9][0-9]', p.stderr or b'') and TRANSIENT.search(p.stderr or b''):
            time.sleep(3)
            continue
        break
    return dict({'cmd': cmd, 'installed': True, 'push': None}, **why(p.returncode, p.stderr))


repos = {}
for s in slugs:
    tried = [probe('gh', s)]
    # gh-personal only when gh has no push (work repos never touch it)
    if tried[0]['push'] is not True:
        tried.append(probe('gh-personal', s))
    pick = next((t for t in tried if t['push'] is True), None) or next((t for t in tried if t['push'] is False), None)
    repos[s] = {'gh_cmd': pick['cmd'] if pick else None, 'push': bool(pick and pick['push']), 'tried': tried}
out = {'origin': origin, 'repos': repos, 'args': args}
out['program'] = _PROG
out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
print(json.dumps(out, ensure_ascii=False))
