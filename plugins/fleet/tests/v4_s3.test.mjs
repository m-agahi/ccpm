// fleet 4.0.0 stream S3 (overhead and access): ledger 1990 (infra model
// tiers, preflight cache), 1985 (push-access probe) and 1988
// (.claude/settings.local.json in the fingerprint).
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SOURCE,
  ARGS,
  happy,
  run,
  runOne,
  call,
  inputsOf,
  noUnscripted,
  pathRecheckOut,
} from "./harness.mjs";

// ---------------------------------------------------------------- 1990 tiers

// The INFRA_TIER table, read from the script source.
function infraTier() {
  const m = /\/\/ INFRA_TIER_BEGIN\n([\s\S]*?)\n\/\/ INFRA_TIER_END/.exec(SOURCE);
  assert.ok(m, "INFRA_TIER markers present");
  return Function(m[1] + "\nreturn INFRA_TIER;")();
}
function tierOf(table, label) {
  const hit = table.find(([p]) => label.indexOf(p) === 0);
  return hit ? hit[1] : null;
}

// The tier each infra label must run on (the plan's table, with the brief's
// overrides: park-plan on sonnet, load-parked on haiku; labels the plan does
// not name stay on sonnet).
const WANT = [
  [/^infra:path-check:/, "haiku"],
  [/^preflight/, "haiku"],
  [/^workspace$/, "haiku"],
  [/^infra:branch-scan$/, "haiku"],
  [/^infra:stage-plan/, "haiku"],
  [/^infra:verify-plan/, "haiku"],
  [/^infra:read-state$/, "haiku"],
  [/^infra:callers/, "haiku"],
  [/^infra:check-scripts/, "haiku"],
  [/^infra:precommit-ids/, "haiku"],
  [/^infra:review-paths/, "haiku"],
  [/^infra:remote-head/, "haiku"],
  [/^infra:load-parked$/, "haiku"],
  [/^intake/, "sonnet"],
  [/^hasher:/, "sonnet"],
  [/^infra:load-ref/, "sonnet"],
  [/^infra:commit-plan/, "sonnet"],
  [/^infra:park-plan/, "sonnet"],
  [/^infra:format-/, "sonnet"],
  [/^infra:commit:/, "sonnet"],
  [/^infra:push/, "sonnet"],
  [/^infra:tf-gate/, "sonnet"],
  [/^infra:hook-surface/, "sonnet"],
  [/^infra:changed-defs/, "sonnet"],
  [/^infra:replan-/, "sonnet"],
  [/^infra:state:/, "sonnet"],
  [/^infra:(fleet-scan|purge-bytecode|review-cleanup|ledger-|yaadgaar-|comments-)/, "sonnet"],
];
function wantTier(label) {
  const w = WANT.find(([re]) => re.test(label));
  return w ? w[1] : null;
}

test("4.0.0 1990 AC-1990-2: every infra agent runs on its INFRA_TIER model; every PATH check on haiku", async () => {
  const out = await run(happy(), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  let checks = 0;
  for (const c of out.calls) {
    if (c.label.indexOf("role:") === 0) {
      assert.equal(c.opts.model, "sonnet", c.label + " runs on its DISPATCH tier");
      continue;
    }
    const w = wantTier(c.label);
    assert.ok(w, "no expected tier for " + c.label);
    assert.equal(c.opts.model, w, c.label);
    if (/^infra:path-check:/.test(c.label)) checks++;
  }
  assert.ok(checks >= 10, "the happy run has its PATH checks");
});

test("4.0.0 1990: every agent label in the script resolves in INFRA_TIER, and the table has no catch-all", () => {
  const table = infraTier();
  assert.ok(Array.isArray(table) && table.length > 10);
  for (const [p, t] of table) {
    assert.ok(typeof p === "string" && p.length > 3, "no empty or catch-all prefix: " + JSON.stringify(p));
    assert.ok(t === "haiku" || t === "sonnet", p + " -> " + t);
  }
  const labels = new Set();
  for (const m of SOURCE.matchAll(/"((?:infra|hasher|intake|preflight|workspace)[a-z0-9:_-]*)"/g)) labels.add(m[1]);
  // built from another label at run time
  labels.add("infra:remote-head:push");
  assert.ok(labels.size > 40);
  for (const l of labels) {
    for (const sfx of ["", "x", ":replan", ":retry", ":audit-fix", ":p2", "1"]) {
      const label = l + sfx;
      if (l === "hasher") continue; // the program name, not a label
      const t = tierOf(table, label);
      assert.ok(t, "no INFRA_TIER entry for " + label);
      const w = wantTier(label);
      if (w) assert.equal(t, w, label);
    }
  }
});

test("4.0.0 1990: a haiku PATH check whose relay is broken is retried once on sonnet; a real finding is not", async () => {
  // relay drift: the digest does not match the relayed values
  const s = happy();
  s["infra:path-check:plan-audit"] = (prompt) => {
    const i = inputsOf(prompt);
    const r = pathRecheckOut({}, [i.repo, i.token]);
    r.digest = "0".repeat(64);
    return r;
  };
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const retry = call(out, "infra:path-check:plan-audit:relay-retry");
  assert.equal(retry.opts.model, "sonnet");
  assert.equal(call(out, "infra:path-check:plan-audit").opts.model, "haiku");
  // the retry has its own token
  assert.notEqual(inputsOf(retry.prompt).token, inputsOf(call(out, "infra:path-check:plan-audit").prompt).token);
  // twice broken -> the iac stop, as before
  const s2 = happy();
  const broken = (prompt) => {
    const i = inputsOf(prompt);
    const r = pathRecheckOut({}, [i.repo, i.token]);
    r.digest = "0".repeat(64);
    return r;
  };
  s2["infra:path-check:plan-audit"] = broken;
  s2["infra:path-check:plan-audit:relay-retry"] = broken;
  const o2 = await runOne(s2, ARGS);
  assert.equal(o2.result.status, "needs_human");
  assert.equal(o2.result.stop_gate, "iac");
  // a real IaC tool on PATH is a finding: no retry
  const s3 = happy();
  s3["infra:path-check:plan-audit"] = (prompt) => {
    const i = inputsOf(prompt);
    return pathRecheckOut({ ["terra" + "form"]: { path: "/usr/bin/x", real: "/usr/bin/x", shim: false } }, [i.repo, i.token]);
  };
  const o3 = await runOne(s3, ARGS);
  assert.equal(o3.result.stop_gate, "iac");
  assert.ok(!o3.labels.includes("infra:path-check:plan-audit:relay-retry"), o3.labels.join(", "));
  // a dead or not-ok haiku check is retried on sonnet too
  const s4 = happy();
  s4["infra:path-check:plan-audit"] = null;
  const o4 = await runOne(s4, ARGS);
  assert.equal(o4.result.status, "awaiting_confirmation", o4.result.reason);
  assert.ok(o4.labels.includes("infra:path-check:plan-audit:relay-retry"));
});
