// fleet 6.3.2 (ledger 2130): gh runs without the program's own memory cap.
//
// Every fleet program caps its address space at 1 GiB (ADR-1174). gh is a Go
// binary: it inherited that cap and crashed at startup in about 10-16% of
// calls (exit 2, "runtime: out of memory: cannot allocate 4194304-byte block"
// or "runtime/cgo: pthread_create failed"), with no HTTP status. The ruleset
// surface then read "HTTP None" and the plan stopped at the hooks gate (runs
// wf_68c4970e-061, wf_57d9869b-814). 6.3.2: each gh child gets the hard limits
// back (db_sweep's lift()); git and ssh keep the caps. An api() call with no
// status is tried once more and then names gh's stderr; gh_identity counts a Go
// runtime crash as transient. A relay the agent marked failed only because the
// program's `error` was set reaches the program's own error branch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCRIPTS_SRC, ARGS, happy, run, inputsOf, spawnSync, programOf, programSha, relayDigestOf, K } from "./harness.mjs";

const PY = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
const GIT = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
const SHA = "a".repeat(40);
const OOM = "fatal error: runtime: out of memory: cannot allocate 4194304-byte block (ghp_" + "A".repeat(36) + ")";

// A stub gh. It logs, per call, whether its RLIMIT_AS soft limit equals the
// hard limit ("lifted") or not ("capped"); a capped call crashes the Go way.
// `table` maps the last argument to [status, body] or to "crash" (always
// crashes, no status) or "crash-once" (crashes on its first call only).
function stubGh(dir, name, table = {}) {
  writeFileSync(join(dir, name + ".json"), JSON.stringify(table));
  const f = join(dir, name);
  writeFileSync(
    f,
    "#!" + PY + "\nimport json, os, sys\n" +
      "d = " + JSON.stringify(dir) + "\n" +
      "lim = [l for l in open('/proc/self/limits') if l.startswith('Max address space')][0].split()\n" +
      "soft, hard = lim[3], lim[4]\n" +
      "mode = 'lifted' if soft == hard else 'capped'\n" +
      "open(os.path.join(d, " + JSON.stringify(name + ".log") + "), 'a').write(mode + ' ' + ' '.join(sys.argv[1:]) + '\\n')\n" +
      "if mode == 'capped':\n    sys.stderr.write(" + JSON.stringify(OOM) + " + '\\n')\n    sys.exit(2)\n" +
      "t = json.load(open(os.path.join(d, " + JSON.stringify(name + ".json") + ")))\n" +
      "e = t.get(sys.argv[-1], t.get('*', [404, {'message': 'Not Found'}]))\n" +
      "if e in ('crash', 'crash-once'):\n" +
      "    c = os.path.join(d, 'count-' + ''.join(x if x.isalnum() else '_' for x in sys.argv[-1]))\n" +
      "    n = int(open(c).read()) if os.path.exists(c) else 0\n" +
      "    open(c, 'w').write(str(n + 1))\n" +
      "    if e == 'crash' or n == 0:\n        sys.stderr.write(" + JSON.stringify(OOM) + " + '\\n')\n        sys.exit(2)\n" +
      "    e = t.get(sys.argv[-1] + '#ok', [200, {}])\n" +
      "st, body = e\n" +
      "if '-i' in sys.argv:\n    sys.stdout.write('HTTP/2.0 %d X\\r\\n\\r\\n' % st)\n" +
      "sys.stdout.write(body if isinstance(body, str) else json.dumps(body))\n" +
      "if st >= 300:\n    sys.stderr.write('gh: X (HTTP %d)\\n' % st)\n    sys.exit(1)\n",
  );
  chmodSync(f, 0o755);
}
const logOf = (dir, name) => (existsSync(join(dir, name + ".log")) ? readFileSync(join(dir, name + ".log"), "utf8").trim().split("\n") : []);

function home() {
  const h = mkdtempSync(join(tmpdir(), "fleet-632-"));
  const bin = join(h, "bin");
  mkdirSync(bin);
  symlinkSync(GIT, join(bin, "git"));
  const repo = join(h, "repo");
  mkdirSync(repo);
  spawnSync(GIT, ["init", "-q", repo]);
  writeFileSync(join(repo, "x.py"), "x = 1\n");
  spawnSync(GIT, ["-C", repo, "add", "-A"]);
  return { h, bin, repo };
}
function prog(name, args, bin) {
  return spawnSync(PY, ["-I", join(SCRIPTS_SRC, name + ".py")].concat(args), { encoding: "utf8", env: { PATH: bin, HOME: bin }, timeout: 120000 });
}

// the seven programs that spawn gh, with arguments that reach a gh call
const GH_PROGRAMS = {
  ruleset_surface: (e) => [e.repo, "gh", "q/actions", "master"],
  pr_convention: (e) => [e.repo, "gh", "q/actions", "master"],
  gh_identity: () => ["-", "q/actions"],
  ci_watch: (e) => ["gh", "q/actions", "1", SHA, "5", join(e.h, "ci-state.json")],
  orch_scan: (e) => [e.repo, "gh", "q/actions", "1", SHA, "master"],
  pr_state: () => ["view", "gh", "q/actions", "1", SHA],
  pr_body_block: () => ["gh", "q/actions", "1", Buffer.from("<details><summary>Built with ccpm fleet x @@WALL@@ <!-- ccpm-fleet-stats -->").toString("base64"), "-", "[]"],
};

for (const [name, argsOf] of Object.entries(GH_PROGRAMS)) {
  test("6.3.2 2130: " + name + " runs gh with the hard address-space limit, not the program's 1 GiB cap", () => {
    const e = home();
    try {
      stubGh(e.bin, "gh");
      prog(name, argsOf(e), e.bin);
      const log = logOf(e.bin, "gh");
      assert.ok(log.length > 0, name + " made no gh call");
      for (const l of log) assert.match(l, /^lifted /, name + ": " + l);
    } finally {
      rmSync(e.h, { recursive: true, force: true });
    }
  });
}

test("6.3.2 2130: every gh spawn in the seven programs passes preexec_fn=lift; git and ssh keep the caps", () => {
  for (const name of Object.keys(GH_PROGRAMS)) {
    const src = readFileSync(join(SCRIPTS_SRC, name + ".py"), "utf8");
    assert.match(src, /\ndef lift\(\):\n    # [^\n]*\n    for k in \(_r\.RLIMIT_AS, _r\.RLIMIT_CPU\):\n        _r\.setrlimit\(k, \(_r\.getrlimit\(k\)\[1\],\) \* 2\)\n/, name);
    // the caps themselves stay in the header
    assert.match(src, /for _k, _v in \(\(_r\.RLIMIT_AS, 1 << 30\), \(_r\.RLIMIT_CPU, 300\)\):/, name);
    const spawns = src.match(/subprocess\.run\(\[[^\]]*\][^\n]*/g) || [];
    const gh = spawns.filter((s) => /^subprocess\.run\(\[(gh|cmd|cmd or gh)\b/.test(s));
    assert.ok(gh.length > 0, name + ": no gh spawn found");
    for (const s of gh) {
      if (/^subprocess\.run\(\[cmd or gh\]/.test(s)) assert.match(s, /preexec_fn=None if cmd else lift/, name + ": " + s);
      else assert.match(s, /preexec_fn=lift\b/, name + ": " + s);
    }
    for (const s of spawns.filter((x) => /^subprocess\.run\(\[('git'|'ssh'|G\b)/.test(x))) assert.doesNotMatch(s, /preexec_fn/, name + ": " + s);
  }
});

// ---------------------------------------------------------------- api(): one retry, then gh's stderr

const RS_OK = { "repos/q/actions": [200, { id: 7, owner: { type: "User" } }], "repos/q/actions/rules/branches/master": [200, []] };

test("6.3.2 2130: ruleset_surface: a call with no HTTP status is tried once more; a second success leaves error null", () => {
  const e = home();
  try {
    stubGh(e.bin, "gh", Object.assign({}, RS_OK, { "repos/q/actions": "crash-once", "repos/q/actions#ok": RS_OK["repos/q/actions"] }));
    const r = prog("ruleset_surface", GH_PROGRAMS.ruleset_surface(e), e.bin);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.error, null);
    assert.equal(logOf(e.bin, "gh").filter((l) => / repos\/q\/actions$/.test(l)).length, 2);
  } finally {
    rmSync(e.h, { recursive: true, force: true });
  }
});

test("6.3.2 2130: ruleset_surface: two calls with no HTTP status name gh's stderr (tokens redacted) in error", () => {
  const e = home();
  try {
    stubGh(e.bin, "gh", Object.assign({}, RS_OK, { "repos/q/actions": "crash" }));
    const r = prog("ruleset_surface", GH_PROGRAMS.ruleset_surface(e), e.bin);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.match(o.error, /^repo q\/actions not readable \(HTTP None: fatal error: runtime: out of memory: cannot allocate 4194304-byte block \(\[redacted\]\)\)$/);
    assert.doesNotMatch(o.error, /ghp_/);
    assert.equal(logOf(e.bin, "gh").length, 2);
  } finally {
    rmSync(e.h, { recursive: true, force: true });
  }
});

test("6.3.2 2130: ruleset_surface: an HTTP status is never retried and its text is unchanged", () => {
  const e = home();
  try {
    stubGh(e.bin, "gh", Object.assign({}, RS_OK, { "repos/q/actions/rules/branches/master": [500, {}] }));
    const o = JSON.parse(prog("ruleset_surface", GH_PROGRAMS.ruleset_surface(e), e.bin).stdout);
    assert.equal(o.error, "rules of q/actions branch master not readable (HTTP 500)");
    assert.equal(logOf(e.bin, "gh").length, 2);
  } finally {
    rmSync(e.h, { recursive: true, force: true });
  }
});

test("6.3.2 2130: pr_convention: a call with no HTTP status is tried once more, then names gh's stderr in unreadable", () => {
  const e = home();
  try {
    const rules = "repos/q/actions/rules/branches/master";
    stubGh(e.bin, "gh", { [rules]: "crash" });
    const r = prog("pr_convention", GH_PROGRAMS.pr_convention(e), e.bin);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    const u = o.unreadable.find((x) => x.startsWith("rules of q/actions branch master"));
    assert.equal(u, "rules of q/actions branch master not readable (HTTP None: fatal error: runtime: out of memory: cannot allocate 4194304-byte block ([redacted]))");
    assert.equal(logOf(e.bin, "gh").filter((l) => l.endsWith(" " + rules)).length, 2);
  } finally {
    rmSync(e.h, { recursive: true, force: true });
  }
  const f = home();
  try {
    const rules = "repos/q/actions/rules/branches/master";
    stubGh(f.bin, "gh", { [rules]: "crash-once", [rules + "#ok"]: [200, []] });
    const o = JSON.parse(prog("pr_convention", GH_PROGRAMS.pr_convention(f), f.bin).stdout);
    assert.ok(!o.unreadable.some((x) => x.startsWith("rules of q/actions")), JSON.stringify(o.unreadable));
  } finally {
    rmSync(f.h, { recursive: true, force: true });
  }
});

test("6.3.2 2130: gh_identity: a Go runtime crash is transient: tried once more, and a second answer counts", () => {
  const e = home();
  try {
    stubGh(e.bin, "gh", { ".permissions.push": "crash-once", ".permissions.push#ok": [0, "true"] });
    const r = prog("gh_identity", ["-", "q/actions"], e.bin);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.repos["q/actions"].gh_cmd, "gh");
    assert.equal(o.repos["q/actions"].push, true);
    assert.equal(logOf(e.bin, "gh").length, 2);
  } finally {
    rmSync(e.h, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the relay: failed only because error was set

function failedRsRelay(p, error) {
  const r = { status: "failed", reason: "the program reported an error", surface: [], sources: [], read: [], unreadable: [], error, args: inputsOf(p).args };
  r.program = programOf("ruleset_surface");
  r.file_sha256 = programSha("ruleset_surface");
  r.digest = relayDigestOf(r, K("ruleset_surface"));
  return r;
}

test("6.3.2 2130: a valid ruleset relay marked failed for its own error reaches the hooks gate, not 'returned failed'", async () => {
  const s = happy();
  s["infra:ruleset-surface:plan"] = (p) => failedRsRelay(p, "repo o/r not readable (HTTP None: runtime: out of memory)");
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "hooks");
  assert.ok(out.result.reason.startsWith("hook surface cannot be computed (repo o/r not readable (HTTP None: runtime: out of memory)); hook change needs Max's confirmation"), out.result.reason);
  assert.doesNotMatch(out.result.reason, /returned failed/);
});

test("6.3.2 2130: a failed ruleset relay with a wrong digest or no error still halts as returned failed", async () => {
  for (const mut of [(r) => Object.assign(r, { digest: "0".repeat(64) }), (r) => Object.assign(r, { error: null, digest: relayDigestOf(Object.assign(r, { error: null }), K("ruleset_surface")) })]) {
    const s = happy();
    s["infra:ruleset-surface:plan"] = (p) => mut(failedRsRelay(p, "x"));
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "failed");
    assert.match(out.result.reason, /^infra:ruleset-surface:plan returned failed/);
  }
});

test("6.3.2 2130: the ruleset prompt says a non-null error with exit 0 is still status ok", () => {
  const src = readFileSync(join(SCRIPTS_SRC, "..", "src", "build-task-run.js"), "utf8");
  const m = src.match(/function rulesetSurfacePrompt\(inputs\) \{[\s\S]*?\n\}/);
  assert.ok(m);
  assert.match(m[0], /A non-null error with exit 0 is still status ok/);
});
