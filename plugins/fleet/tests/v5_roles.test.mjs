// fleet 5.0.0 PR-1 (R1, ledger 1999): the role prompts ship in the plugin as
// roles/<role>.md, pinned by ROLE_SHA256 in the workflow. Preflight relays each
// file through role_files.py (one sonnet agent per role); the script joins the
// relayed chunks and hashes the text itself. No prompt loads a yadgar page.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SOURCE,
  ARGS,
  happy,
  run,
  runOne,
  spawnSync,
  inputsOf,
  ROLE_NAMES,
  ROLE_TEXT,
  ROLES_SRC,
  SCRIPTS_SRC,
  SCRIPTS_DIR,
  roleChunks,
  scriptsProbe,
  programSha,
  noUnscripted,
  sha256,
  canon,
} from "./harness.mjs";

const GEN = await import(join(SCRIPTS_SRC, "gen.mjs"));
const PIN = GEN.roles(SOURCE);
const fileSha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const ROLES_DIR = SCRIPTS_DIR.replace(/\/scripts$/, "/roles");
// the happy scenario with the shipped role files unchanged (happy runs every role on sonnet)
function shipped() {
  const s = happy();
  delete s.__dispatch;
  return s;
}

// the script's own helpers, compiled from the source (the production hash path)
function scriptFns() {
  const pick = (name) => {
    const i = SOURCE.indexOf("\nfunction " + name + "(");
    assert.ok(i >= 0, name);
    const j = SOURCE.indexOf("\n}\n", i);
    return SOURCE.slice(i, j + 3);
  };
  const k = SOURCE.indexOf("\nconst K256 = [");
  const kEnd = SOURCE.indexOf("];\n", k) + 3;
  return new Function(SOURCE.slice(k, kEnd) + pick("utf8Bytes") + pick("rotr") + pick("sha256Hex") + "\nreturn { sha256Hex };")();
}

test("5.0.0 R1: ten role files ship, each pinned by ROLE_SHA256, and gen.mjs --check passes", () => {
  assert.deepEqual(readdirSync(ROLES_SRC).sort(), ROLE_NAMES.map((r) => r + ".md").sort());
  assert.deepEqual(Object.keys(PIN).sort(), ROLE_NAMES.slice().sort());
  for (const r of ROLE_NAMES) {
    assert.equal(fileSha(join(ROLES_SRC, r + ".md")), PIN[r], r);
    assert.doesNotMatch(ROLE_TEXT[r], /^CONTRACT:/m, r + ": the CONTRACT line is stripped");
    assert.match(ROLE_TEXT[r], /^DISPATCH: model=[a-z]+/m, r + ": the DISPATCH line is kept");
  }
  const ok = spawnSync("node", [join(SCRIPTS_SRC, "gen.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
});

test("5.0.0 R1: gen.mjs --check fails on a changed, missing or extra role file", () => {
  const tmp = mkdtempSync(join(tmpdir(), "fleet-roles-gen-"));
  const dir = join(tmp, "roles");
  const wf = join(tmp, "build-task-run.js");
  const chk = () => spawnSync("node", [join(SCRIPTS_SRC, "gen.mjs"), "--check", "--roles", dir, "--workflow", wf], { encoding: "utf8" });
  try {
    cpSync(ROLES_SRC, dir, { recursive: true });
    writeFileSync(wf, SOURCE);
    assert.equal(chk().status, 0, chk().stderr);
    writeFileSync(join(dir, "plan-audit.md"), ROLE_TEXT["plan-audit"] + "x");
    const changed = chk();
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /plan-audit\.md/);
    writeFileSync(join(dir, "plan-audit.md"), ROLE_TEXT["plan-audit"]);
    writeFileSync(join(dir, "extra.md"), "x");
    const extra = chk();
    assert.notEqual(extra.status, 0);
    assert.match(extra.stderr, /extra\.md/);
    rmSync(join(dir, "extra.md"));
    writeFileSync(join(dir, "notes.txt"), "x");
    const other = chk();
    assert.notEqual(other.status, 0);
    assert.match(other.stderr, /notes\.txt: not a role file/);
    rmSync(join(dir, "notes.txt"));
    rmSync(join(dir, "pr-review.md"));
    const missing = chk();
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /pr-review\.md/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// role_files.py for real: every part of every role, as the relay agent runs them
function relayFor(dir, role) {
  const prog = join(SCRIPTS_SRC, "role_files.py");
  const outs = [];
  let parts = 1;
  for (let k = 0; k < parts; k++) {
    const p = spawnSync("python3", ["-I", prog, dir, role, String(k)], { encoding: "utf8" });
    assert.equal(p.status, 0, p.stderr);
    const o = JSON.parse(p.stdout);
    outs.push({ o, stdout: p.stdout.length });
    parts = o.parts;
  }
  return outs;
}

test("5.0.0 R1 real execution: role_files.py relays every role file; the per-call schema accepts it and the script's own hash equals ROLE_SHA256", async () => {
  const { sha256Hex } = scriptFns();
  // the per-call schema the workflow gives a relay agent
  const out = await runOne(happy(), ARGS);
  const relayCall = out.calls.find((c) => c.label === "infra:role-relay:scope-and-plan");
  assert.ok(relayCall, "a relay agent per role");
  const schema = relayCall.opts.schema;
  assert.deepEqual(schema.required.slice().sort(), ["file_sha256", "program", "reason", "status"]);
  assert.deepEqual(schema.properties.chunks.type, ["array", "null"]);
  assert.deepEqual(schema.properties.role.type, ["string", "null"]);
  let total = 0;
  let maxStdout = 0;
  let relayBytes = 0;
  const report = {};
  for (const role of ROLE_NAMES) {
    const parts = relayFor(ROLES_SRC, role);
    const chunks = parts.flatMap(({ o }) => o.chunks);
    for (const { o, stdout } of parts) {
      assert.equal(o.role, role);
      assert.deepEqual(o.program, { name: "role_files", sha256: programSha("role_files") });
      assert.ok(o.chunks.every((c) => c.length <= 1000));
      assert.ok(stdout < 20000, role + " part " + o.part + " prints " + stdout + " characters (Bash output cap 30000)");
      maxStdout = Math.max(maxStdout, stdout);
    }
    const relay = { status: "ok", reason: "relayed", role, chunks, program: parts[0].o.program, file_sha256: programSha("role_files") };
    assert.deepEqual(validate(schema, relay), [], role);
    const text = chunks.join("");
    assert.equal(sha256Hex(text), PIN[role], role + ": the workflow's sha256Hex of the joined chunks");
    assert.equal(createHash("sha256").update(text, "utf8").digest("hex"), PIN[role], role + ": node crypto cross-check");
    total += readFileSync(join(ROLES_SRC, role + ".md")).length;
    relayBytes += Buffer.byteLength(JSON.stringify(relay), "utf8");
    report[role] = parts.length;
  }
  console.log("role files: " + total + " bytes; relayed results: " + relayBytes + " bytes; largest part stdout: " + maxStdout + " chars; parts: " + JSON.stringify(report));
});

test("5.0.0 R1 real execution: role_files.py fails closed on a missing or extra file, a symlinked dir, a bad role or part", () => {
  const prog = join(SCRIPTS_SRC, "role_files.py");
  const tmp = mkdtempSync(join(tmpdir(), "fleet-roles-py-"));
  const dir = join(tmp, "roles");
  const runp = (d, role, part) => spawnSync("python3", ["-I", prog, d, role || "plan-audit", part || "0"], { encoding: "utf8" });
  try {
    cpSync(ROLES_SRC, dir, { recursive: true });
    assert.equal(runp(dir).status, 0, runp(dir).stderr);
    writeFileSync(join(dir, "extra.md"), "x");
    assert.match(runp(dir).stderr, /extra.*extra\.md/);
    rmSync(join(dir, "extra.md"));
    rmSync(join(dir, "pr-review.md"));
    assert.match(runp(dir).stderr, /missing.*pr-review\.md/);
    writeFileSync(join(dir, "pr-review.md"), ROLE_TEXT["pr-review"]);
    symlinkSync(dir, join(tmp, "link"));
    assert.notEqual(runp(join(tmp, "link")).status, 0, "a symlinked roles dir is refused");
    assert.notEqual(runp(dir, "nope").status, 0, "an unknown role is refused");
    assert.match(runp(dir, "plan-audit", "9").stderr, /out of range/);
    writeFileSync(join(dir, "plan-audit.md"), Buffer.from([0xff, 0xfe]));
    assert.match(runp(dir).stderr, /not UTF-8/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("5.0.0 R1: every role prompt begins with the role file text; no prompt loads a role from yadgar", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  noUnscripted(out);
  for (const c of out.calls) assert.ok(!String(c.prompt).includes("agent_prompt_get"), c.label + " names agent_prompt_get");
  const roleCalls = out.calls.filter((c) => c.label.startsWith("role:"));
  assert.ok(roleCalls.length >= 6);
  // happy runs every role on sonnet: the text is the shipped file with that DISPATCH line
  for (const c of roleCalls) {
    const role = c.label.split(":")[1];
    const text = ROLE_TEXT[role].replace(/^DISPATCH:.*$/m, "DISPATCH: model=sonnet");
    assert.ok(c.prompt.startsWith(text + "\n\n---\n"), c.label + " starts with the role text");
    assert.ok(!/role_version|role_contract/.test(c.prompt.slice(text.length)), c.label);
  }
  // both runs relay all ten roles on sonnet
  for (const o of [out.plan, out.build])
    for (const r of ROLE_NAMES) assert.equal(o.calls.find((c) => c.label === "infra:role-relay:" + r).opts.model, "sonnet", r);
});

test("5.0.0 R1: the shipped DISPATCH lines pick the tiers (no tier is hardcoded)", async () => {
  const s = happy();
  delete s.__dispatch;
  const out = await runOne(s, ARGS);
  const tier = (r) => /^DISPATCH: model=([a-z]+)/m.exec(ROLE_TEXT[r])[1];
  assert.equal(out.calls.find((c) => c.label === "role:scope-and-plan").opts.model, tier("scope-and-plan"));
  assert.ok(out.logs.some((l) => l === "model: plan-audit -> " + tier("plan-audit") + " (fallback opus)"), out.logs.join("\n"));
  assert.ok(out.logs.some((l) => /all 10 role files relayed and hashed/.test(l)));
});

// one corrupted chunk in a relay
const corrupt = (role) => (prompt) => {
  const r = inputsOf(prompt).role;
  const c = roleChunks(ROLE_TEXT[r]);
  if (r === role) c[0] = c[0].replace(/e/, "E");
  return { status: "ok", reason: "relayed", role: r, chunks: c };
};

test("5.0.0 R1: one corrupted chunk -> one retry on sonnet; a clean retry goes on", async () => {
  const s = happy();
  s["infra:role-relay:plan-audit"] = corrupt("plan-audit");
  const out = await runOne(s, ARGS);
  const retry = out.calls.find((c) => c.label === "infra:role-relay:plan-audit:retry");
  assert.ok(retry, "the corrupted role is relayed once more");
  assert.equal(retry.opts.model, "sonnet");
  assert.equal(out.calls.filter((c) => /^infra:role-relay:.*:retry$/.test(c.label)).length, 1, "only the bad role retries");
  assert.ok(out.logs.some((l) => /role file plan-audit: hash mismatch \(relay or tampered\)/.test(l)));
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
});

test("5.0.0 R1: a corrupted chunk twice stops with the reinstall text", async () => {
  const s = happy();
  s["infra:role-relay:plan-audit"] = corrupt("plan-audit");
  s["infra:role-relay:plan-audit:retry"] = corrupt("plan-audit");
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /^role file plan-audit hash mismatch \(relay or tampered\); reinstall fleet 4\.0\.3/);
  assert.equal(out.result.stop_gate, "contract");
  assert.ok(!out.calls.some((c) => c.label === "intake"), "no agent after the stop");
});

test("5.0.0 R1: a role the relay does not return (no result, wrong role, no chunks) stops after one retry", async () => {
  for (const bad of [null, { status: "ok", reason: "x", role: "plan-audit", chunks: roleChunks(ROLE_TEXT["plan-audit"]) }, { status: "ok", reason: "x", role: "pr-review", chunks: [] }]) {
    const s = happy();
    s["infra:role-relay:pr-review"] = bad;
    s["infra:role-relay:pr-review:retry"] = bad;
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human", JSON.stringify(bad));
    assert.match(out.result.reason, /^role file pr-review hash mismatch \(relay or tampered\); reinstall fleet 4\.0\.3 \(relay (returned no result|returned role "plan-audit"|returned no chunks)\)/);
  }
});

test("5.0.0 R1: a relay that did not run the shipped program stops", async () => {
  const s = happy();
  const fake = (prompt) => ({ __raw: true, status: "ok", reason: "x", role: inputsOf(prompt).role, chunks: roleChunks(ROLE_TEXT[inputsOf(prompt).role]), program: { name: "role_files", sha256: "0".repeat(64) }, file_sha256: "0".repeat(64) });
  s["infra:role-relay:coder"] = fake;
  s["infra:role-relay:fleet-coder"] = fake;
  s["infra:role-relay:fleet-coder:retry"] = fake;
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /role file fleet-coder .*did not run the shipped program role_files/);
});

test("5.0.0 R1: the probe pins the roles dir: missing, symlinked, an extra or a changed role file stops before any relay", async () => {
  const cases = [
    [{ hits: [{ hit: SCRIPTS_DIR, roles_real: "" }] }, /roles dir .* resolves to ""/],
    [{ hits: [{ hit: SCRIPTS_DIR, roles_symlink: "yes" }] }, /roles dir .* is a symlink/],
    [{ roleSums: { "x.md": "1".repeat(64) } }, /x\.md is not a shipped role file/],
    [{ roleSums: { "pr-review.md": "1".repeat(64) } }, /pr-review\.md hashes 1{64}/],
    [{ roleSums: { "pr-review.md": undefined } }, /pr-review\.md is missing/],
  ];
  for (const [over, re] of cases) {
    const s = happy();
    s.preflight = { scripts_probe: scriptsProbe(over), scripts_dir: SCRIPTS_DIR };
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human", JSON.stringify(over));
    assert.match(out.result.reason, re);
    assert.ok(!out.calls.some((c) => c.label.startsWith("infra:role-relay:")), "no relay after a probe stop");
  }
  // the probe command lists the roles dir and hashes every file in it
  const out = await runOne(happy(), ARGS);
  assert.match(out.calls[0].prompt, /roles_real=/);
  assert.match(out.calls[0].prompt, /\$\{d%\/scripts\}\/roles\\?"\/\*/);
  assert.ok(out.logs.includes("roles_dir: " + ROLES_DIR));
});

test("5.0.0 R1: a role file with no usable DISPATCH line stops (the pinned text decides the tier)", async () => {
  const s = happy();
  s.__dispatch["fleet-coder"] = null;
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /role fleet-coder has no usable DISPATCH line/);
});

test("5.0.0 R1: a plan ref seals {fleet_version, role_sha256} log-only; build relays the roles again and ignores fresh_preflight", async () => {
  for (const fresh of [undefined, true, false]) {
    const out = await run(shipped(), ARGS, fresh === undefined ? {} : { fresh_preflight: fresh });
    assert.equal(out.result.status, "ok", out.result.reason);
    assert.equal(out.build.calls.filter((c) => /^infra:role-relay:[a-z-]+$/.test(c.label)).length, 10);
    assert.deepEqual(out.result.role_sha256, PIN);
    assert.ok(!out.build.calls.some((c) => c.label === "preflight:roles"));
  }
});

// Rewrites the sealed plan ref in the store (resealed) and returns the tiny ref (as v4_s3).
function reseal(s, tiny, fn) {
  const content = s.__store[tiny.plan_commit];
  const o = JSON.parse(content);
  fn(o);
  delete o.seal;
  o.seal = sha256(canon(o));
  const next = JSON.stringify(o) + (content.endsWith("\n") ? "\n" : "");
  s.__store[tiny.plan_commit] = next;
  return Object.assign({}, tiny, { ref_sha256: sha256(next) });
}

test("5.0.0 R1: plan mode seals history.preflight {fleet_version, role_sha256}, log only", async () => {
  const s = shipped();
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const p = JSON.parse(s.__store[out.result.plan_ref.plan_commit]).history.preflight;
  assert.deepEqual(Object.keys(p).sort(), ["fleet_version", "role_sha256"]);
  assert.equal(p.fleet_version, "4.0.3");
  assert.deepEqual(p.role_sha256, PIN);
});

test("5.0.0 R1: a 4.x plan ref (history.preflight {versions, dispatch, contract}), none, or another version builds with the shipped role files", async () => {
  const old = { fleet_version: "4.0.2", versions: { "plan-audit": 17 }, dispatch: { "plan-audit": "DISPATCH: model=opus" }, contract: { "plan-audit": "CONTRACT: fleet-v4" } };
  for (const fix of [(o) => (o.history.preflight = old), (o) => delete o.history.preflight, (o) => (o.history.preflight = { fleet_version: "4.0.3" })]) {
    const s = happy();
    const plan = await runOne(s, ARGS);
    const tiny = reseal(s, plan.result.plan_ref, fix);
    const b = await runOne(s, { mode: "build", plan_ref: tiny, date: ARGS.date, project: "o/r" });
    noUnscripted(b);
    assert.equal(b.result.status, "ok", b.result.reason);
    // the sealed tier is never used: the scenario's role files decide
    assert.equal(b.calls.find((c) => c.label === "role:fleet-coder:r1").opts.model, "sonnet");
  }
  // a broken record still fails the ref check (the same check in branch_scan.py)
  const s = happy();
  const plan = await runOne(s, ARGS);
  const tiny = reseal(s, plan.result.plan_ref, (o) => (o.history.preflight = { fleet_version: "5.0.0", role_sha256: [] }));
  const b = await runOne(s, { mode: "build", plan_ref: tiny, date: ARGS.date, project: "o/r" });
  assert.equal(b.result.status, "needs_human");
  assert.match(b.result.reason, /history\.preflight\.role_sha256 is not an object/);
});

test("5.0.0 probe mode: preflight only on the given repo; returns the table and stops", async () => {
  const s = shipped();
  const out = await runOne(s, { mode: "probe", repo: "/r", date: ARGS.date });
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.result.mode, "probe");
  assert.deepEqual(out.labels.filter((l) => !l.startsWith("infra:role-relay:")), ["preflight"]);
  assert.equal(out.labels.length, 11);
  const p = out.result.probe;
  assert.equal(p.scripts_dir, SCRIPTS_DIR);
  assert.equal(p.roles_dir, ROLES_DIR);
  for (const r of ROLE_NAMES) {
    assert.equal(p.roles[r].sha256, PIN[r]);
    assert.equal(p.roles[r].model, /^DISPATCH: model=([a-z]+)/m.exec(ROLE_TEXT[r])[1]);
  }
  // no repo: refused before any agent
  const bad = await runOne(happy(), { mode: "probe", date: ARGS.date });
  assert.equal(bad.result.status, "needs_human");
  assert.deepEqual(bad.labels, []);
});

// ---------------------------------------------------------------- JSON schema check (the subset the workflow uses)
function validate(s, v, at = "$", out = []) {
  if (!s || typeof s !== "object") return out;
  if (s.type !== undefined) {
    const t = [].concat(s.type);
    const jt = v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;
    if (!t.includes(jt) && !(jt === "integer" && t.includes("number"))) {
      out.push(at + ": " + jt + " not " + t.join("|"));
      return out;
    }
  }
  if (Array.isArray(s.enum) && !s.enum.includes(v)) out.push(at + ": not in enum");
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const k of s.required || []) if (!(k in v)) out.push(at + "." + k + ": required");
    for (const [k, x] of Object.entries(v)) {
      if (s.properties && k in s.properties) validate(s.properties[k], x, at + "." + k, out);
      else if (s.additionalProperties && typeof s.additionalProperties === "object") validate(s.additionalProperties, x, at + "." + k, out);
    }
  }
  if (Array.isArray(v) && s.items) v.forEach((x, i) => validate(s.items, x, at + "[" + i + "]", out));
  return out;
}
