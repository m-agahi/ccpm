// fleet 5.0.5 (ledger 2018): the hasher relays a digest of the ignored map,
// never the map.
//
// Run wf_651d74ec-b3b (yadgarhq/iam-db, fleet 5.0.4) failed at
// hasher:pre-writers:r1: hasher.py exited 0, but its JSON was 472 KB, and
// hashes.ignored alone held 3157 entries (Rust's target/ plus
// .claude/settings.local.json). The relay agent cannot copy that map exactly
// through StructuredOutput, so the digest check failed.
//
// The rule: no relayed field grows with the repo's file count.
// - hasher.py writes the full ignored map to <scratch>/hashes/ignored-<sha256
//   of the file>.json (outside the hashed worktree) and relays
//   {count, sha256 (every entry but the fleet's settings file), settings (that
//   file's hash or null), file}. The script compares the digest and the count;
//   the settings entry keeps its 4.0.0 exemption.
// - A change still stops the run exactly where 5.0.4 stopped it. A new
//   program, ignored_diff.py, reads the two files from disk and prints the
//   changed paths, capped, for the stop text. It verifies each file against
//   its relayed digest; a missing or forged file never reads as "no change".
// - hasher.py exits non-zero when its JSON is over 64 KiB (a clear stop, not a
//   digest mismatch after a cut copy).
// - A local hook that names a directory (`pytest scripts/tests/ -q`) freezes
//   that directory's tree; 5.0.4 flagged it as unresolvable, which stopped
//   every freeze.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCRIPTS_SRC, ARGS, happy, run, sh, sha256, canon, FP_PRE, FP_TESTS, inputsOf, call, spawnSync, PROGRAMS, registerIgnored } from "./harness.mjs";

const HASHER = join(SCRIPTS_SRC, "hasher.py");
const DIFF = join(SCRIPTS_SRC, "ignored_diff.py");
const SETTINGS = ".claude/settings.local.json";
// the bound this release holds the relay to (the program's own cap is 64 KiB)
const RELAY_BOUND = 16384;

// a Rust-shaped repo: target/ ignored with n build files, a tracked test
function rustRepo(n = 3000) {
  const home = mkdtempSync(join(tmpdir(), "fleet-505-"));
  const wt = join(home, "repo");
  const scratch = join(home, "scratch");
  mkdirSync(join(wt, "tests"), { recursive: true });
  mkdirSync(join(wt, ".claude"), { recursive: true });
  mkdirSync(scratch);
  sh(wt, "git", "init", "-q");
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"]]) sh(wt, "git", "config", k, v);
  writeFileSync(join(wt, ".gitignore"), "/target\nlocal.txt\n.claude/settings.local.json\n");
  writeFileSync(join(wt, "tests", "test_a.py"), "def test_a():\n    pass\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-qm", "base");
  for (let i = 0; i < n; i++) {
    const d = join(wt, "target", "debug", "deps", "d" + (i % 30));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "f" + i + ".rlib"), "x" + i);
  }
  writeFileSync(join(wt, "local.txt"), "a");
  writeFileSync(join(wt, SETTINGS), "{}");
  return { home, wt, scratch, done: () => rmSync(home, { recursive: true, force: true }) };
}

function hasherRun(wt, scratch, files = ["tests/test_a.py"]) {
  const r = spawnSync("python3", ["-I", HASHER, wt, JSON.stringify(files), "", scratch], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: r.status === 0 ? JSON.parse(r.stdout) : null };
}

function diffRun(args) {
  const r = spawnSync("python3", ["-I", DIFF].concat(args), { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return { stdout: r.stdout, out: JSON.parse(r.stdout) };
}

const fileMap = (p) => JSON.parse(readFileSync(p, "utf8"));
const rest = (m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== SETTINGS));

test("5.0.5 2018: 3000 ignored target/ files: the relay stays under 16 KiB; the full map is on disk", () => {
  const f = rustRepo();
  try {
    const r = hasherRun(f.wt, f.scratch);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(Buffer.byteLength(r.stdout) < RELAY_BOUND, "relay is " + Buffer.byteLength(r.stdout) + " bytes");
    const ig = r.out.hashes.ignored;
    assert.deepEqual(Object.keys(ig).sort(), ["count", "file", "settings", "sha256"]);
    assert.equal(ig.count, 3001, "every entry but the settings file");
    assert.match(ig.file, new RegExp("^" + f.scratch + "/hashes/ignored-[0-9a-f]{64}\\.json$"));
    const raw = readFileSync(ig.file);
    assert.equal(ig.file.slice(-69, -5), sha256(raw), "the file is named by the sha256 of its bytes");
    const m = fileMap(ig.file);
    assert.equal(Object.keys(m).length, 3002);
    assert.ok("target/debug/deps/d0/f0.rlib" in m && "local.txt" in m && SETTINGS in m);
    assert.equal(ig.sha256, sha256(canon(rest(m))));
    assert.equal(ig.settings, m[SETTINGS]);
    // the digest covers the summary the relay carries
    assert.equal(r.out.digest, sha256(canon({ fingerprint: r.out.fingerprint, hashes: r.out.hashes, scripts: r.out.scripts, program: r.out.program })));
  } finally {
    f.done();
  }
});

test("5.0.5 2018: no settings file -> settings null; the same tree twice gives the same file", () => {
  const f = rustRepo(10);
  try {
    rmSync(join(f.wt, SETTINGS));
    const a = hasherRun(f.wt, f.scratch).out.hashes.ignored;
    const b = hasherRun(f.wt, f.scratch).out.hashes.ignored;
    assert.equal(a.settings, null);
    assert.deepEqual(a, b);
    assert.equal(readdirSync(join(f.scratch, "hashes")).length, 1);
  } finally {
    f.done();
  }
});

test("5.0.5 2018: a scratch dir inside the worktree, a relative one or none fails closed", () => {
  const f = rustRepo(5);
  try {
    for (const s of [join(f.wt, "scratch"), join(f.wt, "target"), "rel/scratch", ""]) {
      const r = hasherRun(f.wt, s);
      assert.notEqual(r.status, 0, s);
      assert.equal(r.stdout, "", s);
    }
  } finally {
    f.done();
  }
});

test("5.0.5 2018: hasher output over 64 KiB exits non-zero with the map sizes, never a cut relay", () => {
  const f = rustRepo(0);
  try {
    // 1500 runner-config files: the files map alone is ~150 KB
    for (let i = 0; i < 1500; i++) {
      mkdirSync(join(f.wt, "pkgs", "p" + i), { recursive: true });
      writeFileSync(join(f.wt, "pkgs", "p" + i, "conftest.py"), "");
    }
    const r = hasherRun(f.wt, f.scratch);
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /hasher output is \d+ bytes, over the 65536-byte relay cap; largest: files \d+ keys/);
  } finally {
    f.done();
  }
});

test("5.0.5 2018: ignored_diff lists the changed paths capped at 20, from verified files", () => {
  const f = rustRepo();
  try {
    const a = hasherRun(f.wt, f.scratch).out.hashes.ignored;
    for (let i = 0; i < 3000; i++) writeFileSync(join(f.wt, "target", "debug", "deps", "d" + (i % 30), "f" + i + ".rlib"), "y" + i);
    writeFileSync(join(f.wt, "target", "new.rlib"), "n");
    writeFileSync(join(f.wt, SETTINGS), '{"hooks":{}}');
    const b = hasherRun(f.wt, f.scratch).out.hashes.ignored;
    const args = [a.file, a.sha256, String(a.count), b.file, b.sha256, String(b.count)];
    const d = diffRun(args);
    assert.ok(Buffer.byteLength(d.stdout) < RELAY_BOUND, "diff relay " + Buffer.byteLength(d.stdout));
    assert.equal(d.out.error, null);
    assert.equal(d.out.total, 3001, "the settings file is left out (its own exemption)");
    assert.equal(d.out.paths.length, 20);
    assert.deepEqual(d.out.paths, d.out.paths.slice().sort());
    assert.deepEqual(d.out.args, args);
    const { program, digest, ...rest0 } = d.out;
    assert.equal(digest, sha256(canon(Object.assign({}, rest0, { program }))));
    // a few changes are listed in full
    rmSync(join(f.wt, "local.txt"));
    const c = hasherRun(f.wt, f.scratch).out.hashes.ignored;
    const e = diffRun([b.file, b.sha256, String(b.count), c.file, c.sha256, String(c.count)]).out;
    assert.deepEqual([e.total, e.paths, e.error], [1, ["local.txt"], null]);
  } finally {
    f.done();
  }
});

test("5.0.5 2018: ignored_diff fails closed on a missing, forged or miscounted file", () => {
  const f = rustRepo(20);
  try {
    const a = hasherRun(f.wt, f.scratch).out.hashes.ignored;
    writeFileSync(join(f.wt, "local.txt"), "b");
    const b = hasherRun(f.wt, f.scratch).out.hashes.ignored;
    const ok = [a.file, a.sha256, String(a.count), b.file, b.sha256, String(b.count)];
    // missing
    let d = diffRun([a.file + ".gone"].concat(ok.slice(1))).out;
    assert.match(d.error, /cannot read/);
    assert.deepEqual([d.paths, d.total], [[], null]);
    // forged: a file rewritten to hide the change
    const m = fileMap(b.file);
    m["local.txt"] = fileMap(a.file)["local.txt"];
    writeFileSync(b.file, JSON.stringify(m));
    d = diffRun(ok).out;
    assert.match(d.error, /does not match its digest/);
    assert.equal(d.total, null);
    // a digest or a count the relay forged
    d = diffRun([a.file, "0".repeat(64)].concat(ok.slice(2))).out;
    assert.match(d.error, /does not match its digest/);
    d = diffRun([a.file, a.sha256, String(a.count + 1)].concat(ok.slice(3))).out;
    assert.match(d.error, /count/);
  } finally {
    f.done();
  }
});

// ---------------------------------------------------------------- the workflow

// The real program's states, as a stub relays them: the file path moved to the
// run's scratch dir (the script checks where the file is), the map registered
// with the harness (its ignored-diff stub reads it as the program reads the file).
const SCRATCH = (prompt) => inputsOf(prompt).scratch_dir;
function relayed(out, prompt) {
  const h = JSON.parse(JSON.stringify(out.hashes));
  const m = fileMap(h.ignored.file);
  h.ignored.file = SCRATCH(prompt) + "/hashes/" + h.ignored.file.split("/").pop();
  registerIgnored(h.ignored, m);
  return h;
}

// pre-writers state A everywhere, post-writers `post`; every later hasher keeps post
function writersScript(A, post) {
  const s = happy();
  const pw = s["hasher:post-writers:r1"];
  s["hasher:pre-writers:r1"] = (p) => ({ status: "ok", fingerprint: FP_PRE, hashes: relayed(A, p) });
  s["hasher:post-writers:r1"] = (p) => Object.assign(pw(p), { hashes: relayed(post, p) });
  for (const l of ["hasher:freeze:f1", "hasher:post-coder:r1"]) {
    const base = s[l];
    s[l] = (p) => Object.assign({}, base, { hashes: relayed(post, p) });
  }
  return s;
}

function states() {
  const f = rustRepo();
  const A = hasherRun(f.wt, f.scratch).out;
  writeFileSync(join(f.wt, "target", "debug", "deps", "d0", "f0.rlib"), "changed");
  const B = hasherRun(f.wt, f.scratch).out;
  writeFileSync(join(f.wt, "target", "debug", "deps", "d0", "f0.rlib"), "x0");
  writeFileSync(join(f.wt, "local.txt"), "b");
  const C = hasherRun(f.wt, f.scratch).out;
  writeFileSync(join(f.wt, "local.txt"), "a");
  writeFileSync(join(f.wt, "target", "planted.so"), "p");
  const D = hasherRun(f.wt, f.scratch).out;
  return { f, A, B, C, D };
}

test("5.0.5 2018: a Rust repo whose target/ does not change between hasher points: the run proceeds", async () => {
  const { f, A } = states();
  try {
    const out = await run(writersScript(A, A), ARGS);
    assert.equal(out.result.status, "ok", out.result.reason);
    assert.ok(!out.labels.some((l) => l.startsWith("infra:ignored-diff:")), "no comparison when the digests match");
    // every hasher prompt names the run's scratch dir as its last argument
    const hp = call(out, "hasher:pre-writers:r1").prompt;
    assert.match(hp, /hasher\.py' '[^']+' '\["tests\/test_a\.py","tests\/test_b\.py"\]' '' '[^']+\/scratch'/);
    // the coder's do-not-touch list and the judge's recheck hold the summary, not 3000 keys
    const cin = inputsOf(call(out, "role:fleet-coder:r1").prompt);
    const keys = Object.keys(cin.frozen_config_sections);
    assert.ok(keys.includes("ignored:*") && !keys.some((k) => k.includes("target/")), keys.join(", "));
    assert.ok(JSON.stringify(cin).length < 40000);
  } finally {
    f.done();
  }
});

// The 5.0.4 outcomes, recorded by running the same states through the 5.0.4
// workflow (the relay copied by the harness, no model in between).
const V504 = {
  target: ["needs_human", "ownership", "ignored path written: target/debug/deps/d0/f0.rlib in test round 1"],
  local: ["needs_human", "ownership", "ignored path written: local.txt in test round 1"],
  planted: ["needs_human", "ownership", "ignored path written: target/planted.so in test round 1"],
  judge: ["needs_human", "fingerprint", "judge mutated worktree: fleet-test-judge (role:fleet-test-judge:r1) changed ignored path written: target/debug/deps/d0/f0.rlib; verdict discarded"],
};

test("5.0.5 2018: non-weakening: an ignored file a writer changes, inside target/ or not, or plants, stops as in 5.0.4", async () => {
  const { f, A, B, C, D } = states();
  try {
    for (const [k, post] of [["target", B], ["local", C], ["planted", D]]) {
      const out = await run(writersScript(A, post), ARGS);
      assert.deepEqual([out.result.status, out.result.stop_gate, out.result.reason], V504[k], k);
    }
  } finally {
    f.done();
  }
});

test("5.0.5 2018: non-weakening: a judge that rebuilds target/ is stopped as in 5.0.4", async () => {
  const { f, A, B } = states();
  try {
    const s = writersScript(A, A);
    s["hasher:fp-post:test-judge:r1"] = (p) => ({ status: "ok", fingerprint: FP_TESTS, hashes: relayed(B, p) });
    const out = await run(s, ARGS);
    assert.deepEqual([out.result.status, out.result.stop_gate, out.result.reason], V504.judge);
  } finally {
    f.done();
  }
});

test("5.0.5 2018: a comparison that fails (missing file, forged output, no result) still stops; the text says the list is unavailable", async () => {
  const { f, A, B } = states();
  try {
    for (const diff of [
      { status: "ok", reason: "x", paths: [], total: null, error: "cannot read /x: gone" },
      { status: "ok", reason: "x", paths: [], total: 0, error: null, digest: "0".repeat(64) },
      null,
    ]) {
      const s = writersScript(A, B);
      s["infra:ignored-diff:writers:r1"] = diff;
      const out = await run(s, ARGS);
      assert.equal(out.result.status, "needs_human");
      assert.equal(out.result.stop_gate, "ownership");
      assert.match(out.result.reason, /^ignored path written: \(the ignored files changed: 3001 -> 3001 files; the path list is unavailable: [^)]+\) in test round 1$/);
    }
  } finally {
    f.done();
  }
});

test("5.0.5 2018: a forged relay (digest, count, settings, file) fails the hasher step", async () => {
  const { f, A } = states();
  try {
    const forge = [
      // the relay changed a value and kept the program's digest
      (h) => ({ hashes: Object.assign(h, { ignored: Object.assign({}, h.ignored, { count: 1 }) }), keepDigest: true }),
      (h) => ({ hashes: Object.assign(h, { ignored: Object.assign({}, h.ignored, { sha256: "0".repeat(64) }) }), keepDigest: true }),
    ];
    for (const fz of forge) {
      const s = writersScript(A, A);
      s["hasher:pre-writers:r1"] = (p) => {
        const h = relayed(A, p);
        const good = { status: "ok", fingerprint: FP_PRE, hashes: JSON.parse(JSON.stringify(h)) };
        // the digest the program printed over the true values
        const prog = PROGRAMS.find(([n]) => n === "hasher");
        const digest = sha256(canon({ fingerprint: FP_PRE, hashes: good.hashes, scripts: Object.fromEntries(PROGRAMS.map(([n, x]) => [n, x])), program: { name: "hasher", sha256: prog[1] } }));
        return Object.assign({ status: "ok", fingerprint: FP_PRE, digest }, fz(h));
      };
      const out = await run(s, ARGS);
      assert.equal(out.result.status, "failed", JSON.stringify(out.result.reason));
      assert.match(out.result.reason, /hasher hasher:pre-writers:r1 failed: the relayed maps do not match the program's digest/);
    }
    // a well-digested summary of the wrong shape: the script refuses it
    const bad = [
      (ig) => Object.assign(ig, { file: "/elsewhere/hashes/" + ig.file.split("/").pop() }),
      (ig) => Object.assign(ig, { file: ig.file.replace(/ignored-[0-9a-f]+/, "ignored-x") }),
      (ig) => Object.assign(ig, { count: -1 }),
      (ig) => Object.assign(ig, { sha256: "abc" }),
      (ig) => Object.assign(ig, { settings: 5 }),
      (ig) => { delete ig.file; return ig; },
    ];
    for (const b of bad) {
      const s = writersScript(A, A);
      s["hasher:pre-writers:r1"] = (p) => {
        const h = relayed(A, p);
        h.ignored = b(h.ignored);
        return { status: "ok", fingerprint: FP_PRE, hashes: h };
      };
      const out = await run(s, ARGS);
      assert.equal(out.result.status, "failed", b.toString());
      assert.match(out.result.reason, /hasher hasher:pre-writers:r1 failed: (the ignored summary|incomplete output)/, b.toString());
    }
  } finally {
    f.done();
  }
});

test("5.0.5 2018: the same digest with another count is a change (the count is compared too)", async () => {
  const { f, A } = states();
  try {
    const s = writersScript(A, A);
    const post = s["hasher:post-writers:r1"];
    s["hasher:post-writers:r1"] = (p) => {
      const r = post(p);
      r.hashes.ignored.count += 1;
      return r;
    };
    s["infra:ignored-diff:writers:r1"] = { status: "ok", reason: "x", paths: [], total: null, error: "count mismatch" };
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "needs_human");
    assert.equal(out.result.stop_gate, "ownership");
  } finally {
    f.done();
  }
});

// ---------------------------------------------------------------- 3: directory hook entries

const HOOK = (entry) => "repos:\n  - repo: local\n    hooks:\n      - id: pytest-scripts\n        name: t\n        entry: " + entry + "\n        language: system\n        pass_filenames: false\n";

test("5.0.5 2018: a local hook that names a directory (with or without a slash) freezes its tree; 5.0.4 flagged it", () => {
  const f = rustRepo(0);
  try {
    mkdirSync(join(f.wt, "scripts", "tests"), { recursive: true });
    writeFileSync(join(f.wt, "scripts", "tests", "test_s.py"), "def test_s():\n    pass\n");
    writeFileSync(join(f.wt, "scripts", "tests", "new_untracked.py"), "");
    for (const entry of ["pytest scripts/tests/ -q", "pytest scripts/tests -q", "pytest ./scripts/tests/ -q"]) {
      writeFileSync(join(f.wt, ".pre-commit-config.yaml"), HOOK(entry));
      const o = hasherRun(f.wt, f.scratch).out;
      assert.deepEqual(o.hashes.suspicious, [], entry);
      assert.ok("scripts/tests/test_s.py" in o.hashes.files, entry + ": " + Object.keys(o.hashes.files).join(", "));
      assert.ok("scripts/tests/new_untracked.py" in o.hashes.files, entry);
    }
    // a directory that does not exist, the worktree itself, or one outside it stays unresolvable
    for (const [entry, tok] of [["pytest nosuch/ -q", "nosuch/"], ["pytest . -q", "."], ["pytest ../ -q", "../"]]) {
      writeFileSync(join(f.wt, ".pre-commit-config.yaml"), HOOK(entry));
      const o = hasherRun(f.wt, f.scratch).out;
      assert.deepEqual(o.hashes.suspicious, ["unresolvable local hook pytest-scripts: " + tok], entry);
    }
  } finally {
    f.done();
  }
});

test("5.0.5 2018: the program table names ignored_diff and the workflow runs it only through its slot", () => {
  assert.ok(PROGRAMS.some(([n]) => n === "ignored_diff"));
  assert.ok(existsSync(DIFF));
});
