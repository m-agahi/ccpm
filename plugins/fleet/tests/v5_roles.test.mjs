// fleet 5.0.0 PR-1 (R1, ledger 1999; Max's ruling on PR #46): the role prompts
// ship in the plugin as roles/<role>.md, pinned by ROLE_SHA256, with the same
// trust model as the shipped programs. Preflight pins the roles dir (realpath,
// no symlink, exactly the ten files, each its sha256). Each role agent's first
// action is `sha256sum -- <roles_dir>/<role>.md`, then it reads that file with
// the Read tool (review of d8df90b: never cat) and follows it and returns role_file {name, sha256}; the script checks
// both against the dispatched role and ROLE_SHA256. No prompt carries role
// text, and no prompt loads a yadgar page.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SOURCE, ARGS, happy, run, runOne, spawnSync, inputsOf, ROLE_NAMES, ROLE_TEXT, ROLES_SRC, SCRIPTS_SRC, SCRIPTS_DIR, scriptsProbe, noUnscripted, sha256, canon, PROGRAMS, PREFLIGHT_PROBE } from "./harness.mjs";

// The preflight probe run for real by bash over a plugin cache under a temp
// HOME, its lines fed to the workflow as the preflight agent's relay.
async function realProbe(mutate) {
  const home = mkdtempSync(join(tmpdir(), "fleet-roles-probe-"));
  try {
    const ver = join(home, ".claude", "plugins", "cache", "mkt", "fleet", "6.2.2");
    mkdirSync(join(ver, "scripts"), { recursive: true });
    for (const [n] of PROGRAMS) cpSync(join(SCRIPTS_SRC, n + ".py"), join(ver, "scripts", n + ".py"));
    cpSync(ROLES_SRC, join(ver, "roles"), { recursive: true });
    if (mutate) mutate(join(ver, "roles"));
    const p = spawnSync("bash", ["-c", await PREFLIGHT_PROBE()], { encoding: "utf8", env: Object.assign({}, process.env, { HOME: home }) });
    // 5.0.0 R3: only regular files are hashed; a directory is a roles_odd line
    assert.equal(p.status, 0, p.stderr);
    const s = happy();
    delete s.__dispatch;
    s.preflight = { scripts_probe: p.stdout.split("\n"), scripts_dir: join(ver, "scripts") };
    return await runOne(s, ARGS);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const GEN = await import(join(SCRIPTS_SRC, "gen.mjs"));
const PIN = GEN.roles(SOURCE);
const ROLES_DIR = SCRIPTS_DIR.replace(/\/scripts$/, "/roles");
const fileSha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const firstDispatch = (t) => /^DISPATCH:.*$/m.exec(t)[0];
// the role read command a role prompt carries
const readCmd = (role) => "sha256sum -- '" + ROLES_DIR + "/" + role + ".md'\n2. Read " + ROLES_DIR + "/" + role + ".md with the Read tool";
// a scripted role result with an explicit role_file
const withFile = (r, rf) => Object.assign({}, r, { role_file: rf });

test("5.0.0 R1: eleven role files ship (6.0.0: + fleet-ci-classifier), each pinned by ROLE_SHA256; gen.mjs --check passes", () => {
  // 5.0.0 R3: plus the _shared dir (pinned by SHARED_SHA256; v5_prompts)
  assert.deepEqual(readdirSync(ROLES_SRC).sort(), ROLE_NAMES.map((r) => r + ".md").concat(["_shared"]).sort());
  assert.deepEqual(Object.keys(PIN).sort(), ROLE_NAMES.slice().sort());
  for (const r of ROLE_NAMES) {
    assert.equal(fileSha(join(ROLES_SRC, r + ".md")), PIN[r], r);
    assert.doesNotMatch(ROLE_TEXT[r], /^CONTRACT:/m, r + ": the CONTRACT line is stripped");
    assert.match(ROLE_TEXT[r], /^DISPATCH: model=[a-z]+/m, r + ": the DISPATCH line is kept");
  }
  const ok = spawnSync("node", [join(SCRIPTS_SRC, "gen.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
});

test("5.0.0 R1 real execution: sha256sum of every shipped role file equals ROLE_SHA256", () => {
  const files = ROLE_NAMES.map((r) => join(ROLES_SRC, r + ".md"));
  const p = spawnSync("sha256sum", ["--", ...files], { encoding: "utf8" });
  assert.equal(p.status, 0, p.stderr);
  const got = {};
  for (const line of p.stdout.trim().split("\n")) {
    const m = /^([0-9a-f]{64}) [ *](.+)\/([a-z-]+)\.md$/.exec(line);
    assert.ok(m, line);
    got[m[3]] = m[1];
  }
  assert.deepEqual(got, PIN);
});

test("5.0.0 R1: ROLE_DISPATCH is generated from each file's first DISPATCH line; gen.mjs --check fails on a changed, missing or extra role file", () => {
  const m = /\nconst ROLE_DISPATCH = (\{[\s\S]*?\n\});/.exec(SOURCE);
  assert.ok(m, "ROLE_DISPATCH table");
  const t = JSON.parse(m[1]);
  for (const r of ROLE_NAMES) assert.equal(t[r], firstDispatch(ROLE_TEXT[r]), r);
  const tmp = mkdtempSync(join(tmpdir(), "fleet-roles-gen-"));
  const dir = join(tmp, "roles");
  const wf = join(tmp, "build-task-run.js");
  const chk = () => spawnSync("node", [join(SCRIPTS_SRC, "gen.mjs"), "--check", "--roles", dir, "--workflow", wf], { encoding: "utf8" });
  try {
    cpSync(ROLES_SRC, dir, { recursive: true });
    writeFileSync(wf, SOURCE);
    assert.equal(chk().status, 0, chk().stderr);
    writeFileSync(join(dir, "plan-audit.md"), ROLE_TEXT["plan-audit"].replace(/^DISPATCH: model=[a-z]+/m, "DISPATCH: model=haiku"));
    const changed = chk();
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /plan-audit/);
    writeFileSync(join(dir, "plan-audit.md"), ROLE_TEXT["plan-audit"]);
    writeFileSync(join(dir, "extra.md"), "x");
    assert.match(chk().stderr, /extra\.md/);
    rmSync(join(dir, "extra.md"));
    rmSync(join(dir, "pr-review.md"));
    assert.match(chk().stderr, /pr-review\.md/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("5.0.0 R1: no relay program and no relay agent; a happy run dispatches what 4.0.3 dispatched (plan 17, build 50; 5.0.6: 58)", async () => {
  assert.ok(!existsSync(join(SCRIPTS_SRC, "role_files.py")), "role_files.py is deleted");
  assert.doesNotMatch(SOURCE, /role_files|role-relay|roleRelay/);
  const out = await run(happy(), Object.assign({}, ARGS, { confirm: "ask" }));
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  // 6.0.0 (ledger 2041): + infra:ruleset-surface:plan
  // 6.0.0 (ledger 2042): + infra:pr-convention:plan
  assert.equal(out.plan.calls.length, 19, out.plan.labels.join(", "));
  // 5.0.6 (ledger 2019): + 7 build-dir resets and the teardown
  // 6.0.0 (ledger 2033): + infra:policy
  // 6.0.0 review S6, S7a: + the CI write-back (ledger read and write :ci) and the run-end stats block
  assert.equal(out.build.calls.length, 67, out.build.labels.join(", "));
  for (const c of out.calls) assert.ok(!String(c.prompt).includes("agent_prompt_get"), c.label);
});

test("5.0.0 R1: a role prompt carries the read command, the inputs and the StructuredOutput rule; no role text", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const roleCalls = out.calls.filter((c) => c.label.startsWith("role:"));
  assert.ok(roleCalls.length >= 6);
  for (const c of roleCalls) {
    const role = c.label.split(":")[1];
    assert.ok(c.prompt.includes(readCmd(role)), c.label + " carries the read command");
    assert.ok(!c.prompt.includes(ROLE_TEXT[role].slice(0, 200)), c.label + " carries no role text");
    assert.doesNotMatch(c.prompt, /^## Purpose|^DISPATCH:/m, c.label);
    assert.match(c.prompt, /role_file/);
    assert.match(c.prompt, /StructuredOutput/);
    assert.ok(inputsOf(c.prompt), c.label + " has its inputs");
    // the wrapper is short: only the inputs make a prompt long
    assert.ok(c.prompt.length - JSON.stringify(inputsOf(c.prompt)).length < 2000, c.label + " wrapper length");
  }
});

test("5.0.0 R1: every role schema requires role_file {name, sha256}, object or null", async () => {
  const out = await run(happy(), ARGS);
  for (const c of out.calls.filter((x) => x.label.startsWith("role:"))) {
    const s = c.opts.schema;
    assert.ok(s.required.includes("role_file"), c.label);
    const rf = s.properties.role_file;
    assert.deepEqual([].concat(rf.type).sort(), ["null", "object"], c.label);
    assert.deepEqual(rf.properties.name.type, "string");
    assert.deepEqual(rf.properties.sha256.type, "string");
  }
});

test("5.0.0 R1: a wrong role_file.sha256 stops at contract (after the one contract retry)", async () => {
  const s = happy();
  const bad = withFile(s["role:plan-audit"], { name: "plan-audit", sha256: "0".repeat(64) });
  s["role:plan-audit"] = bad;
  s["role:plan-audit:retry"] = bad;
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "contract");
  assert.match(out.result.reason, /role plan-audit did not run the shipped role file \(role_file sha256 0{64}, not [0-9a-f]{64}\)/);
  assert.ok(out.labels.includes("role:plan-audit:retry"), out.labels.join(", "));
  // a good retry goes on
  const s2 = happy();
  // the retry reports the scenario file's own sha256 (the harness fills it)
  s2["role:plan-audit:retry"] = s2["role:plan-audit"];
  s2["role:plan-audit"] = withFile(s2["role:plan-audit"], { name: "plan-audit", sha256: "0".repeat(64) });
  const ok = await runOne(s2, ARGS);
  assert.notEqual(ok.result.stop_gate, "contract", ok.result.reason);
});

// review of d8df90b, item 6: a not-ok coder with no role_file stops at "role"
test("5.0.0 R1: a missing role_file (null) stops: at contract on ok (after its one retry), at role on a not-ok coder", async () => {
  for (const status of ["ok", "needs_human"]) {
    const s = happy();
    const r = withFile(Object.assign({}, s["role:fleet-coder:r1"], status === "ok" ? {} : { status, reason: "blocked" }), null);
    s["role:fleet-coder:r1"] = r;
    s["role:fleet-coder:r1:retry"] = r;
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "needs_human", status);
    assert.equal(out.result.stop_gate, status === "ok" ? "contract" : "role", status + ": " + out.result.reason);
    assert.match(out.result.reason, /role fleet-coder did not run the shipped role file \(no role_file\)/);
    assert.equal(out.labels.includes("role:fleet-coder:r1:retry"), status === "ok", status + ": the ok coder retries once");
    assert.ok(!out.labels.includes("role:fleet-code-judge:r1"));
  }
});

test("5.0.0 R1: a role_file.name other than the dispatched role stops", async () => {
  const s = happy();
  const bad = withFile(s["role:fleet-test-judge:r1"], { name: "fleet-code-judge", sha256: PIN["fleet-code-judge"] });
  s["role:fleet-test-judge:r1"] = bad;
  s["role:fleet-test-judge:r1:retry"] = bad;
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "contract");
  assert.match(out.result.reason, /role fleet-test-judge did not run the shipped role file \(role_file name "fleet-code-judge"\)/);
});

test("5.0.0 R1: preflight pins the roles dir: a hash mismatch, an extra .md, a missing file, a symlink or a missing dir stops before intake", async () => {
  const cases = [
    [{ roleSums: { "pr-review.md": "1".repeat(64) } }, /pr-review\.md hashes 1{64}/],
    [{ roleSums: { "x.md": "1".repeat(64) } }, /x\.md is not a shipped role file/],
    [{ roleSums: { "pr-review.md": undefined } }, /pr-review\.md is missing/],
    [{ hits: [{ hit: SCRIPTS_DIR, roles_symlink: "yes" }] }, /roles dir .* is a symlink/],
    [{ hits: [{ hit: SCRIPTS_DIR, roles_real: "" }] }, /roles dir .* resolves to ""/],
  ];
  for (const [over, re] of cases) {
    const s = happy();
    s.preflight = { scripts_probe: scriptsProbe(over), scripts_dir: SCRIPTS_DIR };
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human", JSON.stringify(over));
    assert.equal(out.result.stop_gate, "contract");
    assert.match(out.result.reason, re);
    assert.deepEqual(out.labels, ["preflight"]);
  }
});

test("5.0.0 R1: the shipped DISPATCH lines pick the tiers", async () => {
  const s = happy();
  delete s.__dispatch;
  const out = await runOne(s, ARGS);
  const tier = (r) => /^DISPATCH: model=([a-z]+)/m.exec(ROLE_TEXT[r])[1];
  assert.equal(out.calls.find((c) => c.label === "role:scope-and-plan").opts.model, tier("scope-and-plan"));
  assert.ok(out.logs.includes("model: plan-audit -> " + tier("plan-audit") + " (fallback opus)"), out.logs.join("\n"));
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
  const s = happy();
  delete s.__dispatch;
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const p = JSON.parse(s.__store[out.result.plan_ref.plan_commit]).history.preflight;
  assert.deepEqual(Object.keys(p).sort(), ["fleet_version", "role_sha256"]);
  assert.equal(p.fleet_version, "6.2.2");
  assert.deepEqual(p.role_sha256, PIN);
});

test("5.0.0 R1: a 4.x plan ref, none, or another version builds with the shipped role files; a broken record fails", async () => {
  const old = { fleet_version: "4.0.2", versions: { "plan-audit": 17 }, dispatch: { "plan-audit": "DISPATCH: model=opus" }, contract: { "plan-audit": "CONTRACT: fleet-v4" } };
  for (const fix of [(o) => (o.history.preflight = old), (o) => delete o.history.preflight, (o) => (o.history.preflight = { fleet_version: "4.0.3" })]) {
    const s = happy();
    const plan = await runOne(s, ARGS);
    const tiny = reseal(s, plan.result.plan_ref, fix);
    const b = await runOne(s, { mode: "build", plan_ref: tiny, date: ARGS.date, project: "o/r" });
    noUnscripted(b);
    assert.equal(b.result.status, "ok", b.result.reason);
    assert.equal(b.calls.find((c) => c.label === "role:fleet-coder:r1").opts.model, "sonnet");
  }
  const s = happy();
  const plan = await runOne(s, ARGS);
  const tiny = reseal(s, plan.result.plan_ref, (o) => (o.history.preflight = { fleet_version: "5.0.0", role_sha256: [] }));
  const b = await runOne(s, { mode: "build", plan_ref: tiny, date: ARGS.date, project: "o/r" });
  assert.equal(b.result.status, "needs_human");
  assert.match(b.result.reason, /history\.preflight\.role_sha256 is not an object/);
});

test("5.0.0 probe mode: preflight only on the given repo; returns the table and stops", async () => {
  const s = happy();
  delete s.__dispatch;
  const out = await runOne(s, { mode: "probe", repo: "/r", date: ARGS.date });
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.result.mode, "probe");
  // review 3: plus one role-read agent
  assert.deepEqual(out.labels, ["preflight", "infra:role-read:plan-audit"]);
  const p = out.result.probe;
  assert.equal(p.scripts_dir, SCRIPTS_DIR);
  assert.equal(p.roles_dir, ROLES_DIR);
  for (const r of ROLE_NAMES) {
    assert.equal(p.roles[r].sha256, PIN[r]);
    assert.equal(p.roles[r].model, /^DISPATCH: model=([a-z]+)/m.exec(ROLE_TEXT[r])[1]);
  }
  const bad = await runOne(happy(), { mode: "probe", date: ARGS.date });
  assert.equal(bad.result.status, "needs_human");
  assert.deepEqual(bad.labels, []);
});

test("5.0.0 R1 real execution: the probe, run by bash over a real plugin cache, passes the shipped roles and refuses a changed, extra, missing, symlinked or nested entry", async () => {
  const ok = await realProbe();
  assert.equal(ok.result.status, "awaiting_confirmation", ok.result.reason);
  assert.ok(ok.logs.some((l) => /all 11 role files at their ROLE_SHA256 pins/.test(l)));
  const cases = [
    [(d) => writeFileSync(join(d, "plan-audit.md"), ROLE_TEXT["plan-audit"] + "x"), /plan-audit\.md hashes [0-9a-f]{64}, not /],
    [(d) => writeFileSync(join(d, "extra.md"), "x"), /extra\.md is not a shipped role file/],
    [(d) => writeFileSync(join(d, ".hidden"), "x"), /\.hidden is not a shipped role file/],
    [(d) => rmSync(join(d, "pr-review.md")), /pr-review\.md is missing/],
    [(d) => mkdirSync(join(d, "sub")), /not regular files: sub/],
    // 5.0.0 R3: the _shared dir: a changed, extra, missing or nested entry, or a symlinked dir
    [(d) => writeFileSync(join(d, "_shared", "test-cmd-allowlist.md"), "x"), /_shared\/test-cmd-allowlist\.md hashes [0-9a-f]{64}, not /],
    [(d) => writeFileSync(join(d, "_shared", "extra.md"), "x"), /_shared\/extra\.md is not a shipped role file/],
    [(d) => rmSync(join(d, "_shared", "test-cmd-allowlist.md")), /_shared\/test-cmd-allowlist\.md is missing/],
    [(d) => mkdirSync(join(d, "_shared", "deeper")), /not regular files: _shared\/deeper/],
    [
      (d) => {
        cpSync(join(d, "_shared"), join(d, "..", "shared-elsewhere"), { recursive: true });
        rmSync(join(d, "_shared"), { recursive: true });
        symlinkSync(join(d, "..", "shared-elsewhere"), join(d, "_shared"));
      },
      /not regular files: _shared(,|;|$)/,
    ],
    [
      (d) => {
        writeFileSync(join(d, "..", "elsewhere.md"), ROLE_TEXT["fleet-coder"]);
        rmSync(join(d, "fleet-coder.md"));
        symlinkSync(join(d, "..", "elsewhere.md"), join(d, "fleet-coder.md"));
      },
      /not regular files: fleet-coder\.md/,
    ],
  ];
  for (const [mut, re] of cases) {
    const out = await realProbe(mut);
    assert.equal(out.result.status, "needs_human", String(re));
    assert.equal(out.result.stop_gate, "contract");
    assert.match(out.result.reason, re);
    assert.deepEqual(out.labels, ["preflight"]);
  }
});

// ---------------------------------------------------------------- review of d8df90b

const fileOf = (role) => ROLES_DIR + "/" + role + ".md";

// item 1 (HIGH): the Bash tool cuts output near 30000 characters, so `cat` can
// truncate a role file while the sha256sum line still passes. The agent hashes
// with sha256sum in Bash and reads the whole file with the Read tool.
test("review 1: a role prompt hashes with sha256sum, reads the file with the Read tool (no cat), and every role agent type can Read", async () => {
  const out = await run(happy(), ARGS);
  const roleCalls = out.calls.filter((c) => c.label.startsWith("role:"));
  // every role dispatch in the source names fleet:judge or no agent type (the default agent)
  for (const m of SOURCE.matchAll(/callRole\([^;]*?\)/gs)) assert.doesNotMatch(m[0], /WRITER_AGENT|ledger-writer/, m[0]);
  assert.ok(roleCalls.length >= 6);
  const judge = readFileSync(join(SCRIPTS_SRC, "..", "agents", "judge.md"), "utf8");
  const denied = (/^disallowedTools: (.*)$/m.exec(judge) || [, ""])[1].split(",").map((x) => x.trim());
  assert.ok(!denied.includes("Read") && !/^tools:/m.test(judge), "fleet:judge can use Read");
  for (const c of roleCalls) {
    const role = c.label.split(":")[1];
    assert.ok(c.prompt.includes("sha256sum -- '" + fileOf(role) + "'"), c.label);
    assert.doesNotMatch(c.prompt, /&& cat |\bcat '/, c.label + ": no cat");
    assert.ok(c.prompt.includes("Read tool") && c.prompt.includes(fileOf(role)), c.label + ": reads with the Read tool");
    assert.match(c.prompt, /no offset and no limit/, c.label);
    assert.ok([undefined, "fleet:judge"].includes(c.opts.agentType), c.label + " runs as " + c.opts.agentType);
  }
});

function genCheckWith(mutate) {
  const tmp = mkdtempSync(join(tmpdir(), "fleet-roles-gen2-"));
  const dir = join(tmp, "roles");
  const wf = join(tmp, "build-task-run.js");
  try {
    cpSync(ROLES_SRC, dir, { recursive: true });
    mutate(dir);
    // the tables follow the changed files, so only the new checks can fail
    writeFileSync(wf, SOURCE);
    const w = spawnSync("node", [join(SCRIPTS_SRC, "gen.mjs"), "--roles", dir, "--workflow", wf], { encoding: "utf8" });
    const c = spawnSync("node", [join(SCRIPTS_SRC, "gen.mjs"), "--check", "--roles", dir, "--workflow", wf], { encoding: "utf8" });
    return { write: w, check: c };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test("review 1: gen.mjs refuses a role file the Read tool would cut: over 2000 lines, a line over 2000 characters, or over 40000 characters", () => {
  const base = ROLE_TEXT["fleet-pr-opener"];
  for (const [what, text, re] of [
    ["2001 lines", base + "\n".repeat(2001 - base.split("\n").length + 1), /fleet-pr-opener\.md: 20\d\d lines, over 2000/],
    ["a 2001-character line", base + "\n" + "x".repeat(2001), /fleet-pr-opener\.md: line \d+ has 2001 characters, over 2000/],
    ["40001 characters", base + "\n" + ("y".repeat(1000) + "\n").repeat(Math.ceil((40001 - base.length) / 1001)), /fleet-pr-opener\.md: \d+ characters, over 40000/],
  ]) {
    const r = genCheckWith((d) => writeFileSync(join(d, "fleet-pr-opener.md"), text));
    assert.notEqual(r.write.status, 0, what + ": gen refuses to write");
    assert.match(r.write.stderr, re, what);
    assert.notEqual(r.check.status, 0, what);
    assert.match(r.check.stderr, re, what);
  }
  assert.equal(genCheckWith(() => {}).check.status, 0, "the shipped files pass");
});

// item 4 (LOW)
test("review 4: gen.mjs refuses a role file whose DISPATCH line is missing or names an unknown tier", () => {
  for (const [what, fix, re] of [
    ["unknown tier", (t) => t.replace(/^DISPATCH: model=[a-z]+/m, "DISPATCH: model=gpt5"), /plan-audit\.md: no DISPATCH line with a tier in fable, opus, sonnet, haiku/],
    ["deleted line", (t) => t.replace(/^DISPATCH:.*\n/m, ""), /plan-audit\.md: no DISPATCH line with a tier in fable, opus, sonnet, haiku/],
  ]) {
    const r = genCheckWith((d) => writeFileSync(join(d, "plan-audit.md"), fix(ROLE_TEXT["plan-audit"])));
    assert.notEqual(r.write.status, 0, what);
    assert.match(r.write.stderr, re, what);
    assert.notEqual(r.check.status, 0, what);
  }
});

// item 2 (MEDIUM): the role_file rule is repeated after the inputs
test("review 2: the role prompt ends with a reminder to put role_file in the final StructuredOutput", async () => {
  const out = await run(happy(), ARGS);
  for (const c of out.calls.filter((x) => x.label.startsWith("role:"))) {
    const role = c.label.split(":")[1];
    const tail = c.prompt.slice(c.prompt.lastIndexOf("\nInputs: "));
    assert.ok(tail.includes('role_file: {name: "' + role + '", sha256: <the hex sha256sum printed in step 1>}'), c.label);
    assert.match(tail, /even when the role file's output section does not list it/, c.label);
  }
});

test("review 2: a coder whose ONLY problem is role_file is retried once; the good retry goes on", async () => {
  const s = happy();
  s["role:fleet-coder:r1:retry"] = s["role:fleet-coder:r1"];
  s["role:fleet-coder:r1"] = withFile(s["role:fleet-coder:r1"], null);
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  const retry = out.calls.find((c) => c.label === "role:fleet-coder:r1:retry");
  assert.ok(retry, "one retry");
  assert.match(retry.prompt, /Your previous result was refused: role fleet-coder did not run the shipped role file \(no role_file\)/);
  assert.match(retry.prompt, /change no file/);
  // the retry runs before the post-coder hash: its changes are checked too
  assert.ok(out.labels.indexOf("role:fleet-coder:r1:retry") < out.labels.indexOf("hasher:post-coder:r1"));
});

test("review 2: a coder with role_file AND another problem is not retried; it stops", async () => {
  const s = happy();
  const r = withFile(Object.assign({}, s["role:fleet-coder:r1"], { __raw: true, status: "ok", reason: "x" }), { name: "fleet-coder", sha256: "0".repeat(64) });
  delete r.changed_paths;
  s["role:fleet-coder:r1"] = r;
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "contract");
  assert.ok(!out.labels.includes("role:fleet-coder:r1:retry"), out.labels.join(", "));
});

// item 3 (MEDIUM): probe runs one cheap role-read agent the way a role reads
test("review 3: probe dispatches one haiku role-read agent for plan-audit and checks its role_file", async () => {
  const s = happy();
  delete s.__dispatch;
  s["infra:role-read:plan-audit"] = { status: "ok", reason: "read", role_file: { name: "plan-audit", sha256: PIN["plan-audit"] }, shared_file: { name: "test-cmd-allowlist", sha256: GEN.shared(SOURCE)["test-cmd-allowlist"] } }; // PR #48 ruling 3
  const out = await runOne(s, { mode: "probe", repo: "/r", date: ARGS.date });
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.deepEqual(out.labels, ["preflight", "infra:role-read:plan-audit"]);
  const c = out.calls[1];
  assert.equal(c.opts.model, "haiku");
  assert.equal(c.opts.agentType, "fleet:judge");
  assert.ok(c.prompt.includes("sha256sum -- '" + fileOf("plan-audit") + "'") && c.prompt.includes("Read tool"));
  assert.ok(c.opts.schema.required.includes("role_file"));
  assert.deepEqual(out.result.probe.role_read, { role: "plan-audit", sha256: PIN["plan-audit"], ok: true, shared_file: { name: "test-cmd-allowlist", sha256: GEN.shared(SOURCE)["test-cmd-allowlist"], ok: true } }); // PR #48 ruling 3
  for (const bad of [null, { status: "ok", reason: "x", role_file: { name: "plan-audit", sha256: "0".repeat(64) } }, { status: "ok", reason: "x", role_file: null }]) {
    const t = happy();
    delete t.__dispatch;
    t["infra:role-read:plan-audit"] = bad;
    const o = await runOne(t, { mode: "probe", repo: "/r", date: ARGS.date });
    assert.equal(o.result.status, "needs_human", JSON.stringify(bad));
    assert.equal(o.result.stop_gate, "contract");
    assert.match(o.result.reason, /probe: the role-read agent/);
  }
});

// item 5 (LOW)
test("review 5: a sealed role_sha256 that differs from this install's pins is gate-logged; the build goes on", async () => {
  const s = happy();
  const plan = await runOne(s, ARGS);
  const tiny = reseal(s, plan.result.plan_ref, (o) => (o.history.preflight.role_sha256["plan-audit"] = "f".repeat(64)));
  const b = await runOne(s, { mode: "build", plan_ref: tiny, date: ARGS.date, project: "o/r" });
  assert.equal(b.result.status, "ok", b.result.reason);
  assert.ok(b.result.gate_log.some((l) => /^plan ref sealed other role pins than this install's: plan-audit$/.test(l)), b.result.gate_log.join("\n"));
  const same = await run(happy(), ARGS);
  assert.ok(!same.result.gate_log.some((l) => /other role pins/.test(l)));
});
