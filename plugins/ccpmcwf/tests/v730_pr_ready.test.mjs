// fleet 7.3.0 (#33, L2140) A29, A30: the fleet opens its PR ready for review,
// also on orchestrator and IaC repos. It opens a draft only when the plan
// names a merge_after condition (the body and the run result name it) or the
// policy sets pr_ready false. The no-merge rules do not change.
//
// dont_care: the gate line wording beyond the merge_after text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ARGS, happy, run, call, inputsOf } from "./harness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CAPS = { pr_ready: true, ci_watch: true, ci_watch_minutes: 60, stats: true, merge: "auto", update_branch: "never", ci_trigger: true, review_post: "none" };
const pol = (over) => (p) => ({ status: "ok", reason: "read", profile: "personal", file: "/h/p.json", policy_sha256: null, caps: Object.assign({}, CAPS, over), matched: "x", error: null, now: 1000, args: inputsOf(p).args });
const COND = "after yadgarhq/flux#12 merges";
const opener = (out) => inputsOf(call(out, "role:fleet-pr-opener").prompt);

test("7.3.0 A29: no merge_after, default policy: the PR opens ready and the ready check runs", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(opener(out).draft, false);
  assert.equal(opener(out).merge_after, null);
  assert.ok(out.build.labels.includes("infra:pr-ready"), out.build.labels.join(", "));
  assert.match(out.result.reason, /^PR ready for review/);
});

test("7.3.0 A29: an orchestrator sign: the PR opens ready and is never merged", async () => {
  const s = happy();
  s["infra:policy"] = pol({});
  s["infra:orch-scan"] = (p) => ({ status: "ok", reason: "s", orchestrator: true, iac_repo: false, apply_on_merge: false, hook_surface_pr: false, reasons: ["orchestrator config digger.yml"], error: null, args: inputsOf(p).args });
  const out = await run(s, ARGS);
  assert.equal(opener(out).draft, false);
  assert.ok(out.build.labels.includes("infra:pr-ready"), out.build.labels.join(", "));
  assert.ok(!out.build.labels.some((l) => /^infra:pr-merge/.test(l)), out.build.labels.join(", "));
});

test("7.3.0 A29: a plan merge_after opens a draft that stays a draft; the result names the condition", async () => {
  const s = happy();
  s["role:scope-and-plan"] = Object.assign({}, s["role:scope-and-plan"], { merge_after: COND });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(opener(out).draft, true);
  assert.equal(opener(out).merge_after, COND);
  assert.ok(!out.build.labels.includes("infra:pr-ready"), out.build.labels.join(", "));
  assert.ok(out.build.logs.some((l) => l.includes("merge_after: " + COND)), out.build.logs.join("\n"));
  assert.ok(out.result.reason.includes(COND), out.result.reason);
});

test("7.3.0 A29: policy pr_ready false opens a draft; no ready call", async () => {
  const s = happy();
  s["infra:policy"] = pol({ pr_ready: false });
  const out = await run(s, ARGS);
  assert.equal(opener(out).draft, true);
  assert.ok(!out.build.labels.includes("infra:pr-ready"), out.build.labels.join(", "));
});

test("7.3.0 A30: the pr-opener, scope-and-plan and build-task skill texts say the PR opens ready", () => {
  const po = readFileSync(join(ROOT, "roles/fleet-pr-opener.md"), "utf8");
  assert.match(po, /`--draft` only when `draft` is true/);
  assert.match(po, /`isDraft` equals `draft`/);
  assert.ok(!po.includes("isDraft` true on create"));
  assert.match(readFileSync(join(ROOT, "roles/scope-and-plan.md"), "utf8"), /`merge_after`/);
  const sk = readFileSync(join(ROOT, "skills/build-task/SKILL.md"), "utf8");
  assert.ok(!sk.includes("Never mark it"), "no never-mark-ready text");
  assert.match(sk, /opens ready for review/);
  assert.match(sk, /`merge_after`/);
});
