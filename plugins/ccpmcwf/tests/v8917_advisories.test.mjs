// ccpmcwf 8.9.17 (yaadgaar #133): the code judge's advisory tamper signatures (step 9 "Dodges",
// the 8.3.4 and 8.9.12 lists) are a schema field, advisories: [{path, hunk, signature}] (required,
// [] when none; at most 20; signature from a fixed id enum). The workflow keeps the entries of the
// committed approve whose path the change holds and writes them into the PR's script-written test
// block, one line each, "- `<path>` <@@ range or added path> — <id>". An empty list gives no section.
// A bad entry is contract drift (one retry, then the contract stop). The run-state keeps them.
//
// dont_care: the gate line wording; the other run-state keys.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARGS, HASHES, HERE, SOURCE, happy, run, runOne, call, inputsOf, stateJsonOf, redigest } from "./harness.mjs";

const blockOf = (out, label) => Buffer.from(inputsOf(call(out, label).prompt).args[3], "base64").toString("utf8");
const CHANGED = ["src/x.py", "tests/test_a.py", "uv.lock"];
const ADV = [
  { path: "uv.lock", hunk: "@@ -10,7 +10,7 @@ name = \"coverage\"", signature: "coverage_lock" },
  { path: "src/x.py", hunk: "@@ -1 +1,2 @@", signature: "os_exit" },
];
const LINES = "- `uv.lock` @@ -10,7 +10,7 @@ — coverage_lock\n- `src/x.py` @@ -1 +1,2 @@ — os_exit\n";
function withAdv(adv) {
  const s = happy();
  s["hasher:post-coder:r1"] = Object.assign({}, s["hasher:post-coder:r1"], { changed: CHANGED });
  s["role:fleet-code-judge:r1"] = Object.assign({}, s["role:fleet-code-judge:r1"], { advisories: adv });
  return s;
}

test("8.9.17 (#133): the judge's advisories reach the PR test block as program-rendered lines, and the run result", async () => {
  const out = await run(withAdv(ADV), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const tb = blockOf(out, "infra:pr-tests");
  assert.ok(tb.includes("\n**Advisory flags** (code judge tamper signatures without verdict evidence; not findings):\n" + LINES + "<!-- /ccpm-fleet-tests -->"), tb);
  // the text after the @@ range never reaches the body
  assert.ok(!tb.includes("name = "), tb);
  assert.deepEqual(out.result.advisories, ADV);
});

test("8.9.17 (#133): a path that holds a PR-body marker is rendered with ? for < and >, so every marker stays once", async () => {
  const MARKS = ["<details><summary>Built with ccpmcwf", "<!-- ccpm-fleet-stats -->", "<!-- ccpm-fleet-tests -->", "<!-- /ccpm-fleet-tests -->"];
  const paths = MARKS.map((k, i) => "m" + i + k.replace(/\//g, "") + ".pth");
  const s = happy();
  s["hasher:post-coder:r1"] = Object.assign({}, s["hasher:post-coder:r1"], { changed: CHANGED.concat(paths) });
  s["role:fleet-code-judge:r1"] = Object.assign({}, s["role:fleet-code-judge:r1"], { advisories: paths.map((p) => ({ path: p, hunk: "added path", signature: "pth" })) });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const tb = blockOf(out, "infra:pr-tests");
  const n = (k) => tb.split(k).length - 1;
  assert.equal(n("<!-- ccpm-fleet-tests -->"), 1, tb);
  assert.equal(n("<!-- /ccpm-fleet-tests -->"), 1, tb);
  assert.equal(n("<details><summary>Built with ccpmcwf"), 0, tb);
  assert.equal(n("<!-- ccpm-fleet-stats -->"), 0, tb);
  for (const p of paths) assert.ok(tb.includes("- `" + p.replace(/[<>]/g, "?") + "` added path — pth\n"), p);
});

test("8.9.17 (#133): an empty list gives no section and no result key", async () => {
  const out = await run(withAdv([]), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(!blockOf(out, "infra:pr-tests").includes("Advisory flags"));
  assert.ok(!("advisories" in out.result));
});

test("8.9.17 (#133): an entry whose path the change does not hold is dropped, with a gate line", async () => {
  const out = await run(withAdv(ADV.concat([{ path: "src/other.py", hunk: "added path", signature: "pth" }])), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const tb = blockOf(out, "infra:pr-tests");
  assert.ok(tb.includes(LINES + "<!-- /ccpm-fleet-tests -->"), tb);
  assert.ok(!tb.includes("src/other.py"), tb);
  assert.ok(out.logs.some((l) => /advisory pth on src\/other\.py dropped/.test(l)), out.logs.join("\n"));
});

test("8.9.17 (#133): a signature outside the enum, a bad path or hunk, or over 20 entries is drift: one retry, then the stop", async () => {
  const bad = [
    [{ path: "src/x.py", hunk: "@@ -1 +1 @@", signature: "something the judge made up" }],
    [{ path: "../x.py", hunk: "@@ -1 +1 @@", signature: "os_exit" }],
    [{ path: "/etc/x", hunk: "@@ -1 +1 @@", signature: "os_exit" }],
    [{ path: "src/x`.py", hunk: "@@ -1 +1 @@", signature: "os_exit" }],
    [{ path: "src/x‮.py", hunk: "@@ -1 +1 @@", signature: "os_exit" }],
    [{ path: "src/x.py", hunk: "## heading", signature: "os_exit" }],
    Array.from({ length: 21 }, () => ({ path: "src/x.py", hunk: "added path", signature: "pth" })),
  ];
  for (const adv of bad) {
    const s = withAdv(adv);
    const out = await run(s, ARGS);
    assert.ok(out.labels.includes("role:fleet-code-judge:r1:retry"), JSON.stringify(adv[0]) + ": " + out.labels.join(", "));
    assert.equal(out.result.status, "needs_human", JSON.stringify(adv[0]));
    assert.equal(out.result.stop_gate, "contract");
    assert.equal(out.result.stop_class, "safety");
    assert.match(out.result.reason, /advisories entry \d+ |advisories 21 entries/, out.result.reason);
    assert.ok(!out.labels.some((l) => /^infra:pr-tests/.test(l)), out.labels.join(", "));
  }
  // the retry fixes it: the run goes on
  const s = withAdv([{ path: "src/x.py", hunk: "@@ -1 +1 @@", signature: "made_up" }]);
  s["role:fleet-code-judge:r1:retry"] = Object.assign({}, s["role:fleet-code-judge:r1"], { advisories: [ADV[1]] });
  const ok = await run(s, ARGS);
  assert.equal(ok.result.status, "ok", ok.result.reason);
  assert.ok(blockOf(ok, "infra:pr-tests").includes("- `src/x.py` @@ -1 +1,2 @@ — os_exit\n"));
});

test("8.9.17 (#133): the advisories key is required on ok (a missing one is drift)", async () => {
  const s = withAdv(ADV);
  const j = Object.assign({}, s["role:fleet-code-judge:r1"]);
  delete j.advisories;
  s["role:fleet-code-judge:r1"] = Object.assign({ __raw: true }, j, { gates_not_run: [], obligations_check: [] });
  const out = await run(s, ARGS);
  assert.ok(out.labels.includes("role:fleet-code-judge:r1:retry"), out.labels.join(", "));
  // the schema the judge gets requires the key (a workflow agent drops a key its schema does not require)
  const sch = call(out, "role:fleet-code-judge:r1").opts.schema;
  assert.ok(sch.required.includes("advisories"), JSON.stringify(sch.required));
  assert.deepEqual(sch.properties.advisories.items.properties.signature.enum, /\nconst ADVISORY_IDS = "([^"]*)"\.split/.exec(SOURCE)[1].split(" "));
});

test("8.9.17 (#133): a body the pr-opener rewrites without the section gets it back from the program", async () => {
  const s = withAdv(ADV);
  // the first write reports a block that is not the script's (the section dropped): one regeneration
  let n = 0;
  s.__mutate = { label: /^infra:pr-tests/, fn: (r, prompt, real) => (/-retry$/.test(real) || n++ ? r : redigest(real, Object.assign(r, { block_sha256: "0".repeat(64) }), prompt)) };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(blockOf(out, "infra:pr-tests:regen").includes(LINES), "the regenerated block holds the section");
  // a second miss stops (stats)
  const s2 = withAdv(ADV);
  s2.__mutate = { label: /^infra:pr-tests/, fn: (r, prompt, real) => redigest(real, Object.assign(r, { block_sha256: "0".repeat(64) }), prompt) };
  const out2 = await run(s2, ARGS);
  assert.equal(out2.result.status, "needs_human");
  assert.equal(out2.result.stop_gate, "stats");
});

test("8.9.17 (#133): the run-state keeps the advisories (absent when none); a resume writes them into the block again", async () => {
  const states = {};
  const s = withAdv(ADV);
  for (const label of ["infra:state:committed:r1", "infra:state:pr_open:p1", "infra:state:shipped"]) {
    s[label] = (prompt) => {
      const st = stateJsonOf(prompt);
      states[st.last_gate] = st;
      return { status: "ok", reason: "written", head: inputsOf(prompt).expected_head, state_sha: "f".repeat(40) };
    };
  }
  const plan = await runOne(s, ARGS);
  const bargs = { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r" };
  const first = await runOne(s, bargs);
  assert.equal(first.result.status, "ok", first.result.reason);
  assert.deepEqual(states.shipped.advisories, ADV);
  assert.deepEqual(states.pr_open.advisories, ADV);
  const resumeAt = (x) => {
    s["infra:verify-plan"] = { ...happy()["infra:verify-plan"], head: x.approved_sha, commits_since: [{ sha: x.approved_sha, subject: "feat(thing): add thing" }], changed_since: ["src/x.py", "tests/test_a.py"] };
    s["infra:read-state"] = { status: "ok", reason: "read", exists: true, target: x.approved_sha, message: JSON.stringify(x), head: x.approved_sha, head_tree: x.code_tree, clean: true };
    const h = JSON.parse(JSON.stringify(HASHES));
    h.git["fleetref:refs/fleet/l42/freeze"] = "T1";
    s["hasher:resume"] = { status: "ok", fingerprint: { head: x.approved_sha, tree: x.code_tree }, hashes: h };
    return runOne(s, bargs);
  };
  const out = await resumeAt(states.pr_open);
  assert.ok(blockOf(out, "infra:pr-tests:resume").includes(LINES), out.labels.join(", "));
  // a run-state before 8.9.17 (no key): no section
  const old = Object.assign({}, states.pr_open);
  delete old.advisories;
  const out0 = await resumeAt(old);
  assert.ok(!blockOf(out0, "infra:pr-tests:resume").includes("Advisory flags"));
  // a bad or empty list stops (resume)
  for (const bad of [[], [{ path: "x", hunk: "h", signature: "pth" }], "x"]) {
    const o = await resumeAt(Object.assign({}, states.pr_open, { advisories: bad }));
    assert.equal(o.result.status, "needs_human", JSON.stringify(bad));
    assert.equal(o.result.stop_gate, "resume");
    assert.match(o.result.reason, /run-state mismatch: advisories/);
  }
});

test("8.9.17 (#133): step 9 sends the signatures to advisories; its id list is the engine's enum", () => {
  const role = readFileSync(join(HERE, "..", "roles", "fleet-code-judge.md"), "utf8");
  const step9 = /\n9\. \*\*Dodges\.\*\*[^\n]*(?:\n {3}[^\n]*)*/.exec(role)[0];
  assert.ok(step9.includes("goes in `advisories`, never in `routed_findings` or `memory_notes`"), step9);
  const ids = /`signature` is one of these ids: ([^\n]*?)\. No hit/.exec(step9)[1].match(/`[a-z_]+`/g).map((x) => x.slice(1, -1));
  const engine = /\nconst ADVISORY_IDS = "([^"]*)"\.split/.exec(SOURCE)[1].split(" ");
  assert.deepEqual(ids, engine);
  assert.ok(/`advisories` \(array, `\[\]` when none; see check 9\)/.test(role), "Required on ok names advisories");
});
