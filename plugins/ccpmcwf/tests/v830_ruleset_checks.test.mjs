// ccpmcwf (yaadgaar #95): the ruleset read collects the required checks of the
// effective branch rules: each `workflows` rule entry (repo@ref:path and its
// check names, "<workflow name> / <job name>", from the file the step already
// reads) and each `required_status_checks` context. The read runs after the
// planner's first round (8.3.2, yaadgaar #103: Max kept it there), so the checks
// reach re-plan rounds, plan-audit and the PR opener, never the planner's first
// round; the plan ref seals them.
// No real GitHub API: a stub gh answers from a table.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCRIPTS_SRC, ARGS, happy, run, call, inputsOf, spawnSync } from "./harness.mjs";

const PY = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
const GIT = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
const RULES = "repos/m/p/rules/branches/main";
const AI = "name: AI Usage Label\non: pull_request\njobs:\n  survey:\n    name: AI Usage Survey\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n";
const LOCAL = "name: 'CI'\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./tools/act\n  lint:\n    name: \"Lint all\" # comment\n    runs-on: ubuntu-latest\n";
const b64 = (t) => Buffer.from(t).toString("base64");

function home(table) {
  const h = mkdtempSync(join(tmpdir(), "fleet-830-"));
  const bin = join(h, "bin");
  mkdirSync(bin);
  symlinkSync(GIT, join(bin, "git"));
  writeFileSync(join(bin, "gh.json"), JSON.stringify(table));
  writeFileSync(
    join(bin, "gh"),
    "#!" + PY + "\nimport json, os, sys\n" +
      "t = json.load(open(" + JSON.stringify(join(bin, "gh.json")) + "))\n" +
      "st, body = t.get(sys.argv[-1], [404, {'message': 'Not Found'}])\n" +
      "if '-i' in sys.argv:\n    sys.stdout.write('HTTP/2.0 %d X\\r\\n\\r\\n' % st)\n" +
      "sys.stdout.write(body if isinstance(body, str) else json.dumps(body))\n" +
      "if st >= 300:\n    sys.stderr.write('gh: X (HTTP %d)\\n' % st)\n    sys.exit(1)\n",
  );
  chmodSync(join(bin, "gh"), 0o755);
  const repo = join(h, "repo");
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  writeFileSync(join(repo, ".github", "workflows", "ci.yml"), LOCAL);
  spawnSync(GIT, ["init", "-q", repo]);
  spawnSync(GIT, ["-C", repo, "add", "-A"]);
  return { h, bin, repo };
}
function surface(rules, extra = {}) {
  const e = home(Object.assign({ "repos/m/p": [200, { id: 9, owner: { type: "User" } }], [RULES]: [200, rules] }, extra));
  try {
    const r = spawnSync(PY, ["-I", join(SCRIPTS_SRC, "ruleset_surface.py"), e.repo, "gh", "m/p", "main"], { encoding: "utf8", env: { PATH: e.bin, HOME: e.bin }, timeout: 120000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(e.h, { recursive: true, force: true });
  }
}
const OTHER = {
  "repositories/77": [200, { full_name: "q/actions" }],
  "repos/q/actions/contents/.github/workflows/ai-usage-label.yaml?ref=refs%2Fheads%2Fmain": [200, { content: b64(AI) }],
};
const RULESET = [
  { type: "pull_request", ruleset_id: 5, parameters: {} },
  { type: "workflows", ruleset_id: 7, ruleset_source_type: "Organization", parameters: { workflows: [{ repository_id: 77, path: ".github/workflows/ai-usage-label.yaml", ref: "refs/heads/main" }] } },
  { type: "required_status_checks", ruleset_id: 8, ruleset_source_type: "Repository", parameters: { required_status_checks: [{ context: "build" }, { context: "lint", integration_id: 1 }] } },
];

test("#95: a ruleset with a workflows rule and a required_status_checks rule yields the checks", () => {
  const o = surface(RULESET, OTHER);
  assert.equal(o.error, null);
  assert.deepEqual(o.checks, [
    { type: "workflows", ruleset_id: 7, workflow: "q/actions@refs/heads/main:.github/workflows/ai-usage-label.yaml", check: "AI Usage Label / AI Usage Survey" },
    { type: "required_status_checks", ruleset_id: 8, workflow: null, check: "build" },
    { type: "required_status_checks", ruleset_id: 8, workflow: null, check: "lint" },
  ]);
  // the digest covers the checks
  assert.ok(o.digest);
});

test("#95: a workflows rule on this repo reads the local file (job name, else job id); an unreadable one has check null", () => {
  const rules = [
    { type: "workflows", ruleset_id: 3, parameters: { workflows: [{ repository_id: 9, path: ".github/workflows/ci.yml", ref: "refs/heads/main" }, { repository_id: 88, path: "x.yml", ref: "v1" }] } },
  ];
  const o = surface(rules);
  assert.equal(o.error, null);
  assert.deepEqual(o.checks, [
    { type: "workflows", ruleset_id: 3, workflow: "m/p@refs/heads/main:.github/workflows/ci.yml", check: "CI / test" },
    { type: "workflows", ruleset_id: 3, workflow: "m/p@refs/heads/main:.github/workflows/ci.yml", check: "CI / Lint all" },
    { type: "workflows", ruleset_id: 3, workflow: "repo 88@v1:x.yml", check: null },
  ]);
});

test("#95: no rules, or a rules read error: checks is empty", () => {
  assert.deepEqual(surface([]).checks, []);
  const e = home({ "repos/m/p": [200, { id: 9, owner: { type: "User" } }], [RULES]: [404, { message: "Not Found" }] });
  try {
    const r = spawnSync(PY, ["-I", join(SCRIPTS_SRC, "ruleset_surface.py"), e.repo, "gh", "m/p", "main"], { encoding: "utf8", env: { PATH: e.bin, HOME: e.bin }, timeout: 120000 });
    const o = JSON.parse(r.stdout);
    assert.ok(o.error);
    assert.deepEqual(o.checks, []);
  } finally {
    rmSync(e.h, { recursive: true, force: true });
  }
});

// The ruleset read stays in the plan's surfaces step (after the planner's first round, as before): plan-audit
// gets the checks in every round, a re-plan round's planner gets them, the plan ref seals them, the opener gets them.
function withChecks(s, checks) {
  for (const sfx of ["", ":audit-fix"])
    s["infra:ruleset-surface:plan" + sfx] = (p) => ({ status: "ok", reason: "read", surface: [], sources: [], read: ["rules/branches/main: 3 rule(s)"], unreadable: [], checks, error: null, args: inputsOf(p).args });
  return s;
}
test("#95: plan-audit, a re-plan round's planner and the PR opener get the required checks; the plan ref seals them", async () => {
  const o = surface(RULESET, OTHER);
  const s = withChecks(happy(), o.checks);
  let n = 0;
  const ok = s["role:plan-audit"];
  s["role:plan-audit"] = (...a) => (n++ === 0 ? { status: "ok", reason: "x", verdict: "plan_defect", routed_findings: [{ target: "plan", criterion: null, finding: "the AI Usage Survey check is not an obligation" }] } : typeof ok === "function" ? ok(...a) : ok);
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const want = o.checks.map((c) => ({ workflow: c.workflow, check: c.check }));
  assert.equal(inputsOf(call(out, "role:scope-and-plan").prompt).required_checks, undefined, "round 0 runs before the ruleset read");
  assert.deepEqual(inputsOf(call(out, "role:scope-and-plan:audit-fix").prompt).required_checks, want);
  assert.deepEqual(inputsOf(call(out, "role:plan-audit").prompt).required_checks, want);
  assert.deepEqual(inputsOf(call(out, "role:fleet-pr-opener").prompt).required_checks, want);
  assert.ok(out.plan.logs.includes("ruleset required checks: AI Usage Label / AI Usage Survey (q/actions@refs/heads/main:.github/workflows/ai-usage-label.yaml), build, lint"), out.plan.logs.join("\n"));
});

test("#95: with no required checks no role gets the key (prompts unchanged)", async () => {
  const out = await run(withChecks(happy(), []), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  for (const l of ["role:scope-and-plan", "role:plan-audit", "role:fleet-pr-opener"]) assert.equal(inputsOf(call(out, l).prompt).required_checks, undefined, l);
});
