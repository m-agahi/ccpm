// fleet 7.4.0 (#18, L2024): a contract-drift retry empties the role's own build dir first.
// retryOnDrift re-ran a role in the build dir its first try left (a half-built target/, a
// stale cache). It now runs infra:build-reset:<role label>:drift for the role's keys before
// the retry: test writers (short and full path), the test judge, the code judge, pr-review
// and the sweep; and the coder's one role_file re-ask (it runs the frozen tests again).
//
// dont_care: the order of the reset against the path re-check (both run before the retry).

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, NONCE, BUILD_SCRATCH, happy, run, inputsOf } from "./harness.mjs";

const idx = (out, l) => out.labels.indexOf(l);
const resetKeys = (out, l) => inputsOf(out.calls.find((c) => c.label === l).prompt).args.slice(3);

test("7.4.0 #18 R1: a test writer's drift retry runs infra:build-reset:...:drift for its own key, before the retry", async () => {
  const s = happy();
  const ok = s["role:fleet-test-writer:AC1:r1"];
  s["role:fleet-test-writer:AC1:r1"] = Object.assign({}, ok, { tests: "x" });
  s["role:fleet-test-writer:AC1:r1:retry"] = ok;
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const reset = "infra:build-reset:fleet-test-writer:AC1:r1:drift";
  assert.ok(idx(out, reset) >= 0, out.labels.join(", "));
  assert.ok(idx(out, reset) < idx(out, "role:fleet-test-writer:AC1:r1:retry"));
  assert.ok(idx(out, reset) > idx(out, "role:fleet-test-writer:AC1:r1"));
  assert.deepEqual(resetKeys(out, reset), ["w-AC1-r1"]);
  const a = inputsOf(out.calls.find((c) => c.label === reset).prompt).args;
  assert.deepEqual(a.slice(0, 3), ["reset", BUILD_SCRATCH, NONCE]);
  // AC2 did not drift: no reset of its own
  assert.ok(!out.labels.some((l) => /build-reset:fleet-test-writer:AC2/.test(l)));
});

test("7.4.0 #18 R1: the short-path writer's drift retry resets the short key", async () => {
  const s = happy();
  s["role:scope-and-plan"] = Object.assign({}, s["role:scope-and-plan"], { est_diff_lines: 10, new_behaviour: false });
  delete s["role:fleet-test-writer:AC1:r1"];
  delete s["role:fleet-test-writer:AC2:r1"];
  const ok = { status: "ok", reason: "red", criterion_id: "short", tests: [{ name: "test_a1", covers: "AC1: x" }, { name: "test_b1", covers: "AC2: y" }], files: ["tests/test_a.py", "tests/test_b.py"] };
  s["role:fleet-test-writer:short:r1"] = Object.assign({}, ok, { files: "x" });
  s["role:fleet-test-writer:short:r1:retry"] = ok;
  const out = await run(s, ARGS);
  assert.ok(out.labels.includes("role:fleet-test-writer:short:r1"), out.labels.join(", "));
  const reset = "infra:build-reset:fleet-test-writer:short:r1:drift";
  assert.ok(idx(out, reset) >= 0 && idx(out, reset) < idx(out, "role:fleet-test-writer:short:r1:retry"), out.labels.join(", "));
  assert.deepEqual(resetKeys(out, reset), ["w-short-r1"]);
});

test("7.4.0 #18 R1: the test judge's and the code judge's drift retries reset their own keys", async () => {
  const s = happy();
  const tj = s["role:fleet-test-judge:r1"];
  s["role:fleet-test-judge:r1"] = Object.assign({}, tj, { checked: "x" });
  s["role:fleet-test-judge:r1:retry"] = tj;
  const cj = s["role:fleet-code-judge:r1"];
  s["role:fleet-code-judge:r1"] = Object.assign({}, cj, { routed_findings: "x" });
  s["role:fleet-code-judge:r1:retry"] = cj;
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  for (const [role, key] of [["fleet-test-judge", "tjudge-r1"], ["fleet-code-judge", "cjudge-r1"]]) {
    const reset = "infra:build-reset:" + role + ":r1:drift";
    assert.ok(idx(out, reset) >= 0, role + ": " + out.labels.join(", "));
    assert.ok(idx(out, reset) < idx(out, "role:" + role + ":r1:retry"), role);
    assert.deepEqual(resetKeys(out, reset), [key]);
  }
});

test("7.4.0 #18 R1: pr-review's drift retry resets review-v1", async () => {
  const s = happy();
  const pr = s["role:pr-review:v1"];
  s["role:pr-review:v1"] = Object.assign({}, pr, { touches_gate: "no" });
  s["role:pr-review:v1:retry"] = pr;
  const out = await run(s, ARGS);
  const reset = "infra:build-reset:pr-review:v1:drift";
  assert.ok(idx(out, reset) >= 0 && idx(out, reset) < idx(out, "role:pr-review:v1:retry"), out.labels.join(", "));
  assert.deepEqual(resetKeys(out, reset), ["review-v1"]);
});

test("7.4.0 #18 R1: no drift, no extra reset", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(!out.labels.some((l) => /:drift$/.test(l)), out.labels.join(", "));
});

test("7.4.0 #18 R1: the coder's one role_file re-ask resets coder-r1 first (its step 1 runs the frozen tests)", async () => {
  const s = happy();
  const ok = s["role:fleet-coder:r1"];
  s["role:fleet-coder:r1:retry"] = ok;
  s["role:fleet-coder:r1"] = Object.assign({}, ok, { role_file: null });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const reset = "infra:build-reset:fleet-coder:r1:drift";
  assert.ok(idx(out, reset) >= 0 && idx(out, reset) < idx(out, "role:fleet-coder:r1:retry"), out.labels.join(", "));
  assert.ok(idx(out, reset) > idx(out, "role:fleet-coder:r1"));
  assert.deepEqual(resetKeys(out, reset), ["coder-r1"]);
});
