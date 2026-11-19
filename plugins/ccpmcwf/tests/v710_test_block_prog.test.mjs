// fleet 7.1.0 (L2145, yaadgaar #37), AC1: pr_test_block.py writes exactly one
// script-written test block into the PR body and leaves every other byte alone.
// It refuses bad arguments, a bad block and unpaired or forged markers, reports
// gh failures and a changed re-read in `error`, and runs gh with the rlimits
// lifted (AC1 ex19 is the pr_test_block row of v632_gh_rlimit GH_PROGRAMS).
//
// Expected values come only from the plan's AC1 examples.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { SCRIPTS_SRC, spawnSync } from "./harness.mjs";

const PY = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
const PROG = join(SCRIPTS_SRC, "pr_test_block.py");
const LF = "\n";
const START = "<!-- ccpm-fleet-tests -->";
const END = "<!-- /ccpm-fleet-tests -->";
const BLOCK = [START, "**Tests (measured by ccpmcwf):** 133 passed, 0 failed, 0 errors, 133 total.", "Command: `npm test`", END].join(LF);
const OLD = [START, "**Tests (measured by ccpmcwf):** 140 passed, 0 failed, 0 errors, 140 total.", "Command: `npm test`", END].join(LF);
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const B64 = b64(BLOCK);
const USAGE = "usage: pr_test_block.py <gh|gh-personal> <owner/repo> <pr> <block_b64> <headers_json>";
const UNPAIRED = "the PR body holds an unpaired test block marker";

// A stub gh. cfg: {body, view_fail?, edit_fail?, reread_suffix?, reread_drop_line?}.
// `pr view` prints {"body": <stored>} (after an edit, optionally changed);
// `pr edit --body-file F` stores F. Every call is logged.
function setup(cfg) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-710-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(dir, "cfg.json"), JSON.stringify(cfg));
  writeFileSync(join(dir, "stored.txt"), cfg.body ?? "");
  const f = join(bin, "gh");
  writeFileSync(
    f,
    "#!" + PY + "\nimport json, os, sys\n" +
      "d = " + JSON.stringify(dir) + "\n" +
      "cfg = json.load(open(os.path.join(d, 'cfg.json')))\n" +
      "argv = sys.argv[1:]\n" +
      "open(os.path.join(d, 'log.jsonl'), 'a').write(json.dumps({'argv': argv}) + '\\n')\n" +
      "edited = os.path.exists(os.path.join(d, 'edited'))\n" +
      "if argv[:2] == ['pr', 'view']:\n" +
      "    if cfg.get('view_fail'):\n        sys.stderr.write(cfg['view_fail'])\n        sys.exit(1)\n" +
      "    b = open(os.path.join(d, 'stored.txt'), newline='').read()\n" +
      "    if edited and cfg.get('reread_suffix'):\n        b = b + cfg['reread_suffix']\n" +
      "    if edited and cfg.get('reread_drop_line'):\n        b = '\\n'.join(l for l in b.split('\\n') if l != cfg['reread_drop_line'])\n" +
      "    sys.stdout.write(json.dumps({'body': b}))\n" +
      "elif argv[:2] == ['pr', 'edit']:\n" +
      "    if cfg.get('edit_fail'):\n        sys.stderr.write(cfg['edit_fail'])\n        sys.exit(1)\n" +
      "    i = argv.index('--body-file')\n" +
      "    open(os.path.join(d, 'stored.txt'), 'w', newline='').write(open(argv[i + 1], newline='').read())\n" +
      "    open(os.path.join(d, 'edited'), 'w').write('1')\n" +
      "else:\n    sys.exit(3)\n",
  );
  chmodSync(f, 0o755);
  return { dir, bin };
}
function run(env, args) {
  const r = spawnSync(PY, ["-I", PROG].concat(args), { encoding: "utf8", env: { PATH: env.bin, HOME: env.bin }, timeout: 120000 });
  const logp = join(env.dir, "log.jsonl");
  const log = existsSync(logp) ? readFileSync(logp, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const stored = readFileSync(join(env.dir, "stored.txt"), "utf8");
  let out = { program: {} };
  try {
    out = JSON.parse(r.stdout);
  } catch {}
  return { r, log, stored, out, edits: log.filter((c) => c.argv[1] === "edit") };
}
function withStub(cfg, fn) {
  const env = setup(cfg);
  try {
    return fn(env);
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
}
const go = (body, headers = "[]", extra = {}) => withStub({ body, ...extra }, (env) => run(env, ["gh", "o/r", "7", B64, headers]));
const lastLine = (s) => s.trim().split("\n").pop();

test("AC1 ex1: a body with no block gets the block appended; one pr edit; the printed JSON", () => {
  const g = go("## Summary" + LF + "Text.", '["## Summary"]');
  assert.equal(g.r.status, 0, g.r.stderr);
  assert.equal(g.edits.length, 1);
  assert.equal(g.stored, "## Summary" + LF + "Text." + LF + LF + BLOCK + LF);
  assert.equal(g.out.replaced, false);
  assert.equal(g.out.edited, true);
  assert.equal(g.out.block_sha256, sha(BLOCK));
  assert.deepEqual(g.out.claims, []);
  assert.equal(g.out.claims_truncated, false);
  assert.deepEqual(g.out.headers_missing, []);
  assert.equal(g.out.error, null);
  assert.deepEqual(g.out.args, ["gh", "o/r", "7", B64, '["## Summary"]']);
  assert.equal(g.out.program.name, "pr_test_block");
  assert.match(g.out.digest, /^[0-9a-f]{64}$/);
});

test("AC1 ex2: an old block is replaced in place; A and B stay byte-identical", () => {
  const g = go("A" + LF + LF + OLD + LF + LF + "B" + LF);
  assert.equal(g.stored, "A" + LF + LF + BLOCK + LF + LF + "B" + LF);
  assert.equal(g.out.replaced, true);
  assert.equal(g.out.edited, true);
  assert.equal(g.out.error, null);
});

test("AC1 ex3: two blocks leave one; the second region is removed", () => {
  const g = go("A" + LF + BLOCK + LF + "B" + LF + OLD + LF + "C");
  assert.equal(g.stored.split(START).length - 1, 1);
  assert.equal(g.stored, "A" + LF + BLOCK + LF + "B" + LF + LF + "C");
  assert.equal(g.out.replaced, true);
  assert.equal(g.out.error, null);
});

test("AC1 ex4: a body that is already the wanted body gets no edit", () => {
  const g = go("## Summary" + LF + "Text." + LF + LF + BLOCK + LF);
  assert.equal(g.edits.length, 0);
  assert.equal(g.out.replaced, true);
  assert.equal(g.out.edited, false);
  assert.equal(g.out.error, null);
});

test("AC1 ex5: an empty body becomes the block and one LF", () => {
  const g = go("");
  assert.equal(g.stored, BLOCK + LF);
  assert.equal(g.out.replaced, false);
  assert.equal(g.out.edited, true);
  assert.equal(g.out.error, null);
});

function refused(args, msg) {
  const g = withStub({ body: "any" }, (env) => run(env, args));
  assert.equal(g.r.status, 1, args.join(" "));
  assert.equal(lastLine(g.r.stderr), msg, args.join(" "));
  assert.equal(g.log.length, 0, args.join(" "));
}

test("AC1 ex6: four arguments exit 1 with the usage line and no gh call", () => {
  refused(["gh", "o/r", "7", B64], USAGE);
});

test("AC1 ex7: a gh command other than gh or gh-personal exits 1 with the usage line", () => {
  refused(["sh", "o/r", "7", B64, "[]"], USAGE);
});

test("AC1 ex8: a bad slug and a PR number with a leading zero exit 1 with the usage line", () => {
  refused(["gh", "o/r;x", "7", B64, "[]"], USAGE);
  refused(["gh", "o/r", "07", B64, "[]"], USAGE);
});

test("AC1 ex9: a block that is not base64 exits 1", () => {
  refused(["gh", "o/r", "7", "!!", "[]"], "the block is not base64 UTF-8 or the headers are not JSON");
});

test("AC1 ex10: headers that are not a list of strings exit 1", () => {
  refused(["gh", "o/r", "7", B64, '{"a":1}'], "headers must be a list of strings");
});

test("AC1 ex11: a block without markers exits 1", () => {
  refused(["gh", "o/r", "7", b64("no markers"), "[]"], "the block must start with the start marker, end with the end marker and hold each once");
});

test("AC1 ex12: a start marker with no end marker makes no edit; error; claims []", () => {
  const g = go("A" + LF + START + LF + "forged 999 passed");
  assert.equal(g.r.status, 0, g.r.stderr);
  assert.equal(g.edits.length, 0);
  assert.equal(g.out.error, UNPAIRED);
  assert.deepEqual(g.out.claims, []);
});

test("AC1 ex13: a second start marker inside a region makes no edit", () => {
  const g = go(START + LF + "x" + LF + START + LF + "y" + LF + END);
  assert.equal(g.edits.length, 0);
  assert.equal(g.out.error, UNPAIRED);
});

test("AC1 ex14: an end marker outside every region makes no edit", () => {
  const g = go("A" + LF + END);
  assert.equal(g.edits.length, 0);
  assert.equal(g.out.error, UNPAIRED);
});

test("AC1 ex15: gh pr view fails: exit 0, error names it, claims [], edited false", () => {
  const g = go("x", "[]", { view_fail: "HTTP 502" });
  assert.equal(g.r.status, 0, g.r.stderr);
  assert.ok(g.out.error.startsWith("gh pr view: "), g.out.error);
  assert.ok(g.out.error.includes("HTTP 502"), g.out.error);
  assert.deepEqual(g.out.claims, []);
  assert.equal(g.out.edited, false);
});

test("AC1 ex16: gh pr edit fails: exit 0, error names it, claims []", () => {
  const g = go("x", "[]", { edit_fail: "HTTP 422" });
  assert.equal(g.r.status, 0, g.r.stderr);
  assert.ok(g.out.error.startsWith("gh pr edit: "), g.out.error);
  assert.ok(g.out.error.includes("HTTP 422"), g.out.error);
  assert.deepEqual(g.out.claims, []);
});

test("AC1 ex17: a re-read changed by another writer is an error", () => {
  const g = go("## Summary", "[]", { reread_suffix: "X" });
  assert.equal(g.out.error, "the re-read body is not the body written (the block is missing, doubled or the rest changed)");
});

test("AC1 ex18: a re-read that lost a header names it", () => {
  const g = go("## Summary" + LF + "Text.", '["## Summary"]', { reread_drop_line: "## Summary" });
  assert.equal(g.out.error, "the re-read body lost header(s): ## Summary");
  assert.deepEqual(g.out.headers_missing, ["## Summary"]);
});

test("AC1 property: a second run on the body the first run wrote makes no pr edit", () => {
  for (const body of ["## Summary" + LF + "Text.", "", "A" + LF + LF + OLD + LF + LF + "B" + LF, "A" + LF + BLOCK + LF + "B" + LF + OLD + LF + "C"]) {
    const env = setup({ body });
    try {
      const a = run(env, ["gh", "o/r", "7", B64, "[]"]);
      assert.equal(a.out.error, null, a.r.stderr);
      const written = a.stored;
      const n = a.edits.length;
      const b = run(env, ["gh", "o/r", "7", B64, "[]"]);
      assert.equal(b.out.error, null, b.r.stderr);
      assert.equal(b.edits.length, n, "no second edit");
      assert.equal(b.out.edited, false);
      assert.equal(b.stored, written);
    } finally {
      rmSync(env.dir, { recursive: true, force: true });
    }
  }
});
