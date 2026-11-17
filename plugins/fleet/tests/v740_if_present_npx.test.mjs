// fleet 7.4.0 car 5, extra items from the car-4 report and its security review.
// - Z2 (security, hook_surface.py N1): the `--if-present` skip of a nested run of a missing script
//   was fail-open: a segment with -w/--workspace/--workspaces/--prefix/-C/--filter/-r/--recursive,
//   an `--if-present` after `--`, an env prefix, or a cd/pushd/subshell earlier in the script text
//   may run that script in another package. The skip now holds only for the exact forms
//   `npm|pnpm|yarn run --if-present X` and `... run X --if-present`, alone in their segment, with no
//   cd/pushd/popd/export/npm_config/subshell/backtick/--prefix earlier in the text. Every other
//   missing script drops the npm:<name> entry (fail closed). New skip = old skip AND the exact form,
//   so every entry the old rule dropped stays dropped (checked below with the old rule frozen).
// - Z1 (#39 extension): plan mode guards `npx jest|vitest`: with no tracked
//   package.json at the worktree root, npx resolves the main checkout's prefix. The plan
//   hook-surface read asks for the `pkg:package.json` target; no entry is a plan finding through
//   planFindingsStop, as for the J1 npm walk-up guard.
//
// dont_care: the finding's wording after "npx would resolve".

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ARGS, SCRIPTS_SRC, happy, runOne, call, inputsOf, spawnSync } from "./harness.mjs";

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-740z-"));
  const env = Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: join(dir, ".gc"), GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
  const wt = join(dir, "wt");
  mkdirSync(wt);
  const g = (...a) => {
    const r = spawnSync("git", ["-C", wt].concat(a), { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
  };
  g("init", "-q", "-b", "main");
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(dirname(join(wt, p)), { recursive: true });
    writeFileSync(join(wt, p), t);
  }
  g("add", "-A");
  g("commit", "-q", "-m", "a", "--allow-empty");
  const hs = (targets) => {
    const r = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "hook_surface.py"), wt, "HEAD", JSON.stringify(targets)], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.error, null);
    return o.make_paths;
  };
  return { hs };
}
const pkg = (scripts) => JSON.stringify({ scripts });

// the shipped (aaed9b1) N1 skip, frozen: a nested run of a missing script is skipped when its
// call (up to the next &&, ;, | or newline) holds --if-present
const OLD_RUN = /\b(?:npm|pnpm|yarn)[ \t]+(?:run(?:-script)?(?:[ \t]+-\S+)*[ \t]+([A-Za-z0-9_:.][A-Za-z0-9_:.-]*)|(?:test|t)\b)/g;
function oldDrops(scripts, name) {
  // true when the old rule gives no entry for npm:<name> (depth and pre/post ignored: one level)
  const t = scripts[name];
  if (typeof t !== "string") return true;
  for (const m of t.matchAll(OLD_RUN)) {
    const n = m[1] || "test";
    if (n === name) continue;
    const seg = t.slice(m.index).split(/&&|[;|\n]/)[0];
    if (scripts[n] === undefined && seg.indexOf("--if-present") < 0) return true;
  }
  return false;
}

// every form that may target another package, or that is not the exact run form
const BYPASS = [
  "npm run --if-present -w pkg lint",
  "npm run lint --if-present -w pkg",
  "npm run lint --if-present --workspace=pkg",
  "npm run lint --if-present --workspace pkg",
  "npm run lint --if-present --workspaces",
  "npm run --workspaces --if-present lint",
  "npm run lint --if-present --prefix sub",
  "npm run --prefix sub --if-present lint",
  "pnpm run lint --if-present -C sub",
  "pnpm run --filter sub --if-present lint",
  "pnpm run -r --if-present lint",
  "pnpm run lint --if-present --recursive",
  "npm run lint -- --if-present",
  "npm run lint --silent --if-present",
  "npm run-script --if-present lint",
  "npm_config_workspace=pkg npm run --if-present lint",
  "env -C sub npm run --if-present lint",
  "cd sub && npm run --if-present lint",
  "cd sub; npm run lint --if-present",
  "pushd sub && npm run --if-present lint",
  "(cd sub && npm run --if-present lint)",
  "x=$(cd sub) && npm run --if-present lint",
  "x=`pwd` && npm run --if-present lint",
  "export npm_config_prefix=sub; npm run --if-present lint",
  "node a.mjs --prefix sub && npm run --if-present lint",
];
// 7.4.0 review A-m4: yarn left the exact forms (`yarn run X` runs a package binary when the script is missing)
const EXACT = ["npm run --if-present lint", "npm run lint --if-present", "pnpm run --if-present lint", "node a.mjs && npm run --if-present lint", "node a.mjs; npm run lint --if-present"];

test("7.4.0 car 5 Z2: each bypass form of --if-present drops the entry (fail closed)", () => {
  const scripts = { a: "node a.mjs" };
  BYPASS.forEach((t, i) => (scripts["b" + i] = t + " && node a.mjs"));
  const { hs } = repo({ "package.json": pkg(scripts), "a.mjs": "x\n" });
  const mp = hs(BYPASS.map((t, i) => "npm:b" + i));
  BYPASS.forEach((t, i) => assert.equal(mp["npm:b" + i], undefined, JSON.stringify(t) + " -> " + JSON.stringify(mp["npm:b" + i])));
});

test("7.4.0 car 5 Z2: the exact forms still skip a missing script (no change)", () => {
  const scripts = {};
  EXACT.forEach((t, i) => (scripts["e" + i] = t + " && node a.mjs"));
  const { hs } = repo({ "package.json": pkg(scripts), "a.mjs": "x\n" });
  const mp = hs(EXACT.map((t, i) => "npm:e" + i));
  EXACT.forEach((t, i) => assert.deepEqual(mp["npm:e" + i], ["a.mjs"], JSON.stringify(t)));
});

test("7.4.0 car 5 Z2: non-weakening: every entry the shipped rule dropped is still dropped", () => {
  const forms = BYPASS.concat(EXACT, ["npm run lint && npm run x --if-present", "npm run lint", "npm test", "npm run lint --if-present; npm run nope", "yarn run nope"]);
  const scripts = {};
  forms.forEach((t, i) => (scripts["c" + i] = t + " && node a.mjs"));
  const { hs } = repo({ "package.json": pkg(scripts), "a.mjs": "x\n" });
  const mp = hs(forms.map((t, i) => "npm:c" + i));
  let dropped = 0;
  forms.forEach((t, i) => {
    if (oldDrops(scripts, "c" + i)) {
      dropped++;
      assert.equal(mp["npm:c" + i], undefined, "the old rule dropped " + JSON.stringify(t) + "; the new rule must too");
    }
  });
  assert.ok(dropped >= 4, "the corpus holds old refusals: " + dropped);
});

// ---------------------------------------------------------------- Z1: npx at plan time
test("7.4.0 car 5 Z1: hook_surface.py lists pkg:package.json only when a package.json object is tracked at the root", () => {
  assert.deepEqual(repo({ "package.json": pkg({ test: "jest" }) }).hs(["pkg:package.json"])["pkg:package.json"], []);
  assert.equal(repo({ "sub/package.json": pkg({ test: "jest" }) }).hs(["pkg:package.json"])["pkg:package.json"], undefined);
  assert.deepEqual(repo({ "package.json": "{}" }).hs(["pkg:package.json"])["pkg:package.json"], []);
  // a package.json that is not a JSON object is a hook-surface read error (the plan stops at the hooks gate)
});

const hsOut = (mp) => (p) => {
  const i = inputsOf(p);
  return { status: "ok", reason: "read", surface: [], make_paths: mp, error: null, args: [i.worktree, i.rev, JSON.stringify(i.targets)] };
};
const SFX = ["", ":audit-fix", ":audit-fix-2"];
function npxPlan(cmd, mp) {
  const s = happy();
  for (const x of SFX) {
    if (x) s["role:scope-and-plan" + x] = Object.assign({}, s["role:scope-and-plan"]);
    s["role:scope-and-plan" + x] = Object.assign({}, s["role:scope-and-plan" + x], { test_cmd: { command: cmd, paths_placeholder: null, env: {}, tools: [] } });
    s["infra:hook-surface:plan" + x] = hsOut(mp);
  }
  return s;
}

test("7.4.0 car 5 Z1: npx jest|vitest with no tracked root package.json: a re-plan finding, then needs_human", async () => {
  // npm exec is not an allowed test runner (the shape gate refuses it before this read)
  for (const cmd of ["npx jest", "npx vitest run"]) {
    const out = await runOne(npxPlan(cmd, {}), ARGS);
    assert.equal(out.result.status, "needs_human", cmd + ": " + out.result.reason);
    assert.match(out.result.reason, /npx would resolve the main checkout/, cmd);
    assert.deepEqual(inputsOf(call(out, "infra:hook-surface:plan").prompt).targets, ["pkg:package.json"], cmd);
    const pr = inputsOf(call(out, "role:scope-and-plan:audit-fix").prompt).prior_round;
    assert.ok(pr.findings.some((f) => /npx would resolve/.test(f.finding)), JSON.stringify(pr.findings));
  }
});

test("7.4.0 car 5 Z1: a tracked root package.json gives no finding; pytest asks for no pkg target", async () => {
  const ok = await runOne(npxPlan("npx jest", { "pkg:package.json": [] }), ARGS);
  assert.equal(ok.result.status, "awaiting_confirmation", ok.result.reason);
  assert.ok(!ok.labels.includes("role:scope-and-plan:audit-fix"), ok.labels.join(", "));
  const py = await runOne(happy(), ARGS);
  assert.deepEqual(inputsOf(call(py, "infra:hook-surface:plan").prompt).targets, []);
});
