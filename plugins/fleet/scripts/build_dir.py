
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
import hashlib, json, os, re, shutil, stat, sys
# fleet 5.0.6 (ledger 2019): the per-role build dirs, outside the worktree.
# Every role that builds or tests in the worktree gets env vars (the workflow's
# BUILD_ENV_ROWS) that point build output and caches at
# <scratch>/build/<nonce>/<key>/..., so the worktree's ignored files do not
# change. The paths are predictable, so the dirs are emptied right before
# their role runs: no role reads output another role (or an earlier run) left
# there, such as a planted pyc under the bytecode prefix. A reset deletes the
# whole build root first (every earlier step has finished; parallel writers
# share one reset), so a run holds one step's build output at a time.
# usage:
#   build_dir.py reset <scratch> <nonce> <key>...  delete <scratch>/build,
#     then create each <scratch>/build/<nonce>/<key> empty; prints
#     {dirs, args}
#   build_dir.py clean <scratch>  delete <scratch>/build; prints
#     {removed, bytes, args} (bytes: the size of the files it held)
# <scratch> is absolute and normalised. A symlink at any component from
# <realpath repo>/.claude (the run's layout <repo>/.claude/worktrees/
# fleet-<key>/scratch; else the scratch dir's parent) down to the build dir
# exits non-zero; nothing is deleted through a link. Any failure exits
# non-zero (the workflow stops; a dir that may hold old output is never used).
NAME = re.compile(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}')
argv = sys.argv[1:]
os.chdir('/')

def fail(msg):
    sys.stderr.write('build_dir: ' + msg + '\n')
    sys.exit(2)

def name_ok(n):
    return NAME.fullmatch(n) is not None and n not in ('.', '..')

def done(out):
    out['program'] = _PROG
    out['digest'] = hashlib.sha256(json.dumps(out, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0)

mode = argv[0] if argv else ''
if mode == 'reset':
    if len(argv) < 4:
        fail('usage: build_dir.py reset <scratch> <nonce> <key>...')
elif mode == 'clean':
    if len(argv) != 2:
        fail('usage: build_dir.py clean <scratch>')
else:
    fail('mode must be reset or clean, got ' + repr(mode))
scratch = argv[1]
if not os.path.isabs(scratch) or os.path.normpath(scratch) != scratch or scratch == '/':
    fail('scratch dir must be an absolute, normalised path: ' + repr(scratch))
names = argv[2:]
bad = [n for n in names if not name_ok(n)]
if bad:
    fail('name refused: ' + repr(bad[0]))
if mode == 'reset' and len(set(names[1:])) != len(names[1:]):
    fail('a key is given twice')

# the anchor, as hasher.py takes it
k = scratch.rfind('/.claude/worktrees/')
root, rest = (scratch[:k], scratch[k + 1:]) if k >= 0 else (os.path.dirname(scratch), os.path.basename(scratch))
ROOT = os.path.realpath(root or '/')
REST = rest.split('/')

def no_link(parts):
    cur = ROOT
    for part in parts:
        cur = os.path.join(cur, part)
        if os.path.islink(cur):
            fail('symlinked path component: ' + cur)
    return cur

def remove(path):
    # path is lstat'ed: a link or a file is unlinked, a dir removed with
    # shutil.rmtree (which never follows a link inside it); returns bytes freed
    st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode):
        os.unlink(path)
        return st.st_size
    size = 0
    for d, dirs, files in os.walk(path):
        for f in files + [x for x in dirs if os.path.islink(os.path.join(d, x))]:
            try:
                size += os.lstat(os.path.join(d, f)).st_size
            except OSError:
                pass
    shutil.rmtree(path)
    return size

def mkdir(parts):
    # each component made 0700 when missing, and checked: a dir, not a link
    for i in range(len(parts)):
        cur = no_link(parts[:i + 1])
        if not os.path.lexists(cur):
            os.mkdir(cur, 0o700)
        if os.path.islink(cur) or not os.path.isdir(cur):
            fail('not a directory: ' + cur)

try:
    if mode == 'reset':
        nonce, keys = names[0], names[1:]
        root = no_link(REST + ['build'])
        if os.path.lexists(root):
            remove(root)
        mkdir(REST + ['build', nonce])
        dirs = []
        for key in keys:
            parts = REST + ['build', nonce, key]
            real = no_link(parts)
            if os.path.lexists(real):
                remove(real)
            mkdir(parts)
            if os.listdir(real):
                fail('not empty after reset: ' + real)
            dirs.append(os.path.join(scratch, 'build', nonce, key))
        done({'dirs': dirs, 'args': argv})
    real = no_link(REST + ['build'])
    removed, size = False, 0
    if os.path.lexists(real):
        size = remove(real)
        removed = True
    if os.path.lexists(real):
        fail('still present: ' + real)
    done({'removed': removed, 'bytes': size, 'args': argv})
except OSError as e:
    fail(str(e))
