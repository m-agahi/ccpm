// fleet 7.2.0 (L2178, yaadgaar #44) AC5: on the FLEET_CALLERS_ON_DISK marker the workflow runs
// callers.py file mode; a symbol whose mapped set hashes to the summary sha256 needs no read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, happy, runOne, call, inputsOf, callersDisk } from "./harness.mjs";

const FOO_MAP = (a1, a3) => [{ symbol: "foo", occurrences: [{ at: a1, criterion: "AC1", dont_care: null }, { at: a3, criterion: null, dont_care: "a test helper" }] }];
const DATA = { foo: { hits: ["src/a.py:1", "src/a.py:3"] } };

test("7.2.0 AC5: the marker hands off to file mode; an exact map reads nothing and the plan goes on", async () => {
  const s = happy();
  s["role:scope-and-plan"].changed_symbols = FOO_MAP("src/a.py:1", "src/a.py:3");
  callersDisk(s, "infra:callers", DATA);
  const out = await runOne(s, ARGS);
  assert.ok(out.labels.includes("infra:callers:file"), out.labels.join(", "));
  assert.ok(!out.labels.some((l) => l.includes(":read:")), out.labels.join(", "));
  const fc = call(out, "infra:callers:file");
  const i = inputsOf(call(out, "infra:callers").prompt);
  assert.match(fc.prompt, /callers\.py' 'file' /);
  const fi = inputsOf(fc.prompt);
  const scratch = i.worktree.replace(/\/+[^/]+\/*$/, "") + "/scratch";
  assert.deepEqual([fi.worktree, fi.plan_path, JSON.stringify(fi.symbols), String(fi.cap), fi.scratch_dir], [i.worktree, i.plan_path, '["foo"]', "100", scratch]);
  assert.ok(fc.prompt.includes("'" + scratch + "'"), fc.prompt);
  assert.ok(out.logs.includes("infra:callers: the caller output is over the 8192-byte inline cap; on-disk handoff (1 symbols)"), out.logs.join("\n"));
  assert.ok(out.labels.includes("role:plan-audit"), out.result.reason);
  const cc = inputsOf(call(out, "role:plan-audit").prompt).caller_check;
  assert.deepEqual(cc.auto_dont_care.foo, []);
  assert.deepEqual(cc.occurrences.foo, ["src/a.py:1", "src/a.py:3"]);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
});

test("7.2.0 AC5: the mapped set is occurrenceKey-normalised before hashing", async () => {
  const s = happy();
  s["role:scope-and-plan"].changed_symbols = FOO_MAP("./src/a.py:1", " src/a.py:3");
  callersDisk(s, "infra:callers", DATA);
  const out = await runOne(s, ARGS);
  assert.ok(!out.labels.some((l) => l.includes(":read:")), out.labels.join(", "));
  assert.ok(out.labels.includes("role:plan-audit"), out.result.reason);
});

test("7.2.0 AC5: control: an ok inline relay takes no file step", async () => {
  const s = happy();
  s["role:scope-and-plan"].changed_symbols = FOO_MAP("src/a.py:1", "src/a.py:3");
  s["infra:callers"] = { status: "ok", reason: "grepped", occurrences: { foo: ["src/a.py:1", "src/a.py:3"] }, capped: [], auto_dont_care: {}, doctest_md: [] };
  const out = await runOne(s, ARGS);
  assert.ok(!out.labels.includes("infra:callers:file"));
  assert.ok(out.labels.includes("role:plan-audit"), out.result.reason);
});
