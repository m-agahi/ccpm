// fleet 7.2.0 (L2178, yaadgaar #44) AC6: batch-wide reads on the disk path: part auto for symbols
// whose only gap is their auto hits, part all for the rest, with today's findings.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, happy, runOne, call, inputsOf, callersDisk } from "./harness.mjs";

const reads = (out) => out.labels.filter((l) => l.includes(":read:"));
const findingsOf = (out) => {
  const c = call(out, "role:scope-and-plan:audit-fix");
  assert.ok(c, "no re-plan round: " + out.result.status + " " + out.result.reason);
  return inputsOf(c.prompt).prior_round.findings.map((f) => f.finding);
};
const map1 = (sym, at) => ({ symbol: sym, occurrences: [{ at, criterion: "AC1", dont_care: null }] });

test("7.2.0 AC6: one auto read joins the doc hit; the sealed map gets it as auto dont_care", async () => {
  const s = happy();
  s["role:scope-and-plan"].changed_symbols = [map1("b_sym", "src/b.py:2")];
  callersDisk(s, "infra:callers", { b_sym: { hits: ["docs/b.md:4", "src/b.py:2"], auto: ["docs/b.md:4"] } });
  const out = await runOne(s, ARGS);
  assert.deepEqual(reads(out), ["infra:callers:read:auto:0"]);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const pa = inputsOf(call(out, "role:plan-audit").prompt);
  assert.deepEqual(pa.caller_check.auto_dont_care.b_sym, ["docs/b.md:4"]);
  const sealed = pa.changed_symbols.find((x) => x.symbol === "b_sym");
  assert.ok(sealed.occurrences.some((o) => o.at === "docs/b.md:4" && o.criterion === null && o.dont_care === "auto: non-code file"), JSON.stringify(sealed));
});

test("7.2.0 AC6: three auto symbols (40 + 50 + 60) read in exactly 3 batch-wide pages", async () => {
  const s = happy();
  const data = {};
  const syms = [["a_sym", 40], ["b_sym", 50], ["c_sym", 60]];
  for (const [x, n] of syms) {
    const auto = Array.from({ length: n }, (_, j) => "docs/" + x + "_" + String(j).padStart(3, "0") + ".md:1");
    data[x] = { hits: ["src/" + x + ".py:1"].concat(auto), auto };
  }
  s["role:scope-and-plan"].changed_symbols = syms.map(([x]) => map1(x, "src/" + x + ".py:1"));
  callersDisk(s, "infra:callers", data);
  const out = await runOne(s, ARGS);
  assert.deepEqual(reads(out), ["infra:callers:read:auto:0", "infra:callers:read:auto:1", "infra:callers:read:auto:2"]);
  const i0 = inputsOf(call(out, "infra:callers:read:auto:0").prompt);
  assert.deepEqual([i0.file, i0.part, JSON.stringify(i0.symbols), String(i0.page)].slice(1), ["auto", '["a_sym","b_sym","c_sym"]', "0"]);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
});

test("7.2.0 AC6: a stale map falls through auto to part all and gets today's findings", async () => {
  const s = happy();
  s["role:scope-and-plan"].changed_symbols = [map1("b_sym", "src/b.py:9")];
  callersDisk(s, "infra:callers", { b_sym: { hits: ["docs/b.md:4", "src/b.py:2"], auto: ["docs/b.md:4"] } });
  const out = await runOne(s, ARGS);
  assert.deepEqual(reads(out), ["infra:callers:read:auto:0", "infra:callers:read:all:0"]);
  const f = findingsOf(out);
  assert.ok(f.includes("b_sym: src/b.py:2 is an occurrence (git grep -w) not mapped in changed_symbols; map it to a criterion or to dont_care with a reason"), f.join("\n"));
  assert.ok(f.includes("b_sym: src/b.py:9 is mapped but git grep -w finds no occurrence there (stale line or wrong path; cite lines at the worktree HEAD)"), f.join("\n"));
  assert.ok(!f.some((x) => x.includes("docs/b.md:4")), f.join("\n"));
});

test("7.2.0 AC6: a symbol with no auto hit and a wrong map reads part all only", async () => {
  const s = happy();
  s["role:scope-and-plan"].changed_symbols = [map1("x_sym", "src/x.py:2")];
  callersDisk(s, "infra:callers", { x_sym: { hits: ["src/x.py:1"] } });
  const out = await runOne(s, ARGS);
  assert.deepEqual(reads(out), ["infra:callers:read:all:0"]);
  const f = findingsOf(out);
  assert.ok(f.some((x) => x.startsWith("x_sym: src/x.py:1 is an occurrence (git grep -w) not mapped")), f.join("\n"));
  assert.ok(f.some((x) => x.startsWith("x_sym: src/x.py:2 is mapped but git grep -w finds no occurrence there")), f.join("\n"));
});
