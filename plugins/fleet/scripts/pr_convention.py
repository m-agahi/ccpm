
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
# fleet 6.0.0 (ledger 2042): the repo's PR title and body convention. Args:
# <worktree> <gh_cmd|-> <owner/repo|-> <default_branch>. Title, first match:
# a required workflow (`rules/branches/<default>`, org rulesets included)
# whose path names pr-title (types and the key rule from its checker's
# literals), a commitlint or semantic config in the repo, >= 80 % of the
# last 20 merged PR titles, else the conventional fallback (ruling 4).
# Body: the repo's PR template, else the org's (<owner>/.github), and a
# required pr-body workflow's checker literals. Prints {title, body, source,
# unreadable, args, program, digest}. Read only: GET requests, no token read.
import base64, hashlib, json, os, re, subprocess, sys
UNRESERVED = re.compile(r'[A-Za-z0-9._~/-]')


def quote(v, safe_slash=True):
    return ''.join(c if c.isascii() and UNRESERVED.match(c) and (safe_slash or c != '/') else ''.join('%%%02X' % b for b in c.encode('utf-8')) for c in v)
args = sys.argv[1:]
if len(args) != 4:
    sys.exit('usage: pr_convention.py <worktree> <gh_cmd|-> <owner/repo|-> <default_branch>')
wt, gh, slug, branch = args
SLUG = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,99}/[A-Za-z0-9._-]{1,100}$')
if not os.path.isabs(wt) or (slug != '-' and not SLUG.match(slug)) or gh not in ('-', 'gh', 'gh-personal') or not re.match(r'^[A-Za-z0-9._/-]{1,255}$', branch):
    sys.exit('bad arguments: ' + json.dumps(args))
os.chdir('/')
os.environ['GH_PROMPT_DISABLED'] = '1'
os.environ['NO_COLOR'] = '1'
os.environ['GH_NO_UPDATE_NOTIFIER'] = '1'
CC = ['feat', 'fix', 'perf', 'revert', 'chore', 'refactor', 'docs', 'style', 'test', 'build', 'ci']
ls = subprocess.run(['git', '-C', wt, 'ls-files', '-z'], capture_output=True)
tracked = sorted(set(x.decode('utf-8', 'replace') for x in ls.stdout.split(b'\0') if x))
title, source, unreadable = None, [], []
body = {'template': None, 'template_repo': None, 'required_sections': None, 'min_chars': None, 'checker': None}


def read_local(p):
    try:
        with open(os.path.join(wt, p), 'rb') as f:
            return f.read(1 << 20).decode('utf-8', 'replace')
    except OSError:
        return ''


def api(path):
    try:
        p = subprocess.run([gh, 'api', '-i', path], capture_output=True, timeout=30, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired):
        return None, None
    raw = p.stdout.decode('utf-8', 'replace').replace('\r\n', '\n')
    m = re.match(r'^HTTP/[0-9.]+ ([0-9]{3})', raw)
    code, text = (int(m.group(1)), raw.partition('\n\n')[2]) if m else (200 if p.returncode == 0 else None, raw)
    try:
        return code, json.loads(text) if text.strip() else None
    except ValueError:
        return code, None


def content(repo, path, ref):
    code, d = api('repos/' + repo + '/contents/' + quote(path) + '?ref=' + quote(ref, False))
    if code == 200 and isinstance(d, dict) and isinstance(d.get('content'), str):
        try:
            return base64.b64decode(d['content']).decode('utf-8', 'replace')
        except ValueError:
            return None
    return None


def strs(text, name):
    m = re.search(name + r'''\s*=\s*[\[(]([^\])]*)[\])]''', text)
    return re.findall(r'''['"]([^'"\n]+)['"]''', m.group(1)) if m else None


def checker(repo, wf, ref, want):
    # the checker files a required workflow runs: the .py files of each `uses: <o>/<r>/<dir>@<ref>`
    text = content(repo, wf, ref)
    if text is None:
        return None, None
    for o, d, r in re.findall(r'uses:\s*["\']?([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)/([A-Za-z0-9._/-]+)@([^\s"\'#]+)', text):
        code, items = api('repos/' + o + '/contents/' + quote(d) + '?ref=' + quote(r, False))
        for it in (items if code == 200 and isinstance(items, list) else [])[:20]:
            if isinstance(it, dict) and str(it.get('name', '')).endswith('.py') and isinstance(it.get('path'), str):
                t = content(o, it['path'], r)
                if t and want(t):
                    return o + '/' + it['path'], t
    return None, None


rules = []
if slug == '-' or gh == '-':
    unreadable.append('rules and merged PR titles of ' + slug + ' not read: no GitHub command can read it')
else:
    code, rules = api('repos/' + slug + '/rules/branches/' + quote(branch))
    if code != 200 or not isinstance(rules, list):
        unreadable.append('rules of ' + slug + ' branch ' + branch + ' not readable (HTTP ' + str(code) + ')')
        rules = []
for r in rules:
    if not isinstance(r, dict) or r.get('type') != 'workflows':
        continue
    for w in ((r.get('parameters') or {}).get('workflows') or []):
        if not isinstance(w, dict) or not isinstance(w.get('path'), str):
            continue
        kind = 'title' if re.search(r'pr[-_]?title', w['path'], re.I) else 'body' if re.search(r'pr[-_]?body', w['path'], re.I) else None
        if not kind or (kind == 'title' and title) or (kind == 'body' and body['checker']):
            continue
        c1, other = api('repositories/' + str(w.get('repository_id')))
        repo = other.get('full_name') if c1 == 200 and isinstance(other, dict) and isinstance(other.get('full_name'), str) else None
        ref = str(w.get('ref') or 'HEAD')
        if kind == 'title':
            name, text = checker(repo, w['path'], ref, lambda t: 'TYPES' in t) if repo else (None, None)
            types = strs(text, 'TYPES') if text else None
            title = {'style': 'scoped-key', 'types': types or CC, 'key_required': True}
            source.append('title: required workflow ' + w['path'] + ' (ruleset ' + str(r.get('ruleset_id')) + ', ' + str(repo) + ')' + (', checker ' + name if name else ''))
            if not types:
                unreadable.append('pr-title checker of ' + str(repo) + ':' + w['path'] + ' not readable: the Conventional Commits types are assumed')
        else:
            name, text = checker(repo, w['path'], ref, lambda t: 'SECTIONS' in t or 'MIN_CHARS' in t) if repo else (None, None)
            body['checker'] = name or str(repo) + ':' + w['path']
            if text:
                body['required_sections'] = strs(text, r'[A-Z_]*SECTIONS')
                m = re.search(r'MIN_CHARS\s*=\s*(?:int\([^)]*?)?([0-9]+)', text)
                body['min_chars'] = int(m.group(1)) if m else None
                source.append('body: required workflow ' + w['path'] + ', checker ' + name)
            else:
                unreadable.append('pr-body checker of ' + body['checker'] + ' not readable: its required sections are not known')
if not title:
    for p in tracked:
        b = p.rsplit('/', 1)[-1]
        if re.fullmatch(r'\.commitlintrc(\.(json|ya?ml|js|cjs|mjs|ts))?|commitlint\.config\.(js|cjs|mjs|ts)', b) or p == '.github/semantic.yml' or (p == 'package.json' and '"commitlint"' in read_local(p)):
            m = re.search(r'''type-enum['"]?\s*[:,]\s*\[[^\[\]]*\[([^\]]*)\]''', read_local(p))
            types = re.findall(r'''['"]([a-z]+)['"]''', m.group(1)) if m else []
            title = {'style': 'conventional', 'types': types or CC, 'key_required': False}
            source.append('title: commitlint config ' + p)
            break
if not title and slug != '-' and gh != '-':
    code, pulls = api('repos/' + slug + '/pulls?state=closed&sort=updated&direction=desc&per_page=50')
    got = sorted((x for x in pulls if isinstance(x, dict) and x.get('merged_at') and isinstance(x.get('title'), str)), key=lambda x: x['merged_at'], reverse=True)[:20] if code == 200 and isinstance(pulls, list) else []
    if code != 200:
        unreadable.append('merged PR titles of ' + slug + ' not readable (HTTP ' + str(code) + ')')
    t = '(' + '|'.join(CC) + ')'
    sk = sum(1 for x in got if re.match(r'^' + t + r'\([a-z0-9-]+, ([A-Z][A-Z0-9]+-[0-9]+|NOJIRA)\): |^' + t + r'\(([A-Z][A-Z0-9]+-[0-9]+|NOJIRA)\): ', x['title']))
    cv = sum(1 for x in got if re.match(r'^' + t + r'(\([^)]+\))?!?: ', x['title']))
    if len(got) >= 5 and sk * 5 >= len(got) * 4:
        title = {'style': 'scoped-key', 'types': CC, 'key_required': True}
        source.append('title: %d of the last %d merged PR titles are type(component, KEY)' % (sk, len(got)))
    elif len(got) >= 5 and cv * 5 >= len(got) * 4:
        title = {'style': 'conventional', 'types': CC, 'key_required': False}
        source.append('title: %d of the last %d merged PR titles are type(scope): summary' % (cv, len(got)))
if not title:
    title = {'style': 'conventional', 'types': CC, 'key_required': False}
    source.append('title: no convention found; the fallback type(component): summary')
tpl = [p for p in tracked if p.count('/') <= 3 and re.match(r'pull_request_template', p.rsplit('/', 1)[-1], re.I)]
if tpl:
    body['template'] = tpl[0]
elif slug != '-' and gh != '-':
    owner = slug.split('/')[0]
    code, items = api('repos/' + owner + '/.github/contents/.github')
    hit = [x['path'] for x in (items if code == 200 and isinstance(items, list) else []) if isinstance(x, dict) and isinstance(x.get('path'), str) and re.match(r'pull_request_template', str(x.get('name', '')), re.I)]
    if hit:
        body['template'], body['template_repo'] = hit[0], owner + '/.github'
if body['template']:
    source.append('body: PR template ' + (body['template_repo'] + ':' if body['template_repo'] else '') + body['template'])
out = {'title': title, 'body': body, 'source': source, 'unreadable': unreadable, 'args': args}
out['program'] = _PROG
out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
print(json.dumps(out, ensure_ascii=False))
