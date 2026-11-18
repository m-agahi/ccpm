// fleet 8.0.0 car F: the fixes of reviews A and B (r8-review-findings.md).
// - A-H1: a gate's result of an earlier round of this build is never lost: a not_run after an
//   earlier ran (or after findings), or a partial after an earlier ran with findings, stops at
//   gate gates; the mark survives a resume (gates_seen in the run state).
// - G2 ruling: a red baseline in the copy reruns the suite at the plan base; base green and tree
//   red stops at gates (a reason that starts "tree red").

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { HERE, SOURCE, ARGS, happy, run, inputsOf, call, FP_K2, HASHES, mutOut, secOut, coverOut, stateJsonOf } from "./harness.mjs";

const SCRIPTS = join(HERE, "..", "scripts");
const SKILL = join(HERE, "..", "skills", "build-task");

const approve = (over) => Object.assign({ status: "ok", reason: "good", verdict: "approve", routed_findings: [], hash_check: { match: true, mismatched: [] }, suite_result: { command: "pytest", exit_code: 0 } }, over);
const fixCode = approve({ verdict: "fix_code", routed_findings: [{ target: "code", criterion: null, finding: "tidy" }] });
const R2 = {
  "role:fleet-coder:r2": { status: "ok", changed_paths: ["src/x.py"] },
  "hasher:post-coder:r2": { status: "ok", fingerprint: FP_K2, hashes: HASHES },
  "role:fleet-code-judge:r2": approve(),
  "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: FP_K2 },
};
// a gates stub: each slot the harness default, with the given overrides
const gs = (cov, mut, sec) => (p) => ({ status: "ok", reason: "ran", coverage: coverOut(p, cov), mutation: mutOut(p, mut), security_scan: secOut(p, sec) });
const UNCOV = { status: "ran", reason: "2 uncovered added line(s) in 1 file(s)", findings: [{ path: "src/x.py", lines: [3, 4] }] };
const CLEAN = { status: "ran", reason: null, findings: [] };
const SURV = { status: "ran", reason: "0 killed, 1 survived of 1 mutant(s)", survived: [{ id: "m1", path: "src/x.py", line: 3, op: "flip: == -> !=" }] };
const MCLEAN = { status: "ran", reason: "1 killed, 0 survived of 1 mutant(s)", killed: 1 };
const NR = { status: "not_run", reason: "baseline red in scratch copy at the tree and at the base (exit 1, 1): the environment" };

async function rounds(r1, r2, j1) {
  return run(happy({ script: Object.assign({ "infra:gates:r1": r1, "infra:gates:r2": r2, "role:fleet-code-judge:r1": j1 || approve() }, R2) }), ARGS);
}
const stopsAtGates = (out, re) => {
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "gates");
  assert.match(out.result.reason, re);
  assert.ok(!out.labels.includes("role:fleet-code-judge:r2"), "no judge after the stop");
};

test("8.0.0 car F A-H1: coverage findings in round 1, not_run in round 2 -> needs_human at gates", async () => {
  const out = await rounds(gs(UNCOV), gs(NR));
  stopsAtGates(out, /^infra:gates:r2: gate coverage not_run .*after an earlier round's result/);
});

test("8.0.0 car F A-H1: mutation survivors in round 1, not_run in round 2 -> needs_human at gates", async () => {
  const out = await rounds(gs(null, SURV), gs(null, NR));
  stopsAtGates(out, /^infra:gates:r2: gate mutation not_run /);
});

test("8.0.0 car F A-H1: any not_run after an earlier clean ran stops; a partial stops only after a ran with findings", async () => {
  stopsAtGates(await rounds(gs(CLEAN), gs(NR), fixCode), /gate coverage not_run/);
  stopsAtGates(await rounds(gs(null, MCLEAN), gs(null, NR), fixCode), /gate mutation not_run/);
  stopsAtGates(await rounds(gs(UNCOV), gs({ status: "partial", reason: "the 540 s deadline was hit before the coverage report", findings: [] })), /gate coverage partial/);
  const sec = { status: "ran", reason: null, findings: [{ path: "src/x.py", lines: [3], rule: "grep: shell=True", kind: "code" }] };
  stopsAtGates(await rounds(gs(null, null, sec), gs()), /gate security_scan partial/);
  // a partial after a clean ran: no stop (a .js file next to the python one is partial)
  const ok = await rounds(gs(CLEAN), gs({ status: "partial", reason: "not measured (not python): a.js", findings: [] }), fixCode);
  assert.equal(ok.result.status, "ok", ok.result.reason);
  // not_run in both rounds: no earlier result, no stop (the harness default)
  const nr = await rounds(gs(), gs(), fixCode);
  assert.equal(nr.result.status, "ok", nr.result.reason);
});

test("8.0.0 car F G2 ruling: tree red with a green base -> needs_human at gates in that round", async () => {
  const red = { status: "not_run", reason: "tree red, base green: the judged tree fails test_cmd in the scratch copy (exit 1)" };
  for (const s of [gs(red), gs(null, red)]) {
    const out = await run(happy({ script: { "infra:gates:r1": s } }), ARGS);
    stopsAtGates(out, /^infra:gates:r1: gate (coverage|mutation) not_run \(tree red, base green/);
  }
});

test("8.0.0 car F A-H1: the earlier-result mark is saved in the run state (gates_seen) and restored on a resume", async () => {
  const out = await run(happy({ script: { "infra:gates:r1": gs(CLEAN, MCLEAN) } }), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const st = stateJsonOf(call(out, "infra:state:committed:r1").prompt);
  assert.deepEqual(st.gates_seen, { coverage: 1, mutation: 1, security_scan: 0 });
  const st2 = stateJsonOf(call(await run(happy(), ARGS), "infra:state:committed:r1").prompt);
  assert.deepEqual(st2.gates_seen, { coverage: 0, mutation: 0, security_scan: 0 });
  assert.match(SOURCE, /for \(const \[g, n\] of Object\.entries\(Object\(resume\.gates_seen\)\)\)/);
});

test("8.0.0 car F A-H2: gitleaks runs with the plugin's pinned config: the default rules with no global path allowlist", () => {
  const src = readFileSync(join(SCRIPTS, "sec_scan.py"), "utf8");
  const pin = /\nGITLEAKS_SHA256 = '([0-9a-f]{64})'\n/.exec(src);
  assert.ok(pin, "GITLEAKS_SHA256");
  const toml = readFileSync(join(SKILL, "gitleaks.toml"));
  assert.equal(pin[1], createHash("sha256").update(toml).digest("hex"));
  const t = toml.toString("utf8");
  // the global [allowlist] keeps its regexes and stopwords, but no paths list (lock files, node_modules/, go.sum)
  const glob = t.slice(t.indexOf("\n[allowlist]\n"), t.indexOf("\n[[rules]]\n"));
  assert.ok(glob.length > 0 && !/\npaths = \[/.test(glob), glob);
  assert.ok(!/^\s*(\[extend\]|useDefault)/m.test(t), "useDefault inherits the default path allowlist");
  assert.ok(!/node_modules|package-lock|go\\\.\(\?:mod\|sum/.test(glob));
  assert.ok((t.match(/\n\[\[rules\]\]\n/g) || []).length >= 200, "the default rules");
  assert.match(src, /'--config', '\/rules\/gitleaks\.toml'/);
});
