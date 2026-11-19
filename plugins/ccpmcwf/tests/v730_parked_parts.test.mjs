// fleet 7.3.0 (#42, L2175) A7, A8: the parked draft travels in parts. The
// meta relay (parked.py read, digest id parked:read, so the digest retry runs)
// names the run, the plan path, payload_sha256 and part_count; the parts
// (parked.py read-part, labels infra:load-parked:p<k>) hold PARKED_PART code points
// each with their own sha256; the joined payload must hash to payload_sha256,
// else the prior is ignored (fail closed, the unreadable blocker as before).
//
// dont_care: the wording of the prompts; the order of unrelated labels; the
// model of the part reads.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ARGS, SCRIPTS_SRC, happy, runOne, call, inputsOf, noUnscripted, spawnSync, sha256, parkedPartOut, PARKED_STORE, PARKED_PART } from "./harness.mjs";

const PRUN = "n0-1234567";
// 8.3.0 (#91): sizes scale with PARKED_PART (32000 until 8.2.5)
const DRAFT = "# draft plan\n" + "d".repeat((70000 * PARKED_PART) / 32000 - 13);
const FINDINGS = JSON.stringify({ reason: "plan-audit verdict plan_defect", rounds: [{ round: 0, findings: [{ criterion: "AC1", finding: "f0" }], criteria: [], change_kind: "feature", new_behaviour: true }], symbols: [], plan_path: "docs/plans/x.md" });
const pieces = (t) => {
  const out = [];
  for (let i = 0; i < t.length; i += 1000) out.push(t.slice(i, i + 1000));
  return out;
};
// a 7.2.0-shaped stub: the harness turns it into the meta relay and serves the parts
function parked(draft = DRAFT, findings = FINDINGS) {
  return (prompt) => {
    const i = inputsOf(prompt);
    return { status: "ok", reason: "read", parked: { run: PRUN, plan_path: "docs/plans/x.md", draft_chunks: pieces(draft), findings_chunks: pieces(findings) }, args: [i.scratch, i.plan_tip_time === null ? "null" : String(i.plan_tip_time)] };
  };
}
const ignored = (out) => out.logs.some((l) => /^parked draft ignored \(/.test(l));

test("7.3.0 #42 A7: a parked draft of 70000 code points (scaled to PARKED_PART) loads in 3 part reads; the planner gets the draft", async () => {
  const s = happy();
  s["infra:load-parked"] = parked();
  const out = await runOne(s, ARGS);
  noUnscripted(out);
  for (const k of [0, 1, 2]) assert.ok(out.labels.includes("infra:load-parked:p" + k), out.labels.join(", "));
  assert.ok(!out.labels.includes("infra:load-parked:p3"));
  const pin = inputsOf(call(out, "role:scope-and-plan").prompt);
  assert.equal(pin.prior_draft.text, DRAFT);
  assert.equal(pin.prior_draft.plan_path, "docs/plans/x.md");
  assert.equal(pin.prior_round.findings.length, 1);
  assert.ok(!ignored(out), out.logs.filter((l) => /parked/.test(l)).join("\n"));
  // the part prompt runs the program's read-part mode on the run the meta named
  assert.match(call(out, "infra:load-parked:p1").prompt, /parked\.py' 'read-part' '[^']*\/scratch' 'n0-1234567' '1'/);
});

test("7.3.0 #42 A8: a meta relay with a bad digest gets the digest retry, and the draft loads", async () => {
  const s = happy();
  s["infra:load-parked"] = parked();
  let n = 0;
  s.__mutate = { label: "infra:load-parked", fn: (r) => (n++ === 0 ? Object.assign(r, { digest: "0".repeat(64) }) : r) };
  const out = await runOne(s, ARGS);
  assert.ok(out.labels.includes("infra:load-parked:digest-retry"), out.labels.join(", "));
  assert.equal(inputsOf(call(out, "role:scope-and-plan").prompt).prior_draft.text, DRAFT);
  assert.ok(!ignored(out));
});

test("7.3.0 #42 A8: a part mis-copied once is read again; mis-copied twice, the prior is ignored and is the unreadable blocker", async () => {
  const bad = (p) => {
    const i = inputsOf(p);
    const r = parkedPartOut(PARKED_STORE.get(i.run), i.part, [i.scratch, i.run, String(i.part)]);
    r.chunks[0] = r.chunks[0].slice(0, -1);
    return r;
  };
  const once = happy();
  once["infra:load-parked"] = parked();
  once["infra:load-parked:p1"] = bad;
  const o1 = await runOne(once, ARGS);
  assert.ok(o1.labels.includes("infra:load-parked:p1:retry"), o1.labels.join(", "));
  assert.equal(inputsOf(call(o1, "role:scope-and-plan").prompt).prior_draft.text, DRAFT);
  const twice = happy();
  twice["infra:load-parked"] = parked();
  twice["infra:load-parked:p1"] = twice["infra:load-parked:p1:retry"] = bad;
  const o2 = await runOne(twice, { ...ARGS, confirm: "default" });
  assert.ok(ignored(o2), o2.logs.filter((l) => /parked/.test(l)).join("\n"));
  const pin = inputsOf(call(o2, "role:scope-and-plan").prompt);
  assert.ok(!("prior_draft" in pin) && !("prior_round" in pin));
  assert.equal(o2.result.status, "awaiting_confirmation", o2.result.reason);
  assert.match(o2.result.confirm_reason, /parked prior unreadable \(fail closed\)/);
});

test("7.3.0 #42 A8: a part relay from another run, or a part 0 with another count, never loads", async () => {
  const other = happy();
  other["infra:load-parked"] = parked();
  other["infra:load-parked:p2"] = other["infra:load-parked:p2:retry"] = (p) => {
    const i = inputsOf(p);
    return parkedPartOut(PARKED_STORE.get(i.run), i.part, [i.scratch, "n0-7654321", String(i.part)]);
  };
  const o1 = await runOne(other, ARGS);
  assert.ok(ignored(o1));
  const count = happy();
  count["infra:load-parked"] = parked("# short draft\n");
  count["infra:load-parked:p0"] = count["infra:load-parked:p0:retry"] = (p) => {
    const i = inputsOf(p);
    const r = parkedPartOut(PARKED_STORE.get(i.run), 0, [i.scratch, i.run, "0"]);
    r.part.count = 2;
    return r;
  };
  const o2 = await runOne(count, ARGS);
  assert.ok(ignored(o2));
  assert.ok(!o2.labels.includes("infra:load-parked:p1"), "the meta part_count decides how many parts are read");
});

// the shipped program, on a scratch dir laid out as fleet 7.2.0 parked it
function parkedPy(...a) {
  const r = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "parked.py"), ...a], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
test("7.3.0 #42 A8: a draft parked by 7.2.0 (the same on-disk files) loads: read gives the meta, read-part the parts that join to payload_sha256", () => {
  const scratch = mkdtempSync(join(tmpdir(), "fleet-730p-"));
  try {
    const d = join(scratch, "parked", PRUN, "docs", "plans");
    mkdirSync(d, { recursive: true });
    const draft = "# draft é ✓ 😀\n" + "x".repeat((40000 * PARKED_PART) / 32000);
    writeFileSync(join(d, "x.md"), draft);
    writeFileSync(join(scratch, "parked", PRUN, "findings.json"), FINDINGS);
    const m = parkedPy("read", scratch, "null");
    assert.deepEqual(m.args, [scratch, "null"]);
    const k = m.parked;
    assert.deepEqual([k.run, k.plan_path, k.part_count], [PRUN, "docs/plans/x.md", 2]);
    assert.match(m.digest, /^[0-9a-f]{64}$/);
    let joined = "";
    for (let i = 0; i < k.part_count; i++) {
      const p = parkedPy("read-part", scratch, PRUN, String(i));
      assert.deepEqual(p.args, [scratch, PRUN, String(i)]);
      const t = p.chunks.join("");
      assert.ok(p.chunks.every((c) => Array.from(c).length <= 1000));
      assert.deepEqual(p.part, { index: i, count: 2, sha256: sha256(t) });
      const n = Array.from(t).length;
      assert.ok(i === 0 ? n === PARKED_PART : n >= 1 && n <= PARKED_PART, "part " + i + " holds " + n);
      joined += t;
    }
    assert.equal(sha256(joined), k.payload_sha256);
    assert.deepEqual(JSON.parse(joined), { draft, findings: FINDINGS });
    // a part past the count, a bad run name and a run that is not there exit non-zero
    for (const a of [[PRUN, "2"], ["../x", "0"], ["n0-0000000", "0"]]) assert.notEqual(spawnSync("python3", ["-I", join(SCRIPTS_SRC, "parked.py"), "read-part", scratch, ...a]).status, 0, a.join(" "));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
