// fleet 6.2.0 (ledger 2058, ADR-1219): the plan-task skill MVP.
//
// T1 brief_check.py: one passing brief and one failing brief per check.
// T2 drift: the IaC and hook-path rules copied into brief_check.py agree with
//    isIacPath and HOOK_PATH_RE of build-task-run.js on a fixed path list.
// T3 the plan-task skill's allowed-tools is the exact read-only list.
// T4 the build-task skill forces confirm "ask" when the fleet-brief marker is
//    present (snapshot of the rule paragraph).
// T5 (launch-turn relay of an AskUserQuestion answer) and T6 (smoke run) are
// manual; see CHANGELOG 6.2.0.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { HERE, SOURCE, spawnSync } from "./harness.mjs";

const PY = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
const GIT = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
const SYS_PATH = dirname(GIT) + ":/usr/bin:/bin";
const SKILL_DIR = join(HERE, "..", "skills", "plan-task");
const CHECK = join(SKILL_DIR, "brief_check.py");
const TEMPLATE_PATH = join(SKILL_DIR, "brief-template.md");
const BUILD_SKILL = join(HERE, "..", "skills", "build-task", "SKILL.md");
const PLAN_SKILL = join(SKILL_DIR, "SKILL.md");

const TF = "terra" + "form";
const AT = "atlan" + "tis";
const DG = "dig" + "ger";
const NBSP = String.fromCharCode(0xa0);
const ZWSP = String.fromCharCode(0x200b);
const CR = String.fromCharCode(13);
const TAG_A = String.fromCodePoint(0xe0041);
const VS16 = String.fromCharCode(0xfe0f);
const HANGUL_FILLER = String.fromCharCode(0x3164);
const LSEP = String.fromCharCode(0x2028);

// a valid brief, as the skill writes it
const GOOD = [
  "## Fleet brief (plan-task, 2026-11-12)",
  "",
  "<!-- fleet-brief:v1 -->",
  "",
  "Repo: m-agahi/ccpm Component: fleet",
  "",
  "### Outcome",
  "",
  "When a user runs /plan-task on a vague idea, the task body gains a checked brief.",
  "",
  "### Behaviours",
  "",
  '- B1: Given a brief with no marker, When brief_check.py runs, Then it exits 1 and names "marker".',
  "- B2: Given the template, When brief_check.py runs, Then it exits 0.",
  "",
  "### Rulings (Max, 2026-11-12) — verbatim answers only",
  "",
  '- Q: Where does the brief live? A: "in the task body"',
  "",
  "### Draft by plan-task — not a ruling",
  "",
  "- The check runs on the brief text only.",
  "",
  "### Non-goals",
  "",
  "- No goldfish review.",
  "",
  "### Open decisions",
  "",
  "- none",
  "",
  "### Out of plan: IaC / hook surface / needs ADR",
  "",
  "- none",
  "",
].join("\n");

function check(text, extra, opts) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-620-"));
  try {
    const f = join(dir, "brief.md");
    writeFileSync(f, text);
    const r = spawnSync(PY, ["-I", CHECK].concat(extra || [], [f]), Object.assign({ encoding: "utf8", env: { PATH: SYS_PATH, HOME: dir } }, opts || {}));
    let out = null;
    try {
      out = JSON.parse(r.stdout);
    } catch (e) {
      out = null;
    }
    return { status: r.status, out, stderr: r.stderr, stdout: r.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const checksOf = (r) => (r.out ? r.out.errors.map((e) => e.check) : []);
const warnsOf = (r) => (r.out ? r.out.warnings.map((e) => e.check) : []);
function assertFails(r, name) {
  assert.equal(r.status, 1, JSON.stringify(r));
  assert.equal(r.out.ok, false);
  assert.ok(checksOf(r).includes(name), name + " not in " + JSON.stringify(r.out.errors));
}
function assertOk(r) {
  assert.equal(r.status, 0, JSON.stringify(r));
  assert.equal(r.out.ok, true);
  assert.deepEqual(r.out.errors, []);
}
const swap = (a, b) => GOOD.replace(a, b);

// a git repo with an origin URL and optional files
function gitRepo(url, files) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-620r-"));
  const env = { PATH: SYS_PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(dir, "gc") };
  writeFileSync(join(dir, "gc"), "");
  spawnSync(GIT, ["init", "-q", dir], { env });
  if (url) spawnSync(GIT, ["-C", dir, "remote", "add", "origin", url], { env });
  for (const [p, body] of Object.entries(files || {})) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  return dir;
}

// ---------------------------------------------------------------- T1: brief_check.py

test("6.2.0 T1: a complete brief passes", () => {
  assertOk(check(GOOD));
});

test("6.2.0 T1: the shipped template passes the check", () => {
  assertOk(check(readFileSync(TEMPLATE_PATH, "utf8")));
});

test("6.2.0 T1: the brief can come on stdin", () => {
  const r = spawnSync(PY, ["-I", CHECK, "-"], { input: GOOD, encoding: "utf8", env: { PATH: SYS_PATH } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);
});

test("6.2.0 T1 marker: no fleet-brief marker fails", () => {
  assertFails(check(swap("<!-- fleet-brief:v1 -->", "")), "marker");
});

test("6.2.0 T1 marker: a second marker fails", () => {
  assertFails(check(GOOD + "\n<!-- fleet-brief:v1 -->\n"), "marker");
});

test("6.2.0 T1 headings: the top heading is required", () => {
  assertFails(check(swap("## Fleet brief (plan-task, 2026-11-12)", "## Brief")), "headings");
});

for (const h of ["### Outcome", "### Behaviours", "### Rulings", "### Draft by plan-task", "### Non-goals", "### Open decisions", "### Out of plan"]) {
  test("6.2.0 T1 headings: missing " + h + " fails", () => {
    const text = GOOD.split("\n")
      .filter((l) => !l.startsWith(h))
      .join("\n");
    assertFails(check(text), "headings");
  });
}

test("6.2.0 T1 headings: headings out of order fail", () => {
  const text = GOOD.replace("### Outcome", "### TMP").replace("### Non-goals", "### Outcome").replace("### TMP", "### Non-goals");
  assertFails(check(text), "headings");
});

test("6.2.0 T1 repo: no Repo line fails", () => {
  assertFails(check(swap("Repo: m-agahi/ccpm Component: fleet", "Component: fleet")), "repo");
});

test("6.2.0 T1 repo: two Repo lines fail", () => {
  assertFails(check(swap("Repo: m-agahi/ccpm Component: fleet", "Repo: m-agahi/ccpm Component: fleet\nRepo: other/x")), "repo");
});

for (const bad of ["Repo: ccpm", "Repo: m-agahi/ccpm and other/x", "Repo: https://github.com/m-agahi/ccpm", "Repo: <owner>/<repo>"]) {
  test("6.2.0 T1 repo: '" + bad + "' is not exactly one owner/repo", () => {
    assertFails(check(swap("Repo: m-agahi/ccpm Component: fleet", bad)), "repo");
  });
}

test("6.2.0 T1 repo: a GitLab subgroup path is one repo", () => {
  assertOk(check(swap("Repo: m-agahi/ccpm", "Repo: concrete-media/group/app")));
});

for (const url of ["https://github.com/m-agahi/ccpm.git", "git@github.com:m-agahi/ccpm.git", "codeberg-agent:M-Agahi/ccpm", "ssh://git@github.com:22/m-agahi/ccpm"]) {
  test("6.2.0 T1 repo: --repo whose origin is " + url + " matches", () => {
    const dir = gitRepo(url, { "package.json": "{}\n" });
    try {
      const r = check(GOOD, ["--repo", dir], { env: { PATH: SYS_PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(dir, "gc") } });
      assertOk(r);
      assert.equal(r.out.repo, "m-agahi/ccpm");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("6.2.0 T1 repo: --repo whose origin is another repo fails", () => {
  const dir = gitRepo("git@github.com:m-agahi/other.git", { "package.json": "{}\n" });
  try {
    assertFails(check(GOOD, ["--repo", dir], { env: { PATH: SYS_PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(dir, "gc") } }), "repo");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("6.2.0 T1 repo: --repo with no origin fails", () => {
  const dir = gitRepo(null, { "package.json": "{}\n" });
  try {
    assertFails(check(GOOD, ["--repo", dir], { env: { PATH: SYS_PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(dir, "gc") } }), "repo");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("6.2.0 T1 runner: --repo with no test runner file warns, does not fail", () => {
  const dir = gitRepo("git@github.com:m-agahi/ccpm.git", {});
  try {
    const r = check(GOOD, ["--repo", dir], { env: { PATH: SYS_PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(dir, "gc") } });
    assertOk(r);
    assert.ok(warnsOf(r).includes("runner"), JSON.stringify(r.out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("6.2.0 T1 runner: a package.json is a runner hint (no warning)", () => {
  const dir = gitRepo("git@github.com:m-agahi/ccpm.git", { "package.json": "{}\n" });
  try {
    const r = check(GOOD, ["--repo", dir], { env: { PATH: SYS_PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(dir, "gc") } });
    assertOk(r);
    assert.ok(!warnsOf(r).includes("runner"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("6.2.0 T1 behaviours: a line with no Given/When/Then fails", () => {
  assertFails(check(swap("- B2: Given the template, When brief_check.py runs, Then it exits 0.", "- B2: the template passes.")), "behaviours");
});

test("6.2.0 T1 behaviours: Then before When fails", () => {
  assertFails(check(swap("- B2: Given the template, When brief_check.py runs, Then it exits 0.", "- B2: Given the template, Then it exits 0, When brief_check.py runs.")), "behaviours");
});

test("6.2.0 T1 behaviours: no behaviour at all fails", () => {
  const text = GOOD.split("\n")
    .filter((l) => !l.startsWith("- B"))
    .join("\n");
  assertFails(check(text), "behaviours");
});

test("6.2.0 T1 behaviours: prose that is not a list item fails", () => {
  assertFails(check(swap("- B2: Given the template, When brief_check.py runs, Then it exits 0.", "- B2: Given the template, When brief_check.py runs, Then it exits 0.\nAlso the docs.")), "behaviours");
});

const COMMANDS = [
  ["test_cmd", "- test_cmd: pytest -q"],
  ["check_cmd", "- check_cmd is make lint"],
  ["change_kind", "- change_kind: feature"],
  ["bug_fix", "- this is a bug_fix"],
  ["new_behaviour", "- new_behaviour: false"],
  ["env key", "- env: DEBUG=1"],
  ["backtick fence", "```sh\nrm -rf /\n```"],
  ["tilde fence", "~~~\nmake\n~~~"],
  ["shell prompt", "$ npm test"],
];
for (const [name, line] of COMMANDS) {
  test("6.2.0 T1 commands: " + name + " in the brief fails", () => {
    assertFails(check(swap("- The check runs on the brief text only.", line)), "commands");
  });
}

const IAC = ["infra/main.tf", "live/root.hcl", "envs/prod.tfvars", "." + TF + ".lock.hcl", AT + ".yaml", DG + ".yml", ".spacelift/config.yml"];
for (const p of IAC) {
  test("6.2.0 T1 iac: " + p + " in Behaviours fails", () => {
    assertFails(check(swap("Then it exits 0.", "Then it exits 0 and `" + p + "` changes.")), "iac");
  });
  test("6.2.0 T1 iac: " + p + " under Out of plan passes", () => {
    assertOk(check(GOOD.replace(/- none\n$/, "- `" + p + "`: hand to Max via MIGRATION_NOTES.md\n")));
  });
}

const HOOKS = [".pre-commit-config.yaml", ".github/workflows/ci.yml", ".gitlab-ci.yml", ".forgejo/workflows/x.yaml", ".husky/pre-commit", "lefthook.yml", ".git/hooks/pre-push"];
for (const p of HOOKS) {
  test("6.2.0 T1 hook: " + p + " in Draft fails", () => {
    assertFails(check(swap("- The check runs on the brief text only.", "- Edit " + p + ".")), "hook");
  });
  test("6.2.0 T1 hook: " + p + " under Out of plan passes", () => {
    assertOk(check(GOOD.replace(/- none\n$/, "- " + p + ": hook surface, own PR with Max\n")));
  });
}

const INVISIBLE = [
  ["NBSP", "a" + NBSP + "b"],
  ["ZWSP", "a" + ZWSP + "b"],
  ["CR", "a" + CR + "b"],
  ["tag character", "a" + TAG_A + "b"],
  ["variation selector", "a" + VS16 + "b"],
  ["Hangul filler", "a" + HANGUL_FILLER + "b"],
  ["line separator", "a" + LSEP + "b"],
];
for (const [name, s] of INVISIBLE) {
  test("6.2.0 T1 invisible: " + name + " fails", () => {
    assertFails(check(swap("No goldfish review.", "No goldfish review " + s + ".")), "invisible");
  });
}

test("6.2.0 T1 invisible: visible typography (em dash, smart quotes, arrow) passes", () => {
  assertOk(check(swap("No goldfish review.", "No goldfish review — “quoted” → fine.")));
});

test("6.2.0 T1 open decisions: an open entry fails", () => {
  assertFails(check(GOOD.replace("### Open decisions\n\n- none", "### Open decisions\n\n- A or B? Recommend A.")), "open_decisions");
});

test("6.2.0 T1 open decisions: --allow-open (Max chose plan anyway) passes with a warning", () => {
  const r = check(GOOD.replace("### Open decisions\n\n- none", "### Open decisions\n\n- A or B? Recommend A."), ["--allow-open"]);
  assertOk(r);
  assert.ok(warnsOf(r).includes("open_decisions"));
});

test("6.2.0 T1 size: a brief over 64 KiB is refused", () => {
  const r = check(GOOD + "x".repeat(70000));
  assert.equal(r.status, 1);
  assert.ok(checksOf(r).includes("size"), JSON.stringify(r.out));
});

test("6.2.0 T1 usage: no file argument exits 2", () => {
  const r = spawnSync(PY, ["-I", CHECK], { encoding: "utf8", env: { PATH: SYS_PATH } });
  assert.equal(r.status, 2);
});

// ---------------------------------------------------------------- T2: drift against build-task-run.js

function jsRules() {
  const grab = (re) => {
    const m = re.exec(SOURCE);
    assert.ok(m, "not found in build-task-run.js: " + re);
    return m[0];
  };
  const src = [
    grab(/^function normPath\(p\) \{[\s\S]*?\n\}\n/m),
    grab(/^const IAC_TF = .*;\n/m),
    grab(/^function isIacPath\(p\) \{[\s\S]*?\n\}\n/m),
    grab(/^const HOOK_PATH_RE = .*;\n/m),
  ].join("\n");
  return new Function(src + "\nreturn { isIacPath, hook: (p) => HOOK_PATH_RE.test(p) };")();
}

const DRIFT_PATHS = [
  "main.tf",
  "infra/MAIN.TF",
  "a/b.tofu",
  "x.tf.json",
  "y.tofu.json",
  "prod.tfvars",
  "prod.tfvars.json",
  "p.tofuvars",
  "p.tofuvars.json",
  "root.hcl",
  "env.hcl.json",
  "backend/prod.tfbackend",
  "." + TF + "rc",
  "cli.tfrc",
  "." + TF + "-version",
  ".open" + "to" + "fu-version",
  "." + "to" + "fu-version",
  AT + ".yaml",
  "ops/" + AT.toUpperCase() + ".YML",
  DG + ".yml",
  DG + ".yaml",
  "." + TF + "/providers/x",
  TF + ".d/plugins/x",
  "stacks/.spacelift/hooks.yml",
  "./infra/main.tf",
  "src/app.py",
  "README.md",
  "docs/" + TF + ".md",
  "spacelift.yml",
  ".pre-commit-config.yaml",
  ".pre-commit-hooks.yaml",
  ".github/workflows/ci.yml",
  ".gitlab-ci.yml",
  "Jenkinsfile",
  "azure-pipelines.yml",
  "bitbucket-pipelines.yaml",
  ".woodpecker.yml",
  ".circleci/config.yml",
  "tools/lefthook-local.yml",
  ".husky/pre-commit",
  "src/github/workflow.py",
];

test("6.2.0 T2: the IaC and hook rules in brief_check.py agree with build-task-run.js on " + DRIFT_PATHS.length + " paths", () => {
  assert.ok(DRIFT_PATHS.length >= 40);
  const js = jsRules();
  const r = spawnSync(PY, ["-I", CHECK, "--classify-paths", JSON.stringify(DRIFT_PATHS)], { encoding: "utf8", env: { PATH: SYS_PATH } });
  assert.equal(r.status, 0, r.stderr);
  const py = JSON.parse(r.stdout);
  assert.equal(py.length, DRIFT_PATHS.length);
  for (let i = 0; i < DRIFT_PATHS.length; i++) {
    const p = DRIFT_PATHS[i];
    assert.equal(py[i].path, p);
    assert.equal(py[i].iac, js.isIacPath(p), "iac drift on " + p);
    assert.equal(py[i].hook_re, js.hook(p), "hook drift on " + p);
  }
  // the list exercises both answers of both rules
  assert.ok(py.some((x) => x.iac) && py.some((x) => !x.iac));
  assert.ok(py.some((x) => x.hook_re) && py.some((x) => !x.hook_re));
});

// ---------------------------------------------------------------- T3: plan-task skill frontmatter

function frontmatter(path) {
  const text = readFileSync(path, "utf8");
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, "no frontmatter in " + path);
  return { fm: m[1], text };
}
function allowedTools(fm) {
  const m = /\nallowed-tools:\n((?: {2}- .*\n?)+)/.exec("\n" + fm + "\n");
  assert.ok(m, "no allowed-tools list");
  return m[1]
    .split("\n")
    .filter(Boolean)
    .map((l) => l.replace(/^ {2}- /, "").trim());
}

test("6.2.0 T3: the plan-task skill pre-approves only the exact read-only tool list", () => {
  const { fm } = frontmatter(PLAN_SKILL);
  assert.match(fm, /^name: plan-task$/m);
  assert.deepEqual(allowedTools(fm), [
    "AskUserQuestion",
    "Bash(git rev-parse *)",
    "Bash(git remote get-url *)",
    "Bash(git ls-files *)",
    "Bash(date *)",
    "Bash(python3 -I ${CLAUDE_PLUGIN_ROOT}/skills/plan-task/brief_check.py *)",
  ]);
});

test("6.2.0 T3: no write tool, no Workflow and no Agent is pre-approved", () => {
  const tools = allowedTools(frontmatter(PLAN_SKILL).fm).join("\n");
  for (const w of ["edit_task", "create_task", "transition_task", "task_write", "wiki_", "Write", "Edit", "Workflow", "Agent", "adr_add", "memorize"]) assert.ok(!tools.includes(w), w);
});

test("6.2.0 T3: the plan-task skill states its safety rules", () => {
  // line wraps do not count (prettier keeps the wrap)
  const text = frontmatter(PLAN_SKILL).text.replace(/\s+/g, " ");
  for (const s of [
    "<!-- fleet-brief:v1 -->",
    "not a ruling",
    "untrusted data",
    "Never change a task's status",
    "expect_version",
    "body_slug",
    "skip — just plan",
    "Show only",
    "never in `plugins/fleet/scripts/` or `plugins/fleet/roles/`",
  ])
    assert.ok(text.includes(s), s);
});

// ---------------------------------------------------------------- T4: build-task forces ask on a brief

const BRIEF_RULE_SHA256 = "378c44d710852bffd5c21002305a55ae3237129d0bbd89104349655499eddb24";

test("6.2.0 T4: build-task forces confirm ask when the source carries the fleet-brief marker", () => {
  const text = readFileSync(BUILD_SKILL, "utf8");
  const m = /\n(   \*\*Fleet brief \(6\.2\.0, ADR-1219\)\.\*\*[\s\S]*?)\n\n/.exec(text);
  assert.ok(m, "no Fleet brief rule in build-task SKILL.md");
  const rule = m[1];
  for (const s of ["<!-- fleet-brief:v1 -->", 'confirm: "ask"', '"auto"', "cannot read"]) assert.ok(rule.includes(s), s);
  // the rule comes before the plan launch (step 6)
  assert.ok(text.indexOf(rule) < text.indexOf("6. **Plan.**"));
  const sha = createHash("sha256").update(rule).digest("hex");
  if (process.env.FLEET_SNAPSHOT_PRINT) console.log("BRIEF_RULE_SHA256", sha);
  assert.equal(sha, BRIEF_RULE_SHA256);
});

test("6.2.0: build-task points vague input to /plan-task", () => {
  assert.ok(readFileSync(BUILD_SKILL, "utf8").includes("/plan-task"));
});
