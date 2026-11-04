export const meta = {
  name: "build-task-run",
  description:
    "Role fleet for one task: plan, audit, per-criterion test writers, test judge, freeze, coder, code judge, draft PR. Every gate runs in script code.",
  whenToUse:
    "Run by the /build-task skill. args: {task, repo, date, title?, project?}. If invoked with no args, do not call Workflow again: tell the user to run /build-task <ledger id | plan path>.",
  phases: [
    { title: "Preflight", detail: "load all seven role prompts from yadgar" },
    { title: "Workspace", detail: "create or reuse the fleet branch and worktree" },
    { title: "Plan", detail: "scope-and-plan, risk tier, plan-audit" },
    { title: "Tests", detail: "one test writer per criterion, test judge, revise rounds" },
    { title: "Freeze", detail: "hash frozen tests and test-runner config" },
    { title: "Code", detail: "coder, hash check, code judge, fix rounds" },
    { title: "PR", detail: "draft PR from the approved sha" },
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
const JUDGE_AGENT = "fleet:judge"; // read-only: Write/Edit/NotebookEdit disallowed
const MAX_AGENTS = 60;
const MAX_TEST_ROUNDS = 3; // per test-loop entry (initial, and each fix_tests re-entry)
const MAX_CODE_ROUNDS = 3; // total coder rounds; a fix_tests detour counts as one
const SHORT_PATH_MAX_DIFF = 20;

// v1 runs no held-out examples and no mutation/coverage/scanner gates. Judges
// get these explicit not_run markers, never an empty list: a judge must not
// read a missing gate as a passing one (fail-closed).
const HELD_OUT_NOT_RUN = { status: "not_run", reason: "v1: held-out execution lands in v1.1" };
const SCRIPT_FINDINGS_NOT_RUN = { status: "not_run", reason: "v1: mutation/coverage/scan gates land in v1.1" };
// The planner may emit these. They must never reach another role.
const HELD_OUT_KEY = "held_out_examples";

// Test-runner config the hasher freezes, in addition to every criterion test
// file. Whole files, matched on basename anywhere in the tree (tracked, or
// untracked and not ignored):
// Found by walking the filesystem (not git ls-files), so a config file that an
// ignore rule hides is still hashed. The walk skips .git, .claude/worktrees and
// the dependency/cache dirs in WALK_SKIP_DIRS.
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
const WALK_SKIP_DIRS = [".git", "node_modules", "__pycache__", ".venv", "venv", ".tox", ".nox", ".mypy_cache", ".pytest_cache"];
// Ignore rules are frozen too: hiding a new config file behind an ignore rule
// changes one of these keys. Every .gitignore in the tree is hashed under its
// path; the worktree's info/exclude (git rev-parse --git-path info/exclude,
// the common dir for a linked worktree) under "git:info/exclude"; the global
// core.excludesFile under "git:core.excludesFile".
// Every symlink the walk meets (file or directory, outside the skipped dirs) is
// frozen as "symlink:<path>" = its readlink target. Links are never followed,
// so adding or retargeting one is a change.
const SYMLINK_RULE = "every symlink outside the skipped dirs -> key symlink:<path> = readlink target (never followed)";
const IGNORE_RULE_FILES = [".gitignore (every one in the tree)", "git:info/exclude", "git:core.excludesFile"];
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
SKIP_DIRS = {'.git', 'node_modules', '__pycache__', '.venv', 'venv', '.tox', '.nox', '.mypy_cache', '.pytest_cache'}
PACKAGE_KEYS = ['jest', 'vitest', 'mocha']

wt, mode = sys.argv[1], sys.argv[2]
explicit = json.loads(sys.argv[3]) if len(sys.argv) > 3 else []

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

def walk():
    # never follows a symlink; every link outside SKIP_DIRS is recorded with its target
    for dp, dns, fns in os.walk(wt):
        reld = os.path.relpath(dp, wt)
        keep = []
        for d in sorted(dns):
            if d in SKIP_DIRS or os.path.join(reld, d) in ('./.claude/worktrees', '.claude/worktrees'):
                continue
            full = os.path.join(dp, d)
            if os.path.islink(full):
                LINKS[os.path.normpath(os.path.join(reld, d))] = os.readlink(full)
                continue
            keep.append(d)
        dns[:] = keep
        for f in sorted(fns):
            rel = os.path.normpath(os.path.join(reld, f))
            full = os.path.join(dp, f)
            if os.path.islink(full):
                LINKS[rel] = os.readlink(full)
            yield rel

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
    hashes = {}
    for rel in walk():
        base = os.path.basename(rel)
        if base == '.gitignore' or any(fnmatch.fnmatch(base, g) for g in CONFIG_GLOBS):
            hashes[rel] = file_hash(rel)
        elif '/' not in rel and any(fnmatch.fnmatch(base, g) for g in ROOT_ONLY_GLOBS):
            hashes[rel] = file_hash(rel)
    for rel in sorted(LINKS):
        hashes['symlink:' + rel] = LINKS[rel]
    ex = git('rev-parse', '--git-path', 'info/exclude').decode().strip()
    hashes['git:info/exclude'] = abs_hash(ex if os.path.isabs(ex) else os.path.join(wt, ex))
    gx = subprocess.run(['git', '-C', wt, 'config', '--path', 'core.excludesFile'], capture_output=True)
    gpath = gx.stdout.decode().strip()
    if not gpath:
        gpath = os.path.join(os.environ.get('XDG_CONFIG_HOME') or os.path.expanduser('~/.config'), 'git', 'ignore')
    hashes['git:core.excludesFile'] = abs_hash(gpath)
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
                hashes[rel + '#tool.pytest'] = 'ABSENT' if sec is None else sha(canon(sec))
            except FileNotFoundError:
                hashes[rel + '#tool.pytest'] = 'MISSING'
            except Exception:
                hashes[rel + '#tool.pytest'] = 'UNPARSEABLE'
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
                hashes[rel + '#' + k] = v
    for rel in explicit:
        rel = norm(rel)
        hashes[rel] = file_hash(rel)
    out['hashes'] = hashes

print(json.dumps(out, sort_keys=True))
`;
// HASHER_PY_END

// ---------------------------------------------------------------- schemas

const STR = { type: "string" };
const STR_OR_NULL = { type: ["string", "null"] };
const ANY_ARRAY = { type: "array" };
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
    required: ["status", "reason"],
    properties: Object.assign(
      {
        status: { type: "string", enum: ["ok", "needs_human", "failed"] },
        reason: STR,
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
  }),
  "plan-audit": roleSchema({
    verdict: { type: "string", enum: ["approve", "untestable_criteria", "plan_defect"] },
    routed_findings: FINDINGS,
  }),
  "fleet-test-writer": roleSchema({
    criterion_id: STR,
    tests: ANY_ARRAY,
    commit: STR_OR_NULL,
    addressed_findings: ANY_ARRAY,
  }),
  "fleet-test-judge": roleSchema({
    verdict: { type: "string", enum: ["approve", "revise"] },
    routed_findings: FINDINGS,
    checked: ANY_ARRAY,
  }),
  "fleet-coder": roleSchema({
    commits: { type: "array", items: STR },
    frozen_tests_red_at_start: { type: "boolean" },
    suite_result: SUITE,
    addressed_findings: ANY_ARRAY,
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
  }),
};

const PREFLIGHT_SCHEMA = {
  type: "object",
  required: ["reachable", "missing"],
  properties: {
    reachable: { type: "boolean" },
    missing: { type: "array", items: STR },
    versions: { type: "object" },
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
    hashes: { type: "object", additionalProperties: STR },
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

function isPlanPath(task) {
  return /\.md$/i.test(task) || task.indexOf("/") >= 0;
}

// Task id: "plan" for a plan path, else the slugified ledger id.
// Slug: the plan filename stem, else the title, else "task".
// Branch: fleet/<task id>-<slug>.
function deriveNames(task, title) {
  if (isPlanPath(task)) {
    const stem = task.split("/").pop().replace(/\.md$/i, "");
    return { taskId: "plan", slug: slugify(stem) || "task", planPath: task };
  }
  return { taskId: slugify(task, 40), slug: slugify(title) || "task", planPath: null };
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
    { gate: "held_out", reason: HELD_OUT_NOT_RUN.reason },
    { gate: "script_findings", reason: SCRIPT_FINDINGS_NOT_RUN.reason },
  ];
}

// Split the frozen map: plain worktree files (plain=true) vs synthetic keys
// (<path>#<section>, git:<...>). Roles sha256sum plain files; synthetic keys
// are not paths.
function plainKeys(map, plain) {
  const o = {};
  for (const k of Object.keys(map || {})) {
    const synthetic = k.indexOf("#") >= 0 || k.indexOf("git:") === 0 || k.indexOf("symlink:") === 0;
    if (synthetic !== plain) o[k] = map[k];
  }
  return o;
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

// Keys whose value differs, including keys only one side has.
function diffHashes(frozen, now) {
  const keys = {};
  for (const k of Object.keys(frozen || {})) keys[k] = true;
  for (const k of Object.keys(now || {})) keys[k] = true;
  return Object.keys(keys)
    .filter((k) => {
      const a = frozen && k in frozen ? frozen[k] : "<new>";
      const b = now && k in now ? now[k] : "<removed>";
      return a !== b;
    })
    .sort();
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
    "versions maps each found pattern to its `version`. Return {reachable, missing, versions, reason}."
  );
}

function workspacePrompt(inputs) {
  return (
    "Infra step of the fleet build workflow: mechanical git setup only. No code, no commits, no push. Never delete, reset or recreate an existing branch or worktree.\n" +
    "Inputs: " +
    JSON.stringify(inputs) +
    "\n" +
    "Steps (use `git -C`):\n" +
    "1. `git -C <repo> fetch origin --prune`.\n" +
    "2. default_branch = `git -C <repo> symbolic-ref --short refs/remotes/origin/HEAD` without the `origin/` prefix; if that fails, `gh repo view --json defaultBranchRef -q .defaultBranchRef.name` run in <repo>.\n" +
    "3. Keep fleet files out of git status: if `git -C <repo> check-ignore -q .claude/worktrees/probe` fails, append the line `.claude/worktrees/` to `$(git -C <repo> rev-parse --path-format=absolute --git-common-dir)/info/exclude`. Do the same for `.claude/settings.local.json` (probe that path), and for the test caches `__pycache__/`, `.pytest_cache/`, `.coverage` (a judge's test run must not leave untracked noise). Never edit a tracked .gitignore.\n" +
    "4. Branch state: `gh pr list --head <branch> --state all --json number,state` in <repo>. MERGED or CLOSED -> status needs_human.\n" +
    "5. main_worktree: if it exists and `git -C <main_worktree> branch --show-current` equals <branch>, reuse it (created=false). If the path exists otherwise -> needs_human. If absent: local branch <branch> exists -> `git -C <repo> worktree add <main_worktree> <branch>`; else remote branch exists (`git -C <repo> ls-remote --exit-code --heads origin <branch>`) -> `git -C <repo> worktree add -b <branch> <main_worktree> origin/<branch>`; else `git -C <repo> worktree add --no-track -b <branch> <main_worktree> origin/<default_branch>` (created=true).\n" +
    "6. If `<main_worktree>/.claude/settings.local.json` is absent, write it with exactly the content of `settings_local_json`. Then `git -C <main_worktree> status --porcelain` must be empty; if not -> needs_human with the listed paths.\n" +
    "7. `mkdir -p <scratch_dir>`.\n" +
    "8. base_ref = `git -C <main_worktree> merge-base HEAD origin/<default_branch>`.\n" +
    "9. remote_slug = <owner>/<name> parsed from `git -C <repo> remote get-url origin`.\n" +
    "Return {status, reason, default_branch, base_ref, remote_slug, created}."
  );
}

function preparePrompt(inputs) {
  return (
    "Infra step of the fleet build workflow: commit the plan doc and create per-criterion test worktrees. No other edits. Never push. Never --no-verify or any hook bypass; no Co-Authored-By trailer.\n" +
    "Inputs: " +
    JSON.stringify(inputs) +
    "\n" +
    "1. `git -C <main_worktree> branch --show-current` must equal <branch>; mismatch -> needs_human.\n" +
    '2. If `git -C <main_worktree> status --porcelain -- <plan_path>` is non-empty: `git -C <main_worktree> add <plan_path>` and `git -C <main_worktree> commit -m "docs(plan): <slug>"`. Hook failure: fix the cause and retry once; a second failure -> failed. Any other dirty path in main_worktree -> needs_human with the paths.\n' +
    "3. For each entry of `criterion_worktrees`: if entry.path is a worktree on entry.branch, reuse it. Else if local branch entry.branch exists: `git -C <main_worktree> worktree add <entry.path> <entry.branch>`. Else `git -C <main_worktree> worktree add --no-track -b <entry.branch> <entry.path> <branch>`. Path exists on another branch -> needs_human. In each worktree you create, write `<entry.path>/.claude/settings.local.json` with exactly entry.settings_local_json.\n" +
    "4. head = `git -C <main_worktree> rev-parse HEAD`; `git -C <main_worktree> status --porcelain` must be empty.\n" +
    "Return {status, reason, head}."
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
    ", .claude/worktrees. Sections hashed under <path>#<section> (whole file NOT hashed): " +
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
    'It prints one JSON object with `fingerprint` and (mode hashes) `hashes`. Return {status: "ok", fingerprint, hashes} with those values copied exactly. ' +
    'If the command exits non-zero, return {status: "failed", reason: <its stderr>, fingerprint: {head: "", status_sha256: "", diff_sha256: ""}}. Run no other command.\n' +
    "Extraction rules (the program implements them): " +
    rules
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
  agents: 0,
  gateLog: [],
  findings: [],
  rounds: { tests: 0, code: 0 },
  path: null,
  branch: null,
  pr: null,
  gatesNotRun: null,
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

async function dispatch(label, prompt, opts) {
  reserve(1, label);
  state.agents++;
  const r = await agent(prompt, Object.assign({}, opts, { label }));
  if (r == null) halt("failed", "agent " + label + " returned no result");
  return r;
}

function collect(role, r) {
  if (r && Array.isArray(r.yadgar_findings) && r.yadgar_findings.length)
    state.findings.push({ role, findings: r.yadgar_findings });
}

async function callRole(role, label, inputs, phaseName, agentType) {
  const opts = { schema: SCHEMAS[role], phase: phaseName };
  if (agentType) opts.agentType = agentType;
  const r = await dispatch(label, rolePrompt(role, inputs), opts);
  collect(role, r);
  return r;
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
  if (r.status !== "ok" || !r.fingerprint || !r.fingerprint.head || (mode === "hashes" && !r.hashes))
    halt("failed", "hasher " + label + " failed: " + (r.reason || "incomplete output"));
  return r;
}

async function infra(label, prompt, phaseName) {
  const r = await dispatch(label, prompt, { schema: INFRA_SCHEMA, phase: phaseName });
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
    branch: state.branch,
    pr_url: state.pr ? state.pr.pr_url : null,
    pr_number: state.pr ? state.pr.pr_number : null,
    path: state.path,
    rounds: { tests: state.rounds.tests, code: state.rounds.code },
    agents: state.agents,
    gates_not_run: state.gatesNotRun,
    gate_log: state.gateLog,
    yadgar_findings: state.findings,
  };
}

// ---------------------------------------------------------------- main

async function main(input) {
  const task = typeof input.task === "string" ? input.task.trim() : "";
  const repo = typeof input.repo === "string" ? input.repo.replace(/\/+$/, "") : "";
  const date = input.date;
  if (!task) stop("needs_human", "args.task missing: run /build-task <ledger id | plan path>");
  if (!repo || repo.charAt(0) !== "/") stop("needs_human", "args.repo must be the absolute path of the target repo");
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    stop("needs_human", "args.date must be YYYY-MM-DD (the skill supplies it; workflows cannot read the clock)");

  const names = deriveNames(task, input.title);
  if (!names.taskId) stop("needs_human", "task id derives to an empty slug: " + JSON.stringify(task));
  const key = names.taskId + "-" + names.slug;
  const branch = "fleet/" + key;
  const root = repo + "/.claude/worktrees/fleet-" + key;
  const mainWt = root + "/main";
  const scratch = root + "/scratch";
  state.branch = branch;
  gate("task " + JSON.stringify(task) + " -> branch " + branch + ", worktree " + mainWt);

  // 1. preflight
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

  // 2. workspace
  phase("Workspace");
  const ws = await infra(
    "workspace",
    workspacePrompt({
      repo,
      branch,
      main_worktree: mainWt,
      scratch_dir: scratch,
      settings_local_json: settingsFor(mainWt),
    }),
    "Workspace",
  );
  if (!ws.default_branch || !ws.base_ref) halt("failed", "workspace returned no default_branch/base_ref");
  const defaultBranch = ws.default_branch;
  const project = input.project || ws.remote_slug;
  if (!project) halt("needs_human", "no project (<owner>/<repo>): pass args.project");
  gate("workspace: " + (ws.created ? "created " : "reused ") + mainWt + " off " + defaultBranch + " @ " + ws.base_ref);

  const common = { project, worktree: mainWt, branch, default_branch: defaultBranch, scratch_dir: scratch };

  // 3. plan
  phase("Plan");
  const plan = requireOk(
    "scope-and-plan",
    await callRole(
      "scope-and-plan",
      "role:scope-and-plan",
      Object.assign({}, common, {
        task,
        title: input.title || null,
        plan_path: names.planPath,
        repo: project,
        base_ref: ws.base_ref,
        date,
        mode: "commit=false",
      }),
      "Plan",
    ),
  );
  if (typeof plan.plan_path !== "string" || !Array.isArray(plan.criteria))
    halt("failed", "scope-and-plan returned no plan_path/criteria");
  const seen = {};
  const criteria = plan.criteria.map((c) => {
    const id = String(c.id || "");
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
  // plan facts forwarded to later roles; held-out examples stay behind
  const planFacts = {
    allowed_additions: plan.allowed_additions ? stripHeldOut(plan.allowed_additions) : null,
    est_diff_lines: typeof plan.est_diff_lines === "number" ? plan.est_diff_lines : null,
  };
  if (Array.isArray(plan[HELD_OUT_KEY]) || plan.criteria.some((c) => c && c[HELD_OUT_KEY]))
    gate("planner emitted held_out_examples: withheld from every other role (v1 does not run them)");
  const overlaps = findOverlaps(criteria);
  if (overlaps.length) halt("needs_human", "test_files overlap across criteria: " + overlaps.join("; "));
  gate("plan: " + plan.plan_path + ", " + criteria.length + " criteria, test files disjoint");

  // 4. risk tier
  const shortPath =
    typeof plan.est_diff_lines === "number" &&
    plan.est_diff_lines < SHORT_PATH_MAX_DIFF &&
    plan.new_behaviour === false;
  state.path = shortPath ? "short" : "full";
  gate(
    "risk tier: est_diff_lines=" +
      plan.est_diff_lines +
      ", new_behaviour=" +
      plan.new_behaviour +
      " -> " +
      state.path +
      " path",
  );

  const planCtx = { plan_path: plan.plan_path };
  let testable = [];
  if (!shortPath) {
    // 5. plan-audit
    const audit = requireOk(
      "plan-audit",
      await callRole(
        "plan-audit",
        "role:plan-audit",
        Object.assign({}, common, planCtx, planFacts, { criteria, base_ref: ws.base_ref, mode: "writeback=false" }),
        "Plan",
      ),
    );
    if (audit.verdict !== "approve") {
      const first = (audit.routed_findings || [])
        .slice(0, 3)
        .map((f) => (f.criterion || "-") + ": " + f.finding);
      halt(
        audit.verdict ? "needs_human" : "failed",
        "plan-audit verdict " + (audit.verdict || "missing") + (first.length ? ": " + first.join("; ") : ""),
      );
    }
    gate("plan-audit: approve");
    testable = criteria.filter((c) => c.test_files.length);
    for (const c of criteria)
      if (!c.test_files.length) gate("criterion " + c.id + " has no test_files ([manual]): no writer");
    if (!testable.length) halt("needs_human", "full path but no testable criteria (all [manual])");
  }

  const critWt = {};
  for (const c of testable) {
    const p = root + "/t-" + c.id;
    critWt[c.id] = { criterion: c.id, path: p, branch: branch + "--t-" + c.id, settings_local_json: settingsFor(p) };
  }

  const prep = await infra(
    "infra:prepare",
    preparePrompt({
      main_worktree: mainWt,
      branch,
      slug: names.slug,
      plan_path: plan.plan_path,
      criterion_worktrees: testable.map((c) => critWt[c.id]),
    }),
    shortPath ? "Plan" : "Tests",
  );
  if (!prep.head) halt("failed", "infra:prepare returned no head");
  const planHead = prep.head;
  gate("plan committed at " + planHead + (testable.length ? "; " + testable.length + " test worktrees ready" : ""));

  // 6. tests
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
        reserve(pending.length + 4, "test round " + n);
        state.agents += pending.length;
        const results = await parallel(
          pending.map((p) => () => {
            const c = p.criterion;
            const wt = critWt[c.id];
            return agent(
              rolePrompt(
                "fleet-test-writer",
                Object.assign({}, common, planCtx, {
                  criterion: writerCriterion(c),
                  test_files: c.test_files,
                  worktree: wt.path,
                  branch: wt.branch,
                  routed_findings: p.findings,
                }),
              ),
              {
                label: "role:fleet-test-writer:" + c.id + ":r" + n,
                schema: SCHEMAS["fleet-test-writer"],
                phase: "Tests",
              },
            );
          }),
        );
        results.forEach((r, idx) => {
          const cid = pending[idx].criterion.id;
          if (r == null) halt("failed", "test writer " + cid + " r" + n + " returned no result");
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
      if (judgeFirst) {
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

  // 7. freeze
  let freezes = 0;
  let frozen = null;
  let freezeRef = null;
  // the first freeze ref, before any coder commit: a re-freeze after fix_tests
  // moves freeze_ref past earlier coder commits, so judges diff from this one
  let codeBaseRef = null;
  const frozenFiles = [];
  for (const c of testable) for (const f of c.test_files) frozenFiles.push(f);

  async function freeze() {
    freezes++;
    const h = await hasher("hasher:freeze:f" + freezes, mainWt, "hashes", frozenFiles, "Freeze");
    if (lastJudgeFp && !sameFingerprint(lastJudgeFp, h.fingerprint))
      halt("needs_human", "worktree changed between test approval and freeze");
    frozen = h.hashes;
    freezeRef = h.fingerprint.head;
    if (!codeBaseRef) codeBaseRef = freezeRef;
    gate("freeze f" + freezes + " at " + freezeRef + ": " + Object.keys(frozen).length + " hashed keys");
  }

  if (!shortPath) {
    phase("Tests");
    await testLoop(
      testable.map((c) => ({ criterion: c, findings: [] })),
      null,
    );
  }
  phase("Freeze");
  await freeze();

  // 8. code
  phase("Code");
  const frozenNote =
    "frozen_tests holds plain worktree files only (sha256 of the content). frozen_config_sections holds canonicalised test-runner config sections (<path>#<section>), symlinks (symlink:<path> = link target) and ignore-rule files outside the worktree (git:info/exclude, git:core.excludesFile); ABSENT/MISSING mean the section or file did not exist at freeze. Every key in both maps is read-only. The workflow recomputes every key itself after the coder. code_base_ref is the commit before the first coder round; diff production changes from it.";
  let coderFindings = [];
  let approvedSha = null;
  let approval = null;
  for (;;) {
    if (state.rounds.code >= MAX_CODE_ROUNDS)
      halt("needs_human", "code rounds exhausted (" + MAX_CODE_ROUNDS + ") without code-judge approval");
    state.rounds.code++;
    const m = state.rounds.code;
    reserve(4, "code round " + m);
    const codeInputs = Object.assign({}, common, planCtx, planFacts, {
      criteria,
      frozen_tests: plainKeys(frozen, true),
      frozen_config_sections: plainKeys(frozen, false),
      frozen_tests_note: frozenNote,
      freeze_ref: freezeRef,
      code_base_ref: codeBaseRef,
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
    const h = await hasher("hasher:post-coder:r" + m, mainWt, "hashes", frozenFiles, "Code");
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
      gate("code-judge r" + m + ": approve at " + approvedSha);
      break;
    }
    if (cj.verdict === "plan_wrong")
      halt("needs_human", "code-judge verdict plan_wrong: " + routed.map((f) => f.finding).join("; "));
    if (cj.verdict === "fix_code") {
      coderFindings = routed.filter((f) => f.target === "code");
      gate("code-judge r" + m + ": fix_code -> coder (" + coderFindings.length + " findings)");
      continue;
    }
    if (cj.verdict === "fix_tests") {
      if (shortPath) halt("needs_human", "code-judge fix_tests on the short path (no test fleet ran)");
      const tf = routed.filter((f) => f.target === "tests");
      gate("code-judge r" + m + ": fix_tests -> test-judge (" + tf.length + " findings)");
      phase("Tests");
      await testLoop([], tf);
      phase("Freeze");
      await freeze();
      phase("Code");
      // a fix_tests verdict may also carry code findings: keep them
      coderFindings = routed.filter((f) => f.target === "code");
      continue;
    }
    halt("failed", "code-judge returned no verdict");
  }

  // 9. PR
  phase("PR");
  const pr = requireOk(
    "fleet-pr-opener",
    await callRole(
      "fleet-pr-opener",
      "role:fleet-pr-opener",
      Object.assign({}, common, planCtx, {
        repo: project,
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
  const out = finish("ok", "draft PR ready for review");
  out.created = pr.created;
  out.template_used = pr.template_used || null;
  return out;
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
      "build-task-run was started without args. Run /build-task <ledger id | plan path>; the skill supplies task, repo and date. Do not re-invoke this workflow by hand.",
  };
}

try {
  return await main(input);
} catch (e) {
  if (e instanceof Stop) return finish(e.status, e.reason);
  throw e;
}
