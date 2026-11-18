// fleet 7.4.0 review fixes, B group (workflow side):
// - B-M3: the plan sweep runs only for a planned path on a gate path (planScopePaths: files, test
//   files, occurrences with a criterion) or touches_gate, never for a caller occurrence alone; a sweep that did not finish is a warning, not a stop; a
//   weakening sweep still stops the plan (v740_plan_sweep Z2).
// - B-M4: UV_CACHE_DIR is per run and per tier, outside build/ (a reset deletes build/):
//   <scratch>/uv-cache/<nonce>/write for test writers and the coder, .../gate for every other role
//   and hook env (security follow-up: a writer could plant a wheel a gate then installs).
//   UV_PROJECT_ENVIRONMENT stays per role.
// - B-m1: the push-access probe runs with a 180 s Bash timeout (its git runs up to 120 s).
// - B-m3: the workflow's push slug pattern is push.py's SLUG, character for character.
// - B-m7: a fleet-brief marker under confirm default or auto asks (confirm ask) with a gate line, in
//   place of a stop.
//
// dont_care: the warning wording after "plan sweep".

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARGS, NONCE, BUILD_SCRATCH, BRIEF, PB, SCRIPTS_SRC, happy, run, runOne, call, inputsOf, spawnSync } from "./harness.mjs";

const SRC = readFileSync(new URL("../src/build-engine.js", import.meta.url), "utf8");
const PUSH = readFileSync(new URL("../scripts/push.py", import.meta.url), "utf8");
const SW = "role:gate-change-nonweakening-sweep:plan";
const SFX = ["", ":audit-fix", ":audit-fix-2"];
const fence = (files) => ({ files, symbols: [], deps: [], settings: [] });

function plan(over, sweep) {
  const s = happy();
  for (const x of SFX) {
    s["role:scope-and-plan" + x] = Object.assign({}, s["role:scope-and-plan"], over || {});
    s["role:plan-audit" + x] = s["role:plan-audit"];
    if (sweep) s[SW + x] = sweep;
  }
  return s;
}

test("7.4.0 review B-M3: a caller occurrence on a gate path alone (no criterion) runs no plan sweep", async () => {
  const cs = [{ symbol: "guard_verdict", occurrences: [{ at: "chart/guards.py:10", criterion: null, dont_care: "a caller; its behaviour is unchanged" }] }];
  const s = plan({ changed_symbols: cs, allowed_additions: fence(["src/x.py"]), touches_gate: false });
  s["infra:callers"] = { status: "ok", reason: "grepped", occurrences: { guard_verdict: ["chart/guards.py:10"] }, capped: [] };
  const out = await runOne(s, ARGS);
  assert.ok(!out.labels.some((l) => /gate-change-nonweakening-sweep/.test(l)), out.labels.join(", "));
});

test("7.4.0 review B-M3: a planned occurrence (with a criterion) in a gate file still runs the plan sweep", async () => {
  const cs = [{ symbol: "guard_verdict", occurrences: [{ at: "chart/guards.py:10", criterion: "AC1", dont_care: null }] }];
  const s = plan({ changed_symbols: cs, allowed_additions: fence(["src/x.py"]), touches_gate: false }, { status: "ok", reason: "0 loosened", verdict: "non_weakening", units: [], findings: [] });
  s["infra:callers"] = { status: "ok", reason: "grepped", occurrences: { guard_verdict: ["chart/guards.py:10"] }, capped: [] };
  const out = await runOne(s, ARGS);
  assert.ok(out.labels.includes(SW), out.labels.join(", "));
  assert.ok(out.logs.some((l) => /plan sweep triggered \( paths chart\/guards\.py\)/.test(l)), out.logs.join("\n"));
});

test("7.4.0 review B-M3: a plan sweep that did not finish is a warning; the plan goes on", async () => {
  for (const sw of [{ status: "error", reason: "base_ref unreadable" }]) {
    const out = await runOne(plan({ allowed_additions: fence(["plugins/x/hooks/check.py"]) }, sw), ARGS);
    assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
    assert.ok(out.logs.some((l) => /warning: plan sweep did not finish/.test(l)), out.logs.join("\n"));
    assert.ok(out.labels.includes("infra:commit-plan"));
  }
});

// security follow-up: two run-level uv caches; a role that writes code never shares one with a gate
test("7.4.0 review B-M4: UV_CACHE_DIR is per run and per tier: writers and the coder share one, every gate step another", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const W = BUILD_SCRATCH + "/uv-cache/" + NONCE + "/write";
  const G = BUILD_SCRATCH + "/uv-cache/" + NONCE + "/gate";
  assert.notEqual(W, G);
  const seen = { w: 0, g: 0 };
  for (const c of out.calls) {
    let i;
    try {
      i = inputsOf(c.prompt);
    } catch {
      continue;
    }
    for (const e of [i && i.test_env, i && i.hook_env]) {
      if (!e || !e.UV_CACHE_DIR) continue;
      const writer = /^role:fleet-(test-writer|coder)(:|$)/.test(c.label);
      assert.equal(e.UV_CACHE_DIR, writer ? W : G, c.label);
      seen[writer ? "w" : "g"]++;
    }
    if (!/^role:fleet-(test-writer|coder)(:|$)/.test(c.label)) assert.ok(!String(c.prompt).includes(W), c.label + " names the writers' cache");
  }
  assert.ok(seen.w >= 2 && seen.g >= 3, JSON.stringify(seen));
  for (const l of ["role:fleet-test-judge:r1", "role:fleet-code-judge:r1", "role:pr-review:v1"]) assert.equal(inputsOf(call(out, l).prompt).test_env.UV_CACHE_DIR, G, l);
  assert.equal(inputsOf(call(out, "infra:commit:r1").prompt).hook_env.UV_CACHE_DIR, G);
  const cw = inputsOf(call(out, "role:fleet-coder:r1").prompt).test_env;
  assert.equal(cw.UV_CACHE_DIR, W);
  assert.equal(cw.UV_PROJECT_ENVIRONMENT, BUILD_SCRATCH + "/build/" + NONCE + "/coder-r1/uv-venv");
});

test("7.4.0 review B-M4: build_dir reset keeps <scratch>/uv-cache; clean deletes it with build/, never through a link", () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-740rb-uv-"));
  const prog = (a) => {
    const r = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "build_dir.py")].concat(a), { encoding: "utf8" });
    return { status: r.status, stderr: r.stderr, out: r.status === 0 ? JSON.parse(r.stdout) : null };
  };
  try {
    const sc = join(home, "scratch");
    const uc = join(sc, "uv-cache", NONCE, "gate");
    mkdirSync(uc, { recursive: true });
    writeFileSync(join(uc, "w"), "12345");
    let r = prog(["reset", sc, NONCE, "coder-r1"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(uc, "w")), "a reset keeps the uv caches");
    r = prog(["clean", sc]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.out.removed, true);
    assert.equal(r.out.bytes, 5);
    assert.ok(!existsSync(join(sc, "uv-cache")) && !existsSync(join(sc, "build")));
    // a symlinked uv-cache is refused; nothing outside is deleted
    const outside = join(home, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep"), "x");
    symlinkSync(outside, join(sc, "uv-cache"));
    assert.notEqual(prog(["clean", sc]).status, 0);
    assert.ok(existsSync(join(outside, "keep")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("7.4.0 review B-m1: the push-access probe runs as one Bash call with timeout 180000 ms", async () => {
  const out = await run(happy(), ARGS);
  const p = call(out.plan, "infra:push-probe").prompt;
  assert.match(p, /as one Bash call with timeout 180000 ms/);
});

test("7.4.0 review B-m3: the workflow's push slug pattern equals push.py's SLUG", () => {
  const js = /const PUSH_SLUG_RE = \/(.*)\/;/.exec(SRC);
  const py = /^SLUG = re\.compile\(r'(.*)'\)$/m.exec(PUSH);
  assert.ok(js && py);
  assert.equal(js[1].replace(/\\\//g, "/"), py[1]);
  assert.match(SRC, /PUSH_SLUG_RE\.test\(String\(remoteSlug/);
});

const MARKER = "<!-- fleet-brief:v1 -->";
const marked = () => ({ ...BRIEF, sources: [Object.assign({}, BRIEF.sources[0], { body: "Add Thing! (open)\n\n" + MARKER + "\n" })] });

test("7.4.0 review B-m7: a marked brief under confirm auto or default asks in place of a stop", async () => {
  for (const confirm of ["auto", "default"]) {
    const out = await runOne(happy({ brief: marked() }), { ...ARGS, confirm });
    assert.equal(out.result.status, "awaiting_confirmation", confirm + ": " + out.result.reason);
    assert.ok(out.logs.some((l) => /fleet-brief marker: confirm ask/.test(l)), confirm);
    assert.ok(out.labels.includes("role:scope-and-plan"), confirm);
    assert.ok(!out.labels.some((l) => /^role:fleet-test-writer/.test(l)), confirm + ": no build");
  }
});
