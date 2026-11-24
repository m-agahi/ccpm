// fleet 7.4.0 car 5 (#68 items 2, 3).
// - C1 (item 2): callers.py file mode: the summary of ONE symbol may reach 16384 bytes
//   (SUMMARY_CAP_ONE; doctest_md can list many .md paths); two or more symbols keep 4096. This is
//   a transport cap, not a gate: the content is still checked by count and sha256.
// - C2 (item 3): the finding for auto hits over the caller read budget names the scratch file.
//   8.5.3 (#111): auto hits no longer use the budget; C2 now checks they are read with no finding.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ARGS, SCRIPTS_SRC, happy, runOne, scratchRepo, sh, spawnSync, callersDisk } from "./harness.mjs";

const CALLERS = join(SCRIPTS_SRC, "callers.py");

test("7.4.0 #68 C1: one symbol with 90 .md doctest hits (a ~9 KB summary) passes; two symbols over 4096 still stop", () => {
  const wt = scratchRepo("fleet-740c-");
  const S = mkdtempSync(join(tmpdir(), "fleet-740c-scratch-"));
  try {
    writeFileSync(join(wt, "pytest.ini"), "[pytest]\naddopts = --doctest-glob=*.md\n");
    mkdirSync(join(wt, "docs"));
    for (let i = 0; i < 90; i++) writeFileSync(join(wt, "docs", "guide_" + "g".repeat(80) + "_" + String(i).padStart(3, "0") + ".md"), "use my_symbol here and other_symbol\n");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "x");
    const one = spawnSync("python3", ["-I", CALLERS, "file", wt, "docs/plans/x.md", JSON.stringify(["my_symbol"]), "100", S], { encoding: "utf8" });
    assert.equal(one.status, 0, one.stderr);
    const n = Buffer.byteLength(one.stdout);
    assert.ok(n > 8000 && n <= 16384, "summary bytes " + n);
    assert.equal(JSON.parse(one.stdout).doctest_md.length, 90);
    const two = spawnSync("python3", ["-I", CALLERS, "file", wt, "docs/plans/x.md", JSON.stringify(["my_symbol", "other_symbol"]), "100", S], { encoding: "utf8" });
    assert.notEqual(two.status, 0);
    assert.ok(two.stderr.startsWith("FLEET_CALLERS_RELAY_CAP: the callers summary is over the 4096-byte summary cap ("), two.stderr);
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(S, { recursive: true, force: true });
  }
});

test("7.4.0 #68 C1: one symbol alone over the one-symbol cap stops naming 16384 bytes", async () => {
  const s = happy();
  s["role:scope-and-plan"].changed_symbols = [{ symbol: "s1", occurrences: [{ at: "src/s1.py:1", criterion: "AC1", dont_care: null }] }];
  callersDisk(s, "infra:callers", { s1: { hits: ["src/s1.py:1"] } });
  s["infra:callers:file"] = () => ({ status: "failed", reason: "FLEET_CALLERS_RELAY_CAP: the callers summary is over the 16384-byte summary cap (20000 bytes; symbols: s1)" });
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "callers");
  assert.match(out.result.reason, /the caller summary of s1 is over the 16384-byte summary cap/);
});

const docs = (x, n) => Array.from({ length: n }, (_, j) => "docs/" + x + "_" + String(j).padStart(3, "0") + ".md:1");

// 8.5.3 (#111): auto hits no longer use the read budget, so this finding is gone; the 5 pages are read
test("7.4.0 #68 C2 / 8.5.3: 210 auto hits (5 pages) are read outside the budget, with no finding", async () => {
  const s = happy();
  const x = "r_one";
  s["role:scope-and-plan"].changed_symbols = [{ symbol: x, occurrences: [{ at: docs(x, 1)[0], criterion: null, dont_care: "a doc" }] }];
  callersDisk(s, "infra:callers", { [x]: { hits: docs(x, 210), auto: docs(x, 210) } });
  const out = await runOne(s, ARGS);
  assert.ok(!out.labels.includes("role:scope-and-plan:audit-fix"), out.result.status + " " + out.result.reason);
  assert.equal(out.labels.filter((l) => l.startsWith("infra:callers:read:auto:")).length, 5, out.labels.join(", "));
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
});
