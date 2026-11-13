
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
# fleet 6.0.0 (ledger 2034): one slice of the CI watch on the fleet's own PR.
# Args: <gh_cmd> <owner/repo> <pr> <head_sha> <total_seconds> <state_file>.
# The first call writes its start time to <state_file> (a ci-*.json file in an
# existing dir, one per watched head); every call waits at most SLICE seconds
# with `gh pr checks --watch --required` (all checks when the PR has no
# required check), then reads the checks once. An empty list is no check.
# Each checks read sits between two head reads: both must be <head_sha>.
# state: green (none pending, none failed, at least one check, read at least
# SETTLE_S after the first call and GAP_S after the first read: a check that
# registers late, such as a ready_for_review workflow, has time to appear),
# red (none pending, one failed or cancelled), pending (time left), timeout
# (none left), head_moved (the PR head is not <head_sha>), no_checks (none
# reported after NO_CHECKS_S), error (a read failed). For each failed check:
# its run id when its url is this repo's Actions job of a run of <head_sha>
# (verified); never any log text (pr_state.py logs reads the logs for the
# classifier, so this agent never sees CI output). Prints {state, checks,
# failed, required, head, elapsed_s, error, args, program, digest}.
import hashlib, json, os, re, subprocess, sys, time
def lift():
    # 6.3.2 (2130): gh (a Go binary) is not bound by this program's caps
    for k in (_r.RLIMIT_AS, _r.RLIMIT_CPU):
        _r.setrlimit(k, (_r.getrlimit(k)[1],) * 2)
SLICE, NO_CHECKS_S, MAX_FAILED, CALL_S, SETTLE_S, GAP_S = 480, 180, 6, 540, 90, 60
args = sys.argv[1:]
SLUG = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,99}/[A-Za-z0-9._-]{1,100}$')
if len(args) != 6 or args[0] not in ('gh', 'gh-personal') or not SLUG.match(args[1]) or not re.match(r'^[1-9][0-9]{0,9}$', args[2]) or not re.match(r'^[0-9a-f]{40}$', args[3]) or not re.match(r'^[1-9][0-9]{0,5}$', args[4]):
    sys.exit('usage: ci_watch.py <gh|gh-personal> <owner/repo> <pr> <head_sha> <total_seconds> <state_file>')
gh, slug, pr, sha, total, sf = args[0], args[1], args[2], args[3], int(args[4]), args[5]
if not os.path.isabs(sf) or not re.match(r'^ci-[A-Za-z0-9._-]{1,120}\.json$', os.path.basename(sf)) or not os.path.isdir(os.path.dirname(sf)):
    sys.exit('bad state file: ' + sf)
os.chdir('/')
for k, v in (('GH_PROMPT_DISABLED', '1'), ('NO_COLOR', '1'), ('GH_NO_UPDATE_NOTIFIER', '1')):
    os.environ[k] = v
now = int(time.time())
# one call stays under the 600 s Bash cap: no run read starts within 120 s of CALL_S
call_end = time.time() + CALL_S
try:
    with open(sf) as f:
        st = json.load(f)
    start = int(st['start'])
    first = int(st['first_read']) if st.get('first_read') is not None else None
except (OSError, ValueError, KeyError, TypeError):
    start, first = now, None
    with open(sf, 'w') as f:
        json.dump({'start': start}, f)
out = {'state': None, 'checks': [], 'failed': [], 'required': None, 'head': None, 'elapsed_s': None, 'error': None}


class Fail(Exception):
    pass


def gh_run(a, timeout=120):
    return subprocess.run([gh] + a, capture_output=True, timeout=timeout, preexec_fn=lift)


def head():
    r = gh_run(['pr', 'view', pr, '-R', slug, '--json', 'headRefOid'])
    if r.returncode != 0:
        raise Fail('gh pr view: ' + r.stderr.decode('utf-8', 'replace').strip()[-300:])
    out['head'] = json.loads(r.stdout.decode('utf-8')).get('headRefOid')
    return out['head']


def checks(req):
    # (list, or None when none is reported or the list is empty; required flag)
    r = gh_run(['pr', 'checks', pr, '-R', slug, '--json', 'name,state,bucket,link'] + (['--required'] if req else []))
    err = r.stderr.decode('utf-8', 'replace').strip()
    # a JSON list on stdout is the answer, whatever the exit code (gh exits non-zero on failed checks)
    try:
        lst = json.loads(r.stdout.decode('utf-8'))
        if isinstance(lst, list):
            # an empty required list falls back to all checks; an empty list is no check
            return (lst, req) if lst else checks(False) if req else (None, False)
    except ValueError:
        pass
    if r.returncode not in (0, 8):
        if 'no required checks' in err.lower():
            return checks(False) if req else (None, False)
        if 'no checks reported' in err.lower():
            return None, req
        raise Fail('gh pr checks: ' + err[-300:])
    return checks(False) if req else (None, False)


read_at = None


def read():
    # one checks read between two head reads of <head_sha>; the first read's time is kept
    global first, read_at
    if head() != sha:
        return None, None, False
    cs, req = checks(True)
    read_at = int(time.time())
    if first is None:
        first = read_at
        with open(sf, 'w') as f:
            json.dump({'start': start, 'first_read': first}, f)
    return cs, req, head() == sha


def settled():
    return first is not None and read_at is not None and read_at - start >= SETTLE_S and read_at - first >= GAP_S


bad = lambda cs: any(c.get('bucket') in ('fail', 'cancel') for c in cs)
pend = lambda cs: any(c.get('bucket') == 'pending' for c in cs)
try:
    cs, req, ok = read()
    left = total - (int(time.time()) - start)
    if ok and left > 0 and (cs is None or pend(cs) or not (bad(cs) or settled())):
        if cs is None:
            # none reported yet: wait a minute, then read again
            time.sleep(min(60, left))
        elif pend(cs):
            try:
                gh_run(['pr', 'checks', pr, '-R', slug, '--watch', '--interval', '30'] + (['--required'] if req else []), timeout=min(SLICE, left))
            except subprocess.TimeoutExpired:
                pass
        else:
            # all done, none failed, too early to call green: wait out the settle window
            t = int(time.time())
            time.sleep(max(1, min(left, max(start + SETTLE_S, first + GAP_S) - t + 1)))
        cs, req, ok = read()
    out['required'] = req
    elapsed = int(time.time()) - start
    left = total - elapsed
    if not ok:
        out['state'] = 'head_moved'
    elif cs is None:
        out['state'] = ('no_checks' if elapsed >= NO_CHECKS_S else 'pending') if left > 0 else 'timeout'
    else:
        out['checks'] = [{'name': str(c.get('name')), 'state': str(c.get('state')), 'bucket': str(c.get('bucket')), 'url': c.get('link') or None} for c in cs]
        if any(c['bucket'] == 'pending' for c in out['checks']):
            out['state'] = 'pending' if left > 0 else 'timeout'
        elif any(c['bucket'] in ('fail', 'cancel') for c in out['checks']):
            out['state'] = 'red'
        elif settled():
            out['state'] = 'green'
        else:
            out['state'] = 'pending' if left > 0 else 'timeout'
    if out['state'] == 'red':
        # security review: only this repo's run of the watched head, with that job in it; any other url is report-only
        RUN_URL = re.compile(r'^https://github\.com/' + re.escape(slug) + r'/actions/runs/([0-9]{1,16})/job/([0-9]{1,16})$', re.I)
        for c in [c for c in out['checks'] if c['bucket'] in ('fail', 'cancel')][:MAX_FAILED]:
            m = RUN_URL.match(c['url'] or '')
            ok = False
            if m and time.time() + 120 < call_end:
                try:
                    r = gh_run(['run', 'view', m.group(1), '--repo', slug, '--json', 'headSha,event,headBranch,jobs'], timeout=60)
                    v = json.loads(r.stdout.decode('utf-8')) if r.returncode == 0 else {}
                    ok = v.get('headSha') == sha and any(str(j.get('databaseId')) == m.group(2) for j in v.get('jobs') or [])
                except (subprocess.TimeoutExpired, ValueError, AttributeError, TypeError):
                    ok = False
            out['failed'].append({'name': c['name'], 'url': c['url'], 'run_id': m.group(1) if ok else None, 'verified': ok})
except (Fail, ValueError, OSError, AttributeError, TypeError, subprocess.SubprocessError) as e:
    out['state'] = 'error'
    out['error'] = str(e)[:600] or 'watch failed'
out['elapsed_s'] = int(time.time()) - start
out['args'] = args
out['program'] = _PROG
out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
print(json.dumps(out, ensure_ascii=False))
