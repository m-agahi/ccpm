// fleet 4.0.0 stream S1 (ledger 1993): the embedded programs ship as files
// under plugins/fleet/scripts/, agents run them as python3 -I <scripts_dir>/<name>.py,
// each program proves which file ran (its own sha256), and the plan ref is
// written from checked base64 chunks by a commit step and verified by a
// separate read-only step.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, cpSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  spawnSync,
  SOURCE,
  ARGS,
  BRIEF,
  PC,
  PSHA,
  happy,
  run,
  runOne,
  call,
  inputsOf,
  noUnscripted,
  sha256,
  canon,
  HAVE_PY,
  sh,
  gitEnv,
  SCRIPTS_DIR,
  SCRIPTS_SRC,
  PROGRAMS,
  PROGRAM_LABELS,
  programSha,
  programTableSha,
  verifyStub,
  chunkedContentOf,
  redigest,
  scriptsProbe,
  PREFLIGHT_PROBE,
} from "./harness.mjs";

const GEN = join(SCRIPTS_SRC, "gen.mjs");

function at(obj, path) {
  return path ? obj[path] : obj;
}

// ---------------------------------------------------------------- AC-1993-2: the files are the constants

// 4.0.1 (1996): the files are the source; the workflow holds only their sha256
test("4.0.0 1993 AC-2 (4.0.1): every program ships as scripts/<name>.py and the PROGRAM_SHA256 table holds its exact sha256", () => {
  // no program text is embedded any more
  assert.equal((SOURCE.match(/^const ([A-Z_]+_PY) = String\.raw`/gm) || []).length, 0, "no *_PY constant left in the workflow");
  assert.ok(!/_PY_BEGIN|_PY_END/.test(SOURCE), "no *_PY markers left in the workflow");
  // 22 in S1; S4 adds parked (1986); S3 adds push_probe (1985);
  // S5 adds test_db_decl, db_sweep, db_up, db_down (1981); 5.0.3 adds plan_dsn (2010)
  assert.equal(PROGRAMS.length, 29);
  const files = readdirSync(SCRIPTS_SRC).filter((f) => f.endsWith(".py")).sort();
  assert.deepEqual(files, PROGRAMS.map(([n]) => n + ".py").sort(), "no extra and no missing file");
  for (const [name, sha] of PROGRAMS) {
    // byte-exact: the sha256 of the file's bytes, as sha256sum prints it
    assert.equal(createHash("sha256").update(readFileSync(join(SCRIPTS_SRC, name + ".py"))).digest("hex"), sha, name);
    assert.equal(programSha(name), sha, name);
    assert.equal(programTableSha(name), sha, name);
  }
});

test("4.0.0 1993: gen.mjs --check passes on the shipped files and fails on a changed, missing or extra file", () => {
  const ok = spawnSync("node", [GEN, "--check"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  // 4.0.1: a copy of the scripts dir and the workflow; gen writes the table from the files
  const tmp = mkdtempSync(join(tmpdir(), "fleet-gen-"));
  const dir = join(tmp, "scripts");
  const wf = join(tmp, "build-task-run.js");
  const chk = () => spawnSync("node", [GEN, "--check", "--scripts", dir, "--workflow", wf], { encoding: "utf8" });
  const gen = () => spawnSync("node", [GEN, "--scripts", dir, "--workflow", wf], { encoding: "utf8" });
  try {
    mkdirSync(dir);
    for (const [n] of PROGRAMS) cpSync(join(SCRIPTS_SRC, n + ".py"), join(dir, n + ".py"));
    writeFileSync(wf, SOURCE);
    assert.equal(chk().status, 0, chk().stderr);
    const w = gen();
    assert.equal(w.status, 0, w.stderr);
    assert.equal(readFileSync(wf, "utf8"), SOURCE, "gen is deterministic: the shipped table is its output");
    writeFileSync(join(dir, "plan_files.py"), readFileSync(join(dir, "plan_files.py"), "utf8") + "# x\n");
    const changed = chk();
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /plan_files\.py/);
    cpSync(join(SCRIPTS_SRC, "plan_files.py"), join(dir, "plan_files.py"));
    assert.equal(chk().status, 0);
    writeFileSync(join(dir, "extra.py"), "print(1)\n");
    const extra = chk();
    assert.notEqual(extra.status, 0);
    assert.match(extra.stderr, /extra\.py/);
    assert.notEqual(gen().status, 0, "gen refuses a 29th program");
    rmSync(join(dir, "extra.py"));
    rmSync(join(dir, "hasher.py"));
    const missing = chk();
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /hasher\.py/);
    cpSync(join(SCRIPTS_SRC, "hasher.py"), join(dir, "hasher.py"));
    // a tampered table entry fails too
    writeFileSync(wf, SOURCE.replace(PROGRAMS[0][1], "0".repeat(64)));
    const table = chk();
    assert.notEqual(table.status, 0);
    assert.match(table.stderr, new RegExp(PROGRAMS[0][0] + "\\.py"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("4.0.0 1993: FLEET_VERSION is a semver string and the scripts_dir shape names it", () => {
  const m = /^const FLEET_VERSION = "(\d+\.\d+\.\d+)";$/m.exec(SOURCE);
  assert.ok(m, "FLEET_VERSION constant");
  assert.equal(m[1], "5.0.3");
  assert.match(SCRIPTS_DIR, new RegExp("/fleet/" + m[1].replace(/\./g, "\\.") + "/scripts$"));
});

test("4.0.0 1993 / ADR-1174: every shipped program sets RLIMIT_AS and RLIMIT_CPU before anything else and hashes itself after", () => {
  for (const [name] of PROGRAMS) {
    const body = readFileSync(join(SCRIPTS_SRC, name + ".py"), "utf8");
    assert.match(body, /^\n# resource caps \(3\.1\.0\)[^\n]*\n[^\n]*\nimport os as _o, resource as _r\nfor _k, _v in \(\(_r\.RLIMIT_AS, 1 << 30\), \(_r\.RLIMIT_CPU, 300\)\):\n/, name);
    const caps = body.indexOf("RLIMIT_AS");
    const self = body.indexOf("_PROG = {'name'");
    assert.ok(caps > 0 && self > caps, name + ": the self-hash runs after the caps");
    assert.ok(body.indexOf("_PROG") < body.indexOf("\nimport ", body.indexOf("import hashlib as _hl") + 5) || name, name);
  }
});

// ---------------------------------------------------------------- self-hash, for real

test("4.0.0 1993: a shipped program prints its own name and file sha256; a pasted copy prints nulls", { skip: !HAVE_PY }, () => {
  const wt = mkdtempSync(join(tmpdir(), "fleet-self-"));
  try {
    sh(wt, "git", "init", "-q");
    sh(wt, "git", "config", "user.email", "t@example.com");
    sh(wt, "git", "config", "user.name", "t");
    sh(wt, "git", "config", "commit.gpgsign", "false");
    writeFileSync(join(wt, "a.md"), "a\n");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "i");
    const f = join(SCRIPTS_SRC, "plan_files.py");
    const r = spawnSync("python3", ["-I", f, wt], { encoding: "utf8", cwd: tmpdir() });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.deepEqual(o.program, { name: "plan_files", sha256: sha256(readFileSync(f, "utf8")) });
    // the digest covers the program key
    const d = Object.assign({}, o);
    delete d.digest;
    assert.equal(o.digest, sha256(canon(d)));
    const pasted = spawnSync("python3", ["-I", "-c", readFileSync(f, "utf8"), wt], { encoding: "utf8", cwd: tmpdir() });
    assert.equal(pasted.status, 0, pasted.stderr);
    assert.deepEqual(JSON.parse(pasted.stdout).program, { name: null, sha256: null });
    // plan_hash prints JSON now: the sha256 and its program
    const ph = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "plan_hash.py"), wt, "HEAD", "a.md"], { encoding: "utf8", cwd: tmpdir() });
    assert.equal(ph.status, 0, ph.stderr);
    assert.deepEqual(JSON.parse(ph.stdout), { plan_sha256: sha256("a\n"), program: { name: "plan_hash", sha256: programSha("plan_hash") } });
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- AC-1993-1: no prompt pastes a program

test("4.0.0 1993 AC-1: no prompt of a plan and build run carries python3 -I -c or a FLEET_ heredoc; programs run from scripts_dir", async () => {
  const out = await run(happy(), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  let programs = 0;
  for (const c of out.calls) {
    assert.ok(!c.prompt.includes("python3 -I -c"), c.label + " pastes a program");
    assert.ok(!c.prompt.includes("<<'FLEET_"), c.label + " carries a heredoc");
    assert.ok(!c.prompt.includes("python3 -I -"), c.label + " pipes a program");
    const runs = c.prompt.match(/python3 -I '([^']+)\.py'/g) || [];
    for (const x of runs) {
      programs++;
      const p = /python3 -I '([^']+)\.py'/.exec(x)[1];
      assert.ok(p.startsWith(SCRIPTS_DIR + "/"), c.label + ": " + p);
      assert.ok(PROGRAMS.some(([n]) => p === SCRIPTS_DIR + "/" + n), c.label + ": " + p);
    }
  }
  assert.ok(programs >= 15, "programs run: " + programs);
});

// ---------------------------------------------------------------- AC-1993-3: the self-hash is checked

test("4.0.0 1993 AC-3: a relayed plan_files program sha256 of zeros, or no program key, halts", async () => {
  for (const mut of [(o) => (o.program = { name: "plan_files", sha256: "0".repeat(64) }), (o) => delete o.program]) {
    const s = happy();
    // after the harness filled the shipped program's self-hash, on every attempt
    s.__mutate = { label: "infra:verify-plan-commit", fn: (r) => (mut(r.plan_files), r) };
    const out = await runOne(s, ARGS);
    assert.notEqual(out.result.status, "awaiting_confirmation");
    assert.match(out.result.reason, /did not run the shipped program plan_files/);
    assert.equal(out.result.stop_gate, "commit");
  }
});

// 4.0.0 (1990, S3): a PATH check whose relay is broken runs once more on
// sonnet; a mutation of the check's result applies to that retry too.
function relayRetried(label) {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (/^infra:path-check:/.test(label)) return new RegExp("^" + esc + "(:relay-retry)?$");
  return label;
}

test("4.0.0 1993: a wrong program at every program-running step stops the run (table over the labels)", async () => {
  const full = await run(happy(), ARGS);
  assert.equal(full.result.status, "ok", full.result.reason);
  const seen = new Set();
  const cases = [];
  for (const c of full.calls) {
    for (const [re, slots] of PROGRAM_LABELS) {
      if (!re.test(c.label)) continue;
      for (const [path, name] of slots) {
        const key = c.label + "|" + path;
        if (seen.has(key)) continue;
        seen.add(key);
        cases.push([c.label, path, name]);
      }
    }
  }
  assert.ok(cases.length >= 20, "cases " + cases.length);
  // the steps a plain plan and build does not run: the caller grep and, under
  // confirm auto, the pre-commit hook ids
  for (const [label, path, name, mk, args] of [
    ["infra:callers", null, "callers", callersScript, ARGS],
    ["infra:precommit-ids", null, "precommit_ids", precommitScript, { ...ARGS, confirm: "auto" }],
  ]) {
    const ok = await run(mk(), args);
    assert.equal(ok.result.status, "ok", label + ": " + ok.result.reason);
    assert.ok(ok.labels.includes(label), label);
    cases.push([label, path, name, mk, args]);
  }
  for (const [label, path, name, mk, args] of cases) {
    const s = (mk || happy)();
    const orig = s[label];
    // after the harness filled the program: a wrong self-hash under a digest
    // that still matches, so only the program check can stop it
    s.__mutate = { label: relayRetried(label), fn: (r, prompt) => {
      const o = at(r, path);
      if (o && typeof o === "object") o.program = { name, sha256: "0".repeat(64) };
      return redigest(label, r, prompt);
    } };
    if (orig === undefined) delete s[label];
    const out = await run(s, args || ARGS);
    const okish = out.result && (out.result.status === "ok" || out.result.status === "awaiting_confirmation");
    if (/^workspace$/.test(label)) {
      // the origin URL relay is soft: unusable, so the IaC push gate refuses later
      assert.ok(out.logs.some((l) => /origin URL relay unusable/.test(l)), label);
      continue;
    }
    if (/^infra:push-probe$/.test(label)) {
      // 4.0.0 (1985, S3): the push-access probe is soft: no access verdict, never a stop
      assert.ok(okish, label + ": " + out.result.reason);
      assert.ok(out.plan.result.gate_log.some((l) => /^push access unknown: infra:push-probe: did not run the shipped program push_probe/.test(l)), label);
      continue;
    }
    if (/^infra:load-parked$/.test(label)) {
      // 4.0.0 (1986, S4): the parked-run read is soft: its data is ignored, never used
      assert.ok(out.logs.some((l) => /parked draft ignored \(did not run the shipped program parked/.test(l)), label);
      continue;
    }
    assert.ok(!okish, label + " " + (path || "") + " (" + name + "): a zero program sha256 did not stop the run");
  }
});

// A plan whose changed symbol has callers: the caller grep runs.
function callersScript() {
  const s = happy();
  s["role:scope-and-plan"].changed_symbols = [{ symbol: "guard_verdict", occurrences: [{ at: "chart/guards.py:10", criterion: "AC1", dont_care: null }] }];
  s["infra:callers"] = { status: "ok", reason: "grepped", occurrences: { guard_verdict: ["chart/guards.py:10"] }, capped: [] };
  return s;
}
// confirm auto with a pre-commit check_cmd: the hook ids are read.
function precommitScript() {
  const s = happy();
  Object.assign(s, {
    "hasher:pre-intent": { status: "ok", fingerprint: { head: PC, tree: "P0" } },
    "role:fleet-intent-judge": {
      status: "ok",
      reason: "matches the task",
      verdict: "approve",
      deviations: [{ item: "adds f()", allowed_by: "task body: 'add f'", source_ref: "L42", fails_closed: true, verdict: "approve", reason: "asked for" }],
      coverage: { covered: true, missing: [] },
    },
    "hasher:fp-post:intent": { status: "ok", fingerprint: { head: PC, tree: "P0" } },
    "infra:precommit-ids": { status: "ok", reason: "read", present: true, ids: ["prettier", "check-json"], parser: "yaml" },
  });
  s["role:scope-and-plan"] = Object.assign({}, s["role:scope-and-plan"], { repo_obligations: [{ id: "fmt", kind: "other", instruction: "format", check_cmd: "pre-commit run prettier --all-files" }] });
  s["role:fleet-code-judge:r1"] = Object.assign({}, s["role:fleet-code-judge:r1"], { obligations_check: [{ id: "fmt", met: true, evidence: "ran", check_exit: 0 }] });
  return s;
}

// ---------------------------------------------------------------- AC-1993-4: scripts_dir per run, shape-checked

test("4.0.0 1993 AC-4: a scripts_dir outside the plugin cache halts at the first agent with stop_gate contract", async () => {
  const bad = [
    ["/tmp/x", ["/tmp/x"]],
    ["fleet/5.0.3/scripts", ["fleet/5.0.3/scripts"]],
    ["/home/u/.claude/plugins/cache/m/fleet/3.1.3/scripts", ["/home/u/.claude/plugins/cache/m/fleet/3.1.3/scripts"]],
    ["/home/u/../x/fleet/5.0.3/scripts", ["/home/u/../x/fleet/5.0.3/scripts"]],
    ["/home/u//fleet/5.0.3/scripts", ["/home/u//fleet/5.0.3/scripts"]],
    ["/home/u/a b/fleet/5.0.3/scripts", ["/home/u/a b/fleet/5.0.3/scripts"]],
    // security review: exactly $HOME/.claude/plugins/cache/<marketplace>/fleet/<version>/scripts
    ["/home/u/x/fleet/5.0.3/scripts", ["/home/u/x/fleet/5.0.3/scripts"]],
    ["/home/v/.claude/plugins/cache/m/fleet/5.0.3/scripts", ["/home/v/.claude/plugins/cache/m/fleet/5.0.3/scripts"]],
    ["/home/u/.claude/plugins/cache/a/b/fleet/5.0.3/scripts", ["/home/u/.claude/plugins/cache/a/b/fleet/5.0.3/scripts"]],
    ["/home/u/.claude/plugins/cache/../fleet/5.0.3/scripts", ["/home/u/.claude/plugins/cache/../fleet/5.0.3/scripts"]],
    ["/home/u/.claude/plugins/cache/.x/fleet/5.0.3/scripts", ["/home/u/.claude/plugins/cache/.x/fleet/5.0.3/scripts"]],
    // two hits: never guess
    [SCRIPTS_DIR, [SCRIPTS_DIR, "/home/v/.claude/plugins/cache/n/fleet/5.0.3/scripts"]],
    // no hit
    [null, []],
    // the directory used is not the hit
    ["/home/v/.claude/plugins/cache/n/fleet/5.0.3/scripts", [SCRIPTS_DIR]],
  ];
  for (const [dir, hits] of bad) {
    const s = happy();
    s.preflight = Object.assign({}, s.preflight, { scripts_dir: dir, scripts_probe: scriptsProbe({ hits: hits.map((h) => ({ hit: h })) }) });
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human", JSON.stringify(dir));
    assert.equal(out.result.stop_gate, "contract", JSON.stringify(dir));
    assert.match(out.result.reason, /scripts_dir/);
    assert.deepEqual(out.labels, ["preflight"], JSON.stringify(dir));
  }
});

test("4.0.0 1993 AC-4: every run resolves scripts_dir in its own first agent; nothing is cached or sealed", async () => {
  const s = happy();
  const first = await runOne(s, ARGS);
  assert.equal(first.result.status, "awaiting_confirmation", first.result.reason);
  const second = await runOne(s, ARGS);
  assert.equal(second.result.status, "awaiting_confirmation", second.result.reason);
  for (const o of [first, second]) {
    assert.equal(o.labels[0], "preflight");
    assert.ok(o.calls[0].prompt.includes('for d in "$HOME"/.claude/plugins/cache/*/fleet/5.0.3/scripts;'));
    assert.ok(o.calls[0].prompt.includes("sha256sum -- <scripts_dir>/path_check.py && python3 -I <scripts_dir>/path_check.py"));
  }
  const ref = s.__store[PC];
  assert.ok(typeof ref === "string" && ref.length > 0);
  assert.ok(!ref.includes("scripts"), "the sealed ref names no scripts path");
  // build mode resolves it again in its own first agent
  const b = await run(happy(), ARGS);
  assert.equal(b.build.labels[0], "preflight");
  assert.match(b.build.calls[0].prompt, /fleet\/5\.0\.3\/scripts/);
});

test("4.0.0 1993 AC-4: a path_check run from another directory (wrong self-hash) halts at preflight", async () => {
  const s = happy();
  s.__mutate = { label: "preflight", fn: (r) => ((r.path_check.program = { name: "path_check", sha256: "1".repeat(64) }), r) };
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /did not run the shipped program path_check/);
  assert.deepEqual(out.labels, ["preflight"]);
});

// ---------------------------------------------------------------- AC-1993-5: commit, then a read-only verify that retries once

test("4.0.0 1993: commit-plan writes the ref from chunks; verify-plan-commit is a separate read-only step", async () => {
  const s = happy();
  const out = await runOne(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const i = out.labels.indexOf("infra:commit-plan");
  assert.equal(out.labels[i + 1], "infra:verify-plan-commit");
  const v = call(out, "infra:verify-plan-commit");
  assert.equal(v.opts.agentType, "fleet:judge");
  for (const n of ["plan_files", "plan_hash", "plan_ref"]) assert.ok(v.prompt.includes(SCRIPTS_DIR + "/" + n + ".py"), n);
  assert.ok(!/git -C [^\n]* commit/.test(v.prompt), "the verify step commits nothing");
  const cp = call(out, "infra:commit-plan").prompt;
  assert.ok(cp.includes(SCRIPTS_DIR + "/plan_ref_write.py"));
  // the chunks decode to the sealed ref's tag message
  const content = chunkedContentOf(cp);
  assert.equal(content, s.__store[PC]);
  assert.equal(JSON.parse(content).task_id, "l42");
  assert.equal(out.result.plan_ref.ref_sha256, sha256(content));
  // at most 4000 base64 chars per chunk, each listed with its sha256
  const chunks = [...cp.matchAll(/^chunk (\d+) sha256 ([0-9a-f]{64}):\n([A-Za-z0-9+/=]+)$/gm)];
  assert.ok(chunks.length >= 1);
  for (const m of chunks) {
    assert.ok(m[3].length <= 4000);
    assert.equal(sha256(m[3]), m[2]);
  }
  assert.match(cp, /exit 3/i);
  assert.match(cp, /at most 2/);
});

test("4.0.0 1993 AC-5: a verify relay with a bad digest is retried once; the run reaches awaiting_confirmation", async () => {
  const s = happy();
  const base = s["infra:verify-plan-commit"];
  let n = 0;
  s["infra:verify-plan-commit"] = (prompt) => {
    const r = base(prompt);
    if (n++ === 0) r.plan_files.digest = "0".repeat(64);
    return r;
  };
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.ok(out.result.plan_ref && out.result.plan_ref.plan_commit === PC);
  assert.ok(out.result.gate_log.some((l) => /^verify-plan-commit: retried once/.test(l)), out.result.gate_log.join("\n"));
  assert.equal(out.labels.filter((l) => l === "infra:verify-plan-commit").length, 2);
  assert.equal(out.labels.filter((l) => l === "infra:commit-plan").length, 1, "the commit step is never retried");
});

test("4.0.0 1993: a verify relay that fails twice halts stop_gate commit with the unverified plan_ref", async () => {
  // a step that says failed although its programs printed a good result, and
  // a step whose plan-ref list is gone
  for (const fn of [(r) => Object.assign(r, { status: "failed", reason: "flaky" }), (r) => ((r.plan_ref.refs = null), r)]) {
    const s = happy();
    s.__mutate = { label: "infra:verify-plan-commit", fn };
    const out = await runOne(s, ARGS);
    assert.equal(out.result.stop_gate, "commit");
    assert.equal(out.result.plan_ref_verified, false);
    assert.equal(out.labels.filter((l) => l === "infra:verify-plan-commit").length, 2);
  }
  const s = happy();
  const base = s["infra:verify-plan-commit"];
  s["infra:verify-plan-commit"] = (prompt) => Object.assign(base(prompt), { status: "failed", reason: "flaky" });
  const out = await runOne(s, ARGS);
  assert.equal(out.result.stop_gate, "commit");
  assert.notEqual(out.result.status, "awaiting_confirmation");
  assert.equal(out.result.plan_ref_verified, false);
  assert.equal(out.result.plan_ref.plan_commit, PC);
  assert.match(out.result.reason, /unverified/);
  assert.equal(out.labels.filter((l) => l === "infra:verify-plan-commit").length, 2);
});

test("4.0.0 1993: a verify result that names other files, another plan hash or another ref halts at once (no retry)", async () => {
  const cases = [
    [(r) => (r.plan_files.files = ["docs/plans/x.md", "src/evil.py"]), /not exactly docs\/plans\/x\.md/],
    [(r) => (r.plan_hash.plan_sha256 = "e".repeat(64)), /the committed plan hashes/],
    [(r) => (r.plan_ref.refs = []), /differs from the sealed ref/],
    [(r) => (r.plan_files.head = "9".repeat(40)), /head/],
    [(r) => (r.plan_ref.refs[0].tag_sha = "8".repeat(40)), /is not the one written/],
  ];
  for (const [mut, re] of cases) {
    const s = happy();
    const base = s["infra:verify-plan-commit"];
    // a wrong fact the programs printed (the harness digests it as printed)
    s["infra:verify-plan-commit"] = (prompt) => {
      const r = base(prompt);
      mut(r);
      return r;
    };
    const out = await runOne(s, ARGS);
    assert.notEqual(out.result.status, "awaiting_confirmation", String(re));
    assert.match(out.result.reason, re);
    assert.equal(out.labels.filter((l) => l === "infra:verify-plan-commit").length, 1, String(re));
    assert.ok(!("plan_ref" in out.result) || out.result.plan_ref_verified === false, String(re));
  }
});

test("4.0.0 1993: a commit step with no usable ref write stops before any verify (no plan_ref)", async () => {
  for (const mut of [(r) => (r.digest = "0".repeat(64)), (r) => (r.program = { name: "plan_ref_write", sha256: "0".repeat(64) }), (r) => delete r.tag_sha]) {
    const s = happy();
    s.__mutate = { label: "infra:commit-plan", fn: (r) => (mut(r), r) };
    const out = await runOne(s, ARGS);
    assert.notEqual(out.result.status, "awaiting_confirmation");
    assert.ok(!out.labels.includes("infra:verify-plan-commit"));
    assert.ok(!("plan_ref" in out.result));
  }
});

// ---------------------------------------------------------------- AC-1993-6: the chunk writer, for real

function chunkRepo() {
  const home = mkdtempSync(join(tmpdir(), "fleet-chunks-"));
  const wt = join(home, "main");
  const cfg = join(home, "gitconfig");
  writeFileSync(cfg, "[user]\n\temail = t@example.com\n\tname = t\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = master\n");
  const env = gitEnv(home, cfg);
  const g = (...a) => {
    const r = spawnSync("git", ["-C", wt].concat(a), { encoding: "utf8", env });
    if (r.status !== 0) throw new Error("git " + a.join(" ") + ": " + r.stderr);
    return r.stdout;
  };
  spawnSync("git", ["init", "-q", wt], { env });
  writeFileSync(join(wt, "a.md"), "a\n");
  g("add", "-A");
  g("commit", "-qm", "i");
  mkdirSync(join(home, "scratch"));
  return { home, wt, env, g };
}

function writeChunks(dir, b64, size) {
  mkdirSync(dir, { recursive: true });
  const shas = [];
  for (let i = 0, k = 0; i < b64.length; i += size, k++) {
    writeFileSync(join(dir, k + ".b64"), b64.slice(i, i + size));
    shas.push({ i: k, sha256: sha256(b64.slice(i, i + size)) });
  }
  return shas;
}

test("4.0.0 1993 AC-6: one flipped char in chunk 2 exits 3 with bad_chunks [2] and writes no ref; fixed chunks write it", { skip: !HAVE_PY }, () => {
  const { home, wt, env, g } = chunkRepo();
  try {
    const msg = JSON.stringify({ task_id: "l42", note: "it's \"quoted\" — ünï 🚀", pad: "x".repeat(300) }) + "\n";
    const b64 = Buffer.from(msg, "utf8").toString("base64");
    const dir = join(home, "scratch", "plan-ref-n1");
    const shas = writeChunks(dir, b64, 100);
    assert.ok(shas.length >= 3);
    const c2 = readFileSync(join(dir, "2.b64"), "utf8");
    writeFileSync(join(dir, "2.b64"), (c2[0] === "A" ? "B" : "A") + c2.slice(1));
    const prog = join(SCRIPTS_SRC, "plan_ref_write.py");
    const argv = ["-I", prog, wt, "l42", dir, String(shas.length), sha256(msg), JSON.stringify(shas)];
    const bad = spawnSync("python3", argv, { encoding: "utf8", env, cwd: home });
    assert.equal(bad.status, 3, bad.stderr);
    assert.deepEqual(JSON.parse(bad.stdout), { bad_chunks: [2] });
    assert.equal(g("for-each-ref", "refs/fleet/"), "");
    writeFileSync(join(dir, "2.b64"), c2);
    const ok = spawnSync("python3", argv, { encoding: "utf8", env, cwd: home });
    assert.equal(ok.status, 0, ok.stderr);
    const o = JSON.parse(ok.stdout);
    const head = g("rev-parse", "HEAD").trim();
    assert.equal(o.head, head);
    assert.equal(g("rev-parse", "refs/fleet/l42/plan").trim(), o.tag_sha);
    assert.deepEqual(o.program, { name: "plan_ref_write", sha256: programSha("plan_ref_write") });
    const d = Object.assign({}, o);
    delete d.digest;
    assert.equal(o.digest, sha256(canon(d)));
    const raw = g("cat-file", "tag", o.tag_sha);
    assert.equal(raw.slice(raw.indexOf("\n\n") + 2), msg);
    assert.equal(raw.split("\n")[0], "object " + head);
    assert.ok(!existsSync(dir), "the chunk dir is removed after a success");
    // a second, different ref keeps the first as plan-1
    const msg2 = msg.replace("l42", "l42 ");
    const b2 = Buffer.from(msg2, "utf8").toString("base64");
    const shas2 = writeChunks(dir, b2, 4000);
    const ok2 = spawnSync("python3", ["-I", prog, wt, "l42", dir, String(shas2.length), sha256(msg2), JSON.stringify(shas2)], { encoding: "utf8", env, cwd: home });
    assert.equal(ok2.status, 0, ok2.stderr);
    assert.equal(g("rev-parse", "refs/fleet/l42/plan-1").trim(), o.tag_sha);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("4.0.0 1993: the chunk writer refuses a chunk dir outside the scratch dir, a wrong total and a bad sha list", { skip: !HAVE_PY }, () => {
  const { home, wt, env, g } = chunkRepo();
  try {
    const msg = '{"a":1}\n';
    const b64 = Buffer.from(msg).toString("base64");
    const prog = join(SCRIPTS_SRC, "plan_ref_write.py");
    const outside = join(home, "elsewhere");
    let shas = writeChunks(outside, b64, 4000);
    let r = spawnSync("python3", ["-I", prog, wt, "l42", outside, "1", sha256(msg), JSON.stringify(shas)], { encoding: "utf8", env, cwd: home });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not under/);
    const dir = join(home, "scratch", "c");
    shas = writeChunks(dir, b64, 4000);
    r = spawnSync("python3", ["-I", prog, wt, "l42", dir, "1", sha256("other"), JSON.stringify(shas)], { encoding: "utf8", env, cwd: home });
    assert.notEqual(r.status, 0);
    assert.notEqual(r.status, 3);
    assert.match(r.stderr, /decoded message hashes/);
    r = spawnSync("python3", ["-I", prog, wt, "l42", dir, "2", sha256(msg), JSON.stringify(shas)], { encoding: "utf8", env, cwd: home });
    assert.notEqual(r.status, 0);
    r = spawnSync("python3", ["-I", prog, wt, "../x", dir, "1", sha256(msg), JSON.stringify(shas)], { encoding: "utf8", env, cwd: home });
    assert.notEqual(r.status, 0);
    assert.equal(g("for-each-ref", "refs/fleet/"), "");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("4.0.0 1993: the run-state writer writes from chunks and the reader reads it back", { skip: !HAVE_PY }, () => {
  const { home, wt, env, g } = chunkRepo();
  try {
    const st = { plan_commit: "abc", last_gate: "committed", note: "it's \"quoted\" — ü" };
    const msg = JSON.stringify(st) + "\n";
    const dir = join(home, "scratch", "state-x");
    const shas = writeChunks(dir, Buffer.from(msg, "utf8").toString("base64"), 4000);
    const w = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "state_write.py"), wt, "refs/fleet/l42/state", dir, String(shas.length), sha256(msg), JSON.stringify(shas)], { encoding: "utf8", env, cwd: home });
    assert.equal(w.status, 0, w.stderr);
    const o = JSON.parse(w.stdout);
    assert.equal(o.state_sha, g("rev-parse", "refs/fleet/l42/state").trim());
    assert.deepEqual(o.program, { name: "state_write", sha256: programSha("state_write") });
    const rr = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "read_state.py"), wt, "refs/fleet/l42/state"], { encoding: "utf8", env, cwd: home });
    assert.equal(rr.status, 0, rr.stderr);
    assert.deepEqual(JSON.parse(JSON.parse(rr.stdout).message), st);
    // a ref outside refs/fleet/<task>/state is refused before anything is read
    const shas2 = writeChunks(dir, Buffer.from(msg, "utf8").toString("base64"), 4000);
    const before = g("rev-parse", "refs/heads/master").trim();
    const bad = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "state_write.py"), wt, "refs/heads/master", dir, String(shas2.length), sha256(msg), JSON.stringify(shas2)], { encoding: "utf8", env, cwd: home });
    assert.notEqual(bad.status, 0);
    assert.notEqual(bad.status, 3);
    assert.match(bad.stderr, /bad state ref/);
    assert.equal(g("rev-parse", "refs/heads/master").trim(), before);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("4.0.0 1993: the run-state write step carries its JSON as checked chunks, run by state_write.py", async () => {
  const states = [];
  const s = happy();
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const w = call(out, "infra:state:committed:r1").prompt;
  assert.ok(w.includes(SCRIPTS_DIR + "/state_write.py"));
  const st = JSON.parse(chunkedContentOf(w));
  assert.equal(st.last_gate, "committed");
  states.push(st);
  assert.equal(states.length, 1);
});

// ---------------------------------------------------------------- 4.0.0 security review: a persistent tamper surface is detected

test("4.0.0 security 1: scripts_dir must be its own realpath and no symlink; the probe hashes must be the shipped programs", async () => {
  const cases = [
    [{ hits: [{ hit: SCRIPTS_DIR, real: "/srv/elsewhere/scripts" }] }, /resolves to/],
    [{ hits: [{ hit: SCRIPTS_DIR, real: null }] }, /resolves to/],
    [{ hits: [{ hit: SCRIPTS_DIR, symlink: "yes" }] }, /is a symlink/],
    [{ home: "/home/u/../v" }, /HOME/],
    [{ sums: { plan_files: "0".repeat(64) } }, /plan_files\.py hashes 0{64}/],
    [{ sums: { hasher: undefined } }, /hasher\.py is missing/],
    [{ sums: { evil: "1".repeat(64) } }, /evil\.py is not a shipped program/],
    [{ extra: ["2".repeat(64) + "  /tmp/plan_files.py"] }, /outside/],
  ];
  for (const [over, re] of cases) {
    const s = happy();
    s.preflight = Object.assign({}, s.preflight, { scripts_probe: scriptsProbe(over) });
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human", JSON.stringify(over));
    assert.equal(out.result.stop_gate, "contract", JSON.stringify(over));
    assert.match(out.result.reason, re, JSON.stringify(over));
    assert.deepEqual(out.labels, ["preflight"]);
  }
  // the probe is one bash command: realpath, the symlink test and sha256sum of every program
  const p = call(await runOne(happy(), ARGS), "preflight").prompt;
  for (const w of ["realpath -e --", '[ -L "$d" ]', 'sha256sum -- "$d"/*.py', "shopt -s nullglob", "scripts_probe"]) assert.ok(p.includes(w), w);
});

test("4.0.0 security 1: the probe command, run for real, reports a symlinked scripts dir and the program hashes", { skip: !HAVE_PY }, async () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-probe-"));
  try {
    const real = join(home, ".claude", "plugins", "cache", "mkt", "fleet", "5.0.3", "scripts");
    mkdirSync(real, { recursive: true });
    for (const [n] of PROGRAMS) cpSync(join(SCRIPTS_SRC, n + ".py"), join(real, n + ".py"));
    const cmd = await PREFLIGHT_PROBE();
    const run1 = () => {
      const r = spawnSync("bash", ["-c", cmd], { encoding: "utf8", env: Object.assign({}, process.env, { HOME: home }) });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.split("\n");
    };
    let lines = run1();
    assert.ok(lines.includes("hit=" + real) && lines.includes("real=" + real) && lines.includes("symlink=no"), lines.join("\n"));
    for (const [n] of PROGRAMS) assert.ok(lines.includes(programSha(n) + "  " + real + "/" + n + ".py"), n);
    // the version dir replaced by a symlink to a copy elsewhere
    const other = join(home, "other");
    cpSync(join(home, ".claude", "plugins", "cache", "mkt", "fleet", "5.0.3"), other, { recursive: true });
    rmSync(join(home, ".claude", "plugins", "cache", "mkt", "fleet", "5.0.3"), { recursive: true });
    symlinkSync(other, join(home, ".claude", "plugins", "cache", "mkt", "fleet", "5.0.3"));
    lines = run1();
    assert.ok(lines.includes("real=" + join(other, "scripts")), lines.join("\n"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("4.0.0 security 2: every fingerprint hashes the shipped programs; a change by a role halts naming the file", async () => {
  const all = Object.fromEntries(PROGRAMS.map(([n]) => [n, programSha(n)]));
  for (const label of ["hasher:pre-writers:r1", "hasher:post-writers:r1", "hasher:freeze:f1", "hasher:post-coder:r1", "hasher:fp-post:code-judge:r1"]) {
    const s = happy();
    const base = s[label];
    s[label] = (prompt, opts) => Object.assign({}, typeof base === "function" ? base(prompt, opts) : base, { scripts: Object.assign({}, all, { plan_ref_write: "f".repeat(64) }) });
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "needs_human", label);
    assert.equal(out.result.stop_gate, "hash", label);
    assert.match(out.result.reason, new RegExp("hasher " + label + ": the shipped fleet programs were changed: " + SCRIPTS_DIR.replace(/\./g, "\\.") + "/plan_ref_write\\.py hashes f{64}"), label);
  }
  // every program must be present and match; an unknown extra or the overflow sentinel is refused
  const missingOne = Object.assign({}, all);
  delete missingOne.state_write;
  for (const scripts of [null, {}, missingOne, Object.assign({}, all, { extra: "1".repeat(64) }), Object.assign({}, all, { __too_many_programs__: null })]) {
    const s = happy();
    s["hasher:pre-writers:r1"] = Object.assign({}, s["hasher:pre-writers:r1"], { scripts });
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "needs_human", JSON.stringify(scripts));
    assert.equal(out.result.stop_gate, "hash");
  }
});

test("4.0.0 security 2: the shipped hasher hashes every program beside it; a tampered copy shows", { skip: !HAVE_PY }, () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-hscripts-"));
  try {
    const dir = join(home, "scripts");
    mkdirSync(dir);
    for (const [n] of PROGRAMS) cpSync(join(SCRIPTS_SRC, n + ".py"), join(dir, n + ".py"));
    const wt = join(home, "wt");
    sh(home, "git", "init", "-q", wt);
    sh(wt, "git", "config", "user.email", "t@example.com");
    sh(wt, "git", "config", "user.name", "t");
    sh(wt, "git", "config", "commit.gpgsign", "false");
    writeFileSync(join(wt, "a.py"), "a\n");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "i");
    const hash = () => {
      const r = spawnSync("python3", ["-I", join(dir, "hasher.py"), wt, "[]"], { encoding: "utf8", cwd: home });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    let o = hash();
    assert.deepEqual(o.scripts, Object.fromEntries(PROGRAMS.map(([n]) => [n, programSha(n)])));
    const d = Object.assign({}, o);
    delete d.digest;
    assert.equal(o.digest, sha256(canon(d)), "the digest covers the scripts map");
    // padding the dir with other files never pushes a program out of the hashed set
    for (let i = 0; i < 250; i++) writeFileSync(join(dir, "a" + String(i).padStart(3, "0") + ".txt"), "x");
    o = hash();
    assert.deepEqual(o.scripts, Object.fromEntries(PROGRAMS.map(([n]) => [n, programSha(n)])), "padding with non-.py files");
    // an extra .py is listed, so the workflow refuses it
    writeFileSync(join(dir, "evil.py"), "print(1)\n");
    o = hash();
    assert.equal(o.scripts.evil, sha256("print(1)\n"));
    rmSync(join(dir, "evil.py"));
    // more .py files than the cap: a sentinel the workflow refuses, never a cut list
    for (let i = 0; i < 200; i++) writeFileSync(join(dir, "z" + String(i).padStart(3, "0") + ".py"), "");
    o = hash();
    assert.deepEqual(Object.keys(o.scripts), ["__too_many_programs__"]);
    for (let i = 0; i < 200; i++) rmSync(join(dir, "z" + String(i).padStart(3, "0") + ".py"));
    writeFileSync(join(dir, "plan_files.py"), readFileSync(join(dir, "plan_files.py"), "utf8") + "# x\n");
    o = hash();
    assert.notEqual(o.scripts.plan_files, programSha("plan_files"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("4.0.0 security 3: each program step runs sha256sum on the file first; a sha256sum line that is not the shipped one halts", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  let n = 0;
  for (const c of out.calls) {
    for (const m of c.prompt.matchAll(/python3 -I ('[^']+\.py')/g)) {
      n++;
      assert.ok(c.prompt.includes("sha256sum -- " + m[1] + " && python3 -I " + m[1]), c.label + ": " + m[1]);
      assert.match(c.prompt, /as `file_sha256`/, c.label);
    }
  }
  assert.ok(n >= 15);
  // the self-hash is right, the sha256sum line is not: two observations, both required
  for (const [label, slot, name] of [["infra:verify-plan-commit", "plan_files", "plan_files"], ["infra:branch-scan", null, "branch_scan"], ["infra:path-check:commit-plan", null, "path_check"]]) {
    const s = happy();
    s.__mutate = { label: relayRetried(label), fn: (r) => ((slot ? r[slot] : r).file_sha256 = "3".repeat(64), r) };
    const o = await runOne(s, ARGS);
    assert.notEqual(o.result.status, "awaiting_confirmation", label);
    assert.match(o.result.reason, new RegExp("did not run the shipped program " + name + " \\(its file's sha256sum line reads \"3{64}\""), label);
  }
});

test("4.0.0 1993: a run-state relay whose head or state object differs from the program's digest halts", async () => {
  const s = happy();
  s.__mutate = { label: "infra:state:committed:r1", fn: (r) => ((r.state_sha = "e".repeat(40)), r) };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "failed");
  assert.match(out.result.reason, /infra:state:committed:r1: the relayed head and state object do not match the program's digest/);
});

test("4.0.0 1993: the script's base64 matches Buffer for every padding case and non-ASCII text", () => {
  const grab = (name) => {
    const i = SOURCE.indexOf("\nfunction " + name + "(");
    return SOURCE.slice(i, SOURCE.indexOf("\n}\n", i) + 3);
  };
  const i = SOURCE.indexOf("\nconst B64_CHARS = ");
  const fn = new Function(SOURCE.slice(i, SOURCE.indexOf(";\n", i) + 2) + grab("utf8Bytes") + grab("base64Of") + "\nreturn base64Of;")();
  for (const t of ["", "a", "ab", "abc", "abcd", "abcde", "ünï — 🚀", "x".repeat(4001)]) assert.equal(fn(t), Buffer.from(t, "utf8").toString("base64"), JSON.stringify(t.slice(0, 20)));
});
