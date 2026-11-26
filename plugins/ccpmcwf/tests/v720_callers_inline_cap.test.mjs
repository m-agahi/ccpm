// fleet 7.2.0 (L2178, yaadgaar #44) AC1: callers.py inline mode prints its unchanged object up to
// INLINE_CAP = 8192 bytes; over it, nothing on stdout and the FLEET_CALLERS_ON_DISK marker.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SCRIPTS_SRC, scratchRepo, sh, spawnSync } from "./harness.mjs";

// 8.9.14 (yaadgaar #119): callers.py takes the runtime-doc list last (the engine's default here)
const RD = '["roles/**/*.md"]';

const CALLERS = join(SCRIPTS_SRC, "callers.py");
const SYMS = Array.from({ length: 30 }, (_, i) => "sym_name_" + i + "_long_identifier");
const run = (wt, syms) => spawnSync("python3", ["-I", CALLERS, wt, "docs/plans/x.md", JSON.stringify(syms), "100", RD], { encoding: "utf8" });

function repo50() {
  const wt = scratchRepo("fleet-720-inline-");
  for (let f = 0; f < 50; f++) {
    const d = join(wt, "src/services/module_" + (f % 10) + "/handlers");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "request_handler_" + String(f).padStart(2, "0") + ".py"), SYMS.map((x) => "x = " + x + "(1)\ny = " + x + "(2)\n").join(""));
  }
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-qm", "x");
  return wt;
}
const ON_DISK = "FLEET_CALLERS_ON_DISK: the callers output is over the 8192-byte inline cap (";

test("7.2.0 AC1: inline output over 8192 bytes prints nothing and exits with the FLEET_CALLERS_ON_DISK marker; one symbol stays inline", () => {
  const wt = repo50();
  try {
    // example 1 (main)
    const two = run(wt, SYMS.slice(0, 2));
    assert.notEqual(two.status, 0);
    assert.equal(two.stdout, "");
    assert.ok(two.stderr.startsWith(ON_DISK), two.stderr);
    assert.ok(two.stderr.includes("bytes; symbols: sym_name_0_long_identifier, sym_name_1_long_identifier)"), two.stderr);
    assert.match(two.stderr, /inline cap \(\d+ bytes; /);
    // example 2 (boundary): one symbol is the unchanged inline object
    const one = run(wt, SYMS.slice(0, 1));
    assert.equal(one.status, 0, one.stderr);
    const o = JSON.parse(one.stdout);
    assert.deepEqual(Object.keys(o).sort(), ["args", "auto_dont_care", "capped", "digest", "doctest_md", "occurrences", "program"]);
    assert.equal(o.occurrences.sym_name_0_long_identifier.length, 100);
    assert.ok(Buffer.byteLength(one.stdout) <= 8192, String(Buffer.byteLength(one.stdout)));
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("7.2.0 AC1: an output over 65536 bytes gets the on-disk marker, not the relay-cap marker; a no-hit symbol stays inline", () => {
  const wt = repo50();
  try {
    // example 3 (boundary)
    const all = run(wt, SYMS);
    assert.notEqual(all.status, 0);
    assert.equal(all.stdout, "");
    assert.ok(all.stderr.startsWith(ON_DISK), all.stderr);
    assert.ok(!all.stderr.startsWith("FLEET_CALLERS_RELAY_CAP"));
    // example 4 (boundary)
    const none = run(wt, ["absent_name"]);
    assert.equal(none.status, 0, none.stderr);
    const o = JSON.parse(none.stdout);
    assert.deepEqual(o.occurrences, { absent_name: [] });
    assert.deepEqual(o.capped, []);
    const two = run(wt, SYMS.slice(2, 4));
    assert.notEqual(two.status, 0);
    assert.ok(two.stderr.startsWith("FLEET_CALLERS_ON_DISK: "), two.stderr);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});
