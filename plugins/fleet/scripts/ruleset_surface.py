
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
# fleet 6.0.0 (ledger 2041): the hook surface that org and repo rulesets and
# workflow self-references add. Args: <worktree> <gh_cmd|-> <owner/repo|->
# <default_branch>. Floor (local, always): every directory a tracked
# .github/workflows/*.y*ml names by self-reference (`uses: ./<dir>`,
# `uses: <owner>/<repo>/<dir>@...`), as `<dir>/`. With a GitHub command:
# `rules/branches/<default>` (org and repo rulesets that apply to the repo):
# a `workflows` rule entry in this repo is surface; one in another repo is
# read for self-references into this repo. For an Organization owner,
# `orgs/<owner>/rulesets` and each ruleset (cap 50): a `workflows` entry
# hosted in this repo is surface. A 404 there, or a 403 / 5xx without the
# admin:org scope, is reported in `unreadable` (the floor stands); a 403 / 5xx
# with admin:org, and any failure of the repo or rules read, sets `error`.
# Prints {surface, sources, read, unreadable, error, args, program, digest}.
# Read only: GET requests through the given command; no token is read.
import base64, hashlib, json, os, re, subprocess, sys
UNRESERVED = re.compile(r'[A-Za-z0-9._~/-]')


def quote(v, safe_slash=True):
    # percent-encode a URL path or query part (stdlib only, no network module)
    return ''.join(c if c.isascii() and UNRESERVED.match(c) and (safe_slash or c != '/') else ''.join('%%%02X' % b for b in c.encode('utf-8')) for c in v)
args = sys.argv[1:]
if len(args) != 4:
    sys.exit('usage: ruleset_surface.py <worktree> <gh_cmd|-> <owner/repo|-> <default_branch>')
wt, gh, slug, branch = args
SLUG = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,99}/[A-Za-z0-9._-]{1,100}$')
if not os.path.isabs(wt) or (slug != '-' and not SLUG.match(slug)) or gh not in ('-', 'gh', 'gh-personal') or not re.match(r'^[A-Za-z0-9._/-]{1,255}$', branch):
    sys.exit('bad arguments: ' + json.dumps(args))
os.chdir('/')
os.environ['GH_PROMPT_DISABLED'] = '1'
os.environ['NO_COLOR'] = '1'
os.environ['GH_NO_UPDATE_NOTIFIER'] = '1'
FILE_CAP = 1 << 20
ls = subprocess.run(['git', '-C', wt, 'ls-files', '-z'], capture_output=True)
tracked = set(x.decode('utf-8', 'replace') for x in ls.stdout.split(b'\0') if x)
surface, sources, read, unreadable, error = set(), [], [], [], None


def norm(p):
    q = os.path.normpath(p)
    return None if q in ('.', '') or q == '..' or q.startswith('../') or q.startswith('/') else q


USES = re.compile(r'''^[ \t-]*uses:[ \t]*["']?([^\s"'#]+)''', re.M)


def self_refs(text):
    # the repo paths a workflow text names by self-reference
    # (a root reference, ./ . <slug>@ref <slug>/@ref, is the whole repo: "./")
    out = []
    for u in USES.findall(text):
        if u in ('.', './') or u.startswith('./'):
            rel = u[2:]
        elif slug != '-' and '@' in u and u.split('@', 1)[0].lower().rstrip('/') == slug.lower():
            rel = ''
        elif slug != '-' and u.lower().startswith(slug.lower() + '/') and '@' in u:
            rel = u[len(slug) + 1:].split('@', 1)[0]
        else:
            continue
        rel = rel.replace('\\', '/').lstrip('/')
        d = None if os.path.normpath(rel or '.') in ('.', '') else norm(rel)
        # a root or escaping self-reference fails closed: the whole repo
        out.append('./' if d is None else d if d in tracked else d.rstrip('/') + '/')
    return out


def add_refs(text, via, src):
    for d in self_refs(text):
        surface.add(d)
        sources.append(dict(src, path=d, via=via))


WF = re.compile(r'^\.github/workflows/[^/]+\.ya?ml$')
local = sorted(x for x in tracked if WF.match(x))
for w in local:
    try:
        with open(os.path.join(wt, w), 'rb') as fh:
            t = fh.read(FILE_CAP).decode('utf-8', 'replace')
    except OSError:
        continue
    add_refs(t, w, {'ruleset_id': None, 'name': None, 'source_type': 'self-reference'})
read.append('self-references in ' + str(len(local)) + ' local workflow file(s)')


def api(path):
    # (status or None, parsed JSON body or None, {lower header: value})
    try:
        p = subprocess.run([gh, 'api', '-i', path], capture_output=True, timeout=30, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired):
        return None, None, {}
    raw = p.stdout.decode('utf-8', 'replace').replace('\r\n', '\n')
    code, hdr, body = None, {}, raw
    m = re.match(r'^HTTP/[0-9.]+ ([0-9]{3})', raw)
    if m:
        code = int(m.group(1))
        head, _, body = raw.partition('\n\n')
        for line in head.split('\n')[1:]:
            k, _, v = line.partition(':')
            hdr[k.strip().lower()] = v.strip()
    else:
        m = re.search(r'HTTP ([0-9]{3})', p.stderr.decode('utf-8', 'replace'))
        code = int(m.group(1)) if m else (200 if p.returncode == 0 else None)
    try:
        data = json.loads(body) if body.strip() else None
    except ValueError:
        data = None
    return code, data, hdr


PAGE_CAP = 10
NEXT = re.compile(r'<https://api\.github\.com/([^>]+)>;\s*rel="next"')


def api_all(path):
    # every page of a list: (items, why the rest is missing or None, the failed page's status and headers)
    items, page = [], 1
    while True:
        code, data, hdr = api(path)
        if code != 200 or not isinstance(data, list):
            return items, ('HTTP ' + str(code) if page == 1 else 'page ' + str(page) + ': HTTP ' + str(code)), code, hdr
        items.extend(data)
        m = NEXT.search(hdr.get('link', ''))
        if not m:
            return items, None, code, hdr
        if page >= PAGE_CAP:
            return items, 'more than ' + str(PAGE_CAP) + ' pages', code, hdr
        path, page = m.group(1), page + 1


def workflows_of(rules):
    for r in rules if isinstance(rules, list) else []:
        if isinstance(r, dict) and r.get('type') == 'workflows':
            for w in ((r.get('parameters') or {}).get('workflows') or []):
                if isinstance(w, dict) and isinstance(w.get('path'), str):
                    yield r, w


if slug == '-':
    read.append('rulesets not read: origin is not a GitHub repo')
elif gh == '-':
    unreadable.append('rulesets of ' + slug + ' not read: no GitHub command can read it; hosting-side required workflows not checked')
else:
    owner = slug.split('/')[0]
    code, repo, _ = api('repos/' + slug)
    if code != 200 or not isinstance(repo, dict) or not isinstance(repo.get('id'), int):
        error = 'repo ' + slug + ' not readable (HTTP ' + str(code) + ')'
    else:
        rid = repo['id']
        otype = (repo.get('owner') or {}).get('type')
        rules, why, _, _ = api_all('repos/' + slug + '/rules/branches/' + quote(branch))
        if why is not None:
            error = 'rules of ' + slug + ' branch ' + branch + ' not readable (' + why + ')'
        else:
            read.append('rules/branches/' + branch + ': ' + str(len(rules)) + ' rule(s)')
            names = {}
            for r, w in workflows_of(rules):
                src = {'ruleset_id': r.get('ruleset_id'), 'name': None, 'source_type': r.get('ruleset_source_type')}
                if w.get('repository_id') == rid:
                    p = norm(w['path'])
                    if p:
                        surface.add(p)
                        sources.append(dict(src, path=p, via=p))
                    continue
                # a required workflow in another repo: its self-references into this repo
                c1, other, _ = api('repositories/' + str(w.get('repository_id')))
                full = other.get('full_name') if c1 == 200 and isinstance(other, dict) else None
                c2, f, _ = api('repos/' + full + '/contents/' + quote(w['path']) + '?ref=' + quote(str(w.get('ref') or ''), False)) if full else (c1, None, {})
                if c2 != 200 or not isinstance(f, dict) or not isinstance(f.get('content'), str):
                    unreadable.append('required workflow ' + w['path'] + ' in repo ' + str(w.get('repository_id')) + ' not readable (HTTP ' + str(c2) + '): its references into ' + slug + ' not checked')
                    continue
                try:
                    t = base64.b64decode(f['content']).decode('utf-8', 'replace')
                except ValueError:
                    t = ''
                usrc = dict(src, source_type=(src['source_type'] or 'ruleset'))
                add_refs(t, full + ':' + w['path'], usrc)
            if otype == 'Organization':
                org, why, code, hdr = api_all('orgs/' + owner + '/rulesets?per_page=100')
                if why is not None and why.startswith('HTTP'):
                    org = None
                elif why is not None:
                    unreadable.append('org rulesets of ' + owner + ': only ' + str(len(org)) + ' read; ' + re.sub(r'^page ([0-9]+): (HTTP .*)$', r'page \1 not readable (\2)', why) + ': the rest not checked')
                if isinstance(org, list):
                    read.append('org rulesets of ' + owner + ': ' + str(len(org)))
                    for e in org[:50]:
                        c, d, _ = api('orgs/' + owner + '/rulesets/' + str(e.get('id') if isinstance(e, dict) else ''))
                        if c != 200 or not isinstance(d, dict):
                            unreadable.append('org ruleset ' + str(e.get('id') if isinstance(e, dict) else e) + ' not readable (HTTP ' + str(c) + ')')
                            continue
                        for r, w in workflows_of(d.get('rules')):
                            p = norm(w['path'])
                            if w.get('repository_id') == rid and p:
                                surface.add(p)
                                sources.append({'ruleset_id': d.get('id'), 'name': d.get('name'), 'source_type': 'Organization', 'path': p, 'via': p})
                    if len(org) > 50:
                        unreadable.append('org rulesets of ' + owner + ': ' + str(len(org) - 50) + ' past the cap of 50 not read')
                elif code in (403,) or code is None or code >= 500:
                    scopes = [s.strip() for s in hdr.get('x-oauth-scopes', '').split(',')]
                    if 'admin:org' in scopes:
                        error = 'org rulesets of ' + owner + ' not readable (HTTP ' + str(code) + ') with the admin:org scope'
                    else:
                        unreadable.append('org rulesets not readable (HTTP ' + str(code) + ', no admin:org scope): hosting-side required workflows not checked')
                else:
                    unreadable.append('org rulesets not readable (HTTP ' + str(code) + '; needs admin:org): hosting-side required workflows not checked')
            else:
                read.append('owner ' + owner + ' is not an organization: no org rulesets')
sources.sort(key=lambda s: (s['path'], str(s['ruleset_id']), s['via']))
out = {'surface': [] if error else sorted(surface), 'sources': [] if error else sources, 'read': read, 'unreadable': unreadable, 'error': error, 'args': args}
out['program'] = _PROG
out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
print(json.dumps(out, ensure_ascii=False))
