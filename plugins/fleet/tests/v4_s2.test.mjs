// fleet 4.0.0 stream S2 (ledger 1984, 1992, 1982): the role output contract
// at the schema with one retry on drift, the sealed project, the brief
// schema, the fleet-v4 marker and the release integration.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SOURCE, ARGS, happy, run, runOne, call, inputsOf, planRefFor, buildArgs, sha256, canon, FROZEN_VERSIONS, CONTRACT_LINE } from "./harness.mjs";

// REQUIRED_ON_OK as written in the script source
function requiredOf() {
  const m = /const REQUIRED_ON_OK = (\{[\s\S]*?\n\});/.exec(SOURCE);
  assert.ok(m, "REQUIRED_ON_OK in source");
  return Function("return " + m[1])();
}

// ---------------------------------------------------------------- S2 keys (D10)

test("4.0.0 S2 keys: REQUIRED_ON_OK has the planner change_kind and the intent-judge classification", () => {
  const req = requiredOf();
  assert.ok(req["scope-and-plan"].includes("change_kind"));
  assert.ok(req["scope-and-plan"].includes("new_behaviour"));
  assert.ok(req["fleet-intent-judge"].includes("classification"));
});

test("4.0.0 S2 keys: the planner schema types change_kind, new_behaviour and criteria[].test_args", async () => {
  const out = await run(happy(), ARGS);
  const sch = call(out, "role:scope-and-plan").opts.schema;
  const ck = sch.properties.change_kind;
  assert.deepEqual([].concat(ck.enum).filter((v) => v !== null), ["bug_fix", "feature", "refactor", "chore"]);
  assert.ok([].concat(sch.properties.new_behaviour.type).includes("boolean"));
  const item = sch.properties.criteria.items;
  assert.ok([].concat(item.properties.test_args.type).includes("string"), "criteria[].test_args is a string");
  assert.ok(!item.required.includes("test_args"), "test_args stays optional");
});

test("4.0.0 S2 keys: the intent-judge schema has classification {change_kind, new_behaviour, quote}", async () => {
  const out = await run(happy({ script: { "hasher:pre-intent": { status: "ok", fingerprint: { head: "abc1234def0", tree: "P0" } } } }), { ...ARGS, confirm: "auto" });
  const c = out.calls.find((x) => x.label === "role:fleet-intent-judge");
  assert.ok(c, "intent judge dispatched: " + out.labels.join(", "));
  const cl = c.opts.schema.properties.classification;
  assert.ok([].concat(cl.type).includes("object"));
  for (const k of ["change_kind", "new_behaviour"]) assert.deepEqual(cl.properties[k].enum, ["approve", "refuse"]);
  assert.deepEqual(cl.properties.quote.type, "string");
  assert.deepEqual(cl.required, ["change_kind", "new_behaviour", "quote"]);
});

test("4.0.0 S2 keys: the caller grep relay carries auto_dont_care and doctest_md", () => {
  const m = /const INFRA_SCHEMA = \{[\s\S]*?\n\};/.exec(SOURCE);
  assert.ok(m);
  // S4 (1989): per symbol, like occurrences
  assert.match(m[0], /auto_dont_care: \{ type: "object", additionalProperties: \{ type: "array", items: STR \} \}/);
  assert.match(m[0], /doctest_md: \{ type: "array", items: STR \}/);
});

test("4.0.0 S2 keys: an ok planner without change_kind, or with a bad one, is contract drift", async () => {
  const noKind = { __raw: true, ...happyPlanner(), change_kind: undefined };
  let out = await run(happy({ script: { "role:scope-and-plan": noKind, "role:scope-and-plan:retry": noKind } }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /scope-and-plan contract drift: missing change_kind/);
  const hotfix = { __raw: true, ...happyPlanner(), change_kind: "hotfix" };
  out = await run(happy({ script: { "role:scope-and-plan": hotfix, "role:scope-and-plan:retry": hotfix } }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /contract drift: scope-and-plan change_kind/);
});

// A complete planner result as the role runner returns it (raw: no defaults).
export function happyPlanner(over = {}) {
  const s = happy();
  const p = JSON.parse(JSON.stringify(s["role:scope-and-plan"]));
  return Object.assign(
    p,
    {
      role_version: s.preflight.versions["scope-and-plan"],
      role_contract: s.preflight.contract["scope-and-plan"],
      allowed_additions: { files: [], symbols: [], deps: [], settings: [] },
      held_out_examples: [],
      repo_obligations: [],
      test_cmd: { command: "pytest <paths>", paths_placeholder: "<paths>", env: {}, tools: [] },
      changed_symbols: [],
      change_kind: "feature",
    },
    over,
  );
}

// ---------------------------------------------------------------- 1984 contract at the schema

const ROLE_LABEL = {
  "scope-and-plan": "role:scope-and-plan",
  "plan-audit": "role:plan-audit",
  "fleet-test-writer": "role:fleet-test-writer:AC1:r1",
  "fleet-test-judge": "role:fleet-test-judge:r1",
  "fleet-coder": "role:fleet-coder:r1",
  "fleet-code-judge": "role:fleet-code-judge:r1",
  "fleet-pr-opener": "role:fleet-pr-opener",
  "pr-review": "role:pr-review:v1",
};

// raw role stubs carry what the runner loaded
function rawRole(role, fields) {
  const s = happy();
  return { __raw: true, status: "ok", reason: "x", role_version: s.preflight.versions[role], role_contract: s.preflight.contract[role], ...fields };
}

test("AC-1984-1: the coder schema requires its 5 keys; added_symbols is array or null", async () => {
  const out = await run(happy(), ARGS);
  const sch = call(out, "role:fleet-coder:r1").opts.schema;
  for (const k of ["changed_paths", "suite_result", "added_symbols", "frozen_tests_red_at_start", "obligations_done"]) assert.ok(sch.required.includes(k), k);
  assert.deepEqual(sch.properties.added_symbols.type, ["array", "null"]);
});

test("1984: every role schema requires its REQUIRED_ON_OK keys, nullable, and each one has a property", async () => {
  const req = requiredOf();
  const out = await run(happy(), ARGS);
  for (const [role, label] of Object.entries(ROLE_LABEL)) {
    const sch = call(out, label).opts.schema;
    for (const k of sch.required) assert.ok(k in sch.properties, role + " required " + k + " has no property");
    for (const k of req[role]) {
      assert.ok(sch.required.includes(k), role + " requires " + k);
      const p = sch.properties[k];
      assert.ok([].concat(p.type).includes("null"), role + " " + k + " nullable");
      if (p.enum) assert.ok(p.enum.includes(null), role + " " + k + " enum allows null");
    }
    // shared type constants are not widened in place
    assert.equal(sch.properties.reason.type, "string", role + " reason stays a string");
    assert.equal(sch.properties.status.enum.includes(null), false);
  }
});

test("AC-1984-2: plan-audit drops routed_findings once; the retry is complete and the run continues", async () => {
  const s = happy({
    script: {
      "role:plan-audit": rawRole("plan-audit", { verdict: "approve" }),
      "role:plan-audit:retry": rawRole("plan-audit", { verdict: "approve", routed_findings: [] }),
    },
  });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const gl = out.planResult.gate_log;
  assert.ok(gl.some((g) => /plan-audit: contract drift \(missing routed_findings\); retried once/.test(g)), gl.join("\n"));
  const rp = call(out, "role:plan-audit:retry").prompt;
  assert.match(rp, /Your previous result was refused: role plan-audit contract drift: missing routed_findings\. Return the whole object again\./);
  // a fresh PATH re-check right before the retry
  const i = out.labels.indexOf("role:plan-audit:retry");
  assert.equal(out.labels[i - 1], "infra:path-check:plan-audit:retry");
});

test("AC-1984-2: two drifts halt with stop_gate contract", async () => {
  const s = happy({
    script: {
      "role:plan-audit": rawRole("plan-audit", { verdict: "approve" }),
      "role:plan-audit:retry": rawRole("plan-audit", { verdict: "approve" }),
    },
  });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "contract");
  assert.match(out.result.reason, /plan-audit contract drift: missing routed_findings/);
  assert.ok(!out.labels.includes("role:plan-audit:retry:retry"));
});

test("1984: a version or contract mismatch never retries", async () => {
  let out = await run(happy({ script: { "role:plan-audit": rawRole("plan-audit", { verdict: "approve", routed_findings: [], role_version: 1 }) } }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /runner loaded version 1/);
  assert.ok(!out.labels.some((l) => /:retry$/.test(l)), out.labels.join(", "));
  out = await run(happy({ script: { "role:plan-audit": rawRole("plan-audit", { verdict: "approve", routed_findings: [], role_contract: "CONTRACT: fleet-v1" }) } }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.ok(!out.labels.some((l) => /:retry$/.test(l)));
  // a version mismatch that also drifts still never retries
  out = await run(happy({ script: { "role:plan-audit": rawRole("plan-audit", { verdict: "approve", role_version: 1 }) } }), ARGS);
  assert.match(out.result.reason, /runner loaded version 1/);
  assert.ok(!out.labels.some((l) => /:retry$/.test(l)), out.labels.join(", "));
});

test("1984: null on ok for a key whose frozen type has no null is drift (est_diff_lines, change_kind, plan_path, tldr)", async () => {
  for (const [k, re] of [
    ["est_diff_lines", /scope-and-plan est_diff_lines type: got null/],
    ["change_kind", /scope-and-plan change_kind type: got null/],
    ["plan_path", /scope-and-plan plan_path type: got null/],
    ["tldr", /scope-and-plan tldr type: got null/],
  ]) {
    const bad = { __raw: true, ...happyPlanner({ [k]: null }) };
    const out = await run(happy({ script: { "role:scope-and-plan": bad, "role:scope-and-plan:retry": bad } }), ARGS);
    assert.equal(out.result.status, "needs_human", k);
    assert.equal(out.result.stop_gate, "contract", k);
    assert.match(out.result.reason, re);
  }
  // a string where the frozen type is a number is drift too
  const s = { __raw: true, ...happyPlanner({ est_diff_lines: "10" }) };
  const out = await run(happy({ script: { "role:scope-and-plan": s, "role:scope-and-plan:retry": s } }), ARGS);
  assert.match(out.result.reason, /est_diff_lines type: got string/);
});

test("1984: null stays allowed where the frozen type allows it (pr-opener template_used)", async () => {
  const out = await run(happy({ script: { "role:fleet-pr-opener": { status: "ok", reason: "opened", pr_url: "https://github.com/o/r/pull/7", pr_number: 7, created: true, template_used: null, gates_not_run_stated: true } } }), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(!out.labels.includes("role:fleet-pr-opener:retry"), out.labels.join(", "));
});

test("1984: a judge retries inside its fingerprint bracket", async () => {
  const s = happy({
    script: {
      "role:fleet-test-judge:r1": rawRole("fleet-test-judge", { verdict: "approve", routed_findings: [] }),
      "role:fleet-test-judge:r1:retry": rawRole("fleet-test-judge", { verdict: "approve", routed_findings: [], checked: [] }),
    },
  });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const L = out.labels;
  const a = L.indexOf("role:fleet-test-judge:r1"), b = L.indexOf("role:fleet-test-judge:r1:retry"), c = L.indexOf("hasher:fp-post:test-judge:r1");
  assert.ok(a >= 0 && a < b && b < c, L.join(", "));
});

test("1984: a judge that mutates the worktree is reported before its drift", async () => {
  const s = happy({
    script: {
      "role:fleet-test-judge:r1": rawRole("fleet-test-judge", { verdict: "approve", routed_findings: [] }),
      "role:fleet-test-judge:r1:retry": rawRole("fleet-test-judge", { verdict: "approve", routed_findings: [] }),
      "hasher:fp-post:test-judge:r1": { status: "ok", fingerprint: { head: "abc1234def0", tree: "CHANGED" } },
    },
  });
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "fingerprint");
});

test("1984: only the drifting writer retries", async () => {
  const s = happy({
    script: {
      "role:fleet-test-writer:AC1:r1": rawRole("fleet-test-writer", { criterion_id: "AC1", tests: [] }),
      "role:fleet-test-writer:AC1:r1:retry": rawRole("fleet-test-writer", { criterion_id: "AC1", tests: [], files: ["tests/test_a.py"] }),
    },
  });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.labels.includes("role:fleet-test-writer:AC1:r1:retry"));
  assert.ok(!out.labels.includes("role:fleet-test-writer:AC2:r1:retry"));
});

test("AC-1984-3: the coder is never re-run on drift; round 2 gets the drift as a finding", async () => {
  const s = happy({
    script: {
      "role:fleet-coder:r1": { status: "ok", reason: "done", changed_paths: ["src/x.py"], added_symbols: null, frozen_tests_red_at_start: true, suite_result: { command: "pytest", exit_code: 0 } },
      "role:fleet-coder:r2": { status: "ok", changed_paths: ["src/x.py"] },
      "hasher:post-coder:r2": { status: "ok", fingerprint: { head: "abc1234def0", tree: "K2" } },
      "role:fleet-code-judge:r2": { status: "ok", verdict: "approve", routed_findings: [] },
      "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: { head: "abc1234def0", tree: "K2" } },
    },
  });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(!out.labels.includes("role:fleet-coder:r1:retry"));
  assert.ok(!out.labels.includes("role:fleet-code-judge:r1"), "no judge on a drifted coder round");
  const f = inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings;
  assert.equal(f.length, 1);
  assert.equal(f[0].target, "code");
  assert.match(f[0].finding, /contract drift: fleet-coder added_symbols type: got null/);
});

test("1984: coder drift in every round ends at the code round cap", async () => {
  const bad = { status: "ok", reason: "done", changed_paths: ["src/x.py"], added_symbols: null, frozen_tests_red_at_start: true, suite_result: { command: "pytest", exit_code: 0 } };
  const s = happy({
    script: {
      "role:fleet-coder:r1": bad,
      "role:fleet-coder:r2": bad,
      "role:fleet-coder:r3": bad,
      "hasher:post-coder:r2": { status: "ok", fingerprint: { head: "abc1234def0", tree: "K2" } },
      "hasher:post-coder:r3": { status: "ok", fingerprint: { head: "abc1234def0", tree: "K3" } },
    },
  });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /code rounds exhausted/);
  assert.ok(!out.labels.includes("role:fleet-coder:r4"));
});

// ---------------------------------------------------------------- 1992 sealed project

// the sealed ref the plan run wrote, and a re-sealed variant
function sealedRef(s, tiny) {
  return JSON.parse(s.__store[tiny.plan_commit]);
}
function reseal(s, tiny, edit) {
  const ref = sealedRef(s, tiny);
  edit(ref);
  delete ref.seal;
  ref.seal = sha256(canon(ref));
  s.__store[tiny.plan_commit] = JSON.stringify(ref) + "\n";
  return { ...tiny, ref_sha256: sha256(s.__store[tiny.plan_commit]) };
}

test("AC-1992: the plan ref seals project and plan_facts change_kind/new_behaviour", async () => {
  const s = happy();
  const tiny = await planRefFor(s);
  const ref = sealedRef(s, tiny);
  assert.equal(ref.project, "o/r");
  assert.equal(ref.plan_facts.change_kind, "feature");
  assert.equal(ref.plan_facts.new_behaviour, true);
  // no args.project: sealed null
  const s3 = happy();
  const out3 = await runOne(s3, { ...ARGS, project: undefined });
  assert.equal(out3.result.status, "awaiting_confirmation", out3.result.reason);
  assert.equal(sealedRef(s3, out3.result.plan_ref).project, null);
});

test("AC-1992: a build without project uses the sealed project for the ledger and write-back", async () => {
  const s = happy();
  const tiny = await planRefFor(s);
  const out = await runOne(s, buildArgs(tiny, { project: undefined }));
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(inputsOf(call(out, "infra:ledger-writeback").prompt).project, "o/r");
  assert.ok(out.result.gate_log.some((g) => /project o\/r from the sealed plan ref/.test(g)));
});

test("AC-1992: a build with a different project halts with project mismatch", async () => {
  const s = happy();
  const tiny = await planRefFor(s);
  const out = await runOne(s, buildArgs(tiny, { project: "x/y" }));
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /project mismatch: args\.project "x\/y" but plan ref refs\/fleet\/[^ ]+ sealed "o\/r"/);
  assert.ok(!out.labels.some((l) => l.startsWith("role:")), out.labels.join(", "));
});

test("AC-1992: an old ref with no project keeps the 3.1.3 behaviour", async () => {
  const s = happy();
  const tiny = await planRefFor(s);
  const old = reseal(s, tiny, (r) => {
    delete r.project;
    delete r.plan_facts.change_kind;
    delete r.plan_facts.new_behaviour;
  });
  let out = await runOne(s, buildArgs(old));
  assert.equal(out.result.status, "ok", out.result.reason);
  // no project anywhere: the 3.1.3 halt for a yadgar ledger source
  out = await runOne(s, buildArgs(old, { project: undefined }));
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /needs args\.project/);
});

test("1992: a sealed project that is not a non-empty string or null is a changed ref", async () => {
  for (const bad of [42, "", ["o/r"]]) {
    const s = happy();
    const tiny = await planRefFor(s);
    const t = reseal(s, tiny, (r) => {
      r.project = bad;
    });
    const out = await runOne(s, buildArgs(t));
    assert.equal(out.result.status, "needs_human", JSON.stringify(bad));
    assert.match(out.result.reason, /plan ref missing or changed.*project/);
  }
});

// ---------------------------------------------------------------- history.preflight shape (S2 owns the field)

test("4.0.0: history.preflight is optional; when present it is {fleet_version, versions, dispatch, contract}", async () => {
  const good = { fleet_version: "4.0.0", versions: { "plan-audit": 17 }, dispatch: { "plan-audit": "DISPATCH: model=opus" }, contract: { "plan-audit": "CONTRACT: fleet-v4" } };
  for (const [pf, ok] of [
    [undefined, true],
    [null, true],
    [good, true],
    [{ ...good, fleet_version: 4 }, false],
    [{ ...good, versions: null }, false],
    [{ ...good, dispatch: [] }, false],
    [{ fleet_version: "4.0.0", versions: {}, dispatch: {} }, false],
    ["4.0.0", false],
  ]) {
    const s = happy();
    const tiny = await planRefFor(s);
    const t = reseal(s, tiny, (r) => {
      if (pf === undefined) delete r.history.preflight;
      else r.history.preflight = pf;
    });
    const out = await runOne(s, buildArgs(t));
    if (ok) assert.equal(out.result.status, "ok", JSON.stringify(pf) + ": " + out.result.reason);
    else {
      assert.equal(out.result.status, "needs_human", JSON.stringify(pf));
      assert.match(out.result.reason, /plan ref missing or changed.*history\.preflight/);
    }
  }
});

test("4.0.0: makePlanRef carries history.preflight through to the seal", async () => {
  const m = /function makePlanRef\(f\) \{[\s\S]*?\n\}/.exec(SOURCE);
  assert.ok(m);
  assert.match(m[0], /history: f\.history/);
  assert.match(m[0], /project: typeof f\.project === "string" && f\.project \? f\.project : null/);
});

// ---------------------------------------------------------------- 1982 brief schema

test("1982: the intake source schema and the README agree on {kind, ref, url, body, id, project}", async () => {
  const out = await run(happy(), ARGS);
  const src = call(out, "intake").opts.schema.properties.brief.properties.sources.items;
  assert.deepEqual(Object.keys(src.properties).sort(), ["body", "id", "kind", "project", "ref", "url"]);
  assert.deepEqual(src.properties.kind.enum, ["ledger", "yaadgaar", "jira", "github", "codeberg", "plan", "text"]);
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /sources: \[\{kind, ref, url, body, id,\s+project\}\]/);
  assert.match(readme, /`kind` is one of `ledger`, `yaadgaar`, `jira`, `github`, `codeberg`,\s+`plan` and `text`/);
});

// ---------------------------------------------------------------- integration: version 4.0.0

test("4.0.0: FLEET_VERSION equals the fleet version in marketplace.json, the root README and the CHANGELOG", () => {
  const fv = /^const FLEET_VERSION = "(\d+\.\d+\.\d+)";$/m.exec(SOURCE);
  assert.ok(fv, "FLEET_VERSION constant");
  const mk = JSON.parse(readFileSync(new URL("../../../.claude-plugin/marketplace.json", import.meta.url), "utf8"));
  const fleet = mk.plugins.filter((p) => p.name === "fleet");
  assert.equal(fleet.length, 1);
  assert.equal(fleet[0].version, fv[1]);
  const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
  assert.match(readme, new RegExp("^### fleet \\(v" + fv[1].replace(/\./g, "\\.") + "\\)$", "m"));
  const cl = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  const top = /^## \[([^\]]+)\]/m.exec(cl);
  assert.equal(top[1], fv[1], "the newest CHANGELOG entry is this version");
  assert.ok(!/^## \[Unreleased\]/m.test(cl), "no [Unreleased] section left");
});

// ---------------------------------------------------------------- contract fleet-v4 (D1, plan §2 rev 3)

const V4_VERSIONS = {
  "scope-and-plan": 29,
  "plan-audit": 17,
  "fleet-test-writer": 11,
  "fleet-test-judge": 11,
  "fleet-coder": 18,
  "fleet-code-judge": 16,
  "fleet-pr-opener": 11,
  "fleet-intent-judge": 3,
  "pr-review": 19,
  "gate-change-nonweakening-sweep": 6,
};

test("4.0.0 D1: CONTRACT is fleet-v4 and EXPECTED_VERSIONS are the rev-3 pins", () => {
  assert.match(SOURCE, /^const CONTRACT = "fleet-v4";$/m);
  const m = /const EXPECTED_VERSIONS = (\{[\s\S]*?\n\});/.exec(SOURCE);
  assert.ok(m);
  assert.deepEqual(Function("return " + m[1])(), V4_VERSIONS);
  assert.deepEqual(FROZEN_VERSIONS, V4_VERSIONS, "the harness mirrors the pins");
  assert.equal(CONTRACT_LINE, "CONTRACT: fleet-v4");
});

test("4.0.0 D1: a fleet-v3 page halts preflight with the reload hint; a page below its pin halts", async () => {
  const s = happy();
  s.preflight.contract["plan-audit"] = "CONTRACT: fleet-v3";
  let out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "contract");
  assert.match(out.result.reason, /role plan-audit contract fleet-v3 != fleet-v4.*reload-plugins/);
  const t = happy();
  t.preflight.versions["scope-and-plan"] = 28;
  out = await runOne(t, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /scope-and-plan/);
  assert.ok(!out.labels.includes("role:scope-and-plan"));
});
