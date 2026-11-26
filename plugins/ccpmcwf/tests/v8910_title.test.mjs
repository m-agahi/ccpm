// ccpmcwf 8.9.10 (yaadgaar #123, #129, #128).
// #123: the commit subject and the PR title come from one builder (subjectsOf). It keeps the
// plan tldr's safe punctuation (. , - > / _ : ( ) #) and digits, maps every other character to a
// space, and cuts at a word boundary under the cap. The R2 incident (yadgarhq/iam-db#195, 8.9.6
// run wf_29ad47bb-640): "feat(service): bump iam db proto version v1 27 0 v1 29 1 and re vendor p".
// #129: a blocking pr-review finding of category pr_title with no file stops for the human (the
// workflow writes the title and the commit subject; no role can change them); any file goes to
// the coder; a mixed review never sends the title finding to the coder.
// #128: the default RUN_BUDGET is 1.5M output tokens.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, HASHES, CSHA, SOURCE, happy, run, call, inputsOf } from "./harness.mjs";

const subjectsOfRun = async (tldr) => {
  const s = happy();
  s["role:scope-and-plan"] = Object.assign({}, s["role:scope-and-plan"], { tldr });
  const out = await run(s, ARGS);
  const subj = out.calls.filter((c) => /^infra:commit:r/.test(c.label)).map((c) => inputsOf(c.prompt).subject);
  const titles = out.calls.filter((c) => /^role:fleet-pr-opener/.test(c.label)).map((c) => inputsOf(c.prompt).title);
  return { out, subj, titles };
};
// the summary charset: lowercase letters, digits, space and . , _ : ( ) # > / -
const SAFE = /^[a-z][a-z0-9-]*\([a-z][a-z0-9-]*\): [a-z0-9][a-z0-9 .,_:()#>\/-]*$/;

test("8.9.10 #123 R2: the iam-db proto bump keeps its dots, dashes and arrow and is cut at a word boundary", async () => {
  const { out, subj, titles } = await subjectsOfRun("bump iam-db proto version v1.27.0 -> v1.29.1 and re-vendor proto stubs for every service\nmore");
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(subj.length && titles.length);
  assert.equal(subj[0], "feat(thing): bump iam-db proto version v1.27.0 -> v1.29.1 and re-vendor");
  for (const t of titles) assert.equal(t, subj[0]);
  assert.ok(subj[0].length <= 72);
});

test("8.9.10 #123: the exact R2 input proto v1.27.0 -> v1.29.1, re-vendor, iam-db is kept whole", async () => {
  const { out, subj, titles } = await subjectsOfRun("proto v1.27.0 -> v1.29.1, re-vendor, iam-db");
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(subj[0], "feat(thing): proto v1.27.0 -> v1.29.1, re-vendor, iam-db");
  assert.deepEqual([...new Set(titles)], [subj[0]]);
});

test("8.9.10 #123: a long tldr is cut at the last space under the cap, with no partial word and no trailing separator", async () => {
  const words = "update the parser so it handles nested quotes -> escaped forms and keeps every token intact across lines";
  const { out, subj } = await subjectsOfRun(words);
  assert.equal(out.result.status, "ok", out.result.reason);
  const sum = subj[0].slice("feat(thing): ".length);
  assert.ok(subj[0].length <= 72, subj[0]);
  assert.ok(words.startsWith(sum), sum);
  assert.ok(words[sum.length] === " ", "cut at a word boundary: " + JSON.stringify(sum));
  assert.doesNotMatch(sum, /[ .,_:(#>\/-]$/);
});

test("8.9.10 #123: shell, quote and control characters never reach the subject or the title", async () => {
  const { out, subj, titles } = await subjectsOfRun("fix `rm -rf x` $(id) 'q' \"d\" a\\b; c | d & e! f\tg\u0007h ~x *y ?z <w> [v] {u}");
  assert.equal(out.result.status, "ok", out.result.reason);
  for (const x of subj.concat(titles)) {
    assert.match(x, SAFE, x);
    assert.doesNotMatch(x, /[`$'"\\;|&!\t\u0007~*?<\[\]{}]|  /, x);
  }
  assert.equal(subj[0], "feat(thing): fix rm -rf x (id) q d a b c d e f g h x y z w> v u");
});

test("8.9.10 #123: the task id and the source ref are dropped by word, never from inside a version", async () => {
  // ARGS input "#42": yaadgaar source ref 42, task id y42
  const { out, subj } = await subjectsOfRun("fix y42 parser (#42) for v1.42.0 in /home/u/r/src/p.py and https://x.io/a");
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(subj[0], "feat(thing): fix parser for v1.42.0 in and");
});

test("8.9.10 #123: one word longer than the cap is cut at the cap (the only partial word allowed)", async () => {
  const { out, subj } = await subjectsOfRun("a".repeat(90));
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(subj[0], "feat(thing): " + "a".repeat(59));
});

test("8.9.10 #123: the unsafe-subject gate allows the builder's charset and nothing more", () => {
  const m = /const SUBJECT_RE = (\/.*\/);/.exec(SOURCE);
  assert.ok(m, "SUBJECT_RE in the source");
  const re = new RegExp(m[1].slice(1, -1));
  assert.ok(re.test("feat(thing): bump iam-db proto version v1.27.0 -> v1.29.1 and re-vendor"));
  assert.ok(re.test("fix(thing, ABC-1): code round 2"));
  for (const bad of ["feat(thing): a'b", "feat(thing): a$b", "feat(thing): a`b", 'feat(thing): a"b', "feat(thing): a\\b", "feat(thing): a;b", "feat(thing): a  b", "feat(thing): a ", "feat(thing): -a", "feat(thing): a\nb", "feat(thing): " + "a".repeat(61)])
    assert.ok(!re.test(bad), bad);
});

// ---------------------------------------------------------------- #129

const TITLE = {
  id: "R2",
  severity: "blocking",
  category: "pr_title",
  file: null,
  line: null,
  summary: "the commit subject and the PR title are cut off mid-word: 'feat(service): bump iam db proto version v1 27 0 v1 29 1 and re vendor p'",
  evidence: "gh pr view 195 --json title",
  target: "code",
};
const CODE = { id: "R3", severity: "blocking", category: "correctness", file: "src/x.py", line: 3, summary: "empty input passes", evidence: "ran x" };
const REV = (v, fs) => ({ status: "ok", reason: "x", verdict: v, findings: fs, touches_gate: false, checked: [] });
const OPEN7 = { status: "ok", reason: "updated", pr_url: "https://github.com/o/r/pull/7", pr_number: 7, created: false, template_used: null, gates_not_run_stated: true };
const APPROVE = { status: "ok", reason: "clean", verdict: "approve", findings: [], touches_gate: false, checked: [] };
const CODER2 = { status: "ok", reason: "done", changed_paths: ["src/x.py"], frozen_tests_red_at_start: true, suite_result: { command: "pytest", exit_code: 0 } };
const JUDGE2 = { status: "ok", reason: "good", verdict: "approve", routed_findings: [], hash_check: { match: true, mismatched: [] }, suite_result: { command: "pytest", exit_code: 0 } };
function fixture(script) {
  const F = happy();
  const rs = F["hasher:pre-review:v1"];
  F["infra:review-paths:v2"] = { status: "ok", reason: "listed", changed_paths: ["src/x.py"] };
  F["hasher:pre-review:v2"] = rs;
  F["hasher:fp-post:pr-review:v2"] = rs;
  F["infra:review-cleanup:v2"] = { status: "ok", reason: "clean" };
  return Object.assign(F, script);
}
const CODE_ROUND = {
  "role:fleet-coder:r2": CODER2,
  "hasher:post-coder:r2": { status: "ok", fingerprint: { head: CSHA(1), tree: "K2" }, hashes: HASHES },
  "role:fleet-code-judge:r2": JUDGE2,
  "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: { head: CSHA(1), tree: "K2" } },
  "infra:push:p2": (prompt) => ({ status: "ok", reason: "pushed", push_result: "ok", remote_head: inputsOf(prompt).approved_sha }),
  "role:fleet-pr-opener:p2": OPEN7,
  "role:pr-review:v2": APPROVE,
};

test("8.9.10 #129: the pr-review schema and role know the pr_title category", () => {
  assert.match(SOURCE, /const FINDING_CATEGORIES = \[[^\]]*"pr_title"/);
});

test("8.9.10 #129 (R2 shape, blocking): a pr_title finding with no file stops for the human; no coder round", async () => {
  const out = await run(fixture({ "role:pr-review:v1": REV("changes_requested", [TITLE]) }), ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "review");
  assert.equal(out.result.stop_class, "judgment");
  assert.match(out.result.reason, /review v1: PR title finding: the workflow builds the PR title and the commit subject from the plan; no role can change them: R2: /);
  for (const l of ["role:fleet-coder:r2", "role:fleet-code-judge:r2", "infra:commit:r2"]) assert.ok(!out.labels.includes(l), l);
  assert.ok(!out.labels.some((l) => l.startsWith("role:fleet-pr-opener:body-v")));
  assert.ok(!out.result.gate_log.some((l) => /-> coder \(fix_code\)/.test(l)), out.result.gate_log.join("\n"));
});

test("8.9.10 #129: a pr_title finding with a file is a code finding and goes to the coder (fails toward the coder)", async () => {
  const MIS = Object.assign({}, TITLE, { file: "src/x.py", line: 3 });
  const out = await run(fixture(Object.assign({ "role:pr-review:v1": REV("changes_requested", [MIS]) }, CODE_ROUND)), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const rf = inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings;
  assert.equal(rf.length, 1);
  assert.ok(rf[0].finding.startsWith("review R2 [pr_title] src/x.py:3: "), rf[0].finding);
});

test("8.9.10 #129: a mixed code + pr_title review sends only the code finding to the coder", async () => {
  const out = await run(fixture(Object.assign({ "role:pr-review:v1": REV("changes_requested", [TITLE, CODE]) }, CODE_ROUND)), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.deepEqual(inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings, [
    { target: "code", criterion: null, finding: "review R3 [correctness] src/x.py:3: empty input passes (evidence: ran x)" },
  ]);
  assert.ok(!call(out, "role:fleet-coder:r2").prompt.includes("cut off mid-word"));
  assert.equal(inputsOf(call(out, "role:fleet-pr-opener:p2").prompt).body_findings, undefined);
});

test("8.9.10 #129: a pr_title finding still flagged after the code round stops for the human", async () => {
  const out = await run(fixture(Object.assign({ "role:pr-review:v1": REV("changes_requested", [TITLE, CODE]) }, CODE_ROUND, { "role:pr-review:v2": REV("changes_requested", [TITLE]) })), ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "review");
  assert.match(out.result.reason, /^review v2: PR title finding/);
  assert.ok(!out.labels.includes("role:fleet-coder:r3"));
});

// ---------------------------------------------------------------- #128

test("8.9.10 #128: the default run budget is 1.5M output tokens", () => {
  assert.match(SOURCE, /const RUN_BUDGET = 1500000;/);
});
