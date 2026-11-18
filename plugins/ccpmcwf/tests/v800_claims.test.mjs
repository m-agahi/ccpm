// fleet 8.0.0 car A (yaadgaar #74): pr_test_block claims_of drops three named false-positive forms
// and nothing else:
// - a claim whose whole match lies inside an inline code span (a backtick run of length n, text on
//   the same line, a backtick run of exactly length n);
// - a claim whose whole match lies inside a closed fenced code block (a line of 3+ backticks or 3+
//   tildes, up to 3 spaces indent, a backtick fence with no backtick after it; closed by a line of
//   the same character, at least as long, then only spaces or tabs). An unclosed fence exempts nothing;
// - a claim that starts right after the word `timeout` and spaces or tabs (`timeout 1800 npm test`).
// A claim that only partly lies in a code span stays: "`12` tests" is still a claim (7.4.0 #64).
// Quoted prose is no named form: PR 74's "133 unit tests" stays a claim.
// Corpus: the bodies of merged PRs 73-78 (tests/fixtures/pr<n>.body.txt). Non-weakening: the 7.4.0
// program (931e844, frozen as tests/fixtures/pr_test_block_740.py) is run beside the new one; new
// claims = old claims minus the claims in a named form, for every corpus body and synthetic line.
//
// dont_care: the order of claims beyond sorted-by-start.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERE, SCRIPTS_SRC, spawnSync } from "./harness.mjs";

const PY = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
const LF = "\n";
const BT = "`";
const START = "<!-- ccpm-fleet-tests -->";
const END = "<!-- /ccpm-fleet-tests -->";
const BLOCK = [START, "**Tests (measured by the fleet):** 133 passed, 0 failed, 0 errors, 133 total.", "Command: " + BT + "npm test" + BT, END].join(LF);
const REGION = /<!-- ccpm-fleet-tests -->[\s\S]*?<!-- \/ccpm-fleet-tests -->/g;
const FIX = join(HERE, "fixtures");
const OLD_PROG = join(FIX, "pr_test_block_740.py");
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

// the stored body: a text with a block region keeps it (that region is the block passed); else BLOCK is appended
function stored(text) {
  const m = text.match(/<!-- ccpm-fleet-tests -->[\s\S]*?<!-- \/ccpm-fleet-tests -->/);
  return m ? { body: text, block: m[0] } : { body: text + LF + BLOCK + LF, block: BLOCK };
}
// the claims of a stored body through a real program (a stub gh serves the body; an edit exits 3)
function claimsBy(prog, text) {
  const { body, block } = stored(text);
  const dir = mkdtempSync(join(tmpdir(), "fleet-800c-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(dir, "stored.txt"), body);
    const f = join(bin, "gh");
    writeFileSync(
      f,
      "#!" + PY + "\nimport json, os, sys\n" +
        "d = " + JSON.stringify(dir) + "\n" +
        "argv = sys.argv[1:]\n" +
        "if argv[:2] == ['pr', 'view']:\n" +
        "    sys.stdout.write(json.dumps({'body': open(os.path.join(d, 'stored.txt'), newline='').read()}))\n" +
        "else:\n    sys.exit(3)\n",
    );
    chmodSync(f, 0o755);
    const r = spawnSync(PY, ["-I", prog, "gh", "o/r", "7", b64(block), "[]"], { encoding: "utf8", env: { PATH: bin, HOME: bin }, timeout: 120000 });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.error, null, out.error);
    assert.equal(out.edited, false);
    return out.claims;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const claimsOf = (text) => claimsBy(join(SCRIPTS_SRC, "pr_test_block.py"), text);

// the frozen 7.4.0 claims_of, with each hit's (start, end, text): its own source, two lines patched
const OLD_HITS = String.raw`
import json, re, sys
src = open(sys.argv[1], encoding='utf-8').read()
a = src.index("START, END = ")
b = src.index("def body():")
c = src.index("def claims_of(text):")
d = src.index("try:\n    before = body()")
fn = src[c:d]
for old, new in (("hits.append((m.start(), ", "hits.append((m.start(), m.end(), "), ("    seen, size = [], 0\n", "    return sorted(hits)\n")):
    assert fn.count(old) == 1, old
    fn = fn.replace(old, new)
ns = {}
exec("import re\n" + src[a:src.index("args = sys.argv[1:]")] + src[src.index("REGION = re.compile"):b] + fn, ns)
print(json.dumps([ns['claims_of'](t) for t in json.loads(sys.stdin.read())]))
`;
function oldHits(texts) {
  const r = spawnSync(PY, ["-I", "-c", OLD_HITS, OLD_PROG], { input: JSON.stringify(texts.map((t) => stored(t).body)), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

// the test's own statement of the named forms, on the text claims_of reads (block regions as one LF)
function codeSpans(text) {
  const out = [];
  let at = 0;
  let fence = null;
  for (const line of text.split(LF)) {
    if (!fence) {
      const m = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (m && !(m[1][0] === BT && line.slice(m[0].length).indexOf(BT) >= 0)) fence = { ch: m[1][0], n: m[1].length, at };
    } else {
      const m = line.match(/^ {0,3}(`+|~+)[ \t]*$/);
      if (m && m[1][0] === fence.ch && m[1].length >= fence.n) {
        out.push([fence.at, at + line.length]);
        fence = null;
      }
    }
    at += line.length + 1;
  }
  for (const m of text.matchAll(/(?<!`)(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g)) out.push([m.index, m.index + m[0].length]);
  return out;
}
function expected(text, hits) {
  const t = stored(text).body.replace(REGION, LF);
  const spans = codeSpans(t);
  const want = [];
  for (const [s, e, c] of hits) {
    if (spans.some(([a, b]) => a <= s && e <= b)) continue;
    if (/(?<![A-Za-z0-9_-])timeout[ \t]+$/.test(t.slice(Math.max(0, s - 200), s))) continue;
    if (want.indexOf(c) < 0) want.push(c);
  }
  return want;
}

const CORPUS = [73, 74, 75, 76, 77, 78].map((n) => [n, readFileSync(join(FIX, "pr" + n + ".body.txt"), "utf8")]);
// every real count phrase in the six bodies (hand-listed); each one must still be a claim
const KEEP = {
  73: ["1543 passed", "0 failed"],
  74: ["147 passed", "104 tests", "tests: 15", "15 pass", "89 fail", "1631 tests", "tests: 1631", "1631 pass", "0 fail", "143 tests", "133 unit tests", "502 failed"],
  75: ["27 tests", "7 pass", "20 fail", "27 of 27", "27 pass", "1658 tests", "1658 pass", "0 fail"],
  76: ["36 new tests", "34 failing", "40 tests", "40 passing", "892 tests", "892 passing", "**1698 tests", "1698 tests", "1698 pass", "0 fail"],
  77: ["1804/1804", "1804 pass"],
  78: ["2016/2016", "2016 pass"],
};

test("8.0.0 #74: the PR 73-78 corpus keeps every real count claim; only PR 76's `timeout 1800 npm test` is dropped", () => {
  for (const [n, text] of CORPUS) {
    const nw = claimsOf(text);
    assert.deepEqual(nw, KEEP[n], "PR " + n);
    const old = claimsBy(OLD_PROG, text);
    const gone = old.filter((c) => nw.indexOf(c) < 0);
    assert.deepEqual(gone, n === 76 ? ["1800 npm test"] : [], "PR " + n + " dropped " + JSON.stringify(gone));
  }
});

test("8.0.0 #74: claims inside a code span or a closed fence, and right after timeout, are no claim", () => {
  assert.deepEqual(claimsOf("Run " + BT + "systemd-run timeout 1800 npm test" + BT + " in plugins/ccpmcwf."), []);
  assert.deepEqual(claimsOf("Ran " + BT + "pytest -n 4 tests/" + BT + "."), []);
  assert.deepEqual(claimsOf("Ran " + BT + BT + "x ` 12 tests" + BT + BT + " once."), []);
  assert.deepEqual(claimsOf("```" + LF + "1804 passed" + LF + "```"), []);
  assert.deepEqual(claimsOf("```text" + LF + "ok 5 tests" + LF + "```" + LF + "after"), []);
  assert.deepEqual(claimsOf("~~~" + LF + "5 tests, 3 fail" + LF + "~~~"), []);
  assert.deepEqual(claimsOf("````" + LF + "```" + LF + "3 tests" + LF + "```" + LF + "````"), []);
  assert.deepEqual(claimsOf("The suite ran under timeout 1800 npm test."), []);
});

test("8.0.0 #74: near misses stay claims", () => {
  // a claim that only partly lies in a code span (7.4.0 #64)
  assert.deepEqual(claimsOf(BT + "12" + BT + " tests"), [BT + "12" + BT + " tests"]);
  // a claim next to a code span
  assert.deepEqual(claimsOf(BT + "npm test" + BT + " ran 5 tests"), ["5 tests"]);
  assert.deepEqual(claimsOf(BT + "5 tests" + BT + " and 6 tests"), ["6 tests"]);
  // an unclosed fence exempts nothing; a claim right after a closed fence stays
  assert.deepEqual(claimsOf("```" + LF + "5 tests"), ["5 tests"]);
  assert.deepEqual(claimsOf("```" + LF + "x" + LF + "```" + LF + "7 tests"), ["7 tests"]);
  // a fence closed by the other character, or a shorter run, is not closed
  assert.deepEqual(claimsOf("````" + LF + "x" + LF + "```" + LF + "8 tests"), ["8 tests"]);
  assert.deepEqual(claimsOf("~~~" + LF + "x" + LF + "```" + LF + "9 tests"), ["9 tests"]);
  // a lone backtick opens no span
  assert.deepEqual(claimsOf("a ` b 4 tests"), ["4 tests"]);
  // a code span does not run over a line end
  assert.deepEqual(claimsOf(BT + "a" + LF + "3 tests " + BT), ["3 tests"]);
  // timeout must be the word right before the number
  assert.deepEqual(claimsOf("15 tests; timeout 1800 npm test"), ["15 tests"]);
  assert.deepEqual(claimsOf("no timeout; 30 tests pass"), ["30 tests"]);
  assert.deepEqual(claimsOf("mytimeout 30 tests"), ["30 tests"]);
  assert.deepEqual(claimsOf("timeout: 30 tests"), ["30 tests"]);
  // quoted prose is no named form
  assert.deepEqual(claimsOf('P1/P2 miss "133 unit tests".'), ["133 unit tests"]);
});

test("8.0.0 #74: against the frozen 7.4.0 program, every claim stays except those in a named form", () => {
  const syn = [
    "Run " + BT + "systemd-run timeout 1800 npm test" + BT + "; 1698 tests, 1698 pass.",
    BT + "12" + BT + " tests and " + BT + "5 tests" + BT + " and 6 tests",
    "```" + LF + "1804 passed" + LF + "```" + LF + "1804/1804 pass",
    "~~~" + LF + "5 tests" + LF + "~~~~" + LF + "27 of 27 tests",
    "```" + LF + "5 tests",
    "timeout 30 tests; timeout: 30 tests; 2 tests pass",
    "See test 2 of AC3. Step 2 tests the parser; 5 tests pass.",
    "| tests written | 4 (2 test rounds) |",
    "No numbers here.",
  ];
  const texts = CORPUS.map((x) => x[1]).concat(syn);
  const old = oldHits(texts);
  let dropped = 0;
  for (let i = 0; i < texts.length; i++) {
    const want = expected(texts[i], old[i]);
    dropped += old[i].length - want.length;
    assert.deepEqual(claimsOf(texts[i]), want, JSON.stringify(texts[i].slice(0, 80)));
  }
  assert.ok(dropped >= 6, "the corpus exercises the named forms: " + dropped);
});
