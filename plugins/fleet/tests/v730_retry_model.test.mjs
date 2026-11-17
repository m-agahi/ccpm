// fleet 7.3.0 (#67) A1, A2: a digest or args retry of an infra relay runs one
// model step up from its INFRA_TIER model (haiku -> sonnet, sonnet -> opus);
// the PATH re-check's relay retry keeps RELAY_RETRY_MODEL.
//
// dont_care: the wording of the retry prompt; the order of unrelated labels.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, happy, run, runOne, redigest, callersDisk } from "./harness.mjs";

const modelOf = (out, l) => {
  const c = out.calls.filter((x) => x.label === l);
  assert.ok(c.length, l + " ran: " + out.labels.join(", "));
  return c.map((x) => x.opts.model);
};
const FOO = [{ symbol: "foo", occurrences: [{ at: "src/a.py:1", criterion: "AC1", dont_care: null }, { at: "src/a.py:3", criterion: null, dont_care: "a test helper" }] }];

test("7.3.0 #67 A1: a haiku callers relay that misses its digest is retried on sonnet; the gate line names sonnet", async () => {
  const s = happy();
  s["role:scope-and-plan"].changed_symbols = FOO;
  callersDisk(s, "infra:callers", { foo: { hits: ["src/a.py:1", "src/a.py:3"] } });
  const good = s["infra:callers:file"];
  s["infra:callers:file"] = (p) => Object.assign(good(p), { digest: "f".repeat(64) });
  s["infra:callers:file:digest-retry"] = good;
  const out = await runOne(s, ARGS);
  assert.deepEqual(modelOf(out, "infra:callers:file"), ["haiku"]);
  assert.deepEqual(modelOf(out, "infra:callers:file:digest-retry"), ["sonnet"]);
  const line = "dispatched once more to a fresh agent (infra:callers:file:digest-retry) on sonnet";
  assert.ok(out.logs.some((l) => l.includes(line)), out.logs.join("\n"));
});

test("7.3.0 #67 A2: a sonnet pr-tests relay on other args is retried on opus", async () => {
  const s = happy();
  s.__mutate = { label: /^infra:pr-tests/, fn: (r, prompt, real) => (/-retry$/.test(real) ? r : redigest(real, Object.assign(r, { args: ["gh", "o/r", "8"].concat(r.args.slice(3)) }), prompt)) };
  const out = await run(s, ARGS);
  assert.deepEqual(modelOf(out, "infra:pr-tests")[0], "sonnet");
  assert.deepEqual(modelOf(out, "infra:pr-tests:args-retry"), ["opus"]);
  assert.ok(out.logs.some((l) => l.includes("(infra:pr-tests:args-retry) on opus")), out.logs.join("\n"));
});

test("7.3.0 #67 A2: the PATH re-check relay retry still runs on RELAY_RETRY_MODEL (sonnet)", async () => {
  const s = happy();
  let n = 0;
  s.__mutate = { label: /^infra:path-check:/, fn: (r, prompt, real) => (/relay-retry$/.test(real) || n++ ? r : null) };
  const out = await runOne(s, ARGS);
  const l = out.labels.find((x) => /^infra:path-check:.*:relay-retry$/.test(x));
  assert.ok(l, out.labels.join(", "));
  assert.deepEqual(modelOf(out, l), ["sonnet"]);
});
