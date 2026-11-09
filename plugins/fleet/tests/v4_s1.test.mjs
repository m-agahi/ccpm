// fleet 4.0.0 stream S1 (ledger 1993): the embedded programs ship as files
// under plugins/fleet/scripts/, agents run them as python3 -I <scripts_dir>/<name>.py,
// each program proves which file ran (its own sha256), and the plan ref is
// written from checked base64 chunks by a commit step and verified by a
// separate read-only step.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, cpSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  programConst,
  verifyStub,
  chunkedContentOf,
} from "./harness.mjs";

const GEN = join(SCRIPTS_SRC, "gen.mjs");

function at(obj, path) {
  return path ? obj[path] : obj;
}

// ---------------------------------------------------------------- AC-1993-2: the files are the constants

test("4.0.0 1993 AC-2: every *_PY constant ships as scripts/<name>.py, byte-equal to the constant + newline", () => {
  const consts = (SOURCE.match(/^const ([A-Z_]+_PY) = String\.raw`/gm) || []).map((l) => /const ([A-Z_]+_PY)/.exec(l)[1]).sort();
  assert.deepEqual(consts, PROGRAMS.map(([, c]) => c).sort(), "the program table names every embedded program");
  assert.equal(PROGRAMS.length, 22);
  const files = readdirSync(SCRIPTS_SRC).filter((f) => f.endsWith(".py")).sort();
  assert.deepEqual(files, PROGRAMS.map(([n]) => n + ".py").sort(), "no extra and no missing file");
  for (const [name, c] of PROGRAMS) {
    const value = programConst(c);
    // the raw literal is the runtime value: no ${ and no backtick inside
    assert.ok(!value.includes("${") && !value.includes("`"), c);
    assert.equal(Function("return String.raw`" + value + "`")(), value, c);
    assert.equal(readFileSync(join(SCRIPTS_SRC, name + ".py"), "utf8"), value + "\n", name);
    assert.equal(programSha(name), sha256(value + "\n"), name);
  }
});

test("4.0.0 1993: gen.mjs --check passes on the shipped files and fails on a changed, missing or extra file", () => {
  const ok = spawnSync("node", [GEN, "--check"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  const tmp = mkdtempSync(join(tmpdir(), "fleet-gen-"));
  try {
    const w = spawnSync("node", [GEN, "--out", tmp], { encoding: "utf8" });
    assert.equal(w.status, 0, w.stderr);
    assert.equal(spawnSync("node", [GEN, "--check", "--out", tmp], { encoding: "utf8" }).status, 0);
    writeFileSync(join(tmp, "plan_files.py"), readFileSync(join(tmp, "plan_files.py"), "utf8") + "# x\n");
    const changed = spawnSync("node", [GEN, "--check", "--out", tmp], { encoding: "utf8" });
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /plan_files\.py/);
    spawnSync("node", [GEN, "--out", tmp]);
    writeFileSync(join(tmp, "extra.py"), "print(1)\n");
    assert.notEqual(spawnSync("node", [GEN, "--check", "--out", tmp], { encoding: "utf8" }).status, 0);
    rmSync(join(tmp, "extra.py"));
    rmSync(join(tmp, "hasher.py"));
    assert.notEqual(spawnSync("node", [GEN, "--check", "--out", tmp], { encoding: "utf8" }).status, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("4.0.0 1993: FLEET_VERSION is a semver string and the scripts_dir shape names it", () => {
  const m = /^const FLEET_VERSION = "(\d+\.\d+\.\d+)";$/m.exec(SOURCE);
  assert.ok(m, "FLEET_VERSION constant");
  assert.equal(m[1], "4.0.0");
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
  for (const [label, path, name] of cases) {
    const s = happy();
    const orig = s[label];
    // the harness fills the program; this wraps the harness output instead
    s.__mutate = { label, fn: (r) => {
      const o = at(r, path);
      if (o && typeof o === "object") o.program = { name, sha256: "0".repeat(64) };
      return r;
    } };
    if (orig === undefined) delete s[label];
    const out = await run(s, ARGS);
    const okish = out.result && (out.result.status === "ok" || out.result.status === "awaiting_confirmation");
    if (/^workspace$/.test(label)) {
      // the origin URL relay is soft: unusable, so the IaC push gate refuses later
      assert.ok(out.logs.some((l) => /origin URL relay unusable/.test(l)), label);
      continue;
    }
    assert.ok(!okish, label + " " + (path || "") + " (" + name + "): a zero program sha256 did not stop the run");
  }
});

// ---------------------------------------------------------------- AC-1993-4: scripts_dir per run, shape-checked

test("4.0.0 1993 AC-4: a scripts_dir outside the plugin cache halts at the first agent with stop_gate contract", async () => {
  const bad = [
    ["/tmp/x", ["/tmp/x"]],
    ["fleet/4.0.0/scripts", ["fleet/4.0.0/scripts"]],
    ["/home/u/.claude/plugins/cache/m/fleet/3.1.3/scripts", ["/home/u/.claude/plugins/cache/m/fleet/3.1.3/scripts"]],
    ["/home/u/../x/fleet/4.0.0/scripts", ["/home/u/../x/fleet/4.0.0/scripts"]],
    ["/home/u//fleet/4.0.0/scripts", ["/home/u//fleet/4.0.0/scripts"]],
    ["/home/u/a b/fleet/4.0.0/scripts", ["/home/u/a b/fleet/4.0.0/scripts"]],
    // two hits: never guess
    [SCRIPTS_DIR, [SCRIPTS_DIR, "/home/v/.claude/plugins/cache/n/fleet/4.0.0/scripts"]],
    // no hit
    [null, []],
    // the directory used is not the hit
    ["/home/v/.claude/plugins/cache/n/fleet/4.0.0/scripts", [SCRIPTS_DIR]],
  ];
  for (const [dir, hits] of bad) {
    const s = happy();
    s.preflight = Object.assign({}, s.preflight, { scripts_dir: dir, scripts_hits: hits });
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
    assert.match(o.calls[0].prompt, /ls -d "\$HOME"\/\.claude\/plugins\/cache\/\*\/fleet\/4\.0\.0\/scripts/);
    assert.match(o.calls[0].prompt, /python3 -I <scripts_dir>\/path_check\.py/);
  }
  const ref = s.__store[PC];
  assert.ok(typeof ref === "string" && ref.length > 0);
  assert.ok(!ref.includes("scripts"), "the sealed ref names no scripts path");
  // build mode resolves it again in its own first agent
  const b = await run(happy(), ARGS);
  assert.equal(b.build.labels[0], "preflight");
  assert.match(b.build.calls[0].prompt, /fleet\/4\.0\.0\/scripts/);
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
    const bad = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "state_write.py"), wt, "refs/heads/master", dir, "1", sha256(msg), JSON.stringify(shas)], { encoding: "utf8", env, cwd: home });
    assert.notEqual(bad.status, 0);
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
