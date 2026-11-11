// fleet 6.0.0, stream 1: ledger 2038, 2039, 2040, 2043, 2041.
//
// 2038: run wf_204148f5-38f stopped at the PR step with "no GitHub command
// with push access" although both probes had answered null (unknown), not
// false; a re-run got push true. The PR step now re-probes once on unknown.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCRIPTS_SRC, ARGS, happy, run, call, inputsOf, ghIdOut, spawnSync } from "./harness.mjs";

const UNKNOWN = [{ cmd: "gh", installed: true, push: null }, { cmd: "gh-personal", installed: true, push: null }];
const GH_PUSH = [{ cmd: "gh", installed: true, push: true }];
const NO_PUSH = [{ cmd: "gh", installed: true, push: false }, { cmd: "gh-personal", installed: true, push: false }];
const reprobe = (tried) => (p) => Object.assign({ status: "ok", reason: "checked" }, ghIdOut(inputsOf(p).args, null, { "o/r": tried }));

// ---------------------------------------------------------------- 2038: the PR step re-probes once on unknown

test("6.0.0 2038: unknown push at the workspace, push true at the PR re-probe -> the PR opens", async () => {
  const s = happy();
  s.__gh = { "o/r": UNKNOWN };
  s["infra:gh-identity:pr"] = reprobe(GH_PUSH);
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.build.labels.filter((l) => /^infra:gh-identity:pr/.test(l)).length, 1, "one re-probe");
  assert.ok(out.build.logs.some((l) => /^PR step: push access to o\/r not known \(.*\); probing once more/.test(l)), out.build.logs.join("\n"));
  assert.equal(inputsOf(call(out, "role:fleet-pr-opener").prompt).gh_cmd, "gh");
  assert.ok(out.build.labels.indexOf("infra:gh-identity:pr") < out.build.labels.indexOf("role:fleet-pr-opener"));
});

test("6.0.0 2038: unknown twice -> halt with the unknown text, not 'no push access'", async () => {
  const s = happy();
  s.__gh = { "o/r": UNKNOWN };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "role");
  assert.match(out.result.reason, /^PR step: push access to o\/r still not known after a second probe \(gh=null, gh-personal=null\)/);
  assert.doesNotMatch(out.result.reason, /no GitHub command with push access/);
  assert.equal(out.build.labels.filter((l) => /^infra:gh-identity:pr/.test(l)).length, 1);
  assert.ok(!out.build.labels.includes("role:fleet-pr-opener"));
});

test("6.0.0 2038: unknown at the workspace, definite no at the re-probe -> the no-access halt", async () => {
  const s = happy();
  s.__gh = { "o/r": UNKNOWN };
  s["infra:gh-identity:pr"] = reprobe(NO_PUSH);
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "role");
  assert.match(out.result.reason, /^PR step: no GitHub command with push access to o\/r \(gh=false, gh-personal=false\)/);
});

test("6.0.0 2038: a definite no at the workspace still stops at build start; no re-probe", async () => {
  const s = happy();
  s.__gh = { "o/r": NO_PUSH };
  const out = await run(s, ARGS);
  assert.match(out.result.reason, /^build start: no GitHub command with push access to o\/r/);
  assert.ok(!out.labels.some((l) => /^infra:gh-identity:pr/.test(l)));
});

// the program records why an answer was unknown
const GIT = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
function stub(dir, name, out, code = 0, err = "") {
  const f = join(dir, name);
  writeFileSync(f, "#!/bin/sh\n" + (err ? "printf '%s\\n' " + JSON.stringify(err) + " >&2\n" : "") + (out !== null ? "printf '%s\\n' " + JSON.stringify(out) + "\n" : "") + "exit " + code + "\n");
  chmodSync(f, 0o755);
}
function ghProg(args, dir) {
  if (!existsSync(join(dir, "git"))) symlinkSync(GIT, join(dir, "git"));
  const path = [dir].concat((process.env.PATH || "").split(":").filter((e) => e && e.startsWith("/") && !["gh", "gh-personal", "ssh"].some((n) => existsSync(join(e, n))))).join(":");
  const r = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "gh_identity.py")].concat(args), { encoding: "utf8", env: { PATH: path, HOME: dir } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("6.0.0 2038: gh_identity records exit_code and a short, token-free stderr on each unknown answer", () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-600-"));
  try {
    const bin = join(home, "bin");
    mkdirSync(bin);
    stub(bin, "gh", null, 1, "gh: Bad credentials ghp_" + "A".repeat(36) + " (HTTP 401) " + "x".repeat(400));
    stub(bin, "gh-personal", "false");
    const o = ghProg(["-", "o/r"], bin);
    const t = o.repos["o/r"].tried;
    assert.equal(t[0].push, null);
    assert.equal(t[0].exit_code, 1);
    assert.match(t[0].stderr, /^gh: Bad credentials \[redacted\] \(HTTP 401\)/);
    assert.ok(t[0].stderr.length <= 200, t[0].stderr.length);
    assert.ok(!/ghp_/.test(JSON.stringify(o)));
    // a definite answer carries no diagnostics
    assert.deepEqual(t[1], { cmd: "gh-personal", installed: true, push: false });
    // exit 0 with an unexpected stdout: exit_code 0, stderr empty
    stub(bin, "gh", "null");
    assert.deepEqual(ghProg(["-", "o/r"], bin).repos["o/r"].tried[0], { cmd: "gh", installed: true, push: null, exit_code: 0, stderr: "" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("6.0.0 2038: the unknown halt shows the program's stderr", async () => {
  const s = happy();
  s.__gh = { "o/r": [{ cmd: "gh", installed: true, push: null, exit_code: 1, stderr: "HTTP 502: Bad Gateway" }, { cmd: "gh-personal", installed: false, push: null }] };
  const out = await run(s, ARGS);
  assert.match(out.result.reason, /gh=null \[exit 1: HTTP 502: Bad Gateway\]/);
});
