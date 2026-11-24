// ccpmcwf 8.8.0 (yaadgaar #108 step 5, ADR-1397): every stop site names its stop class in script code.
// 1. Coverage: every halt(), global stop() and planFindingsStop() call in the source passes a class as
//    its first argument: "s" (safety), "m" (mechanical), "t" (transient), a J_<NAME> judgment const
//    (the class with its script-built options), or a ternary of those. A new unclassified site fails here.
// 2. Every judgment const carries 2 or 3 script-built options; no relayed text (no .reason) goes in.
// 3. The safety categories of ADR-1397 stay safety (pinned by site text).
// 4. docs/stop-classes.md lists every site, in source order, with its function and class.
// 5. The result carries stop_class next to stop_gate (null on ok and awaiting_confirmation).
// 6. Review of #115: B1, a hook_surface error is never transient (it names repo files; only
//    ruleset_surface.py's own error shape is); S1, no alias of halt/stop/planFindingsStop hides a site;
//    S2, a prototype key ("constructor") is no class. The table is generated (stop_classes_doc.mjs).
//
// Run: node --test plugins/ccpmcwf/tests/v880_stop_class.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SOURCE, ARGS, PB, happy, run, runOne, inputsOf, programOf, programSha, relayDigestOf, K } from "./harness.mjs";

import { ATOM, stopSites, classProblem, classNames, valueUses, render, DOC as DOC_PATH } from "./stop_classes_doc.mjs";

const DOC = (() => {
  try {
    return readFileSync(DOC_PATH, "utf8");
  } catch {
    return "";
  }
})();
const CLASSES = ["safety", "mechanical", "judgment", "transient"];
const SITES = stopSites(SOURCE);

// ---------------------------------------------------------------- 1: coverage

test("8.8.0: every halt, stop and planFindingsStop site names a stop class", () => {
  assert.ok(SITES.length >= 330, "only " + SITES.length + " sites found: the scan is broken");
  const bad = SITES.map(classProblem).filter(Boolean);
  assert.deepEqual(bad, []);
});

test("8.8.0: the coverage scan refuses an unclassified site (a new halt without a class fails CI)", () => {
  const src = 'function f() {\n  halt("needs_human", "x", "scope");\n  stop("needs_human", "y");\n  // halt() in a comment\n  halt("s", "failed", "z");\n  halt(a ? "t" : "s", "failed", "w");\n  halt(J_X, "needs_human", "v");\n  halt(a ? "t" : "q", "failed", "u");\n  planFindingsStop("j", ctx);\n  halt("j", "needs_human", "t");\n}\n';
  const s = stopSites(src);
  assert.equal(s.length, 8);
  assert.deepEqual(s.map((x) => !!classProblem(x)), [true, true, false, false, false, true, false, true]);
});

test("8.8.0 review S1: halt, stop and planFindingsStop are never used as a value (an alias hides a site)", () => {
  assert.deepEqual(valueUses(SOURCE), []);
  // mutation: an alias, an array element and an argument are refused; a call, a declaration, a property,
  // an object key, a string and a comment are not
  const m = valueUses('const hh = halt;\nhh("needs_human", "x");\n[stop][0]("s", "x");\nf(planFindingsStop);\nx.stop = 1;\nconst o = { stop: 1 };\nhalt("s", "x");\nfunction stop(a) {}\nconst t = "halt";\n// halt\n');
  assert.deepEqual(m, ["line 1: halt used as a value", "line 3: stop used as a value", "line 4: planFindingsStop used as a value"]);
  // and the mutated engine fails the check
  const mutated = SOURCE.replace("function reserve(n, what) {", "const hh = halt;\nfunction reserve(n, what) {");
  assert.notEqual(mutated, SOURCE);
  assert.equal(valueUses(mutated).length, 1);
});

test("8.8.0 review S2: a prototype key is no stop class (constructor, toString, __proto__ fall back to safety)", () => {
  const at = SOURCE.indexOf("function stop(cls, status, reason) {");
  const body = /^const STOP_CLASS = .*$/m.exec(SOURCE)[0] + "\n" + SOURCE.slice(at, SOURCE.indexOf("\n}\n", at) + 3);
  const state = {};
  const stop = new Function("state", "Stop", body + "\nreturn stop;")(state, class extends Error {});
  const cls = (c) => {
    try {
      stop(c, "needs_human", "x");
    } catch {}
    return state.stopClass;
  };
  assert.deepEqual(["constructor", "toString", "__proto__", "hasOwnProperty", "q", undefined, null, 3].map(cls), Array(8).fill("safety"));
  assert.deepEqual(["s", "m", "t", "j"].map(cls), ["safety", "mechanical", "transient", "judgment"]);
  assert.equal(cls({ j: ["a", "b"] }), "judgment");
});

test("8.8.0: only stop() and the park re-throw build a Stop; the direct finish stops set the class", () => {
  assert.equal((SOURCE.match(/new Stop\(/g) || []).length, 2);
  assert.match(SOURCE, /throw new Stop\(e\.status, e\.reason \+ note\)/);
  const direct = [...SOURCE.matchAll(/finish\("(needs_human|failed)"/g)];
  assert.ok(direct.length >= 2);
  for (const d of direct) assert.match(SOURCE.slice(d.index - 400, d.index), /state\.stopClass = "(safety|mechanical|transient|judgment)"/, SOURCE.slice(d.index - 200, d.index + 80));
  // the no-args return carries its class
  assert.match(SOURCE, /status: "needs_human",\s*stop_class: "safety",/);
});

// ---------------------------------------------------------------- 2: judgment options

test("8.8.0: every judgment const carries 2-3 script-built options, never relayed text", () => {
  const defs = SOURCE.split("\n").filter((l) => /^const (O_[A-Z0-9_]+|J_[A-Z0-9_]+) = /.test(l));
  assert.ok(defs.some((l) => l.startsWith("const J_")));
  for (const l of defs) assert.doesNotMatch(l, /\.reason\b|\.finding\b|\.summary\b/, l);
  const J = /^const J = .*$/m.exec(SOURCE);
  assert.ok(J, "no J helper");
  const SYMBOL_RE = /^const SYMBOL_RE = .*$/m.exec(SOURCE)[0] + "\n" + /^const SAME_PLAN_REF = .*$/m.exec(SOURCE)[0];
  const names = defs.filter((l) => l.startsWith("const J_")).map((l) => /^const (J_[A-Z0-9_]+)/.exec(l)[1]);
  const all = new Function(SYMBOL_RE + "\n" + J[0] + "\n" + defs.join("\n") + "\nreturn {" + names.join(",") + "};")();
  for (const n of names) {
    const v = typeof all[n] === "function" ? all[n]("some_symbol") : all[n];
    assert.ok(v && Array.isArray(v.j) && v.j.length >= 2 && v.j.length <= 3 && v.j.every((x) => typeof x === "string" && x.length > 10), n + ": " + JSON.stringify(v));
  }
  // every J_ a site names is defined
  for (const s of SITES) for (const j of s.cls.match(/J_[A-Z0-9_]+/g) || []) assert.ok(names.includes(j), j + " at line " + s.line);
  // a judgment site stops needs_human (finish shows options on needs_human only)
  for (const s of SITES.filter((x) => ATOM.test(x.cls) && /^J_/.test(x.cls))) assert.match(s.text.slice(s.text.indexOf(s.cls) + s.cls.length), /^\s*,\s*"needs_human"/, "line " + s.line);
});

test("8.8.0: a symbol that is not identifier-shaped never reaches the options", () => {
  const J = /^const J = .*$/m.exec(SOURCE)[0];
  const SYMBOL_RE = /^const SYMBOL_RE = .*$/m.exec(SOURCE)[0] + "\n" + /^const SAME_PLAN_REF = .*$/m.exec(SOURCE)[0];
  const defs = SOURCE.split("\n").filter((l) => /^const (O_[A-Z0-9_]+|J_[A-Z0-9_]+) = /.test(l));
  const { J_SYMS } = new Function(SYMBOL_RE + "\n" + J + "\n" + defs.join("\n") + "\nreturn { J_SYMS };")();
  const o = J_SYMS(["ok_name", "evil; rm -rf /", "x".repeat(300)]).j.join("\n");
  assert.match(o, /ok_name/);
  assert.doesNotMatch(o, /evil|rm -rf|xxxxx/);
});

// ---------------------------------------------------------------- 3: the safety categories stay safety

const SAFETY = {
  "hook surface": /"hook changes must be a separate PR/,
  "hook confirmation": /"hook change needs Max's confirmation: "/,
  "IaC": /"IaC pre-push check stops: "/,
  "IaC push": /"IaC diffs never push automatically/,
  "hash": /": hash violation on "/,
  "freeze": /"worktree changed between test approval and freeze"/,
  "fingerprint": /"judge mutated worktree: "/,
  "ownership": /"coder committed: HEAD moved from "/,
  "scope fence": /": changed path outside the scope fence: "/,
  "command allowlist": /"test_cmd refused: "/,
  "DSN": /" holds mysql:\/\/ \(a test DSN\)/,
  "DSN in the plan doc": /"plan doc holds a test DSN URL"/,
  "work-owner merge": /"green, merge blocked: " \+ \(m\.error/,
  "intent refusal": /"plan sweep verdict weakening"/,
  "role identity": /" is not its ROLE_AGENT type "/,
  "program identity": /label \+ ": " \+ p, stopGate \|\| "contract"/,
  "relay digest": /lb \+ RELAY_MISMATCH, "policy"/,
  "relay args": /"infra:verify-plan: " \+ OTHER_ARGS/,
  "run-state": /"run-state mismatch: " \+ what/,
  "plan ref": /"plan changed since approval: branch HEAD "/,
  "checkpoint arg": /"args\.checkpoint must be the \{run, sha256\}/,
  "legacy ref": /stop\("s", "needs_human", LEGACY_REF\)/,
  "push access": /"no push access to origin for "/,
  "agent cap": /"agent cap " \+ MAX_AGENTS/,
  "budget": /"run budget: " \+ n/,
  "secret paths": /"scope check failed: " \+ early/,
  "version": /RELOAD_HINT/,
  "hasher relay cap": /the hasher output is over the 65536-byte relay cap/,
  "write-step null": /"test writer " \+ cid \+ " r" \+ n \+ " returned no result"/,
  "unattended header": /" section \(the unattended run's automatic decisions\)/,
  "truncated claims": /": the PR body holds more test-count phrases/,
};
test("8.8.0: the safety categories of ADR-1397 are classed safety", () => {
  for (const [what, re] of Object.entries(SAFETY)) {
    const hit = SITES.filter((s) => re.test(s.text) && (s.callee !== "halt" || s.fn !== "planFindingsStop"));
    assert.ok(hit.length, what + ": no site matches " + re);
    const s = hit[0];
    assert.equal(s.cls, '"s"', what + " (line " + s.line + "): class " + s.cls);
  }
});

// ---------------------------------------------------------------- 4: the classification table

test("8.8.0 review: docs/stop-classes.md is the generator's output for the source (run tests/stop_classes_doc.mjs)", () => {
  assert.ok(DOC === render(SOURCE), "docs/stop-classes.md is stale: run node plugins/ccpmcwf/tests/stop_classes_doc.mjs");
  // the tables are prettier-ignored, so the hook keeps them byte for byte
  assert.equal((DOC.match(/^<!-- prettier-ignore -->\n\|/gm) || []).length, 3);
  // mutation: a new site changes the table
  const mutated = SOURCE.replace("function reserve(n, what) {", 'function reserve(n, what) {\n  if (n < 0) halt("s", "failed", "negative");');
  assert.notEqual(render(mutated), render(SOURCE));
});

test("8.8.0: docs/stop-classes.md lists every site in source order with its function and class", () => {
  const rows = DOC.split("\n").filter((l) => /^\|\s*\d+\s*\|/.test(l)).map((l) => l.split(/(?<!\\)\|/).map((x) => x.trim()));
  assert.equal(rows.length, SITES.length, "the table has " + rows.length + " rows, the source " + SITES.length + " sites");
  SITES.forEach((s, i) => {
    const r = rows[i];
    assert.equal(r[2], "`" + s.fn + "`", "row " + (i + 1) + " (line " + s.line + ")");
    assert.equal(r[4], classNames(s), "row " + (i + 1) + " (line " + s.line + ", " + s.fn + ")");
    assert.ok(r[6] && r[6].length > 5, "row " + (i + 1) + " has no reason");
  });
  // the stops that return without halt: [function, class, the source text that sets the class]
  const DIRECT = [
    ["autoFailResult", "safety", /function autoFailResult\([^)]*\) \{\n  state\.stopGate = g\.failedCheck;\n  state\.stopClass = "safety";/],
    ["planMode", "mechanical", /state\.stopGate = "resume";\n(?:\s*\/\/[^\n]*\n)?\s*state\.stopClass = "mechanical";/],
    ["(top)", "safety", /status: "needs_human",\n\s*stop_class: "safety",\n\s*reason:\n\s*"build-engine was started without args/],
  ];
  const drows = DOC.slice(DOC.indexOf("## Stops that return without halt")).split("\n").filter((l) => /^\|\s*`[^`]+`\s*\|/.test(l)).map((l) => l.split(/(?<!\\)\|/).map((x) => x.trim()));
  assert.equal(drows.length, DIRECT.length, "the direct-stop table has " + drows.length + " rows");
  DIRECT.forEach(([fn, cls, re], i) => {
    assert.match(SOURCE, re, fn);
    assert.deepEqual([drows[i][1], drows[i][3]], ["`" + fn + "`", cls]);
  });
  for (const c of CLASSES) assert.ok(rows.concat(drows.map((r) => ["", "", "", "", r[3]])).some((r) => r[4].split(" / ").includes(c)), "no " + c + " row");
});

// ---------------------------------------------------------------- 5: the result carries stop_class

test("8.8.0: an ok-path stop (awaiting_confirmation) carries stop_class null", async () => {
  const out = await runOne(happy(), ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.ok("stop_class" in out.result);
  assert.equal(out.result.stop_class, null);
});

test("8.8.0: a read-only step's second null result stops transient", async () => {
  const s = happy();
  s.intake = [null, null];
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "failed");
  assert.equal(out.result.stop_class, "transient");
});

test("8.8.0: a write step's null result stops safety", async () => {
  const s = happy();
  s.workspace = [null, s.workspace];
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "failed");
  assert.equal(out.result.stop_class, "safety");
});

test("8.8.0: a plan finding the planner cannot fix stops judgment, with options", async () => {
  const s = happy();
  s["role:scope-and-plan"].criteria[1].id = "AC1";
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "plan");
  assert.equal(out.result.stop_class, "judgment");
  assert.ok(Array.isArray(out.result.options) && out.result.options.length === 3, JSON.stringify(out.result.options));
});

test("8.8.0: a branch with build commits and its sealed plan ref returns resume_with, class mechanical", async () => {
  const s = happy();
  const META = { name: "refs/fleet/y42/plan", tag_sha: "7".repeat(40), type: "tag", target: "2222222", target_type: "commit", sha256: "a".repeat(64), task_id: "y42", plan_path: "docs/plans/x.md", ref_ok: true };
  s["infra:branch-scan"] = { status: "ok", reason: "scanned", head: PB, commits: [{ sha: "1111111", subject: "feat(thing): add thing", files: ["src/x.py"] }], refs: [META] };
  const out = await runOne(s, ARGS);
  assert.equal(out.result.resume_with, "build");
  assert.equal(out.result.stop_class, "mechanical");
});

test("8.8.0: a scope-fence stop in build is safety", async () => {
  const s = happy({ script: { "infra:fleet-scan:push": { status: "ok", reason: "scanned", diff: [".fleet/x"], commits: [] } } });
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "scope", out.result.reason);
  assert.equal(out.result.stop_class, "safety");
});

test("8.8.0: an argument stop (no halt) is safety", async () => {
  const out = await runOne(happy(), Object.assign({}, ARGS, { confirm: "maybe" }));
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_class, "safety");
});

// ---------------------------------------------------------------- 6: review B1, the hook-surface read stop

const TRANSIENT = "transient GitHub read failure; re-run";
const CONFIRM = "hook change needs Max's confirmation";
const hsErr = (error) => () => ({ status: "ok", reason: "read", surface: [], make_paths: {}, error });
function rsErr(p, error) {
  const r = { status: "failed", reason: "the program reported an error", surface: [], sources: [], read: [], unreadable: [], error, args: inputsOf(p).args };
  r.program = programOf("ruleset_surface");
  r.file_sha256 = programSha("ruleset_surface");
  r.digest = relayDigestOf(r, K("ruleset_surface"));
  return r;
}
async function hookStop(slot, relay) {
  const s = happy();
  s[slot] = relay;
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "hooks", out.result.reason);
  return out.result;
}

test("8.8.0 review B1: a hook_surface error naming a path that holds HTTP None stays safety, with the confirmation text", async () => {
  for (const e of ["hook or CI file .github/workflows/HTTP None.yml is over 1 MiB or unreadable", "hook file x (HTTP None) is over 1 MiB or unreadable", "repo o/r not readable (HTTP None: runtime: out of memory)"]) {
    const r = await hookStop("infra:hook-surface:plan", hsErr(e));
    assert.equal(r.stop_class, "safety", e);
    assert.ok(r.reason.includes(CONFIRM) && !r.reason.includes(TRANSIENT), r.reason);
  }
});

test("8.8.0 review B1: a ruleset_surface error is transient only in the program's own shape", async () => {
  for (const e of ["repo o/r not readable (HTTP None: runtime: out of memory)", "rules of o/r branch master not readable (HTTP None)", "rules of o/r branch master not readable (page 2: HTTP None: gh crashed)", "org rulesets of o not readable (HTTP None) with the admin:org scope"]) {
    const r = await hookStop("infra:ruleset-surface:plan", (p) => rsErr(p, e));
    assert.equal(r.stop_class, "transient", e);
    assert.ok(r.reason.includes(TRANSIENT), r.reason);
  }
  for (const e of ["hook file HTTP None.yml not readable (HTTP None)", "x repo o/r not readable (HTTP None)", "rules of o/r branch a b not readable (HTTP None)", "repo o/r not readable (HTTP 404)", "repo o/r not readable (HTTP Nonesuch)"]) {
    const r = await hookStop("infra:ruleset-surface:plan", (p) => rsErr(p, e));
    assert.equal(r.stop_class, "safety", e);
    assert.ok(r.reason.includes(CONFIRM) && !r.reason.includes(TRANSIENT), r.reason);
  }
});
