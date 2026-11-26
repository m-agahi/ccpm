// ccpmcwf 8.9.14 (yaadgaar #119, Max ruling option (b)): a .md file that code loads at runtime is code, not a doc.
// The runtime-doc rule is the default roles/**/*.md (anchored at the repo root) plus the globs of
// .fleet-runtime-docs.json read at origin/<default branch> (never the worktree). The engine passes the whole list
// to callers.py as an argument, and both ports (callers.py doc_or_lock, the engine's docOrLockFile) apply it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ARGS, DIST, HASHES, SOURCE, SCRIPTS_SRC, scratchRepo, sh, spawnSync, happy, run, runOne, call, inputsOf, callersDisk, callersHash, planRefFor, buildArgs } from "./harness.mjs";
import { join as pjoin } from "node:path";

const CALLERS = join(SCRIPTS_SRC, "callers.py");
const READER = join(SCRIPTS_SRC, "runtime_docs.py");
const DEF = ["roles/**/*.md"];
const py = (...a) => spawnSync("python3", ["-I", ...a], { encoding: "utf8" });

// ---------------------------------------------------------------- parity of the two ports

function jsDefs(names) {
  const parts = names.map((n) => {
    const fm = new RegExp("\\nfunction " + n + "\\([\\s\\S]*?\\n\\}\\n").exec(SOURCE);
    if (fm) return fm[0];
    const cm = new RegExp("\\nconst " + n + " = [\\s\\S]*?;\\n").exec(SOURCE);
    assert.ok(cm, "definition of " + n);
    return cm[0];
  });
  return Function(parts.join("") + "\nreturn {" + names.join(", ") + "};")();
}
const JS = () => jsDefs(["DOC_FILE_RE", "NOTE_FILE_RE", "LOCK_FILES", "RUNTIME_DOCS_DEFAULT", "RD_ENTRY_RE", "runtimeDocsProblem", "rdSeg", "rdMatch", "runtimeDoc", "docOrLockFile"]);
function pyEval(expr, arg) {
  const text = readFileSync(CALLERS, "utf8");
  const blk = text.match(/\nDOC_RE =[\s\S]*?\ndef doc_or_lock\(p, rd\):\n(?: {4}.*\n)+/);
  assert.ok(blk, "callers.py has no DOC_RE .. doc_or_lock(p, rd) block");
  const r = spawnSync("python3", ["-I", "-c", "import re, json, sys\n" + blk[0] + "\nA = json.loads(sys.argv[1])\nprint(json.dumps(" + expr + "))", JSON.stringify(arg)], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const PATHS = [
  "roles/x.md", "roles/a/b/c.md", "roles/x.MD", "roles/x.txt", "roles", "sub/roles/x.md", "plugins/ccpmcwf/roles/scope-and-plan.md",
  "README.md", "docs/x.md", "docs/prompts/a.md", "docs/prompts/deep/a.md", "CHANGELOG.md", "Cargo.lock", "src/a.py", "rolesx/y.md",
  "prompts/a.md", "prompts/a.md.bak", "a/b/prompt-1.md", "a/prompt-.md", "x/y/z/w.md", "LICENSE",
];
const RULES = [
  DEF,
  DEF.concat(["docs/prompts/*.md"]),
  DEF.concat(["plugins/*/roles/**/*.md", "a/**/prompt-*.md", "**/w.md", "prompts/*", "LICENSE", "docs/**"]),
  ["*.md"],
  ["**"],
  [],
];

test("8.9.14 (#119) parity: the JS and Python doc/lock classifiers agree for every path under each runtime-doc list", () => {
  const js = JS();
  const want = RULES.map((rd) => PATHS.map((p) => js.docOrLockFile(p, rd)));
  assert.deepEqual(pyEval("[[doc_or_lock(p, rd) for p in A[0]] for rd in A[1]]", [PATHS, RULES]), want);
  // the verdicts themselves (default list): roles/ at the root is code, a doc elsewhere is a doc
  const d = Object.fromEntries(PATHS.map((p, i) => [p, want[0][i]]));
  assert.equal(d["roles/x.md"], false);
  assert.equal(d["roles/a/b/c.md"], false);
  assert.equal(d["roles/x.MD"], true, "the glob is case-sensitive, so roles/x.MD stays a doc");
  assert.equal(d["sub/roles/x.md"], true, "the default is anchored at the repo root");
  assert.equal(d["plugins/ccpmcwf/roles/scope-and-plan.md"], true, "this repo lists its own roles dir in its config file");
  assert.equal(d["README.md"], true);
  assert.equal(d["docs/x.md"], true);
  assert.equal(d["rolesx/y.md"], true);
  // a config list widens only
  const c = Object.fromEntries(PATHS.map((p, i) => [p, want[1][i]]));
  assert.equal(c["docs/prompts/a.md"], false);
  assert.equal(c["docs/prompts/deep/a.md"], true, "* stays inside one segment");
  assert.equal(c["docs/x.md"], true);
  // an empty list is the pre-8.9.14 rule
  assert.deepEqual(want[5], PATHS.map((p) => js.docOrLockFile(p, [])));
  assert.equal(Object.fromEntries(PATHS.map((p, i) => [p, want[5][i]]))["roles/x.md"], true);
});

test("8.9.14 (#119) parity: the glob matcher agrees on edge globs", () => {
  const js = JS();
  const cases = [
    ["roles/**/*.md", "roles/x.md"], ["roles/**/*.md", "roles/a/x.md"], ["roles/**/*.md", "roles/.md"], ["roles/**/*.md", "roles/x.md/y"],
    ["a/**", "a"], ["a/**", "a/b/c"], ["**/a", "a"], ["**/a", "x/y/a"], ["**", "x"], ["a/*/b", "a/b"], ["a/*/b", "a/x/b"],
    ["*a*b*", "ab"], ["*a*b*", "xaxbx"], ["*a*b*", "ba"], ["a*a", "a"], ["a*a", "aa"], ["a*a", "aba"], ["x*", "x"], ["*.md", "a/b.md"],
    ["a/**/b/**/c", "a/b/c"], ["a/**/b/**/c", "a/x/b/y/z/c"], ["a/**/b/**/c", "a/c"], ["lit.md", "lit.md"], ["lit.md", "litXmd"],
  ];
  const want = cases.map(([g, p]) => js.rdMatch(g.split("/"), p.split("/")));
  assert.deepEqual(pyEval("[rd_match(g.split('/'), p.split('/')) for g, p in A]", cases), want);
  assert.deepEqual(want, [true, true, true, false, true, true, true, true, true, false, true, true, true, false, false, true, true, true, false, true, true, false, true, false]);
});

test("8.9.14 (#119) parity: both ports refuse the same malformed lists, with the same text", () => {
  const js = JS();
  const lists = [
    [], DEF, ["a/b.md"], ["/a.md"], ["a/"], ["a//b"], ["./a.md"], ["a/../b"], ["a?.md"], ["a[b].md"], ["{a,b}.md"], ["a\\b"], ["a b.md"],
    ["a/**b"], ["***"], ["a/**/**/b"], ["**/a/**/b/**/c/**/d/**/e"], ["a.md", "a.md"], [""], ["x".repeat(201)], [7], "roles/**/*.md",
    Array.from({ length: 65 }, (_, i) => "a" + i + ".md"), ["é.md"],
  ];
  const want = lists.map((l) => js.runtimeDocsProblem(l));
  assert.deepEqual(pyEval("[rd_problem(l) for l in A]", lists), want);
  assert.deepEqual(want.map((x) => x === null), [true, true, true].concat(Array(lists.length - 3).fill(false)));
});

// ---------------------------------------------------------------- the programs (real git)

function withRepo(files, fn) {
  const wt = scratchRepo("fleet-8914-");
  const S = mkdtempSync(join(tmpdir(), "fleet-8914-scratch-"));
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
const MAIN = { "src/a.py": "pin()\n", "roles/x.md": "pin\n", "docs/x.md": "pin\n", "docs/prompts/a.md": "pin\n", "sub/roles/y.md": "pin\n" };

test("8.9.14 (#119) callers.py: a changed pin in roles/x.md is a code hit, not auto; a doc elsewhere stays auto", () => {
  withRepo(MAIN, (wt) => {
    const r = py(CALLERS, wt, "docs/plans/p.md", '["pin"]', "100", JSON.stringify(DEF));
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.deepEqual(o.occurrences.pin, ["docs/prompts/a.md:1", "docs/x.md:1", "roles/x.md:1", "src/a.py:1", "sub/roles/y.md:1"]);
    assert.deepEqual(o.auto_dont_care.pin, ["docs/prompts/a.md:1", "docs/x.md:1", "sub/roles/y.md:1"]);
    assert.deepEqual(o.args, [wt, "docs/plans/p.md", '["pin"]', "100", JSON.stringify(DEF)]);
    // a config-listed glob behaves the same way
    const c = JSON.parse(py(CALLERS, wt, "docs/plans/p.md", '["pin"]', "100", JSON.stringify(DEF.concat(["docs/prompts/*.md"]))).stdout);
    assert.deepEqual(c.auto_dont_care.pin, ["docs/x.md:1", "sub/roles/y.md:1"]);
  });
});

test("8.9.14 (#119) callers.py file mode: the runtime-doc list is in args, and roles/x.md is a code path (R5 compares it)", () => {
  withRepo(MAIN, (wt, S) => {
    const rd = JSON.stringify(DEF);
    const r = py(CALLERS, "file", wt, "docs/plans/p.md", '["pin"]', "100", S, rd);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.deepEqual(o.args, [wt, "docs/plans/p.md", '["pin"]', "100", S, rd]);
    assert.equal(o.symbols.pin.code_paths_sha256, callersHash(["roles/x.md", "src/a.py"]));
    assert.equal(o.symbols.pin.code_sha256, callersHash(["roles/x.md:1", "src/a.py:1"]));
    const p = py(CALLERS, "read", o.file, "paths", '["pin"]', "0");
    assert.deepEqual(JSON.parse(p.stdout).hits, { pin: ["roles/x.md", "src/a.py"] });
  });
});

test("8.9.14 (#119) callers.py refuses a missing or malformed runtime-doc list (fail closed, no output)", () => {
  withRepo(MAIN, (wt, S) => {
    for (const a of [[CALLERS, wt, "p.md", '["pin"]', "100"], [CALLERS, wt, "p.md", '["pin"]', "100", '["/x.md"]'], [CALLERS, wt, "p.md", '["pin"]', "100", "nope"], [CALLERS, "file", wt, "p.md", '["pin"]', "100", S]]) {
      const r = py(...a);
      assert.notEqual(r.status, 0, a.join(" "));
      assert.equal(r.stdout, "");
    }
    const r = py(CALLERS, wt, "p.md", '["pin"]', "100", '["/x.md"]');
    assert.ok(r.stderr.startsWith("FLEET_CALLERS_RUNTIME_DOCS: runtime_docs entry 0 "), r.stderr);
  });
});

const CFG = ".fleet-runtime-docs.json";
function readerRepo(baseCfg, wtCfg, fn) {
  const wt = scratchRepo("fleet-8914-rd-");
  try {
    writeFileSync(join(wt, "a.txt"), "a\n");
    if (baseCfg !== null) writeFileSync(join(wt, CFG), baseCfg);
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "base");
    sh(wt, "git", "update-ref", "refs/remotes/origin/master", "HEAD");
    if (wtCfg !== null) {
      // the coder's tree: a commit on the fleet branch, then an uncommitted edit on top
      writeFileSync(join(wt, CFG), wtCfg);
      sh(wt, "git", "add", "-A");
      sh(wt, "git", "commit", "-qm", "coder");
      writeFileSync(join(wt, CFG), JSON.stringify({ version: 1, runtime_docs: [] }));
    }
    fn(wt);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
}
const reader = (wt) => {
  const r = py(READER, wt, "master");
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test("8.9.14 (#119) runtime_docs.py: the list is read at origin/<default>; the coder's tree cannot shrink it", () => {
  readerRepo(JSON.stringify({ version: 1, runtime_docs: ["docs/prompts/*.md", "tpl/**/*.md"] }), JSON.stringify({ version: 1, runtime_docs: ["docs/prompts/*.md"] }), (wt) => {
    const o = reader(wt);
    assert.deepEqual(o.docs, ["docs/prompts/*.md", "tpl/**/*.md"]);
    assert.equal(o.error, null);
    assert.deepEqual(o.args, [wt, "master"]);
    assert.equal(o.program.name, "runtime_docs");
    assert.match(o.digest, /^[0-9a-f]{64}$/);
  });
  // no file at origin: no list (the default alone), whatever the worktree holds
  readerRepo(null, JSON.stringify({ version: 1, runtime_docs: ["x/*.md"] }), (wt) => {
    const o = reader(wt);
    assert.equal(o.docs, null);
    assert.equal(o.error, null);
  });
});

test("8.9.14 (#119) runtime_docs.py refuses a malformed file at origin/<default>", () => {
  for (const [cfg, err] of [
    ["{", ".fleet-runtime-docs.json is not JSON"],
    ["[]", "keys must be exactly version, runtime_docs"],
    [JSON.stringify({ version: 1 }), "keys must be exactly version, runtime_docs"],
    [JSON.stringify({ version: 2, runtime_docs: [] }), "version must be 1"],
    [JSON.stringify({ version: true, runtime_docs: [] }), "version must be 1"],
    [JSON.stringify({ version: 1, runtime_docs: "a.md" }), "runtime_docs must be a list of strings"],
    [JSON.stringify({ version: 1, runtime_docs: [1] }), "runtime_docs must be a list of strings"],
    [JSON.stringify({ version: 1, runtime_docs: ["x".repeat(5000)] }), ".fleet-runtime-docs.json is larger than 4096 bytes"],
  ]) {
    readerRepo(cfg, null, (wt) => {
      const o = reader(wt);
      assert.equal(o.docs, null, cfg);
      assert.equal(o.error, err, cfg);
    });
  }
});

// ---------------------------------------------------------------- the engine: the plan

const findingsOf = (out) => {
  const c = call(out, "role:scope-and-plan:audit-fix");
  assert.ok(c, "no re-plan round: " + out.result.status + " " + out.result.reason);
  return inputsOf(c.prompt).prior_round.findings.map((f) => f.finding);
};
const dc = (at) => ({ at, criterion: null, dont_care: "a version pin" });
// a read step's stub with a runtime_docs relay of the program (docs at origin, or error)
function withRd(s, label, docs, error) {
  const base = s[label];
  s[label] = (p) => {
    const b = typeof base === "function" ? base(p) : JSON.parse(JSON.stringify(base));
    const i = inputsOf(p);
    return Object.assign(b, { runtime_docs: { docs, error: error || null, args: [i.main_worktree, i.default_branch] } });
  };
  return s;
}
const planOf = (map, hits, auto) => {
  const s = happy();
  s["role:scope-and-plan"].changed_symbols = [{ symbol: "pin", occurrences: map.map(dc) }];
  s["infra:callers"] = { status: "ok", reason: "grepped", occurrences: { pin: hits }, capped: [], auto_dont_care: { pin: auto }, doctest_md: [] };
  return s;
};

test("8.9.14 (#119) plan: an unmapped hit in roles/x.md is a finding (code), README.md stays auto", async () => {
  const out = await runOne(planOf(["src/p.py:1"], ["README.md:1", "roles/x.md:1", "src/p.py:1"], ["README.md:1"]), ARGS);
  assert.deepEqual(findingsOf(out), ["pin: roles/x.md:1 is an occurrence (git grep -w) not mapped in changed_symbols; map it to a criterion or to dont_care with a reason"]);
  const c = inputsOf(call(out, "infra:callers").prompt);
  assert.deepEqual(c.runtime_docs, DEF);
  // mapped by the planner, it passes
  const ok = await runOne(planOf(["roles/x.md:1", "src/p.py:1"], ["README.md:1", "roles/x.md:1", "src/p.py:1"], ["README.md:1"]), ARGS);
  assert.equal(ok.result.status, "awaiting_confirmation", ok.result.reason);
});

test("8.9.14 (#119) plan: a program that lists roles/x.md as auto (a shorter list) halts; so does one run with other args", async () => {
  const out = await runOne(planOf(["src/p.py:1"], ["roles/x.md:1", "src/p.py:1"], ["roles/x.md:1"]), ARGS);
  assert.equal(out.result.status, "failed", out.result.reason);
  assert.match(out.result.reason, /listed "roles\/x\.md:1" as auto dont_care for pin, which the script's doc and lock file list refuses/);
  // the relay ran callers.py with an empty runtime-doc list: the args check halts
  const s = planOf(["src/p.py:1"], ["src/p.py:1"], []);
  s["infra:callers"] = (p) => {
    const i = inputsOf(p);
    return { status: "ok", reason: "grepped", occurrences: { pin: ["src/p.py:1"] }, capped: [], auto_dont_care: { pin: [] }, doctest_md: [], args: [i.worktree, i.plan_path, JSON.stringify(i.symbols), String(i.cap), "[]"] };
  };
  const o2 = await runOne(s, ARGS);
  assert.equal(o2.result.status, "failed", o2.result.reason);
  assert.match(o2.result.reason, /^infra:callers: .*\["\/.*","docs\/plans\/.*","\[\\"pin\\"\]","\d+","\[\]"\]/);
});

test("8.9.14 (#119) plan: a config-listed path is code, and the callers prompt carries the default plus the config list", async () => {
  const s = withRd(planOf(["src/p.py:1"], ["docs/prompts/a.md:1", "src/p.py:1"], ["docs/prompts/a.md:1"]), "infra:branch-scan", ["docs/prompts/*.md"]);
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "failed", out.result.reason);
  assert.match(out.result.reason, /listed "docs\/prompts\/a\.md:1" as auto dont_care for pin/);
  assert.deepEqual(inputsOf(call(out, "infra:callers").prompt).runtime_docs, DEF.concat(["docs/prompts/*.md"]));
  assert.ok(out.logs.some((l) => l.includes(".fleet-runtime-docs.json at origin/master: 1 runtime-doc glob(s) (code, not docs): docs/prompts/*.md")), out.logs.join("\n"));
  // a doc the list does not match is still a doc
  const t = withRd(planOf(["src/p.py:1"], ["docs/x.md:1", "src/p.py:1"], ["docs/x.md:1"]), "infra:branch-scan", ["docs/prompts/*.md"]);
  const o2 = await runOne(t, ARGS);
  assert.equal(o2.result.status, "awaiting_confirmation", o2.result.reason);
});

test("8.9.14 (#119) plan: a malformed config file at origin stops for a human before the planner", async () => {
  for (const [docs, error, want] of [
    [["/abs.md"], null, ".fleet-runtime-docs.json at origin/master refused: runtime_docs entry 0 must be a relative path of segments [A-Za-z0-9._+@-] and *, with no leading or trailing /"],
    [null, "version must be 1", ".fleet-runtime-docs.json at origin/master refused: version must be 1"],
  ]) {
    const out = await runOne(withRd(planOf(["src/p.py:1"], ["src/p.py:1"], []), "infra:branch-scan", docs, error), ARGS);
    assert.equal(out.result.status, "needs_human", out.result.reason);
    assert.equal(out.result.reason, want);
    assert.ok(!out.labels.includes("role:scope-and-plan"), out.labels.join(", "));
  }
});

test("8.9.14 (#119): .fleet-runtime-docs.json is fenced (a fleet change cannot shrink the list for later runs)", () => {
  assert.match(SOURCE, /\nconst FENCED_FILES = \[".fleet-test-db.json", ".fleet-runtime-docs.json"\];\n/);
});

// ---------------------------------------------------------------- R5 at the update merge (fixture of v895)

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
  t["infra:callers"] = { status: "ok", reason: "grepped", occurrences: { pin: map }, capped: [], auto_dont_care: { pin: [] }, doctest_md: [] };
  return t;
}
const CODE = ["src/a.py:10", "src/y.py:5"];
const passed = (out) => out.logs.some((l) => l.includes("R1-R5 pass -> code rounds on the update merge"));
const u1 = (t, hits, auto) => {
  t["infra:callers:u1"] = { status: "ok", reason: "grepped", occurrences: { pin: hits }, capped: [], auto_dont_care: { pin: auto }, doctest_md: [] };
  return t;
};

test("8.9.14 (#119) R5: the base moves roles/x.md with a new pin there: the update merge is refused", async () => {
  const out = await run(u1(upd(CODE, ["roles/x.md"]), CODE.concat(["roles/x.md:3"]), ["roles/x.md:3"]), ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.ok(out.result.reason.includes("no coder round: the base change touches files with occurrences of the changed symbols (roles/x.md)"), out.result.reason);
  assert.deepEqual(inputsOf(call(out, "infra:callers:u1").prompt).runtime_docs, DEF);
  // a doc outside the rule still passes
  assert.ok(passed(await run(u1(upd(CODE, ["docs/x.md"]), CODE.concat(["docs/x.md:3"]), ["docs/x.md:3"]), ARGS)));
});

test("8.9.14 (#119) R5: a config-listed path moved by the base is refused; the build reads the list at verify, not from the coder's tree", async () => {
  const t = withRd(u1(upd(CODE, ["docs/prompts/a.md"]), CODE.concat(["docs/prompts/a.md:3"]), ["docs/prompts/a.md:3"]), "infra:verify-plan", ["docs/prompts/*.md"]);
  const out = await run(t, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.ok(out.result.reason.includes("(docs/prompts/a.md)"), out.result.reason);
  // with no config at verify the same path is a doc: R5 passes
  assert.ok(passed(await run(u1(upd(CODE, ["docs/prompts/a.md"]), CODE.concat(["docs/prompts/a.md:3"]), ["docs/prompts/a.md:3"]), ARGS)));
});

test("8.9.14 (#119) R5 disk path: the u1 file relay carries the runtime-doc list in its args", async () => {
  const t = upd(CODE, ["roles/x.md"]);
  callersDisk(t, "infra:callers:u1", { pin: { hits: CODE.concat(["roles/x.md:3"]) } });
  const out = await run(t, ARGS);
  const fi = inputsOf(call(out, "infra:callers:u1:file").prompt);
  assert.deepEqual(fi.runtime_docs, DEF);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.ok(out.result.reason.includes("(roles/x.md)"), out.result.reason);
});

// ---------------------------------------------------------------- the relay of the reader

test("8.9.14 (#119): a relay that shrinks or drops the runtime-doc read halts, at plan and at build", async () => {
  const cfg = ["docs/prompts/*.md"];
  const at = (label, fn) => {
    const s = withRd(planOf(["src/p.py:1"], ["src/p.py:1"], []), label, cfg);
    s.__mutate = { label, fn: (r) => (fn(r), r) };
    return s;
  };
  // the list emptied in the copy: the program's digest no longer matches
  const o1 = await runOne(at("infra:branch-scan", (r) => (r.runtime_docs.docs = [])), ARGS);
  assert.equal(o1.result.status, "failed", o1.result.reason);
  assert.equal(o1.result.reason, "infra:branch-scan: the relayed .fleet-runtime-docs.json read does not match the program's digest or arguments");
  // the relay ran the program on another worktree
  const o2 = await runOne(at("infra:branch-scan", (r) => (r.runtime_docs.args = ["/elsewhere", "master"])), ARGS);
  assert.equal(o2.result.status, "failed", o2.result.reason);
  assert.match(o2.result.reason, /^infra:branch-scan: the relayed \.fleet-runtime-docs\.json read does not match/);
  // no relay at all
  const o3 = await runOne(at("infra:branch-scan", (r) => delete r.runtime_docs), ARGS);
  assert.equal(o3.result.status, "failed", o3.result.reason);
  assert.equal(o3.result.reason, "infra:branch-scan: no runtime_docs relay (the .fleet-runtime-docs.json read)");
  for (const o of [o1, o2, o3]) assert.ok(!o.labels.includes("role:scope-and-plan"), o.labels.join(", "));
  // the build's read at verify, before any role of the build
  const t = withRd(upd(CODE, ["docs/prompts/a.md"]), "infra:verify-plan", cfg);
  t.__mutate = { label: "infra:verify-plan", fn: (r) => ((r.runtime_docs.docs = []), r) };
  const o4 = await run(t, ARGS);
  assert.equal(o4.result.status, "failed", o4.result.reason);
  assert.equal(o4.result.reason, "infra:verify-plan: the relayed .fleet-runtime-docs.json read does not match the program's digest or arguments");
  assert.ok(!o4.labels.some((l) => l.startsWith("role:fleet-")), o4.labels.join(", "));
});

test("8.9.14 (#119) RED on the dist: without the digest check a shrunk list reaches the planner", async () => {
  // the dist is collapsed (no spaces): drop the digest half of the check
  const mut = DIST.replace('!relayDigestOk(t,progKeys("runtime_docs"),"runtime_docs")||', "");
  assert.notEqual(mut, DIST);
  const s = withRd(planOf(["src/p.py:1"], ["docs/prompts/a.md:1", "src/p.py:1"], ["docs/prompts/a.md:1"]), "infra:branch-scan", ["docs/prompts/*.md"]);
  s.__mutate = { label: "infra:branch-scan", fn: (r) => ((r.runtime_docs.docs = []), r) };
  s.__source = mut;
  const out = await runOne(s, ARGS);
  // the tampered list passes: docs/prompts/a.md is auto again and the plan reaches confirmation
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.deepEqual(inputsOf(call(out, "infra:callers").prompt).runtime_docs, DEF);
});

// ---------------------------------------------------------------- review of 3d945e5 (Max: fix first, then merge)

const CFG1 = ["docs/prompts/*.md"];
const DECL = { version: 1, engine: "mariadb", major: "11.4", env: "YADGAR_TEST_DSN" };
function withDecl(s) {
  for (const label of ["infra:branch-scan", "infra:verify-plan"]) {
    const base = s[label];
    s[label] = (p) => {
      const b = typeof base === "function" ? base(p) : JSON.parse(JSON.stringify(base));
      const i = inputsOf(p);
      return Object.assign(b, { test_db: { decl: DECL, error: null, args: [i.main_worktree, i.default_branch] } });
    };
  }
  return s;
}
const refOf = (s, out) => JSON.parse(s.__store[out.planResult.plan_ref.plan_commit]);

test("8.9.14 review 1: the plan ref seals the runtime-doc list the plan used", async () => {
  const s = withRd(happy(), "infra:branch-scan", CFG1);
  withRd(s, "infra:verify-plan", CFG1);
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.deepEqual(refOf(s, out).plan_facts.runtime_docs, DEF.concat(CFG1));
  // no config: the default alone is sealed
  const t = happy();
  const o2 = await run(t, ARGS);
  assert.deepEqual(refOf(t, o2).plan_facts.runtime_docs, DEF);
});

test("8.9.14 review 1: a default branch that drops a sealed glob before the build halts at verify (safety, callers)", async () => {
  const s = withRd(happy(), "infra:branch-scan", CFG1);
  const ref = await planRefFor(s);
  // the build reads origin again: the glob is gone
  const out = await runOne(s, buildArgs(ref));
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "callers");
  assert.equal(out.result.stop_class, "safety");
  assert.equal(out.result.reason, "plan ref " + ref.plan_ref + ": .fleet-runtime-docs.json at origin/master no longer lists the sealed runtime-doc glob(s) docs/prompts/*.md; restore them on master, or run plan again");
  assert.ok(!out.labels.some((l) => l.startsWith("role:") || l.startsWith("infra:db-")), out.labels.join(", "));
  // a wider build list is fine, and the build uses it
  const t = withRd(happy(), "infra:branch-scan", CFG1);
  const r2 = await planRefFor(t);
  withRd(t, "infra:verify-plan", CFG1.concat(["tpl/*.md"]));
  const o2 = await runOne(t, buildArgs(r2));
  assert.equal(o2.result.status, "ok", o2.result.reason);
  assert.ok(o2.logs.some((l) => l.includes(".fleet-runtime-docs.json at origin/master: 2 runtime-doc glob(s) (code, not docs): docs/prompts/*.md, tpl/*.md")), o2.logs.join("\n"));
});

test("8.9.14 review 1: a plan ref sealed before the list (no plan_facts.runtime_docs) builds with the build list", async () => {
  // a plan run of a source that seals no list (the 8.9.14 key cut out of the dist)
  const s = happy();
  const cut = DIST.replace("runtime_docs:ctx.runtimeDocs,", "");
  assert.notEqual(cut, DIST);
  s.__source = cut;
  const ref = await planRefFor(s);
  delete s.__source;
  withRd(s, "infra:verify-plan", CFG1);
  const out = await runOne(s, buildArgs(ref));
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.logs.some((l) => l.includes("plan ref sealed before the runtime-doc list: the build uses the list at origin/master (" + DEF.concat(CFG1).join(", ") + ")")), out.logs.join("\n"));
  // a sealed list that is not a valid list fails closed
  const t = happy();
  const bad = DIST.replace("runtime_docs:ctx.runtimeDocs,", 'runtime_docs:["/x.md"],');
  assert.notEqual(bad, DIST);
  t.__source = bad;
  const r2 = await planRefFor(t);
  delete t.__source;
  const o2 = await runOne(t, buildArgs(r2));
  assert.equal(o2.result.status, "needs_human", o2.result.reason);
  assert.equal(o2.result.stop_class, "safety");
  assert.equal(o2.result.reason, "plan ref " + r2.plan_ref + ": the sealed runtime-doc list is refused: runtime_docs entry 0 must be a relative path of segments [A-Za-z0-9._+@-] and *, with no leading or trailing /");
});

test("8.9.14 review 2: runtime_docs.py fails closed when git cannot read the file (never 'no file')", () => {
  readerRepo(JSON.stringify({ version: 1, runtime_docs: CFG1 }), null, (wt) => {
    // the blob is gone from the object store: the tree still names it
    const oid = sh(wt, "git", "rev-parse", "refs/remotes/origin/master:.fleet-runtime-docs.json").trim();
    rmSync(pjoin(wt, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
    const o = reader(wt);
    assert.equal(o.docs, null);
    assert.equal(o.error, "git cannot read .fleet-runtime-docs.json at origin/master");
  });
  // the tree itself unreadable
  readerRepo(JSON.stringify({ version: 1, runtime_docs: CFG1 }), null, (wt) => {
    const tree = sh(wt, "git", "rev-parse", "refs/remotes/origin/master^{tree}").trim();
    rmSync(pjoin(wt, ".git", "objects", tree.slice(0, 2), tree.slice(2)));
    const o = reader(wt);
    assert.equal(o.docs, null);
    assert.equal(o.error, "git cannot list the tree of origin/master");
  });
  // a directory at the path is not a file; a missing file is still no list
  readerRepo(null, null, (wt) => {
    assert.equal(reader(wt).error, null);
    mkdirSync(pjoin(wt, CFG));
    writeFileSync(pjoin(wt, CFG, "x"), "x");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "dir");
    sh(wt, "git", "update-ref", "refs/remotes/origin/master", "HEAD");
    assert.equal(reader(wt).error, ".fleet-runtime-docs.json is not a file");
  });
});

test("8.9.14 review 3: a bad runtime-doc list halts before the test database starts (plan and build)", async () => {
  const p = withRd(withDecl(planOf(["src/p.py:1"], ["src/p.py:1"], [])), "infra:branch-scan", null, "version must be 1");
  const o1 = await runOne(p, ARGS);
  assert.equal(o1.result.reason, ".fleet-runtime-docs.json at origin/master refused: version must be 1");
  assert.ok(!o1.labels.some((l) => l.startsWith("infra:db-")), o1.labels.join(", "));
  const b = withDecl(happy());
  const ref = await planRefFor(b);
  withRd(b, "infra:verify-plan", null, "version must be 1");
  const o2 = await runOne(b, buildArgs(ref));
  assert.equal(o2.result.reason, ".fleet-runtime-docs.json at origin/master refused: version must be 1");
  assert.ok(!o2.labels.some((l) => l.startsWith("infra:db-")), o2.labels.join(", "));
});

test("8.9.14 review 4: the config holds at most 63 globs (64 with the default); the stop names the count", async () => {
  const globs = (n) => Array.from({ length: n }, (_, i) => "d" + i + "/*.md");
  const o1 = await runOne(withRd(planOf(["src/p.py:1"], ["src/p.py:1"], []), "infra:branch-scan", globs(64)), ARGS);
  assert.equal(o1.result.status, "needs_human", o1.result.reason);
  assert.equal(o1.result.reason, ".fleet-runtime-docs.json at origin/master refused: it lists 64 globs; at most 63 (64 with the default roles/**/*.md)");
  const o2 = await runOne(withRd(planOf(["src/p.py:1"], ["src/p.py:1"], []), "infra:branch-scan", globs(63)), ARGS);
  assert.equal(o2.result.status, "awaiting_confirmation", o2.result.reason);
  assert.equal(inputsOf(call(o2, "infra:callers").prompt).runtime_docs.length, 64);
  // the cap counts the config as written: 63 globs plus a repeat of the default is 64
  const o3 = await runOne(withRd(planOf(["src/p.py:1"], ["src/p.py:1"], []), "infra:branch-scan", globs(63).concat(DEF)), ARGS);
  assert.equal(o3.result.status, "needs_human", o3.result.reason);
  assert.match(o3.result.reason, /it lists 64 globs; at most 63/);
});

test("8.9.14 review 5: each runtime-doc stop site has its own reason in docs/stop-classes.md", () => {
  const doc = readFileSync(pjoin(SCRIPTS_SRC, "..", "docs", "stop-classes.md"), "utf8");
  const rows = doc.split("\n").filter((l) => /^\| \d+ \| `runtimeDocs(Step|Sealed)` \|/.test(l));
  assert.ok(rows.length >= 6, rows.join("\n"));
  const reasons = rows.map((l) => l.split(" | ").pop().replace(/ \|$/, ""));
  for (const r of reasons) assert.ok(!r.includes("sealed caller map does not cover"), r);
  // the relay-digest rule stays shared; every other site is its own
  const own = reasons.filter((r) => !r.startsWith("relay digest or args mismatch"));
  assert.equal(new Set(own).size, own.length, own.join("\n"));
});
