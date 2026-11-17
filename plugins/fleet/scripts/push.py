
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
# fleet 7.4.0 (#9, L2008): the push and the push-access probe, in one program
#   push <main_worktree> <branch> <approved_sha> <default_branch> <hook_env_json> <gh|gh-personal|-> <owner/repo|-> <deadline_s> <sealed_url> <parent|-> <tree|->
#     Checks the branch, HEAD and a clean worktree (any mismatch: non-zero exit,
#     nothing pushed); with <parent> and <tree> (a re-plan built on an open PR)
#     also approved^ == parent, approved^{tree} == tree and origin's head at the
#     sealed URL == parent; refuses repo config that rewrites, redirects or
#     re-routes a push (any non-global url.*, http.*, credential.*, ssh.*,
#     core.sshCommand, core.gitProxy key; any remote.* key but <name>.url and
#     <name>.fetch; a remote named by the sealed URL). Pushes once to the sealed URL (the URL sealed at plan time,
#     not the repo's origin: 7.4.0 review A-M1) with the explicit refspec
#     refs/heads/<branch>:refs/heads/<branch> (no +, so no config forces it or
#     sends it to another ref); retries a network failure after 5, 15 and 45 s
#     while the deadline leaves room for one more attempt and the head read
#     (READ_RESERVE s; each attempt's timeout leaves that reserve too, review
#     B-M2); classifies git's output; sets the upstream in a separate local
#     call; then reads origin's head of <branch> (gh api, else ls-remote of the
#     sealed URL with no repo) within what is left of the deadline. A pre-push
#     hook gets the sealed URL as both its remote name and URL.
#     Prints {push_result, exit_code, hook_tail, tail, attempts, remote_head,
#     args, program, digest}.
#   probe <main_worktree> <base_ref> <branch>
#     `git push --dry-run --porcelain origin <base_ref>:refs/heads/<branch>`,
#     120 s, no retry. Prints {access, result, exit_code, auth_line, args,
#     program, digest}.
# The target repo's pre-push hooks run on purpose: this is the one fleet git
# call that does not set core.hooksPath=/dev/null, and it never passes
# --no-verify. Network git calls run without this program's caps (lift).
import hashlib, json, os, re, subprocess, sys, time
def lift():
    # 7.4.0 (#34, L2141): a git network call and its credential helper are not bound by this program's caps
    for k in (_r.RLIMIT_AS, _r.RLIMIT_CPU):
        _r.setrlimit(k, (_r.getrlimit(k)[1],) * 2)
args = sys.argv[1:]
SHA = re.compile(r'^[0-9a-f]{40}$')
REF = re.compile(r'^[A-Za-z0-9._/-]+$')
SLUG = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,99}/[A-Za-z0-9._-]{1,100}$')
ENV_KEY = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')
ref_ok = lambda x: bool(REF.match(x)) and not x.startswith('-') and '..' not in x
mode = args[0] if args else None
abs_ok = lambda p: os.path.isabs(p) and p == os.path.normpath(p)
# the sealed origin URL: remote_head.py's form
URL_OK = re.compile(r'^(https://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._~/-]+|git@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+)$')
opt_sha = lambda x: x == '-' or bool(SHA.match(x))
if mode == 'push':
    ok = (len(args) == 12 and abs_ok(args[1]) and ref_ok(args[2]) and SHA.match(args[3]) and ref_ok(args[4])
          and args[6] in ('gh', 'gh-personal', '-') and (args[7] == '-' or SLUG.match(args[7])) and re.match(r'^[0-9]{1,4}$', args[8])
          and URL_OK.match(args[9]) and opt_sha(args[10]) and opt_sha(args[11]) and (args[10] == '-') == (args[11] == '-'))
elif mode == 'probe':
    ok = len(args) == 4 and abs_ok(args[1]) and ref_ok(args[2]) and ref_ok(args[3])
else:
    ok = False
if not ok:
    sys.exit('usage: push.py push <main_worktree> <branch> <approved_sha> <default_branch> <hook_env_json> <gh|gh-personal|-> <owner/repo|-> <deadline_s> <sealed_url> <parent|-> <tree|-> | probe <main_worktree> <base_ref> <branch>')
wt = args[1]
os.chdir('/')
os.environ['GIT_TERMINAL_PROMPT'] = '0'
for k, v in (('GH_PROMPT_DISABLED', '1'), ('NO_COLOR', '1'), ('GH_NO_UPDATE_NOTIFIER', '1')):
    os.environ[k] = v


def local(*a):
    # local reads: capped, no repo hook
    r = subprocess.run(['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', wt] + list(a), capture_output=True, timeout=120)
    if r.returncode != 0:
        sys.exit('git ' + ' '.join(a[:2]) + ': ' + r.stderr.decode('utf-8', 'replace').strip()[-500:])
    return r.stdout.decode('utf-8', 'replace').strip()


# 7.4.0 review A-M1: network git outside the repo's transport config (remote_head.py's HARD,
# without core.hooksPath: the push runs the repo's pre-push hooks on purpose); the user's
# global config stays trusted (ADR-1152)
HARD = ['git', '-c', 'core.fsmonitor=', '-c', 'core.sshCommand=ssh -o BatchMode=yes', '-c', 'core.askPass=',
        '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always',
        '-c', 'push.recurseSubmodules=no', '-c', 'push.followTags=false', '-c', 'push.pushOption=',
        '-c', 'gc.auto=0', '-c', 'maintenance.auto=false']


def tip(url, ref, tmo):
    # origin's head of ref at the sealed URL; no repo, so no repo config is read
    q = subprocess.run(HARD + ['ls-remote', '--upload-pack=git-upload-pack', url, ref], capture_output=True, stdin=subprocess.DEVNULL, timeout=tmo, preexec_fn=lift, cwd='/')
    rows = [x.split('\t') for x in q.stdout.decode('utf-8', 'replace').splitlines() if x.strip()]
    if q.returncode != 0 or len(rows) > 1 or (rows and (len(rows[0]) != 2 or rows[0][1] != ref or not SHA.match(rows[0][0]))):
        return False
    return rows[0][0] if rows else None


def lines_of(b):
    # bounded: git's own lines come last, so the last 1 MiB is read
    return b[-(1 << 20):].decode('utf-8', 'replace').splitlines()


def classify(code, lines):
    # 3.1.0 (1935c), moved from push_classify.py: git's own lines tell a hook's refusal from git's
    own = [x for x in lines if x.startswith(('error:', 'fatal:', ' ! ['))]
    has = lambda p: any(x.startswith(p) for x in own)
    if code == 0:
        return 'ok'
    if has(' ! [rejected]'):
        return 'non_ff'
    if has(' ! [remote rejected]'):
        return 'remote_rejected'
    if has('error: failed to push some refs'):
        # git-lfs runs as a pre-push hook and prints its own transport errors
        lfs = any(re.match(r'(batch (request|response):|LFS: )', x) for x in lines)
        if code != 1 or has(' ! [') or has('fatal:') or has('error: RPC failed') or lfs:
            return 'ambiguous'
        return 'hook_rejected'
    return 'network'


def probe_classify(code, lines):
    # 4.0.0 (1985), moved from push_probe.py
    rej = [m.group(1) for m in (re.match(r'^!\t[^\t]*\t\[rejected\] \((non-fast-forward|fetch first)\)$', x) for x in lines) if m]
    auth = [x for x in lines if re.search(r'(Permission to .* denied|Authentication failed|Could not read from remote repository|Repository not found)', x)]
    if code == 0:
        res = 'ok'
    elif code == 124:
        res = 'timeout'
    elif rej:
        res = 'non_ff' if rej[0] == 'non-fast-forward' else 'fetch_first'
    elif auth:
        res = 'denied'
    elif code == 1 and any(x.startswith('error: failed to push some refs') for x in lines) and not any(x.startswith('fatal:') for x in lines):
        res = 'hook_rejected'
    else:
        res = 'unknown'
    access = 'ok' if res in ('ok', 'non_ff', 'fetch_first', 'hook_rejected') else 'denied' if res == 'denied' else 'unknown'
    return {'access': access, 'result': res, 'exit_code': code, 'auth_line': auth[0][:300] if res == 'denied' else None}


if mode == 'probe':
    try:
        p = subprocess.run(['git', '-C', wt, 'push', '--dry-run', '--porcelain', 'origin', args[2] + ':refs/heads/' + args[3]], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, timeout=120, preexec_fn=lift)
        code, out_b = p.returncode, p.stdout
    except subprocess.TimeoutExpired as e:
        code, out_b = 124, e.stdout or b''
    out = probe_classify(code, lines_of(out_b))
else:
    branch, approved, default = args[2], args[3], args[4]
    try:
        env_add = json.loads(args[5])
    except ValueError:
        env_add = None
    if not isinstance(env_add, dict) or not all(isinstance(k, str) and ENV_KEY.match(k) and isinstance(v, str) for k, v in env_add.items()):
        sys.exit('hook_env must be a JSON object of NAME: string')
    if branch == default:
        sys.exit('the branch is the default branch ' + default)
    if local('symbolic-ref', '--quiet', 'HEAD') != 'refs/heads/' + branch:
        sys.exit('the worktree is not on ' + branch)
    if local('rev-parse', 'HEAD') != approved:
        sys.exit('HEAD is not the approved ' + approved)
    if local('status', '--porcelain'):
        sys.exit('the worktree has uncommitted changes')
    url, parent, tree = args[9], args[10], args[11]
    os.environ['GIT_CONFIG_NOSYSTEM'] = '1'
    cfg = subprocess.run(['git', '-c', 'core.fsmonitor=false', '-C', wt, 'config', '--show-scope', '--includes', '--name-only', '--list'], capture_output=True, timeout=120)
    if cfg.returncode != 0:
        sys.exit('git config --list: ' + cfg.stderr.decode('utf-8', 'replace').strip()[-500:])
    bad = []
    for row in cfg.stdout.decode('utf-8', 'replace').splitlines():
        sc, _, key = row.partition('\t')
        # security follow-up: an allowlist for remote.* (url and fetch of a named remote), and none of
        # the transport keys (http.*, credential.*, ssh.*, core.sshCommand, core.gitProxy) outside the
        # user's global config: the HARD -c values cannot reset a URL-scoped key such as
        # credential.<url>.helper or http.<url>.proxy, so a local one is refused, never overridden
        if sc != 'global' and (re.match(r'(url|http|credential|ssh)\.|core\.(sshcommand|gitproxy)$', key) or (key.startswith('remote.') and (not re.match(r'remote\..*\.(url|fetch)$', key) or key.startswith('remote.' + url + '.')))):
            bad.append(sc + ' ' + key)
    if bad:
        sys.exit('repo config rewrites or redirects the push (never followed): ' + ', '.join(sorted(set(bad)))[:500])
    if parent != '-':
        # A-M2: the rebuilt commit sits on the open PR's head, and origin is still there
        if local('rev-parse', approved + '^') != parent:
            sys.exit('the approved commit\'s parent is not ' + parent)
        if local('rev-parse', approved + '^{tree}') != tree:
            sys.exit('the approved commit\'s tree is not ' + tree)
        try:
            at = tip(url, 'refs/heads/' + branch, 60)
        except (OSError, subprocess.TimeoutExpired):
            at = False
        if at != parent:
            sys.exit('origin/' + branch + ' at the sealed URL is ' + ('unreadable' if at is False else str(at)) + ', not the open PR\'s head ' + parent)
    env = dict(os.environ, **env_add)
    start, deadline = time.monotonic(), int(args[8])
    left = lambda: deadline - (time.monotonic() - start)
    # the head read after a push needs time of its own: no retry starts into it
    READ_RESERVE = 60
    attempts, took, code, lines, res = 0, 0.0, None, [], None
    for wait in (0, 5, 15, 45):
        if attempts:
            if res != 'network' or left() < wait + took + READ_RESERVE:
                break
            time.sleep(wait)
        t0 = time.monotonic()
        attempts += 1
        try:
            # the pre-push hooks run on purpose (no core.hooksPath, no --no-verify)
            # A-M1: the sealed URL and an explicit refspec with no +; B-M2: the head read keeps its reserve
            p = subprocess.run(HARD + ['-C', wt, 'push', '--receive-pack=git-receive-pack', url, 'refs/heads/' + branch + ':refs/heads/' + branch], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, env=env, timeout=max(1, left() - READ_RESERVE), preexec_fn=lift)
            code, lines = p.returncode, lines_of(p.stdout)
        except subprocess.TimeoutExpired as e:
            code, lines = 124, lines_of(e.stdout or b'') + ['fatal: push timed out at the deadline']
        took = time.monotonic() - t0
        res = classify(code, lines)
    head = None
    if res == 'ok':
        # the upstream, set apart from the push (local only, best effort)
        for a in (('config', 'branch.' + branch + '.remote', 'origin'), ('config', 'branch.' + branch + '.merge', 'refs/heads/' + branch), ('update-ref', 'refs/remotes/origin/' + branch, approved)):
            subprocess.run(['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', wt] + list(a), capture_output=True, timeout=120)
        gh, slug = args[6], args[7]
        for wait in (0, 5, 15, 45):
            if wait:
                if left() < wait + 1:
                    break
                time.sleep(wait)
            # bounded by the deadline: the agent's Bash call ends at 600 s
            tmo = max(1, min(60, left()))
            try:
                if gh != '-' and slug != '-':
                    q = subprocess.run([gh, 'api', 'repos/' + slug + '/branches/' + branch, '--jq', '.commit.sha'], capture_output=True, stdin=subprocess.DEVNULL, timeout=tmo, preexec_fn=lift)
                    v = q.stdout.decode('utf-8', 'replace').strip()
                else:
                    # A-M1: the sealed URL with no repo, never the repo's origin or uploadpack
                    v = tip(url, 'refs/heads/' + branch, tmo) or ''
                    q = None
            except (OSError, subprocess.TimeoutExpired):
                continue
            if (q is None or q.returncode == 0) and SHA.match(v):
                head = v
                break
    out = {'push_result': res, 'exit_code': code, 'hook_tail': '\n'.join(lines[-60:]) if res == 'hook_rejected' else '',
           'tail': '' if res == 'ok' else '\n'.join(lines[-60:]), 'attempts': attempts, 'remote_head': head}
out['args'] = args
out['program'] = _PROG
out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
print(json.dumps(out, ensure_ascii=False))
