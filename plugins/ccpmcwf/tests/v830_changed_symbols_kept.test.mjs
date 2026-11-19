// ccpmcwf 8.3.0 (#100, fix a): a symbol of an earlier round does not count as dropped when the
// new plan's interface (allowed_additions.symbols) or a finding of the latest plan-audit round
// still names it, as a whole identifier. A prior-round map entry is put back (and checked again);
// with none, the symbol is only kept. A symbol gone from both still stops as before.
// y116 (run wf_31f87394-d5c): RoutingConfig was never in changed_symbols; a round-1 audit finding
// carried symbol "RoutingConfig", and round 2 stopped on "changed_symbols dropped RoutingConfig".

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, happy, runOne, call, inputsOf } from "./harness.mjs";

const one = (x) => ({ symbol: x, occurrences: [{ at: "src/" + x + ".py:1", criterion: "AC1", dont_care: null }] });
const grep = (p) => ({ status: "ok", reason: "grepped", occurrences: Object.fromEntries(inputsOf(p).symbols.map((x) => [x, ["src/" + x + ".py:1"]])), capped: [], auto_dont_care: {}, doctest_md: [], });
const AA = (symbols) => ({ files: [], symbols, deps: [], settings: [] });
const planRound = (s, over) => Object.assign({}, s["role:scope-and-plan"], over);
const refuse = (f) => ({ status: "ok", reason: "refused", verdict: "untestable_criteria", routed_findings: [Object.assign({ target: "plan", criterion: "AC1" }, f)] });
const APPROVE = { status: "ok", reason: "fine", verdict: "approve", routed_findings: [] };
const callers = (s) => {
  for (const sfx of ["", ":audit-fix", ":audit-fix-2"]) s["infra:callers" + sfx] = grep;
};
const DROP_STOP = /^changed_symbols dropped a symbol of an earlier round: changed_symbols dropped foo after the /;

test("8.3.0 #100: the y116 shape (in the interface, named in a latest-round finding, no map entry) goes on and logs the kept symbol", async () => {
  const s = happy();
  const aa = AA(["Tier", "RoutingConfig", "RoutingConfigError", "RoutingConfig.resolve"]);
  s["role:scope-and-plan"] = planRound(s, { allowed_additions: aa });
  s["role:plan-audit"] = refuse({ finding: "r0" });
  s["role:scope-and-plan:audit-fix"] = planRound(s, { allowed_additions: aa });
  s["role:plan-audit:audit-fix"] = refuse({ symbol: "RoutingConfig", finding: "`RoutingConfig.resolve` of a value that is not a Tier value has no example" });
  s["role:scope-and-plan:audit-fix-2"] = planRound(s, { allowed_additions: aa });
  s["role:plan-audit:audit-fix-2"] = APPROVE;
  callers(s);
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.ok(out.logs.includes("changed_symbols kept RoutingConfig: the plan interface names it; no earlier map entry (a new symbol), not counted as dropped"), out.logs.join("\n"));
  assert.ok(!out.logs.some((l) => /^changed_symbols dropped/.test(l)), out.logs.join("\n"));
  assert.ok(!out.labels.includes("infra:callers:audit-fix-2"), "no caller check for a symbol with no map entry");
});

test("8.3.0 #100: a symbol named only in a latest-round audit finding is put back from the earlier map", async () => {
  const s = happy();
  s["role:scope-and-plan"].changed_symbols = [one("foo")];
  s["role:plan-audit"] = refuse({ finding: "AC1 never calls foo(1) with a bad value" });
  s["role:scope-and-plan:audit-fix"] = planRound(s, { changed_symbols: [] });
  s["role:plan-audit:audit-fix"] = APPROVE;
  callers(s);
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.ok(out.logs.includes("changed_symbols kept foo: a latest plan-audit finding names it; its earlier map entry is put back"), out.logs.join("\n"));
  assert.deepEqual(inputsOf(call(out, "infra:callers:audit-fix").prompt).symbols, ["foo"]);
  assert.deepEqual(inputsOf(call(out, "role:plan-audit:audit-fix").prompt).changed_symbols.map((x) => x.symbol), ["foo"]);
});

test("8.3.0 #100: a symbol named only in the plan interface is put back from the earlier map", async () => {
  const s = happy();
  s["role:scope-and-plan"].changed_symbols = [one("foo")];
  s["role:plan-audit"] = refuse({ finding: "r0" });
  s["role:scope-and-plan:audit-fix"] = planRound(s, { changed_symbols: [], allowed_additions: AA(["Bar.foo"]) });
  s["role:plan-audit:audit-fix"] = APPROVE;
  callers(s);
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.ok(out.logs.includes("changed_symbols kept foo: the plan interface names it; its earlier map entry is put back"), out.logs.join("\n"));
  assert.deepEqual(inputsOf(call(out, "infra:callers:audit-fix").prompt).symbols, ["foo"]);
});

test("8.3.0 #100: a symbol removed from the interface and named in no finding still stops with the same reason", async () => {
  const s = happy();
  s["role:scope-and-plan"] = planRound(s, { changed_symbols: [one("foo")], allowed_additions: AA(["foo"]) });
  s["role:plan-audit"] = refuse({ finding: "r0" });
  s["role:scope-and-plan:audit-fix"] = planRound(s, { changed_symbols: [], allowed_additions: AA([]) });
  s["role:scope-and-plan:audit-fix-2"] = planRound(s, { changed_symbols: [], allowed_additions: AA([]) });
  callers(s);
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, DROP_STOP);
  assert.ok(out.logs.includes("changed_symbols dropped a symbol of an earlier round: re-plan round 2 of 2 with the findings"), out.logs.join("\n"));
  assert.ok(!out.logs.some((l) => /^changed_symbols kept/.test(l)), out.logs.join("\n"));
});

test("8.3.0 #100: a finding or interface entry that holds the name only inside a longer identifier does not keep it", async () => {
  const s = happy();
  s["role:scope-and-plan"].changed_symbols = [one("foo")];
  s["role:plan-audit"] = refuse({ symbol: "fooBar", finding: "fooBar, foo_x and xfoo (and Foo) have no example" });
  s["role:scope-and-plan:audit-fix"] = planRound(s, { changed_symbols: [], allowed_additions: AA(["fooBar", "foo_baz.x", "private helpers like foo"]) });
  s["role:scope-and-plan:audit-fix-2"] = planRound(s, { changed_symbols: [], allowed_additions: AA(["fooBar"]) });
  callers(s);
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, DROP_STOP);
  // round 1 (latest audit findings: fooBar, foo_x, xfoo, Foo) drops foo: re-plan round 2
  assert.ok(out.logs.includes("changed_symbols dropped a symbol of an earlier round: re-plan round 2 of 2 with the findings"), out.logs.join("\n"));
  assert.ok(!out.logs.some((l) => /^changed_symbols kept foo:/.test(l)), out.logs.join("\n"));
});
