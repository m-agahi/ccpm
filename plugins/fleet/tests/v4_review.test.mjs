// fleet 4.0.0 whole-branch review fixes: the precommit-ids digest and tier,
// the workspace tier, the unreadable parked prior, the re-frozen resume, the
// short-path writer halt, old refs under build auto, and the test DSN in the
// committed plan.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  spawnSync,
  ARGS,
  PC,
  SOURCE,
  SCRIPTS_SRC,
  happy,
  run,
  runOne,
  call,
  inputsOf,
  noUnscripted,
  redigest,
  relayDigestOf,
  scratchRepo,
  sh,
  sha256,
  canon,
  H,
  HASHES_FLAT,
  FP_K1,
  FP_M3,
} from "./harness.mjs";

// confirm auto with a pre-commit check_cmd: the hook ids are read.
function precommitScript(ids) {
  const s = happy();
  Object.assign(s, {
    "hasher:pre-intent": { status: "ok", fingerprint: { head: PC, tree: "P0" } },
    "role:fleet-intent-judge": {
      status: "ok",
      reason: "matches the task",
      verdict: "approve",
      deviations: [],
      coverage: { covered: true, missing: [] },
    },
    "hasher:fp-post:intent": { status: "ok", fingerprint: { head: PC, tree: "P0" } },
    "infra:precommit-ids": { status: "ok", reason: "read", present: true, ids: ids || ["prettier", "check-json"], parser: "yaml", error: null },
  });
  s["role:scope-and-plan"] = Object.assign({}, s["role:scope-and-plan"], { repo_obligations: [{ id: "fmt", kind: "other", instruction: "format", check_cmd: "pre-commit run prettier --all-files" }] });
  s["role:fleet-code-judge:r1"] = Object.assign({}, s["role:fleet-code-judge:r1"], { obligations_check: [{ id: "fmt", met: true, evidence: "ran", check_exit: 0 }] });
  return s;
}
const AUTO = { ...ARGS, confirm: "auto" };
const okish = (o) => o.result && (o.result.status === "ok" || o.result.status === "awaiting_confirmation");

// ---------------------------------------------------------------- fix 2: workspace on sonnet

test("review fix 2: the workspace step runs on sonnet (its default_branch/base_ref feed the diff base)", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  for (const c of out.calls.filter((x) => x.label === "workspace")) assert.equal(c.opts.model, "sonnet");
  assert.ok(out.calls.some((x) => x.label === "workspace"));
});

// ---------------------------------------------------------------- fix 1: precommit-ids digest and tier

test("review fix 1: infra:precommit-ids runs on sonnet", async () => {
  const out = await run(precommitScript(), AUTO);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(call(out, "infra:precommit-ids").opts.model, "sonnet");
});

test("review fix 1: a precommit-ids relay that drops a duplicate hook id after the program printed it stops", async () => {
  // the program saw the hook twice (G2 refuses that); the relay drops one
  const s = precommitScript(["prettier", "prettier"]);
  s.__mutate = { label: "infra:precommit-ids", fn: (r) => Object.assign(r, { ids: ["prettier"] }) };
  const out = await run(s, AUTO);
  assert.ok(!okish(out), "a relay that does not match the digest passed G2: " + out.result.status);
  assert.match(out.result.reason, /precommit-ids.*digest/);
});

test("review fix 1: a precommit-ids relay of another revision stops", async () => {
  const s = precommitScript();
  s.__mutate = { label: "infra:precommit-ids", fn: (r, prompt) => redigest("infra:precommit-ids", Object.assign(r, { args: [r.args ? r.args[0] : "/x", "f".repeat(40)] }), prompt) };
  const out = await run(s, AUTO);
  assert.ok(!okish(out), out.result.status);
  assert.match(out.result.reason, /precommit-ids.*(argument|args)/);
});

test("review fix 1: the precommit-ids prompt asks for the digest and the args", async () => {
  const out = await run(precommitScript(), AUTO);
  const p = call(out, "infra:precommit-ids").prompt;
  assert.match(p, /\{present, ids, parser, error, args, program, digest\}/);
  assert.match(p, /recomputes the digest/);
});

test("review fix 1 (real git): precommit_ids.py prints every key and a digest on every path", () => {
  const wt = scratchRepo("fleet-pci-");
  writeFileSync(join(wt, "a.txt"), "a\n");
  sh(wt, "git", "add", "a.txt");
  sh(wt, "git", "commit", "-q", "-m", "a");
  const absent = sh(wt, "git", "rev-parse", "HEAD").trim();
  writeFileSync(join(wt, ".pre-commit-config.yaml"), "repos:\n  - repo: local\n    hooks:\n      - id: prettier\n      - id: check-json\n");
  sh(wt, "git", "add", ".pre-commit-config.yaml");
  sh(wt, "git", "commit", "-q", "-m", "cfg");
  const good = sh(wt, "git", "rev-parse", "HEAD").trim();
  writeFileSync(join(wt, ".pre-commit-config.yaml"), "repos: [\n");
  sh(wt, "git", "add", ".pre-commit-config.yaml");
  sh(wt, "git", "commit", "-q", "-m", "bad");
  const bad = sh(wt, "git", "rev-parse", "HEAD").trim();
  const keys = ["present", "ids", "parser", "error", "args"];
  const seen = {};
  for (const [name, rev] of [["absent", absent], ["good", good], ["bad", bad]]) {
    const r = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "precommit_ids.py"), wt, rev], { encoding: "utf8" });
    assert.equal(r.status, 0, name + ": " + r.stderr);
    const o = JSON.parse(r.stdout);
    for (const k of keys.concat(["program", "digest"])) assert.ok(k in o, name + " prints " + k);
    assert.deepEqual(o.args, [wt, rev], name);
    assert.equal(o.program.name, "precommit_ids", name);
    assert.equal(o.digest, relayDigestOf(o, keys), name + ": the digest covers every key and the program");
    seen[name] = o;
  }
  assert.equal(seen.absent.present, false);
  assert.equal(seen.absent.error, null);
  assert.ok(seen.good.parser === "yaml" ? seen.good.error === null : typeof seen.good.error === "string");
  if (seen.good.parser === "yaml") assert.deepEqual(seen.good.ids, ["prettier", "check-json"]);
  assert.equal(typeof seen.bad.error, "string");
});

// ---------------------------------------------------------------- fix 5: the short-path writer keeps its halt

// A small, no-new-behaviour plan: the short path, one writer for every criterion.
function shortScript() {
  const s = happy();
  s["role:scope-and-plan"].est_diff_lines = 10;
  s["role:scope-and-plan"].new_behaviour = false;
  delete s["role:fleet-test-writer:AC1:r1"];
  delete s["role:fleet-test-writer:AC2:r1"];
  s["role:fleet-test-writer:short:r1"] = {
    status: "ok",
    reason: "red",
    criterion_id: "short",
    tests: [{ name: "test_a1", covers: "AC1: x" }, { name: "test_b1", covers: "AC2: y" }],
    files: ["tests/test_a.py", "tests/test_b.py"],
  };
  return s;
}

test("review fix 5: a halt inside the short-path writer's role call keeps its stop_gate (contract)", async () => {
  // fault injection: the role table loses the writer's tier for the short
  // writer only, so roleAgent halts at contract; no stub can reach that halt
  const at = "  const tier = state.models[role];\n";
  assert.equal(SOURCE.split(at).length, 2, "the injection point is unique");
  const s = shortScript();
  s.__source = SOURCE.replace(at, "  const tier = /:short:/.test(label) ? null : state.models[role];\n");
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "contract");
  assert.match(out.result.reason, /role fleet-test-writer has no DISPATCH tier/);
  // the control: the same script without the fault takes the short path
  const ok = await run(shortScript(), ARGS);
  assert.equal(ok.result.status, "ok", ok.result.reason);
  assert.equal(ok.result.path, "short");
});

// ---------------------------------------------------------------- fix 3: an unreadable parked prior fails closed

// an eligible confirm "default" plan (bug_fix, no new behaviour) with the intent judge
function defaultHappy() {
  const s = happy();
  Object.assign(s, {
    "hasher:pre-intent": { status: "ok", fingerprint: { head: PC, tree: "P0" } },
    "role:fleet-intent-judge": {
      status: "ok",
      reason: "matches the task",
      verdict: "approve",
      deviations: [],
      coverage: { covered: true, missing: [] },
      classification: { change_kind: "approve", new_behaviour: "approve", quote: "the parser drops NBSP (a regression)" },
    },
    "hasher:fp-post:intent": { status: "ok", fingerprint: { head: PC, tree: "P0" } },
  });
  s["role:scope-and-plan"] = Object.assign({}, s["role:scope-and-plan"], { change_kind: "bug_fix", new_behaviour: false, est_diff_lines: 80 });
  return s;
}
const DEFAULT = { ...ARGS, confirm: "default" };
const PRUN = "n0-1234567";
const R0 = { round: 0, findings: [], criteria: [{ id: "AC1", text: "behaviour 1" }], change_kind: "bug_fix", new_behaviour: false };
function parkedOut(over) {
  const p = Object.assign({ run: PRUN, plan_path: "docs/plans/x.md", draft_chunks: ["# draft plan\n"], findings_chunks: [JSON.stringify({ reason: "x", rounds: [R0], symbols: [] })] }, over || {});
  return (prompt) => {
    const i = inputsOf(prompt);
    return { status: "ok", reason: "read", parked: p, args: [i.scratch, i.plan_tip_time === null ? "null" : String(i.plan_tip_time)] };
  };
}
const UNREADABLE = [
  ["digest", (r) => Object.assign(r, { parked: Object.assign({}, r.parked, { draft_chunks: ["# other"] }) })],
  ["program", (r) => Object.assign(r, { program: { name: "parked", sha256: "0".repeat(64) } })],
  ["args", (r, p) => redigest("infra:load-parked", Object.assign(r, { args: ["/elsewhere", "null"] }), p)],
  ["failed", () => ({ status: "failed", reason: "boom" })],
  ["dead", () => null],
  ["shape", (r, p) => redigest("infra:load-parked", Object.assign(r, { parked: Object.assign({}, r.parked, { run: "../x" }) }), p)],
  ["plan_path", (r, p) => redigest("infra:load-parked", Object.assign(r, { parked: Object.assign({}, r.parked, { plan_path: "/etc/x.md" }) }), p)],
  ["findings", (r, p) => redigest("infra:load-parked", Object.assign(r, { parked: Object.assign({}, r.parked, { findings_chunks: ["{not json"] }) }), p)],
];

test("review fix 3: under default an unreadable parked prior is a blocker (fail closed): Max is asked", async () => {
  for (const [what, fn] of UNREADABLE) {
    const s = defaultHappy();
    s["infra:load-parked"] = parkedOut();
    s.__mutate = { label: "infra:load-parked", fn };
    const out = await runOne(s, DEFAULT);
    assert.equal(out.result.status, "awaiting_confirmation", what + ": " + out.result.reason);
    assert.match(out.result.confirm_reason, /parked prior unreadable \(fail closed\)/, what);
    assert.ok(!out.labels.includes("role:fleet-intent-judge"), what);
  }
  // control: a readable parked prior of the same plan stays eligible
  const s = defaultHappy();
  s["infra:load-parked"] = parkedOut();
  const ok = await runOne(s, DEFAULT);
  assert.equal(ok.result.status, "ok", ok.result.reason);
  // no parked folder at all is not unreadable
  const n = await runOne(defaultHappy(), DEFAULT);
  assert.equal(n.result.status, "ok", n.result.reason);
});

test("review fix 3: under auto an unreadable parked prior stops for Max after the plan commit, as a relaxed re-plan does", async () => {
  for (const [what, fn] of UNREADABLE) {
    const s = defaultHappy();
    s["infra:load-parked"] = parkedOut();
    s.__mutate = { label: "infra:load-parked", fn };
    const out = await runOne(s, AUTO);
    assert.equal(out.result.status, "needs_human", what + ": " + out.result.reason);
    assert.equal(out.result.failed_check, "intent", what);
    assert.match(out.result.reason, /parked prior unreadable \(fail closed\)/, what);
    assert.ok(out.result.plan_ref && out.result.plan_ref.plan_commit, what + ": the plan stays committed for a ruling");
    assert.ok(!out.labels.includes("role:fleet-intent-judge"), what);
  }
});

test("review fix 3: under ask an unreadable parked prior is still ignored with a gate line", async () => {
  for (const [what, fn] of UNREADABLE) {
    const s = happy();
    s["infra:load-parked"] = parkedOut();
    s.__mutate = { label: "infra:load-parked", fn };
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "awaiting_confirmation", what + ": " + out.result.reason);
    assert.ok(!("confirm_reason" in out.result), what);
    assert.ok(out.logs.some((l) => /^parked (draft|findings) ignored \(/.test(l)), what);
  }
});

test("review fix 3: the sealed agent count does not include gate agents an unreadable prior keeps from running", async () => {
  const bad = defaultHappy();
  bad["infra:load-parked"] = parkedOut();
  bad.__mutate = { label: "infra:load-parked", fn: UNREADABLE[0][1] };
  await runOne(bad, AUTO);
  const ask = defaultHappy();
  ask["infra:load-parked"] = parkedOut();
  ask.__mutate = { label: "infra:load-parked", fn: UNREADABLE[0][1] };
  await runOne(ask, ARGS);
  const n = (s) => JSON.parse(s.__store[PC]).history.agents;
  assert.equal(n(bad), n(ask));
});

// ---------------------------------------------------------------- fix 4: no frozen resume after a re-freeze

// A build whose code judge routes fix_tests, the tests are re-frozen (f2 at
// tree M3), and the coder then stops in round 2.
function refrozenCoderStop() {
  const f = { target: "tests", criterion: "AC1", finding: "wrong expectation" };
  const after = H({ ...HASHES_FLAT, "tests/test_a.py": "ha2" });
  const s = happy({
    script: {
      "role:fleet-code-judge:r1": { status: "ok", verdict: "fix_tests", routed_findings: [f] },
      "role:fleet-test-judge:r2": { status: "ok", verdict: "revise", routed_findings: [f] },
      "hasher:fp-post:test-judge:r2": { status: "ok", fingerprint: FP_K1 },
      "role:fleet-test-writer:AC1:r3": { status: "ok", criterion_id: "AC1" },
      "hasher:post-writers:r3": { status: "ok", fingerprint: FP_M3, changed: ["tests/test_a.py"], hashes: after },
      "role:fleet-test-judge:r3": { status: "ok", verdict: "approve", routed_findings: [] },
      "hasher:fp-post:test-judge:r3": { status: "ok", fingerprint: FP_M3 },
      "hasher:freeze:f2": { status: "ok", fingerprint: FP_M3, hashes: after },
      "role:fleet-coder:r2": { status: "needs_human", reason: "coder stuck" },
      "hasher:post-coder:r2": { status: "ok", fingerprint: FP_M3, hashes: after },
    },
  });
  return { s, after };
}
function mapsDigestOf(h) {
  const o = {};
  for (const m of ["files", "sections", "git", "symlinks", "ignored"]) o[m] = Object.assign({}, h[m] || {});
  for (const k of Object.keys(o.git)) if (k.startsWith("fleetref:")) delete o.git[k];
  return sha256(canon(o));
}

test("review fix 4: a stop after a fix_tests re-freeze binds the re-freeze into freeze_digest, and a resume with it halts resume", async () => {
  const { s, after } = refrozenCoderStop();
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.refreeze_log.length, 1);
  const planRef = out.planResult.plan_ref;
  assert.match(out.result.freeze_digest, /^[0-9a-f]{64}$/);
  // the digest is not the one an untouched freeze of the same tree and maps gives
  assert.notEqual(out.result.freeze_digest, sha256(canon({ ref_sha256: planRef.ref_sha256, tree: "M3", mapsDigest: mapsDigestOf(after) })));
  // the worktree is the re-freeze tree, untouched: still no resume
  const h = H({ ...HASHES_FLAT, "tests/test_a.py": "ha2" });
  h.git["fleetref:" + planRef.plan_ref.replace(/\/plan$/, "/freeze")] = "M3";
  s["hasher:resume-frozen"] = { status: "ok", fingerprint: { head: PC, tree: "M3" }, hashes: h };
  s["role:fleet-coder:r1"] = happy()["role:fleet-coder:r1"];
  const b = Object.assign({}, ARGS, { mode: "build", plan_ref: planRef, freeze_digest: out.result.freeze_digest });
  delete b.input;
  const r = await runOne(s, b);
  assert.equal(r.result.status, "needs_human", r.result.reason);
  assert.equal(r.result.stop_gate, "resume");
  assert.match(r.result.reason, /re-frozen after fix_tests/);
  assert.ok(!r.labels.some((l) => /^role:/.test(l)), r.labels.join(", "));
});

// ---------------------------------------------------------------- fix 7: no test DSN in the committed plan

const DECL = { version: 1, engine: "mariadb", major: "11.4", env: "YADGAR_TEST_DSN" };
function withDecl(s) {
  const td = (prompt) => ({ decl: DECL, error: null, args: [inputsOf(prompt).main_worktree, inputsOf(prompt).default_branch] });
  const bs = s["infra:branch-scan"];
  const vp = s["infra:verify-plan"];
  s["infra:branch-scan"] = (prompt) => Object.assign(JSON.parse(JSON.stringify(bs)), { test_db: td(prompt) });
  s["infra:verify-plan"] = (prompt) => Object.assign(JSON.parse(JSON.stringify(vp)), { test_db: td(prompt) });
  return s;
}

test("review fix 7: the planner, plan-audit and pr-review are told never to write a test_env value into the plan, a finding or a PR", async () => {
  const out = await run(withDecl(happy()), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  for (const [o, l] of [[out.plan, "role:scope-and-plan"], [out.plan, "role:plan-audit"], [out.build, "role:pr-review:v1"]]) {
    const i = inputsOf(call(o, l).prompt);
    assert.match(i.test_env.YADGAR_TEST_DSN, /^mysql:\/\//, l + " gets its DSN");
    assert.match(i.test_env_note, /Never write a test_env value \(a DSN, its user or its password\) into the plan doc, a finding, a commit message or a PR/, l);
  }
});

test("review fix 7: a committed plan doc that holds mysql:// stops at verify-plan-commit, with no plan_ref", async () => {
  const s = withDecl(happy());
  s.__mutate = {
    label: "infra:verify-plan-commit",
    fn: (r, prompt) => {
      r.plan_files.dsn_paths = [r.plan_files.files[0]];
      return redigest("infra:verify-plan-commit", r, prompt);
    },
  };
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "db");
  assert.match(out.result.reason, /verify-plan-commit: the committed plan .* holds mysql:\/\//);
  assert.equal(out.result.plan_ref, undefined);
  assert.ok(!out.labels.some((l) => /^role:fleet-intent-judge/.test(l)));
});

test("review fix 7: a verify-plan-commit relay without dsn_paths is a relay problem (fail closed)", async () => {
  const s = happy();
  s.__mutate = {
    label: /^infra:verify-plan-commit/,
    fn: (r, prompt) => {
      delete r.plan_files.dsn_paths;
      return redigest("infra:verify-plan-commit", r, prompt);
    },
  };
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "failed", out.result.reason);
  assert.equal(out.result.stop_gate, "commit");
  assert.match(out.result.reason, /dsn_paths/);
});

test("review fix 7 (real git): plan_files.py lists the HEAD files that hold mysql://, inside its digest", () => {
  const wt = scratchRepo("fleet-pf-");
  writeFileSync(join(wt, "a.txt"), "a\n");
  sh(wt, "git", "add", "a.txt");
  sh(wt, "git", "commit", "-q", "-m", "a");
  const clean = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "plan_files.py"), wt], { encoding: "utf8" });
  assert.equal(clean.status, 0, clean.stderr);
  const c = JSON.parse(clean.stdout);
  assert.deepEqual(c.dsn_paths, []);
  sh(wt, "mkdir", "-p", "docs/plans");
  writeFileSync(join(wt, "docs/plans/p.md"), "# plan\nrun with YADGAR_TEST_DSN=mysql://fleet_plan:abc@127.0.0.1:4000/fleet_plan\n");
  writeFileSync(join(wt, "b.txt"), "b\n");
  sh(wt, "git", "add", "docs/plans/p.md", "b.txt");
  sh(wt, "git", "commit", "-q", "-m", "p");
  const r = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "plan_files.py"), wt], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.deepEqual(o.files.slice().sort(), ["b.txt", "docs/plans/p.md"]);
  assert.deepEqual(o.dsn_paths, ["docs/plans/p.md"]);
  assert.equal(o.digest, relayDigestOf(o, ["head", "files", "args", "dsn_paths"]));
});

test("review fix 1: precommit_ids routes every print through one emit with the digest", () => {
  const m = /\/\/ PRECOMMIT_IDS_PY_BEGIN\n([\s\S]*?)\n\/\/ PRECOMMIT_IDS_PY_END/.exec(SOURCE);
  assert.ok(m);
  const prints = m[1].split("\n").filter((l) => /\bprint\(/.test(l));
  assert.equal(prints.length, 1, prints.join("\n"));
});
