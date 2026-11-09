
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
import hashlib, json, os, re, subprocess, sys
wt, branch, url = sys.argv[1], sys.argv[2], sys.argv[3]
os.chdir('/')
URL_OK = re.compile(r'^(https://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._~/-]+|git@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+)$')
if not URL_OK.match(url):
    sys.exit('the sealed origin URL is not an https or git@host: URL')
# network git and every read run outside the repo's own config: a role can
# edit .git/config (sshCommand, uploadpack, insteadOf, helpers), so the URL is
# the one sealed at plan time and the command line overrides the rest; the
# user's global config and environment stay trusted (ADR-1152)
os.environ['GIT_TERMINAL_PROMPT'] = '0'
os.environ['GIT_CONFIG_NOSYSTEM'] = '1'
HARD = ['git', '-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/dev/null', '-c', 'core.sshCommand=ssh -o BatchMode=yes', '-c', 'core.askPass=',
        '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always', '-c', 'fetch.recurseSubmodules=false',
        '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'core.quotePath=false', '-c', 'remote.origin.uploadpack=git-upload-pack']
if not re.match(r'^[A-Za-z0-9._/-]+$', branch) or branch.startswith('-'):
    sys.exit('bad branch name')
# no repo at all: ls-remote needs none, so no repo config is read
r = subprocess.run(HARD + ['ls-remote', '--exit-code', '--upload-pack=git-upload-pack', url, 'refs/heads/' + branch], capture_output=True)
if r.returncode == 2:
    head = None
elif r.returncode == 0:
    lines = [l.split('\t') for l in r.stdout.decode('utf-8', 'replace').splitlines() if l.strip()]
    if len(lines) != 1 or len(lines[0]) != 2 or lines[0][1] != 'refs/heads/' + branch or not re.match(r'^[0-9a-f]{40}$', lines[0][0]):
        sys.exit('unexpected ls-remote output')
    head = lines[0][0]
else:
    sys.exit(r.stderr.decode('utf-8', 'replace') or 'ls-remote failed')
out = {'head': head, 'args': [wt, branch, url]}
out['program'] = _PROG
out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
print(json.dumps(out, ensure_ascii=False))
