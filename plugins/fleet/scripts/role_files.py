
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
# fleet 5.0.0 (R1, ledger 1999): the role prompts ship as roles/<role>.md.
# `<roles_dir> <role> <part>` prints one part of one role file's text for the
# relay. Fail closed: the directory must be absolute, its own realpath and no
# symlink, and hold exactly the ROLES files (regular files, nothing else); the
# file must be strict UTF-8 with no control character but newline and tab.
# The text travels as chunks of CHUNK characters, PER_PART chunks per call,
# so one call's stdout stays well under the Bash tool's output cap (30000
# characters); `parts` is the number of calls. The workflow joins the chunks
# of every part and hashes the text itself against its ROLE_SHA256 pin; the
# sha256 printed here is for diagnosis only.
import hashlib, json, os, stat, sys
ROLES = ('fleet-code-judge', 'fleet-coder', 'fleet-intent-judge', 'fleet-pr-opener', 'fleet-test-judge',
         'fleet-test-writer', 'gate-change-nonweakening-sweep', 'plan-audit', 'pr-review', 'scope-and-plan')
CHUNK = 1000
PER_PART = 12
if len(sys.argv) != 4:
    sys.exit('usage: <roles_dir> <role> <part>')
d, role, part_s = sys.argv[1], sys.argv[2], sys.argv[3]
if role not in ROLES:
    sys.exit('unknown role: ' + role)
if not part_s.isdigit() or len(part_s) > 3:
    sys.exit('bad part: ' + part_s)
part = int(part_s)
if not os.path.isabs(d) or os.path.realpath(d) != d or os.path.islink(d) or not os.path.isdir(d):
    sys.exit('roles dir ' + d + ' is not a real directory (absolute, its own realpath, no symlink)')
names = sorted(os.listdir(d))
want = sorted(r + '.md' for r in ROLES)
if names != want:
    extra = [x for x in names if x not in want]
    missing = [x for x in want if x not in names]
    sys.exit('roles dir ' + d + ' does not hold exactly the role files: missing ' + json.dumps(missing) + ', extra ' + json.dumps(extra))
for x in names:
    if not stat.S_ISREG(os.lstat(os.path.join(d, x)).st_mode):
        sys.exit('role file ' + x + ' is not a regular file')
with open(os.path.join(d, role + '.md'), 'rb') as fh:
    raw = fh.read((1 << 20) + 1)
if len(raw) > 1 << 20:
    sys.exit('role file ' + role + '.md is over 1 MiB')
try:
    text = raw.decode('utf-8', 'strict')
except UnicodeDecodeError as e:
    sys.exit('role file ' + role + '.md is not UTF-8: ' + str(e))
if any((ord(c) < 32 and c not in '\n\t') or ord(c) == 127 for c in text):
    sys.exit('role file ' + role + '.md holds a control character')
chunks = [text[i:i + CHUNK] for i in range(0, len(text), CHUNK)]
parts = max(1, (len(chunks) + PER_PART - 1) // PER_PART)
if part >= parts:
    sys.exit('part ' + str(part) + ' out of range (' + str(parts) + ' parts)')
out = {'role': role, 'part': part, 'parts': parts, 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw),
       'chunks': chunks[part * PER_PART:(part + 1) * PER_PART]}
out['program'] = _PROG
out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
print(json.dumps(out, sort_keys=True, ensure_ascii=False))
