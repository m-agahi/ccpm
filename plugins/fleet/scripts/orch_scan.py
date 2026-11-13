
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
# fleet 6.0.0 (ledger 2034, ADR-1199): is the fleet's PR an orchestrator or IaC
# PR? Args: <worktree> <gh_cmd> <owner/repo> <pr> <head_sha> <default_branch>.
# Fails closed: any read that does not complete sets error and every flag true.
# It scans the worktree's tracked files and the forge's own trees of <head_sha>
# (which must be the PR head) and of <default_branch> (a truncated tree, more
# than 60 CI files in a tree, or a PR of 100 files or more is an error). A
# heuristic: composite actions, Makefiles, scripts a workflow runs and remote
# reusable workflows are not read. orchestrator: a tracked
# orchestrator config (dig-ger / atlan-tis yaml, .spacelift/, *.spacelift.*),
# or a check, status or comment from such an app or bot on the PR. iac_repo: a
# tracked IaC file (HCL/JSON/vars, terra-grunt.hcl, Pulumi.yaml, cdk.json), or
# one the PR changes. apply_on_merge: a tracked CI file that names an IaC tool
# or orchestrator. hook_surface_pr: the PR changes a hook config, CI or
# hook-manager file. Prints {orchestrator, iac_repo, apply_on_merge,
# hook_surface_pr, reasons, error, args, program, digest}. Read only.
import base64, hashlib, json, os, re, subprocess, sys
def lift():
    # 6.3.2 (2130): gh (a Go binary) is not bound by this program's caps
    for k in (_r.RLIMIT_AS, _r.RLIMIT_CPU):
        _r.setrlimit(k, (_r.getrlimit(k)[1],) * 2)
args = sys.argv[1:]
SLUG = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,99}/[A-Za-z0-9._-]{1,100}$')
if len(args) != 6 or not os.path.isabs(args[0]) or args[1] not in ('gh', 'gh-personal') or not SLUG.match(args[2]) or not re.match(r'^[1-9][0-9]{0,9}$', args[3]) or not re.match(r'^[0-9a-f]{40}$', args[4]) or not re.match(r'^[A-Za-z0-9._/-]{1,200}$', args[5]) or '..' in args[5]:
    sys.exit('usage: orch_scan.py <worktree> <gh|gh-personal> <owner/repo> <pr> <head_sha> <default_branch>')
wt, gh, slug, pr, head, dflt = args
os.chdir('/')
for k, v in (('GH_PROMPT_DISABLED', '1'), ('NO_COLOR', '1'), ('GH_NO_UPDATE_NOTIFIER', '1')):
    os.environ[k] = v
TF, TO, TP, DG, AT, SL = 'terra' + 'form', 'to' + 'fu', 't' + 'fp', 'dig' + 'ger', 'atlan' + 'tis', 'space' + 'lift'
BOTS = re.compile(DG + '|' + AT + '|' + SL, re.I)
ORCH_FILE = re.compile(r'(^|/)((' + DG + '|' + AT + r')\.ya?ml|\.' + SL + r'/.*|[^/]*\.' + SL + r'\.[^/]+)$', re.I)
IAC_FILE = re.compile(r'(\.(tf|tf\.json|tfvars|tfvars\.json|' + TO + '|' + TO + r'\.json|' + TO + r'vars)$|(^|/)(' + 'terra' + r'grunt\.hcl|Pulumi\.ya?ml|cdk\.json)$)', re.I)
CI_FILE = re.compile(r'^(\.github/workflows/|\.gitea/|\.forgejo/|\.circleci/|\.gitlab/|\.gitlab-ci\.yml$|\.buildkite/|\.woodpecker|Jenkinsfile$|azure-pipelines\.ya?ml$|bitbucket-pipelines\.ya?ml$)', re.I)
CI_TOOL = re.compile(r'\b(' + TF + '|' + TO + '|' + TP + '|' + 'terra' + r'grunt|pulumi|cdk\s+deploy|' + DG + '|' + AT + '|' + SL + r')\b', re.I)
HOOK_FILE = re.compile(r'(^|/)(\.pre-commit-config\.ya?ml|\.pre-commit-hooks\.ya?ml|\.?lefthook\.ya?ml|\.husky/.*|\.githooks/.*)$|^(\.github/|\.gitea/|\.forgejo/|\.gitlab-ci\.yml$|\.gitlab/)', re.I)
out = {'orchestrator': False, 'iac_repo': False, 'apply_on_merge': False, 'hook_surface_pr': False, 'reasons': [], 'error': None}


class Fail(Exception):
    pass


def api(path):
    r = subprocess.run([gh, 'api', path], capture_output=True, timeout=120, preexec_fn=lift)
    if r.returncode != 0:
        raise Fail('gh api ' + path + ': ' + r.stderr.decode('utf-8', 'replace').strip()[-300:])
    return json.loads(r.stdout.decode('utf-8'))


def scan_path(p, text, where):
    if ORCH_FILE.search(p):
        note('orchestrator', 'orchestrator config ' + p + where)
    if IAC_FILE.search(p):
        note('iac_repo', 'IaC file ' + p + where)
    if CI_FILE.search(p):
        m = CI_TOOL.search(text())
        if m:
            note('apply_on_merge', 'CI file ' + p + where + ' names ' + m.group(1))


def note(flag, why):
    out[flag] = True
    if len(out['reasons']) < 20:
        out['reasons'].append(why)


try:
    ls = subprocess.run(['git', '--no-replace-objects', '-C', wt, 'ls-files', '-z'], capture_output=True, timeout=120)
    if ls.returncode != 0:
        raise Fail('git ls-files: ' + ls.stderr.decode('utf-8', 'replace')[-300:])
    def local(p):
        try:
            with open(os.path.join(wt, p), 'rb') as fh:
                return fh.read(1 << 20).decode('utf-8', 'replace')
        except OSError as e:
            raise Fail('read ' + p + ': ' + str(e))
    for p in sorted(x.decode('utf-8', 'replace') for x in ls.stdout.split(b'\0') if x):
        scan_path(p, lambda p=p: local(p), '')
    r = subprocess.run([gh, 'pr', 'view', pr, '-R', slug, '--json', 'statusCheckRollup,comments,files,headRefOid'], capture_output=True, timeout=120, preexec_fn=lift)
    if r.returncode != 0:
        raise Fail('gh pr view: ' + r.stderr.decode('utf-8', 'replace').strip()[-300:])
    v = json.loads(r.stdout.decode('utf-8'))
    if v.get('headRefOid') != head:
        raise Fail('the PR head is ' + str(v.get('headRefOid')) + ', not ' + head)
    if len(v.get('files') or []) >= 100:
        raise Fail('the PR has 100 files or more: its file list is cut')
    # the forge's view: the PR head and the default branch tip, not only the local checkout
    for ref in (head, dflt):
        tr = api('repos/' + slug + '/git/trees/' + ref + '?recursive=1')
        if tr.get('truncated') is not False or not isinstance(tr.get('tree'), list):
            raise Fail('the forge tree of ' + ref + ' is truncated or unreadable')
        blobs = [e for e in tr['tree'] if e.get('type') == 'blob' and isinstance(e.get('path'), str)]
        if sum(1 for e in blobs if CI_FILE.search(e['path'])) > 60:
            raise Fail('more than 60 CI files in the forge tree of ' + ref)
        for e in blobs:
            scan_path(e['path'], lambda e=e: base64.b64decode(api('repos/' + slug + '/git/blobs/' + str(e.get('sha'))).get('content') or '').decode('utf-8', 'replace'), ' (forge ' + ref[:12] + ')')
    for c in v.get('statusCheckRollup') or []:
        for k in ('name', 'context', 'workflowName', 'targetUrl', 'detailsUrl'):
            if isinstance(c.get(k), str) and BOTS.search(c[k]):
                note('orchestrator', 'check ' + str(c.get('name') or c.get('context')) + ' (' + k + ')')
                break
    for c in v.get('comments') or []:
        a = (c.get('author') or {}).get('login') or ''
        if BOTS.search(a):
            note('orchestrator', 'comment by ' + a)
    for f in v.get('files') or []:
        p = f.get('path') or ''
        if HOOK_FILE.search(p):
            note('hook_surface_pr', 'PR changes ' + p)
        if IAC_FILE.search(p) or ORCH_FILE.search(p):
            note('iac_repo', 'PR changes ' + p)
except (Fail, ValueError, OSError, AttributeError, TypeError, subprocess.SubprocessError) as e:
    out.update(orchestrator=True, iac_repo=True, apply_on_merge=True, hook_surface_pr=True, error=str(e)[:600] or 'scan failed')
out['args'] = args
out['program'] = _PROG
out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
print(json.dumps(out, ensure_ascii=False))
