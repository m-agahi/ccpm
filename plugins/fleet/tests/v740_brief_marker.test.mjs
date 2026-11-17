// fleet 7.4.0 car 3 (#30, L2098).
// - N1 (M1, M2): a task body that holds the fleet-brief marker was briefed by /plan-task and is
//   confirmed by Max. Plan mode stops (needs_human) when a source body holds the marker and the
//   caller's confirm is not "ask", before any plan is written; except under unattended, where
//   the marker stays a ruling (6.3.0 ADR-1239) and auto_decisions logs the confirm as before.
// - L3 (M3): brief_check.py flags an IaC path with a ":<line>" or a possessive "'s" suffix.
//
// dont_care: the stop text after "fleet-brief marker".

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARGS, BRIEF, HERE, PB, happy, runOne, inputsOf, spawnSync } from "./harness.mjs";

const MARKER = "<!-- fleet-brief:v1 -->";
const PAGE = "## Fleet brief (plan-task, 2026-11-12)\n\n" + MARKER + "\n\nRepo: o/r Component: x\n";
const marked = (over) => ({ ...BRIEF, sources: [Object.assign({}, BRIEF.sources[0], { body: "Add Thing! (open)\n\n" + PAGE }, over || {})] });
const DEFAULT_CAPS = { pr_ready: true, ci_watch: true, ci_watch_minutes: 60, stats: true, merge: "never", update_branch: "never", ci_trigger: false, review_post: "none" };
const polUn = (p) => ({ status: "ok", reason: "read", profile: "personal", file: "/h/.config/fleet/policy.json", policy_sha256: "f".repeat(64), caps: Object.assign({}, DEFAULT_CAPS, { unattended: true }), matched: "profile personal", error: null, args: inputsOf(p).args });
function gated(over = {}) {
  const s = happy(over);
  Object.assign(s, {
    "hasher:pre-intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "role:fleet-intent-judge": { status: "ok", reason: "matches the task", verdict: "approve", deviations: [], coverage: { covered: true, missing: [] }, classification: { change_kind: "approve", new_behaviour: "approve", quote: "add a thing" } },
    "hasher:fp-post:intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "infra:precommit-ids": { status: "ok", reason: "read", present: true, ids: ["prettier", "check-json"], parser: "yaml" },
  });
  return Object.assign(s, over.script || {});
}
const decisions = (out) => (out.result.auto_decisions || []).map((d) => d.gate + ": " + d.decision + " (" + d.reason + ")");

test("7.4.0 #30 M1: a marked brief under confirm auto or default stops needs_human before the planner", async () => {
  for (const confirm of ["auto", "default"]) {
    const out = await runOne(gated({ brief: marked() }), { ...ARGS, confirm });
    assert.equal(out.result.status, "needs_human", confirm + ": " + out.result.reason);
    assert.match(out.result.reason, /fleet-brief marker/, confirm);
    assert.match(out.result.reason, /confirm ask/, confirm);
    assert.ok(!out.labels.includes("role:scope-and-plan"), confirm + ": no plan");
    assert.ok(!out.labels.some((l) => /^role:fleet-test-writer/.test(l)), confirm + ": no build");
  }
});

test("7.4.0 #30 M2: a marked brief under confirm ask (or none) ends awaiting_confirmation as before", async () => {
  for (const args of [{ ...ARGS, confirm: "ask" }, ARGS, { ...ARGS, confirm: "ask", brief_marker: true }]) {
    const out = await runOne(gated({ brief: marked() }), args);
    assert.equal(out.result.status, "awaiting_confirmation", JSON.stringify(args.confirm) + ": " + out.result.reason);
  }
});

test("7.4.0 #30 M2: the marker in a body_slug page body stops like M1", async () => {
  const out = await runOne(gated({ brief: marked({ body_slug: "o_r_task-42" }) }), { ...ARGS, confirm: "auto" });
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.match(out.result.reason, /fleet-brief marker/);
});

test("7.4.0 #30 M2: a body without the marker is not stopped under confirm auto", async () => {
  const out = await runOne(gated({ brief: marked({ body: "Add Thing! fleet-brief v1 (no marker)" }) }), { ...ARGS, confirm: "auto" });
  assert.doesNotMatch(String(out.result.reason), /fleet-brief marker/);
});

test("7.4.0 #30 M2: under unattended the marker is a ruling: no marker stop, and auto_decisions logs the confirm", async () => {
  const m = await runOne(gated({ brief: marked(), script: { "infra:policy": polUn } }), { ...ARGS, confirm: "default", brief_marker: true });
  assert.equal(m.result.status, "ok", m.result.reason);
  assert.doesNotMatch(String(m.result.reason), /fleet-brief marker/);
  assert.ok(decisions(m).includes("confirm: auto (the Build confirmation (confirm default; the fleet-brief marker is treated as a ruling))"), decisions(m).join("\n"));
  const a = await runOne(gated({ brief: marked(), script: { "infra:policy": polUn } }), { ...ARGS, confirm: "auto", brief_marker: true });
  assert.equal(a.result.status, "ok", a.result.reason);
});

// ---------------------------------------------------------------- M3: brief_check.py

const CHECK = join(HERE, "..", "skills", "plan-task", "brief_check.py");
const GOOD = [
  "## Fleet brief (plan-task, 2026-11-12)",
  "",
  MARKER,
  "",
  "Repo: m-agahi/ccpm Component: fleet",
  "",
  "### Outcome",
  "",
  "When a user runs /plan-task on a vague idea, the task body gains a checked brief.",
  "",
  "### Behaviours",
  "",
  "- B1: Given the template, When brief_check.py runs, Then it exits 0.",
  "",
  "### Rulings (Max, 2026-11-12) — verbatim answers only",
  "",
  '- Q: Where does the brief live? A: "in the task body"',
  "",
  "### Draft by plan-task — not a ruling",
  "",
  "- The check runs on the brief text only.",
  "",
  "### Non-goals",
  "",
  "- No goldfish review.",
  "",
  "### Open decisions",
  "",
  "- none",
  "",
  "### Out of plan: IaC / hook surface / needs ADR",
  "",
  "- none",
  "",
].join("\n");
function check(text) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-740-bc-"));
  try {
    const f = join(dir, "brief.md");
    writeFileSync(f, text);
    const r = spawnSync("python3", ["-I", CHECK, f], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir } });
    return { status: r.status, out: JSON.parse(r.stdout || "null"), stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("7.4.0 #30 M3: brief_check flags infra/main.tf:12, stacks/x.tf and env.tfvars’s as IaC paths", () => {
  const base = check(GOOD);
  assert.equal(base.status, 0, JSON.stringify(base));
  const r = check(GOOD.replace("- The check runs on the brief text only.", "- touch infra/main.tf:12 and stacks/x.tf, and env.tfvars’s"));
  assert.equal(r.status, 1, JSON.stringify(r));
  const iac = r.out.errors.filter((e) => e.check === "iac").map((e) => e.detail).join("\n");
  for (const p of ["'infra/main.tf'", "'stacks/x.tf'", "'env.tfvars'"]) assert.ok(iac.includes(p), p + " not flagged: " + iac);
});

test("7.4.0 #30 M3: the suffix cut takes a line:col pair and an ASCII possessive too", () => {
  const r = check(GOOD.replace("- The check runs on the brief text only.", "- see infra/a.tf:3:7 and env.tfvars's line"));
  const iac = r.out.errors.filter((e) => e.check === "iac").map((e) => e.detail).join("\n");
  for (const p of ["'infra/a.tf'", "'env.tfvars'"]) assert.ok(iac.includes(p), p + " not flagged: " + iac);
});
