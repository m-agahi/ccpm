// fleet 7.4.0 (#36, L2143, 6.3.2 review lows; Max ruled "All five"):
// - B1: a hook-surface read that failed with no HTTP status tells Max to re-run, not to confirm
//   a hook change.
// - B2, B3: the failed-relay routing of hook_surface and ruleset_surface is pinned.
// - B5: the cap-lift tests skip where the hard RLIMIT_AS leaves nothing to lift.
// - B6: the gh stderr redaction covers short Bearer tokens.
//
// dont_care: the wording after "re-run"; the TAP layout of the skipped child run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCRIPTS_SRC, HERE, ARGS, happy, run, inputsOf, spawnSync, programOf, programSha, relayDigestOf, K, liftSkip, hardAs } from "./harness.mjs";

const TRANSIENT = "transient GitHub read failure; re-run";
const CONFIRM = "hook change needs Max's confirmation";

function hsOk(error) {
  return () => ({ status: "ok", reason: "read", surface: [], make_paths: {}, error });
}

test("7.4.0 #36 H1: a hook_surface error with HTTP None stops with the re-run text, not the confirmation text", async () => {
  const s = happy();
  s["infra:hook-surface:plan"] = hsOk("repo o/r not readable (HTTP None: runtime: out of memory)");
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "hooks");
  assert.ok(out.result.reason.includes(TRANSIENT), out.result.reason);
  assert.ok(!out.result.reason.includes(CONFIRM), out.result.reason);
  assert.ok(out.result.reason.includes("HTTP None: runtime: out of memory"), out.result.reason);
});

test("7.4.0 #36 H1: a hook_surface error with an HTTP status keeps the old text", async () => {
  const s = happy();
  s["infra:hook-surface:plan"] = hsOk("repo o/r not readable (HTTP 404)");
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "hooks");
  assert.ok(out.result.reason.startsWith("hook surface cannot be computed (repo o/r not readable (HTTP 404)); " + CONFIRM), out.result.reason);
  assert.ok(!out.result.reason.includes(TRANSIENT), out.result.reason);
});

function failedRsRelay(p, error, args) {
  const r = { status: "failed", reason: "the program reported an error", surface: [], sources: [], read: [], unreadable: [], error, args: args || inputsOf(p).args };
  r.program = programOf("ruleset_surface");
  r.file_sha256 = programSha("ruleset_surface");
  r.digest = relayDigestOf(r, K("ruleset_surface"));
  return r;
}

test("7.4.0 #36 H1: the ruleset_surface stop with HTTP None gets the re-run text too", async () => {
  const s = happy();
  s["infra:ruleset-surface:plan"] = (p) => failedRsRelay(p, "repo o/r not readable (HTTP None: runtime: out of memory)");
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "hooks");
  assert.ok(out.result.reason.startsWith("hook surface cannot be computed (repo o/r not readable (HTTP None: runtime: out of memory)); " + TRANSIENT), out.result.reason);
  assert.ok(!out.result.reason.includes(CONFIRM), out.result.reason);
});

test("7.4.0 #36 H2: a hook_surface relay marked failed, with a valid digest, its args and a non-null error, stops at hooks", async () => {
  const s = happy();
  s["infra:hook-surface:plan"] = (p) => {
    const i = inputsOf(p);
    const r = { status: "failed", reason: "the program reported an error", surface: [], make_paths: {}, error: "cannot read .pre-commit-config.yaml (HTTP 404)", args: [i.worktree, i.rev, JSON.stringify(i.targets)] };
    r.program = programOf("hook_surface");
    r.file_sha256 = programSha("hook_surface");
    r.digest = relayDigestOf(r, K("hook_surface"));
    return r;
  };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "hooks");
  assert.doesNotMatch(out.result.reason, /returned failed/);
});

test("7.4.0 #36 H3: a ruleset_surface relay marked failed whose args differ from the request halts as returned failed", async () => {
  const s = happy();
  s["infra:ruleset-surface:plan"] = (p) => failedRsRelay(p, "x", ["/elsewhere", "gh", "o/r", "master"]);
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "failed");
  assert.match(out.result.reason, /^infra:ruleset-surface:plan returned failed/);
});

test("7.4.0 #36 H4: at a hard RLIMIT_AS of 1 GiB or less the lift tests skip with a message naming the hard limit", () => {
  const env = { FLEET_TEST_HARD_AS: String(1 << 30) };
  assert.equal(hardAs(env), 1 << 30);
  const msg = liftSkip(env);
  assert.ok(typeof msg === "string" && msg.includes("1073741824"), String(msg));
  assert.equal(liftSkip({ FLEET_TEST_HARD_AS: String(2 ** 34) }), false);
  // the v632 lift tests take the guard: run them in a child with the override
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", join(HERE, "v632_gh_rlimit.test.mjs")], {
    encoding: "utf8",
    // a fresh test runner: no NODE_TEST_CONTEXT from this one
    env: Object.fromEntries(Object.entries(Object.assign({}, process.env, env)).filter(([k]) => k !== "NODE_TEST_CONTEXT")),
    timeout: 300000,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const skipped = r.stdout.split("\n").filter((l) => /# SKIP hard RLIMIT_AS is 1073741824 bytes/.test(l));
  // the seven per-program lift tests and the five that rely on a capped crash
  assert.ok(skipped.length >= 12, r.stdout);
});

// B6: a stub gh that fails with a short Bearer token in its stderr
function bearerGh(bin) {
  const py = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
  const f = join(bin, "gh");
  writeFileSync(f, "#!" + py + "\nimport sys\nsys.stderr.write('gh: request failed: Authorization: Bearer abc123 was rejected\\n')\nsys.exit(1)\n");
  chmodSync(f, 0o755);
}

test("7.4.0 #36 H5: ruleset_surface, pr_convention and gh_identity redact a short Bearer token from gh's stderr", () => {
  const h = mkdtempSync(join(tmpdir(), "fleet-740-bearer-"));
  try {
    const bin = join(h, "bin");
    mkdirSync(bin);
    const git = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    const repo = join(h, "repo");
    spawnSync(git, ["init", "-q", repo]);
    bearerGh(bin);
    const cases = {
      ruleset_surface: [repo, "gh", "q/actions", "master"],
      pr_convention: [repo, "gh", "q/actions", "master"],
      gh_identity: ["-", "q/actions"],
    };
    for (const [name, args] of Object.entries(cases)) {
      const r = spawnSync("python3", ["-I", join(SCRIPTS_SRC, name + ".py")].concat(args), { encoding: "utf8", env: { PATH: bin + ":" + git.slice(0, git.lastIndexOf("/")), HOME: h }, timeout: 120000 });
      assert.equal(r.status, 0, name + ": " + r.stderr);
      assert.ok(r.stdout.includes("Bearer ***"), name + ": " + r.stdout);
      assert.ok(!r.stdout.includes("abc123"), name + ": " + r.stdout);
    }
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});
