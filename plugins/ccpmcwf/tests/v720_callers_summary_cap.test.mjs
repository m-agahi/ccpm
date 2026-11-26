// fleet 7.2.0 (L2178, yaadgaar #44) AC10: a file-mode summary over SUMMARY_CAP = 4096 bytes exits
// with the relay-cap marker; the workflow splits that batch in halves that go straight to the
// disk path; one symbol alone stops needs_human.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ARGS, SCRIPTS_SRC, happy, runOne, scratchRepo, sh, spawnSync, callersDisk } from "./harness.mjs";

// 8.9.14 (yaadgaar #119): callers.py takes the runtime-doc list last (the engine's default here)
const RD = '["roles/**/*.md"]';

const CALLERS = join(SCRIPTS_SRC, "callers.py");

test("7.2.0 AC10: callers.py file mode refuses a summary over 4096 bytes; 4 long names fit", () => {
  const wt = scratchRepo("fleet-720-sum-");
  const S = mkdtempSync(join(tmpdir(), "fleet-720-scratch-"));
  try {
    const names = Array.from({ length: 30 }, (_, i) => "s" + String(i).padStart(2, "0") + "_" + "n".repeat(116));
    mkdirSync(join(wt, "src"));
    writeFileSync(join(wt, "src/f.py"), names.map((x) => x + "()\n").join(""));
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "x");
    const big = spawnSync("python3", ["-I", CALLERS, "file", wt, "docs/plans/x.md", JSON.stringify(names), "100", S, RD], { encoding: "utf8" });
    assert.notEqual(big.status, 0);
    assert.equal(big.stdout, "");
    assert.ok(big.stderr.startsWith("FLEET_CALLERS_RELAY_CAP: the callers summary is over the 4096-byte summary cap ("), big.stderr);
    const small = spawnSync("python3", ["-I", CALLERS, "file", wt, "docs/plans/x.md", JSON.stringify(names.slice(0, 4)), "100", S, RD], { encoding: "utf8" });
    assert.equal(small.status, 0, small.stderr);
    assert.ok(Buffer.byteLength(small.stdout) <= 4096);
    assert.equal(Object.keys(JSON.parse(small.stdout).symbols).length, 4);
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(S, { recursive: true, force: true });
  }
});

const one = (x) => ({ symbol: x, occurrences: [{ at: "src/" + x + ".py:1", criterion: "AC1", dont_care: null }] });
const SUM_CAP = (syms) => ({ status: "failed", reason: "FLEET_CALLERS_RELAY_CAP: the callers summary is over the 4096-byte summary cap (9000 bytes; symbols: " + syms.join(", ") + ")" });

test("7.2.0 AC10: a summary over the cap splits the batch into disk halves with no inline dispatch", async () => {
  const s = happy();
  const syms = ["s1", "s2", "s3", "s4"];
  s["role:scope-and-plan"].changed_symbols = syms.map(one);
  const data = Object.fromEntries(syms.map((x) => [x, { hits: ["src/" + x + ".py:1"] }]));
  callersDisk(s, "infra:callers", data);
  s["infra:callers:file"] = (p) => SUM_CAP(syms);
  callersDisk(s, "infra:callers:b2", data);
  callersDisk(s, "infra:callers:b3", data);
  const out = await runOne(s, ARGS);
  assert.ok(out.logs.includes("infra:callers:file: 4 symbols are over the summary cap; split in two"), out.logs.join("\n"));
  assert.ok(out.labels.includes("infra:callers:b2:file"), out.labels.join(", "));
  assert.ok(out.labels.includes("infra:callers:b3:file"));
  assert.ok(!out.labels.includes("infra:callers:b2"));
  assert.ok(!out.labels.includes("infra:callers:b3"));
  assert.ok(out.labels.includes("role:plan-audit"), out.result.reason);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
});

test("7.2.0 AC10: one symbol alone over the summary cap stops needs_human at the callers gate", async () => {
  const s = happy();
  s["role:scope-and-plan"].changed_symbols = [one("s1")];
  callersDisk(s, "infra:callers", { s1: { hits: ["src/s1.py:1"] } });
  s["infra:callers:file"] = () => SUM_CAP(["s1"]);
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "callers");
  assert.ok(out.result.reason.startsWith("infra:callers:file: the caller summary of s1 is over the 16384-byte summary cap"), out.result.reason);
});
