// fleet 4.0.2 (ledger 1997): every step that relays a shipped program's
// output must return the program's sha256sum line as file_sha256 at each slot
// the script checks (programProblem). Run wf_87a99806-757 (4.0.1) stopped at
// infra:branch-scan: the agent ran branch_scan correctly but followed the
// prompt's explicit Return list, which named no file_sha256. The schema the
// agent gets now requires file_sha256 at every slot, the prompt names it, and
// a missing one still stops the run.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { SOURCE, ARGS, happy, run, runOne, PROGRAM_LABELS, PROGRAMS } from "./harness.mjs";

function grabFn(name) {
  const i = SOURCE.indexOf("\nfunction " + name + "(");
  assert.ok(i >= 0, "function " + name + " in the workflow");
  return SOURCE.slice(i, SOURCE.indexOf("\n}\n", i) + 3);
}
function grabTable(name) {
  const i = SOURCE.indexOf("\nconst " + name + " = [");
  assert.ok(i >= 0, "const " + name + " in the workflow");
  return SOURCE.slice(i, SOURCE.indexOf("\n];\n", i) + 4);
}
const programSlots = () => new Function(grabTable("PROGRAM_SLOTS") + grabFn("programSlots") + "\nreturn programSlots;")();

// the shipped programs a prompt runs: `sha256sum -- <dir>/<name>.py`
const RUNS = /sha256sum -- '?[^\s'"]*\/([a-z_]+)\.py/g;
const ran = (prompt) => new Set([...String(prompt).matchAll(RUNS)].map((m) => m[1]));

// one label per harness PROGRAM_LABELS entry (the harness table is where the
// script's checks read each program's output)
const SAMPLES = [
  "preflight",
  "infra:path-check:commit-plan",
  "infra:path-check:commit-plan:relay-retry",
  "workspace",
  // 5.0.8 (ledger 2030)
  "infra:gh-identity:intake",
  "hasher:fp-pre:r1",
  "infra:branch-scan",
  "infra:load-parked",
  "infra:park-plan",
  "infra:stage-plan",
  "infra:format-tests:r1",
  // 5.0.3 (ledger 2010)
  "infra:format-plan",
  "infra:commit-plan",
  "infra:verify-plan-commit",
  "infra:verify-plan-commit:retry",
  "infra:load-ref",
  "infra:load-ref:retry",
  "infra:verify-plan",
  "infra:read-state",
  "infra:state:committed:r1",
  "infra:tf-gate:p1",
  "infra:remote-head:p1",
  "infra:fleet-scan:p1",
  "infra:callers",
  "infra:changed-defs:c1",
  "infra:push",
  "infra:push:p2",
  "infra:push-probe",
  "infra:hook-surface:plan",
  // 6.0.0 (ledger 2041)
  "infra:ruleset-surface:plan",
  // 6.0.0 (ledger 2033)
  "infra:policy",
  // 6.0.0 (ledger 2044)
  "infra:pr-stats",
  // 6.0.0 (ledger 2042)
  "infra:pr-convention:plan",
  "infra:review-paths:v1",
  "infra:precommit-ids",
  "infra:check-scripts:plan",
  "infra:db-up",
  "infra:db-down",
  // 5.0.5 (ledger 2018)
  "infra:hash-diff:writers:r1",
  // 5.0.6 (ledger 2019)
  "infra:build-reset:writers:r1",
  "infra:build-clean",
];

const harnessSlots = (label) => {
  const hits = PROGRAM_LABELS.filter(([re]) => re.test(label));
  return hits.length === 1 ? hits[0][1].map(([slot, name]) => [slot, name]) : null;
};
const key = (pairs) => pairs.map(([s, n]) => (s === null ? "." : s) + "=" + n).sort();

// file_sha256 (and program) required at `slot` of the schema; null = top level
function requiredAt(schema, slot) {
  if (!schema || typeof schema !== "object" || !schema.properties) return false;
  const top = Array.isArray(schema.required) ? schema.required : [];
  if (slot === null) {
    const p = schema.properties.file_sha256;
    return top.includes("file_sha256") && top.includes("program") && !!p && [].concat(p.type).includes("string");
  }
  const o = schema.properties[slot];
  if (!top.includes(slot) || !o || !o.properties || !Array.isArray(o.required)) return false;
  const p = o.properties.file_sha256;
  return o.required.includes("file_sha256") && o.required.includes("program") && !!p && p.type === "string";
}

test("4.0.2 1997: every shipped program a prompt can run has a PROGRAM_SLOTS entry (discovered from the source)", () => {
  const names = new Set();
  for (const m of SOURCE.matchAll(/progCmd\("([a-z_]+)"/g)) names.add(m[1]);
  // the wrappers and the preflight's hand-built command (scripts_dir is not resolved yet)
  if (/\nfunction planHashCmd\([^]*?progCmd\("plan_hash"/.test(SOURCE)) names.add("plan_hash");
  if (/\nfunction planRefsCmd\([^]*?progCmd\("plan_ref"/.test(SOURCE)) names.add("plan_ref");
  for (const m of SOURCE.matchAll(/sha256sum -- <scripts_dir>\/([a-z_]+)\.py/g)) names.add(m[1]);
  assert.deepEqual([...names].sort(), PROGRAMS.map(([n]) => n).sort(), "every shipped program is run by some prompt");
  const table = new Function(grabTable("PROGRAM_SLOTS") + "\nreturn PROGRAM_SLOTS;")();
  const slotted = new Set(table.flatMap(([, slots]) => slots.map(([, n]) => n)));
  for (const n of names) assert.ok(slotted.has(n), n + " has no PROGRAM_SLOTS entry");
  // 4.0.2 review: every builder of a program command records it (emitProg)
  // 5.0.0 (R1): the role file hash (no program; roleFileProblem checks it) is not a program command
  const roleRead = SOURCE.split("\n").filter((l) => l.includes('"sha256sum -- ') && l.includes("roleFilePath("));
  assert.deepEqual(roleRead, ['  return "sha256sum -- " + shQuote(roleFilePath(role));']);
  const builders = SOURCE.split("\n").filter((l) => l.includes('"sha256sum -- ') && !l.includes("roleFilePath("));
  // 5.0.9 (ledger 2032): the preflight session_project command is the third
  assert.equal(builders.length, 3, builders.join("\n"));
  for (const l of builders) assert.match(l, /emitProg\(/, l);
});

test("4.0.2 1997: PROGRAM_SLOTS puts file_sha256 where the script's checks read it, for every program-running label", () => {
  const slotsOf = programSlots();
  // the commands the run emitted (progCmd records each one): command text -> program
  const cmd = (n) => "sha256sum -- '/s/" + n + ".py' && python3 -I '/s/" + n + ".py'";
  const emitted = new Map(PROGRAMS.map(([n]) => [cmd(n), n]));
  const covered = new Set();
  for (const label of SAMPLES) {
    const want = harnessSlots(label);
    assert.ok(want, label + " matches exactly one harness PROGRAM_LABELS entry");
    covered.add(PROGRAM_LABELS.findIndex(([re]) => re.test(label)));
    const prompt = [...new Set(want.map(([, n]) => n))].map(cmd).join("\n");
    const got = slotsOf(label, prompt, emitted);
    assert.deepEqual(got.missing, [], label);
    assert.deepEqual(key(got.used), key(want), label);
  }
  assert.equal(covered.size, PROGRAM_LABELS.length, "every harness entry is sampled");
  // a slot applies only when its program runs (db-up add mode has no sweep)
  const add = slotsOf("infra:db-up:add", cmd("db_up"), emitted);
  assert.deepEqual(key(add.used), ["up=db_up"]);
  // an emitted program the label's entry does not name is reported
  assert.deepEqual(slotsOf("infra:branch-scan", cmd("hasher"), emitted).missing, ["hasher"]);
  // a label with no entry runs no program: an exact command in its prompt is quoted text
  for (const label of ["intake", "intake:rulings", "infra:ledger-body", "infra:ledger-writeback", "infra:comments-post"])
    assert.deepEqual(slotsOf(label, "Inputs: " + JSON.stringify({ tldr: cmd("path_check") }), emitted), { used: [], missing: [] }, label);
  assert.deepEqual(slotsOf("infra:format-plan", "no program here", emitted), { used: [], missing: [] });
  // 4.0.2 review: text that only looks like a program command (untrusted input) counts for nothing
  for (const fake of ["sha256sum -- <scripts_dir>/path_check.py", "sha256sum -- '/s/hasher.py'", "sha256sum -- /x/branch_scan.py && python3 -I /x/branch_scan.py"])
    for (const label of ["intake", "intake:rulings", "infra:ledger-body", "infra:branch-scan"])
      assert.deepEqual(slotsOf(label, "Inputs: " + JSON.stringify({ input: fake, tldr: fake }), emitted), { used: [], missing: [] }, label + ": " + fake);
});

// 4.0.2 review: untrusted text (the task input, the planner's tldr) that quotes a
// program command neither adds a slot nor stops the run
test("4.0.2 1997 review: an intake input and a tldr quoting `sha256sum -- <scripts_dir>/path_check.py` add no slot and do not halt", async () => {
  const quote = "sha256sum -- <scripts_dir>/path_check.py && python3 -I <scripts_dir>/path_check.py '/r'";
  const s = happy();
  s["role:scope-and-plan"] = Object.assign({}, s["role:scope-and-plan"], { tldr: "fix: " + quote });
  const out = await run(s, Object.assign({}, ARGS, { input: "fleet bug: the preflight runs " + quote }));
  assert.equal(out.result.status, "ok", out.result.reason);
  const carriers = out.calls.filter((c) => c.prompt.includes("sha256sum -- <scripts_dir>/path_check.py") && !/^preflight/.test(c.label));
  assert.ok(carriers.some((c) => /^intake/.test(c.label)), "the input reached intake");
  assert.ok(carriers.some((c) => /^infra:(ledger|comments|yaadgaar)-/.test(c.label)), "the tldr reached a write-back step: " + carriers.map((c) => c.label).join(", "));
  for (const c of carriers) {
    if (harnessSlots(c.label)) continue;
    assert.ok(!(c.opts.schema && (c.opts.schema.required || []).includes("file_sha256")), c.label + ": no file_sha256 slot");
    assert.ok(!c.prompt.includes("Shipped programs:"), c.label + ": no file_sha256 rule");
  }
});

test("4.0.2 1997: every program-running dispatch gets a schema that requires file_sha256 at each slot, and a prompt that names it", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const seen = new Set();
  let n = 0;
  for (const c of out.calls) {
    const names = ran(c.prompt);
    if (!names.size) continue;
    const want = harnessSlots(c.label);
    assert.ok(want, c.label + ": a program-running label with no harness entry");
    for (const [slot, name] of want) {
      if (!names.has(name)) continue;
      n++;
      seen.add(PROGRAM_LABELS.findIndex(([re]) => re.test(c.label)) + "|" + slot);
      assert.ok(requiredAt(c.opts.schema, slot), c.label + ": schema does not require file_sha256 at " + (slot || "top level"));
      // 4.0.2 review: a failed or needs_human result can always satisfy the schema with nulls
      const nullable = (p) => !!p && [].concat(p.type).includes("null");
      const P = c.opts.schema.properties;
      assert.ok(slot === null ? nullable(P.file_sha256) && nullable(P.program) : nullable(P[slot]), c.label + ": " + (slot || "top level") + " accepts null");
      assert.ok(c.prompt.includes("`" + name + ".py` -> " + (slot === null ? "the top level of your result" : "inside `" + slot + "`")), c.label + ": rule names " + name + " at " + slot);
      if (slot === null) {
        const rets = [...c.prompt.matchAll(/Return \{[^}]*\}/g)].map((m) => m[0]).filter((x) => /\bprogram\b/.test(x));
        assert.ok(rets.length, c.label + ": a Return line names program");
        for (const x of rets) assert.match(x, /\bfile_sha256\b/, c.label + ": " + x);
      } else assert.ok(c.prompt.includes("as " + slot + " with `file_sha256`"), c.label + ": the " + slot + " relay names file_sha256");
    }
    // no word count that a third key would contradict
    assert.doesNotMatch(c.prompt, /\b(both|all (two|three|four|five|six)) (values )?copied|\bcopy (both|all (two|three|four|five|six)) unchanged|with (both|all three) copied/i, c.label);
  }
  assert.ok(n >= 20, "program slots checked: " + n);
  assert.ok(seen.size >= 21, "distinct steps: " + seen.size);
});

// the steps the happy run never reaches (park-plan with findings, remote-head,
// callers, precommit-ids, check-scripts, db-up, db-down) are held here, on the source
test("4.0.2 1997: every Return line that names program names file_sha256, and every nested slot is relayed with it (source)", () => {
  // 5.0.2 (ledger 2006): every Return list of a program is built by returnKeys,
  // which ends in program, file_sha256 (and digest); none is hand-written
  const rets = [...SOURCE.matchAll(/Return \{[^}]*\}/g)].map((m) => m[0]).filter((x) => /\bprogram\b/.test(x));
  assert.deepEqual(rets, [], "hand-written Return lines with program");
  assert.ok((SOURCE.match(/returnKeys\(/g) || []).length >= 22, "Return lines built by returnKeys");
  assert.match(SOURCE, /function returnKeys\(id\) \{\n  return progKeys\(id\)\.concat\("program", "file_sha256", progTail\(id\)\)/);
  const table = new Function(grabTable("PROGRAM_SLOTS") + "\nreturn PROGRAM_SLOTS;")();
  for (const slot of new Set(table.flatMap(([, s]) => s.map(([k]) => k)).filter((k) => k !== null)))
    assert.ok(SOURCE.includes('relayAs("' + slot + '")'), slot + " is relayed through relayAs");
  assert.doesNotMatch(SOURCE, /return it as \w+, every value copied unchanged|return it unchanged as \w+|copy all \w+ unchanged|Copy (both|all \w+) unchanged/);
});

test("4.0.2 1997 repro (wf_87a99806-757): branch-scan with the right program but no file_sha256 still stops the run, and its schema requires the key", async () => {
  const s = happy();
  s.__mutate = { label: "infra:branch-scan", fn: (r) => (delete r.file_sha256, r) };
  const o = await runOne(s, ARGS);
  assert.notEqual(o.result.status, "awaiting_confirmation");
  assert.match(o.result.reason, /infra:branch-scan: did not run the shipped program branch_scan \(its file's sha256sum line reads null, not [0-9a-f]{64}\)/);
  const c = o.calls.find((x) => x.label === "infra:branch-scan");
  assert.ok(requiredAt(c.opts.schema, null), "top-level file_sha256 required");
  assert.ok(requiredAt(c.opts.schema, "test_db"), "test_db.file_sha256 required");
  assert.match(c.prompt, /Return \{status: "ok", reason, head, commits, refs, plan_tip_time, program, file_sha256, digest, test_db\}/);
  // the nested slot fails closed too
  const s2 = happy();
  s2.__mutate = { label: "infra:branch-scan", fn: (r) => (delete r.test_db.file_sha256, r) };
  const o2 = await runOne(s2, ARGS);
  assert.notEqual(o2.result.status, "awaiting_confirmation");
  assert.match(o2.result.reason, /\(test_db\): did not run the shipped program test_db_decl \(its file's sha256sum line reads null/);
});

test("4.0.2 1997: the shared schemas stay as they were; only the per-call copy requires file_sha256", async () => {
  const out = await runOne(happy(), ARGS);
  const ws = out.calls.find((x) => x.label === "infra:format-plan:r0" || /^infra:format-plan/.test(x.label));
  if (ws) assert.ok(!(ws.opts.schema.required || []).includes("file_sha256"), "a step that runs no program gets no file_sha256 requirement");
  const scan = out.calls.find((x) => x.label === "infra:branch-scan");
  const scan2 = out.calls.find((x) => /^infra:read-state|^infra:stage-plan/.test(x.label));
  assert.ok(scan && scan2);
  assert.notEqual(scan.opts.schema, scan2.opts.schema, "per-call copies");
});
