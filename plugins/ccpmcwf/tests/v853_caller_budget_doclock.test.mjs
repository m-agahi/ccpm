// ccpmcwf 8.5.3 (yaadgaar #111): doc and lock hits that the script auto-maps to dont_care never use
// the caller read budget and never cause the changed_symbols stop. Plan run wf_a5e02d51-28c (task
// #108) stopped: 16+ version-pin symbols split into caller batches; the first batch spent the 4
// reads, so the last batch could not read its auto lists ("19 doc or lock hit(s) left to auto
// dont_care are over the caller read budget"). Code hits keep the budget and the stop.
// fixtures/v853_callers_b3.json is the hit list of that last batch (the real callers file).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ARGS, PB, DIST, happy, runOne, call, inputsOf, callersDisk } from "./harness.mjs";

const B3 = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "v853_callers_b3.json"), "utf8"));
const REAL = Object.keys(B3).sort();
const AUTO_TOTAL = REAL.reduce((a, s) => a + B3[s].auto.length, 0);
const reads = (out, re) => out.labels.filter((l) => l.includes(":read:") && (!re || re.test(l)));
const auditFix = (out) => call(out, "role:scope-and-plan:audit-fix");
const findingsOf = (out) => {
  const c = auditFix(out);
  assert.ok(c, "no re-plan round: " + out.result.status + " " + out.result.reason);
  return inputsOf(c.prompt).prior_round.findings.map((f) => f.finding);
};
const docs = (x, n) => Array.from({ length: n }, (_, j) => "docs/plans/" + x + "_" + String(j).padStart(3, "0") + ".md:1");
const code = (x, n) => Array.from({ length: n }, (_, j) => "src/" + x + ".py:" + (j + 1));
const dc = (at) => ({ at, criterion: null, dont_care: "a version pin" });
// the planner maps every code hit and leaves the doc and lock hits to auto
const mapCode = (x, d) => ({ symbol: x, occurrences: d.hits.filter((h) => d.auto.indexOf(h) < 0).map(dc) });
// 8 more pin symbols: 2 code hits each, 25 doc hits each (200 doc hits: 4 pages, the whole budget)
const FIRST = ["P_A", "P_B", "P_C", "P_D", "P_E", "P_F", "P_G", "P_H"];
const firstData = () => Object.fromEntries(FIRST.map((x) => [x, { hits: code(x, 2).concat(docs(x, 25)), auto: docs(x, 25) }]));

// the real run: 16 symbols; the first file relay is over the summary cap and splits 8 + 8
function realRun(extra) {
  const s = happy();
  const f = firstData();
  const data = Object.assign({}, f, B3, extra ? extra.data : {});
  s["role:scope-and-plan"].changed_symbols = FIRST.map((x) => mapCode(x, f[x])).concat(REAL.map((x) => mapCode(x, B3[x])), extra ? extra.map : []);
  callersDisk(s, "infra:callers", data);
  callersDisk(s, "infra:callers:b2", data);
  callersDisk(s, "infra:callers:b3", data);
  const names = s["role:scope-and-plan"].changed_symbols.map((x) => x.symbol);
  s["infra:callers:file"] = (p) => ({ status: "failed", reason: "FLEET_CALLERS_RELAY_CAP: the callers summary is over the 4096-byte summary cap (9000 bytes; symbols: " + inputsOf(p).symbols.join(", ") + ")" });
  return { s, names };
}

test("8.5.3 (#111): the real 16-symbol pin plan reads its doc and lock hits outside the budget and reaches confirmation", async () => {
  assert.ok(REAL.length === 8 && AUTO_TOTAL === 113, REAL.join(",") + " " + AUTO_TOTAL);
  const { s } = realRun();
  const out = await runOne(s, ARGS);
  assert.ok(!out.labels.includes("role:scope-and-plan:audit-fix"), "re-plan round: " + JSON.stringify(out.result));
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  // b2 (the first 8) spends 4 auto pages, b3 (the real 8) reads its 113 auto hits in 3 more pages
  assert.equal(reads(out, /:b2:read:auto:/).length, 4, reads(out).join(", "));
  assert.equal(reads(out, /:b3:read:auto:/).length, 3, reads(out).join(", "));
  // every doc or lock hit (200 + 113) is sealed in the map as auto dont_care
  assert.ok(out.logs.some((g) => String(g).includes("; 313 doc or lock hit(s) mapped \"auto: non-code file\"")), out.logs.join("\n"));
  assert.ok(!out.logs.some((g) => /of the caller read budget \(4\) left; not read/.test(String(g))), out.logs.join("\n"));
});

test("8.5.3 (#111): 300 doc hits of one symbol (6 pages) still map to auto dont_care with no finding", async () => {
  const s = happy();
  const d = { hits: code("big_pin", 1).concat(docs("big_pin", 300)), auto: docs("big_pin", 300) };
  s["role:scope-and-plan"].changed_symbols = [mapCode("big_pin", d)];
  callersDisk(s, "infra:callers", { big_pin: d });
  const out = await runOne(s, ARGS);
  assert.ok(!out.labels.includes("role:scope-and-plan:audit-fix"), "re-plan round: " + JSON.stringify(out.result));
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.equal(reads(out, /:read:auto:/).length, 6, reads(out).join(", "));
});

test("8.5.3 (#111) non-weakening: code hits over the budget still give the re-grep finding", async () => {
  // c_wrong: 210 code hits (5 pages), mapped to one wrong line; it rides in the last batch
  const extra = { data: { c_wrong: { hits: code("c_wrong", 210) } }, map: [{ symbol: "c_wrong", occurrences: [dc("src/c_wrong.py:999")] }] };
  const { s } = realRun(extra);
  const out = await runOne(s, ARGS);
  const f = findingsOf(out);
  assert.ok(f.includes("c_wrong: the mapped occurrences differ from git grep -w (210 hits, 1 mapped) and the hit list is over the caller read budget (4 reads of 50 entries); re-grep and map every hit"), f.join("\n"));
  assert.ok(!f.some((y) => /doc or lock hit\(s\) left to auto dont_care/.test(y)), f.join("\n"));
  assert.equal(reads(out, /:read:all:/).length, 0, reads(out).join(", "));
});

test("8.5.3 (#111): auto reads leave the code budget whole: a 4-page code list after 7 auto pages is read and checked", async () => {
  // c_miss: 200 code hits (4 pages); the planner missed one hit, so the part-all list is read
  const hits = code("c_miss", 200);
  const extra = { data: { c_miss: { hits } }, map: [{ symbol: "c_miss", occurrences: hits.slice(1).map(dc) }] };
  const { s } = realRun(extra);
  const out = await runOne(s, ARGS);
  assert.equal(reads(out, /:read:all:/).length, 4, reads(out).join(", "));
  const f = findingsOf(out);
  assert.deepEqual(f, ["c_miss: src/c_miss.py:1 is an occurrence (git grep -w) not mapped in changed_symbols; map it to a criterion or to dont_care with a reason"]);
});

// review of PR #108: plan and build share one 100-agent cap in a same-run build (confirm auto), so the
// auto reads must sit outside that cap too, and have their own bound per caller check
const SAME_RUN = {
  "hasher:pre-intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
  "role:fleet-intent-judge": { status: "ok", reason: "matches the task", verdict: "approve", deviations: [], coverage: { covered: true, missing: [] }, classification: { change_kind: "approve", new_behaviour: "approve", quote: "the task" } },
  "hasher:fp-post:intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
};
// the incident's 16-symbol plan, then the build in the same run, under a lowered agent cap. The real
// agents of this run need a cap of 66; the 7 auto reads would need 73 if they counted.
async function sameRunAt(cap) {
  const { s } = realRun();
  Object.assign(s, JSON.parse(JSON.stringify(SAME_RUN)));
  // 8.6.0 (ADR-1403): the dist writes `MAX_AGENTS=100` (whitespace collapsed)
  s.__source = DIST.replace("MAX_AGENTS=100", "MAX_AGENTS=" + cap);
  assert.notEqual(s.__source, DIST, "the dist holds MAX_AGENTS=100");
  return runOne(s, Object.assign({}, ARGS, { confirm: "auto" }));
}

test("8.5.3 (#111, PR #108 review a): the auto reads are outside the agent cap: the same-run plan+build fits a cap its real agents fit", async () => {
  const out = await sameRunAt(66);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(reads(out, /:read:auto:/).length, 7, reads(out).join(", "));
});

test("8.5.3 (#111, PR #108 review c): the agent cap still stops on real agents (one under the cap the real agents need)", async () => {
  const out = await sameRunAt(65);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.match(out.result.reason, /^agent cap 65 reached: /);
});

test("8.5.3 (#111, PR #108 review b): auto pages over the per-check bound (20 pages) stop at the callers gate, naming the symbols and the hit count", async () => {
  const s = happy();
  const d = { hits: code("huge_pin", 1).concat(docs("huge_pin", 1001)), auto: docs("huge_pin", 1001) };
  s["role:scope-and-plan"].changed_symbols = [mapCode("huge_pin", d)];
  callersDisk(s, "infra:callers", { huge_pin: d });
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "callers");
  assert.match(out.result.reason, /^infra:callers: the auto lists of huge_pin \(1001 doc or lock hit\(s\)\) need 21 read\(s\); over the 20 auto reads a caller check may take/);
  assert.equal(reads(out).length, 0, reads(out).join(", "));
});

test("8.5.3 (#111, PR #108 review b): 1000 doc hits (exactly 20 pages) are read with no stop", async () => {
  const s = happy();
  const d = { hits: code("big_pin", 1).concat(docs("big_pin", 1000)), auto: docs("big_pin", 1000) };
  s["role:scope-and-plan"].changed_symbols = [mapCode("big_pin", d)];
  callersDisk(s, "infra:callers", { big_pin: d });
  for (let k = 10; k < 20; k++) s["infra:callers:read:auto:" + k] = s["infra:callers:read:auto:0"];
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.equal(reads(out, /:read:auto:/).length, 20, reads(out).join(", "));
});
