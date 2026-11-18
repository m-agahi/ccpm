// fleet 8.0.0 car A (yaadgaar #71): the remaining R4 hook-input gaps. Each fix makes the
// update-branch refusal R4 refuse more; none makes it accept more.
// - G1: an npm:<name> entry whose script texts run jest or vitest also lists the setup files the
//   package.json `jest` key and the root jest/vitest/vite config files name (tracked files, with
//   `<rootDir>/` and a missing .js/.ts/... extension resolved) and those config files. A config that
//   is not JSON is read as text: every tracked file it names. testCmdRuns: an npm test_cmd also
//   refuses a jest/vitest setup or config file by basename (JEST_SETUP_RE), as `npx jest` did.
// - G2: an npm, pnpm or yarn call with --prefix, --workspace(s), -w, -C, --dir, --filter, -F, -r,
//   --recursive or --cwd anywhere in its command segment, or `yarn workspace(s)`, runs another
//   package's script: the entry is dropped (R4 refuses every moved file).
// - G3: a bare nested `yarn <word>` or `pnpm <word>` is followed when <word> is a key of scripts.
// - G4: a sourced shell path built from a variable that resolves to no tracked file drops the entry
//   (sh: and npm: targets). A make entry is never dropped: it keeps every path it resolved (the
//   obligations gate reads them) and adds the mark "/:incomplete", which R4 reads as every file. A
//   make entry the workflow did not get (null) is every file for both gates (security review).
// - G5: a Python script a command runs adds the tracked modules it imports (transitively, from the
//   script's dir, the repo root and the importing file's dir): the new py:<path> target for a
//   `python|python3 <file>` (or `uv run [--extra x] python <file>`) test_cmd or check_cmd, read at
//   the update head, and every Python file a script or a make recipe names. A file that does not
//   parse, or a py: script that cannot be read, drops the entry.
// Non-weakening: the 7.4.0 hook_surface.py (931e844, tests/fixtures/hook_surface_740.py) runs beside
// the new one on the same repos: every old entry is a subset of the new one, or (npm:, sh:, py: only)
// the new entry is dropped (fail closed). The 7.4.0 testCmdRuns/cmdRuns (tests/fixtures/r4_fns_740.js)
// run beside the new ones over a cross product: every old refusal stays; cmdRuns without the R4 flag
// is unchanged but for a null make entry, which is now every file.
//
// dont_care: the order of the paths in a refusal beyond the named one; gate wording after the
// "test or check commands run" phrase.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ARGS, HASHES, CSHA, HERE, SCRIPTS_SRC, SOURCE, compile, happy, run, call, inputsOf, spawnSync } from "./harness.mjs";

const OLD_HS = join(HERE, "fixtures", "hook_surface_740.py");
const NEW_HS = join(SCRIPTS_SRC, "hook_surface.py");

// ---------------------------------------------------------------- hook_surface.py on a real repo
function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-800r4-"));
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
  const by = (prog, targets) => {
    const r = spawnSync("python3", ["-I", prog, wt, "HEAD", JSON.stringify(targets)], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.error, null);
    return o.make_paths;
  };
  // the new program's entries; every old entry is a subset of the new one, or the new one is dropped
  const hs = (targets) => {
    const nw = by(NEW_HS, targets);
    const old = by(OLD_HS, targets);
    for (const t of Object.keys(old)) {
      if (!(t in nw)) {
        assert.match(t, /^(npm|sh|py):/, t + ": only an npm:, sh: or py: entry may be dropped");
        continue;
      }
      for (const p of old[t]) assert.ok(pathsHit(nw[t], p), t + ": the 7.4.0 program listed " + p + "; new " + JSON.stringify(nw[t]));
    }
    for (const t of Object.keys(nw)) assert.ok(t in old || /^py:/.test(t), t + ": a new entry where 7.4.0 had none");
    return { nw, old };
  };
  return { hs };
}
function pathsHit(list, p) {
  return list.some((x) => x === p || (x.slice(-1) === "/" && p.indexOf(x) === 0));
}
const pkg = (scripts, extra) => JSON.stringify(Object.assign({ scripts }, extra || {}));

test("8.0.0 #71 G1: an npm script that runs jest or vitest lists the setup and config files", () => {
  const jestKey = { setupFiles: ["<rootDir>/test/env.js"], setupFilesAfterEnv: ["./test/after"], globalSetup: "test/gs.js", globalTeardown: "test/gt.ts", testEnvironment: "node" };
  const a = repo({
    "package.json": pkg({ test: "npm run unit", unit: "jest --ci", lint: "eslint ." }, { jest: jestKey }),
    "test/env.js": "x\n",
    "test/after.js": "x\n",
    "test/gs.js": "x\n",
    "test/gt.ts": "x\n",
    "src/x.js": "x\n",
  });
  const r = a.hs(["npm:test", "npm:lint"]).nw;
  assert.deepEqual(r["npm:test"], ["test/after.js", "test/env.js", "test/gs.js", "test/gt.ts"]);
  assert.deepEqual(r["npm:lint"], [], "a script that runs no jest lists no setup file");
  const b = repo({
    "package.json": pkg({ test: "jest" }),
    "jest.config.js": "module.exports = { setupFilesAfterEnv: ['<rootDir>/test/x.js'], testMatch: ['**/*.test.js'] };\n",
    "jest.config.json": JSON.stringify({ globalSetup: "./tools/gs.js" }),
    "test/x.js": "x\n",
    "tools/gs.js": "x\n",
  });
  assert.deepEqual(b.hs(["npm:test"]).nw["npm:test"], ["jest.config.js", "jest.config.json", "test/x.js", "tools/gs.js"]);
  const c = repo({
    "package.json": pkg({ test: "vitest run" }),
    "vitest.config.ts": "export default { test: { setupFiles: ['./test/vs.ts'] } };\n",
    "vite.config.mjs": "export default { test: { globalSetup: 'test/g.mjs' } };\n",
    "test/vs.ts": "x\n",
    "test/g.mjs": "x\n",
  });
  assert.deepEqual(c.hs(["npm:test"]).nw["npm:test"], ["test/g.mjs", "test/vs.ts", "vite.config.mjs", "vitest.config.ts"]);
});

test("8.0.0 #71 G2: --prefix, --workspace, -C, --cwd and yarn workspace anywhere in the call drop the entry", () => {
  const { hs } = repo({
    "package.json": pkg({
      a: "npm run lint --prefix web && node a.mjs",
      b: "npm --prefix web run lint",
      c: "npm test --workspace w",
      d: "yarn --cwd web lint",
      e: "yarn workspace w lint",
      f: "pnpm -C web lint",
      g: "npm run lint -- --fix",
      h: "node a.mjs && npm run lint --workspaces",
      lint: "node b.mjs",
      test: "node b.mjs",
    }),
    "a.mjs": "x\n",
    "b.mjs": "x\n",
    "web/package.json": pkg({ lint: "node c.mjs" }),
  });
  const { nw, old } = hs(["npm:a", "npm:b", "npm:c", "npm:d", "npm:e", "npm:f", "npm:g", "npm:h"]);
  for (const t of ["npm:a", "npm:b", "npm:c", "npm:d", "npm:e", "npm:f", "npm:h"]) assert.equal(nw[t], undefined, t);
  assert.deepEqual(old["npm:a"], ["a.mjs", "b.mjs", "web/"], "7.4.0 resolved the nested lint against the root package.json");
  assert.deepEqual(nw["npm:g"], ["b.mjs"]);
});

test("8.0.0 #71 G3: a bare nested yarn or pnpm <script> is followed; a builtin or binary is not", () => {
  const { hs } = repo({
    "package.json": pkg({ test: "yarn lint && pnpm gen && yarn tsc", lint: "node l.mjs", gen: "pnpm build", build: "node g.mjs", t3: "pnpm deep", deep: "npm run missing", t4: "yarn install && node l.mjs" }),
    "l.mjs": "x\n",
    "g.mjs": "x\n",
  });
  const { nw, old } = hs(["npm:test", "npm:t3", "npm:t4"]);
  assert.deepEqual(old["npm:test"], []);
  assert.deepEqual(nw["npm:test"], ["g.mjs", "l.mjs"]);
  assert.equal(nw["npm:t3"], undefined, "a followed script that runs a missing script drops the entry");
  assert.deepEqual(nw["npm:t4"], ["l.mjs"]);
});

test("8.0.0 #71 G4: a sourced variable path that resolves to no tracked file drops the entry", () => {
  const { hs } = repo({
    "scripts/t.sh": '#!/bin/sh\n. "$LIB/x.sh"\nrun\n',
    "scripts/e.sh": '#!/bin/sh\nsource "$LIB"\n',
    "scripts/u.sh": '#!/bin/bash\nsource "$(dirname "$0")/lib.sh"\nsource "$ROOT/scripts/lib.sh"\n. /etc/profile\n',
    "scripts/lib.sh": "y=1\n",
    "package.json": pkg({ test: "sh scripts/t.sh", ok: "bash scripts/u.sh" }),
    Makefile: "test:\n\tbash scripts/t.sh\nok:\n\tbash scripts/u.sh\n",
  });
  const { nw, old } = hs(["sh:scripts/t.sh", "sh:scripts/e.sh", "sh:scripts/u.sh", "test", "ok", "npm:test", "npm:ok"]);
  assert.deepEqual([old["sh:scripts/t.sh"], old.test], [[], ["scripts/t.sh"]]);
  for (const t of ["sh:scripts/t.sh", "sh:scripts/e.sh", "npm:test"]) assert.equal(nw[t], undefined, t);
  assert.deepEqual(nw.test, ["scripts/t.sh", "/:incomplete"], "a make entry keeps its paths and is marked");
  assert.deepEqual(nw["sh:scripts/u.sh"], ["scripts/lib.sh"]);
  assert.deepEqual(nw.ok, ["scripts/lib.sh", "scripts/u.sh"]);
  assert.deepEqual(nw["npm:ok"], ["scripts/lib.sh", "scripts/u.sh"]);
});

test("8.0.0 #71 G5: py:<path> lists the tracked modules the script imports; a recipe's Python file adds its imports", () => {
  const { hs } = repo({
    "scripts/check.py": "import os\nimport lib\nfrom pkg import mod\nimport pkg.sub as s\n",
    "scripts/lib.py": "import helper\n",
    "scripts/helper.py": "import lib\n",
    "pkg/__init__.py": "",
    "pkg/mod.py": "from . import sub\n",
    "pkg/sub.py": "x = 1\n",
    "bad.py": "def (\n",
    "tools/run.py": "import util\n",
    "tools/util.py": "x = 1\n",
    "src/x.py": "x = 1\n",
    Makefile: "lint:\n\tpython3 tools/run.py\nbad:\n\tpython3 bad.py\n",
    "package.json": pkg({ check: "python3 scripts/check.py" }),
  });
  const { nw } = hs(["py:scripts/check.py", "py:bad.py", "py:nope.py", "py:tools/run.py", "lint", "bad", "npm:check"]);
  const want = ["pkg/__init__.py", "pkg/mod.py", "pkg/sub.py", "scripts/helper.py", "scripts/lib.py"];
  assert.deepEqual(nw["py:scripts/check.py"], want);
  assert.equal(nw["py:bad.py"], undefined, "a script that does not parse drops the entry");
  assert.equal(nw["py:nope.py"], undefined, "an unreadable script has no entry");
  assert.deepEqual(nw["py:tools/run.py"], ["tools/util.py"]);
  assert.deepEqual(nw.lint, ["tools/run.py", "tools/util.py"]);
  assert.deepEqual(nw.bad, ["bad.py", "/:incomplete"]);
  assert.deepEqual(nw["npm:check"], want.concat(["scripts/check.py"]).sort());
});

test("8.0.0 #71 non-weakening: on the 7.4.0 #29 repos every old entry stays a subset (or the entry is dropped)", () => {
  const { hs } = repo({
    "package.json": pkg({ test: "npm run build && jest", build: "pnpm run -s gen", pregen: "node tools/pre.mjs", gen: "yarn run gen2 && node tools/gen.mjs", gen2: "node tools/gen2.mjs && npm run build", other: "node --test test/", p: "pytest -pplugs.two", ifp: "npm run lint --if-present && node tools/l.mjs", deep: "npm run d1", d1: "npm run d2", d2: "npm run d3", d3: "npm run d4", d4: "node tools/l.mjs" }, { jest: { setupFiles: ["tools/l.mjs"] } }),
    "tools/pre.mjs": "x\n",
    "tools/gen.mjs": "x\n",
    "tools/gen2.mjs": "x\n",
    "tools/l.mjs": "x\n",
    "test/a.test.mjs": "x\n",
    "plugs/__init__.py": "",
    "plugs/two.py": "import json\n",
    "myplug.py": "x\n",
    "tests/test_a.py": "x\n",
    Makefile: "test:\n\tpytest -p myplug -p no:cacheprovider tests\nsh:\n\tbash scripts/test.sh\nlint:\n\tscripts/check\n",
    "scripts/test.sh": '#!/bin/sh\nset -e\n. "$(dirname "$0")/common.sh"\nsource scripts/lib.sh\nif true; then source ${BASH_SOURCE%/*}/more.sh; fi\n. /etc/profile\nrun_tests\n',
    "scripts/common.sh": "x=1\n",
    "scripts/lib.sh": "y=1\n",
    "scripts/more.sh": "z=1\n",
    "scripts/check": "#!/usr/bin/env bash\nsource scripts/lib.sh\n",
  });
  const t = ["npm:test", "npm:other", "npm:p", "npm:ifp", "npm:deep", "npm:missing", "test", "sh", "lint", "nomake", "sh:scripts/test.sh", "sh:scripts/check", "sh:scripts/nope.sh", "pkg:package.json", "pkg:scripts.test"];
  const { nw, old } = hs(t);
  for (const k of t) assert.equal(k in nw, k in old, k + ": no entry is dropped on these repos");
});

// ---------------------------------------------------------------- testCmdRuns and cmdRuns
async function fns() {
  const src = SOURCE.replace(/^export const meta/m, "const meta").replace("\nlet input = args;\n", "\nreturn { testCmdRuns, cmdRuns, testRunnerPrefix, parseCheckCmd, relPath, normPath, PATHS_TOKEN };\nlet input = args;\n");
  return compile(src.replace("return { testCmdRuns, cmdRuns,", "return { obligationFailures, testCmdRuns, cmdRuns,"))(null, null, null, () => {}, () => {}, {}, {}, {}, Date, Math);
}
async function oldFns() {
  const f = await fns();
  const body = readFileSync(join(HERE, "fixtures", "r4_fns_740.js"), "utf8") + "\nreturn { testCmdRuns, cmdRuns };\n";
  return new Function("testRunnerPrefix", "parseCheckCmd", "relPath", "normPath", "PATHS_TOKEN", body)(f.testRunnerPrefix, f.parseCheckCmd, f.relPath, f.normPath, f.PATHS_TOKEN);
}
const CMDS = ["npm test", "npm run test:unit", "pnpm test", "yarn test", "npx jest <paths>", "npx vitest run", "pytest <paths>", "python3 -m pytest -p no:cacheprovider <paths>", "uv run pytest <paths>", "make test", "make lint", "bash scripts/test.sh", "scripts/test.sh <paths>", "sh ./scripts/t.sh", "python3 tools/run.py", "python scripts/check.py", "uv run python scripts/check.py", "uv run --extra dev python tools/run.py", "cargo test", "go test ./...", "weird <paths>", "bash", ""];
const PATHS = ["package.json", "web/package.json", ".npmrc", "jest.setup.js", "src/setupTests.ts", "a.setup.mjs", "vitest.config.ts", "jest.config.cjs", "test/env.js", "scripts/test.sh", "scripts/t.sh", "scripts/lib.sh", "scripts/lib.py", "scripts/check.py", "test/a.test.mjs", "tests/test_b.py", "tools/gen.py", "tools/run.py", "tools/util.py", "myplug.py", "src/x.py", "src/x.js", "pyproject.toml", "uv.lock", "Cargo.toml", ".cargo/config.toml", "go.mod", "mk/x.mk", "Makefile", ".pre-commit-config.yaml"];
const FULL = { "npm:test": ["scripts/run.mjs", "test/", "test/env.js"], "npm:test:unit": ["test/", "tools/gen.py"], test: ["tests/", "tools/gen.py", "myplug.py"], lint: ["tools/gen.py"], "sh:scripts/test.sh": ["scripts/lib.sh"], "sh:scripts/t.sh": [], "py:tools/run.py": ["tools/util.py"], "py:scripts/check.py": ["scripts/lib.py"] };
const NULLS = { "npm:test": null, "npm:test:unit": null, test: null, lint: null, "sh:scripts/test.sh": null, "sh:scripts/t.sh": null, "py:tools/run.py": null, "py:scripts/check.py": null };
const EMPTY = { "npm:test": [], "npm:test:unit": [], test: [], lint: [], "sh:scripts/test.sh": [], "sh:scripts/t.sh": [], "py:tools/run.py": [], "py:scripts/check.py": [] };
const INC = Object.assign({}, FULL, { test: ["tests/", "tools/gen.py", "myplug.py", "/:incomplete"], lint: ["tools/gen.py", "/:incomplete"] });
const MPS = [undefined, {}, FULL, NULLS, EMPTY, INC];

test("8.0.0 #71 non-weakening: every (test_cmd, path, make_paths) the 7.4.0 testCmdRuns refused is still refused", async () => {
  const nw = await fns();
  const old = await oldFns();
  let n = 0;
  let more = 0;
  for (const c of CMDS)
    for (const p of PATHS)
      for (const mp of MPS) {
        const o = old.testCmdRuns(c, p, mp);
        if (o) {
          n++;
          assert.equal(nw.testCmdRuns(c, p, mp), true, JSON.stringify([c, p, mp]));
        } else if (nw.testCmdRuns(c, p, mp)) more++;
      }
  assert.ok(n > 300 && more > 20, "old refusals " + n + ", new refusals " + more);
});

test("8.0.0 #71 non-weakening: cmdRuns without the R4 flag is the 7.4.0 cmdRuns but for a null make entry; with it, every old hit stays", async () => {
  const nw = await fns();
  const old = await oldFns();
  for (const c of ["make test", "make lint", "make other", "scripts/check.sh", "scripts/test.sh", "python3 tools/gen.py", "python3 tools/run.py", "uv run python tools/run.py", "uv run python scripts/check.py", "pre-commit run x"])
    for (const p of PATHS)
      for (const mp of MPS) {
        const o = old.cmdRuns(c, p, mp);
        const nullMake = /^make /.test(c) && mp && mp[c.split(" ")[1]] === null;
        assert.equal(nw.cmdRuns(c, p, mp), nullMake ? true : o, "obligations gate: " + JSON.stringify([c, p, mp]));
        if (old.cmdRuns(c, p, mp, true)) assert.equal(nw.cmdRuns(c, p, mp, true), true, "R4: " + JSON.stringify([c, p, mp]));
      }
});

test("8.0.0 #71 G1, G4, G5: testCmdRuns and cmdRuns (R4) read the new entries; unread fails closed", async () => {
  const { testCmdRuns: runs, cmdRuns } = await fns();
  // G1: npm test refuses a jest/vitest setup or config file by basename
  for (const p of ["jest.setup.js", "web/vitest.config.mts", "src/setupTests.ts", "test/db.setup.mjs"]) assert.equal(runs("npm test", p, EMPTY), true, p);
  assert.equal(runs("npm test", "src/x.js", EMPTY), false);
  assert.equal(runs("npm test", "test/env.js", FULL), true);
  // G4: a make entry marked incomplete is every file for R4; the obligations gate keeps its exact paths
  assert.equal(runs("make test", "src/x.py", INC), true);
  assert.equal(cmdRuns("make lint", "src/x.py", INC, true), true);
  assert.equal(cmdRuns("make lint", "src/x.py", INC), false);
  assert.equal(cmdRuns("make lint", "tools/gen.py", INC), true);
  assert.equal(cmdRuns("make lint", "src/x.py", EMPTY, true), false);
  // a null make entry (not read) is every file for both gates
  assert.equal(runs("make test", "src/x.py", NULLS), true);
  assert.equal(cmdRuns("make lint", "src/x.py", NULLS, true), true);
  assert.equal(cmdRuns("make lint", "src/x.py", NULLS), true);
  // G5: py:<path>
  assert.equal(runs("python3 tools/run.py", "tools/util.py", FULL), true);
  assert.equal(runs("python3 tools/run.py", "src/x.py", FULL), false);
  assert.equal(runs("python3 tools/run.py", "src/x.py", NULLS), true, "an unread script fails closed");
  assert.equal(runs("python3 tools/run.py", "src/x.py", {}), true, "no py: entry fails closed");
  for (const c of ["python3 scripts/check.py", "uv run python scripts/check.py", "uv run --extra dev python scripts/check.py"]) {
    assert.equal(cmdRuns(c, "scripts/lib.py", FULL, true), true, c);
    assert.equal(cmdRuns(c, "scripts/lib.py", FULL), false, "the obligations gate keeps the script path only: " + c);
    assert.equal(cmdRuns(c, "src/x.py", FULL, true), false, c);
    assert.equal(cmdRuns(c, "src/x.py", {}, true), true, c);
  }
});

// ---------------------------------------------------------------- R4 in the workflow
const D = "d".repeat(40);
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
// as v740_r4_gaps: the green PR is behind; update-branch merges to D; the re-review u1 requests changes
function upd(moved, over) {
  const t = happy();
  t["infra:policy"] = polOut({ profile: "personal", caps: PERSONAL });
  t["infra:pr-merge"] = BEHIND;
  t["infra:pr-update"] = (p) => ({ status: "ok", reason: "u", mode: "update", updated: true, head: D, base: "c".repeat(40), overlap: ["src/x.py"], error: null, args: inputsOf(p).args });
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

test("8.0.0 #71 G5: check_cmd python3 tools/gen.py reads py:tools/gen.py at d; a base change of an import refuses R4", async () => {
  const d = (mp) => ({ "infra:hook-surface:u1:d": hsOut(mp) });
  const r = await refused(withOb(upd(["src/x.py", "tools/lib.py"], d({ "py:tools/gen.py": ["tools/lib.py"] })), "python3 tools/gen.py"), /\(tools\/lib\.py\)/);
  const i = inputsOf(call(r, "infra:hook-surface:u1:d").prompt);
  assert.deepEqual([i.rev, i.targets], [D, ["py:tools/gen.py"]]);
  await passes(withOb(upd(["src/x.py", "tools/other.py"], d({ "py:tools/gen.py": ["tools/lib.py"] })), "python3 tools/gen.py"));
  await refused(withOb(upd(["src/x.py"], d({})), "python3 tools/gen.py"), /\(src\/x\.py\)/);
  // (a `python3 <file>` test_cmd is not on the test_cmd allowlist; testCmdRuns reads py: for it all the same)
});

test("8.0.0 #71 G4: a make target marked incomplete (or not read) refuses R4 on every moved file; a listed one does not", async () => {
  const pb = (mp) => ({ "infra:hook-surface:u1:pb": hsOut(mp) });
  await refused(withTc(upd(["src/x.py", "docs/a.md"], pb({})), "make test"), /\(src\/x\.py, docs\/a\.md\)/);
  await refused(withTc(upd(["src/x.py", "docs/a.md"], pb({ test: ["tools/gen.py", "/:incomplete"] })), "make test"), /\(src\/x\.py, docs\/a\.md\)/);
  await passes(withTc(upd(["src/x.py", "docs/a.md"], pb({ test: ["tools/gen.py"] })), "make test"));
  await refused(withOb(withTc(upd(["src/x.py", "docs/a.md"], pb({})), "pytest <paths>"), "make lint"), /\(src\/x\.py, docs\/a\.md\)/);
});

test("8.0.0 #71 G1: npm test: a base change of a jest setup file refuses R4", async () => {
  const d = { "infra:hook-surface:u1:d": hsOut({ "npm:test": [] }) };
  await refused(withTc(upd(["src/x.py", "web/jest.setup.ts"], d), "npm test"), /\(web\/jest\.setup\.ts\)/);
  await passes(withTc(upd(["src/x.py", "docs/a.md"], d), "npm test"));
});

test("8.0.0 #71 security review: the obligations gate fails closed on a null make entry and keeps an incomplete entry's paths", async () => {
  const { obligationFailures } = await fns();
  const ob = { id: "OB1", kind: "other", rule_source: "Makefile", files: ["docs/ok.md"], instruction: "lint", check_cmd: "make lint" };
  const met = [{ id: "OB1", met: true, evidence: "ran", check_exit: 0 }];
  const hits = (changed, mp) => obligationFailures([ob], met, [ob], [], changed, mp).map((f) => f.finding);
  // null (the program's entry was not read): any edit is an obligation hit unless the obligation lists it
  assert.match(hits(["src/x.py"], { lint: null }).join("\n"), /OB1: the change edits src\/x\.py, which check_cmd "make lint" runs/);
  assert.deepEqual(hits(["docs/ok.md"], { lint: null }), []);
  // incomplete: the resolved paths stay hits; other paths are R4's only
  assert.match(hits(["tools/gen.py"], { lint: ["tools/gen.py", "/:incomplete"] }).join("\n"), /OB1: the change edits tools\/gen\.py, which check_cmd/);
  assert.deepEqual(hits(["src/x.py"], { lint: ["tools/gen.py", "/:incomplete"] }), []);
  // npm:, sh: and py: entries never reach the obligations gate: a check script is matched by its own path
  const sh = Object.assign({}, ob, { check_cmd: "scripts/check.sh" });
  for (const mp of [{ "sh:scripts/check.sh": null }, { "py:scripts/check.sh": null }, {}]) {
    assert.deepEqual(obligationFailures([sh], met, [sh], [], ["src/x.py"], mp), []);
    assert.match(obligationFailures([sh], met, [sh], [], ["scripts/check.sh"], mp).map((f) => f.finding).join("\n"), /OB1: the change edits scripts\/check\.sh/);
  }
});
