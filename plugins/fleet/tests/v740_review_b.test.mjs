// fleet 7.4.0 review fixes, B group (workflow side):
// - B-M3: the plan sweep runs only for a planned file or test file on a gate path (or touches_gate),
//   never for a caller occurrence alone; a sweep that did not finish is a warning, not a stop; a
//   weakening sweep still stops the plan (v740_plan_sweep Z2).
// - B-M4: UV_CACHE_DIR is one dir per run (<scratch>/uv-cache/<nonce>), outside build/ (a reset
//   deletes build/); UV_PROJECT_ENVIRONMENT stays per role.
// - B-m1: the push-access probe runs with a 180 s Bash timeout (its git runs up to 120 s).
// - B-m3: the workflow's push slug pattern is push.py's SLUG, character for character.
// - B-m7: a fleet-brief marker under confirm default or auto asks (confirm ask) with a gate line, in
//   place of a stop.
//
// dont_care: the warning wording after "plan sweep".

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ARGS, NONCE, BUILD_SCRATCH, BRIEF, PB, happy, run, runOne, call, inputsOf } from "./harness.mjs";

const SRC = readFileSync(new URL("../src/build-task-run.js", import.meta.url), "utf8");
const PUSH = readFileSync(new URL("../scripts/push.py", import.meta.url), "utf8");
const SW = "role:gate-change-nonweakening-sweep:plan";
const SFX = ["", ":audit-fix", ":audit-fix-2"];
const fence = (files) => ({ files, symbols: [], deps: [], settings: [] });

function plan(over, sweep) {
  const s = happy();
  for (const x of SFX) {
    s["role:scope-and-plan" + x] = Object.assign({}, s["role:scope-and-plan"], over || {});
    s["role:plan-audit" + x] = s["role:plan-audit"];
    if (sweep) s[SW + x] = sweep;
  }
  return s;
}

test("7.4.0 review B-M3: a caller occurrence on a gate path alone runs no plan sweep", async () => {
  const cs = [{ symbol: "guard_verdict", occurrences: [{ at: "chart/guards.py:10", criterion: "AC1", dont_care: null }] }];
  const s = plan({ changed_symbols: cs, allowed_additions: fence(["src/x.py"]), touches_gate: false });
  s["infra:callers"] = { status: "ok", reason: "grepped", occurrences: { guard_verdict: ["chart/guards.py:10"] }, capped: [] };
  const out = await runOne(s, ARGS);
  assert.ok(!out.labels.some((l) => /gate-change-nonweakening-sweep/.test(l)), out.labels.join(", "));
});

test("7.4.0 review B-M3: a plan sweep that did not finish is a warning; the plan goes on", async () => {
  for (const sw of [{ status: "error", reason: "base_ref unreadable" }]) {
    const out = await runOne(plan({ allowed_additions: fence(["plugins/x/hooks/check.py"]) }, sw), ARGS);
    assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
    assert.ok(out.logs.some((l) => /warning: plan sweep did not finish/.test(l)), out.logs.join("\n"));
    assert.ok(out.labels.includes("infra:commit-plan"));
  }
});

test("7.4.0 review B-M4: UV_CACHE_DIR is one per run outside build/; UV_PROJECT_ENVIRONMENT stays per role", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const want = BUILD_SCRATCH + "/uv-cache/" + NONCE;
  for (const [label, key] of [["role:fleet-test-writer:AC1:r1", "w-AC1-r1"], ["role:fleet-coder:r1", "coder-r1"]]) {
    const e = inputsOf(call(out, label).prompt).test_env;
    assert.equal(e.UV_CACHE_DIR, want, label);
    assert.equal(e.UV_PROJECT_ENVIRONMENT, BUILD_SCRATCH + "/build/" + NONCE + "/" + key + "/uv-venv", label);
  }
});

test("7.4.0 review B-m1: the push-access probe runs as one Bash call with timeout 180000 ms", async () => {
  const out = await run(happy(), ARGS);
  const p = call(out.plan, "infra:push-probe").prompt;
  assert.match(p, /as one Bash call with timeout 180000 ms/);
});

test("7.4.0 review B-m3: the workflow's push slug pattern equals push.py's SLUG", () => {
  const js = /const PUSH_SLUG_RE = \/(.*)\/;/.exec(SRC);
  const py = /^SLUG = re\.compile\(r'(.*)'\)$/m.exec(PUSH);
  assert.ok(js && py);
  assert.equal(js[1].replace(/\\\//g, "/"), py[1]);
  assert.match(SRC, /PUSH_SLUG_RE\.test\(String\(remoteSlug/);
});

const MARKER = "<!-- fleet-brief:v1 -->";
const marked = () => ({ ...BRIEF, sources: [Object.assign({}, BRIEF.sources[0], { body: "Add Thing! (open)\n\n" + MARKER + "\n" })] });

test("7.4.0 review B-m7: a marked brief under confirm auto or default asks in place of a stop", async () => {
  for (const confirm of ["auto", "default"]) {
    const out = await runOne(happy({ brief: marked() }), { ...ARGS, confirm });
    assert.equal(out.result.status, "awaiting_confirmation", confirm + ": " + out.result.reason);
    assert.ok(out.logs.some((l) => /fleet-brief marker: confirm ask/.test(l)), confirm);
    assert.ok(out.labels.includes("role:scope-and-plan"), confirm);
    assert.ok(!out.labels.some((l) => /^role:fleet-test-writer/.test(l)), confirm + ": no build");
  }
});
