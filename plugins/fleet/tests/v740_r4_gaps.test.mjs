// fleet 7.4.0 car 4 (#29, L2084): the five R4 gaps the 6.1.0 CHANGELOG listed as known. Each one
// makes the update-branch refusal R4 refuse more; none makes it accept more.
// - N1: hook_surface.py follows a nested `npm|pnpm|yarn run X` (and `npm test`) inside the script
//   text, depth 3, with a visited set; a nested run of a missing script, or a chain deeper than 3,
//   drops the whole npm:<name> entry (R4 then refuses every moved file).
// - N2: a directory a script or a make recipe names is listed as "dir/"; R4 matches every path
//   under it. The obligations gate (cmdRuns without the R4 flag) keeps its exact-path match.
// - N3: `-p mod` (and `-m mod`) in a script or a recipe resolves like hook commands' `-m`
//   (mod.py, mod/__init__.py, mod/__main__.py, parent __init__.py), tracked files only.
// - N4: test_cmd `npx jest|vitest` runs the setup and config files (basename regex).
// - N5: a shell script a command runs adds the tracked files it sources (one level), read at the
//   rev: the new `sh:<path>` target for a script test_cmd or check_cmd, and every tracked shell
//   script a script or a recipe names.
// Non-weakening: the old testCmdRuns/cmdRuns (bc8998b, frozen below) and the old make_paths rule
// (the tracked tokens of the text) are run beside the new ones; every old refusal stays.
//
// dont_care: the order of the paths in a refusal beyond the named one; gate wording after the
// "test or check commands run" phrase.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ARGS, HASHES, CSHA, SCRIPTS_SRC, SOURCE, compile, happy, run, call, inputsOf, spawnSync } from "./harness.mjs";

// ---------------------------------------------------------------- hook_surface.py on a real repo
function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-740r4-"));
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
  g("commit", "-q", "-m", "a");
  const hs = (targets) => {
    const r = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "hook_surface.py"), wt, "HEAD", JSON.stringify(targets)], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.error, null);
    return o.make_paths;
  };
  return { hs, tracked: Object.keys(files) };
}
const pkg = (scripts) => JSON.stringify({ scripts });
const TOK = /[A-Za-z0-9_.][A-Za-z0-9_./-]*/g;
// the 6.1.0 rule, frozen: the tracked tokens of the text (no entry when package.json or the script is unreadable)
function oldPaths(text, tracked) {
  const out = new Set();
  for (const tok of text.match(TOK) || []) {
    const q = tok.replace(/^(\.\/)+/, "");
    if (tracked.indexOf(q) >= 0) out.add(q);
  }
  return Array.from(out).sort();
}
function superset(nw, old, what) {
  for (const p of old) assert.ok(Array.isArray(nw) && nw.indexOf(p) >= 0, what + ": the old rule listed " + p + "; new " + JSON.stringify(nw));
}

test("7.4.0 #29 N1: hook_surface.py follows a nested npm/pnpm/yarn run, depth 3, with pre/post and a visited set", () => {
  const files = {
    "package.json": pkg({ test: "npm run build && jest", build: "pnpm run -s gen", pregen: "node tools/pre.mjs", gen: "yarn run gen2 && node tools/gen.mjs", gen2: "node tools/gen2.mjs && npm run build", loop: "npm run loop2", loop2: "npm run loop && node tools/l.mjs" }),
    "tools/pre.mjs": "x\n",
    "tools/gen.mjs": "x\n",
    "tools/gen2.mjs": "x\n",
    "tools/l.mjs": "x\n",
  };
  const { hs, tracked } = repo(files);
  const mp = hs(["npm:test", "npm:loop"]);
  assert.deepEqual(mp["npm:test"], ["tools/gen.mjs", "tools/gen2.mjs", "tools/pre.mjs"]);
  assert.deepEqual(mp["npm:loop"], ["tools/l.mjs"]);
  superset(mp["npm:test"], oldPaths("npm run build && jest", tracked), "N1 test");
});

test("7.4.0 #29 N1: a nested run of a missing script, or a chain deeper than 3, drops the entry (fail closed)", () => {
  const { hs } = repo({
    "package.json": pkg({ test: "npm run nope && node a.mjs", deep: "npm run d1", d1: "npm run d2", d2: "npm run d3", d3: "npm run d4", d4: "node a.mjs", three: "npm run d2" }),
    "a.mjs": "x\n",
  });
  const mp = hs(["npm:test", "npm:deep", "npm:three"]);
  assert.equal(mp["npm:test"], undefined);
  assert.equal(mp["npm:deep"], undefined);
  assert.deepEqual(mp["npm:three"], ["a.mjs"]);
});

test("7.4.0 #29 N2: a directory in an npm script or a make recipe is listed as dir/", () => {
  const files = {
    "package.json": pkg({ test: "node --test test/" }),
    "test/a.test.mjs": "x\n",
    "tests/unit/test_b.py": "x\n",
    Makefile: "test:\n\tpytest tests/unit tools/gen.py\n",
    "tools/gen.py": "x\n",
  };
  const { hs, tracked } = repo(files);
  const mp = hs(["npm:test", "test"]);
  assert.deepEqual(mp["npm:test"], ["test/"]);
  assert.deepEqual(mp.test, ["tests/unit/", "tools/gen.py"]);
  superset(mp.test, oldPaths("\tpytest tests/unit tools/gen.py", tracked), "N2 make");
});

test("7.4.0 #29 N3: pytest -p mod in a recipe or a script resolves to the module files", () => {
  const files = {
    "package.json": pkg({ test: "pytest -pplugs.two" }),
    Makefile: "test:\n\tpytest -p myplug -p no:cacheprovider tests\n",
    "myplug.py": "x\n",
    "plugs/__init__.py": "",
    "plugs/two.py": "x\n",
    "tests/test_a.py": "x\n",
  };
  const { hs } = repo(files);
  const mp = hs(["test", "npm:test"]);
  assert.deepEqual(mp.test, ["myplug.py", "tests/"]);
  assert.deepEqual(mp["npm:test"], ["plugs/__init__.py", "plugs/two.py"]);
});

test("7.4.0 #29 N5: sh:<path> lists the files the script sources; a script named in a recipe adds its sources", () => {
  const files = {
    "scripts/test.sh": '#!/bin/sh\nset -e\n. "$(dirname "$0")/common.sh"\nsource scripts/lib.sh\nif true; then source ${BASH_SOURCE%/*}/more.sh; fi\n. /etc/profile\nrun_tests\n',
    "scripts/common.sh": "x=1\n",
    "scripts/lib.sh": "y=1\n",
    "scripts/more.sh": "z=1\n",
    "scripts/check": "#!/usr/bin/env bash\nsource scripts/lib.sh\n",
    Makefile: "test:\n\tbash scripts/test.sh\nlint:\n\tscripts/check\n",
  };
  const { hs, tracked } = repo(files);
  const mp = hs(["sh:scripts/test.sh", "sh:scripts/nope.sh", "sh:scripts/check", "test", "lint"]);
  assert.deepEqual(mp["sh:scripts/test.sh"], ["scripts/common.sh", "scripts/lib.sh", "scripts/more.sh"]);
  assert.equal(mp["sh:scripts/nope.sh"], undefined, "an unreadable script has no entry");
  assert.deepEqual(mp["sh:scripts/check"], ["scripts/lib.sh"]);
  assert.deepEqual(mp.test, ["scripts/common.sh", "scripts/lib.sh", "scripts/more.sh", "scripts/test.sh"]);
  assert.deepEqual(mp.lint, ["scripts/check", "scripts/lib.sh"]);
  superset(mp.test, oldPaths("\tbash scripts/test.sh", tracked), "N5 make");
});

test("7.4.0 #29 non-weakening: hook_surface.py make_paths hold every path the 6.1.0 rule listed; an old missing entry stays missing", () => {
  const scripts = { test: "node scripts/run.mjs --ci && npm run lint", pretest: "tsc -p tsconfig.json", lint: "eslint src/a.js", other: "node --test test/" };
  const files = { "package.json": pkg(scripts), "scripts/run.mjs": "x\n", "tsconfig.json": "{}\n", "src/a.js": "x\n", "test/b.test.mjs": "x\n", Makefile: "test:\n\tpython3 tools/g.py src/a.js\n", "tools/g.py": "x\n" };
  const { hs, tracked } = repo(files);
  const mp = hs(["npm:test", "npm:other", "npm:missing", "test", "nomake"]);
  superset(mp["npm:test"], oldPaths(scripts.test + "\n" + scripts.pretest, tracked), "npm:test");
  superset(mp["npm:other"], oldPaths(scripts.other, tracked), "npm:other");
  superset(mp.test, oldPaths("\tpython3 tools/g.py src/a.js", tracked), "make test");
  assert.equal(mp["npm:missing"], undefined);
  assert.deepEqual(mp.nomake, []);
  // no package.json at all: no npm entry, as before
  const bare = repo({ "a.txt": "x\n" });
  assert.deepEqual(bare.hs(["npm:test"]), {});
});

// ---------------------------------------------------------------- testCmdRuns and cmdRuns
async function fns() {
  const src = SOURCE.replace(/^export const meta/m, "const meta").replace("\nlet input = args;\n", "\nreturn { testCmdRuns, cmdRuns, testRunnerPrefix, parseCheckCmd, relPath, normPath, PATHS_TOKEN };\nlet input = args;\n");
  return compile(src)(null, null, null, () => {}, () => {}, {}, {}, {}, Date, Math);
}
// testCmdRuns, cmdRuns and their tables at bc8998b (6.1.0 to 7.4.0 car 3), byte for byte
const OLD = `
const TEST_INPUTS = {
  pytest: ["pyproject.toml", "setup.py", "uv.lock", "poetry.lock", "Pipfile.lock"],
  npm: ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", ".npmrc"],
  jest: ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", ".npmrc"],
  cargo: ["Cargo.toml", "Cargo.lock", "build.rs", "config", "config.toml"],
  go: ["go.mod", "go.sum", "go.work"],
};
function npmTargetOf(cmd) {
  const t = String(cmd || "").trim().split(/[ \\t]+/);
  if ((t[0] === "npm" || t[0] === "pnpm" || t[0] === "yarn") && t[1] === "test") return "npm:test";
  if (t[0] === "npm" && t[1] === "run" && t[2]) return "npm:" + t[2];
  return null;
}
function testCmdRuns(cmd, p, makePaths) {
  const t = String(cmd || "").trim().split(/[ \\t]+/).filter((x) => x && x !== PATHS_TOKEN);
  if (!t.length) return true;
  const b = p.split("/").pop();
  const script = (x) => (x && x.charAt(0) !== "-" && relPath(x) ? normPath(relPath(x)) === p : true);
  if (/^(ba|da|k|z)?sh$/.test(t[0])) return script(t[1]);
  if ((t[0] === "python" || t[0] === "python3") && t[1] !== "-m") return script(t[1]);
  if (t[0].indexOf("/") >= 0) return script(t[0]);
  const pre = testRunnerPrefix(t);
  if (!pre) return true;
  if (pre.kind === "make") return cmdRuns("make " + t[1], p, makePaths);
  if (pre.kind === "npm") {
    const np = makePaths ? makePaths[npmTargetOf(t.join(" "))] : null;
    if (!Array.isArray(np)) return true;
    return TEST_INPUTS.npm.indexOf(b) >= 0 || np.indexOf(p) >= 0;
  }
  if (pre.kind === "cargo" && (b === "config" || b === "config.toml")) return p.split("/").slice(-2, -1)[0] === ".cargo";
  return !TEST_INPUTS[pre.kind] || TEST_INPUTS[pre.kind].indexOf(b) >= 0;
}
function cmdRuns(cmd, p, makePaths) {
  const words = cmd.trim().split(/[ \\t]+/);
  const script = parseCheckCmd(cmd).script || null;
  const b = p.split("/").pop();
  const recipe = words[0] === "make" && makePaths && Array.isArray(makePaths[words[1]]) ? makePaths[words[1]] : [];
  return !!(
    (script && p === normPath(script)) ||
    (words[0] === "make" && (/^(GNUmakefile|makefile|Makefile)$/.test(b) || /\\.mk$/.test(b) || recipe.indexOf(p) >= 0)) ||
    (words[0] === "pre-commit" && b === ".pre-commit-config.yaml")
  );
}
return { testCmdRuns, cmdRuns };
`;
async function oldFns() {
  const f = await fns();
  return new Function("testRunnerPrefix", "parseCheckCmd", "relPath", "normPath", "PATHS_TOKEN", OLD)(f.testRunnerPrefix, f.parseCheckCmd, f.relPath, f.normPath, f.PATHS_TOKEN);
}
const CMDS = ["npm test", "npm run test:unit", "pnpm test", "yarn test", "npx jest <paths>", "npx vitest run", "pytest <paths>", "python3 -m pytest -p no:cacheprovider <paths>", "uv run pytest <paths>", "make test", "make lint", "bash scripts/test.sh", "scripts/test.sh <paths>", "sh ./scripts/t.sh", "sh -e scripts/t.sh", "python3 tools/run.py", "cargo test", "go test ./...", "weird <paths>", "bash", ""];
const PATHS = ["package.json", "web/package.json", ".npmrc", "jest.setup.js", "src/setupTests.ts", "a.setup.mjs", "vitest.config.ts", "jest.config.cjs", "scripts/test.sh", "scripts/t.sh", "scripts/lib.sh", "test/a.test.mjs", "tests/test_b.py", "tools/gen.py", "tools/run.py", "myplug.py", "src/x.py", "src/x.js", "pyproject.toml", "uv.lock", "Cargo.toml", ".cargo/config.toml", "crates/a/config", "go.mod", "mk/x.mk", "Makefile", ".pre-commit-config.yaml", "scripts/check.sh"];
const FULL = { "npm:test": ["scripts/run.mjs", "test/"], "npm:test:unit": ["test/", "tools/gen.py"], test: ["tests/", "tools/gen.py", "myplug.py"], lint: ["tools/gen.py"], "sh:scripts/test.sh": ["scripts/lib.sh"], "sh:scripts/t.sh": [], "sh:scripts/check.sh": ["scripts/lib.sh"] };
const NULLS = { "npm:test": null, "npm:test:unit": null, test: [], "sh:scripts/test.sh": null, "sh:scripts/t.sh": null, "sh:scripts/check.sh": null };
const MPS = [undefined, {}, FULL, NULLS];

test("7.4.0 #29 non-weakening: every (test_cmd, path, make_paths) the old testCmdRuns refused is still refused", async () => {
  const nw = await fns();
  const old = await oldFns();
  let n = 0;
  for (const c of CMDS)
    for (const p of PATHS)
      for (const mp of MPS)
        if (old.testCmdRuns(c, p, mp)) {
          n++;
          assert.equal(nw.testCmdRuns(c, p, mp), true, JSON.stringify([c, p, mp]));
        }
  assert.ok(n > 200, "the cross product exercises old refusals: " + n);
});

test("7.4.0 #29 non-weakening: cmdRuns without the R4 flag is the old cmdRuns; with it, every old hit stays", async () => {
  const nw = await fns();
  const old = await oldFns();
  for (const c of ["make test", "make lint", "make other", "scripts/check.sh", "scripts/test.sh", "python3 tools/gen.py", "uv run python tools/gen.py", "pre-commit run x"])
    for (const p of PATHS)
      for (const mp of MPS) {
        const o = old.cmdRuns(c, p, mp);
        assert.equal(nw.cmdRuns(c, p, mp), o, "obligations gate unchanged: " + JSON.stringify([c, p, mp]));
        if (o) assert.equal(nw.cmdRuns(c, p, mp, true), true, "R4: " + JSON.stringify([c, p, mp]));
      }
});

test("7.4.0 #29 N2, N4, N5: testCmdRuns refuses a path under a dir entry, a jest setup file, a sourced shell lib; unread fails closed", async () => {
  const { testCmdRuns: runs, cmdRuns } = await fns();
  // N2
  assert.equal(runs("npm test", "test/a.test.mjs", FULL), true);
  assert.equal(runs("npm test", "testx/a.mjs", FULL), false, "a dir entry is a path prefix with its slash");
  assert.equal(runs("make test", "tests/sub/test_c.py", FULL), true);
  assert.equal(cmdRuns("make test", "tests/sub/test_c.py", FULL), false, "the obligations gate keeps exact paths");
  assert.equal(cmdRuns("make test", "tests/sub/test_c.py", FULL, true), true);
  // N4
  for (const p of ["jest.setup.js", "web/vitest.setup.ts", "jest.config.cjs", "vitest.config.mts", "src/setupTests.ts", "test/db.setup.mjs"]) {
    assert.equal(runs("npx jest <paths>", p, {}), true, p);
    assert.equal(runs("npx vitest run", p, {}), true, p);
  }
  assert.equal(runs("npx jest <paths>", "src/x.js", {}), false);
  assert.equal(runs("npx jest <paths>", "src/setup.js", {}), false);
  // N5
  assert.equal(runs("bash scripts/test.sh", "scripts/lib.sh", FULL), true);
  assert.equal(runs("scripts/test.sh <paths>", "scripts/lib.sh", FULL), true);
  assert.equal(runs("scripts/test.sh <paths>", "src/x.py", FULL), false);
  assert.equal(runs("scripts/test.sh <paths>", "src/x.py", NULLS), true, "an unread script fails closed");
  assert.equal(runs("scripts/test.sh <paths>", "src/x.py", {}), true, "no sh: entry fails closed");
  assert.equal(cmdRuns("scripts/check.sh", "scripts/lib.sh", FULL, true), true);
  assert.equal(cmdRuns("scripts/check.sh", "src/x.py", FULL, true), false);
  assert.equal(cmdRuns("scripts/check.sh", "src/x.py", NULLS, true), true);
  assert.equal(cmdRuns("python3 tools/gen.py", "src/x.py", {}, true), false, "a python check script reads no sh: entry");
});

// ---------------------------------------------------------------- R4 in the workflow
const D = "d".repeat(40);
const C = "c".repeat(40);
const C2 = CSHA(2);
const DEFAULT_CAPS = { pr_ready: true, ci_watch: true, ci_watch_minutes: 60, stats: true, merge: "never", update_branch: "never", ci_trigger: false, review_post: "none" };
const PERSONAL = Object.assign({}, DEFAULT_CAPS, { merge: "auto", update_branch: "once", ci_trigger: true });
const polOut = (over) => (p) => Object.assign({ status: "ok", reason: "read", profile: null, file: "/h/p.json", policy_sha256: null, caps: Object.assign({}, DEFAULT_CAPS), matched: "x", error: null, now: 1000, args: inputsOf(p).args }, over);
const BEHIND = (p) => {
  const a = inputsOf(p).args;
  return { status: "ok", reason: "b", mode: "merge", merged: false, auto_enabled: false, method: "squash", merge_sha: null, blocked: "behind", merge_state: "BEHIND", head: a[4], branch_deleted: null, error: null, args: a };
};
const F1 = { id: "F1", severity: "blocking", category: "correctness", file: "src/x.py", line: 1, summary: "the merge broke x", evidence: "e" };
const review = (verdict) => ({ status: "ok", reason: verdict, verdict, findings: verdict === "approve" ? [] : [F1], touches_gate: false, checked: [] });
// as v610_update_coder: the green PR is behind; update-branch merges to D; the re-review u1 requests changes
function upd(moved, over) {
  const t = happy();
  t["infra:policy"] = polOut({ profile: "personal", caps: PERSONAL });
  t["infra:pr-merge"] = BEHIND;
  t["infra:pr-update"] = (p) => ({ status: "ok", reason: "u", mode: "update", updated: true, head: D, base: C, overlap: ["src/x.py"], error: null, args: inputsOf(p).args });
  Object.assign(t, {
    "hasher:update:u1": { status: "ok", fingerprint: { head: D, tree: "KU" }, hashes: HASHES, changed: moved },
    "infra:review-paths:v2": { status: "ok", reason: "listed", changed_paths: ["src/x.py", "tests/test_a.py"] },
    "hasher:pre-review:v2": { status: "ok", fingerprint: { head: D, tree: "KU" } },
    "role:pr-review:v2": review("changes_requested"),
    "hasher:fp-post:pr-review:v2": { status: "ok", fingerprint: { head: D, tree: "KU" } },
    "infra:review-cleanup:v2": { status: "ok", reason: "clean" },
    "role:fleet-coder:r2": { status: "ok", reason: "fixed", changed_paths: ["src/x.py"], suite_result: { command: "pytest", exit_code: 0 } },
    "hasher:post-coder:r2": { status: "ok", fingerprint: { head: D, tree: "K2" }, hashes: HASHES, changed: ["src/x.py"] },
    "role:fleet-code-judge:r2": { status: "ok", reason: "good", verdict: "approve", routed_findings: [], suite_result: { command: "pytest", exit_code: 0 } },
    "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: { head: D, tree: "K2" } },
    "infra:push:p2": (p) => ({ status: "ok", reason: "pushed", push_result: "ok", remote_head: inputsOf(p).approved_sha }),
    "role:fleet-pr-opener:p2": { status: "ok", reason: "updated", pr_url: "https://github.com/o/r/pull/7", pr_number: 7, created: false, template_used: null, gates_not_run_stated: true },
    "infra:review-paths:v3": { status: "ok", reason: "listed", changed_paths: ["src/x.py", "tests/test_a.py"] },
    "hasher:pre-review:v3": { status: "ok", fingerprint: { head: C2, tree: "K2" } },
    "role:pr-review:v3": review("approve"),
    "hasher:fp-post:pr-review:v3": { status: "ok", fingerprint: { head: C2, tree: "K2" } },
    "infra:review-cleanup:v3": { status: "ok", reason: "clean" },
  });
  return Object.assign(t, over || {});
}
const hsOut = (mp) => (p) => {
  const i = inputsOf(p);
  return { status: "ok", reason: "read", surface: [], make_paths: mp, error: null, args: [i.worktree, i.rev, JSON.stringify(i.targets)] };
};
function withTc(t, cmd) {
  t["role:scope-and-plan"].test_cmd = { command: cmd, paths_placeholder: cmd.indexOf("<paths>") >= 0 ? "<paths>" : null, env: {}, tools: [] };
  return t;
}
function withOb(t, cmd) {
  t["role:scope-and-plan"].repo_obligations = [{ id: "OB1", kind: "other", rule_source: "Makefile", files: [], instruction: "lint", check_cmd: cmd }];
  for (const k of ["role:fleet-code-judge:r1", "role:fleet-code-judge:r2"]) t[k] = Object.assign({}, t[k], { obligations_check: [{ id: "OB1", met: true, evidence: "ran", check_exit: 0 }] });
  t["infra:check-scripts"] = (p) => ({ status: "ok", reason: "checked", checks: Object.fromEntries(inputsOf(p).paths.map((x) => [x, { ok: true, reason: "ok" }])) });
  for (const m of [1, 2]) t["infra:check-scripts:r" + m] = t["infra:check-scripts"];
  return t;
}
async function refused(t, why) {
  const out = await run(t, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "review", out.result.reason);
  assert.match(out.result.reason, /the base change touches files the test or check commands run \(/);
  assert.match(out.result.reason, why);
  assert.ok(!out.build.labels.includes("role:fleet-coder:r2"), out.build.labels.join(", "));
  return out;
}
async function passes(t) {
  const out = await run(t, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.build.labels.includes("role:fleet-coder:r2"));
  return out;
}

test("7.4.0 #29 N1+N2: npm test whose nested script names test/: a base change under test/ refuses R4; an unrelated file does not", async () => {
  const t = withTc(upd(["src/x.py", "test/a.test.mjs"], { "infra:hook-surface:u1:d": hsOut({ "npm:test": ["tools/gen.mjs", "test/"] }) }), "npm test");
  const r = await refused(t, /\(test\/a\.test\.mjs\)/);
  assert.deepEqual(inputsOf(call(r, "infra:hook-surface:u1:d").prompt).targets, ["npm:test"]);
  await refused(withTc(upd(["src/x.py", "tools/gen.mjs"], { "infra:hook-surface:u1:d": hsOut({ "npm:test": ["tools/gen.mjs", "test/"] }) }), "npm test"), /\(tools\/gen\.mjs\)/);
  await passes(withTc(upd(["src/x.py", "testx/a.mjs"], { "infra:hook-surface:u1:d": hsOut({ "npm:test": ["tools/gen.mjs", "test/"] }) }), "npm test"));
  // N1 fail closed: the program dropped the entry
  await refused(withTc(upd(["src/x.py"], { "infra:hook-surface:u1:d": hsOut({}) }), "npm test"), /\(src\/x\.py\)/);
});

test("7.4.0 #29 N2+N3: make test whose recipe names tests/ and -p myplug: a base change there refuses R4", async () => {
  const pb = { "infra:hook-surface:u1:pb": hsOut({ test: ["myplug.py", "tests/"] }) };
  await refused(withTc(upd(["src/x.py", "tests/sub/test_c.py"], pb), "make test"), /\(tests\/sub\/test_c\.py\)/);
  await refused(withTc(upd(["src/x.py", "myplug.py"], pb), "make test"), /\(myplug\.py\)/);
  await passes(withTc(upd(["src/x.py", "testsuite.txt"], pb), "make test"));
  // a check_cmd make target with a dir entry refuses too (R4 only)
  const ob = withOb(withTc(upd(["src/x.py", "lib/a/b.py"], { "infra:hook-surface:u1:pb": hsOut({ lint: ["lib/"] }) }), "pytest <paths>"), "make lint");
  await refused(ob, /\(lib\/a\/b\.py\)/);
});

test("7.4.0 #29 N4: npx jest: a base change of jest.setup.js or setupTests.ts refuses R4; src/x.js does not", async () => {
  await refused(withTc(upd(["src/x.py", "jest.setup.js"]), "npx jest <paths>"), /\(jest\.setup\.js\)/);
  await refused(withTc(upd(["src/x.py", "web/src/setupTests.ts"]), "npx jest <paths>"), /\(web\/src\/setupTests\.ts\)/);
  await passes(withTc(upd(["src/x.py", "src/x.js"]), "npx jest <paths>"));
});

test("7.4.0 #29 N5: check_cmd scripts/check.sh sourcing scripts/lib.sh: a base change of the lib refuses R4; unread fails closed", async () => {
  const d = (mp) => ({ "infra:hook-surface:u1:d": hsOut(mp) });
  const r = await refused(withOb(upd(["src/x.py", "scripts/lib.sh"], d({ "sh:scripts/check.sh": ["scripts/lib.sh"] })), "scripts/check.sh"), /\(scripts\/lib\.sh\)/);
  const i = inputsOf(call(r, "infra:hook-surface:u1:d").prompt);
  assert.deepEqual([i.rev, i.targets], [D, ["sh:scripts/check.sh"]]);
  await passes(withOb(upd(["src/x.py", "scripts/other.sh"], d({ "sh:scripts/check.sh": ["scripts/lib.sh"] })), "scripts/check.sh"));
  await refused(withOb(upd(["src/x.py"], d({})), "scripts/check.sh"), /\(src\/x\.py\)/);
  // a python check script asks for no sh: entry; pytest asks for no read at d
  const py = await run(withOb(upd(["src/x.py"]), "python3 tools/gen.py"), ARGS);
  assert.ok(!py.build.labels.includes("infra:hook-surface:u1:d"), py.build.labels.join(", "));
});
