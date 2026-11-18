// ccpmcwf 8.2.3 (yaadgaar #85): a whole-tree hook red at the plan base is a warning, not a plan stop.
//
// Run wf_3d096689-009 (fleet-smoke-node) stopped at infra:format-plan, stop_gate hooks: the repo's
// always_run / pass_filenames: false `node --test` hook is red at HEAD (the seeded bug the task
// fixes), and plan mode blamed the plan doc. format_files.py plan mode now runs each pre-commit-stage
// hook id alone on the settled doc. A failing file-scoped id is the doc's (halt, id named). A failing
// whole-tree id runs again at HEAD without the doc: red there too is `base_red` (the engine writes a
// warning gate line and goes on); green there is the doc's (halt). Timeouts, an unsettled fixer and
// a hook that fails only with the others keep the 7.3.0 stop. base_red is a digested key.
//
// dont_care: the hook output text; the warning's wording past its prefix; the order of the runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SCRIPTS_SRC, happy, runOne, ARGS, inputsOf, spawnSync, K, redigest } from "./harness.mjs";

const HAS_PC = spawnSync("sh", ["-c", "command -v pre-commit"], { encoding: "utf8" }).status === 0;
const DOC = "docs/plans/p.md";

// a repo whose .pre-commit-config.yaml holds `hooks` (local, language system), committed at HEAD
// with `files`, and an uncommitted plan doc; returns format_files.py plan mode's output
function planRun(hooks, docText, files = {}) {
  const wt = mkdtempSync(join(tmpdir(), "fleet-823-"));
  const scratch = mkdtempSync(join(tmpdir(), "fleet-823s-"));
  try {
    const git = (...a) => assert.equal(spawnSync("git", ["-C", wt, ...a], { encoding: "utf8" }).status, 0, a.join(" "));
    git("init", "-q", "-b", "main");
    const cfg = "repos:\n- repo: local\n  hooks:\n" + hooks.map((h) => "  - " + Object.entries(Object.assign({ name: h.id, language: "system" }, h)).map(([k, v]) => k + ": " + (typeof v === "string" ? JSON.stringify(v) : v)).join("\n    ")).join("\n") + "\n";
    writeFileSync(join(wt, ".pre-commit-config.yaml"), cfg);
    for (const [p, t] of Object.entries(Object.assign({ "README.md": "x\n" }, files))) {
      mkdirSync(join(wt, p, ".."), { recursive: true });
      writeFileSync(join(wt, p), t);
    }
    git("add", "-A");
    git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "init");
    mkdirSync(join(wt, "docs/plans"), { recursive: true });
    writeFileSync(join(wt, DOC), docText);
    const r = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "format_files.py"), wt, JSON.stringify({ mode: "plan", paths: [DOC] }), "[]", scratch, "60"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    o.__doc = readFileSync(join(wt, DOC), "utf8");
    return o;
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}
// a whole-tree test hook that is red at HEAD (the seeded bug), with or without the doc
const RED_TESTS = { id: "unit", entry: "sh -c 'test ! -e src/bug'", always_run: true, pass_filenames: false };
const SEEDED = { "src/bug": "1\n" };

test("8.2.3 #85 (1): a whole-tree hook red at the base: no hook failure, base_red names it", { skip: !HAS_PC }, () => {
  const o = planRun([RED_TESTS], "# plan\n", SEEDED);
  assert.equal(o.ran, true, o.note);
  assert.equal(o.stable, true);
  assert.equal(o.hook_failed, false, o.hook_head);
  assert.deepEqual(o.hook_failures, []);
  assert.deepEqual(o.base_red, ["unit"]);
});

test("8.2.3 #85 (2): a whole-tree hook green at the base and red only with the doc stops (id named)", { skip: !HAS_PC }, () => {
  const o = planRun([{ id: "no-token", entry: "sh -c '! grep -rq FORBIDDEN docs'", always_run: true, pass_filenames: false }], "# plan\nFORBIDDEN\n");
  assert.equal(o.hook_failed, true);
  assert.deepEqual(o.hook_failures, [[DOC, "no-token"]]);
  assert.deepEqual(o.base_red, []);
  assert.match(o.hook_head, /^\[no-token\]/);
});

test("8.2.3 #85 (3): a file-scoped hook failing on the doc stops, with its id; a base-red hook next to it stays base_red", { skip: !HAS_PC }, () => {
  const o = planRun([RED_TESTS, { id: "no-todo", entry: "sh -c '! grep -q TODO \"$@\"' --", files: "\\.md$" }], "# plan\nTODO\n", SEEDED);
  assert.equal(o.hook_failed, true);
  assert.deepEqual(o.hook_failures, [[DOC, "no-todo"]]);
  assert.deepEqual(o.base_red, ["unit"]);
});

test("8.2.3 #85 (3b): an always_run hook that takes file names is file-scoped: red on the doc stops", { skip: !HAS_PC }, () => {
  const o = planRun([{ id: "ar-files", entry: "sh -c 'test -e src/bug' --", always_run: true }], "# plan\n");
  assert.equal(o.hook_failed, true);
  assert.deepEqual(o.hook_failures, [[DOC, "ar-files"]]);
  assert.deepEqual(o.base_red, []);
});

test("8.2.3 #85 (4): an unstable fixer stops as before (stable false), base_red or not", { skip: !HAS_PC }, () => {
  const o = planRun([RED_TESTS, { id: "grow", entry: "sh -c 'for f; do echo x >> \"$f\"; done; exit 1' --", files: "\\.md$" }], "# plan\n", SEEDED);
  assert.equal(o.stable, false);
  assert.equal(o.runs, 3);
});

test("8.2.3 #85 (5): nondeterministic output, red with and without the doc: base_red (exit codes only)", { skip: !HAS_PC }, () => {
  const o = planRun([{ id: "noisy", entry: "sh -c 'date +%s%N; od -An -N8 -tx8 /dev/urandom; exit 1'", always_run: true, pass_filenames: false }], "# plan\n");
  assert.equal(o.hook_failed, false, o.hook_head);
  assert.deepEqual(o.base_red, ["noisy"]);
});

test("8.2.3 #85 (6): a fixer rewrites the doc and then passes: no failure, the rewrite is copied back; with a base-red hook too", { skip: !HAS_PC }, () => {
  const fix = { id: "eof", entry: "sh -c 'r=0; for f; do if grep -q \" $\" \"$f\"; then sed -i \"s/ *$//\" \"$f\"; r=1; fi; done; exit $r' --", files: "\\.md$" };
  const a = planRun([fix], "# plan   \n");
  assert.equal(a.hook_failed, false, a.hook_head);
  assert.deepEqual(a.changed, [DOC]);
  assert.equal(a.__doc, "# plan\n");
  assert.deepEqual(a.base_red, []);
  const b = planRun([fix, RED_TESTS], "# plan   \n", SEEDED);
  assert.equal(b.hook_failed, false, b.hook_head);
  assert.equal(b.__doc, "# plan\n");
  assert.deepEqual(b.base_red, ["unit"]);
});

test("8.2.3 #85 (8): green hooks: no failure, no base_red", { skip: !HAS_PC }, () => {
  const o = planRun([{ id: "ok", entry: "true", always_run: true, pass_filenames: false }], "# plan\n");
  assert.equal(o.hook_failed, false);
  assert.deepEqual(o.base_red, []);
});

// ---------------------------------------------------------------- the engine
function fmtStub(over) {
  return (prompt) => {
    const i = inputsOf(prompt);
    return {
      status: "ok",
      reason: "formatted",
      changed_paths: [],
      format: Object.assign({ ran: true, note: "ran pre-commit run --files in a scratch checkout of HEAD", runs: 1, stable: true, files: [i.plan_path], changed: [], refused: [], purged: 0, purged_paths: [], frozen_changed: [], frozen_map: null, hook_failed: false, hook_failures: [], hook_head: "", hook_sha256: "", hook_timeout: [], fix_timeout: false, unknown_hooks: [], base_red: [] }, over),
    };
  };
}

test("8.2.3 #85 (1, engine): base_red only: no stop, a warning gate line names the ids, the plan goes on", async () => {
  const s = happy();
  s["infra:format-plan"] = fmtStub({ base_red: ["unit", "lint-all"] });
  const out = await runOne(s, ARGS);
  assert.notEqual(out.result.stop_gate, "hooks", out.result.reason);
  assert.ok(out.result.status !== "needs_human" && out.result.status !== "failed", out.result.reason);
  const gl = out.result.gate_log;
  assert.ok(gl.some((g) => g === "warning: hooks red at the plan base, not caused by the plan doc: unit, lint-all"), gl.join("\n"));
  assert.ok(gl.some((g) => /^infra:format-plan: formatted$/.test(g)), gl.join("\n"));
});

test("8.2.3 #85 (2/3, engine): a doc-caused failure stops at hooks even with base_red", async () => {
  const s = happy();
  s["infra:format-plan"] = fmtStub({ hook_failed: true, hook_failures: [[ "x", "no-todo"]], hook_head: "[no-todo] Failed", hook_sha256: "a".repeat(64), base_red: ["unit"] });
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "hooks");
  assert.match(out.result.reason, /fail on the plan doc.*\[no-todo\]/);
});

test("8.2.3 #85 (4, engine): an unstable fixer or a fix timeout stops at hooks, base_red or not", async () => {
  for (const [over, re] of [[{ stable: false, runs: 3 }, /still rewrite the plan after 3 runs/], [{ fix_timeout: true }, /ran out of time/]]) {
    const s = happy();
    s["infra:format-plan"] = fmtStub(Object.assign({ base_red: ["unit"] }, over));
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human", out.result.reason);
    assert.equal(out.result.stop_gate, "hooks");
    assert.match(out.result.reason, re);
  }
});

test("8.2.3 #85 (7): base_red is a digested format_files key; a tampered or non-list base_red is a contract stop", async () => {
  assert.ok(K("format_files").includes("base_red"));
  const cases = [
    // a relay that changed base_red after the program printed it
    (r) => ((r.format.base_red = ["unit"]), r),
    // a relay that dropped it
    (r) => (delete r.format.base_red, r),
    // a digest-valid relay whose base_red is no list of strings
    (r, prompt) => redigest("infra:format-plan", ((r.format.base_red = "unit"), r), prompt),
  ];
  for (const fn of cases) {
    const s = happy();
    s["infra:format-plan"] = fmtStub({ base_red: ["x"] });
    s.__mutate = { label: /^infra:format-plan/, fn };
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "failed", out.result.reason);
    assert.equal(out.result.stop_gate, "contract");
    assert.match(out.result.reason, /does not match the program's digest/);
  }
});

test("8.2.3 #85 (8, engine): green hooks: the format-plan gate line as before and no warning", async () => {
  const out = await runOne(happy(), ARGS);
  const gl = out.result.gate_log;
  assert.ok(gl.some((g) => /^infra:format-plan: /.test(g)), gl.join("\n"));
  assert.ok(!gl.some((g) => /hooks red at the plan base/.test(g)), gl.join("\n"));
});
