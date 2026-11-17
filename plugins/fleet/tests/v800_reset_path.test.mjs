// fleet 8.0.0 car B1 (#62 first cut): a build-dir reset and its PATH re-check run in one agent.
// resetBuild ran build_dir.py reset in one agent and pathRecheck ran path_check.py in the next,
// at 8 sites (test writers, test judge, coder, code judge, commit, push, pr-review, sweep) and
// at the drift retry. Now infra:build-reset:<tag> runs both programs: the reset at the top level
// of its result, the PATH check in its `path_check` slot. capped() excluded both agents, so the
// cap room is unchanged; only total calls drop (happy build 68 -> 61).
//
// ACs (plan-8.0.0-gates.md, B1):
// - B1-1: the happy build drops 7 calls (68 -> 61); capped() is unchanged.
// - B1-2 (non-weakening): a non-shim tool in the merged relay stops needs_human at gate iac,
//   before the role dispatches.
// - B1-3: a bad path-check slot gets one standalone retry on sonnet, then stops.
// - B1-4: a reset digest mismatch still halts with "build dirs were not emptied".
// - B1-5: every label that had a path check still has one (site-set comparison against the
//   7.4.0 baseline, recorded before the change).
//
// dont_care: the token prefix of a merged check (only its nonce, its site and its uniqueness count).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARGS, NONCE, CSHA, HERE, HAVE_PY, happy, run, inputsOf, call, noUnscripted, buildDirOut, pathSlotOut, sha256, canon, spawnSync, programSha } from "./harness.mjs";

const TF = "terra" + "form";
const REAL_TOOL = { path: "/home/u/.local/bin/x", real: "/home/u/.local/bin/x", shim: false };
const NOT_SHIMMED = /terraform tooling on PATH is not shimmed; install the agent PATH shims \(nix\) before using the fleet/;

// [site, the step it guards] on the happy build: the 7 merged pairs
const MERGED = [
  ["writers:r1", "role:fleet-test-writer:AC1:r1"],
  ["test-judge:r1", "role:fleet-test-judge:r1"],
  ["coder:r1", "role:fleet-coder:r1"],
  ["code-judge:r1", "role:fleet-code-judge:r1"],
  ["commit:r1", "infra:commit:r1"],
  ["push", "infra:push"],
  ["pr-review:v1", "role:pr-review:v1"],
];

// the PATH-check sites of each scenario on 7.4.0 (8882fee), from the tokens of every call that ran
// path_check.py (preflight and relay retries aside), recorded before the change
const BASELINE = {
  happy: ["push-probe", "format-plan", "plan-audit", "commit-plan", "writers:r1", "format-tests:r1", "test-judge:r1", "coder:r1", "format-code:r1", "code-judge:r1", "commit:r1", "push", "pr-review:v1"],
  sweep: ["push-probe", "format-plan", "plan-audit", "commit-plan", "writers:r1", "format-tests:r1", "test-judge:r1", "coder:r1", "format-code:r1", "code-judge:r1", "commit:r1", "push", "pr-review:v1", "sweep:v1"],
  writerDrift: ["push-probe", "format-plan", "plan-audit", "commit-plan", "writers:r1", "fleet-test-writer:AC1:r1:retry", "format-tests:r1", "test-judge:r1", "coder:r1", "format-code:r1", "code-judge:r1", "commit:r1", "push", "pr-review:v1"],
  judgeDrift: ["push-probe", "format-plan", "plan-audit", "commit-plan", "writers:r1", "format-tests:r1", "test-judge:r1", "fleet-test-judge:r1:retry", "coder:r1", "format-code:r1", "code-judge:r1", "fleet-code-judge:r1:retry", "commit:r1", "push", "pr-review:v1"],
  reviewDrift: ["push-probe", "format-plan", "plan-audit", "commit-plan", "writers:r1", "format-tests:r1", "test-judge:r1", "coder:r1", "format-code:r1", "code-judge:r1", "commit:r1", "push", "pr-review:v1", "pr-review:v1:retry"],
  coderFile: ["push-probe", "format-plan", "plan-audit", "commit-plan", "writers:r1", "format-tests:r1", "test-judge:r1", "coder:r1", "format-code:r1", "code-judge:r1", "commit:r1", "push", "pr-review:v1"],
};
const SCEN = {
  happy: () => happy(),
  sweep: () =>
    happy({
      script: {
        "infra:review-paths:v1": { status: "ok", reason: "listed", changed_paths: ["hooks/check.py"] },
        "role:gate-change-nonweakening-sweep:v1": { status: "ok", reason: "x", verdict: "non_weakening", units: [], findings: [] },
        "hasher:fp-post:sweep:v1": { status: "ok", fingerprint: { head: CSHA(1), tree: "K1" } },
      },
    }),
  writerDrift: () => {
    const s = happy();
    const ok = s["role:fleet-test-writer:AC1:r1"];
    s["role:fleet-test-writer:AC1:r1"] = Object.assign({}, ok, { tests: "x" });
    s["role:fleet-test-writer:AC1:r1:retry"] = ok;
    return s;
  },
  judgeDrift: () => {
    const s = happy();
    const tj = s["role:fleet-test-judge:r1"];
    s["role:fleet-test-judge:r1"] = Object.assign({}, tj, { checked: "x" });
    s["role:fleet-test-judge:r1:retry"] = tj;
    const cj = s["role:fleet-code-judge:r1"];
    s["role:fleet-code-judge:r1"] = Object.assign({}, cj, { routed_findings: "x" });
    s["role:fleet-code-judge:r1:retry"] = cj;
    return s;
  },
  reviewDrift: () => {
    const s = happy();
    const pr = s["role:pr-review:v1"];
    s["role:pr-review:v1"] = Object.assign({}, pr, { touches_gate: "no" });
    s["role:pr-review:v1:retry"] = pr;
    return s;
  },
  coderFile: () => {
    const s = happy();
    const ok = s["role:fleet-coder:r1"];
    s["role:fleet-coder:r1:retry"] = ok;
    s["role:fleet-coder:r1"] = Object.assign({}, ok, { role_file: null });
    return s;
  },
};
const siteOf = (c) => {
  const t = inputsOf(c.prompt).token;
  return t.slice(t.indexOf(NONCE) + NONCE.length + 1);
};
const checkCalls = (out) => out.calls.filter((c) => c.label !== "preflight" && !/:relay-retry$/.test(c.label) && /path_check\.py/.test(c.prompt));

// a merged reset relay: the reset result plus a path_check slot over `tools`
const merged = (tools, edit) => (p) => {
  const i = inputsOf(p);
  const r = buildDirOut(i.args);
  r.path_check = pathSlotOut(tools || {}, [i.repo, i.token]);
  if (edit) edit(r, i);
  return r;
};

test("8.0.0 B1-1: the happy build drops 7 calls (68 -> 61): each paired reset runs the PATH check itself; the plan run is unchanged", async () => {
  const out = await run(happy(), Object.assign({}, ARGS, { confirm: "ask" }));
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  // 8.0.0 (#62 B2): - 2 plan calls (the surfaces step), - 1 build call (infra:surfaces:r1)
  // 8.0.0 (G3): + 1 plan call (infra:held-out:write)
  assert.equal(out.plan.calls.length, 21, out.plan.labels.join(", "));
  // 8.0.0 (G2): + 2 (infra:build-reset:gates:r1 and infra:gates:r1; the gate is capped)
  assert.equal(out.build.calls.length, 62, out.build.labels.join(", "));
  assert.equal(out.result.agents, 61);
  for (const [site] of MERGED) {
    assert.ok(!out.build.labels.includes("infra:path-check:" + site), site + ": no standalone check");
    const c = call(out.build, "infra:build-reset:" + site);
    assert.match(c.prompt, /build_dir\.py' 'reset' /, site);
    assert.match(c.prompt, /path_check\.py/, site);
    const i = inputsOf(c.prompt);
    assert.equal(i.repo, "/r");
    assert.ok(i.token.includes(NONCE) && !i.token.startsWith("-"), site + ": " + i.token);
    assert.equal(siteOf(c), site);
    // the reset still deletes dirs: not the read-only judge agent; its tier is the reset's
    assert.equal(c.opts.model, "haiku", site);
    assert.doesNotMatch(c.prompt, /terraform|tofu|tflint|terragrunt|\btfp\b|digger|atlantis/i);
  }
  const tokens = checkCalls(out).map((c) => inputsOf(c.prompt).token);
  assert.equal(new Set(tokens).size, tokens.length, "no two checks share a token");
});

test("8.0.0 B1-2 (non-weakening): a non-shim tool in a merged relay stops needs_human at iac before the guarded step; no retry", async () => {
  for (const [site, step] of MERGED) {
    const s = happy();
    s["infra:build-reset:" + site] = merged({ [TF]: REAL_TOOL });
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "needs_human", site + ": " + out.result.reason);
    assert.equal(out.result.stop_gate, "iac", site);
    assert.match(out.result.reason, NOT_SHIMMED, site);
    assert.ok(out.result.reason.includes("infra:build-reset:" + site), site + ": " + out.result.reason);
    assert.ok(out.result.reason.includes(TF + " at " + REAL_TOOL.path), site);
    assert.ok(!out.labels.includes(step), site + ": " + step + " never runs");
    assert.ok(!out.labels.some((l) => /:relay-retry$/.test(l) && l.includes(site)), site + ": a valid relay is not retried");
  }
  // the sweep's reset too
  const s = SCEN.sweep();
  s["infra:build-reset:sweep:v1"] = merged({ [TF]: REAL_TOOL });
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "iac", out.result.reason);
  assert.ok(!out.labels.includes("role:gate-change-nonweakening-sweep:v1"));
  // and a drift retry's reset, before the retry
  const d = SCEN.judgeDrift();
  d["infra:build-reset:fleet-test-judge:r1:drift"] = merged({ [TF]: REAL_TOOL });
  const o2 = await run(d, ARGS);
  assert.equal(o2.result.stop_gate, "iac", o2.result.reason);
  assert.ok(!o2.labels.includes("role:fleet-test-judge:r1:retry"));
});

test("8.0.0 B1-3: a bad path_check slot gets one standalone check on sonnet; a good one goes on, a bad one stops at iac", async () => {
  const site = "code-judge:r1";
  const bad = [
    ["no slot", (r) => delete r.path_check],
    ["null slot", (r) => (r.path_check = null)],
    ["tampered digest", (r) => (r.path_check.digest = "0".repeat(64))],
    ["no tools", (r) => (r.path_check.tools = {})],
    ["the preflight's args", (r, i) => (r.path_check = pathSlotOut({}, [i.repo]))],
    ["another step's token", (r, i) => (r.path_check = pathSlotOut({}, [i.repo, i.token.replace(site, "coder:r1")]))],
    ["a store prefix", (r, i) => (r.path_check = pathSlotOut({}, [i.repo, i.token, "--store-prefix=/tmp/x"]))],
    [
      "path problems",
      (r) => {
        r.path_check.path_problems = ['relative PATH entry "bin"'];
        r.path_check.digest = sha256(canon({ tools: r.path_check.tools, args: r.path_check.args, path_problems: r.path_check.path_problems, program: r.path_check.program }));
      },
    ],
  ];
  for (const [what, edit] of bad) {
    // retry good: the run goes on
    const s = happy();
    s["infra:build-reset:" + site] = merged({}, edit);
    const out = await run(s, ARGS);
    const rl = "infra:path-check:" + site + ":relay-retry";
    if (what === "path problems") {
      // a valid relay with path problems is a finding, not a bad relay: no retry, stop
      assert.equal(out.result.stop_gate, "iac", what + ": " + out.result.reason);
      assert.ok(!out.labels.includes(rl), what);
      continue;
    }
    assert.ok(out.labels.includes(rl), what + ": " + out.labels.join(", "));
    assert.equal(call(out, rl).opts.model, "sonnet", what);
    assert.equal(out.labels.filter((l) => l === rl).length, 1, what + ": one retry");
    assert.ok(out.labels.indexOf(rl) < out.labels.indexOf("role:fleet-code-judge:r1"), what);
    assert.equal(out.result.status, "ok", what + ": " + out.result.reason);
    // retry bad too: stop at iac, the step never runs
    const s2 = happy();
    s2["infra:build-reset:" + site] = merged({}, edit);
    s2[rl] = () => null;
    const o2 = await run(s2, ARGS);
    assert.equal(o2.result.status, "needs_human", what + ": " + o2.result.reason);
    assert.equal(o2.result.stop_gate, "iac", what);
    assert.match(o2.result.reason, NOT_SHIMMED, what);
    assert.ok(o2.result.reason.includes(rl), what + ": " + o2.result.reason);
    assert.ok(!o2.labels.includes("role:fleet-code-judge:r1"), what);
    assert.equal(o2.labels.filter((l) => /:relay-retry$/.test(l) && l.includes(site)).length, 1, what + ": no second retry");
  }
  // the retry finds a real tool: stop
  const s3 = happy();
  s3["infra:build-reset:" + site] = merged({}, (r) => (r.path_check = null));
  s3["infra:path-check:" + site + ":relay-retry"] = (p) => {
    const i = inputsOf(p);
    return Object.assign({ status: "ok", reason: "checked" }, pathSlotOut({ [TF]: REAL_TOOL }, [i.repo, i.token]));
  };
  const o3 = await run(s3, ARGS);
  assert.equal(o3.result.stop_gate, "iac", o3.result.reason);
  assert.ok(!o3.labels.includes("role:fleet-code-judge:r1"));
});

test("8.0.0 B1-4: a failed reset or a reset digest mismatch still halts with 'build dirs were not emptied'", async () => {
  const site = "coder:r1";
  const cases = [
    ["no result", () => null],
    ["failed", () => ({ status: "failed", reason: "python3 exited 1" })],
    ["reset digest", merged({}, (r) => (r.digest = "0".repeat(64)))],
    ["reset dirs", merged({}, (r) => (r.dirs = ["/elsewhere"]))],
  ];
  for (const [what, f] of cases) {
    const s = happy();
    s["infra:build-reset:" + site] = f;
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "failed", what + ": " + out.result.reason);
    assert.match(out.result.reason, /infra:build-reset:coder:r1/, what);
    assert.match(out.result.reason, /build dirs were not emptied/, what + ": " + out.result.reason);
    assert.ok(!out.labels.some((l) => l.startsWith("role:fleet-coder")), what);
  }
});

test("8.0.0 B1-5 (non-weakening): every PATH-check site of 7.4.0 still has a check, before its step", async () => {
  for (const [name, mk] of Object.entries(SCEN)) {
    const out = await run(mk(), ARGS);
    assert.equal(out.result.status, "ok", name + ": " + out.result.reason);
    const sites = checkCalls(out).map(siteOf);
    for (const site of BASELINE[name]) assert.ok(sites.includes(site), name + ": no check at " + site + " (" + sites.join(", ") + ")");
    // no site lost; a reset that had no check before may gain one
    const extra = sites.filter((x) => !BASELINE[name].includes(x));
    // 8.0.0 (G2): the coverage gate's own reset is a new site with a check
    assert.ok(extra.every((x) => /:drift$/.test(x) || /^gates:r\d+$/.test(x)), name + ": unexpected sites " + extra.join(", "));
  }
  // the order: the check of each merged site is the last non-hasher call before its step
  const out = await run(happy(), ARGS);
  for (const [site, step] of MERGED) {
    const at = out.labels.indexOf(step);
    const before = out.labels.slice(0, at).filter((l) => !/^hasher:/.test(l));
    assert.equal(before[before.length - 1], "infra:build-reset:" + site, step);
  }
});

test("8.0.0 B1: a drift retry with build keys runs one merged reset (site <label>:retry), no standalone check", async () => {
  const out = await run(SCEN.writerDrift(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const reset = "infra:build-reset:fleet-test-writer:AC1:r1:drift";
  assert.equal(siteOf(call(out, reset)), "fleet-test-writer:AC1:r1:retry");
  assert.ok(!out.labels.includes("infra:path-check:fleet-test-writer:AC1:r1:retry"), out.labels.join(", "));
  // 7.4.0 ran a reset and a check here: one call less
  const base = await run(happy(), ARGS);
  assert.equal(out.calls.length - base.calls.length, 2, "the merged reset and the retry (7.4.0: 3, with a standalone check)");
});

// the real path_check.py output for the args a merged reset's prompt gives, relayed in its slot
const PY = spawnSync("python3", ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim();
function realPathCheck(args, pathEnv) {
  const r = spawnSync(PY, ["-I", join(HERE, "..", "scripts", "path_check.py")].concat(args), { encoding: "utf8", env: { PATH: pathEnv } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
function realResets(pathEnv) {
  const s = happy();
  s.__mutate = {
    label: /^infra:build-reset:/,
    fn: (r, prompt) => {
      const i = inputsOf(prompt);
      r.path_check = Object.assign(realPathCheck([i.repo, i.token], pathEnv), { file_sha256: programSha("path_check") });
      return r;
    },
  };
  return s;
}

test("8.0.0 B1-2 (real program): the real path_check output in every merged slot passes; a real non-shim tool on PATH stops at the first reset", { skip: !HAVE_PY }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-800b1-"));
  try {
    const empty = join(dir, "empty");
    spawnSync("mkdir", ["-p", empty]);
    const ok = await run(realResets(empty), ARGS);
    assert.equal(ok.result.status, "ok", ok.result.reason);
    assert.ok(!ok.labels.some((l) => /:relay-retry$/.test(l)), ok.labels.join(", "));
    const bin = join(dir, "bin");
    spawnSync("mkdir", ["-p", bin]);
    writeFileSync(join(bin, TF), "#!/bin/sh\necho real\n");
    chmodSync(join(bin, TF), 0o755);
    const out = await run(realResets(bin), ARGS);
    assert.equal(out.result.status, "needs_human", out.result.reason);
    assert.equal(out.result.stop_gate, "iac");
    assert.match(out.result.reason, NOT_SHIMMED);
    assert.ok(out.result.reason.includes("infra:build-reset:writers:r1"), out.result.reason);
    assert.ok(!out.labels.some((l) => l.startsWith("role:fleet-test-writer")), out.labels.join(", "));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
