
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
#   merge <gh> <owner/repo> <pr> <sha>: an open PR at <sha> that is not behind
#     and has no conflict: native auto-merge when the repo allows it, else a
#     direct merge; both with the repo's method (squash, merge, rebase) and
#     --match-head-commit <sha>. A merged PR's fleet/* head branch is deleted on
#     the forge. Prints {mode, merged, auto_enabled, method, merge_sha, blocked,
#     merge_state, head, branch_deleted, error, args, program, digest}.
#   update <gh> <owner/repo> <pr> <sha>: the forge's update-branch with
#     expected_head_sha <sha> (never a local rebase or push); waits for the new
#     head; overlap = the PR's files the base change also touches. Prints
#     {mode, updated, head, overlap, error, args, program, digest}.
#   rerun <gh> <owner/repo> <run_ids_json>: `gh run rerun <id> --failed` each.
#     Prints {mode, rerun, error, args, program, digest}.
#   cleanup <repo> <worktree> <branch>: removes the fleet's own worktree
#     (<repo>/.claude/worktrees/fleet-<key>/main) and local branch fleet/<key>.
#     Prints {mode, removed, deleted, error, args, program, digest}.
import hashlib, json, os, re, subprocess, sys, time
args = sys.argv[1:]
SLUG = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,99}/[A-Za-z0-9._-]{1,100}$')
SHA = re.compile(r'^[0-9a-f]{40}$')
NUM = re.compile(r'^[1-9][0-9]{0,9}$')
KEY = re.compile(r'^[a-z0-9][a-z0-9._-]{0,120}$')
mode = args[0] if args else None
GH_MODES = ('ready', 'merge', 'update')
if mode in GH_MODES:
    ok = len(args) == 5 and args[1] in ('gh', 'gh-personal') and SLUG.match(args[2]) and NUM.match(args[3]) and SHA.match(args[4])
elif mode == 'rerun':
    ok = len(args) == 4 and args[1] in ('gh', 'gh-personal') and SLUG.match(args[2]) and re.match(r'^\[("[1-9][0-9]{0,15}"(,"[1-9][0-9]{0,15}"){0,9})\]$', args[3])
elif mode == 'cleanup':
    ok = len(args) == 4 and os.path.isabs(args[1]) and args[1] == os.path.normpath(args[1]) and args[3].startswith('fleet/') and KEY.match(args[3][6:]) and args[2] == args[1] + '/.claude/worktrees/fleet-' + args[3][6:] + '/main'
else:
    ok = False
if not ok:
    sys.exit('usage: pr_state.py ready|merge|update <gh> <owner/repo> <pr> <sha> | rerun <gh> <owner/repo> <run_ids_json> | cleanup <repo> <worktree> <fleet/branch>')
# work repos never merge or update the branch, whatever the caller says
if mode in ('merge', 'update') and args[2].split('/')[0].lower() in ('quinyx', 'concrete-media'):
    sys.exit('work repo ' + args[2] + ': the fleet never merges or updates its branch')
os.chdir('/')
for k, v in (('GH_PROMPT_DISABLED', '1'), ('NO_COLOR', '1'), ('GH_NO_UPDATE_NOTIFIER', '1')):
    os.environ[k] = v
gh, slug = args[1], args[2]


class Fail(Exception):
    pass


def run(*a, timeout=120, cmd=None):
    r = subprocess.run([cmd or gh] + list(a), capture_output=True, timeout=timeout)
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


KEYS = {
    'ready': ('was_draft', 'is_draft', 'head', 'state'),
    'merge': ('merged', 'auto_enabled', 'method', 'merge_sha', 'blocked', 'merge_state', 'head', 'branch_deleted'),
    'update': ('updated', 'head', 'overlap'),
    'rerun': ('rerun',),
    'cleanup': ('removed', 'deleted'),
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
        rv = json.loads(run('repo', 'view', slug, '--json', 'squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed,autoMergeAllowed'))
        m = 'squash' if rv.get('squashMergeAllowed') else 'merge' if rv.get('mergeCommitAllowed') else 'rebase' if rv.get('rebaseMergeAllowed') else None
        out['method'] = m
        v = view('state,headRefOid,headRefName,mergeStateStatus')
        out.update(head=v.get('headRefOid'), merge_state=v.get('mergeStateStatus'))
        open_at(v, sha)
        if m is None:
            out['blocked'] = 'the repo allows no merge method'
        elif v.get('mergeStateStatus') == 'BEHIND':
            out['blocked'] = 'behind'
        elif v.get('mergeStateStatus') == 'DIRTY':
            out['blocked'] = 'conflict'
        else:
            base = ['pr', 'merge', pr, '-R', slug, '--' + m, '--match-head-commit', sha]
            # native auto-merge first where the repo allows it; a refusal falls back to a direct merge
            for extra in ((['--auto'],) if rv.get('autoMergeAllowed') else ()) + (['--delete-branch'],):
                try:
                    run(*(base + extra))
                    out['blocked'] = None
                    break
                except Fail as e:
                    out['blocked'] = str(e)[:300]
            w = view('state,mergeCommit,autoMergeRequest,headRefOid,mergeStateStatus')
            out.update(merge_state=w.get('mergeStateStatus'), head=w.get('headRefOid'))
            if w.get('state') == 'MERGED':
                out.update(merged=True, blocked=None, merge_sha=(w.get('mergeCommit') or {}).get('oid'))
            elif w.get('autoMergeRequest'):
                out.update(auto_enabled=True, blocked=None)
            elif not out['blocked']:
                out['blocked'] = 'not merged and no auto-merge request (' + str(w.get('mergeStateStatus')) + ')'
            br = v.get('headRefName') or ''
            if out['merged'] and br.startswith('fleet/'):
                q = subprocess.run([gh, 'api', 'repos/' + slug + '/branches/' + br], capture_output=True, timeout=60)
                if q.returncode != 0 and b'404' in q.stderr + q.stdout:
                    out['branch_deleted'] = True
                else:
                    d = subprocess.run([gh, 'api', '-X', 'DELETE', 'repos/' + slug + '/git/refs/heads/' + br], capture_output=True, timeout=60)
                    out['branch_deleted'] = d.returncode == 0
    elif mode == 'update':
        pr, sha = args[3], args[4]
        out.update(updated=False, overlap=[])
        open_at(view('state,headRefOid'), sha)
        run('api', '-X', 'PUT', 'repos/' + slug + '/pulls/' + pr + '/update-branch', '-f', 'expected_head_sha=' + sha)
        new = sha
        for _ in range(24):
            new = view('headRefOid').get('headRefOid')
            if new != sha:
                break
            time.sleep(5)
        out['head'] = new
        if new == sha:
            raise Fail('the head did not move after update-branch')
        out['updated'] = True
        cmp = json.loads(run('api', 'repos/' + slug + '/compare/' + sha + '...' + new))
        moved = set(f.get('filename') for f in cmp.get('files') or [])
        mine = set(f.get('path') for f in view('files').get('files') or [])
        out['overlap'] = sorted(x for x in moved & mine if isinstance(x, str))
    elif mode == 'rerun':
        out['rerun'] = []
        for i in json.loads(args[3]):
            run('run', 'rerun', i, '--failed', '-R', slug)
            out['rerun'].append(i)
    else:
        repo, wt, br = args[1], args[2], args[3]
        out.update(removed=False, deleted=False)
        lst = run('-C', repo, 'worktree', 'list', '--porcelain', cmd='git')
        hit = [b for b in lst.split('\n\n') if ('worktree ' + wt) in b.split('\n')]
        if not hit or ('branch refs/heads/' + br) not in hit[0].split('\n'):
            raise Fail('no worktree ' + wt + ' on ' + br)
        run('-C', repo, 'worktree', 'remove', '--force', wt, cmd='git')
        out['removed'] = True
        run('-C', repo, 'branch', '-D', br, cmd='git')
        out['deleted'] = True
except (Fail, ValueError, OSError, AttributeError, TypeError, subprocess.SubprocessError) as e:
    out['error'] = str(e)[:600] or mode + ' failed'
out['args'] = args
out['program'] = _PROG
out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
print(json.dumps(out, ensure_ascii=False))
