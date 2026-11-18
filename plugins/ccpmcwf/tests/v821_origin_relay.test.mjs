// ccpmcwf 8.2.1
// #81: a plan whose origin URL is not https or git@host: halts in Workspace (no plan ref, no scope agent);
//      a build from a plan ref with no sealed origin URL halts at load-ref (no role agent); the push-time
//      halt no longer tells Max to re-run plan.
// #82: every infra relay whose output is checked against a program digest runs on sonnet first; the
//      preflight relay retry runs one tier up (opus); the probe role read stays on haiku.
//
// dont_care: the exact remedy wording past the pinned phrases; the order of unrelated labels.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, SOURCE, happy, run, runOne, remoteUrlOut, scriptsProbe } from "./harness.mjs";

const PLAN_HALT_LINE = /\n[^\n]*const oh = originHalt\(ws\);\n[^\n]*\n/;
const BUILD_HALT_LINE = /\n[^\n]*if \(!validRemoteUrl\(remoteUrl\)\) halt\("needs_human", "plan ref "[^\n]*\n/;

function planHaltsInWorkspace(out, re) {
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.match(out.result.reason, re);
  assert.match(out.result.reason, /the build cannot push; set a GitHub or https origin/);
  // not "iac" (the skill reads that as an IaC tool on PATH)
  assert.equal(out.result.stop_gate, null);
  assert.equal(out.build, null, "no build ran");
  assert.ok(!out.result.plan_ref, "no plan ref returned");
  for (const l of ["infra:push-probe", "infra:branch-scan", "role:scope-and-plan", "role:plan-audit", "infra:commit-plan"])
    assert.ok(!out.labels.some((x) => x.indexOf(l) === 0), l + " ran: " + out.labels.join(", "));
  assert.ok(out.labels.includes("workspace"));
}

test("8.2.1 #81: a local-path origin halts the plan in Workspace; no plan ref, no scope agent", async () => {
  const s = happy();
  s.workspace = Object.assign({}, s.workspace, { remote_url: "/home/max/git/fleet-smoke.git" });
  const out = await run(s, ARGS);
  planHaltsInWorkspace(out, /^origin URL \/home\/max\/git\/fleet-smoke\.git is not an https or git@host: URL; /);
});

test("8.2.1 #81: a file:// origin halts the plan in Workspace", async () => {
  const s = happy();
  s.workspace = Object.assign({}, s.workspace, { remote_url: "file:///srv/o.git" });
  const out = await run(s, ARGS);
  planHaltsInWorkspace(out, /^origin URL file:\/\/\/srv\/o\.git is not an https or git@host: URL; /);
});

test("8.2.1 #81: the halt hides URL credentials and control characters, and caps the URL", async () => {
  let s = happy();
  s.workspace = Object.assign({}, s.workspace, { remote_url: "https://x-access-token:ghp_SECRET@github.com/o/r.git" });
  let out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.doesNotMatch(out.result.reason, /SECRET|x-access-token/);
  assert.ok(out.result.gate_log.every((g) => !/SECRET/.test(g)));
  s = happy();
  s.workspace = Object.assign({}, s.workspace, { remote_url: "/srv/a\nb" + "x".repeat(400) });
  out = await run(s, ARGS);
  assert.match(out.result.reason, /^origin URL \/srv\/a\?bx+ is not/);
  assert.ok(out.result.reason.length < 400, out.result.reason);
});

test("8.2.1 #81: no origin, or an unusable origin relay, halts the plan in Workspace with its own reason", async () => {
  let s = happy();
  s.workspace = Object.assign({}, s.workspace, { remote_url_check: remoteUrlOut(null, "/r") });
  planHaltsInWorkspace(await run(s, ARGS), /^origin has no URL; /);
  s = happy();
  s.workspace = Object.assign({}, s.workspace, { remote_url_check: Object.assign(remoteUrlOut("git@github.com:o/r.git", "/r"), { digest: "0".repeat(64) }) });
  planHaltsInWorkspace(await run(s, ARGS), /^origin URL not read \(no digest-checked remote_url_check\); /);
});

test("8.2.1 #81: a build from a plan ref with remote_url null halts at load-ref; zero role agents", async () => {
  // only a plan without the new halt can seal null now
  const s = happy();
  assert.match(SOURCE, PLAN_HALT_LINE);
  s.__source = SOURCE.replace(PLAN_HALT_LINE, "\n");
  s.workspace = Object.assign({}, s.workspace, { remote_url: "/srv/o.git" });
  const plan = await runOne(s, ARGS);
  assert.equal(plan.result.status, "awaiting_confirmation", plan.result.reason);
  // the same script (its plan-ref store), on the shipped dist
  delete s.__source;
  const bargs = Object.assign({}, ARGS, { mode: "build", plan_ref: plan.result.plan_ref });
  delete bargs.input;
  const out = await runOne(s, bargs);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /^plan ref \S+ holds no sealed origin URL \(https or git@host: form\); the build cannot push; set a GitHub or https origin, then plan again$/);
  assert.equal(out.result.stop_gate, null);
  assert.equal(out.labels.filter((l) => l.indexOf("role:") === 0).length, 0, out.labels.join(", "));
  assert.ok(!out.labels.includes("infra:verify-plan"), out.labels.join(", "));
  assert.ok(out.labels.includes("infra:load-ref"));
});

test("8.2.1 #81: the push-time halt (no sealed URL) no longer says re-run plan", async () => {
  const s = happy();
  assert.match(SOURCE, BUILD_HALT_LINE);
  s.__source = SOURCE.replace(PLAN_HALT_LINE, "\n").replace(BUILD_HALT_LINE, "\n");
  s.workspace = Object.assign({}, s.workspace, { remote_url: "/srv/o.git" });
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "iac");
  assert.match(out.result.reason, /no sealed origin URL .*the build cannot push; set a GitHub or https origin/);
  assert.doesNotMatch(out.result.reason, /re-run plan/);
});

// ---------------------------------------------------------------- #82

const MOVED = [
  "infra:path-check:", "preflight", "infra:branch-scan", "infra:stage-plan", "infra:verify-plan", "infra:read-state", "infra:policy",
  "infra:ci-logs", "infra:pr-view", "infra:orch-scan", "infra:ci-watch", "infra:callers", "infra:check-scripts", "infra:review-paths",
  "infra:remote-head", "infra:load-parked", "infra:fleet-branch", "infra:run-lock", "infra:db-up", "infra:db-down", "infra:build-",
  "infra:gh-identity:",
];
function infraTier() {
  const m = /\/\/ INFRA_TIER_BEGIN\n([\s\S]*?)\n\/\/ INFRA_TIER_END/.exec(SOURCE);
  return Function(m[1] + "\nreturn INFRA_TIER;")();
}
const tierOf = (t, l) => (t.find(([p]) => l.indexOf(p) === 0) || [])[1];

test("8.2.1 #82: every digest-checked relay runs on sonnet first; the role read stays on haiku", () => {
  const t = infraTier();
  for (const p of MOVED) assert.equal(tierOf(t, p + "x"), "sonnet", p);
  assert.equal(tierOf(t, "preflight"), "sonnet");
  assert.equal(tierOf(t, "infra:load-parked:p1"), "sonnet");
  assert.equal(tierOf(t, "preflight:relay-retry"), "opus");
  assert.equal(tierOf(t, "infra:role-read:fleet-coder"), "haiku");
});

test("8.2.1 #82: a happy run dispatches preflight, read-state and every PATH check on sonnet; no haiku relay", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const by = (l) => out.calls.filter((c) => c.label === l).map((c) => c.opts.model);
  for (const l of ["preflight", "infra:read-state"]) {
    assert.ok(by(l).length, l);
    for (const m of by(l)) assert.equal(m, "sonnet", l);
  }
  const pc = out.calls.filter((c) => /^infra:path-check:/.test(c.label));
  assert.ok(pc.length >= 5);
  for (const c of pc) assert.equal(c.opts.model, "sonnet", c.label);
  assert.deepEqual(out.calls.filter((c) => c.opts.model === "haiku").map((c) => c.label), []);
});

test("8.2.1 #82: the single preflight relay retry runs one tier up, on opus", async () => {
  const s = happy();
  s.__mutate = { label: "preflight", fn: (r, prompt, label) => Object.assign(r, { scripts_probe: label === "preflight" ? ["sha256 lines as printed"] : scriptsProbe() }) };
  const out = await runOne(s, ARGS);
  assert.deepEqual(out.labels.slice(0, 2), ["preflight", "preflight:relay-retry"]);
  assert.deepEqual(out.calls.slice(0, 2).map((c) => c.opts.model), ["sonnet", "opus"]);
  assert.equal(out.labels.filter((l) => l === "preflight:relay-retry").length, 1);
});
