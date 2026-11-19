// fleet 7.4.0 car 6 (#64 item 2, Max ruling on the car-5 deviation): two ordinal forms are no
// test-count claim any more:
// - "test N of AC<k>" (singular "test", then a number, "of", then "AC" and digits);
// - "Step N tests" / "step N tests" followed by a word that is not a number.
// Only the span of that exact form is exempt: a real claim on the same line ("Step 2 tests the
// parser; 5 tests pass") stays a claim, and "test 2 of 5" is no ordinal form. Every other
// refusal of the car-5 program (1565a52, frozen below as a Python copy of its claim patterns)
// stays: for each corpus line, new claims = old claims minus the claims inside an ordinal span.
//
// dont_care: the order of claims beyond sorted-by-start.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCRIPTS_SRC, spawnSync } from "./harness.mjs";

const PY = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
const LF = "\n";
const START = "<!-- ccpm-fleet-tests -->";
const END = "<!-- /ccpm-fleet-tests -->";
const BLOCK = [START, "**Tests (measured by ccpmcwf):** 133 passed, 0 failed, 0 errors, 133 total.", "Command: `npm test`", END].join(LF);
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

// the claims of 'Intro.' + block + text through the real program (a stub gh serves the body)
function claimsOf(text) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-740o-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(dir, "stored.txt"), "Intro." + LF + LF + BLOCK + LF + text + LF);
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
    const r = spawnSync(PY, ["-I", join(SCRIPTS_SRC, "pr_test_block.py"), "gh", "o/r", "7", b64(BLOCK), "[]"], { encoding: "utf8", env: { PATH: bin, HOME: bin }, timeout: 120000 });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.error, null, out.error);
    return out.claims;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// the car-5 (1565a52) claim patterns and claims_of, frozen (block regions and the stats skip kept)
const OLD = String.raw`
import json, re, sys
START, END = '<!-- ccpm-fleet-tests -->', '<!-- /ccpm-fleet-tests -->'
REGION = re.compile(re.escape(START) + r'.*?' + re.escape(END), re.S)
P1 = re.compile(r'(?<![0-9A-Za-z_.,])[0-9][0-9,]*[ \t]+(?:tests?|passed|passing|failed|failing)\b', re.I)
P2 = re.compile(r'\b(?:tests?|pass(?:ed)?|fail(?:ed)?)(?:[ \t]*[:=][ \t]*|[ \t]+)[0-9]+(?![0-9]|[.,][0-9])', re.I)
SP = '[ \\t' + chr(0xa0) + ']'
WS = '(?:' + SP + '+\\n?' + SP + '*|\\n' + SP + '*)'
NOUN = r'(?:tests?|pass(?:ed|ing)?|fail(?:ed|ing)?)\b'
P1N = re.compile(r'(?<![0-9A-Za-z_.,*` + "`" + String.raw`~#])[*_` + "`" + String.raw`~]*[0-9][0-9,]*\+?[*_` + "`" + String.raw`~]*' + WS + '(?:[A-Za-z][A-Za-z-]*' + WS + ')?' + NOUN, re.I)
P2N = re.compile(r'\b' + NOUN[:-2] + r'(?:[ \t]*[:=][ \t]*|[ \t]+)[0-9]+(?![0-9]|[.,][0-9])', re.I)
P3 = re.compile(r'(?<![0-9A-Za-z_.,/])[0-9]+(?:[ \t]*/[ \t]*|[ \t]+of[ \t]+)[0-9]+(?![0-9/]|[.,][0-9])', re.I)
NEAR = re.compile(r'\b' + NOUN, re.I)
ROUNDS = ' rounds)'
STATS = re.compile(re.escape('<details><summary>Built with ccpm fleet') + r'.*?' + re.escape('<!-- ccpm-fleet-stats -->'), re.S)
def claims_of(text):
    text = REGION.sub('\n', text)
    stats = [m.span() for m in STATS.finditer(text)]
    def rounds_cell(m):
        ls = text.rfind('\n', 0, m.start()) + 1
        return text.startswith(ROUNDS, m.end()) and text.startswith('| tests written |', ls) and any(a <= m.start() < b for a, b in stats)
    def near(m):
        ls = text.rfind('\n', 0, m.start()) + 1
        le = text.find('\n', m.end())
        return NEAR.search(text[max(ls, m.start() - 40):min(len(text) if le < 0 else le, m.end() + 40)]) is not None
    hits, at = [], set()
    for p in (P1, P2, P1N, P2N, P3):
        for m in p.finditer(text):
            if p in (P1, P1N) and rounds_cell(m):
                continue
            if p is P3 and not near(m):
                continue
            if p in (P1N, P2N, P3) and m.start() in at:
                continue
            at.add(m.start())
            hits.append((m.start(), m.end(), ' '.join(m.group(0).split())[:80]))
    return sorted(hits)
print(json.dumps([claims_of(t) for t in json.loads(sys.stdin.read())]))
`;
function oldHits(texts) {
  const r = spawnSync(PY, ["-I", "-c", OLD], { input: JSON.stringify(texts.map((t) => "Intro." + LF + LF + BLOCK + LF + t + LF)), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
// the exact ordinal spans of a body (the test's own statement of the ruling)
function ordinalSpans(text) {
  const out = [];
  for (const re of [/(?<![A-Za-z0-9_])[Tt]est[ \t]+[0-9]+[ \t]+of[ \t]+AC[0-9]+(?![A-Za-z0-9_])/g, /(?<![A-Za-z0-9_])[Ss]tep[ \t]+[0-9]+[ \t]+tests[ \t]+(?=[A-Za-z])/g])
    for (const m of text.matchAll(re)) out.push([m.index, m.index + m[0].length]);
  return out;
}

test("7.4.0 #64 item 2: 'test N of AC<k>' and 'Step N tests <word>' are no claim", () => {
  assert.deepEqual(claimsOf("See test 2 of AC3."), []);
  assert.deepEqual(claimsOf("Step 2 tests the parser."), []);
  assert.deepEqual(claimsOf("step 3 tests that the cache is cold."), []);
  assert.deepEqual(claimsOf("Test 1 of AC12 covers the refusal."), []);
});

test("7.4.0 #64 item 2: only the ordinal span is exempt; real count claims stay claims", () => {
  // a real claim on the same line as an ordinal form
  assert.deepEqual(claimsOf("Step 2 tests the parser; 5 tests pass."), ["5 tests"]);
  assert.deepEqual(claimsOf("test 2 of AC3, and 12 passed"), ["12 passed"]);
  // near-misses are not the exact forms: still claims
  assert.deepEqual(claimsOf("See test 2 of 5."), ["test 2", "2 of 5"]);
  assert.deepEqual(claimsOf("tests 2 of AC3"), ["tests 2"]);
  assert.deepEqual(claimsOf("Step 2 tests 5 cases."), ["2 tests", "tests 5"]);
  assert.deepEqual(claimsOf("Step 2 tests."), ["2 tests"]);
  assert.deepEqual(claimsOf("Steps 2 tests the parser."), ["2 tests"]);
  assert.deepEqual(claimsOf("Step 2 tests: 7"), ["2 tests", "tests: 7"]);
  // the count forms Max named stay claims
  assert.deepEqual(claimsOf("2 tests pass"), ["2 tests"]);
  assert.deepEqual(claimsOf("tests: 5 passed"), ["tests: 5", "5 passed"]);
  assert.ok(claimsOf("12/12 tests").includes("12/12"));
  assert.deepEqual(claimsOf("AC1 has 3 tests."), ["3 tests"]);
});

test("7.4.0 #64 item 2: against the frozen car-5 program, every claim stays except those inside an ordinal span", () => {
  const corpus = [
    "See test 2 of AC3.",
    "Step 2 tests the parser.",
    "Step 2 tests the parser; 5 tests pass.",
    "See test 2 of 5.",
    "Step 2 tests 5 cases.",
    "2 tests pass",
    "tests: 5 passed",
    "12/12 tests",
    "Ran 147 unit tests and **147** passed.",
    "3 pass and 2 fail",
    "passing: 5",
    "147 of 150 tests",
    "test 2 of AC3 then test 4 of AC3; 9 failed",
    "Step 1 tests x" + LF + "Step 2 tests 3 inputs",
    "No numbers here.",
    "| tests written | 4 (2 test rounds) |",
  ];
  const old = oldHits(corpus);
  for (let i = 0; i < corpus.length; i++) {
    const body = "Intro." + LF + LF + BLOCK + LF + corpus[i] + LF;
    // the program maps the block region to one LF: spans are measured on that text
    const text = body.replace(BLOCK, LF);
    const spans = ordinalSpans(text);
    const want = [];
    for (const [s, e, c] of old[i]) if (!spans.some(([a, b]) => a <= s && e <= b) && want.indexOf(c) < 0) want.push(c);
    assert.deepEqual(claimsOf(corpus[i]), want, JSON.stringify(corpus[i]));
  }
});
