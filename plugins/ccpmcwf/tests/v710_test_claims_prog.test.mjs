// fleet 7.1.0 (L2145, yaadgaar #37), AC2: pr_test_block.py reports in
// `claims` the count phrases of the final PR body outside every script test
// block. The stats region is scanned too; only the stats row form
// '<n> test rounds)' is dropped. No count cap: claims are listed until their
// UTF-8 bytes would pass 16384, then claims_truncated is true (ruling AC2).
//
// Expected values come only from the plan's AC2 examples.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCRIPTS_SRC, spawnSync } from "./harness.mjs";

const PY = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
const PROG = join(SCRIPTS_SRC, "pr_test_block.py");
const LF = "\n";
const TAB = "\t";
const START = "<!-- ccpm-fleet-tests -->";
const END = "<!-- /ccpm-fleet-tests -->";
const BLOCK = [START, "**Tests (measured by the fleet):** 133 passed, 0 failed, 0 errors, 133 total.", "Command: `npm test`", END].join(LF);
const B64 = Buffer.from(BLOCK, "utf8").toString("base64");

function scan(body, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-710c-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(dir, "cfg.json"), JSON.stringify(extra));
    writeFileSync(join(dir, "stored.txt"), body);
    const f = join(bin, "gh");
    writeFileSync(
      f,
      "#!" + PY + "\nimport json, os, sys\n" +
        "d = " + JSON.stringify(dir) + "\n" +
        "cfg = json.load(open(os.path.join(d, 'cfg.json')))\n" +
        "argv = sys.argv[1:]\n" +
        "open(os.path.join(d, 'log.txt'), 'a').write(argv[1] + '\\n')\n" +
        "if argv[:2] == ['pr', 'view']:\n" +
        "    if cfg.get('view_fail'):\n        sys.stderr.write('HTTP 502')\n        sys.exit(1)\n" +
        "    sys.stdout.write(json.dumps({'body': open(os.path.join(d, 'stored.txt'), newline='').read()}))\n" +
        "elif argv[:2] == ['pr', 'edit']:\n" +
        "    i = argv.index('--body-file')\n" +
        "    open(os.path.join(d, 'stored.txt'), 'w', newline='').write(open(argv[i + 1], newline='').read())\n" +
        "else:\n    sys.exit(3)\n",
    );
    chmodSync(f, 0o755);
    const r = spawnSync(PY, ["-I", PROG, "gh", "o/r", "7", B64, "[]"], { encoding: "utf8", env: { PATH: bin, HOME: bin }, timeout: 120000 });
    const log = existsSync(join(dir, "log.txt")) ? readFileSync(join(dir, "log.txt"), "utf8").trim().split("\n") : [];
    let out = {};
    try {
      out = JSON.parse(r.stdout);
    } catch {}
    return { r, out, edits: log.filter((x) => x === "edit").length };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
// the AC2 body: 'Intro.' + LF + LF + BLOCK + LF + <text> + LF, so no edit runs
const claimsOf = (text) => {
  const g = scan("Intro." + LF + LF + BLOCK + LF + text + LF);
  assert.equal(g.r.status, 0, g.r.stderr);
  assert.equal(g.out.error, null, g.out.error);
  assert.equal(g.edits, 0);
  return g.out;
};
const STATS = "<details><summary>Built with ccpm fleet 7.0.2</summary>" + LF + LF + "| metric | value |" + LF + "|---|---|" + LF + "| tests written | 12 (3 test rounds) |" + LF + "| code rounds | 1 |";
const STATS_END = LF + LF + "</details>" + LF + "<!-- ccpm-fleet-stats -->";

test("AC2 ex1: a count phrase in the prose is a claim", () => {
  const o = claimsOf("Summary: 147 passed in CI.");
  assert.deepEqual(o.claims, ["147 passed"]);
  assert.equal(o.claims_truncated, false);
});

test("AC2 ex2: P1 and P2 forms in order of start", () => {
  assert.deepEqual(claimsOf("Ran 12 tests; tests: 5; passed=3").claims, ["12 tests", "tests: 5", "passed=3"]);
});

test("AC2 ex3: no numbers, no claims", () => {
  assert.deepEqual(claimsOf("No numbers here.").claims, []);
});

test("AC2 ex4: numbers inside dotted versions do not match", () => {
  assert.deepEqual(claimsOf("Python 3.12 tests and fleet 7.0.2 test block").claims, []);
});

test("AC2 ex5: the counts of the script test block are not claims", () => {
  assert.deepEqual(claimsOf("").claims, []);
});

test("AC2 ex6: the stats region is scanned; its tests-written row form is dropped", () => {
  assert.deepEqual(claimsOf(STATS + STATS_END).claims, []);
});

test("AC2 ex7: an extra count row inside the stats region is a claim", () => {
  assert.deepEqual(claimsOf(STATS + LF + "| tests | 147 passed |" + STATS_END).claims, ["147 passed"]);
});

test("AC2 ex8: equal phrases are listed once", () => {
  assert.deepEqual(claimsOf("147 passed. Again: 147 passed.").claims, ["147 passed"]);
});

test("AC2 ex9: a tab collapses to one space", () => {
  assert.deepEqual(claimsOf("147" + TAB + "passed").claims, ["147 passed"]);
});

test("AC2 ex10: case-insensitive, text as written", () => {
  assert.deepEqual(claimsOf("147 PASSED").claims, ["147 PASSED"]);
});

test("AC2 ex11: P2 refuses a number followed by .<digit> or ,<digit>", () => {
  assert.deepEqual(claimsOf("tests: 5.5 and pass 3,000").claims, []);
});

test("AC2 ex12: only the '(<m> test rounds)' cell form is dropped", () => {
  assert.deepEqual(claimsOf("(5 test rounds) and 5 test rounds").claims, ["5 test"]);
});

test("AC2 ex13: each claim is cut to 80 characters", () => {
  const c = claimsOf("1" + ",1".repeat(50) + " passed").claims;
  assert.equal(c.length, 1);
  assert.equal(c[0].length, 80);
  assert.ok(c[0].startsWith("1,1,1"), c[0]);
});

test("AC2 ex14: no count cap: 21 phrases give 21 claims", () => {
  const text = Array.from({ length: 21 }, (_, i) => i + 1 + " passed.").join(" ");
  const o = claimsOf(text);
  assert.equal(o.claims.length, 21);
  assert.equal(o.claims[0], "1 passed");
  assert.equal(o.claims[20], "21 passed");
  assert.equal(o.claims_truncated, false);
});

test("AC2 ex15: claims stop before 16384 bytes and claims_truncated is true", () => {
  const all = Array.from({ length: 2000 }, (_, i) => i + 1 + " passed");
  const o = claimsOf(all.map((x) => x + ".").join(" "));
  assert.equal(o.claims_truncated, true);
  assert.equal(o.claims[0], "1 passed");
  assert.equal(o.claims[1], "2 passed");
  const bytes = o.claims.reduce((n, c) => n + Buffer.byteLength(c, "utf8"), 0);
  assert.ok(bytes <= 16384, String(bytes));
  assert.deepEqual(o.claims, all.slice(0, o.claims.length));
  assert.ok(bytes + Buffer.byteLength(all[o.claims.length], "utf8") > 16384);
});

test("AC2 ex16: a gh pr view failure gives error, claims [] and claims_truncated false", () => {
  const g = scan("147 passed", { view_fail: true });
  assert.ok(g.out.error.startsWith("gh pr view: "), g.out.error);
  assert.deepEqual(g.out.claims, []);
  assert.equal(g.out.claims_truncated, false);
});

test("AC2 ex17: after an edit the claims come from the re-read body", () => {
  const g = scan("## S" + LF + "Now 147 passed.");
  assert.equal(g.out.error, null, g.out.error);
  assert.equal(g.out.edited, true);
  assert.deepEqual(g.out.claims, ["147 passed"]);
});

test("AC2 property: any body text gives a list of strings", () => {
  for (const t of ["", "\u0000 1 passed", "pass:1 fail=2 test 3", "💥 12 tests ✓", "1,2,3 failing\t\t4 failed", "tests:" + "9".repeat(40)]) {
    const o = claimsOf(t);
    assert.ok(Array.isArray(o.claims) && o.claims.every((c) => typeof c === "string"), JSON.stringify(t));
  }
});
