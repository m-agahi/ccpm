// fleet 7.4.0 car 5 (#64): pr_test_block follow-ups.
// - V1/V2 (items 1, 2): the claim check reads more count forms: markdown around the number
//   (**147** passed), one word before the noun (147 unit tests), pass|fail in P1, passing in P2,
//   n/m and "n of m" near a test word, NBSP or a newline between the number and the word, n+.
//   Car 5 kept the shipped P1/P2 matches ("all gate edits only tighten"); car 6 (Max ruling)
//   drops exactly the ordinal forms "test 2 of AC3" and "Step 2 tests the parser"
//   (v740_ordinal_claims). The claim check is a fail-closed backstop.
// - V3 (item 3): the stats row skip ('<n> test rounds)') holds only on a line that starts with
//   '| tests written |' inside the stats region; elsewhere it is a claim.
// - V4 (item 4): a supplied string exempts a claim only as a whole phrase with word bounds
//   ("13 tests" supplied does not exempt "3 tests"), and the shipped substring test must hold too.
// - V5 (item 5): a judge with errors null -> the block says "errors not reported", and the total
//   is passed + failed.
// - V6 (item 6): a stats region (from an opener-written '<details><summary>Built with ccpm fleet')
//   that holds the test block marker -> pr_body_block error, no write.
// - V7 (item 7): halt then resume: a second pr_test_block run on the same body keeps one block.
//
// dont_care: the order of claims of different starts beyond sorted-by-start; the error wording
// after "stats region overlaps the test block".

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARGS, SOURCE, SCRIPTS_SRC, happy, run as runFlow, inputsOf, spawnSync } from "./harness.mjs";

const PY = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
const LF = "\n";
const NBSP = String.fromCharCode(0xa0);
const START = "<!-- ccpm-fleet-tests -->";
const END = "<!-- /ccpm-fleet-tests -->";
const BLOCK = [START, "**Tests (measured by the fleet):** 133 passed, 0 failed, 0 errors, 133 total.", "Command: `npm test`", END].join(LF);
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

// a stub gh over a stored body; logs each call's verb
function stubGh(body) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-740v-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(dir, "stored.txt"), body);
  const f = join(bin, "gh");
  writeFileSync(
    f,
    "#!" + PY + "\nimport json, os, sys\n" +
      "d = " + JSON.stringify(dir) + "\n" +
      "argv = sys.argv[1:]\n" +
      "open(os.path.join(d, 'log.txt'), 'a').write(argv[1] + '\\n')\n" +
      "if argv[:2] == ['pr', 'view']:\n" +
      "    sys.stdout.write(json.dumps({'body': open(os.path.join(d, 'stored.txt'), newline='').read()}))\n" +
      "elif argv[:2] == ['pr', 'edit']:\n" +
      "    i = argv.index('--body-file')\n" +
      "    open(os.path.join(d, 'stored.txt'), 'w', newline='').write(open(argv[i + 1], newline='').read())\n" +
      "else:\n    sys.exit(3)\n",
  );
  chmodSync(f, 0o755);
  const prog = (name, args) => {
    const r = spawnSync(PY, ["-I", join(SCRIPTS_SRC, name + ".py")].concat(args), { encoding: "utf8", env: { PATH: bin, HOME: bin }, timeout: 120000 });
    const log = existsSync(join(dir, "log.txt")) ? readFileSync(join(dir, "log.txt"), "utf8").trim().split("\n") : [];
    let out = {};
    try {
      out = JSON.parse(r.stdout);
    } catch {}
    return { r, out, edits: log.filter((x) => x === "edit").length, stored: readFileSync(join(dir, "stored.txt"), "utf8") };
  };
  return { prog, done: () => rmSync(dir, { recursive: true, force: true }) };
}
// the claims of 'Intro.' + block + text (no edit runs)
function claimsOf(text) {
  const g = stubGh("Intro." + LF + LF + BLOCK + LF + text + LF);
  try {
    const x = g.prog("pr_test_block", ["gh", "o/r", "7", b64(BLOCK), "[]"]);
    assert.equal(x.r.status, 0, x.r.stderr);
    assert.equal(x.out.error, null, x.out.error);
    assert.equal(x.edits, 0);
    return x.out.claims;
  } finally {
    g.done();
  }
}
const STATS_HEAD = "<details><summary>Built with ccpm fleet 7.4.0</summary>" + LF + LF + "| metric | value |" + LF + "|---|---|" + LF;
const STATS_END = LF + LF + "</details>" + LF + "<!-- ccpm-fleet-stats -->";

test("7.4.0 #64 V1: the item-2 table: each row is a claim (shipped rows kept, new forms added)", () => {
  assert.deepEqual(claimsOf("Summary: **147** passed."), ["**147** passed"]);
  assert.deepEqual(claimsOf("Ran 147 unit tests."), ["147 unit tests"]);
  assert.ok(claimsOf("All 147/147 tests green.").includes("147/147"));
  assert.ok(claimsOf("| tests | 147/147 |").includes("147/147"));
  // car 6 (Max ruling on the car-5 deviation): the two exact ordinal forms are no claim
  // (v740_ordinal_claims); every other shipped match stays
  assert.deepEqual(claimsOf("See test 2 of AC3."), []);
  assert.deepEqual(claimsOf("Step 2 tests the parser."), []);
  assert.deepEqual(claimsOf("Ran 147 tests."), ["147 tests"]);
  assert.deepEqual(claimsOf("AC1 has 3 tests."), ["3 tests"]);
});

test("7.4.0 #64 V2: each item-1 form is a claim", () => {
  assert.deepEqual(claimsOf("3 pass and 2 fail"), ["3 pass", "2 fail"]);
  assert.deepEqual(claimsOf("passing: 5"), ["passing: 5"]);
  assert.ok(claimsOf("147 of 150 tests").includes("147 of 150"));
  assert.deepEqual(claimsOf("147" + NBSP + "passed"), ["147 passed"]);
  assert.deepEqual(claimsOf("147" + LF + "passed"), ["147 passed"]);
  assert.deepEqual(claimsOf("147+ tests"), ["147+ tests"]);
  assert.deepEqual(claimsOf("__147__ passed and `12` tests and ~9~ failed"), ["__147__ passed", "`12` tests", "~9~ failed"]);
  // still no claim: no number, a dotted version, a fraction with no test word near it
  assert.deepEqual(claimsOf("No numbers here."), []);
  assert.deepEqual(claimsOf("Python 3.12 tests and fleet 7.0.2 test block"), []);
  assert.deepEqual(claimsOf("Merged 11/17 by the owner."), []);
  // the new forms stay narrow: a bare dash is no word, a blank line ends the phrase, the test
  // word near a fraction is a whole word, and an issue number is no count
  assert.deepEqual(claimsOf("Closes #42" + LF + "- Tests added"), []);
  assert.deepEqual(claimsOf("PR 71" + LF + LF + "Tests pass"), []);
  assert.deepEqual(claimsOf("the latest 11/17 build, a bypass 3/4 fix"), []);
  assert.deepEqual(claimsOf("see #42" + LF + "tests below"), []);
});

test("7.4.0 #64 V3: the rounds cell is dropped only on the '| tests written |' row of the stats region", () => {
  assert.deepEqual(claimsOf(STATS_HEAD + "| tests written | 12 (3 test rounds) |" + LF + "| code rounds | 1 |" + STATS_END), []);
  assert.deepEqual(claimsOf(STATS_HEAD + "| code rounds | 2 (3 test rounds) |" + STATS_END), ["3 test"]);
  assert.deepEqual(claimsOf("| tests written | 12 (3 test rounds) |"), ["3 test"]);
  assert.deepEqual(claimsOf("We ran (4 test rounds) here."), ["4 test"]);
});

// ownClaims from the source (whole-phrase, word-bounded, case and space folded)
const fnText = SOURCE.slice(SOURCE.indexOf("function ownClaims("), SOURCE.indexOf("\n}\n", SOURCE.indexOf("function ownClaims(")) + 2);
const ownClaims = Function("return (" + fnText + ")")();
// the shipped (aaed9b1) ownClaims, frozen: substring match
const oldOwn = (claims, supplied) => {
  const norm = (x) => String(x).replace(/\s+/g, " ").trim().toLowerCase();
  const text = supplied.map(norm);
  return claims.filter((c) => !text.some((t) => t.indexOf(norm(c)) >= 0));
};

test("7.4.0 #64 V3: the workflow's own stats and test blocks give no claim", async () => {
  const s = happy();
  const out = await runFlow(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const dec = (c) => Buffer.from(inputsOf(c.prompt).args[3], "base64").toString("utf8");
  const tb = dec(out.calls.find((x) => x.label === "infra:pr-tests"));
  const stats = out.calls.filter((x) => /^infra:pr-stats/.test(x.label)).map((c) => dec(c).replace("@@WALL@@", "1h 2m"));
  assert.ok(stats.length >= 1);
  // a CI row and many rounds, as a late run-end refresh writes them
  stats.push(stats[0].replace(/\| tests written \| [^|]*\|/, "| tests written | 147 (12 test rounds) |").replace("| code rounds |", "| CI | green (2 CI-fix rounds, waited 14m) |" + LF + "| code rounds |"));
  for (const st of stats) {
    const g = stubGh("## Summary" + LF + "Text." + LF + LF + tb + LF + LF + st + LF);
    try {
      const x = g.prog("pr_test_block", ["gh", "o/r", "7", b64(tb), "[]"]);
      assert.equal(x.out.error, null, x.out.error);
      assert.deepEqual(x.out.claims, [], st);
    } finally {
      g.done();
    }
  }
});

test("7.4.0 #64 V4: a supplied string exempts only a whole phrase with word bounds", () => {
  assert.deepEqual(ownClaims(["3 tests"], ["AC1 adds 13 tests"]), ["3 tests"]);
  assert.deepEqual(ownClaims(["3 tests"], ["AC1 adds 3 testsuites"]), ["3 tests"]);
  assert.deepEqual(ownClaims(["3 tests"], ["AC1 adds 3  TESTS."]), []);
  assert.deepEqual(ownClaims(["4 tests"], ["only 4 tests cover it"]), []);
  assert.deepEqual(ownClaims(["147 passed"], ["147 passed"]), []);
  // non-weakening: every claim the shipped filter kept is still kept
  const cases = [
    [["3 tests", "13 tests", "4 tests"], ["AC1 adds 13 tests", "only 4 tests"]],
    [["2 tests", "147 passed"], ["x 147 passedy", "12 tests"]],
    [["**3** passed"], ["a **3** passed b"]],
  ];
  for (const [c, s] of cases) for (const k of oldOwn(c, s)) assert.ok(ownClaims(c, s).includes(k), JSON.stringify([k, s]));
});

test("7.4.0 #64 V5: errors null -> 'errors not reported', not added to the total", async () => {
  const F = happy();
  F["role:scope-and-plan"] = Object.assign({}, F["role:scope-and-plan"], { test_cmd: { command: "npm test -- <paths>", paths_placeholder: "<paths>", env: {}, tools: [] } });
  F["role:fleet-code-judge:r1"] = Object.assign({}, F["role:fleet-code-judge:r1"], { suite_result: { command: "pytest", exit_code: 1, passed: 133, failed: 2, errors: null } });
  const out = await runFlow(F, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const c = out.calls.find((x) => x.label === "infra:pr-tests");
  const block = Buffer.from(inputsOf(c.prompt).args[3], "base64").toString("utf8");
  assert.equal(block.split(LF)[1], "**Tests (measured by the fleet):** 133 passed, 2 failed, errors not reported, 135 total.");
});

test("7.4.0 #64 V6: an opener-written stats start above the test block -> pr_body_block error, body unchanged", () => {
  const tpl = "<details><summary>Built with ccpm fleet 7.4.0</summary>" + LF + "wall @@WALL@@" + LF + "</details>" + LF + "<!-- ccpm-fleet-stats -->";
  const body = "## Summary" + LF + "<details><summary>Built with ccpm fleet (by the opener)</summary>" + LF + "text" + LF + "</details>" + LF + LF + BLOCK + LF + LF + tpl.replace("@@WALL@@", "5s") + LF;
  const g = stubGh(body);
  try {
    const x = g.prog("pr_body_block", ["gh", "o/r", "7", b64(tpl), "-", "[]"]);
    assert.equal(x.r.status, 0, x.r.stderr);
    assert.match(String(x.out.error), /^stats region overlaps the test block/);
    assert.equal(x.edits, 0);
    assert.equal(x.stored, body);
  } finally {
    g.done();
  }
  // a stats region after the test block is still replaced
  const ok = stubGh("## Summary" + LF + LF + BLOCK + LF + LF + tpl.replace("@@WALL@@", "5s") + LF);
  try {
    const x = ok.prog("pr_body_block", ["gh", "o/r", "7", b64(tpl), "-", "[]"]);
    assert.equal(x.out.error, null, x.out.error);
    assert.equal(x.stored.split(START).length - 1, 1);
  } finally {
    ok.done();
  }
});

test("7.4.0 #64 V7: halt then resume: the second pr_test_block run keeps one test block and edits nothing", () => {
  const g = stubGh("## Summary" + LF + "Ran 147 tests." + LF);
  try {
    const first = g.prog("pr_test_block", ["gh", "o/r", "7", b64(BLOCK), "[]"]);
    assert.equal(first.out.error, null, first.out.error);
    assert.deepEqual(first.out.claims, ["147 tests"], "the claim stop of the first run");
    assert.equal(first.edits, 1);
    const again = g.prog("pr_test_block", ["gh", "o/r", "7", b64(BLOCK), "[]"]);
    assert.equal(again.out.error, null, again.out.error);
    assert.equal(again.out.edited, false);
    assert.equal(again.out.replaced, true);
    assert.equal(again.edits, 1, "no second edit");
    assert.equal(again.stored.split(START).length - 1, 1);
    assert.deepEqual(again.out.claims, ["147 tests"]);
  } finally {
    g.done();
  }
});
