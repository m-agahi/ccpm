export const meta = {
  name: "build-task-run",
  description:
    "Role fleet for one task in two modes. plan: intake, plan, audit, commit the plan locally, return for confirmation. build: verify the approved plan, per-criterion test writers, test judge, freeze, coder, code judge, push, draft PR, write-back. Every gate runs in script code.",
  whenToUse:
    "Run by the /build-task skill. args: {mode: \"plan\", input, repo, date, project?} or {mode: \"build\", plan_ref, date, project?}. If invoked with no args, do not call Workflow again: tell the user to run /build-task <task>.",
  phases: [
    { title: "Preflight", detail: "load all seven role prompts from yadgar" },
    { title: "Intake", detail: "resolve the input into a brief (plan mode)" },
    { title: "Workspace", detail: "create or reuse the fleet branch and worktree" },
    { title: "Plan", detail: "scope-and-plan, risk tier, plan-audit, local plan commit (plan mode)" },
    { title: "Verify", detail: "re-hash the approved plan, check the branch (build mode)" },
    { title: "Tests", detail: "one test writer per criterion, test judge, revise rounds" },
    { title: "Freeze", detail: "hash frozen tests and test-runner config" },
    { title: "Code", detail: "coder, hash check, code judge, fix rounds" },
    { title: "Re-plan", detail: "on plan_wrong: re-plan, save the superseded head, return for confirmation" },
    { title: "PR", detail: "push, draft PR from the approved sha" },
    { title: "Write-back", detail: "ledger section and one marked comment per external source" },
  ],
};

// ---------------------------------------------------------------- constants

const ROLE_PROJECT = "m-agahi/yadgar";
const ROLES = [
  "scope-and-plan",
  "plan-audit",
  "fleet-test-writer",
  "fleet-test-judge",
  "fleet-coder",
  "fleet-code-judge",
  "fleet-pr-opener",
];
// Model tiers come from each role page's "DISPATCH: model=<tier> (fallback=<tier>)"
// line, fetched by preflight. No role->model map lives here.
const TIERS = ["fable", "opus", "sonnet", "haiku"];
const DEFAULT_TIER = "sonnet";
const INFRA_MODEL = "sonnet";
const DISPATCH_RE = /DISPATCH:\s*model=([a-z]+)(?:\s*\(fallback=([a-z]+)\))?/;
const HASH_MAPS = ["files", "sections", "git", "symlinks"];
// Minimum role-page versions this script was built against. Names and enums
// are frozen at these versions; a higher version is assumed to change prose
// only and is logged; a lower one (stale or rolled back) stops the run.
const EXPECTED_VERSIONS = {
  "scope-and-plan": 13,
  "plan-audit": 10,
  "fleet-test-writer": 6,
  "fleet-test-judge": 6,
  "fleet-coder": 9,
  "fleet-code-judge": 8,
  "fleet-pr-opener": 5,
};
// Every role page carries "CONTRACT: <marker>" under its DISPATCH line.
const CONTRACT = "fleet-v2";
const CONTRACT_RE = /CONTRACT:\s*(\S+)/;
// Keys each role must return when status is "ok" (checked with `key in obj`;
// null or empty values are allowed). A missing key is contract drift. A
// required key whose role schema types it as array, object or boolean must
// also have that JS type (null only where the schema allows it); a wrong type
// is contract drift too ("contract drift: <role> <key> type").
const REQUIRED_ON_OK = {
  "scope-and-plan": ["plan_path", "criteria", "est_diff_lines", "new_behaviour", "allowed_additions", "held_out_examples", "tldr", "plan_diff"],
  "plan-audit": ["verdict", "routed_findings"],
  "fleet-test-writer": ["criterion_id", "tests", "commit"],
  "fleet-test-judge": ["verdict", "routed_findings", "checked"],
  "fleet-coder": ["commits", "suite_result", "added_symbols", "frozen_tests_red_at_start"],
  "fleet-code-judge": ["verdict", "routed_findings", "suite_result", "hash_check", "gates_not_run"],
  "fleet-pr-opener": ["pr_url", "pr_number", "created", "template_used", "gates_not_run_stated"],
};
const VERDICTS = {
  "plan-audit": ["approve", "untestable_criteria", "plan_defect"],
  "fleet-test-judge": ["approve", "revise"],
  "fleet-code-judge": ["approve", "fix_code", "fix_tests", "plan_wrong"],
};
const GATES_PREFIX = "approved with gates not run:";
const JUDGE_AGENT = "fleet:judge"; // read-only: Write/Edit/NotebookEdit disallowed
const MAX_AGENTS = 60;
const MAX_TEST_ROUNDS = 3; // per test-loop entry (initial, and each fix_tests re-entry)
const MAX_CODE_ROUNDS = 3; // total coder rounds; a fix_tests detour counts as one
const SHORT_PATH_MAX_DIFF = 20; // tier is computed and logged; the short path is disabled

const MODES = ["plan", "build"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const BRANCH_RE = /^fleet\/[a-z0-9][a-z0-9-]*$/;
const REF_PATH_RE = /^\.fleet\/([a-z0-9][a-z0-9-]*)\/plan_ref\.json$/;
const SOURCE_KINDS = ["ledger", "jira", "github", "codeberg", "plan", "text"];
const EXTERNAL_KINDS = ["jira", "github", "codeberg"];
// Sources whose ref names the task, in priority order, for the task id.
const ID_KINDS = ["ledger", "jira", "github", "codeberg"];
// A comment line that starts with one of these words triggers a terraform
// bot on the PR or issue. The script never posts such a comment.
const FORBIDDEN_COMMENT_RE = /^\s*(digger|atlantis)\b/im;
const PROPOSED_RE = /Proposed plan change:\s*(.+?)\s*$/m;
const LEDGER_SECTION = "Fleet build";

// The fleet runs no held-out examples and no mutation/coverage/scanner gates
// yet. Judges get these explicit not_run markers, never an empty list: a judge
// must not read a missing gate as a passing one (fail-closed).
const HELD_OUT_NOT_RUN = { status: "not_run", reason: "fleet v2: held-out execution is not run yet" };
const SCRIPT_FINDINGS_NOT_RUN = { status: "not_run", reason: "fleet v2: mutation/coverage/scan gates are not run yet" };
// The planner may emit these. They must never reach another role.
const HELD_OUT_KEY = "held_out_examples";

// Test-runner config the hasher freezes, in addition to every criterion test
// file. Whole files, matched on basename anywhere in the tree (tracked, or
// untracked and not ignored):
// Found by walking the filesystem (not git ls-files), so a config file that an
// ignore rule hides is still hashed. The walk skips .git, .claude/worktrees and
// the dependency dirs in WALK_SKIP_DIRS, plus each tool cache dir in
// CACHE_SKIP_DIRS that git ignores (by an outside rule or its own '*'
// .gitignore). A skipped cache dir is still scanned: a runner-config file (or a
// pyproject.toml/package.json) inside one goes on the suspicious list.
const RUNNER_CONFIG_FILES = [
  "conftest.py",
  "pytest.ini",
  ".pytest.ini",
  "pytest.toml",
  "tox.ini",
  "setup.cfg",
  "noxfile.py",
  "sitecustomize.py",
  "usercustomize.py",
  "jest.config.*",
  "vitest.config.*",
  "vitest.workspace*",
  "karma.conf.*",
  ".mocharc*",
  ".babelrc*",
  "babel.config.*",
  "*.pth (repo root only)",
];
const WALK_SKIP_DIRS = [".git", "node_modules", ".venv", "venv", ".tox", ".nox"];
// The hasher's descriptive suspicious-list entries (other entries are odd path
// names): runner config in a skipped cache dir, and bytecode (*.pyc/*.pyo)
// named after a frozen test module or conftest, found anywhere the walk or a
// cache scan reaches.
const SUSPICIOUS_PREFIXES = ["runner config in a skipped cache dir: ", "bytecode for a frozen file: "];
const CACHE_SKIP_DIRS = ["__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".import_linter_cache", ".hypothesis"];
// Ignore rules are frozen too: hiding a new config file behind an ignore rule
// changes one of these keys. A .gitignore is hashed in the files map when
// git can read its rules: every one `git ls-files -z --cached --others
// --exclude-standard -- ':(glob)**/.gitignore' .gitignore` lists (tracked, or
// untracked and not ignored), plus every walked one whose directory no
// outside rule ignores (so a .gitignore that ignores itself still counts). A
// .gitignore inside an ignored dir is not hashed: git never reads it, and
// tools rewrite them (.ruff_cache/.gitignore on every commit). Also hashed: the worktree's info/exclude (git rev-parse --git-path
// info/exclude, the common dir for a linked worktree) and the global
// core.excludesFile in the git map.
// The hasher returns four separate maps (files, sections, git, symlinks), so
// a real file name can never mask a synthetic key, plus a suspicious list of
// walked paths with ':' or '#' in a component and runner config found inside a
// skipped cache dir; a non-empty list is a violation.
// Every symlink the walk meets (file or directory, outside the skipped dirs) is
// frozen in the symlinks map as <path> = its readlink target. Links are never followed,
// so adding or retargeting one is a change.
const SYMLINK_RULE = "every symlink outside the skipped dirs -> symlinks[<path>] = readlink target (never followed)";
const IGNORE_RULE_FILES = [
  ".gitignore listed by `git ls-files -z --cached --others --exclude-standard -- ':(glob)**/.gitignore' .gitignore`, plus any walked .gitignore whose directory is not ignored from outside",
  "git:info/exclude",
  "git:core.excludesFile",
];
// Sections of files that are NOT hashed whole (dependencies stay editable).
// Each section is canonicalised (sorted keys, compact JSON) and hashed under a
// synthetic key "<path>#<section>". A section that does not exist hashes as
// "ABSENT", so adding one later is a change.
const RUNNER_CONFIG_SECTIONS = [
  {
    file: "pyproject.toml",
    section: "tool.pytest",
    rule: "the whole [tool.pytest] table, including every [tool.pytest.*] subtable (ini_options: addopts, markers, deselect, ...)",
  },
  { file: "package.json", section: "jest", rule: 'the top-level "jest" key' },
  { file: "package.json", section: "vitest", rule: 'the top-level "vitest" key' },
  { file: "package.json", section: "mocha", rule: 'the top-level "mocha" key' },
  {
    file: "package.json",
    section: "scripts.test",
    rule: 'the "test" entry of the top-level "scripts" object',
  },
];

// The hasher runs this program verbatim. It is deterministic, so two hasher
// runs over the same tree return the same map. The comparison happens in this
// script, never in an agent.
// HASHER_PY_BEGIN
const HASHER_PY = String.raw`
import fnmatch, hashlib, json, os, subprocess, sys
try:
    import tomllib
except ImportError:
    try:
        import tomli as tomllib
    except ImportError:
        tomllib = None

CONFIG_GLOBS = ['conftest.py', 'pytest.ini', '.pytest.ini', 'pytest.toml', 'tox.ini', 'setup.cfg',
                'noxfile.py', 'sitecustomize.py', 'usercustomize.py', 'jest.config.*', 'vitest.config.*',
                'vitest.workspace*', 'karma.conf.*', '.mocharc*', '.babelrc*', 'babel.config.*']
ROOT_ONLY_GLOBS = ['*.pth']
SKIP_DIRS = {'.git', 'node_modules', '.venv', 'venv', '.tox', '.nox'}
# tool cache dirs: skipped only when git ignores them; runner config inside one is suspicious
CACHE_DIRS = {'__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.import_linter_cache', '.hypothesis'}
CACHE_ALARM_NAMES = ['pyproject.toml', 'package.json']
PACKAGE_KEYS = ['jest', 'vitest', 'mocha']

wt, mode = sys.argv[1], sys.argv[2]
explicit = json.loads(sys.argv[3]) if len(sys.argv) > 3 else []
# module names whose bytecode could shadow a frozen file (the purge removes
# all bytecode before every hash check, so any such pyc is planted)
FROZEN_STEMS = set(os.path.basename(f)[:-3] for f in explicit if f.endswith('.py')) | {'conftest'}

def frozen_pyc(name):
    return (name.endswith('.pyc') or name.endswith('.pyo')) and name.split('.')[0] in FROZEN_STEMS

def sha(data):
    return hashlib.sha256(data).hexdigest()

def git(*a):
    return subprocess.run(['git', '-C', wt] + list(a), capture_output=True, check=True).stdout

def canon(obj):
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False, default=str).encode()

def file_hash(rel):
    p = os.path.join(wt, rel)
    if not os.path.isfile(p):
        return 'MISSING'
    with open(p, 'rb') as fh:
        return sha(fh.read())

def abs_hash(path):
    if not path or not os.path.isfile(path):
        return 'MISSING'
    with open(path, 'rb') as fh:
        return sha(fh.read())

LINKS = {}
SUSPICIOUS = []

def odd(rel):
    return ':' in rel or '#' in rel

def check_ignore(paths):
    # the subset of paths git ignores (exit 1 = none ignored)
    if not paths:
        return set()
    r = subprocess.run(['git', '-C', wt, 'check-ignore', '-z', '--stdin'],
                       input=b'\x00'.join(p.encode() for p in paths) + b'\x00', capture_output=True)
    if r.returncode not in (0, 1):
        sys.exit('git check-ignore failed: ' + r.stderr.decode(errors='replace'))
    return set(x.decode() for x in r.stdout.split(b'\x00') if x)

def scan_cache(reldir):
    # an ignored cache dir is not hashed; any runner config inside it is suspicious
    for dp, dns, fns in os.walk(os.path.join(wt, reldir)):
        for f in sorted(fns):
            rel = os.path.normpath(os.path.join(os.path.relpath(dp, wt), f))
            if any(fnmatch.fnmatch(f, g) for g in CONFIG_GLOBS) or f in CACHE_ALARM_NAMES:
                SUSPICIOUS.append('runner config in a skipped cache dir: ' + rel)
            if frozen_pyc(f):
                SUSPICIOUS.append('bytecode for a frozen file: ' + rel)

def walk_from(start, found, deferred):
    # never follows a symlink; every link outside the skipped dirs is recorded with its target
    for dp, dns, fns in os.walk(os.path.join(wt, start) if start else wt):
        reld = os.path.relpath(dp, wt)
        keep = []
        for d in sorted(dns):
            if d in SKIP_DIRS or os.path.join(reld, d) in ('./.claude/worktrees', '.claude/worktrees'):
                continue
            full = os.path.join(dp, d)
            reldir = os.path.normpath(os.path.join(reld, d))
            if odd(reldir):
                SUSPICIOUS.append(reldir + '/')
            if os.path.islink(full):
                LINKS[reldir] = os.readlink(full)
                continue
            if d in CACHE_DIRS:
                deferred.append(reldir)
                continue
            keep.append(d)
        dns[:] = keep
        for f in sorted(fns):
            rel = os.path.normpath(os.path.join(reld, f))
            full = os.path.join(dp, f)
            if os.path.islink(full):
                LINKS[rel] = os.readlink(full)
            if odd(rel):
                SUSPICIOUS.append(rel)
            if frozen_pyc(f):
                SUSPICIOUS.append('bytecode for a frozen file: ' + rel)
            found.append(rel)

def walk():
    # cache-named dirs are walked like any other dir unless git ignores them
    # (by an outside rule or by their own '*' .gitignore); ignored ones are only
    # scanned for runner config
    found, pending = [], []
    walk_from('', found, pending)
    while pending:
        ign = check_ignore(pending + [d + '/' for d in pending])
        nxt = []
        for d in pending:
            if d in ign or d + '/' in ign:
                scan_cache(d)
            else:
                walk_from(d, found, nxt)
        pending = nxt
    return found

def frozen_ignore_files(walked):
    # .gitignore files whose rules can matter: tracked or untracked-not-ignored
    # ones, plus any walked one whose directory no outside rule ignores (a
    # .gitignore that ignores itself still counts; git never reads one inside
    # an ignored dir)
    keep = set(f.decode() for f in git('ls-files', '-z', '--cached', '--others', '--exclude-standard',
                                       '--', ':(glob)**/.gitignore', '.gitignore').split(b'\x00') if f)
    cands = [rel for rel in walked if os.path.basename(rel) == '.gitignore']
    parents = sorted(set(os.path.dirname(rel) for rel in cands if os.path.dirname(rel)))
    ign = check_ignore(parents)
    for rel in cands:
        if os.path.dirname(rel) not in ign:
            keep.add(rel)
    return keep

def norm(rel):
    while rel.startswith('./'):
        rel = rel[2:]
    return rel.rstrip('/')

out = {'fingerprint': {
    'head': git('rev-parse', 'HEAD').decode().strip(),
    'status_sha256': sha(git('status', '--porcelain')),
    'diff_sha256': sha(git('diff', 'HEAD')),
}}

if mode == 'hashes':
    # one map per key kind, so a real file name can never mask a synthetic key
    files, sections, gitmap, symlinks = {}, {}, {}, {}
    walked = walk()
    for rel in walked:
        base = os.path.basename(rel)
        if any(fnmatch.fnmatch(base, g) for g in CONFIG_GLOBS) or odd(rel):
            files[rel] = file_hash(rel)
        elif '/' not in rel and any(fnmatch.fnmatch(base, g) for g in ROOT_ONLY_GLOBS):
            files[rel] = file_hash(rel)
    for rel in frozen_ignore_files(walked):
        files[rel] = file_hash(rel)
    for rel in sorted(LINKS):
        symlinks[rel] = LINKS[rel]
    ex = git('rev-parse', '--git-path', 'info/exclude').decode().strip()
    gitmap['info/exclude'] = abs_hash(ex if os.path.isabs(ex) else os.path.join(wt, ex))
    gx = subprocess.run(['git', '-C', wt, 'config', '--path', 'core.excludesFile'], capture_output=True)
    gpath = gx.stdout.decode().strip()
    if not gpath:
        gpath = os.path.join(os.environ.get('XDG_CONFIG_HOME') or os.path.expanduser('~/.config'), 'git', 'ignore')
    gitmap['core.excludesFile'] = abs_hash(gpath)
    listed = git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split(b'\x00')
    for rel in sorted(set(f.decode() for f in listed if f)):
        base = os.path.basename(rel)
        if base == 'pyproject.toml':
            if tomllib is None:
                sys.exit('tomllib unavailable: need python >= 3.11 or tomli')
            try:
                with open(os.path.join(wt, rel), 'rb') as fh:
                    data = tomllib.load(fh)
                sec = data.get('tool', {}).get('pytest')
                sections[rel + '#tool.pytest'] = 'ABSENT' if sec is None else sha(canon(sec))
            except FileNotFoundError:
                sections[rel + '#tool.pytest'] = 'MISSING'
            except Exception:
                sections[rel + '#tool.pytest'] = 'UNPARSEABLE'
        elif base == 'package.json':
            try:
                with open(os.path.join(wt, rel), 'rb') as fh:
                    data = json.load(fh)
            except FileNotFoundError:
                data = None
            except Exception:
                data = 'UNPARSEABLE'
            for k in PACKAGE_KEYS + ['scripts.test']:
                if data is None:
                    v = 'MISSING'
                elif not isinstance(data, dict):
                    v = 'UNPARSEABLE'
                elif k == 'scripts.test':
                    s = data.get('scripts')
                    v = sha(canon(s['test'])) if isinstance(s, dict) and 'test' in s else 'ABSENT'
                else:
                    v = sha(canon(data[k])) if k in data else 'ABSENT'
                sections[rel + '#' + k] = v
    for rel in explicit:
        rel = norm(rel)
        files[rel] = file_hash(rel)
    out['hashes'] = {'files': files, 'sections': sections, 'git': gitmap, 'symlinks': symlinks,
                     'suspicious': sorted(set(SUSPICIOUS))}

print(json.dumps(out, sort_keys=True))
`;
// HASHER_PY_END

// ---------------------------------------------------------------- schemas

const STR = { type: "string" };
const STR_OR_NULL = { type: ["string", "null"] };
const ANY_ARRAY = { type: "array" };
// Array items whose shape the role pages own: a path, a symbol name or a
// finding object. Typed loosely; the array itself is what the gates rely on.
const ANY_ITEM = { type: ["string", "object"] };
const FINDINGS = {
  type: "array",
  items: {
    type: "object",
    properties: { target: STR, criterion: STR_OR_NULL, finding: STR },
    required: ["target", "finding"],
  },
};
const SUITE = { type: "object" };

function roleSchema(extra) {
  return {
    type: "object",
    additionalProperties: true,
    required: ["status", "reason", "role_version", "role_contract"],
    properties: Object.assign(
      {
        status: { type: "string", enum: ["ok", "needs_human", "failed"] },
        reason: STR,
        role_version: { type: ["integer", "null"] },
        role_contract: STR_OR_NULL,
        artefacts: ANY_ARRAY,
        yadgar_findings: ANY_ARRAY,
      },
      extra,
    ),
  };
}

const SCHEMAS = {
  "scope-and-plan": roleSchema({
    plan_path: STR,
    criteria: {
      type: "array",
      items: {
        type: "object",
        properties: { id: STR, text: STR, test_files: { type: "array", items: STR } },
        required: ["id", "text", "test_files"],
      },
    },
    est_diff_lines: { type: "number" },
    new_behaviour: { type: "boolean" },
    tldr: STR,
    plan_diff: { type: "array", items: STR },
    fleet_estimate: {
      type: "object",
      properties: { criteria: { type: "number" }, agents: { type: "number" }, rounds: { type: "number" } },
    },
  }),
  "plan-audit": roleSchema({
    verdict: { type: "string", enum: ["approve", "untestable_criteria", "plan_defect"] },
    routed_findings: FINDINGS,
  }),
  "fleet-test-writer": roleSchema({
    criterion_id: STR,
    tests: { type: "array", items: ANY_ITEM },
    commit: STR_OR_NULL,
    addressed_findings: { type: "array", items: ANY_ITEM },
  }),
  "fleet-test-judge": roleSchema({
    verdict: { type: "string", enum: ["approve", "revise"] },
    routed_findings: FINDINGS,
    checked: { type: "array", items: ANY_ITEM },
  }),
  "fleet-coder": roleSchema({
    commits: { type: "array", items: STR },
    added_symbols: { type: "array", items: ANY_ITEM },
    frozen_tests_red_at_start: { type: "boolean" },
    suite_result: SUITE,
    addressed_findings: { type: "array", items: ANY_ITEM },
  }),
  "fleet-code-judge": roleSchema({
    verdict: { type: "string", enum: ["approve", "fix_code", "fix_tests", "plan_wrong"] },
    routed_findings: FINDINGS,
    hash_check: { type: "object" },
    suite_result: SUITE,
    gates_not_run: {
      type: "array",
      items: { type: "object", properties: { gate: STR, reason: STR }, required: ["gate"] },
    },
  }),
  "fleet-pr-opener": roleSchema({
    pr_url: STR_OR_NULL,
    pr_number: { type: ["integer", "null"] },
    created: { type: "boolean" },
    template_used: STR_OR_NULL,
    gates_not_run_stated: { type: "boolean" },
  }),
};

const PREFLIGHT_SCHEMA = {
  type: "object",
  required: ["reachable", "missing"],
  properties: {
    reachable: { type: "boolean" },
    missing: { type: "array", items: STR },
    versions: { type: "object" },
    dispatch: { type: "object", additionalProperties: { type: ["string", "null"] } },
    contract: { type: "object", additionalProperties: { type: ["string", "null"] } },
    reason: STR,
  },
};
const INFRA_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["status", "reason"],
  properties: {
    status: { type: "string", enum: ["ok", "needs_human", "failed"] },
    reason: STR,
    head: STR,
    default_branch: STR,
    base_ref: STR,
    remote_slug: STR,
    created: { type: "boolean" },
    merged: ANY_ARRAY,
    plan_sha256: STR,
    plan_sha256_head: STR,
    is_ancestor: { type: "boolean" },
    commits_since: {
      type: "array",
      items: { type: "object", properties: { sha: STR, subject: STR }, required: ["sha", "subject"] },
    },
    plan_touched: { type: "array", items: STR },
    remote_head: STR,
    purged: { type: "number" },
    superseded_head: STR,
    ref_sha256: STR,
    ref_content: STR,
    sha256: STR,
    content: STR,
    commits: {
      type: "array",
      items: {
        type: "object",
        properties: { sha: STR, subject: STR, files: { type: "array", items: STR }, ref_content: STR_OR_NULL },
        required: ["sha", "subject"],
      },
    },
    results: {
      type: "array",
      items: {
        type: "object",
        properties: { key: STR, status: STR, has_marker: { type: "boolean" }, reason: STR, url: STR_OR_NULL },
        required: ["key"],
      },
    },
  },
};
const SOURCE_SCHEMA = {
  type: "object",
  required: ["kind", "ref", "body"],
  properties: { kind: { type: "string", enum: SOURCE_KINDS }, ref: STR, url: STR_OR_NULL, body: STR },
};
const INTAKE_SCHEMA = {
  type: "object",
  required: ["status", "reason"],
  properties: {
    status: { type: "string", enum: ["ok", "needs_human", "failed"] },
    reason: STR,
    brief: {
      type: "object",
      required: ["title", "description", "sources", "repo"],
      properties: {
        title: STR,
        description: STR,
        sources: { type: "array", items: SOURCE_SCHEMA },
        repo: STR,
        plan_path: STR_OR_NULL,
      },
    },
  },
};
const FINGERPRINT = {
  type: "object",
  required: ["head", "status_sha256", "diff_sha256"],
  properties: { head: STR, status_sha256: STR, diff_sha256: STR },
};
const HASHER_SCHEMA = {
  type: "object",
  required: ["status", "fingerprint"],
  properties: {
    status: { type: "string", enum: ["ok", "failed"] },
    reason: STR,
    fingerprint: FINGERPRINT,
    hashes: {
      type: "object",
      required: ["files", "sections", "git", "symlinks", "suspicious"],
      properties: {
        files: { type: "object", additionalProperties: STR },
        sections: { type: "object", additionalProperties: STR },
        git: { type: "object", additionalProperties: STR },
        symlinks: { type: "object", additionalProperties: STR },
        suspicious: { type: "array", items: STR },
      },
    },
  },
};

// ---------------------------------------------------------------- pure helpers

function slugify(s, max) {
  return String(s == null ? "" : s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max || 40)
    .replace(/-+$/g, "");
}

// Deep copy without any held_out_examples key, at any depth.
function stripHeldOut(v) {
  if (Array.isArray(v)) return v.map(stripHeldOut);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) if (k !== HELD_OUT_KEY) o[k] = stripHeldOut(v[k]);
    return o;
  }
  return v;
}

// gates_not_run for the PR: the code-judge list when it gave one, else built
// from the inputs this script marked not_run.
function gatesNotRun(judgeList) {
  if (Array.isArray(judgeList) && judgeList.length) return judgeList;
  return [
    { gate: "mutation", reason: SCRIPT_FINDINGS_NOT_RUN.reason },
    { gate: "coverage", reason: SCRIPT_FINDINGS_NOT_RUN.reason },
    { gate: "security_scan", reason: SCRIPT_FINDINGS_NOT_RUN.reason },
    { gate: "held_out", reason: HELD_OUT_NOT_RUN.reason },
  ];
}

// Parse a role page's DISPATCH line. null when missing, unparseable or the
// tier is unknown.
function parseDispatch(line) {
  if (typeof line !== "string") return null;
  const m = DISPATCH_RE.exec(line);
  if (!m || TIERS.indexOf(m[1]) < 0) return null;
  return { model: m[1], fallback: m[2] && TIERS.indexOf(m[2]) >= 0 ? m[2] : null };
}

// Display name of a hash key per map; used in findings and logs only.
function keyName(map, k) {
  if (map === "git") return "git:" + k;
  if (map === "symlinks") return "symlink:" + k;
  return k;
}

function normPath(p) {
  let s = String(p).trim();
  while (s.indexOf("./") === 0) s = s.slice(2);
  return s.replace(/\/+$/, "");
}

function findOverlaps(criteria) {
  const owner = {};
  const overlaps = [];
  for (const c of criteria) {
    for (const f of c.test_files) {
      if (owner[f] && owner[f] !== c.id) overlaps.push(f + " (" + owner[f] + ", " + c.id + ")");
      else owner[f] = c.id;
    }
  }
  return overlaps;
}

// Keys whose value differs, compared map by map, including keys only one side
// has. A non-empty suspicious list is always a violation.
function diffHashes(frozen, now) {
  const out = [];
  for (const m of HASH_MAPS) {
    const a = (frozen && frozen[m]) || {};
    const b = (now && now[m]) || {};
    const keys = {};
    for (const k of Object.keys(a)) keys[k] = true;
    for (const k of Object.keys(b)) keys[k] = true;
    for (const k of Object.keys(keys).sort()) {
      const va = k in a ? a[k] : "<new>";
      const vb = k in b ? b[k] : "<removed>";
      if (va !== vb) out.push(keyName(m, k));
    }
  }
  for (const p of (now && now.suspicious) || [])
    out.push(SUSPICIOUS_PREFIXES.some((x) => p.indexOf(x) === 0) ? "suspicious " + p : "suspicious path name " + p);
  return out;
}

// Role view of the non-file maps: one flat map with keys path#section,
// git:<key>, symlink:<rel> (the shape the role prompts read). Files go to
// frozen_tests, so these prefixes cannot collide with a real path here.
function configView(h, testFiles) {
  const o = {};
  const tests = {};
  for (const f of testFiles || []) tests[f] = true;
  for (const k of Object.keys((h && h.files) || {})) if (!tests[k]) o[k] = h.files[k];
  for (const m of ["sections", "git", "symlinks"])
    for (const k of Object.keys((h && h[m]) || {})) o[keyName(m, k)] = h[m][k];
  return o;
}

// For the code judge: {"<map>/<key>": {frozen, current, match}}, plus the
// suspicious list when non-empty. Report only; diffHashes stays authoritative.
function hashRecheck(frozen, now) {
  const out = {};
  for (const m of HASH_MAPS) {
    const a = (frozen && frozen[m]) || {};
    const b = (now && now[m]) || {};
    const keys = {};
    for (const k of Object.keys(a)) keys[k] = true;
    for (const k of Object.keys(b)) keys[k] = true;
    for (const k of Object.keys(keys).sort()) {
      const fa = k in a ? a[k] : null;
      const cb = k in b ? b[k] : null;
      out[m + "/" + k] = { frozen: fa, current: cb, match: fa !== null && cb !== null && fa === cb };
    }
  }
  if (now && now.suspicious && now.suspicious.length) out.suspicious = now.suspicious.slice();
  return out;
}

// Criterion test files only, for the roles' frozen_tests.
function testFilesView(h, testFiles) {
  const o = {};
  for (const f of testFiles || []) if (h && h.files && f in h.files) o[f] = h.files[f];
  return o;
}

function contractOf(line) {
  if (typeof line !== "string") return null;
  const m = CONTRACT_RE.exec(line);
  return m ? m[1] : null;
}

function countKeys(h) {
  let n = 0;
  for (const m of HASH_MAPS) n += Object.keys((h && h[m]) || {}).length;
  return n;
}

function sameFingerprint(a, b) {
  return (
    !!a &&
    !!b &&
    a.head === b.head &&
    a.status_sha256 === b.status_sha256 &&
    a.diff_sha256 === b.diff_sha256
  );
}

function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function settingsFor(worktree) {
  // a "//" prefix makes the path absolute in Claude Code permission rules
  return JSON.stringify({
    permissions: { allow: ["Edit(/" + worktree + "/**)", "Write(/" + worktree + "/**)"] },
  });
}

// Canonical JSON: object keys sorted at every depth, undefined values dropped.
function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object")
    return (
      "{" +
      Object.keys(v)
        .sort()
        .filter((k) => v[k] !== undefined)
        .map((k) => JSON.stringify(k) + ":" + canonical(v[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(v === undefined ? null : v);
}

// SHA-256 in plain JS (workflow scripts have no crypto module). Used for the
// plan_ref seal only; file hashes are computed by infra agents.
const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function utf8Bytes(str) {
  const out = [];
  for (const ch of String(str)) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

function rotr(x, n) {
  return (x >>> n) | (x << (32 - n));
}

function sha256Hex(str) {
  const bytes = utf8Bytes(str);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  for (const x of [hi, lo]) bytes.push((x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255);
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array(64);
  for (let i = 0; i < bytes.length; i += 64) {
    for (let t = 0; t < 16; t++)
      w[t] = (bytes[i + 4 * t] << 24) | (bytes[i + 4 * t + 1] << 16) | (bytes[i + 4 * t + 2] << 8) | bytes[i + 4 * t + 3];
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], k = h[7];
    for (let t = 0; t < 64; t++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[t] + w[t]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
    h[5] = (h[5] + f) | 0;
    h[6] = (h[6] + g) | 0;
    h[7] = (h[7] + k) | 0;
  }
  return h.map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
}

// The plan_ref travels through the skill (a model) between the plan and the
// build run. The seal detects any change to it in transit.
function sealOf(ref) {
  const o = Object.assign({}, ref);
  delete o.seal;
  return sha256Hex(canonical(o));
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Task id for the branch name and the comment marker: the first ledger, Jira,
// GitHub or Codeberg source names it; else "plan" (an ingested plan) or
// "task" (free text). The slug comes from the brief title.
function namesFor(brief) {
  let taskId = null;
  for (const kind of ID_KINDS) {
    const src = brief.sources.find((x) => x.kind === kind);
    if (!src) continue;
    taskId = kind === "ledger" ? "l" + slugify(String(src.ref).replace(/^l/i, ""), 24) : slugify(src.ref, 24);
    break;
  }
  if (taskId === null) taskId = brief.sources.some((x) => x.kind === "plan") ? "plan" : "task";
  return { taskId, slug: slugify(brief.title) || "task" };
}

// Proposed plan changes from the code judge's plan findings: the text after
// "Proposed plan change:", else the whole finding (logged; never dropped).
function proposedChanges(findings, note) {
  return findings.map((f) => {
    const text = String(f.finding || "");
    const m = PROPOSED_RE.exec(text);
    if (m && m[1]) return m[1];
    note("code-judge plan finding has no 'Proposed plan change:' line; using the full finding: " + text);
    return text;
  });
}

function commentText(kind, taskId, tldr, planLink, prUrl) {
  const body = String(tldr || "").trim() + "\n\nPlan: " + planLink + "\nPR: " + prUrl;
  const marker = "fleet:" + taskId;
  return kind === "jira" ? body + "\n\n" + marker : body + "\n\n<!-- " + marker + " -->";
}

// The plan file's sha256 as git stores it at a commit. Plan mode and build
// mode run this exact program, so the two hashes are comparable.
const PLAN_HASH_PY =
  "import hashlib, subprocess, sys\n" +
  "d = subprocess.run(['git', '-C', sys.argv[1], 'show', sys.argv[2] + ':' + sys.argv[3]], capture_output=True, check=True).stdout\n" +
  "print(hashlib.sha256(d).hexdigest())";

// Prints {sha256, content} of a file as git stores it at a commit. Commit-plan
// (at HEAD) and build-mode load-ref (at plan_commit) run this exact program.
const LOAD_REF_PY =
  "import hashlib, json, subprocess, sys\n" +
  "d = subprocess.run(['git', '-C', sys.argv[1], 'show', sys.argv[2] + ':' + sys.argv[3]], capture_output=True, check=True).stdout\n" +
  "print(json.dumps({'sha256': hashlib.sha256(d).hexdigest(), 'content': d.decode('utf-8')}, ensure_ascii=False))";

function loadRefCmd(worktree, rev, refPath) {
  return "python3 -I -c " + shQuote(LOAD_REF_PY) + " " + shQuote(worktree) + " " + shQuote(rev) + " " + shQuote(refPath);
}

// The full sealed plan ref lives in the plan commit at this path. The caller
// only carries {branch, plan_commit, ref_path, ref_sha256, repo}.
function refPathFor(taskId) {
  return ".fleet/" + taskId + "/plan_ref.json";
}

// The command that writes the ref file: a quoted heredoc, so the bytes are
// exactly content + newline. content is one line of JSON.
function writeRefCmd(worktree, refPath, content) {
  const dir = refPath.slice(0, refPath.lastIndexOf("/"));
  return (
    "mkdir -p " + shQuote(worktree + "/" + dir) + " && cat > " + shQuote(worktree + "/" + refPath) +
    " <<'FLEET_REF_JSON'\n" + content + "\nFLEET_REF_JSON"
  );
}

function planHashCmd(worktree, rev, planPath) {
  return "python3 -I -c " + shQuote(PLAN_HASH_PY) + " " + shQuote(worktree) + " " + shQuote(rev) + " " + shQuote(planPath);
}

// ---------------------------------------------------------------- prompts

// The ONLY prompt text a role gets. The role's instructions live in yadgar.
function rolePrompt(role, inputs) {
  return (
    'Call mcp__yadgar__agent_prompt_get(pattern="' +
    role +
    '", project="' +
    ROLE_PROJECT +
    '") (load it via ToolSearch first) and follow the returned content exactly.\n' +
    "Inputs: " +
    JSON.stringify(inputs) +
    "\n" +
    "Return the role's final JSON object through the StructuredOutput tool; the schema enforces its keys. " +
    "Also set role_version to the `version` field the call returned, and role_contract to the raw `CONTRACT:` line of the loaded content (null when there is none). " +
    'If the role prompt cannot be loaded, return {"status": "failed", "reason": "role ' +
    role +
    ' not loadable"}.'
  );
}

function preflightPrompt(inputs) {
  return (
    "Infra step of the fleet build workflow: check that the yadgar role library is reachable. Read only; do nothing else.\n" +
    "Inputs: " +
    JSON.stringify(inputs) +
    "\n" +
    "Load mcp__yadgar__agent_prompt_get via ToolSearch. Call it once per pattern in `roles`, with project=`role_project`. " +
    "A pattern is missing when the call returns an error such as not_found, or empty content. " +
    "reachable=false when the tool is absent or every call fails with a transport, auth or connection error. " +
    "versions maps each found pattern to its `version`. " +
    "dispatch maps each found pattern to the first line of its `content` that matches `DISPATCH: model=<tier> (fallback=<tier>)` (the fallback part is optional), copied raw; null when no line matches. " +
    "contract maps each found pattern to the first line of its `content` that starts with `CONTRACT:`, copied raw; null when none. " +
    "Return {reachable, missing, versions, dispatch, contract, reason}."
  );
}

function workspacePrompt(inputs) {
  return (
    "Infra step of the fleet build workflow: mechanical git setup only. No code, no commits, no push. Never delete, reset or recreate an existing branch or worktree.\n" +
    "Inputs: " +
    JSON.stringify(inputs) +
    "\n" +
    "Steps (use `git -C`):\n" +
    "1. `git -C <repo> fetch origin --prune`, retry up to 3 times with backoff 5 15 45 (seconds): " +
    RETRY_SHELL("git -C <repo> fetch origin --prune") +
    " Still failing after the 3 retries -> failed with the last error.\n" +
    "2. default_branch = `git -C <repo> symbolic-ref --short refs/remotes/origin/HEAD` without the `origin/` prefix; if that fails, `gh repo view --json defaultBranchRef -q .defaultBranchRef.name` run in <repo>.\n" +
    "3. Keep fleet files out of git status: if `git -C <repo> check-ignore -q .claude/worktrees/probe` fails, append the line `.claude/worktrees/` to `$(git -C <repo> rev-parse --path-format=absolute --git-common-dir)/info/exclude`. Do the same for `.claude/settings.local.json` (probe that path), and for the test caches `__pycache__/`, `.pytest_cache/`, `.coverage`, `.hypothesis/` (a judge's test run must not leave untracked noise). Never edit a tracked .gitignore.\n" +
    "4. Branch state: `gh pr list --head <branch> --state all --json number,state` in <repo>. MERGED or CLOSED -> status needs_human.\n" +
    "5. main_worktree: if it exists and `git -C <main_worktree> branch --show-current` equals <branch>, reuse it (created=false). If the path exists otherwise -> needs_human. If absent: local branch <branch> exists -> `git -C <repo> worktree add <main_worktree> <branch>`; else remote branch exists (`git -C <repo> ls-remote --exit-code --heads origin <branch>`: exit code 0 = exists, exit code 2 = absent; any other exit code is a network/auth error -> retry with the same 5 15 45 backoff, and still erroring after the 3 retries -> failed; never treat an error as absent) -> `git -C <repo> worktree add -b <branch> <main_worktree> origin/<branch>`; else `git -C <repo> worktree add --no-track -b <branch> <main_worktree> origin/<default_branch>` (created=true).\n" +
    "6. If `<main_worktree>/.claude/settings.local.json` is absent, write it with exactly the content of `settings_local_json`. Then `git -C <main_worktree> status --porcelain` must be empty; if not -> needs_human with the listed paths.\n" +
    "7. `mkdir -p <scratch_dir>`.\n" +
    "8. base_ref = `git -C <main_worktree> merge-base HEAD origin/<default_branch>`.\n" +
    "9. remote_slug = <owner>/<name> parsed from `git -C <repo> remote get-url origin`.\n" +
    "Return {status, reason, default_branch, base_ref, remote_slug, created}."
  );
}

function integratePrompt(inputs) {
  return (
    "Infra step of the fleet build workflow: merge the test writers' branches into the main fleet branch. No edits. Never push. Never --no-verify; no Co-Authored-By trailer.\n" +
    "Inputs: " +
    JSON.stringify(inputs) +
    "\n" +
    "1. `git -C <main_worktree> branch --show-current` must equal <branch> and `git -C <main_worktree> status --porcelain` must be empty; else needs_human.\n" +
    "2. For each name in `criterion_branches`, in order: if `git -C <main_worktree> merge-base --is-ancestor <name> HEAD` succeeds, skip it; else `git -C <main_worktree> merge --no-ff --no-edit <name>`. On conflict: `git -C <main_worktree> merge --abort`, then needs_human naming the conflicting files.\n" +
    "3. head = `git -C <main_worktree> rev-parse HEAD`.\n" +
    "Return {status, reason, head, merged}."
  );
}

function syncPrompt(inputs) {
  return (
    "Infra step of the fleet build workflow: bring each criterion test branch up to the main fleet branch (the coder's commits) before a fix_tests re-entry. No edits. Never push. Never --no-verify; no Co-Authored-By trailer.\n" +
    "Inputs: " +
    JSON.stringify(inputs) +
    "\n" +
    "For each entry of `criterion_worktrees`: `git -C <entry.path> branch --show-current` must equal entry.branch and `git -C <entry.path> status --porcelain` must be empty, else needs_human. If `git -C <entry.path> merge-base --is-ancestor <branch> HEAD` succeeds, skip it; else `git -C <entry.path> merge --no-edit <branch>`. On conflict: `git -C <entry.path> merge --abort`, then needs_human naming the files.\n" +
    "Return {status, reason, merged}."
  );
}

function hasherPrompt(inputs) {
  const cmd =
    "python3 -I - " +
    shQuote(inputs.worktree) +
    " " +
    inputs.mode +
    " " +
    shQuote(JSON.stringify(inputs.test_files)) +
    " <<'FLEET_HASHER_PY'\n" +
    HASHER_PY.trim() +
    "\nFLEET_HASHER_PY";
  const rules =
    "runner-config files hashed whole: " +
    RUNNER_CONFIG_FILES.join(", ") +
    ". Symlinks: " +
    SYMLINK_RULE +
    ". Ignore-rule files hashed whole: " +
    IGNORE_RULE_FILES.join(", ") +
    ". Walk skips: " +
    WALK_SKIP_DIRS.join(", ") +
    ", .claude/worktrees, and these cache dirs when git ignores them: " +
    CACHE_SKIP_DIRS.join(", ") +
    " (runner config inside a skipped cache dir is suspicious). Sections hashed under <path>#<section> (whole file NOT hashed): " +
    RUNNER_CONFIG_SECTIONS.map((s) => s.file + "#" + s.section + " = " + s.rule).join("; ") +
    ". Canonical form: json.dumps(sort_keys=True, separators=(',', ':')). Missing section = ABSENT, missing file = MISSING.";
  return (
    "Infra step of the fleet build workflow: HASHER. Read only: do not edit, create, stage or commit anything in the worktree.\n" +
    "Inputs: " +
    JSON.stringify(inputs) +
    "\n" +
    "Run this one Bash command exactly as written, unmodified, in the foreground:\n" +
    cmd +
    "\n" +
    'It prints one JSON object with `fingerprint` and (mode hashes) `hashes` = {files, sections, git, symlinks, suspicious}. Return {status: "ok", fingerprint, hashes} with those values copied exactly. ' +
    'If the command exits non-zero, return {status: "failed", reason: <its stderr>, fingerprint: {head: "", status_sha256: "", diff_sha256: ""}}. Run no other command.\n' +
    "Extraction rules (the program implements them): " +
    rules
  );
}

function preparePrompt(inputs) {
  return (
    "Infra step of the fleet build workflow: create per-criterion test worktrees for the approved plan. No edits, no commits. Never push.\n" +
    "Inputs: " +
    JSON.stringify(inputs) +
    "\n" +
    "1. `git -C <main_worktree> branch --show-current` must equal <branch> and `git -C <main_worktree> status --porcelain` must be empty; else needs_human with the paths.\n" +
    "2. For each entry of `criterion_worktrees`: if entry.path is a worktree on entry.branch, reuse it. Else if local branch entry.branch exists: `git -C <main_worktree> worktree add <entry.path> <entry.branch>`. Else `git -C <main_worktree> worktree add --no-track -b <entry.branch> <entry.path> <branch>`. Path exists on another branch -> needs_human. In each worktree you create, write `<entry.path>/.claude/settings.local.json` with exactly entry.settings_local_json.\n" +
    "3. head = `git -C <main_worktree> rev-parse HEAD`.\n" +
    "Return {status, reason, head}."
  );
}

function intakePrompt(inputs) {
  return (
    "Infra step of the fleet build workflow: INTAKE. Read only. Never write, edit, comment, transition or post anywhere: no file edits, no git writes, no ledger, ticket, issue or PR writes.\n" +
    "Inputs: " +
    JSON.stringify(inputs) +
    "\n" +
    "Resolve `input` into ONE work item and fetch its text. Classify it in this order:\n" +
    "1. Ledger id (`L42`, `42`, `#42`): kind ledger. Load mcp__yadgar__task_get via ToolSearch; call it with project_id=<project> and id=<the number>. If it refuses with external_task_ledger, use mcp__yaadgaar__read_task with number=<the number> instead. No project -> needs_human. ref = the number; body = the title, status and full body. If the task names a plan path that exists in the repo, also set plan_path and add a `plan` source for it.\n" +
    "2. Jira key (`ABC-123`): kind jira. Load the Atlassian MCP tools via ToolSearch: getAccessibleAtlassianResources for the cloudId, then getJiraIssue(issueIdOrKey, responseContentFormat=\"markdown\"). Tools absent -> needs_human. ref = the key; url = the browse URL; body = summary + description.\n" +
    "3. GitHub issue or PR URL (`https://github.com/<o>/<r>/issues/<n>` or `/pull/<n>`): kind github. `gh-personal issue view <url> --json title,body,url` (or `pr view`); use `gh` only when gh-personal is not installed. ref = `<o>/<r>#<n>`.\n" +
    "4. Codeberg issue or PR URL (`https://codeberg.org/<o>/<r>/issues/<n>` or `/pulls/<n>`): kind codeberg. `curl -sf https://codeberg.org/api/v1/repos/<o>/<r>/issues/<n>`. ref = `<o>/<r>#<n>`.\n" +
    "5. A path to an existing `.md` file inside <repo>: kind plan. ref and plan_path = the path relative to <repo>; body = the file text.\n" +
    "6. Anything else: kind text; ref = \"text\"; body = `input` verbatim.\n" +
    "Repo (brief.repo is the ABSOLUTE path of the local checkout to work in):\n" +
    "- text, plan, ledger: <repo>.\n" +
    "- github or codeberg: the item's own repo. If `git -C <repo> remote get-url origin` names it -> <repo>. Else look for exactly one sibling checkout (`dirname <repo>`/*) whose origin names it; none or several -> needs_human.\n" +
    "- jira: the ticket must name exactly one repo (in its text, components or links); none or several -> needs_human listing what you found. Map that repo to a checkout as for github.\n" +
    "Any ambiguity (several matching tickets, an unclear id, several repos, a reference you cannot read) -> status needs_human with the candidates in reason. Do not guess.\n" +
    "brief.title: the item's title; for free text, a short title (at most 8 words) that names the change. brief.description: one paragraph that states the requested change.\n" +
    "Return {status, reason, brief: {title, description, sources: [{kind, ref, url, body}], repo, plan_path}}. plan_path is null when no plan was ingested."
  );
}

function branchScanPrompt(inputs) {
  return (
    "Infra step of the fleet build workflow: list the commits the fleet branch carries. Read only: no edits, no commits, no checkout, no reset, no push.\n" +
    "Inputs: " +
    JSON.stringify(inputs) +
    "\n" +
    "For every line of `git -C <main_worktree> log --format=%H%x09%s origin/<default_branch>..HEAD` (empty when the branch adds nothing):\n" +
    "- files = the lines of `git -C <main_worktree> show --name-only --format= <sha>`;\n" +
    "- ref_content = the `content` this command prints, with <sha> replaced by the commit sha and nothing else changed (null when it exits non-zero):\n" +
    loadRefCmd(inputs.main_worktree, "<sha>", inputs.ref_path) +
    "\n" +
    "Return {status, reason, commits: [{sha, subject, files, ref_content}]}."
  );
}

function stagePlanPrompt(inputs) {
  return (
    "Infra step of the fleet build workflow: stage the plan doc and hash the staged bytes. No other edits, no commit, no push.\n" +
    "Inputs: " +
    JSON.stringify(inputs) +
    "\n" +
    "1. " +
    (inputs.branch
      ? "`git -C <worktree> branch --show-current` must equal <branch>; mismatch -> needs_human."
      : "The worktree must be on a detached HEAD (`git -C <worktree> symbolic-ref -q HEAD` fails); else needs_human.") +
    "\n" +
    "2. `git -C <worktree> status --porcelain`: any dirty path other than <plan_path> and <ref_path> -> needs_human with the paths.\n" +
    "3. `git -C <worktree> add -- <plan_path>`.\n" +
    "4. plan_sha256 = the output of this one command (it hashes the staged copy), run exactly as written:\n" +
    planHashCmd(inputs.worktree, "", inputs.plan_path) +
    "\n" +
    "Return {status, reason, plan_sha256}."
  );
}

function commitPlanPrompt(inputs, refContent) {
  return (
    "Infra step of the fleet build workflow: commit the plan doc and its ref file LOCALLY, in ONE commit. No other edits. Never push. Never --no-verify or any hook bypass; no Co-Authored-By trailer. No ledger, ticket or comment writes.\n" +
    "Inputs: " +
    JSON.stringify(inputs) +
    "\n" +
    "1. " +
    (inputs.branch
      ? "`git -C <worktree> branch --show-current` must equal <branch>; mismatch -> needs_human."
      : "The worktree must be on a detached HEAD (`git -C <worktree> symbolic-ref -q HEAD` fails); else needs_human.") +
    "\n" +
    "2. `git -C <worktree> status --porcelain`: any dirty path other than <plan_path> and <ref_path> -> needs_human with the paths.\n" +
    "3. Write the ref file: run this one command exactly as written, unmodified:\n" +
    writeRefCmd(inputs.worktree, inputs.ref_path, refContent) +
    "\n" +
    "4. `git -C <worktree> add -- <plan_path> <ref_path>` and `git -C <worktree> commit -m " +
    shQuote("plan(" + inputs.task_id + "): " + inputs.slug) +
    "`. If a hook rewrites a file, re-add <plan_path> and <ref_path> and commit once more; any other hook failure: fix the cause and retry once; a second failure -> failed. Never edit the ref file by hand.\n" +
    "5. `git -C <worktree> ls-files --error-unmatch -- <plan_path> <ref_path>` must succeed and `git -C <worktree> status --porcelain` must be empty; else needs_human.\n" +
    "6. head = `git -C <worktree> rev-parse HEAD`.\n" +
    "7. plan_sha256 = the output of this command, run exactly as written:\n" +
    planHashCmd(inputs.worktree, "HEAD", inputs.plan_path) +
    "\n" +
    "8. Run this command exactly as written; it prints {sha256, content}. Copy them unchanged as ref_sha256 and ref_content:\n" +
    loadRefCmd(inputs.worktree, "HEAD", inputs.ref_path) +
    "\n" +
    "Return {status, reason, head, plan_sha256, ref_sha256, ref_content}."
  );
}

function loadRefPrompt(inputs) {
  return (
    "Infra step of the fleet build workflow: LOAD the approved plan ref. Read only: no edits, no commits, no checkout, no reset, no push.\n" +
    "Inputs: " +
    JSON.stringify(inputs) +
    "\n" +
    "Run this one command exactly as written, unmodified:\n" +
    loadRefCmd(inputs.main_worktree, inputs.plan_commit, inputs.ref_path) +
    "\n" +
    'It prints one JSON object {sha256, content}. Return {status: "ok", reason, sha256, content} with both values copied exactly, byte for byte. ' +
    'If the command exits non-zero, return {status: "needs_human", reason: <its stderr>}. Run no other command.'
  );
}

function verifyPlanPrompt(inputs) {
  return (
    "Infra step of the fleet build workflow: VERIFY the approved plan. Read only: no edits, no commits, no checkout, no reset, no push.\n" +
    "Inputs: " +
    JSON.stringify(inputs) +
    "\n" +
    "1. `git -C <main_worktree> branch --show-current` must equal <branch> and `git -C <main_worktree> status --porcelain` must be empty; else needs_human.\n" +
    "2. `git -C <main_worktree> cat-file -e '<plan_commit>^{commit}'` (keep the quotes: zsh globs `^`) must succeed; else needs_human.\n" +
    "3. head = `git -C <main_worktree> rev-parse HEAD`.\n" +
    "4. plan_sha256 = the output of this command, run exactly as written:\n" +
    planHashCmd(inputs.main_worktree, inputs.plan_commit, inputs.plan_path) +
    "\n" +
    "5. plan_sha256_head = the output of this command, run exactly as written:\n" +
    planHashCmd(inputs.main_worktree, "HEAD", inputs.plan_path) +
    "\n" +
    "6. is_ancestor = whether `git -C <main_worktree> merge-base --is-ancestor <plan_commit> HEAD` exits 0.\n" +
    "7. commits_since = every line of `git -C <main_worktree> log --format=%H%x09%s <plan_commit>..HEAD` as {sha, subject} (empty when head equals plan_commit or is_ancestor is false).\n" +
    "8. plan_touched = the lines of `git -C <main_worktree> log --format=%H <plan_commit>..HEAD -- <plan_path> <ref_path>`.\n" +
    "Return {status, reason, head, plan_sha256, plan_sha256_head, is_ancestor, commits_since, plan_touched}."
  );
}

function replanWorktreePrompt(inputs) {
  return (
    "Infra step of the fleet build workflow: create a throwaway worktree for a re-plan. No edits in any other worktree. Never push.\n" +
    "Inputs: " +
    JSON.stringify(inputs) +
    "\n" +
    "1. If <worktree> exists: reuse it only when `git -C <worktree> rev-parse HEAD` equals <plan_commit>, it is on a detached HEAD and `git -C <worktree> status --porcelain` is empty; else needs_human.\n" +
    "2. Else `git -C <main_worktree> worktree add --detach <worktree> <plan_commit>`, then write `<worktree>/.claude/settings.local.json` with exactly `settings_local_json`.\n" +
    "3. head = `git -C <worktree> rev-parse HEAD`.\n" +
    "Return {status, reason, head}."
  );
}

function replanResetPrompt(inputs) {
  return (
    "Infra step of the fleet build workflow: move the fleet branch to the re-approved plan. This is the ONLY step that may reset a branch, and only as written here. Never push, never delete a branch.\n" +
    "Inputs: " +
    JSON.stringify(inputs) +
    "\n" +
    "1. `git -C <main_worktree> branch --show-current` must equal <branch>, `git -C <main_worktree> rev-parse HEAD` must equal <expected_head>, and `git -C <main_worktree> status --porcelain` must be empty; else needs_human.\n" +
    "2. Save the old head: if branch <superseded_branch> exists, it must point at <expected_head> (else needs_human); else `git -C <main_worktree> branch <superseded_branch> <expected_head>`. superseded_head = `git -C <main_worktree> rev-parse <superseded_branch>`.\n" +
    "3. Only after step 2 succeeded: `git -C <main_worktree> reset --hard <new_plan_commit>`.\n" +
    "4. `git -C <main_worktree> worktree remove <replan_worktree>` (it must be clean; never --force).\n" +
    "5. head = `git -C <main_worktree> rev-parse HEAD`.\n" +
    "Return {status, reason, head, superseded_head}."
  );
}

// One inline shell retry loop: the first attempt, then up to 3 retries after
// 5, 15 and 45 seconds. With fatalRe, a matching stderr stops the loop at once.
// The loop prints the last stderr and rc=<0|1>.
function RETRY_SHELL(cmd, fatalRe) {
  const fatal = fatalRe ? " grep -Eq " + shQuote(fatalRe) + ' "$e" && break;' : "";
  return (
    '`e=$(mktemp); rc=1; for d in 0 5 15 45; do sleep $d; if ' +
    cmd +
    ' 2>"$e"; then rc=0; break; fi;' +
    fatal +
    ' done; cat "$e"; echo rc=$rc` (run it as one Bash call with timeout 600000 ms; the waits alone take 65s)'
  );
}

// Deletes every __pycache__ dir, *.pyc/*.pyo file and .pytest_cache dir in the
// worktree (sparing .git, venvs, node_modules and nested fleet worktrees), and
// prints purged=<count>. Bytecode is not hashed, so a planted pyc whose header
// matches a frozen test's mtime and size would run instead of the test.
const PURGE_FIND =
  "find <worktree> \\( -name .git -o -name .venv -o -name venv -o -name .tox -o -name .nox -o -name node_modules -o -path '*/.claude/worktrees' \\) -prune -o " +
  "\\( -type d \\( -name __pycache__ -o -name .pytest_cache \\) -prune -print0 \\) -o \\( -type f \\( -name '*.pyc' -o -name '*.pyo' \\) -print0 \\)";
const PURGE_CMD =
  "n=$(" + PURGE_FIND + " | tr -cd '\\0' | wc -c) && " + PURGE_FIND + " | xargs -0 -r rm -rf -- && echo purged=$n";
// The env every suite run of the frozen tests uses: no bytecode written, no
// pytest cache (so no stale or planted cache is read either).
const TEST_ENV = { PYTHONDONTWRITEBYTECODE: "1", PYTEST_ADDOPTS: "-p no:cacheprovider" };
const TEST_ENV_NOTE =
  "test_env: set these environment variables for every run of the frozen tests and the suite (frozen-test red check included), so no bytecode or pytest cache is written or read. The workflow deletes all bytecode before every hash check and code-judge run.";

function purgePrompt(inputs) {
  return (
    "Infra step of the fleet build workflow: delete Python bytecode and pytest caches. No other change: never touch tracked files, never commit.\n" +
    "Inputs: " +
    JSON.stringify(inputs) +
    "\n" +
    "Run this one Bash command exactly as written (replace <worktree> with the shell-quoted worktree path), in the foreground. It removes every __pycache__ dir, *.pyc and *.pyo file and .pytest_cache dir, and skips .git, .venv, venv, .tox, .nox, node_modules and .claude/worktrees:\n" +
    "PURGE: " +
    PURGE_CMD +
    "\n" +
    "purged = the number after `purged=`. Non-zero exit -> failed with its stderr.\n" +
    "Return {status, reason, purged}."
  );
}

async function purgeBytecode(label, worktree, phaseName) {
  const r = await infra(label, purgePrompt({ worktree }), phaseName);
  if (typeof r.purged !== "number") halt("failed", label + " returned no purged count");
  gate(label + ": purged " + r.purged + " bytecode/cache paths");
  return r;
}

function pushPrompt(inputs) {
  return (
    "Infra step of the fleet build workflow: push the approved fleet branch. No edits, no commits.\n" +
    "Inputs: " +
    JSON.stringify(inputs) +
    "\n" +
    "1. <branch> must differ from <default_branch>; `git -C <main_worktree> branch --show-current` must equal <branch>; `git -C <main_worktree> rev-parse HEAD` must equal <approved_sha>; `git -C <main_worktree> status --porcelain` must be empty. Any mismatch -> needs_human.\n" +
    "2. `git -C <main_worktree> push -u origin <branch>`, retry up to 3 times with backoff 5 15 45 (seconds). Never --force, never --no-verify, never push another ref; never change remotes or credentials. " +
    "Rejected as non-fast-forward (stderr has `non-fast-forward`, `fetch first` or `[rejected]`) -> needs_human at once, no retry. An auth, network or 5xx error -> retry: " +
    RETRY_SHELL("git -C <main_worktree> push -u origin <branch>", "non-fast-forward|fetch first|\\[rejected\\]") +
    " Still failing after the 3 retries -> failed with the last error.\n" +
    "3. remote_head through the GitHub API, not git over the network: <owner>/<name> = <remote_slug>. <gh> = `gh-personal` when `command -v gh-personal` succeeds and `gh-personal api user --jq .login` equals <owner>; else `gh`. " +
    "remote_head = the output of `<gh> api repos/<owner>/<name>/branches/<branch> --jq .commit.sha` (the branch name goes in the path as is, slashes included), retry up to 3 times with backoff 5 15 45 (seconds): " +
    RETRY_SHELL("<gh> api repos/<owner>/<name>/branches/<branch> --jq .commit.sha") +
    " Only when neither gh nor gh-personal is installed: remote_head = the sha `git -C <main_worktree> ls-remote origin refs/heads/<branch>` prints, with the same backoff. remote_head must be the full 40-hex sha.\n" +
    "Return {status, reason, remote_head}."
  );
}

function ledgerWritebackPrompt(inputs) {
  return (
    "Infra step of the fleet build workflow: append ONE section to each ledger task's body. Change nothing else on the task: not its title, status or plan.\n" +
    "Inputs: " +
    JSON.stringify(inputs) +
    "\n" +
    "Load mcp__yadgar__task_get, mcp__yadgar__wiki_read and mcp__yadgar__wiki_append_section via ToolSearch. For each entry of `tasks` (key, ref):\n" +
    "1. task_get(project_id=<project>, id=<ref as an integer>). Refused or absent -> that entry failed with the error.\n" +
    "2. The row must have a body_slug; none -> failed (\"task has no body page\").\n" +
    "3. wiki_read(slug=<body_slug>, project=<project>). If the content already contains <marker> -> skipped.\n" +
    "4. wiki_append_section(slug=<body_slug>, section_heading=<section_heading>, content=<section_text>, position=\"new_section_bottom\", project=<project>). A section_exists error -> skipped. The page is the task body that body_slug names, so this writes the body; do not call task_write.\n" +
    "Return {status: \"ok\", reason, results: [{key, status: written|skipped|failed, reason}]}."
  );
}

function commentsListPrompt(inputs) {
  return (
    "Infra step of the fleet build workflow: LIST existing comments. Read only: never post, edit or delete anything.\n" +
    "Inputs: " +
    JSON.stringify(inputs) +
    "\n" +
    "For each entry of `sources` (key, kind, ref, url), read every comment (all pages) and set has_marker = whether any comment body contains <marker>:\n" +
    "- github: `gh-personal api --paginate repos/<o>/<r>/issues/<n>/comments --jq '.[].body'` (PR conversation comments are issue comments too).\n" +
    "- codeberg: `curl -sf 'https://codeberg.org/api/v1/repos/<o>/<r>/issues/<n>/comments'`.\n" +
    "- jira: load the Atlassian MCP tools via ToolSearch; getJiraIssue(issueIdOrKey=<ref>, fields=[\"comment\"], responseContentFormat=\"markdown\").\n" +
    "A source you cannot read -> that entry gets status failed with the error and no has_marker.\n" +
    "Return {status: \"ok\", reason, results: [{key, status: ok|failed, has_marker, reason}]}."
  );
}

function commentsPostPrompt(inputs) {
  return (
    "Infra step of the fleet build workflow: POST one comment per entry. Post each `text` VERBATIM, byte for byte. Never edit an issue, ticket or PR body, never edit or delete a comment, never post anything else. Never post a comment any line of which starts with `digger` or `atlantis`.\n" +
    "Inputs: " +
    JSON.stringify(inputs) +
    "\n" +
    "For each entry of `posts` (key, kind, ref, url, text):\n" +
    "- github: write text to a temp file outside every worktree, then `gh-personal issue comment <url> --body-file <file>` (for a `/pull/` url: `gh-personal pr comment <url> --body-file <file>`); delete the file.\n" +
    "- codeberg: POST `https://codeberg.org/api/v1/repos/<o>/<r>/issues/<n>/comments` with JSON `{\"body\": text}` and header `Authorization: token $CODEBERG_TOKEN` (the bot identity). No token -> failed.\n" +
    "- jira: load the Atlassian MCP tools via ToolSearch; getAccessibleAtlassianResources for the cloudId, then addCommentToJiraIssue(cloudId, issueIdOrKey=<ref>, commentBody=<text>, contentFormat=\"markdown\"). Never pass commentId.\n" +
    "Tool absent or the post fails -> that entry failed with the error. Do not retry a post that may have landed.\n" +
    "Return {status: \"ok\", reason, results: [{key, status: posted|failed, reason, url}]}."
  );
}

// ---------------------------------------------------------------- run state

class Stop extends Error {
  constructor(status, reason) {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}
function stop(status, reason) {
  throw new Stop(status, reason);
}

const state = {
  mode: null,
  agents: 0,
  gateLog: [],
  findings: [],
  rounds: { tests: 0, code: 0 },
  path: null,
  branch: null,
  pr: null,
  gatesNotRun: null,
  models: {},
  roleVersions: {},
  refreezeLog: [],
};

function gate(msg) {
  state.gateLog.push(msg);
  log(msg);
}

function halt(status, msg) {
  gate(msg);
  stop(status, msg);
}

function reserve(n, what) {
  if (state.agents + n > MAX_AGENTS)
    halt(
      "needs_human",
      "agent cap " + MAX_AGENTS + " reached: " + state.agents + " dispatched, " + n + " more needed for " + what,
    );
}

// Infra agents: always INFRA_MODEL.
async function dispatch(label, prompt, opts) {
  reserve(1, label);
  state.agents++;
  const r = await agent(prompt, Object.assign({}, opts, { label, model: INFRA_MODEL }));
  if (r == null) halt("failed", "agent " + label + " returned no result");
  return r;
}

// Infra agents whose failure must not stop the run (write-back). Returns null
// when the cap is reached or the agent dies.
async function softDispatch(label, prompt, opts) {
  if (state.agents + 1 > MAX_AGENTS) {
    gate("agent cap " + MAX_AGENTS + " reached: " + label + " not run");
    return null;
  }
  state.agents++;
  const r = await agent(prompt, Object.assign({}, opts, { label, model: INFRA_MODEL }));
  if (r == null) gate(label + " returned no result");
  return r;
}

// Role agents: the tier from the role page. The caller has already counted
// the first attempt. A dead agent (null) is retried once on the fallback tier;
// the retry counts toward the agent cap.
async function roleAgent(role, label, prompt, opts) {
  const tier = state.models[role] || { model: DEFAULT_TIER, fallback: null };
  const r = await agent(prompt, Object.assign({}, opts, { label, model: tier.model }));
  if (r != null || !tier.fallback) return r;
  if (state.agents + 1 > MAX_AGENTS) {
    gate("agent cap " + MAX_AGENTS + " reached: no fallback retry for " + label);
    return null;
  }
  state.agents++;
  gate("fallback: " + role + " (" + label + ") died on " + tier.model + "; retrying once on " + tier.fallback);
  return agent(prompt, Object.assign({}, opts, { label: label + ":fallback", model: tier.fallback }));
}

function collect(role, r) {
  if (r && Array.isArray(r.yadgar_findings) && r.yadgar_findings.length)
    state.findings.push({ role, findings: r.yadgar_findings });
}

async function callRole(role, label, inputs, phaseName, agentType) {
  const opts = { schema: SCHEMAS[role], phase: phaseName };
  if (agentType) opts.agentType = agentType;
  reserve(1, label);
  state.agents++;
  const r = await roleAgent(role, label, rolePrompt(role, inputs), opts);
  if (r == null) halt("failed", "agent " + label + " returned no result");
  checkRole(role, r);
  collect(role, r);
  return r;
}

// Contract checks on every role result: the runner loaded the same version
// and contract marker that preflight saw, and an ok result carries every
// required key and a known verdict.
function checkRole(role, r) {
  if (r.role_version !== state.roleVersions[role])
    halt(
      "needs_human",
      "role " + role + " runner loaded version " + r.role_version + " but preflight saw " + state.roleVersions[role] + " (changed mid-run); result discarded",
    );
  const c = contractOf(r.role_contract);
  if (c !== CONTRACT)
    halt("needs_human", "role " + role + " runner loaded contract " + c + " != " + CONTRACT + "; result discarded");
  if (r.status !== "ok") return r;
  for (const k of REQUIRED_ON_OK[role] || []) {
    if (!(k in r)) halt("needs_human", "role " + role + " contract drift: missing " + k);
    if (!typeMatches(SCHEMAS[role] && SCHEMAS[role].properties[k], r[k]))
      halt("needs_human", "contract drift: " + role + " " + k + " type: got " + jsType(r[k]));
  }
  if (VERDICTS[role] && VERDICTS[role].indexOf(r.verdict) < 0)
    halt("needs_human", "contract drift: " + role + " verdict " + r.verdict);
  return r;
}

function jsType(v) {
  return v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
}

// Only array, object and boolean are checked; any other schema type passes.
function typeMatches(prop, v) {
  if (!prop || prop.type === undefined) return true;
  const types = [].concat(prop.type);
  const checked = types.filter((t) => t === "array" || t === "object" || t === "boolean");
  if (!checked.length) return true;
  if (v === null) return types.indexOf("null") >= 0;
  return checked.indexOf(jsType(v)) >= 0 || types.some((t) => checked.indexOf(t) < 0 && t !== "null" && jsType(v) === t);
}

function requireOk(who, r) {
  if (r.status === "ok") return r;
  halt(r.status === "failed" ? "failed" : "needs_human", who + " returned " + r.status + ": " + (r.reason || "no reason"));
}

async function hasher(label, worktree, mode, testFiles, phaseName) {
  const inputs = { worktree, mode, test_files: testFiles };
  const r = await dispatch(label, hasherPrompt(inputs), {
    schema: HASHER_SCHEMA,
    agentType: JUDGE_AGENT,
    phase: phaseName,
  });
  const h = r.hashes;
  const mapsOk =
    !!h && HASH_MAPS.every((m) => h[m] && typeof h[m] === "object") && Array.isArray(h.suspicious);
  if (r.status !== "ok" || !r.fingerprint || !r.fingerprint.head || (mode === "hashes" && !mapsOk))
    halt("failed", "hasher " + label + " failed: " + (r.reason || "incomplete output"));
  return r;
}

async function infra(label, prompt, phaseName, agentType) {
  const opts = { schema: INFRA_SCHEMA, phase: phaseName };
  if (agentType) opts.agentType = agentType;
  const r = await dispatch(label, prompt, opts);
  return requireOk(label, r);
}

// Fingerprint the worktree around a judge run. Any change discards the
// verdict, whatever it was. preFp: a fingerprint already taken right before.
async function judged(role, label, roundTag, inputs, worktree, phaseName, preFp) {
  const before =
    preFp || (await hasher("hasher:fp-pre:" + roundTag, worktree, "fingerprint", [], phaseName)).fingerprint;
  const r = await callRole(role, label, inputs, phaseName, JUDGE_AGENT);
  const after = (await hasher("hasher:fp-post:" + roundTag, worktree, "fingerprint", [], phaseName)).fingerprint;
  if (!sameFingerprint(before, after))
    halt(
      "needs_human",
      "judge mutated worktree: " + role + " (" + label + ") changed HEAD, status or diff; verdict discarded",
    );
  requireOk(role, r);
  return { r, fp: after };
}

function finish(status, reason) {
  return {
    status,
    reason,
    mode: state.mode,
    branch: state.branch,
    pr_url: state.pr ? state.pr.pr_url : null,
    pr_number: state.pr ? state.pr.pr_number : null,
    path: state.path,
    rounds: { tests: state.rounds.tests, code: state.rounds.code },
    agents: state.agents,
    gates_not_run: state.gatesNotRun,
    role_versions: state.roleVersions,
    refreeze_log: state.refreezeLog,
    gate_log: state.gateLog,
    yadgar_findings: state.findings,
  };
}

// ---------------------------------------------------------------- shared steps

function cleanRepo(r) {
  const s = typeof r === "string" ? r.replace(/\/+$/, "") : "";
  return s && s.charAt(0) === "/" ? s : "";
}

function layout(names, repo) {
  return layoutKey(names.taskId + "-" + names.slug, repo);
}

function layoutKey(key, repo) {
  const root = repo + "/.claude/worktrees/fleet-" + key;
  return { key, branch: "fleet/" + key, root, mainWt: root + "/main", scratch: root + "/scratch" };
}

async function preflightStep() {
  phase("Preflight");
  const pre = await dispatch("preflight", preflightPrompt({ roles: ROLES, role_project: ROLE_PROJECT }), {
    schema: PREFLIGHT_SCHEMA,
    agentType: JUDGE_AGENT,
    phase: "Preflight",
  });
  if (!pre.reachable) halt("needs_human", "yadgar unavailable: " + (pre.reason || "role library unreachable"));
  const missing = pre.missing || [];
  if (missing.length) halt("needs_human", "role missing in yadgar: " + missing.join(", "));
  gate("preflight: all " + ROLES.length + " roles loadable");
  const versions = pre.versions || {};
  const contracts = pre.contract || {};
  for (const role of ROLES) {
    const got = versions[role];
    const want = EXPECTED_VERSIONS[role];
    if (typeof got !== "number")
      halt("needs_human", "role " + role + " version missing in preflight (frozen minimum " + want + ")");
    if (got < want) halt("needs_human", "role " + role + " version " + got + " < frozen " + want + " (stale or rolled back)");
    if (got > want) gate("role " + role + " v" + got + " > frozen v" + want + ": prose-only changes assumed");
    state.roleVersions[role] = got;
    const c = contractOf(contracts[role]);
    if (c !== CONTRACT) halt("needs_human", "role " + role + " contract " + c + " != " + CONTRACT);
  }
  const dispatchLines = pre.dispatch || {};
  for (const role of ROLES) {
    const t = parseDispatch(dispatchLines[role]);
    if (t) {
      state.models[role] = t;
      gate("model: " + role + " -> " + t.model + (t.fallback ? " (fallback " + t.fallback + ")" : ""));
    } else {
      state.models[role] = { model: DEFAULT_TIER, fallback: null };
      gate(
        "model: " + role + " has no usable DISPATCH line (" + JSON.stringify(dispatchLines[role] || null) + ") -> " + DEFAULT_TIER,
      );
    }
  }
}

async function workspaceStep(repo, lay) {
  phase("Workspace");
  const ws = await infra(
    "workspace",
    workspacePrompt({
      repo,
      branch: lay.branch,
      main_worktree: lay.mainWt,
      scratch_dir: lay.scratch,
      settings_local_json: settingsFor(lay.mainWt),
    }),
    "Workspace",
  );
  if (!ws.default_branch || !ws.base_ref) halt("failed", "workspace returned no default_branch/base_ref");
  // remote_slug (owner/name of origin) is the GitHub repo for the planner and
  // the PR; project is only the recall scope
  if (!ws.remote_slug) halt("needs_human", "workspace found no origin remote owner/name (remote_slug)");
  if (ws.default_branch === lay.branch) halt("needs_human", "fleet branch equals the default branch " + ws.default_branch);
  gate("workspace: " + (ws.created ? "created " : "reused ") + lay.mainWt + " off " + ws.default_branch + " @ " + ws.base_ref);
  return { defaultBranch: ws.default_branch, baseRef: ws.base_ref, remoteSlug: ws.remote_slug };
}

// Brief from intake, or from a plan_ref: shape checked in code.
function briefProblem(b) {
  if (!b || typeof b !== "object") return "no brief";
  if (typeof b.title !== "string" || !b.title.trim()) return "brief has no title";
  if (!Array.isArray(b.sources) || !b.sources.length) return "brief has no sources";
  for (const src of b.sources) {
    if (!src || SOURCE_KINDS.indexOf(src.kind) < 0) return "brief source kind " + JSON.stringify(src && src.kind) + " is unknown";
    if (typeof src.ref !== "string" || !src.ref) return "brief source has no ref";
  }
  if (!cleanRepo(b.repo)) return "brief.repo must be an absolute path";
  if (b.plan_path != null) {
    if (typeof b.plan_path !== "string" || !normPath(b.plan_path)) return "brief.plan_path is not a path";
    if (b.plan_path.charAt(0) === "/" || normPath(b.plan_path).split("/").indexOf("..") >= 0)
      return "brief.plan_path must be relative to the repo";
  }
  return null;
}

function cleanBrief(b) {
  return {
    title: b.title.trim(),
    description: typeof b.description === "string" ? b.description : "",
    sources: b.sources.map((src) => ({
      kind: src.kind,
      ref: src.ref,
      url: typeof src.url === "string" ? src.url : null,
      body: typeof src.body === "string" ? src.body : "",
    })),
    repo: cleanRepo(b.repo),
    plan_path: b.plan_path ? normPath(b.plan_path) : null,
  };
}

function normCriteria(raw) {
  const seen = {};
  const criteria = raw.map((c) => {
    const id = String((c && c.id) || "");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(id))
      halt("needs_human", "criterion id not usable in a branch name: " + JSON.stringify(id));
    if (seen[id]) halt("needs_human", "duplicate criterion id " + id);
    seen[id] = true;
    return Object.assign(stripHeldOut(c), {
      id,
      text: String(c.text || ""),
      test_files: (c.test_files || []).map(normPath).filter(Boolean),
    });
  });
  const overlaps = findOverlaps(criteria);
  if (overlaps.length) halt("needs_human", "test_files overlap across criteria: " + overlaps.join("; "));
  return criteria;
}

function testableOf(criteria) {
  const testable = criteria.filter((c) => c.test_files.length);
  for (const c of criteria)
    if (!c.test_files.length) gate("criterion " + c.id + " has no test_files ([manual]): no writer");
  if (!testable.length) halt("needs_human", "full path but no testable criteria (all [manual])");
  return testable;
}

// scope-and-plan then plan-audit. ctx: {common, brief, date, baseRef,
// remoteSlug, suffix}. Returns the plan facts; held-out examples stay behind.
async function planAndAudit(ctx) {
  const sfx = ctx.suffix || "";
  const plan = requireOk(
    "scope-and-plan",
    await callRole(
      "scope-and-plan",
      "role:scope-and-plan" + sfx,
      Object.assign({}, ctx.common, {
        brief: ctx.brief,
        date: ctx.date,
        repo: ctx.remoteSlug,
        base_ref: ctx.baseRef,
        mode: "commit=false",
      }),
      "Plan",
    ),
  );
  if (typeof plan.plan_path !== "string" || !normPath(plan.plan_path) || !Array.isArray(plan.criteria))
    halt("failed", "scope-and-plan returned no plan_path/criteria");
  if (!Array.isArray(plan.plan_diff) || !plan.plan_diff.length || !plan.plan_diff.every((x) => typeof x === "string"))
    halt("needs_human", "role scope-and-plan contract drift: plan_diff must be a non-empty array of strings");
  if (typeof plan.tldr !== "string" || !plan.tldr.trim())
    halt("needs_human", "role scope-and-plan contract drift: tldr must be a non-empty string");
  const planPath = normPath(plan.plan_path);
  if (ctx.brief.plan_path && planPath !== ctx.brief.plan_path)
    halt("needs_human", "planner wrote " + planPath + " but the ingested plan is " + ctx.brief.plan_path + " (an existing plan is updated in place)");
  const criteria = normCriteria(plan.criteria);
  const planFacts = {
    allowed_additions: plan.allowed_additions ? stripHeldOut(plan.allowed_additions) : null,
    est_diff_lines: typeof plan.est_diff_lines === "number" ? plan.est_diff_lines : null,
  };
  if (Array.isArray(plan[HELD_OUT_KEY]) || plan.criteria.some((c) => c && c[HELD_OUT_KEY]))
    gate("planner emitted held_out_examples: dropped, never returned or forwarded");
  gate("plan: " + planPath + ", " + criteria.length + " criteria, test files disjoint");

  // risk tier: computed and logged; the short path is disabled because no
  // role prompt supports a coder without frozen criterion tests
  const wouldBeShort =
    typeof plan.est_diff_lines === "number" && plan.est_diff_lines < SHORT_PATH_MAX_DIFF && plan.new_behaviour === false;
  state.path = "full";
  gate(
    "risk tier (short = est_diff_lines < 20 AND new_behaviour false): est_diff_lines=" +
      plan.est_diff_lines +
      ", new_behaviour=" +
      plan.new_behaviour +
      " -> " +
      (wouldBeShort ? "short" : "full") +
      "; short path disabled -> full path",
  );

  const audit = requireOk(
    "plan-audit",
    await callRole(
      "plan-audit",
      "role:plan-audit" + sfx,
      Object.assign({}, ctx.common, planFacts, {
        plan_path: planPath,
        criteria,
        plan_diff: plan.plan_diff.slice(),
        base_ref: ctx.baseRef,
        mode: "writeback=false",
      }),
      "Plan",
    ),
  );
  if (audit.verdict !== "approve") {
    const first = (audit.routed_findings || []).slice(0, 3).map((f) => (f.criterion || "-") + ": " + f.finding);
    halt(
      audit.verdict ? "needs_human" : "failed",
      "plan-audit verdict " + (audit.verdict || "missing") + (first.length ? ": " + first.join("; ") : ""),
    );
  }
  gate("plan-audit: approve");
  const testable = testableOf(criteria);
  const est = plan.fleet_estimate && typeof plan.fleet_estimate === "object" ? plan.fleet_estimate : {};
  if (typeof est.criteria === "number" && est.criteria !== testable.length)
    gate("planner fleet_estimate.criteria " + est.criteria + " != " + testable.length + " testable criteria");
  return {
    planPath,
    criteria,
    testable,
    planFacts,
    planDiff: plan.plan_diff.slice(),
    tldr: plan.tldr.trim(),
    fleetSize: {
      criteria: testable.length,
      est_agents: typeof est.agents === "number" ? est.agents : null,
      est_rounds: typeof est.rounds === "number" ? est.rounds : null,
    },
  };
}

// Stage the plan, seal the full ref with the staged plan hash, then write the
// ref file and commit both in ONE local commit. ctx.after: agents this run
// still dispatches after the ref is sealed (counted into its history).
async function commitPlanAndRef(ctx) {
  const sfx = ctx.suffix || "";
  const refPath = refPathFor(ctx.fields.taskId);
  const base = { worktree: ctx.worktree, branch: ctx.branch, plan_path: ctx.fields.planPath };
  const st = await infra("infra:stage-plan" + sfx, stagePlanPrompt(Object.assign({}, base, { ref_path: refPath })), ctx.phaseName);
  if (typeof st.plan_sha256 !== "string" || !SHA256_RE.test(st.plan_sha256))
    halt("failed", "infra:stage-plan" + sfx + " returned no usable plan_sha256");
  const history = Object.assign({}, ctx.fields.history, { agents: ctx.fields.history.agents + state.agents + ctx.after });
  const full = makePlanRef(Object.assign({}, ctx.fields, { planSha: st.plan_sha256, history }));
  const label = "infra:commit-plan" + sfx;
  const r = await infra(
    label,
    commitPlanPrompt(Object.assign({}, base, { ref_path: refPath, task_id: full.task_id, slug: full.slug }), JSON.stringify(full)),
    ctx.phaseName,
  );
  if (typeof r.head !== "string" || !SHA_RE.test(r.head)) halt("failed", label + " returned no usable head sha: " + JSON.stringify(r.head));
  if (r.plan_sha256 !== st.plan_sha256)
    halt("failed", label + ": the committed plan hashes " + r.plan_sha256 + ", the staged plan " + st.plan_sha256);
  if (typeof r.ref_content !== "string" || typeof r.ref_sha256 !== "string" || sha256Hex(r.ref_content) !== r.ref_sha256)
    halt("failed", label + " returned a ref_content that does not match its ref_sha256");
  let committed = null;
  try {
    committed = JSON.parse(r.ref_content);
  } catch (e) {
    committed = null;
  }
  if (canonical(committed) !== canonical(full)) halt("failed", label + ": the committed ref file differs from the sealed ref");
  gate("plan and ref committed locally at " + r.head + " (" + full.plan_path + " sha256 " + full.plan_sha256 + ", " + refPath + " sha256 " + r.ref_sha256 + "); not pushed");
  return {
    full,
    tiny: { branch: full.branch, plan_commit: r.head, ref_path: refPath, ref_sha256: r.ref_sha256, repo: full.brief.repo },
  };
}

// The full ref, sealed. It has no plan_commit: it is committed in that commit.
function makePlanRef(f) {
  const ref = stripHeldOut({
    branch: f.branch,
    plan_path: f.planPath,
    plan_sha256: f.planSha,
    criteria: f.criteria,
    brief: f.brief,
    task_id: f.taskId,
    slug: f.slug,
    tldr: f.tldr,
    plan_facts: f.planFacts,
    history: f.history,
  });
  ref.seal = sealOf(ref);
  return ref;
}

function awaiting(reason, p, tiny, full, extra) {
  return stripHeldOut(
    Object.assign(finish("awaiting_confirmation", reason), {
      tldr: p.tldr,
      plan_diff: p.planDiff,
      fleet_size: p.fleetSize,
      plan_path: p.planPath,
      plan_ref: tiny,
      cumulative: full.history,
    }, extra || {}),
  );
}

// A plan commit of this task: subject plan(<task id>):, and a non-empty file
// set that is a subset of exactly {plan_path, .fleet/<task id>/plan_ref.json}.
// plan_path comes from the sealed ref file at that same commit. Exact paths
// after normalisation; anything else is a build commit.
function isPlanCommit(c, taskId) {
  if (!c || !new RegExp("^plan\\(" + escapeRe(taskId) + "\\): ").test(String(c.subject || ""))) return false;
  if (!Array.isArray(c.files) || !c.files.length) return false;
  let ref = null;
  try {
    ref = typeof c.ref_content === "string" ? JSON.parse(c.ref_content) : null;
  } catch (e) {
    ref = null;
  }
  if (planRefProblem(ref) || ref.task_id !== taskId) return false;
  const allowed = [normPath(ref.plan_path), refPathFor(taskId)];
  return c.files.every((f) => allowed.indexOf(normPath(String(f))) >= 0);
}

function buildCommitsOf(commits, taskId) {
  return commits.filter((c) => !isPlanCommit(c, taskId));
}

// ---------------------------------------------------------------- plan mode

async function planMode(input, date) {
  const raw = typeof input.input === "string" ? input.input.trim() : "";
  const repo = cleanRepo(input.repo);
  if (!raw) stop("needs_human", "args.input missing: run /build-task <ledger id | Jira key | issue or PR URL | plan path | text>");
  if (!repo) stop("needs_human", "args.repo must be the absolute path of the caller's git toplevel");

  await preflightStep();

  phase("Intake");
  const it = await dispatch("intake", intakePrompt({ input: raw, repo, project: input.project || null }), {
    schema: INTAKE_SCHEMA,
    agentType: JUDGE_AGENT,
    phase: "Intake",
  });
  if (it.status !== "ok") halt(it.status === "failed" ? "failed" : "needs_human", "intake " + it.status + ": " + (it.reason || "no reason"));
  const problem = briefProblem(it.brief);
  if (problem) halt("needs_human", "intake: " + problem);
  const brief = cleanBrief(it.brief);
  const names = namesFor(brief);
  if (!names.taskId) halt("needs_human", "task id derives to an empty slug from " + JSON.stringify(brief.sources[0].ref));
  const lay = layout(names, brief.repo);
  state.branch = lay.branch;
  if (brief.repo !== repo) gate("intake: work repo " + brief.repo + " differs from the caller's " + repo);
  gate(
    "intake: " + brief.sources.map((x) => x.kind + ":" + x.ref).join(", ") + " -> branch " + lay.branch + ", worktree " + lay.mainWt,
  );

  const ws = await workspaceStep(brief.repo, lay);
  const project = input.project || ws.remoteSlug;
  const common = { project, worktree: lay.mainWt, branch: lay.branch, default_branch: ws.defaultBranch, scratch_dir: lay.scratch };

  // never commit a plan on top of code: only earlier plan commits may be there
  const scan = await infra(
    "infra:branch-scan",
    branchScanPrompt({ main_worktree: lay.mainWt, default_branch: ws.defaultBranch, ref_path: refPathFor(names.taskId) }),
    "Workspace",
    JUDGE_AGENT,
  );
  if (!Array.isArray(scan.commits)) halt("failed", "infra:branch-scan returned no commit list");
  const built = buildCommitsOf(scan.commits, names.taskId);
  if (built.length)
    halt(
      "needs_human",
      "branch has build commits; run build, or delete branch " + lay.branch + " (first: " + built[0].sha + " " + JSON.stringify(built[0].subject) + ")",
    );
  if (scan.commits.length) gate("branch-scan: " + scan.commits.length + " earlier plan commit(s); re-planning on top");

  phase("Plan");
  const p = await planAndAudit({ common, brief, date, baseRef: ws.baseRef, remoteSlug: ws.remoteSlug });
  const pc = await commitPlanAndRef({
    worktree: lay.mainWt,
    branch: lay.branch,
    phaseName: "Plan",
    after: 1,
    fields: {
      branch: lay.branch,
      planPath: p.planPath,
      criteria: p.criteria,
      brief,
      taskId: names.taskId,
      slug: names.slug,
      tldr: p.tldr,
      planFacts: p.planFacts,
      history: { runs: 1, replans: 0, agents: 0 },
    },
  });
  return awaiting("plan ready: confirm, then run mode build with plan_ref", p, pc.tiny, pc.full);
}

// ---------------------------------------------------------------- build mode

// The tiny ref the caller carries.
function tinyRefProblem(t) {
  if (!t || typeof t !== "object") return "missing";
  if (typeof t.branch !== "string" || !BRANCH_RE.test(t.branch)) return "branch is not a fleet branch";
  if (typeof t.plan_commit !== "string" || !SHA_RE.test(t.plan_commit)) return "plan_commit is not a commit sha";
  const m = typeof t.ref_path === "string" ? REF_PATH_RE.exec(t.ref_path) : null;
  if (!m) return "ref_path is not .fleet/<task id>/plan_ref.json";
  if (t.branch.indexOf("fleet/" + m[1] + "-") !== 0) return "ref_path does not belong to the branch";
  if (typeof t.ref_sha256 !== "string" || !SHA256_RE.test(t.ref_sha256)) return "ref_sha256 is not a sha256";
  if (!cleanRepo(t.repo)) return "repo must be an absolute path";
  return null;
}

// The full ref loaded from the ref file.
function planRefProblem(r) {
  if (!r || typeof r !== "object") return "missing";
  if (typeof r.seal !== "string" || r.seal !== sealOf(r)) return "seal mismatch (changed after the plan run)";
  for (const k of ["branch", "plan_path", "plan_sha256", "task_id", "slug", "tldr"])
    if (typeof r[k] !== "string" || !r[k]) return k + " missing";
  if (!SHA256_RE.test(r.plan_sha256)) return "plan_sha256 is not a sha256";
  if (!Array.isArray(r.criteria)) return "criteria missing";
  const b = briefProblem(r.brief);
  if (b) return b;
  if (r.branch !== "fleet/" + r.task_id + "-" + r.slug) return "branch does not match task_id and slug";
  if (!r.history || typeof r.history !== "object") return "history missing";
  return null;
}

// A commit after plan_commit that a fleet step of this build makes: a test
// writer commit, a coder commit, the integrate merge of a criterion branch, or
// the sync merge into one. Subject patterns only: git cannot prove authorship.
function isFleetCommit(subject, branch, critPrefix, ids) {
  const idAlt = ids.map(escapeRe).join("|");
  const crit = escapeRe(critPrefix) + "(?:" + idAlt + ")";
  const pats = [
    new RegExp("^Merge branch '" + crit + "'"),
    new RegExp("^Merge branch '" + escapeRe(branch) + "' into " + crit + "$"),
    new RegExp("^test\\((?:" + idAlt + ")\\): "),
    /^(?:feat|fix)(?:\([^)]*\))?!?: /,
  ];
  return pats.some((re) => re.test(subject));
}

async function buildMode(input, date) {
  const tp = tinyRefProblem(input.plan_ref);
  if (tp) stop("needs_human", "args.plan_ref " + tp + ": run /build-task again to re-plan");
  const tiny = input.plan_ref;
  const repo = cleanRepo(tiny.repo);
  const lay = layoutKey(tiny.branch.slice("fleet/".length), repo);
  state.branch = lay.branch;

  await preflightStep();
  const ws = await workspaceStep(repo, lay);

  // load the sealed ref from the plan commit; nothing else is trusted
  phase("Verify");
  const ld = await infra(
    "infra:load-ref",
    loadRefPrompt({ main_worktree: lay.mainWt, plan_commit: tiny.plan_commit, ref_path: tiny.ref_path }),
    "Verify",
    JUDGE_AGENT,
  );
  if (typeof ld.content !== "string" || ld.sha256 !== tiny.ref_sha256 || sha256Hex(ld.content) !== tiny.ref_sha256)
    halt("needs_human", "plan changed since approval: " + tiny.ref_path + " at " + tiny.plan_commit + " does not match ref_sha256 " + tiny.ref_sha256);
  let loaded = null;
  try {
    loaded = JSON.parse(ld.content);
  } catch (e) {
    loaded = null;
  }
  const lp = planRefProblem(loaded);
  if (lp) halt("needs_human", "ref file " + tiny.ref_path + ": " + lp);
  if (loaded.branch !== tiny.branch || cleanRepo(loaded.brief.repo) !== repo || refPathFor(loaded.task_id) !== tiny.ref_path)
    halt("needs_human", "ref file " + tiny.ref_path + " does not match plan_ref (branch, repo or task id)");
  const ref = Object.assign({}, loaded, { plan_commit: tiny.plan_commit, ref_path: tiny.ref_path });
  const brief = cleanBrief(ref.brief);
  const names = { taskId: ref.task_id, slug: ref.slug };
  const history = {
    runs: (ref.history.runs || 0) + 1,
    replans: ref.history.replans || 0,
    agents: ref.history.agents || 0,
  };
  gate("build " + lay.branch + " from plan " + ref.plan_path + " @ " + ref.plan_commit + " (run " + history.runs + ", re-plans so far " + history.replans + "); ref file sha256 matches, seal ok");
  const project = input.project || ws.remoteSlug;
  const defaultBranch = ws.defaultBranch;
  const remoteSlug = ws.remoteSlug;
  const mainWt = lay.mainWt;
  const branch = lay.branch;

  // verify the approved plan
  const sha8 = ref.plan_commit.slice(0, 8);
  const critPrefix = branch + "--p" + sha8 + "-t-";
  const criteria = normCriteria(ref.criteria);
  const v = await infra(
    "infra:verify-plan",
    verifyPlanPrompt({ main_worktree: mainWt, branch, plan_commit: ref.plan_commit, plan_path: ref.plan_path, ref_path: ref.ref_path }),
    "Verify",
    JUDGE_AGENT,
  );
  if (typeof v.head !== "string" || !SHA_RE.test(v.head)) halt("failed", "infra:verify-plan returned no usable head");
  if (v.plan_sha256 !== ref.plan_sha256)
    halt("needs_human", "plan changed since approval: " + ref.plan_path + " at " + ref.plan_commit + " hashes " + v.plan_sha256 + ", approved " + ref.plan_sha256);
  if (v.head !== ref.plan_commit) {
    if (v.is_ancestor !== true)
      halt("needs_human", "plan changed since approval: branch HEAD " + v.head + " does not descend from plan_commit " + ref.plan_commit);
    if (v.plan_sha256_head !== ref.plan_sha256 || (v.plan_touched || []).length)
      halt("needs_human", "plan changed since approval: a commit after " + ref.plan_commit + " changed " + ref.plan_path + " or " + ref.ref_path);
    const ids = criteria.map((c) => c.id);
    for (const c of v.commits_since || [])
      if (!isFleetCommit(String(c.subject || ""), branch, critPrefix, ids))
        halt("needs_human", "plan changed since approval: branch moved by a non-fleet commit " + c.sha + " " + JSON.stringify(c.subject));
    gate("verify: HEAD " + v.head + " descends from plan_commit by " + (v.commits_since || []).length + " fleet commit(s)");
  } else gate("verify: HEAD is plan_commit " + ref.plan_commit + "; plan hash matches");

  const common = { project, worktree: mainWt, branch, default_branch: defaultBranch, scratch_dir: lay.scratch };
  const planCtx = { plan_path: ref.plan_path };
  const planFacts = {
    allowed_additions: ref.plan_facts ? ref.plan_facts.allowed_additions : null,
    est_diff_lines: ref.plan_facts && typeof ref.plan_facts.est_diff_lines === "number" ? ref.plan_facts.est_diff_lines : null,
  };
  state.path = "full";
  const testable = testableOf(criteria);

  const critWt = {};
  for (const c of testable) {
    const p = lay.root + "/p" + sha8 + "-t-" + c.id;
    critWt[c.id] = { criterion: c.id, path: p, branch: critPrefix + c.id, settings_local_json: settingsFor(p) };
  }
  const prep = await infra(
    "infra:prepare",
    preparePrompt({ main_worktree: mainWt, branch, criterion_worktrees: testable.map((c) => critWt[c.id]) }),
    "Tests",
  );
  if (prep.head !== v.head) halt("needs_human", "branch moved between verify (" + v.head + ") and prepare (" + prep.head + ")");
  const planHead = ref.plan_commit;
  gate(testable.length + " test worktrees ready off " + v.head);

  // tests
  function writerCriterion(c) {
    const o = Object.assign({}, c);
    delete o.test_files;
    return o;
  }
  const writerOut = {};
  const coderCommits = [];
  let lastJudgeFp = null;

  // pending: [{criterion, findings}] to (re)write this round.
  // codeFindings: set on a fix_tests re-entry; the judge then runs first.
  async function testLoop(pending, codeFindings) {
    for (let i = 0; i < MAX_TEST_ROUNDS; i++) {
      state.rounds.tests++;
      const n = state.rounds.tests;
      const judgeFirst = !!codeFindings && i === 0;
      const roundOut = [];
      if (!judgeFirst) {
        const reentry = !!codeFindings;
        reserve(pending.length + 4 + (reentry ? 1 : 0), "test round " + n);
        if (reentry)
          // writers on a fix_tests re-entry build on the coder's commits
          await infra(
            "infra:sync:r" + n,
            syncPrompt({
              branch,
              criterion_worktrees: testable.map((c) => ({
                criterion: c.id,
                path: critWt[c.id].path,
                branch: critWt[c.id].branch,
              })),
            }),
            "Tests",
          );
        state.agents += pending.length;
        const results = await parallel(
          pending.map((p) => () => {
            const c = p.criterion;
            const wt = critWt[c.id];
            return roleAgent(
              "fleet-test-writer",
              "role:fleet-test-writer:" + c.id + ":r" + n,
              rolePrompt(
                "fleet-test-writer",
                Object.assign({}, common, planCtx, {
                  criterion: writerCriterion(c),
                  test_files: c.test_files,
                  worktree: wt.path,
                  branch: wt.branch,
                  routed_findings: p.findings,
                },
                codeFindings
                  ? { code_judge_findings: codeFindings.filter((f) => f.criterion === c.id) }
                  : {}),
              ),
              { schema: SCHEMAS["fleet-test-writer"], phase: "Tests" },
            );
          }),
        );
        results.forEach((r, idx) => {
          const cid = pending[idx].criterion.id;
          if (r == null) halt("failed", "test writer " + cid + " r" + n + " returned no result");
          checkRole("fleet-test-writer", r);
          collect("fleet-test-writer", r);
          requireOk("fleet-test-writer " + cid, r);
          writerOut[cid] = stripHeldOut(r);
          roundOut.push(writerOut[cid]);
        });
        gate("test round " + n + ": writers ok: " + pending.map((p) => p.criterion.id).join(", "));
        await infra(
          "infra:integrate:r" + n,
          integratePrompt({
            main_worktree: mainWt,
            branch,
            criterion_branches: testable.map((c) => critWt[c.id].branch),
          }),
          "Tests",
        );
      } else {
        reserve(3, "test round " + n);
      }
      // writer_outputs: this round's writer results; a judge-first re-entry
      // round ran no writer, so it gets the latest result per criterion
      const judgeInputs = Object.assign({}, common, planCtx, planFacts, {
        criteria: testable,
        base_ref: planHead,
        writer_outputs: judgeFirst ? testable.map((c) => writerOut[c.id]).filter(Boolean) : roundOut,
        script_findings: SCRIPT_FINDINGS_NOT_RUN,
      });
      // every round of a fix_tests re-entry carries the code-judge context
      if (codeFindings) {
        judgeInputs.code_judge_findings = codeFindings;
        judgeInputs.code_commits = coderCommits.slice();
      }
      const judgedTests = await judged(
        "fleet-test-judge",
        "role:fleet-test-judge:r" + n,
        "test-judge:r" + n,
        judgeInputs,
        mainWt,
        "Tests",
      );
      const tj = judgedTests.r;
      lastJudgeFp = judgedTests.fp;
      const routed = tj.routed_findings || [];
      const planF = routed.filter((f) => f.target === "plan");
      if (planF.length)
        halt(
          "needs_human",
          "test-judge raised a plan finding: " + planF.map((f) => (f.criterion || "-") + ": " + f.finding).join("; "),
        );
      if (tj.verdict === "approve") {
        gate("test-judge r" + n + ": approve");
        return;
      }
      if (tj.verdict !== "revise") halt("failed", "test-judge returned no verdict");
      const byCrit = {};
      for (const f of routed)
        if (f.target === "tests" && critWt[f.criterion]) (byCrit[f.criterion] = byCrit[f.criterion] || []).push(f);
      pending = testable.filter((c) => byCrit[c.id]).map((c) => ({ criterion: c, findings: byCrit[c.id] }));
      if (!pending.length) halt("needs_human", "test-judge revise r" + n + " routed no finding to a known criterion");
      gate("test-judge r" + n + ": revise -> " + pending.map((p) => p.criterion.id).join(", "));
    }
    halt("needs_human", "test rounds exhausted (" + MAX_TEST_ROUNDS + ") without test-judge approval");
  }

  // freeze
  let freezes = 0;
  let frozen = null;
  let freezeRef = null;
  // the first freeze ref, before any coder commit: a re-freeze after fix_tests
  // moves freeze_ref past earlier coder commits, so judges diff from this one
  let codeBaseRef = null;
  const frozenFiles = [];
  for (const c of testable) for (const f of c.test_files) frozenFiles.push(f);
  // the ref file is frozen too (hashed as a config key, read-only for every role)
  const hashedFiles = frozenFiles.concat([ref.ref_path]);

  // refreeze: {round, criteria} after an approved fix_tests round. Only the
  // test files of those criteria may change; any other key -> needs_human.
  async function freeze(refreeze) {
    freezes++;
    await purgeBytecode("infra:purge-bytecode:freeze-f" + freezes, mainWt, "Freeze");
    const h = await hasher("hasher:freeze:f" + freezes, mainWt, "hashes", hashedFiles, "Freeze");
    if (lastJudgeFp && !sameFingerprint(lastJudgeFp, h.fingerprint))
      halt("needs_human", "worktree changed between test approval and freeze");
    if (h.hashes.suspicious.length)
      halt(
        "needs_human",
        "suspicious paths in the worktree at freeze (':' or '#' in a name, or runner config in a skipped cache dir): " +
          h.hashes.suspicious.join(", "),
      );
    if (refreeze && frozen) {
      const allowed = {};
      for (const c of testable) if (refreeze.criteria.indexOf(c.id) >= 0) for (const f of c.test_files) allowed[f] = true;
      const changed = [];
      for (const m of HASH_MAPS) {
        const a = frozen[m] || {};
        const b = h.hashes[m] || {};
        const keys = {};
        for (const k of Object.keys(a)) keys[k] = true;
        for (const k of Object.keys(b)) keys[k] = true;
        for (const k of Object.keys(keys).sort()) {
          const before = k in a ? a[k] : null;
          const after = k in b ? b[k] : null;
          if (before === after) continue;
          const name = keyName(m, k);
          if (m !== "files" || !allowed[k]) halt("needs_human", "re-freeze touched unrouted path " + name);
          changed.push({ path: name, before, after });
        }
      }
      state.refreezeLog.push({
        round: refreeze.round,
        freeze_ref_before: freezeRef,
        freeze_ref_after: h.fingerprint.head,
        changed,
      });
      gate("re-freeze after fix_tests (code round " + refreeze.round + "): " + changed.length + " frozen test file(s) changed");
    }
    frozen = h.hashes;
    freezeRef = h.fingerprint.head;
    if (!codeBaseRef) codeBaseRef = freezeRef;
    gate("freeze f" + freezes + " at " + freezeRef + ": " + countKeys(frozen) + " hashed keys");
  }

  phase("Tests");
  await testLoop(
    testable.map((c) => ({ criterion: c, findings: [] })),
    null,
  );
  phase("Freeze");
  await freeze();

  // code
  phase("Code");
  const frozenNote =
    "frozen_tests holds the criterion test files only (sha256 of the content). frozen_config_sections is one flat map of everything else that is frozen: whole-file runner config and the .gitignore files git reads (not those inside ignored dirs) keyed by path (sha256), <path>#<section> (sha256 of a canonicalised test-runner config section), git:info/exclude and git:core.excludesFile (sha256 of ignore-rule files outside the worktree), and symlink:<rel> whose values are link targets, not hashes. Special values: ABSENT (the section did not exist at freeze), MISSING (the file did not exist), UNPARSEABLE (the file could not be parsed at freeze). Every key is read-only. The workflow recomputes every map itself after the coder; a path name containing ':' or '#' is rejected. code_base_ref is the commit before the first coder round; diff production changes from it.";
  let coderFindings = [];
  let approvedSha = null;
  let approval = null;
  for (;;) {
    if (state.rounds.code >= MAX_CODE_ROUNDS)
      halt("needs_human", "code rounds exhausted (" + MAX_CODE_ROUNDS + ") without code-judge approval");
    state.rounds.code++;
    const m = state.rounds.code;
    reserve(5, "code round " + m);
    const codeInputs = Object.assign({}, common, planCtx, planFacts, {
      criteria,
      frozen_tests: testFilesView(frozen, frozenFiles),
      frozen_config_sections: configView(frozen, frozenFiles),
      frozen_tests_note: frozenNote,
      freeze_ref: freezeRef,
      code_base_ref: codeBaseRef,
      test_env: TEST_ENV,
      test_env_note: TEST_ENV_NOTE,
    });
    const coder = requireOk(
      "fleet-coder",
      await callRole(
        "fleet-coder",
        "role:fleet-coder:r" + m,
        Object.assign({}, codeInputs, { routed_findings: coderFindings }),
        "Code",
      ),
    );
    for (const s of coder.commits || []) coderCommits.push(s);
    // purge before the check and the judge; the judge's "before" fingerprint
    // is the post-purge hasher fingerprint
    await purgeBytecode("infra:purge-bytecode:code-r" + m, mainWt, "Code");
    const h = await hasher("hasher:post-coder:r" + m, mainWt, "hashes", hashedFiles, "Code");
    const viol = diffHashes(frozen, h.hashes);
    if (viol.length) {
      coderFindings = [
        {
          target: "code",
          criterion: null,
          finding:
            "frozen test or runner-config hash changed: " +
            viol.join(", ") +
            " -- frozen paths are read-only; restore them to " +
            freezeRef +
            " and fix production code instead",
        },
      ];
      gate("code round " + m + ": hash violation on " + viol.join(", ") + " -> coder output rejected");
      continue;
    }
    // the post-coder fingerprint is the judge's "before" fingerprint
    const judgedCode = await judged(
      "fleet-code-judge",
      "role:fleet-code-judge:r" + m,
      "code-judge:r" + m,
      Object.assign({}, codeInputs, {
        coder_output: stripHeldOut(coder),
        hash_recheck: hashRecheck(frozen, h.hashes),
        held_out_results: HELD_OUT_NOT_RUN,
        script_findings: SCRIPT_FINDINGS_NOT_RUN,
      }),
      mainWt,
      "Code",
      h.fingerprint,
    );
    const cj = judgedCode.r;
    const routed = cj.routed_findings || [];
    if (cj.verdict === "approve") {
      approvedSha = judgedCode.fp.head;
      approval = cj;
      state.gatesNotRun = gatesNotRun(cj.gates_not_run);
      if (state.gatesNotRun.length && String(cj.reason || "").indexOf(GATES_PREFIX) !== 0)
        gate("warning: code-judge approve reason does not start with '" + GATES_PREFIX + "' although gates did not run");
      gate("code-judge r" + m + ": approve at " + approvedSha);
      break;
    }
    if (cj.verdict === "plan_wrong")
      return replan({
        ref, brief, names, lay, common, date, history, remoteSlug,
        findings: routed.filter((f) => f.target === "plan"),
        expectedHead: judgedCode.fp.head,
      });
    if (cj.verdict === "fix_code") {
      coderFindings = routed.filter((f) => f.target === "code");
      gate("code-judge r" + m + ": fix_code -> coder (" + coderFindings.length + " findings)");
      continue;
    }
    if (cj.verdict === "fix_tests") {
      const tf = routed.filter((f) => f.target === "tests");
      gate("code-judge r" + m + ": fix_tests -> test-judge (" + tf.length + " findings)");
      phase("Tests");
      await testLoop([], tf);
      phase("Freeze");
      await freeze({
        round: m,
        criteria: tf.map((f) => f.criterion).filter((x, i, a) => x && a.indexOf(x) === i),
      });
      phase("Code");
      // a fix_tests verdict may also carry code findings: keep them
      coderFindings = routed.filter((f) => f.target === "code");
      continue;
    }
    halt("failed", "code-judge returned no verdict");
  }

  // push, then PR
  phase("PR");
  const push = await infra(
    "infra:push",
    pushPrompt({ main_worktree: mainWt, branch, default_branch: defaultBranch, approved_sha: approvedSha, remote_slug: remoteSlug }),
    "PR",
  );
  if (push.remote_head !== approvedSha)
    halt("needs_human", "push: origin/" + branch + " is at " + push.remote_head + ", not the approved " + approvedSha);
  gate("pushed " + branch + " at " + approvedSha);
  const pr = requireOk(
    "fleet-pr-opener",
    await callRole(
      "fleet-pr-opener",
      "role:fleet-pr-opener",
      Object.assign({}, common, planCtx, {
        repo: remoteSlug,
        approved_sha: approvedSha,
        criteria,
        suite_result: approval.suite_result || null,
        gates_not_run: state.gatesNotRun,
      }),
      "PR",
    ),
  );
  state.pr = pr;
  gate("pr-opener: " + (pr.created ? "created " : "updated ") + pr.pr_url);
  if (state.gatesNotRun && state.gatesNotRun.length && pr.gates_not_run_stated !== true)
    halt("needs_human", "pr-opener did not state gates_not_run in the PR body; fix the body of " + pr.pr_url);

  phase("Write-back");
  const wb = await writeBack({
    ref, brief, project: input.project || null, remoteSlug, branch, prUrl: pr.pr_url,
  });
  history.agents += state.agents;
  gate("cumulative: run " + history.runs + ", re-plans " + history.replans + ", agents " + history.agents);
  const out = finish("ok", "draft PR ready for review");
  out.created = pr.created;
  out.template_used = pr.template_used || null;
  out.cumulative = history;
  return Object.assign(out, wb);
}

// plan_wrong: re-plan from the approved plan in a detached worktree, commit
// the new plan there, save the old head, then move the branch to the new plan.
async function replan(ctx) {
  const { ref, brief, names, lay, common, date, history, remoteSlug } = ctx;
  if (!ctx.findings.length) halt("needs_human", "code-judge verdict plan_wrong without a plan finding");
  const proposed = proposedChanges(ctx.findings, gate);
  gate("code-judge verdict plan_wrong: " + proposed.join("; "));
  const n = history.replans + 1;
  const superseded = lay.branch + "--superseded-" + n;
  const replanWt = lay.root + "/replan-" + n;
  // worktree, planner, audit, commit, reset: reserve all before any step
  reserve(5, "re-plan " + n);
  phase("Re-plan");
  const rw = await infra(
    "infra:replan-worktree",
    replanWorktreePrompt({
      main_worktree: lay.mainWt,
      worktree: replanWt,
      plan_commit: ref.plan_commit,
      settings_local_json: settingsFor(replanWt),
    }),
    "Re-plan",
  );
  if (rw.head !== ref.plan_commit) halt("failed", "infra:replan-worktree is at " + rw.head + ", not " + ref.plan_commit);
  const findingsText = ctx.findings.map((f) => (f.criterion ? f.criterion + ": " : "") + f.finding).join("\n");
  const replanBrief = Object.assign({}, brief, {
    plan_path: ref.plan_path,
    sources: brief.sources.concat([{ kind: "text", ref: "code-judge plan findings", url: null, body: findingsText }]),
  });
  const p = await planAndAudit({
    common: Object.assign({}, common, { worktree: replanWt }),
    brief: replanBrief,
    date,
    baseRef: ref.plan_commit,
    remoteSlug,
    suffix: ":replan",
  });
  const pc = await commitPlanAndRef({
    worktree: replanWt,
    branch: null,
    phaseName: "Re-plan",
    suffix: ":replan",
    after: 2,
    fields: {
      branch: lay.branch,
      planPath: p.planPath,
      criteria: p.criteria,
      brief,
      taskId: names.taskId,
      slug: names.slug,
      tldr: p.tldr,
      planFacts: p.planFacts,
      history: { runs: history.runs, replans: n, agents: history.agents },
    },
  });
  const newHead = pc.tiny.plan_commit;
  const rs = await infra(
    "infra:replan-reset",
    replanResetPrompt({
      main_worktree: lay.mainWt,
      branch: lay.branch,
      expected_head: ctx.expectedHead,
      superseded_branch: superseded,
      new_plan_commit: newHead,
      replan_worktree: replanWt,
    }),
    "Re-plan",
  );
  if (rs.head !== newHead) halt("failed", "infra:replan-reset left " + lay.branch + " at " + rs.head + ", not " + newHead);
  gate("re-plan " + n + ": old head " + (rs.superseded_head || ctx.expectedHead) + " saved as " + superseded + "; " + lay.branch + " reset to " + newHead);
  const hist = pc.full.history;
  gate("cumulative: run " + hist.runs + ", re-plans " + hist.replans + ", agents " + hist.agents);
  return awaiting("code-judge plan_wrong: re-planned; confirm the proposed plan change, then run mode build with the new plan_ref", p, pc.tiny, pc.full, {
    proposed_plan_change: proposed,
    plan_findings: ctx.findings,
    superseded_ref: superseded,
    superseded_head: rs.superseded_head || ctx.expectedHead,
  });
}

// ---------------------------------------------------------------- write-back

// Never stops the run: every failure is reported in the result.
async function writeBack(ctx) {
  const { ref, brief, project, remoteSlug, branch, prUrl } = ctx;
  const planLink = "https://github.com/" + remoteSlug + "/blob/" + branch + "/" + ref.plan_path;
  const marker = "fleet:" + ref.task_id;
  const out = { write_back: { ledger: [], comments: [] }, ledger_status: "none", comment_status: "none", comment_text: null };

  // (a) ledger
  const ledger = brief.sources.map((s, i) => Object.assign({ key: "s" + i }, s)).filter((s) => s.kind === "ledger");
  if (ledger.length) {
    const sectionText = "TL;DR: " + ref.tldr + "\n\nPlan: " + ref.plan_path + " (" + planLink + ")\nPR: " + prUrl + "\n\n<!-- " + marker + " -->";
    let results = null;
    let why = null;
    if (!project) why = "args.project missing: no ledger project to write to";
    else {
      const r = await softDispatch(
        "infra:ledger-writeback",
        ledgerWritebackPrompt({
          project,
          tasks: ledger.map((s) => ({ key: s.key, ref: s.ref })),
          section_heading: LEDGER_SECTION,
          section_text: sectionText,
          marker,
        }),
        { schema: INFRA_SCHEMA, phase: "Write-back" },
      );
      if (r && Array.isArray(r.results)) results = r.results;
      else why = (r && r.reason) || "ledger write-back agent returned no result";
    }
    for (const s of ledger) {
      const hit = results && results.find((x) => x.key === s.key);
      const st = hit && ["written", "skipped"].indexOf(hit.status) >= 0 ? hit.status : "failed";
      const e = { ref: s.ref, status: st, reason: hit ? hit.reason || null : why };
      if (st === "failed") e.section_text = sectionText;
      out.write_back.ledger.push(e);
    }
    out.ledger_status = out.write_back.ledger.some((e) => e.status === "failed") ? "failed" : "ok";
    gate("write-back ledger: " + out.write_back.ledger.map((e) => e.ref + "=" + e.status).join(", "));
  }

  // (b) one marked comment per external source
  const ext = brief.sources
    .map((s, i) => Object.assign({ key: "s" + i }, s, { text: commentText(s.kind, ref.task_id, ref.tldr, planLink, prUrl) }))
    .filter((s) => EXTERNAL_KINDS.indexOf(s.kind) >= 0);
  if (ext.length) {
    const res = {};
    const listable = [];
    for (const s of ext) {
      if (FORBIDDEN_COMMENT_RE.test(s.text)) res[s.key] = { status: "failed", reason: "refused: a comment line starts with digger or atlantis" };
      else listable.push(s);
    }
    let toPost = [];
    if (listable.length) {
      const l = await softDispatch(
        "infra:comments-list",
        commentsListPrompt({ sources: listable.map((s) => ({ key: s.key, kind: s.kind, ref: s.ref, url: s.url })), marker }),
        { schema: INFRA_SCHEMA, agentType: JUDGE_AGENT, phase: "Write-back" },
      );
      for (const s of listable) {
        const hit = l && Array.isArray(l.results) ? l.results.find((x) => x.key === s.key) : null;
        if (!hit || hit.status === "failed" || typeof hit.has_marker !== "boolean")
          res[s.key] = { status: "failed", reason: "could not list existing comments: " + ((hit && hit.reason) || (l && l.reason) || "no result") };
        else if (hit.has_marker) res[s.key] = { status: "skipped", reason: "a comment with " + marker + " exists" };
        else toPost.push(s);
      }
    }
    if (toPost.length) {
      const p = await softDispatch(
        "infra:comments-post",
        commentsPostPrompt({ posts: toPost.map((s) => ({ key: s.key, kind: s.kind, ref: s.ref, url: s.url, text: s.text })) }),
        { schema: INFRA_SCHEMA, phase: "Write-back" },
      );
      for (const s of toPost) {
        const hit = p && Array.isArray(p.results) ? p.results.find((x) => x.key === s.key) : null;
        res[s.key] =
          hit && hit.status === "posted"
            ? { status: "posted", reason: hit.reason || null, url: hit.url || null }
            : { status: "failed", reason: (hit && hit.reason) || (p && p.reason) || "comment post agent returned no result" };
      }
    }
    for (const s of ext) {
      const e = Object.assign({ kind: s.kind, ref: s.ref }, res[s.key]);
      if (e.status === "failed") e.comment_text = s.text;
      out.write_back.comments.push(e);
    }
    const failed = out.write_back.comments.filter((e) => e.status === "failed");
    out.comment_status = failed.length ? "failed" : out.write_back.comments.some((e) => e.status === "posted") ? "posted" : "skipped";
    if (failed.length) out.comment_text = failed[0].comment_text;
    gate("write-back comments: " + out.write_back.comments.map((e) => e.kind + ":" + e.ref + "=" + e.status).join(", "));
  }
  return out;
}

// ---------------------------------------------------------------- main

async function main(input) {
  const mode = input.mode;
  if (MODES.indexOf(mode) < 0)
    stop("needs_human", "args.mode must be \"plan\" or \"build\", got " + JSON.stringify(mode === undefined ? null : mode) + ": run /build-task <task>");
  state.mode = mode;
  if (typeof input.date !== "string" || !DATE_RE.test(input.date))
    stop("needs_human", "args.date must be YYYY-MM-DD (the skill supplies it; workflows cannot read the clock)");
  return mode === "plan" ? planMode(input, input.date) : buildMode(input, input.date);
}

// ---------------------------------------------------------------- entry

let input = args;
let badArgs = false;
if (typeof input === "string") {
  try {
    input = JSON.parse(input);
  } catch (e) {
    badArgs = true;
  }
}
if (badArgs || input == null || typeof input !== "object" || Object.keys(input).length === 0) {
  log("build-task-run started without args: nothing to do; use /build-task");
  return {
    status: "needs_human",
    reason:
      "build-task-run was started without args. Run /build-task <task>; the skill supplies mode, input, repo and date. Do not re-invoke this workflow by hand.",
  };
}

try {
  return await main(input);
} catch (e) {
  if (e instanceof Stop) return finish(e.status, e.reason);
  throw e;
}
