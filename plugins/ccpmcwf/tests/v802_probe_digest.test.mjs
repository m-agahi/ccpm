// ccpmcwf 8.0.2 (yaadgaar #77): the preflight probe prints probe_sha=<sha256 of
// its other lines>. scriptsProbeOf checks that digest first: a mismatch, a
// missing or invalid probe_sha= line, or no single home= line is a relay drop
// (one retry, on opus since 8.2.1 #82, then "re-run", never the install advice). Once the
// digest holds, a changed or absent file is real and keeps the install advice
// on the first relay.
//
// dont_care: the exact wording of the drop reasons; the retry prompt text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARGS, happy, runOne, call, scriptsProbe, probeSha, PREFLIGHT_PROBE, SCRIPTS_SRC, SCRIPTS_DIR, PROGRAMS, spawnSync } from "./harness.mjs";

const FULL = () => scriptsProbe();
const isSha = (x) => x.startsWith("probe_sha=");
const BODY = () => FULL().filter((x) => !isSha(x));
const HASH = /^[0-9a-f]{64} /;
// the first relay gets `first`, the retry `second`
function relays(first, second) {
  const s = happy();
  s.__mutate = { label: "preflight", fn: (r, prompt, label) => Object.assign(r, { scripts_probe: label === "preflight" ? first() : second() }) };
  return s;
}
const noHome = () => FULL().filter((x) => !x.startsWith("home="));
function assertRetriedThenPassed(out) {
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.deepEqual(out.labels.slice(0, 2), ["preflight", "preflight:relay-retry"]);
  // 8.2.1 (#82): preflight runs on sonnet, its retry one tier up
  assert.equal(call(out, "preflight:relay-retry").opts.model, "opus");
  assert.ok(out.result.gate_log.some((g) => /^preflight: the agent .*; retried once/.test(g)), out.result.gate_log.join("\n"));
}
function assertRelayHalt(out, re) {
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "contract");
  assert.deepEqual(out.labels, ["preflight", "preflight:relay-retry"]);
  assert.match(out.result.reason, /after one retry/);
  assert.match(out.result.reason, /re-run/);
  assert.doesNotMatch(out.result.reason, /install/);
  if (re) assert.match(out.result.reason, re);
}

test("8.0.2 #77 1: a relay that drops home= is retried once (on opus since 8.2.1); a good retry goes on", async () => {
  assertRetriedThenPassed(await runOne(relays(noHome, FULL), ARGS));
});

test("8.0.2 #77 2: home= dropped on both relays stops on contract with re-run, no install advice", async () => {
  assertRelayHalt(await runOne(relays(noHome, noHome), ARGS));
});

test("8.0.2 #77 3: two home= lines (digest intact) is a relay drop", async () => {
  const two = () => {
    const b = BODY();
    b.splice(1, 0, "home=/home/u");
    return b.concat("probe_sha=" + probeSha(b));
  };
  assertRelayHalt(await runOne(relays(two, two), ARGS), /home=/);
  assertRetriedThenPassed(await runOne(relays(two, FULL), ARGS));
});

test("8.0.2 #77 4: a hash swapped in place (same line count) fails the digest: retried, a clean retry passes", async () => {
  const swapped = () => {
    const f = FULL();
    const i = f.findIndex((x) => HASH.test(x) && x.endsWith("/roles/pr-review.md"));
    const j = f.findIndex((x) => HASH.test(x) && x.endsWith("/roles/scope-and-plan.md"));
    assert.ok(i >= 0 && j >= 0);
    f[i] = f[j].slice(0, 64) + f[i].slice(64);
    return f;
  };
  assert.equal(swapped().length, FULL().length);
  assertRetriedThenPassed(await runOne(relays(swapped, FULL), ARGS));
  const out = await runOne(relays(swapped, swapped), ARGS);
  assertRelayHalt(out);
  assert.doesNotMatch(out.result.reason, /changed/);
});

test("8.0.2 #77 5: a really changed file with a matching digest still stops with changed + install, no retry", async () => {
  const s = happy();
  s.preflight = { scripts_probe: scriptsProbe({ roleSums: { "plan-audit.md": "3".repeat(64) } }), scripts_dir: SCRIPTS_DIR };
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "contract");
  assert.deepEqual(out.labels, ["preflight"]);
  assert.match(out.result.reason, /changed/);
  assert.match(out.result.reason, /install ccpmcwf/);
});

test("8.0.2 #77 6: a missing, non-hex, upper-case or doubled probe_sha= line is a relay drop", async () => {
  const good = () => FULL().find(isSha);
  for (const [name, f] of [
    ["missing", () => BODY()],
    ["not hex", () => BODY().concat("probe_sha=" + "z".repeat(64))],
    ["upper case", () => BODY().concat(good().toUpperCase().replace("PROBE_SHA=", "probe_sha="))],
    ["short", () => BODY().concat(good().slice(0, -1))],
    ["doubled", () => BODY().concat(good(), good())],
  ]) {
    const out = await runOne(relays(f, f), ARGS);
    assert.equal(out.result.status, "needs_human", name);
    assertRelayHalt(out, /probe_sha=/);
    assertRetriedThenPassed(await runOne(relays(f, FULL), ARGS));
  }
});

test("8.0.2 #77 7: a file truly absent, with a good digest, is named absent on the first relay, no retry", async () => {
  const s = happy();
  s.preflight = { scripts_probe: scriptsProbe({ sums: { hasher: undefined } }), scripts_dir: SCRIPTS_DIR };
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "contract");
  assert.deepEqual(out.labels, ["preflight"]);
  assert.match(out.result.reason, /hasher\.py is absent from the installed plugin/);
  assert.match(out.result.reason, /install ccpmcwf/);
});

test("8.0.2 #77: the probe, run for real, ends with a probe_sha= line that hashes its other lines; the workflow accepts it", { skip: spawnSync("python3", ["-c", "1"]).status !== 0 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-802-probe-"));
  try {
    const ver = join(home, ".claude", "plugins", "cache", "mkt", "ccpmcwf", SCRIPTS_DIR.split("/").slice(-2)[0]);
    mkdirSync(join(ver, "scripts"), { recursive: true });
    for (const [n] of PROGRAMS) cpSync(join(SCRIPTS_SRC, n + ".py"), join(ver, "scripts", n + ".py"));
    cpSync(join(SCRIPTS_SRC, "..", "roles"), join(ver, "roles"), { recursive: true });
    const p = spawnSync("bash", ["-c", await PREFLIGHT_PROBE()], { encoding: "utf8", env: Object.assign({}, process.env, { HOME: home }) });
    assert.equal(p.status, 0, p.stderr);
    const lines = p.stdout.split("\n").filter((x) => x !== "");
    const shas = lines.filter(isSha);
    assert.equal(shas.length, 1, p.stdout);
    assert.equal(lines[lines.length - 1], shas[0]);
    assert.equal(shas[0], "probe_sha=" + probeSha(lines.slice(0, -1)));
    assert.ok(lines.filter((x) => HASH.test(x)).length >= PROGRAMS.length + 10);
    const s = happy();
    delete s.__dispatch;
    s.preflight = { scripts_probe: lines, scripts_dir: join(ver, "scripts") };
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
    assert.ok(!out.labels.includes("preflight:relay-retry"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("8.0.2 #77: an error line the probe writes (no roles dir) is inside the digest: the agent relays it, and the real fault stops on the first relay with the install text", { skip: spawnSync("python3", ["-c", "1"]).status !== 0 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-802-stderr-"));
  try {
    const ver = join(home, ".claude", "plugins", "cache", "mkt", "ccpmcwf", SCRIPTS_DIR.split("/").slice(-2)[0]);
    mkdirSync(join(ver, "scripts"), { recursive: true });
    for (const [n] of PROGRAMS) cpSync(join(SCRIPTS_SRC, n + ".py"), join(ver, "scripts", n + ".py"));
    const p = spawnSync("bash", ["-c", await PREFLIGHT_PROBE()], { encoding: "utf8", env: Object.assign({}, process.env, { HOME: home }) });
    // the Bash tool shows stdout and stderr together; the agent copies every line
    const lines = (p.stdout + p.stderr).split("\n").filter((x) => x !== "");
    assert.ok(lines.some((x) => /realpath/.test(x)), lines.join("\n"));
    const s = happy();
    delete s.__dispatch;
    s.preflight = { scripts_probe: lines, scripts_dir: join(ver, "scripts") };
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human");
    assert.deepEqual(out.labels, ["preflight"]);
    assert.match(out.result.reason, /roles dir .* resolves to ""/);
    assert.match(out.result.reason, /install ccpmcwf/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
