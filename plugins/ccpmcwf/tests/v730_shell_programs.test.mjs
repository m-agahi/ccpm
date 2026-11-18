// fleet 7.3.0 (#9 IN part, L2008) A20-A22, and the chunk-writer part (Max ruled PARK Q4
// option (a)): four compound shell forms move into programs, and the chunk writers write
// their chunk files with the Write tool, allowed by one Write rule for the run's scratch dir.
// - workspace step 3: exclude_add.py <repo> <pattern>... (no $(...) append)
// - commit-plan housekeeping: parked.py retire <dir> <used> (no mkdir -p && mv -n)
// - purge: purge.py <worktree> (no n=$(find ...) && find ... | xargs)
// - format-plan: format_files.py in plan mode (no cd <worktree> && pre-commit)
// A program command keeps the shipped `sha256sum -- <f> && python3 -I <f>` shape (progCmd), so
// the same allow rules match; that one `&&` is not a compound form of the prompt's own.
//
// dont_care: the step numbering; the wording around the commands; the order of the added lines.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SCRIPTS_SRC, SOURCE, happy, run, runOne, ARGS, call, inputsOf, spawnSync } from "./harness.mjs";

const PROG_RE = /sha256sum -- ('[^']*'|<file>) && python3 -I ('[^']*'|<file>)/g;
function compoundForms(text) {
  const t = String(text).replace(PROG_RE, "<prog>");
  return ["$(", "&&", "| xargs", "cd "].filter((f) => t.includes(f));
}
const prog = (text, name) => new RegExp("sha256sum -- '[^']*/" + name + "\\.py' && python3 -I '[^']*/" + name + "\\.py'").test(text);

test("7.3.0 #9 A20: the format-plan, commit-plan and purge prompts and workspace step 3 hold no compound shell form; each names its program through progCmd", async () => {
  const out = await run(happy(), ARGS);
  const ws = call(out.plan, "workspace").prompt;
  const step3 = ws.split("\n").find((l) => l.startsWith("3. "));
  assert.deepEqual(compoundForms(step3), [], step3);
  assert.ok(prog(step3, "exclude_add"), step3);
  for (const p of [".claude/worktrees/", ".claude/settings.local.json", "__pycache__/", ".pytest_cache/", ".coverage", ".hypothesis/"]) assert.ok(step3.includes("'" + p + "'"), p);
  const fp = call(out.plan, "infra:format-plan").prompt;
  assert.deepEqual(compoundForms(fp), [], fp);
  assert.ok(prog(fp, "format_files") && fp.includes('"mode":"plan"'), fp);
  const cp = call(out.plan, "infra:commit-plan").prompt;
  assert.deepEqual(compoundForms(cp), [], cp);
  const pg = out.build.calls.find((c) => /^infra:purge-bytecode:/.test(c.label));
  assert.ok(pg, out.build.labels.join(", "));
  assert.deepEqual(compoundForms(pg.prompt), [], pg.prompt);
  assert.ok(prog(pg.prompt, "purge"), pg.prompt);
  // the retire housekeeping (a parked prior): parked.py retire, no mkdir -p && mv -n
  const body = SOURCE.slice(SOURCE.indexOf("function commitPlanPrompt("), SOURCE.indexOf("async function writeChunksParallel("));
  assert.ok(!/mkdir -p|mv -n/.test(body));
  assert.match(body, /progCmd\("parked", \["retire", inputs\.retire\.dir, inputs\.retire\.used\]\)/);
  assert.ok(!/PURGE_CMD|xargs -0/.test(SOURCE));
});

test("7.3.0 #9 A21: purge.py deletes bytecode and caches, skips .venv and .claude/worktrees, and prints purged", () => {
  const wt = mkdtempSync(join(tmpdir(), "fleet-730p-"));
  try {
    for (const d of ["a/__pycache__", ".venv", ".claude/worktrees/d/__pycache__", "e/.pytest_cache", "keep"]) mkdirSync(join(wt, d), { recursive: true });
    writeFileSync(join(wt, "a/__pycache__/x.pyc"), "");
    writeFileSync(join(wt, "b.pyc"), "");
    writeFileSync(join(wt, ".venv/c.pyc"), "");
    writeFileSync(join(wt, ".claude/worktrees/d/__pycache__/y.pyc"), "");
    writeFileSync(join(wt, "e/.pytest_cache/v"), "");
    writeFileSync(join(wt, "keep/z.py"), "");
    // a symlink named like a cache is never followed or deleted
    const outside = mkdtempSync(join(tmpdir(), "fleet-730po-"));
    writeFileSync(join(outside, "o.pyc"), "");
    symlinkSync(outside, join(wt, "keep/__pycache__"));
    symlinkSync(join(outside, "o.pyc"), join(wt, "keep/l.pyc"));
    const r = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "purge.py"), wt], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.purged, 3);
    assert.deepEqual(o.args, [wt]);
    assert.match(o.digest, /^[0-9a-f]{64}$/);
    assert.ok(!existsSync(join(wt, "a/__pycache__")) && !existsSync(join(wt, "b.pyc")) && !existsSync(join(wt, "e/.pytest_cache")));
    assert.ok(existsSync(join(wt, ".venv/c.pyc")) && existsSync(join(wt, ".claude/worktrees/d/__pycache__/y.pyc")) && existsSync(join(wt, "keep/z.py")));
    assert.ok(existsSync(join(outside, "o.pyc")) && existsSync(join(wt, "keep/__pycache__")) && existsSync(join(wt, "keep/l.pyc")));
    rmSync(outside, { recursive: true, force: true });
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("7.3.0 #9 A21 (plan example): a/__pycache__/x.pyc and b.pyc go, .venv/c.pyc and .claude/worktrees/d/__pycache__ stay: purged 2", () => {
  const wt = mkdtempSync(join(tmpdir(), "fleet-730p-"));
  try {
    for (const d of ["a/__pycache__", ".venv", ".claude/worktrees/d/__pycache__"]) mkdirSync(join(wt, d), { recursive: true });
    writeFileSync(join(wt, "a/__pycache__/x.pyc"), "");
    writeFileSync(join(wt, "b.pyc"), "");
    writeFileSync(join(wt, ".venv/c.pyc"), "");
    const o = JSON.parse(spawnSync("python3", ["-I", join(SCRIPTS_SRC, "purge.py"), wt], { encoding: "utf8" }).stdout);
    assert.equal(o.purged, 2);
    assert.ok(existsSync(join(wt, ".venv/c.pyc")) && existsSync(join(wt, ".claude/worktrees/d/__pycache__")));
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("7.3.0 #9 A22: exclude_add.py run twice writes the line once; an ignored path is not added", () => {
  const repo = mkdtempSync(join(tmpdir(), "fleet-730e-"));
  try {
    assert.equal(spawnSync("git", ["-C", repo, "init", "-q", "-b", "main"]).status, 0);
    writeFileSync(join(repo, ".gitignore"), ".coverage\n");
    const ex = (...p) => spawnSync("python3", ["-I", join(SCRIPTS_SRC, "exclude_add.py"), repo, ...p], { encoding: "utf8" });
    const a = ex(".claude/worktrees/", ".coverage");
    assert.equal(a.status, 0, a.stderr);
    const o = JSON.parse(a.stdout);
    assert.deepEqual(o.added, [".claude/worktrees/"]);
    assert.deepEqual(o.args, [repo, ".claude/worktrees/", ".coverage"]);
    const b = JSON.parse(ex(".claude/worktrees/", ".coverage").stdout);
    assert.deepEqual(b.added, []);
    const lines = readFileSync(join(repo, ".git/info/exclude"), "utf8").split("\n");
    assert.equal(lines.filter((l) => l === ".claude/worktrees/").length, 1);
    assert.ok(!lines.includes(".coverage"));
    assert.notEqual(ex("bad\nline").status, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("7.3.0 #9: parked.py retire moves the used run folder without clobbering", () => {
  const sc = mkdtempSync(join(tmpdir(), "fleet-730r-"));
  try {
    mkdirSync(join(sc, "scratch/parked/r1"), { recursive: true });
    writeFileSync(join(sc, "scratch/parked/r1/x.md"), "x");
    const py = () => spawnSync("python3", ["-I", join(SCRIPTS_SRC, "parked.py"), "retire", join(sc, "scratch/parked/r1"), join(sc, "scratch/parked/used")], { encoding: "utf8" });
    const r = py();
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.moved, true);
    assert.deepEqual(o.args, [join(sc, "scratch/parked/r1"), join(sc, "scratch/parked/used")]);
    assert.ok(existsSync(join(sc, "scratch/parked/used/r1/x.md")) && !existsSync(join(sc, "scratch/parked/r1")));
    // again: nothing to move; an existing target is never overwritten
    assert.equal(JSON.parse(py().stdout).moved, false);
    mkdirSync(join(sc, "scratch/parked/r1"));
    writeFileSync(join(sc, "scratch/parked/r1/y.md"), "y");
    assert.equal(JSON.parse(py().stdout).moved, false);
    assert.ok(existsSync(join(sc, "scratch/parked/r1/y.md")) && existsSync(join(sc, "scratch/parked/used/r1/x.md")));
  } finally {
    rmSync(sc, { recursive: true, force: true });
  }
});

test("7.3.0 #9: format_files.py plan mode fails on a check hook that fails without a change", () => {
  const wt = mkdtempSync(join(tmpdir(), "fleet-730f-"));
  const scratch = mkdtempSync(join(tmpdir(), "fleet-730fs-"));
  try {
    const git = (...a) => assert.equal(spawnSync("git", ["-C", wt, ...a], { encoding: "utf8" }).status, 0, a.join(" "));
    git("init", "-q", "-b", "main");
    writeFileSync(
      join(wt, ".pre-commit-config.yaml"),
      "repos:\n- repo: local\n  hooks:\n  - id: no-todo\n    name: no-todo\n    entry: sh -c '! grep -q TODO \"$@\"' --\n    language: system\n    files: \\.md$\n",
    );
    git("add", "-A");
    git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "init");
    mkdirSync(join(wt, "docs"));
    writeFileSync(join(wt, "docs/p.md"), "# plan\nTODO\n");
    const r = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "format_files.py"), wt, JSON.stringify({ mode: "plan", paths: ["docs/p.md"] }), "[]", scratch, "180"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    if (o.note === "pre-commit is not installed") return;
    assert.equal(o.ran, true, o.note);
    assert.equal(o.hook_failed, true);
    // 8.2.4 (#85): a file-scoped hook that fails alone on the doc is named
    assert.deepEqual(o.hook_failures, [["docs/p.md", "no-todo"]]);
    assert.deepEqual(o.base_red, []);
    assert.ok(o.stable);
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("7.3.0 #9: a format-plan relay whose plan-mode hooks failed stops with needs_human", async () => {
  const s = happy();
  s["infra:format-plan"] = (prompt) => {
    const i = inputsOf(prompt);
    return {
      status: "ok",
      reason: "formatted",
      changed_paths: [],
      format: { ran: true, note: "ran", runs: 1, stable: true, files: [i.plan_path], changed: [], refused: [], purged: 0, purged_paths: [], frozen_changed: [], frozen_map: null, hook_failed: true, hook_failures: [[i.plan_path, ""]], hook_head: "no-todo...Failed", hook_sha256: "a".repeat(64), hook_timeout: [], fix_timeout: false, unknown_hooks: [], base_red: [] },
    };
  };
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.match(out.result.reason, /no-todo\.\.\.Failed/);
});

test("7.3.0 #9 (Q4 a): the chunk writers use the Write tool; settings.local.json allows Write to the scratch chunk files only", async () => {
  const out = await run(happy(), ARGS);
  const w = out.plan.calls.find((c) => /^infra:plan-chunks:/.test(c.label));
  assert.ok(w, out.plan.labels.join(", "));
  assert.ok(!w.prompt.includes("printf"), w.prompt);
  assert.match(w.prompt, /Write tool/);
  assert.match(w.prompt, /Read it first/);
  assert.ok(!/printf '%s'/.test(SOURCE));
  const ws = inputsOf(call(out.plan, "workspace").prompt);
  const set = JSON.parse(ws.settings_local_json);
  const main = "/r/.claude/worktrees/fleet-y42-add-thing/main";
  assert.deepEqual(set.permissions.allow, ["Edit(/" + main + "/**)", "Write(/" + main + "/**)", "Write(//r/.claude/worktrees/fleet-y42-add-thing/scratch/chunks/*/*.b64)"]);
  // a settings file with other content is rewritten, never left stale
  assert.match(call(out.plan, "workspace").prompt, /absent or its content differs from `settings_local_json`/);
});

// the retire relay at the commit step: a wrong program stops; an unusable relay is a warning line
test("7.3.0 #9: the commit step's retire relay: a wrong program stops the run, a bad relay is a warning", async () => {
  const parked = (s) => {
    s["infra:load-parked"] = (prompt) => {
      const i = inputsOf(prompt);
      return { status: "ok", reason: "read", parked: { run: "n0-1234567", plan_path: "docs/plans/x.md", draft_chunks: ["# draft plan\n"], findings_chunks: [] }, args: [i.scratch, i.plan_tip_time === null ? "null" : String(i.plan_tip_time)] };
    };
    return s;
  };
  const ok = await runOne(parked(happy()), ARGS);
  assert.equal(ok.result.status, "awaiting_confirmation", ok.result.reason);
  assert.ok(ok.logs.some((l) => /^parked folder .*n0-1234567 moved to .*parked\/used$/.test(l)), ok.logs.join("\n"));
  const wrong = parked(happy());
  wrong.__mutate = { label: "infra:commit-plan", fn: (r) => ((r.retire.program = { name: "parked", sha256: "0".repeat(64) }), r) };
  const w = await runOne(wrong, ARGS);
  assert.equal(w.result.status, "failed");
  assert.match(w.result.reason, /infra:commit-plan: .*parked/);
  const bad = parked(happy());
  bad.__mutate = { label: "infra:commit-plan", fn: (r) => ((r.retire.moved = "yes"), r) };
  const b = await runOne(bad, ARGS);
  assert.equal(b.result.status, "awaiting_confirmation", b.result.reason);
  assert.ok(b.logs.some((l) => /^warning: infra:commit-plan: the parked retire relay is unusable; .*n0-1234567 may stay$/.test(l)), b.logs.join("\n"));
});
