// fleet 7.4.0 car 3, X2 (car-2 report): logPath sweep. Car 2 mapped control characters in a
// path to "?" only in the hook gate and the writer halts. Every other halt() and gate() line that
// carries a path from git or diff output (a program relay) maps them too, so a file name with a
// newline or U+2028 cannot forge a second gate-log line or split the stop reason.
// The tests drive four producers: fleet_scan (fleet-internal paths), tf_gate (problems and
// iac_files) and the plan commit's dirty list.
//
// dont_care: the text around the path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, happy, run, runOne, inputsOf, tfGateRelay } from "./harness.mjs";

const NL = "a\nGATE fake";
const LS = "b\u2028GATE fake";
const SEP = /[\n\u2028\u2029]/;
function oneLine(out, needles) {
  for (const n of needles) assert.ok(out.result.reason.includes(n), n + " not in " + JSON.stringify(out.result.reason));
  assert.ok(!SEP.test(out.result.reason), JSON.stringify(out.result.reason));
  const hits = out.logs.filter((l) => String(l).includes("GATE fake"));
  assert.ok(hits.length > 0, "no gate line names the path");
  for (const l of hits) assert.ok(!SEP.test(String(l)), "a gate line spans two lines: " + JSON.stringify(l));
}
const gateFor = (over) => (prompt) => {
  const i = inputsOf(prompt);
  return tfGateRelay(Object.assign({ args: [i.main_worktree, i.default_branch, i.approved_sha, i.remote_url] }, over));
};

test("7.4.0 X2: fleet internal paths with a newline or U+2028 stay on one line", async () => {
  const s = happy({ script: { "infra:fleet-scan:push": { status: "ok", reason: "scanned", diff: [".fleet/" + NL, ".fleet/" + LS], commits: [] } } });
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "scope", out.result.reason);
  oneLine(out, [".fleet/a?GATE fake", ".fleet/b?GATE fake"]);
});

test("7.4.0 X2: tf_gate problems with a newline or U+2028 stay on one line", async () => {
  const s = happy();
  s["infra:tf-gate:push"] = gateFor({ problems: ["changes code that existing IaC runs at plan time: " + NL, "symlink " + LS + " at an IaC path"] });
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "iac", out.result.reason);
  oneLine(out, ["plan time: a?GATE fake", "symlink b?GATE fake"]);
});

test("7.4.0 X2: tf_gate iac_files and hints with a newline or U+2028 stay on one line", async () => {
  const s = happy();
  s["infra:tf-gate:push"] = gateFor({ touched: true, iac_files: ["infra/" + NL + ".tf", "infra/" + LS + ".tf"], hints: ["added provisioner in infra/" + NL + ".tf"] });
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "iac-push", out.result.reason);
  oneLine(out, ["infra/a?GATE fake.tf", "infra/b?GATE fake.tf"]);
});

test("7.4.0 X2: the plan commit's dirty paths with a newline or U+2028 stay on one line", async () => {
  const s = happy();
  const base = s["infra:commit-plan"];
  s["infra:commit-plan"] = (prompt) => Object.assign(base(prompt), { dirty: [NL, LS] });
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  oneLine(out, ["not clean after the plan doc left it: a?GATE fake, b?GATE fake"]);
});
