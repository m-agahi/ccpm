
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
# fleet 6.0.0 (ledgers 2045, 2034): state changes of the fleet's own PR, one
# mode per call; gh runs with -R from / (never inside a checkout).
#   ready <gh> <owner/repo> <pr> <sha>: `gh pr ready` when the PR is an open
#     draft whose head is <sha>; re-read. Prints {mode, was_draft, is_draft,
#     head, state, error, args, program, digest}.
#   merge <gh> <owner/repo> <pr> <sha>: the repo must resolve to <owner/repo>
#     (any case) under an owner that is not a work owner. An open PR at <sha>
#     that is not behind and has no conflict, and whose checks, re-read here
#     (required ones; all when none is required), are a non-empty list where
#     every check passed or was skipped and one passed. A direct merge first,
#     with the repo's method (squash, merge, rebase), --match-head-commit <sha>
#     and --delete-branch; when that is refused, native auto-merge with the same
#     flags where the repo allows it (merged false, auto_enabled true: the forge
#     merges later). merged is true only when the PR is MERGED with its head at
#     <sha> and a merge commit; a PR already merged that way (a crash before the
#     run-state) reports merged without a new merge. A merged PR's fleet/* head
#     branch is deleted on the forge. Prints {mode, merged, auto_enabled,
#     method, merge_sha, blocked, merge_state, head, branch_deleted, error,
#     args, program, digest}.
#   view <gh> <owner/repo> <pr> <sha>: read only; {mode, state, head, merge_sha}
#     of the PR (merge_sha only when MERGED with its head at <sha>).
#   logs <gh> <owner/repo> <pr> <sha>: read only; re-reads the PR's failed
#     checks itself (the head must be <sha>) and, for each one that is this
#     repo's Actions job of a run of <sha>, the tail of `gh run view
#     --log-failed`, control characters removed, 3000 characters at most.
#     CI logs are untrusted data: the tails reach the classifier and, as quoted
#     untrusted data, the CI-fix coder; never the ledger, tracker comments, the
#     PR body or the ledger and comment writers' prompts. Prints {mode, head,
#     logs: [{name, url, run_id, excerpt, verified}], error, args, program,
#     digest}.
#   update <gh> <owner/repo> <pr> <sha>: the same repo and owner check as
#     merge; the forge's update-branch with expected_head_sha <sha> (never a
#     local rebase or push); waits for the new head, which must be a commit
#     whose parents are exactly [<sha>, the base branch tip] and which, against
#     the base tip, changes only files of the PR (renames and copies count their
#     source; fail closed). The PR file set is the forge's diff of <base>...<sha>,
#     read before the update (100 files or more fails closed); overlap = the PR's
#     files the base change also touches. Prints {mode, updated, head, base, overlap, error, args, program,
#     digest}.
#   fetch <worktree> <fleet/branch> <old> <new> <base>: after update-branch,
#     brings the forge's new head into the fleet worktree (clean, on the branch,
#     HEAD at <old>): `git fetch origin <branch>` must give <new>, whose parents
#     must be exactly [<old>, <base>] and whose tree must be `git merge-tree
#     --write-tree <old> <base>` (a forge merge with no extra content); then a
#     fast-forward to <new>. Prints {mode, head, tree, error, args, program,
#     digest}.
#   body <gh> <owner/repo> <pr> <sha> <spec_b64>: read only (8.9.15, yaadgaar
#     #131, #130). The PR must be OPEN at <sha>. spec: {headers, template,
#     min_chars, quotes, checks}. headers_missing: each header of <headers> and
#     each heading line of the template ({repo, path, ref}, read by gh api;
#     template_read false when it is not readable) that is no line of the body
#     (both stripped). short: the stripped body has fewer than min_chars
#     characters (null with no min_chars). quotes[i]: quote i, whitespace runs
#     collapsed to one space, is at least 12 characters and occurs, with no case
#     folding, in the body with the same collapse after the script-written test
#     and stats blocks and every heading line are removed. checks: for each
#     name, the bucket of the PR head's checks of that name (or "<workflow> /
#     <name>"): fail if any fails, else pending, else pass, else missing.
#     8.9.15 review of d9ae4c6: a quote matches within one segment only (the
#     text between removed blocks and heading lines), never across them (R4);
#     Unicode format characters (Cf: zero-width, bidi) are dropped from the
#     body and the quote first (R5). checker {worktree, base, path} (B2): the
#     repo's body checker, <path> read from the commit <base> of <worktree>
#     (never its working tree), runs once in sandbox.py (pinned sha256; no
#     network, the worktree and HOME hidden, / read-only, a fresh overlay)
#     with a 60 s deadline: `python3 -I <checker.py> <body.md>`, env
#     PR_BODY_FILE and GITHUB_EVENT_PATH ({"pull_request": {"body": ...}}), no
#     test DSN. checker: {ran, exit, timed_out, excerpt (stderr, control and
#     format characters dropped, whitespace collapsed, the last 300
#     characters), reason}; null with no checker.
#     Prints {mode, head, body_sha256, headers_missing, short, quotes, checks,
#     template_read, checker, error, args, program, digest}.
#   rerun <gh> <owner/repo> <run_ids_json>: `gh run rerun <id> --failed` each.
#     Prints {mode, rerun, error, args, program, digest}.
#   cleanup <repo> <worktree> <branch>: removes the fleet's own worktree
#     (<repo>/.claude/worktrees/fleet-<key>/main) and local branch fleet/<key>.
#     Prints {mode, removed, deleted, error, args, program, digest}.
import base64, hashlib, json, os, re, shutil, signal, subprocess, sys, tempfile, time, unicodedata
def lift():
    # 6.3.2 (2130): gh (a Go binary) is not bound by this program's caps
    for k in (_r.RLIMIT_AS, _r.RLIMIT_CPU):
        _r.setrlimit(k, (_r.getrlimit(k)[1],) * 2)
args = sys.argv[1:]
SLUG = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,99}/[A-Za-z0-9._-]{1,100}$')
SHA = re.compile(r'^[0-9a-f]{40}$')
NUM = re.compile(r'^[1-9][0-9]{0,9}$')
KEY = re.compile(r'^[a-z0-9][a-z0-9._-]{0,120}$')
mode = args[0] if args else None
GH_MODES = ('ready', 'merge', 'update', 'view', 'logs')
if mode in GH_MODES:
    ok = len(args) == 5 and args[1] in ('gh', 'gh-personal') and SLUG.match(args[2]) and NUM.match(args[3]) and SHA.match(args[4])
elif mode == 'body':
    ok = len(args) == 6 and args[1] in ('gh', 'gh-personal') and SLUG.match(args[2]) and NUM.match(args[3]) and SHA.match(args[4]) and re.match(r'^[A-Za-z0-9+/=]{1,65536}$', args[5])
elif mode == 'rerun':
    ok = len(args) == 4 and args[1] in ('gh', 'gh-personal') and SLUG.match(args[2]) and re.match(r'^\[("[1-9][0-9]{0,15}"(,"[1-9][0-9]{0,15}"){0,9})\]$', args[3])
elif mode == 'fetch':
    ok = len(args) == 6 and os.path.isabs(args[1]) and args[1] == os.path.normpath(args[1]) and args[2].startswith('fleet/') and KEY.match(args[2][6:]) and all(SHA.match(x) for x in args[3:6]) and len(set(args[3:6])) == 3
elif mode == 'cleanup':
    ok = len(args) == 4 and os.path.isabs(args[1]) and args[1] == os.path.normpath(args[1]) and args[3].startswith('fleet/') and KEY.match(args[3][6:]) and args[2] == args[1] + '/.claude/worktrees/fleet-' + args[3][6:] + '/main'
else:
    ok = False
if not ok:
    sys.exit('usage: pr_state.py ready|merge|update|view|logs <gh> <owner/repo> <pr> <sha> | body <gh> <owner/repo> <pr> <sha> <spec_b64> | fetch <worktree> <fleet/branch> <old> <new> <base> | rerun <gh> <owner/repo> <run_ids_json> | cleanup <repo> <worktree> <fleet/branch>')
# work repos never merge or update the branch, whatever the caller says
WORK = ('quinyx', 'concrete-media')
if mode in ('merge', 'update') and args[2].split('/')[0].lower() in WORK:
    sys.exit('work repo ' + args[2] + ': the fleet never merges or updates its branch')
os.chdir('/')
for k, v in (('GH_PROMPT_DISABLED', '1'), ('NO_COLOR', '1'), ('GH_NO_UPDATE_NOTIFIER', '1')):
    os.environ[k] = v
gh, slug = args[1], args[2]


class Fail(Exception):
    pass


def run(*a, timeout=120, cmd=None, net=False):
    r = subprocess.run([cmd or gh] + list(a), capture_output=True, timeout=timeout, preexec_fn=lift if (not cmd or net) else None)
    if r.returncode != 0:
        raise Fail((cmd or 'gh') + ' ' + ' '.join(a[:2]) + ': ' + r.stderr.decode('utf-8', 'replace').strip()[-500:])
    return r.stdout.decode('utf-8', 'replace')


def view(fields):
    return json.loads(run('pr', 'view', args[3], '-R', slug, '--json', fields))


def open_at(v, sha):
    if v.get('state') != 'OPEN':
        raise Fail('the PR is ' + str(v.get('state')) + ', not OPEN')
    if v.get('headRefOid') != sha:
        raise Fail('the PR head is ' + str(v.get('headRefOid')) + ', not ' + sha)


def same_repo():
    # a transferred or renamed repo redirects: the forge's own name and owner decide
    rv = json.loads(run('repo', 'view', slug, '--json', 'owner,nameWithOwner,squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed,autoMergeAllowed'))
    nwo, own = str(rv.get('nameWithOwner') or ''), str((rv.get('owner') or {}).get('login') or '')
    if nwo.lower() != slug.lower():
        raise Fail('the repo ' + slug + ' resolves to ' + json.dumps(nwo) + ' on the forge')
    if not own or own.lower() in WORK or nwo.split('/')[0].lower() in WORK:
        raise Fail('the repo owner ' + json.dumps(own) + ' is a work owner or unknown: the fleet never merges or updates its branch')
    return rv


def checks(req=True):
    # the PR head's checks: required ones, all when none is required; [] when none is reported
    r = subprocess.run([gh, 'pr', 'checks', args[3], '-R', slug, '--json', 'name,state,bucket,link'] + (['--required'] if req else []), capture_output=True, timeout=120, preexec_fn=lift)
    err = r.stderr.decode('utf-8', 'replace').strip()
    try:
        lst = json.loads(r.stdout.decode('utf-8'))
        if isinstance(lst, list):
            return lst if lst or not req else checks(False)
    except ValueError:
        pass
    if 'no required checks' in err.lower() and req:
        return checks(False)
    if 'no checks reported' in err.lower() or r.returncode in (0, 8):
        return []
    raise Fail('gh pr checks: ' + err[-300:])


SANDBOX_SHA256 = '6ef231433b0333775fc85b0762caff74edd2ae862a3a1bd4b5a73264cfb3fd43'
SBX = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'sandbox.py')


def body_checker(ck, body):
    # 8.9.15 review of d9ae4c6 (B2): the repo's body checker, read at <base>, run once in the sandbox
    res = {'ran': False, 'exit': None, 'timed_out': False, 'excerpt': None, 'reason': None}
    try:
        with open(SBX, 'rb') as fh:
            if hashlib.sha256(fh.read()).hexdigest() != SANDBOX_SHA256:
                res['reason'] = 'sandbox unavailable: sandbox.py does not hash to its pinned sha256'
                return res
    except OSError as e:
        res['reason'] = 'sandbox unavailable: ' + str(e)[:200]
        return res
    wt = ck['worktree']
    scratch = os.path.join(os.path.dirname(wt), 'scratch')
    if not os.path.isdir(scratch):
        res['reason'] = 'no scratch dir next to the worktree'
        return res
    g = subprocess.run(['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', wt, 'cat-file', 'blob', ck['base'] + ':' + ck['path']], capture_output=True, timeout=60)
    if g.returncode != 0:
        res['reason'] = 'the checker ' + ck['path'] + ' is not a file at ' + ck['base']
        return res
    tmp = tempfile.mkdtemp(prefix='bodychk-', dir=scratch)
    sd = tempfile.mkdtemp(prefix='bodychk-spec-', dir=scratch)
    try:
        for n, data in (('checker.py', g.stdout), ('body.md', body.encode('utf-8')), ('event.json', json.dumps({'pull_request': {'body': body}}).encode('utf-8'))):
            with open(os.path.join(tmp, n), 'wb') as fh:
                fh.write(data)
        os.mkdir(os.path.join(tmp, 'home'))
        env = {'PATH': _o.environ.get('PATH', ''), 'HOME': os.path.join(tmp, 'home'), 'LANG': 'C.UTF-8', 'PR_BODY_FILE': os.path.join(tmp, 'body.md'), 'GITHUB_EVENT_PATH': os.path.join(tmp, 'event.json'), 'GITHUB_EVENT_NAME': 'pull_request'}
        spec = {'worktree': wt, 'cwd': tmp, 'copy': tmp, 'argv': [os.path.realpath(sys.executable), '-I', os.path.join(tmp, 'checker.py'), os.path.join(tmp, 'body.md')], 'env': env, 'git': False, 'check': True, 'result': os.path.join(sd, 'res.json')}
        with open(os.path.join(sd, 'spec.json'), 'w') as fh:
            json.dump(spec, fh)
        with tempfile.TemporaryFile() as err:
            p = subprocess.Popen([sys.executable, '-I', SBX, 'run', os.path.join(sd, 'spec.json')], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=err, preexec_fn=lift, start_new_session=True)
            try:
                p.wait(timeout=60)
            except subprocess.TimeoutExpired:
                res['timed_out'] = True
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except OSError:
                pass
            p.wait()
            err.seek(0)
            text = err.read(1 << 16).decode('utf-8', 'replace')
        if res['timed_out']:
            res['reason'] = 'the checker ran out of time (60 s)'
            return res
        try:
            with open(spec['result']) as fh:
                rr = json.load(fh)
        except (OSError, ValueError):
            rr = {'started': False, 'reason': 'sandbox.py gave no result'}
        if not rr.get('started'):
            res['reason'] = 'sandbox unavailable: ' + str(rr.get('reason'))[:200]
            return res
        res['ran'] = True
        res['exit'] = rr.get('exit') if isinstance(rr.get('exit'), int) else None
        clean = ' '.join(''.join(c if unicodedata.category(c) not in ('Cc', 'Cf') else ' ' for c in text).split())
        res['excerpt'] = clean[-300:] or None
        return res
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        shutil.rmtree(sd, ignore_errors=True)


KEYS = {
    'ready': ('was_draft', 'is_draft', 'head', 'state'),
    'merge': ('merged', 'auto_enabled', 'method', 'merge_sha', 'blocked', 'merge_state', 'head', 'branch_deleted'),
    'update': ('updated', 'head', 'base', 'overlap'),
    'view': ('state', 'head', 'merge_sha'),
    'logs': ('head', 'logs'),
    'body': ('head', 'body_sha256', 'headers_missing', 'short', 'quotes', 'checks', 'template_read', 'checker'),
    'rerun': ('rerun',),
    'cleanup': ('removed', 'deleted'),
    'fetch': ('head', 'tree'),
}
out = dict({'mode': mode}, **{k: None for k in KEYS[mode]})
out['error'] = None
try:
    if mode == 'ready':
        pr, sha = args[3], args[4]
        v = view('isDraft,headRefOid,state')
        out.update(was_draft=v.get('isDraft'), is_draft=v.get('isDraft'), head=v.get('headRefOid'), state=v.get('state'))
        open_at(v, sha)
        if v.get('isDraft'):
            run('pr', 'ready', pr, '-R', slug)
            w = view('isDraft,headRefOid,state')
            out.update(is_draft=w.get('isDraft'), head=w.get('headRefOid'), state=w.get('state'))
    elif mode == 'merge':
        pr, sha = args[3], args[4]
        out.update(merged=False, auto_enabled=False)
        rv = same_repo()
        m = 'squash' if rv.get('squashMergeAllowed') else 'merge' if rv.get('mergeCommitAllowed') else 'rebase' if rv.get('rebaseMergeAllowed') else None
        out['method'] = m
        v = view('state,headRefOid,headRefName,mergeStateStatus,mergeCommit')
        out.update(head=v.get('headRefOid'), merge_state=v.get('mergeStateStatus'))
        mc = (v.get('mergeCommit') or {}).get('oid')
        if v.get('state') == 'MERGED' and v.get('headRefOid') == sha and isinstance(mc, str) and SHA.match(mc):
            # merged at <sha> before the run-state recorded it: report, never merge again
            out.update(merged=True, merge_sha=mc)
        else:
            open_at(v, sha)
            cs = checks()
            notok = [c for c in cs if c.get('bucket') not in ('pass', 'skipping')]
            if m is None:
                out['blocked'] = 'the repo allows no merge method'
            elif v.get('mergeStateStatus') == 'BEHIND':
                out['blocked'] = 'behind'
            elif v.get('mergeStateStatus') == 'DIRTY':
                out['blocked'] = 'conflict'
            elif not cs or notok or not any(c.get('bucket') == 'pass' for c in cs):
                out['blocked'] = 'checks not green at ' + sha + ': ' + (', '.join(json.dumps(str(c.get('name'))) + ' ' + str(c.get('bucket')) for c in (notok or cs))[:300] or 'no check reported')
            elif view('headRefOid').get('headRefOid') != sha:
                raise Fail('the PR head moved off ' + sha + ' during the checks read')
            else:
                base = ['pr', 'merge', pr, '-R', slug, '--' + m, '--match-head-commit', sha, '--delete-branch']
                # a direct merge first, bound to <sha> by --match-head-commit; native auto-merge only
                # when it is refused: it relies on the forge's required checks to merge later.
                # Residual risk: a later push by a write-access account keeps auto-merge enabled.
                for extra in ([],) + ((['--auto'],) if rv.get('autoMergeAllowed') else ()):
                    try:
                        run(*(base + extra))
                        out['blocked'] = None
                        break
                    except Fail as e:
                        out['blocked'] = str(e)[:300]
                w = view('state,mergeCommit,autoMergeRequest,headRefOid,mergeStateStatus')
                out.update(merge_state=w.get('mergeStateStatus'), head=w.get('headRefOid'))
                mc = (w.get('mergeCommit') or {}).get('oid')
                if w.get('state') == 'MERGED' and w.get('headRefOid') == sha and isinstance(mc, str) and SHA.match(mc):
                    out.update(merged=True, blocked=None, merge_sha=mc)
                elif w.get('state') == 'OPEN' and w.get('headRefOid') == sha and w.get('autoMergeRequest'):
                    out.update(auto_enabled=True, blocked=None)
                elif not out['blocked']:
                    out['blocked'] = 'not merged and no auto-merge request (' + str(w.get('state')) + ', ' + str(w.get('mergeStateStatus')) + ')'
        br = v.get('headRefName') or ''
        if out['merged'] and br.startswith('fleet/'):
            q = subprocess.run([gh, 'api', 'repos/' + slug + '/branches/' + br], capture_output=True, timeout=60, preexec_fn=lift)
            if q.returncode != 0 and b'404' in q.stderr + q.stdout:
                out['branch_deleted'] = True
            else:
                d = subprocess.run([gh, 'api', '-X', 'DELETE', 'repos/' + slug + '/git/refs/heads/' + br], capture_output=True, timeout=60, preexec_fn=lift)
                out['branch_deleted'] = d.returncode == 0
    elif mode == 'update':
        pr, sha = args[3], args[4]
        out.update(updated=False, overlap=[])
        same_repo()
        v = view('state,headRefOid,baseRefName')
        open_at(v, sha)
        bname = v.get('baseRefName') or ''
        if not re.match(r'^[A-Za-z0-9._/-]{1,200}$', bname):
            raise Fail('bad base branch ' + json.dumps(bname))

        def paths(f):
            # a compare entry's changed paths: the file, and the source of a rename or copy
            return [x for x in (f.get('filename'), f.get('previous_filename')) if isinstance(x, str) and x]
        # security review: the PR file set comes from the forge's diff of the reviewed sha, BEFORE the
        # update (a list read after it can already hold injected files); 100 files or more fail closed
        pre = json.loads(run('api', 'repos/' + slug + '/compare/' + bname + '...' + sha)).get('files') or []
        if len(pre) >= 100:
            raise Fail('the reviewed diff has 100 files or more: the PR file set is not known')
        mine = set(p for f in pre for p in paths(f))
        if not mine:
            raise Fail('the reviewed diff lists no file: the PR file set is not known')
        run('api', '-X', 'PUT', 'repos/' + slug + '/pulls/' + pr + '/update-branch', '-f', 'expected_head_sha=' + sha)
        new = sha
        for _ in range(24):
            new = view('headRefOid').get('headRefOid')
            if new != sha:
                break
            time.sleep(5)
        out['head'] = new
        if new == sha or not isinstance(new, str) or not SHA.match(new):
            raise Fail('the head did not move after update-branch')
        # the new head must be the forge's merge of <sha> and the base tip, nothing else
        tip = (json.loads(run('api', 'repos/' + slug + '/branches/' + bname)).get('commit') or {}).get('sha')
        out['base'] = tip if isinstance(tip, str) and SHA.match(tip) else None
        par = [x.get('sha') for x in json.loads(run('api', 'repos/' + slug + '/commits/' + new)).get('parents') or []]
        if out['base'] is None or par != [sha, out['base']]:
            raise Fail('the new head ' + new + ' has parents ' + json.dumps(par) + ', not [' + sha + ', the base tip ' + str(out['base']) + ']')
        cmp = json.loads(run('api', 'repos/' + slug + '/compare/' + sha + '...' + new)).get('files') or []
        if len(cmp) >= 300:
            raise Fail('the base change lists 300 files or more: overlap not known')
        moved = set(p for f in cmp for p in paths(f))
        out['overlap'] = sorted(moved & mine)
        # the content check: against the base tip, the new head changes only files of the PR; a rename
        # or copy counts its source too, and any source outside the PR set is refused
        tcmp = json.loads(run('api', 'repos/' + slug + '/compare/' + out['base'] + '...' + new)).get('files') or []
        if len(tcmp) >= 300:
            raise Fail('the new head lists 300 files or more against the base tip: content not known')
        extra = sorted(set(p for f in tcmp for p in paths(f) if p not in mine) | set(str(f.get('filename')) for f in tcmp if not paths(f)))
        if extra:
            raise Fail('the new head changes files outside the PR against the base tip: ' + ', '.join(json.dumps(x) for x in extra[:10]))
        out['updated'] = True
    elif mode == 'view':
        v = view('state,headRefOid,mergeCommit')
        mc = (v.get('mergeCommit') or {}).get('oid')
        out.update(state=v.get('state'), head=v.get('headRefOid'), merge_sha=mc if v.get('state') == 'MERGED' and v.get('headRefOid') == args[4] and isinstance(mc, str) and SHA.match(mc) else None)
    elif mode == 'logs':
        sha = args[4]
        out['logs'] = []
        if view('headRefOid').get('headRefOid') != sha:
            raise Fail('the PR head is not ' + sha)
        out['head'] = sha
        CTRL = re.compile(r'\x1b\[[0-9;?]*[ -/]*[@-~]|[\x00-\x08\x0b-\x1f\x7f]')
        RUN_URL = re.compile(r'^https://github\.com/' + re.escape(slug) + r'/actions/runs/([0-9]{1,16})/job/([0-9]{1,16})$', re.I)
        for c in [c for c in checks() if c.get('bucket') in ('fail', 'cancel')][:6]:
            u = c.get('link') or None
            mm = RUN_URL.match(u or '')
            ok, ex = False, None
            if mm:
                try:
                    r = subprocess.run([gh, 'run', 'view', mm.group(1), '--repo', slug, '--json', 'headSha,jobs'], capture_output=True, timeout=60, preexec_fn=lift)
                    rv = json.loads(r.stdout.decode('utf-8')) if r.returncode == 0 else {}
                    ok = rv.get('headSha') == sha and any(str(j.get('databaseId')) == mm.group(2) for j in rv.get('jobs') or [])
                    if ok:
                        r = subprocess.run([gh, 'run', 'view', '-R', slug, '--job', mm.group(2), '--log-failed'], capture_output=True, timeout=60, preexec_fn=lift)
                        ex = CTRL.sub('', r.stdout.decode('utf-8', 'replace'))[-3000:] if r.returncode == 0 else None
                except (subprocess.TimeoutExpired, ValueError, AttributeError, TypeError):
                    ok, ex = False, None
            out['logs'].append({'name': str(c.get('name')), 'url': u, 'run_id': mm.group(1) if ok else None, 'excerpt': ex, 'verified': ok})
    elif mode == 'body':
        sha = args[4]
        sp = json.loads(base64.b64decode(args[5], validate=True).decode('utf-8'))
        strs = lambda v, n, m: isinstance(v, list) and len(v) <= n and all(isinstance(x, str) and 0 < len(x) <= m for x in v)
        tp = sp.get('template') if isinstance(sp, dict) else None
        mc = sp.get('min_chars') if isinstance(sp, dict) else None
        if not isinstance(sp, dict) or not strs(sp.get('headers'), 40, 200) or not strs(sp.get('quotes'), 10, 300) or not strs(sp.get('checks'), 20, 200) or not (mc is None or (type(mc) is int and 0 <= mc <= 100000)):
            raise Fail('bad body spec')
        if tp is not None and not (isinstance(tp, dict) and isinstance(tp.get('repo'), str) and SLUG.match(tp['repo']) and isinstance(tp.get('path'), str) and re.match(r'^[A-Za-z0-9._/-]{1,255}$', tp['path']) and '..' not in tp['path'].split('/') and (tp.get('ref') is None or (isinstance(tp.get('ref'), str) and SHA.match(tp['ref'])))):
            raise Fail('bad template in the body spec')
        ck = sp.get('checker')
        if ck is not None and not (isinstance(ck, dict) and isinstance(ck.get('worktree'), str) and os.path.isabs(ck['worktree']) and ck['worktree'] == os.path.normpath(ck['worktree']) and isinstance(ck.get('base'), str) and re.fullmatch(r'[0-9a-f]{40}([0-9a-f]{24})?', ck['base']) and isinstance(ck.get('path'), str) and re.match(r'^[A-Za-z0-9._/-]{1,255}\.py$', ck['path']) and '..' not in ck['path'].split('/') and not ck['path'].startswith('/')):
            raise Fail('bad checker in the body spec')
        v = view('body,headRefOid,state')
        out['head'] = v.get('headRefOid')
        open_at(v, sha)
        b = (v.get('body') if isinstance(v.get('body'), str) else '').replace('\r\n', '\n')
        out['body_sha256'] = hashlib.sha256(b.encode('utf-8')).hexdigest()
        HEAD = re.compile(r'^#{1,6}[ \t]+\S.*$', re.M)
        heads = list(sp['headers'])
        if tp is not None:
            out['template_read'] = False
            try:
                d = json.loads(run('api', 'repos/' + tp['repo'] + '/contents/' + tp['path'] + ('?ref=' + tp['ref'] if tp.get('ref') else '')))
                t = base64.b64decode(d.get('content') or '').decode('utf-8', 'replace').replace('\r\n', '\n')
                heads += [h.strip() for h in HEAD.findall(t) if re.match(r'^#{1,6} [^\n`$]{1,80}$', h.strip())][:40]
                out['template_read'] = True
            except (Fail, ValueError, AttributeError):
                pass
        lines = set(x.strip() for x in b.split('\n'))
        out['headers_missing'] = [h for i, h in enumerate(heads) if h.strip() not in lines and h not in heads[:i]]
        out['short'] = None if mc is None else len(b.strip()) < mc
        # the quote text: no script-written block, no heading line; each segment between them on its own (R4),
        # format characters dropped (R5), whitespace runs collapsed, no case folding
        norm = lambda x: ' '.join(''.join(c for c in x if unicodedata.category(c) != 'Cf').split())
        t = re.sub(r'<!-- ccpm-fleet-tests -->.*?<!-- /ccpm-fleet-tests -->', '\0', b, flags=re.S)
        t = re.sub(r'<details><summary>Built with (?:ccpm fleet|ccpmcwf).*?<!-- ccpm-fleet-stats -->', '\0', t, flags=re.S)
        segs = [norm(x) for x in HEAD.sub('\0', t.replace('\0', '\n\0\n')).split('\0')]
        out['quotes'] = [len(norm(q)) >= 12 and any(norm(q) in g for g in segs) for q in sp['quotes']]
        out['checker'] = None if ck is None else body_checker(ck, b)
        out['checks'] = []
        if sp['checks']:
            r = subprocess.run([gh, 'pr', 'checks', args[3], '-R', slug, '--json', 'name,bucket,workflow'], capture_output=True, timeout=120, preexec_fn=lift)
            try:
                cs = json.loads(r.stdout.decode('utf-8'))
            except ValueError:
                cs = None
            if not isinstance(cs, list):
                if 'no checks reported' not in r.stderr.decode('utf-8', 'replace').lower():
                    raise Fail('gh pr checks: ' + r.stderr.decode('utf-8', 'replace').strip()[-300:])
                cs = []
            for n in sp['checks']:
                bs = [c.get('bucket') for c in cs if isinstance(c, dict) and n in (c.get('name'), str(c.get('workflow')) + ' / ' + str(c.get('name')))]
                out['checks'].append({'name': n, 'bucket': next((k for k in ('fail', 'pending', 'pass') if k in bs), 'missing')})
            if view('headRefOid').get('headRefOid') != sha:
                raise Fail('the PR head moved off ' + sha + ' during the checks read')
    elif mode == 'rerun':
        out['rerun'] = []
        for i in json.loads(args[3]):
            run('run', 'rerun', i, '--failed', '-R', slug)
            out['rerun'].append(i)
    elif mode == 'fetch':
        wt, br, old, new, base = args[1:6]
        # 6.1.0 review B3: no repo hook runs (post-merge, reference-transaction, ...)
        # 7.4.0 (#34): only the network call (fetch) runs without the caps
        g = lambda *a, net=False: run('-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', wt, *a, cmd='git', net=net).strip()
        if g('symbolic-ref', '--quiet', 'HEAD') != 'refs/heads/' + br or g('rev-parse', 'HEAD') != old:
            raise Fail('the worktree is not on ' + br + ' at ' + old)
        if g('status', '--porcelain', '--untracked-files=no'):
            raise Fail('the worktree has uncommitted changes')
        g('fetch', '--no-tags', '--no-recurse-submodules', 'origin', 'refs/heads/' + br, net=True)
        if g('rev-parse', 'FETCH_HEAD') != new:
            raise Fail('origin/' + br + ' is not ' + new)
        par = g('rev-list', '--parents', '-n', '1', new).split()[1:]
        if par != [old, base]:
            raise Fail('the new head ' + new + ' has parents ' + json.dumps(par) + ', not [' + old + ', ' + base + ']')
        want = g('merge-tree', '--write-tree', old, base).split('\n')[0]
        out['tree'] = g('rev-parse', new + '^{tree}')
        if out['tree'] != want:
            raise Fail('the tree of ' + new + ' is ' + out['tree'] + ', not the merge of ' + old + ' and ' + base + ' (' + want + ')')
        g('merge', '--ff-only', '--quiet', new)
        out['head'] = g('rev-parse', 'HEAD')
        if out['head'] != new:
            raise Fail('HEAD is ' + out['head'] + ' after the fast-forward, not ' + new)
    else:
        repo, wt, br = args[1], args[2], args[3]
        out.update(removed=False, deleted=False)
        lst = run('-c', 'core.hooksPath=/dev/null', '-C', repo, 'worktree', 'list', '--porcelain', cmd='git')
        hit = [b for b in lst.split('\n\n') if ('worktree ' + wt) in b.split('\n')]
        if not hit or ('branch refs/heads/' + br) not in hit[0].split('\n'):
            raise Fail('no worktree ' + wt + ' on ' + br)
        run('-c', 'core.hooksPath=/dev/null', '-C', repo, 'worktree', 'remove', '--force', wt, cmd='git')
        out['removed'] = True
        run('-c', 'core.hooksPath=/dev/null', '-C', repo, 'branch', '-D', br, cmd='git')
        out['deleted'] = True
except (Fail, ValueError, OSError, AttributeError, TypeError, subprocess.SubprocessError) as e:
    out['error'] = str(e)[:600] or mode + ' failed'
out['args'] = args
out['program'] = _PROG
out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
print(json.dumps(out, ensure_ascii=False))
