// ccpmcwf 8.9.5 (yaadgaar #112 item 1): the caller check compares code hits only, with no auto read.
// callers.py file mode prints code_count, code_sha256, code_path_count and code_paths_sha256 per symbol
// (the hits that are not auto: not a doc or lock file, or a doc collected as a doctest). The plan
// checks the planner's map against code_sha256; R5 at the update merge compares code paths only.
// A doc or lock hit is dont_care by definition, so no auto (doc and lock) page is read any more.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ARGS, HASHES, SCRIPTS_SRC, scratchRepo, sh, spawnSync, happy, run, runOne, call, inputsOf, callersDisk, callersHash } from "./harness.mjs";

// 8.9.14 (yaadgaar #119): callers.py takes the runtime-doc list last (the engine's default here)
const RD = '["roles/**/*.md"]';

const CALLERS = join(SCRIPTS_SRC, "callers.py");
const py = (...a) => spawnSync("python3", ["-I", CALLERS, ...a], { encoding: "utf8" });
function withRepo(files, fn) {
  const wt = scratchRepo("fleet-895-");
  const S = mkdtempSync(join(tmpdir(), "fleet-895-scratch-"));
  try {
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(join(wt, p, ".."), { recursive: true });
      writeFileSync(join(wt, p), c);
    }
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "x");
    fn(wt, S);
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(S, { recursive: true, force: true });
  }
}
const MAIN = { "src/a.py": "foo()\n\nfoo()\n", "README.md": "x\nfoo\n", "CHANGELOG.md": "foo\n" };

// ---------------------------------------------------------------- the program

test("8.9.5 (#112): file mode prints the code hashes of the hits that are not auto; no path_count or paths_sha256", () => {
  withRepo(MAIN, (wt, S) => {
    const r = py("file", wt, "docs/plans/x.md", '["foo"]', "100", S, RD);
    assert.equal(r.status, 0, r.stderr);
    const e = JSON.parse(r.stdout).symbols.foo;
    assert.deepEqual(e, {
      count: 4,
      sha256: callersHash(["CHANGELOG.md:1", "README.md:2", "src/a.py:1", "src/a.py:3"]),
      auto_count: 2,
      code_count: 2,
      code_sha256: callersHash(["src/a.py:1", "src/a.py:3"]),
      code_path_count: 1,
      code_paths_sha256: callersHash(["src/a.py"]),
    });
  });
});

test("8.9.5 (#112): a doc collected as a doctest is a code hit", () => {
  withRepo(Object.assign({ "pytest.ini": "[pytest]\naddopts = --doctest-glob=*.md\n" }, MAIN), (wt, S) => {
    const r = py("file", wt, "docs/plans/x.md", '["foo"]', "100", S, RD);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.deepEqual(o.doctest_md, ["CHANGELOG.md", "README.md"]);
    assert.equal(o.symbols.foo.auto_count, 0);
    assert.equal(o.symbols.foo.code_count, 4);
    assert.equal(o.symbols.foo.code_paths_sha256, callersHash(["CHANGELOG.md", "README.md", "src/a.py"]));
  });
});

test("8.9.5 (#112): read part paths lists code paths only; part auto is refused", () => {
  withRepo(MAIN, (wt, S) => {
    const F = JSON.parse(py("file", wt, "docs/plans/x.md", '["foo"]', "100", S, RD).stdout).file;
    const p = py("read", F, "paths", '["foo"]', "0");
    assert.equal(p.status, 0, p.stderr);
    assert.deepEqual(JSON.parse(p.stdout).hits, { foo: ["src/a.py"] });
    const u = py("read", F, "auto", '["foo"]', "0");
    assert.notEqual(u.status, 0);
    assert.equal(u.stdout, "");
    assert.ok(u.stderr.startsWith("FLEET_CALLERS_READ: part is not all or paths: auto"), u.stderr);
  });
});

// ---------------------------------------------------------------- the plan

const reads = (out) => out.labels.filter((l) => l.includes(":read:"));
const findingsOf = (out) => {
  const c = call(out, "role:scope-and-plan:audit-fix");
  assert.ok(c, "no re-plan round: " + out.result.status + " " + out.result.reason);
  return inputsOf(c.prompt).prior_round.findings.map((f) => f.finding);
};
const docs = (x, n) => Array.from({ length: n }, (_, j) => "docs/" + x + "_" + String(j).padStart(3, "0") + ".md:1");
const code = (x, n) => Array.from({ length: n }, (_, j) => "src/" + x + ".py:" + (j + 1));
const dc = (at) => ({ at, criterion: null, dont_care: "a version pin" });
const planOf = (sym, map, data) => {
  const s = happy();
  s["role:scope-and-plan"].changed_symbols = [{ symbol: sym, occurrences: map.map(dc) }];
  callersDisk(s, "infra:callers", { [sym]: data });
  return s;
};

test("8.9.5 (#112): a map of every code hit with 300 doc hits needs no read and reaches confirmation", async () => {
  const d = { hits: code("pin", 2).concat(docs("pin", 300)), auto: docs("pin", 300) };
  const out = await runOne(planOf("pin", code("pin", 2), d), ARGS);
  assert.deepEqual(reads(out), []);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.ok(out.logs.some((g) => String(g).includes("; 300 doc or lock hit(s) left to auto dont_care by count and hash (not listed)")), out.logs.join("\n"));
  const pa = inputsOf(call(out, "role:plan-audit").prompt);
  assert.deepEqual(pa.changed_symbols.find((x) => x.symbol === "pin").occurrences.map((o) => o.at), code("pin", 2));
});

test("8.9.5 (#112) gate: only a doc hit changes: no read and no finding", async () => {
  for (const n of [20, 21]) {
    const d = { hits: code("pin", 2).concat(docs("pin", n)), auto: docs("pin", n) };
    const out = await runOne(planOf("pin", code("pin", 2), d), ARGS);
    assert.deepEqual(reads(out), [], "docs " + n);
    assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  }
});

test("8.9.5 (#112) gate: only a code caller changes: caught exactly as before", async () => {
  // a new code hit src/pin.py:3; the map has the first 2
  const d = { hits: code("pin", 3).concat(docs("pin", 20)), auto: docs("pin", 20) };
  const out = await runOne(planOf("pin", code("pin", 2), d), ARGS);
  assert.deepEqual(reads(out), ["infra:callers:read:all:0"]);
  assert.deepEqual(findingsOf(out), ["pin: src/pin.py:3 is an occurrence (git grep -w) not mapped in changed_symbols; map it to a criterion or to dont_care with a reason"]);
  // over the budget (300 doc hits): the re-grep finding, as before
  const d2 = { hits: code("pin", 3).concat(docs("pin", 300)), auto: docs("pin", 300) };
  const o2 = await runOne(planOf("pin", code("pin", 2), d2), ARGS);
  assert.deepEqual(reads(o2), []);
  assert.deepEqual(findingsOf(o2), ["pin: the mapped occurrences differ from git grep -w (303 hits, 2 mapped) and the hit list is over the caller read budget (4 reads of 50 entries); map exactly the code hits (doc and lock hits are auto dont_care), or every hit"]);
});

test("8.9.5 (#112) gate: a stale code line in the map is caught", async () => {
  const d = { hits: code("pin", 2).concat(docs("pin", 20)), auto: docs("pin", 20) };
  const out = await runOne(planOf("pin", ["src/pin.py:1", "src/pin.py:9"], d), ARGS);
  assert.deepEqual(reads(out), ["infra:callers:read:all:0"]);
  const f = findingsOf(out);
  assert.ok(f.includes("pin: src/pin.py:9 is mapped but git grep -w finds no occurrence there (stale line or wrong path; cite lines at the worktree HEAD)"), f.join("\n"));
});

test("8.9.5 (#112): a map of the code hits and some doc hits reads part all (budgeted); under the budget it passes", async () => {
  const d = { hits: code("pin", 2).concat(docs("pin", 20)), auto: docs("pin", 20) };
  const out = await runOne(planOf("pin", code("pin", 2).concat(docs("pin", 1)), d), ARGS);
  assert.deepEqual(reads(out), ["infra:callers:read:all:0"]);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
});

test("8.9.5 (#112): a summary whose code_count is not count - auto_count, or a bad code hash, halts failed", async () => {
  const d = { hits: code("pin", 2).concat(docs("pin", 3)), auto: docs("pin", 3) };
  for (const bad of [{ code_count: 3 }, { code_sha256: "xyz" }, { code_path_count: 3 }, { code_paths_sha256: "xyz" }]) {
    const out = await runOne(planOf("pin", code("pin", 2), Object.assign({ summary: bad }, d)), ARGS);
    assert.equal(out.result.status, "failed", out.result.reason);
    assert.ok(String(out.result.reason).startsWith("infra:callers:file: the summary has no valid entry for pin"), out.result.reason);
  }
});

// ---------------------------------------------------------------- R5 at the update merge (fixture of v720_callers_update_merge)

const D = "d".repeat(40);
const C = "c".repeat(40);
const DEFAULT_CAPS = { pr_ready: true, ci_watch: true, ci_watch_minutes: 60, stats: true, merge: "never", update_branch: "never", ci_trigger: false, review_post: "none" };
const PERSONAL = Object.assign({}, DEFAULT_CAPS, { merge: "auto", update_branch: "once", ci_trigger: true });
const polOut = (over) => (p) => Object.assign({ status: "ok", reason: "read", profile: null, file: "/h/p.json", policy_sha256: null, caps: Object.assign({}, DEFAULT_CAPS), matched: "x", error: null, now: 1000, args: inputsOf(p).args }, over);
const BEHIND = (p) => {
  const a = inputsOf(p).args;
  return { status: "ok", reason: "b", mode: "merge", merged: false, auto_enabled: false, method: "squash", merge_sha: null, blocked: "behind", merge_state: "BEHIND", head: a[4], branch_deleted: null, error: null, args: a };
};
const F1 = { id: "F1", severity: "blocking", category: "correctness", file: "src/x.py", line: 1, summary: "the merge broke x", evidence: "e" };
// moved: the paths the base change moved (hasher changed)
function upd(map, moved) {
  const t = happy();
  t["infra:policy"] = polOut({ profile: "personal", caps: PERSONAL });
  t["infra:pr-merge"] = BEHIND;
  t["infra:pr-update"] = (p) => ({ status: "ok", reason: "u", mode: "update", updated: true, head: D, base: C, overlap: ["src/w.py"], error: null, args: inputsOf(p).args });
  Object.assign(t, {
    "hasher:update:u1": { status: "ok", fingerprint: { head: D, tree: "KU" }, hashes: HASHES, changed: ["src/w.py"].concat(moved) },
    "infra:review-paths:v2": { status: "ok", reason: "listed", changed_paths: ["src/x.py", "tests/test_a.py"] },
    "hasher:pre-review:v2": { status: "ok", fingerprint: { head: D, tree: "KU" } },
    "role:pr-review:v2": { status: "ok", reason: "broken", verdict: "changes_requested", findings: [F1], touches_gate: false, checked: [] },
    "hasher:fp-post:pr-review:v2": { status: "ok", fingerprint: { head: D, tree: "KU" } },
    "infra:review-cleanup:v2": { status: "ok", reason: "clean" },
  });
  t["role:scope-and-plan"].changed_symbols = [{ symbol: "pin", occurrences: map.map((at, i) => ({ at, criterion: "AC" + ((i % 2) + 1), dont_care: null })) }];
  return t;
}
const CODE = ["src/a.py:10", "src/y.py:5"];
const DOCS = docs("pin", 300);
const DOC_PATHS = DOCS.map((h) => h.slice(0, h.lastIndexOf(":")));
// a plan sealed before 8.9.5 (and today's inline plan): the inline grep lists the doc hits, and the sealed map holds them as auto dont_care
const oldPlan = (t) => {
  t["infra:callers"] = { status: "ok", reason: "grepped", occurrences: { pin: CODE.concat(DOCS) }, capped: [], auto_dont_care: { pin: DOCS }, doctest_md: [] };
  return t;
};
// a plan sealed on the 8.9.5 disk path: the map holds the code hits only
const newPlan = (t) => callersDisk(t, "infra:callers", { pin: { hits: CODE.concat(DOCS), auto: DOCS } });
const u1Reads = (out) => out.labels.filter((l) => l.startsWith("infra:callers:u1:read:"));
const passed = (out) => out.logs.some((l) => l.includes("R1-R5 pass -> code rounds on the update merge"));
const sealedOf = (out) => inputsOf(call(out, "role:plan-audit").prompt).changed_symbols[0].occurrences;

test("8.9.5 (#112 item 3) back-compat: an old sealed map with 300 auto doc entries; the base moves those 300 docs; R5 passes with no read", async () => {
  const t = oldPlan(upd(CODE, DOC_PATHS));
  callersDisk(t, "infra:callers:u1", { pin: { hits: ["src/a.py:14", "src/y.py:5"].concat(DOCS), auto: DOCS } });
  const out = await run(t, ARGS);
  assert.equal(sealedOf(out).filter((o) => o.dont_care === "auto: non-code file").length, 300);
  assert.ok(out.labels.includes("infra:callers:u1:file"), out.labels.join(", "));
  assert.deepEqual(u1Reads(out), []);
  assert.ok(passed(out), out.result.reason + "\n" + out.logs.join("\n"));
});

test("8.9.5 (#112 item 3): a new sealed map (code hits only); 300 new doc paths at the merge; R5 passes with no read", async () => {
  const t = newPlan(upd(CODE, DOC_PATHS));
  const NEW = docs("new", 300);
  callersDisk(t, "infra:callers:u1", { pin: { hits: CODE.concat(DOCS, NEW), auto: DOCS.concat(NEW) } });
  const out = await run(t, ARGS);
  assert.deepEqual(sealedOf(out).map((o) => o.at), CODE);
  assert.deepEqual(u1Reads(out), []);
  assert.ok(passed(out), out.result.reason + "\n" + out.logs.join("\n"));
});

test("8.9.5 (#112) gate at R5: a new code path with 300 doc paths reads one code-path page and refuses", async () => {
  const t = oldPlan(upd(CODE, DOC_PATHS));
  callersDisk(t, "infra:callers:u1", { pin: { hits: CODE.concat(["src/w.py:2"], DOCS), auto: DOCS } });
  const out = await run(t, ARGS);
  assert.deepEqual(u1Reads(out), ["infra:callers:u1:read:paths:0"]);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.ok(out.result.reason.includes("no coder round: the base change touches files with occurrences of the changed symbols (src/w.py)"), out.result.reason);
});

test("8.9.5 (#112) gate at R5: an inline grep at the merge: doc paths moved pass, a moved code path refuses", async () => {
  const t = oldPlan(upd(CODE, ["README.md"]));
  t["infra:callers:u1"] = { status: "ok", reason: "grepped", occurrences: { pin: ["README.md:1", "src/a.py:14", "src/y.py:5"] }, capped: [], auto_dont_care: { pin: ["README.md:1"] }, doctest_md: [] };
  assert.ok(passed(await run(t, ARGS)));
  const t2 = oldPlan(upd(CODE, ["src/y.py"]));
  t2["infra:callers:u1"] = { status: "ok", reason: "grepped", occurrences: { pin: ["README.md:1", "src/a.py:14", "src/y.py:5"] }, capped: [], auto_dont_care: { pin: ["README.md:1"] }, doctest_md: [] };
  const o2 = await run(t2, ARGS);
  assert.equal(o2.result.status, "needs_human", o2.result.reason);
  assert.ok(o2.result.reason.includes("(src/y.py)"), o2.result.reason);
});

test("8.9.5 (#112) fail closed at R5: a doc the planner mapped itself stays in the moved-file check", async () => {
  const t = upd(CODE.concat(["README.md:3"]), ["README.md"]);
  t["infra:callers"] = { status: "ok", reason: "grepped", occurrences: { pin: CODE.concat(["README.md:3"]) }, capped: [], auto_dont_care: { pin: ["README.md:3"] }, doctest_md: [] };
  callersDisk(t, "infra:callers:u1", { pin: { hits: CODE.concat(["README.md:3"]), auto: ["README.md:3"] } });
  const out = await run(t, ARGS);
  assert.deepEqual(u1Reads(out), []);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.ok(out.result.reason.includes("(README.md)"), out.result.reason);
});

// ---------------------------------------------------------------- review of PR #121

test("8.9.5 review of #121 (2): plan-audit's caller_check carries the unlisted doc and lock hit count per symbol", async () => {
  const d = { hits: code("pin", 2).concat(docs("pin", 300)), auto: docs("pin", 300) };
  const s = happy();
  // other: a full map (no unlisted hit)
  s["role:scope-and-plan"].changed_symbols = [{ symbol: "pin", occurrences: code("pin", 2).map(dc) }, { symbol: "other", occurrences: [dc("src/o.py:1")] }];
  callersDisk(s, "infra:callers", { pin: d, other: { hits: ["src/o.py:1"] } });
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const cc = inputsOf(call(out, "role:plan-audit").prompt).caller_check;
  assert.deepEqual(cc.auto_unlisted, { pin: 300 });
  assert.deepEqual(cc.auto_dont_care.pin, []);
  // an inline caller check lists its doc hits, so nothing is unlisted
  const t = happy();
  t["role:scope-and-plan"].changed_symbols = [{ symbol: "pin", occurrences: ["src/p.py:1"].map(dc) }];
  t["infra:callers"] = { status: "ok", reason: "grepped", occurrences: { pin: ["README.md:1", "src/p.py:1"] }, capped: [], auto_dont_care: { pin: ["README.md:1"] }, doctest_md: [] };
  const o2 = await runOne(t, ARGS);
  const c2 = inputsOf(call(o2, "role:plan-audit").prompt).caller_check;
  assert.deepEqual(c2.auto_unlisted, {});
  assert.deepEqual(c2.auto_dont_care.pin, ["README.md:1"]);
});

test("8.9.5 review of #121 (3): a planner entry with the script's reserved reason \"auto: non-code file\" is a finding", async () => {
  const s = happy();
  s["role:scope-and-plan"].changed_symbols = [{ symbol: "pin", occurrences: [dc("src/p.py:1"), { at: "README.md:1", criterion: null, dont_care: "auto: non-code file" }] }];
  s["infra:callers"] = { status: "ok", reason: "grepped", occurrences: { pin: ["README.md:1", "src/p.py:1"] }, capped: [], auto_dont_care: { pin: ["README.md:1"] }, doctest_md: [] };
  const out = await runOne(s, ARGS);
  const f = findingsOf(out);
  assert.ok(f.includes("pin: README.md:1 dont_care \"auto: non-code file\" is reserved for the script; leave the hit unmapped or give your own reason"), f.join("\n"));
});

test("8.9.5 review of #121 (3): a sealed auto doc that is a doctest at the merge stays in R5 with no read; the base moves it, R5 refuses", async () => {
  // sealed as auto at plan time (no doctest config); at the merge the base made README.md a doctest
  const t = upd(CODE, ["README.md"]);
  t["infra:callers"] = { status: "ok", reason: "grepped", occurrences: { pin: CODE.concat(["README.md:1"]) }, capped: [], auto_dont_care: { pin: ["README.md:1"] }, doctest_md: [] };
  callersDisk(t, "infra:callers:u1", { pin: { hits: CODE.concat(["README.md:1"]) } }, { file: { doctest_md: ["README.md"] } });
  const out = await run(t, ARGS);
  assert.equal(sealedOf(out).filter((o) => o.dont_care === "auto: non-code file").length, 1);
  assert.deepEqual(u1Reads(out), []);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.ok(out.result.reason.includes("(README.md)"), out.result.reason);
});
