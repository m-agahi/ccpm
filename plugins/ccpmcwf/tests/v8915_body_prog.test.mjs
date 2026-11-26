// ccpmcwf 8.9.15 (yaadgaar #131, #130): pr_state.py body, the read-only PR body facts.
// headers_missing: given headers and the template's heading lines that are no line of the body;
// short: under min_chars; quotes: 12+ characters after whitespace collapse, present (no case
// folding) in the body with the script-written blocks and every heading line removed; checks: the
// named checks' buckets (fail, else pending, else pass, else missing). The PR must be OPEN at <sha>.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, realpathSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCRIPTS_SRC, spawnSync } from "./harness.mjs";

const PY = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
const PROG = join(SCRIPTS_SRC, "pr_state.py");
const SHA = "a".repeat(40);
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const BODY = [
  "## Summary",
  "The change adds two RPCs",
  "and   keeps the old ones.",
  "## Breaking?",
  "maybe",
  "<!-- ccpm-fleet-tests -->",
  "**Tests (measured by ccpmcwf):** 133 passed, 0 failed, 0 errors, 133 total.",
  "<!-- /ccpm-fleet-tests -->",
  "<details><summary>Built with ccpmcwf 8.9.15</summary>",
  "| agents | 40 |",
  "</details>",
  "<!-- ccpm-fleet-stats -->",
].join("\r\n");
const TEMPLATE = "## Summary\n\n## Breaking?\n\n## Testing\n";

// a stub gh: `pr view` prints the cfg's PR; `api .../contents/...` the template; `pr checks` the runs
function setup(cfg) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-8915-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(dir, "cfg.json"), JSON.stringify(cfg));
  const f = join(bin, "gh");
  writeFileSync(
    f,
    "#!" + PY + "\nimport json, os, sys, base64\n" +
      "cfg = json.load(open(" + JSON.stringify(join(dir, "cfg.json")) + "))\n" +
      "argv = sys.argv[1:]\n" +
      "open(" + JSON.stringify(join(dir, "log.jsonl")) + ", 'a').write(json.dumps(argv) + '\\n')\n" +
      "if argv[:2] == ['pr', 'view']:\n    sys.stdout.write(json.dumps({'body': cfg['body'], 'headRefOid': cfg.get('head', '" + SHA + "'), 'state': cfg.get('state', 'OPEN')}))\n" +
      "elif argv[:1] == ['api']:\n" +
      "    if cfg.get('template') is None:\n        sys.stderr.write('HTTP 404'); sys.exit(1)\n" +
      "    sys.stdout.write(json.dumps({'content': base64.b64encode(cfg['template'].encode()).decode()}))\n" +
      "elif argv[:2] == ['pr', 'checks']:\n    sys.stdout.write(json.dumps(cfg.get('checks', [])))\n" +
      "else:\n    sys.exit(3)\n",
  );
  chmodSync(f, 0o755);
  return { dir, bin };
}
function body(cfg, spec, prog) {
  const e = setup(cfg);
  try {
    const sp = Object.assign({ headers: [], template: null, min_chars: null, quotes: [], checks: [] }, spec);
    const r = spawnSync(PY, ["-I", prog || PROG, "body", "gh", "o/r", "7", SHA, b64(JSON.stringify(sp))], { encoding: "utf8", env: { PATH: e.bin + ":" + process.env.PATH, HOME: e.dir }, timeout: 120000 });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    const log = existsSync(join(e.dir, "log.jsonl")) ? readFileSync(join(e.dir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
    return { o, log };
  } finally {
    rmSync(e.dir, { recursive: true, force: true });
  }
}

test("8.9.15 pr_state body: headers from the spec and the template; a heading present in the body is not missing", () => {
  const { o, log } = body({ body: BODY, template: TEMPLATE }, { headers: ["## Summary", "## Notes"], template: { repo: "o/r", path: ".github/pull_request_template.md", ref: SHA } });
  assert.equal(o.error, null);
  assert.deepEqual(o.headers_missing, ["## Notes", "## Testing"]);
  assert.equal(o.template_read, true);
  assert.equal(o.mode, "body");
  assert.equal(o.head, SHA);
  assert.ok(log.some((a) => a[0] === "api" && a[1] === "repos/o/r/contents/.github/pull_request_template.md?ref=" + SHA), JSON.stringify(log));
});

test("8.9.15 pr_state body: an unreadable template reports template_read false and only the spec's headers", () => {
  const { o } = body({ body: BODY, template: null }, { headers: ["## Notes"], template: { repo: "q/.github", path: ".github/pull_request_template.md", ref: null } });
  assert.equal(o.error, null);
  assert.equal(o.template_read, false);
  assert.deepEqual(o.headers_missing, ["## Notes"]);
});

test("8.9.15 pr_state body: quotes are whitespace-collapsed, 12+ characters, case-sensitive, outside headings and the fleet's blocks", () => {
  const quotes = [
    "The change adds two RPCs and keeps the old ones.", // across lines and runs of spaces: present
    "the change adds two rpcs", // case differs: absent
    "two RPCs", // under 12 characters: absent
    "## Breaking? maybe", // spans a heading line: absent
    "133 passed, 0 failed", // inside the test block: absent
    "| agents | 40 |", // inside the stats block: absent
    "nothing like this is here",
  ];
  const { o } = body({ body: BODY }, { quotes });
  assert.equal(o.error, null);
  assert.deepEqual(o.quotes, [true, false, false, false, false, false, false]);
});

test("8.9.15 pr_state body: min_chars makes short; checks report fail, then pending, then pass, else missing", () => {
  const checks = [
    { name: "check", workflow: "PR body", bucket: "pass" },
    { name: "check", workflow: "PR body", bucket: "fail" },
    { name: "template", workflow: "ci", bucket: "pending" },
    { name: "lint", workflow: "ci", bucket: "pass" },
  ];
  const { o } = body({ body: "short body", checks }, { min_chars: 50, checks: ["PR body / check", "template", "lint", "gone"] });
  assert.equal(o.error, null);
  assert.equal(o.short, true);
  assert.deepEqual(o.checks, [
    { name: "PR body / check", bucket: "fail" },
    { name: "template", bucket: "pending" },
    { name: "lint", bucket: "pass" },
    { name: "gone", bucket: "missing" },
  ]);
  assert.equal(body({ body: "x".repeat(50) }, { min_chars: 50 }).o.short, false);
  assert.equal(body({ body: BODY }, {}).o.short, null);
});

test("8.9.15 pr_state body: a PR not OPEN at <sha>, or a bad spec, is an error with no facts", () => {
  assert.match(body({ body: BODY, head: "b".repeat(40) }, {}).o.error, /the PR head is b{40}, not a{40}/);
  assert.match(body({ body: BODY, state: "MERGED" }, {}).o.error, /the PR is MERGED, not OPEN/);
  for (const bad of [{ quotes: ["x".repeat(301)] }, { quotes: Array(11).fill("a quote of length") }, { min_chars: -1 }, { template: { repo: "o/r", path: "../x", ref: null } }]) {
    const { o } = body({ body: BODY }, bad);
    assert.match(o.error, /bad (body spec|template in the body spec)/, JSON.stringify(bad));
    assert.equal(o.quotes, null);
  }
});

// review of d9ae4c6 (R4): a quote matches within one segment, never across a removed heading or block
test("8.9.15 R4: a quote that spans a heading line is not in the body; one inside a segment is", () => {
  const b = "The parser is fixed\n## Testing\nall cases pass";
  const { o } = body({ body: b }, { quotes: ["is fixed all cases pass", "The parser is fixed", "fixed\nall cases pass"] });
  assert.equal(o.error, null);
  assert.deepEqual(o.quotes, [false, true, false]);
  const t = "before the block\n<!-- ccpm-fleet-tests -->\nx\n<!-- /ccpm-fleet-tests -->\nafter the block";
  assert.deepEqual(body({ body: t }, { quotes: ["before the block after the block", "after the block"] }).o.quotes, [false, true]);
});

// review of d9ae4c6 (R5): format characters (Cf: zero-width, bidi) are dropped from both sides; no case folding
test("8.9.15 R5: zero-width and bidi characters do not hide or fake a quote; case still counts", () => {
  const b = "The pa​rser is ‮fixed now";
  const { o } = body({ body: b }, { quotes: ["The parser is fixed now", "The parser⁦ is fixed now", "the parser is fixed now"] });
  assert.equal(o.error, null);
  assert.deepEqual(o.quotes, [true, true, false]);
});

// review of d9ae4c6 (B2): the repo's body checker, read at the base commit, run in the sandbox
const GITP = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
const BWRAP = spawnSync("sh", ["-c", "command -v bwrap"], { encoding: "utf8" }).stdout.trim();
const NO_SBX = !BWRAP ? "bwrap is not on PATH (CI has none): the sandboxed checker run skips" : false;
function repo(files) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "fleet-8915-ck-")));
  const wt = join(d, "main");
  mkdirSync(join(d, "scratch"));
  const env = { PATH: process.env.PATH, HOME: d, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
  const g = (...a) => {
    const r = spawnSync(GITP, a, { cwd: existsSync(wt) ? wt : d, encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  g("init", "-q", "-b", "master", wt);
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(join(wt, p, ".."), { recursive: true });
    writeFileSync(join(wt, p), t);
  }
  g("add", "-A");
  g("commit", "-qm", "base");
  return { d, wt, base: g("rev-parse", "HEAD"), done: () => rmSync(d, { recursive: true, force: true }) };
}
const CHECK = [
  "import json, os, sys",
  "b = open(sys.argv[1]).read()",
  "e = json.load(open(os.environ['GITHUB_EVENT_PATH']))['pull_request']['body']",
  "assert b == e == open(os.environ['PR_BODY_FILE']).read()",
  "if '## Breaking?\\nno' not in b:",
  "    sys.stderr.write('\\x1b[31m## Breaking? must open with yes or no\\u202e\\x07\\n' + 'x' * 400 + 'END')",
  "    sys.exit(3)",
].join("\n");

test("8.9.15 B2: the checker at the base runs sandboxed on the body; a miss gives its exit code and a clean 300-character stderr tail", { skip: NO_SBX }, () => {
  const x = repo({ "check.py": CHECK });
  try {
    // the working tree's copy is never run: only the base commit's
    writeFileSync(join(x.wt, "check.py"), "import sys\nsys.exit(0)\n");
    const ck = { worktree: x.wt, base: x.base, path: "check.py" };
    const miss = body({ body: "## Breaking?\nmaybe" }, { checker: ck }).o;
    assert.equal(miss.error, null);
    assert.equal(miss.checker.ran, true, miss.checker.reason);
    assert.equal(miss.checker.exit, 3);
    assert.equal(miss.checker.excerpt.length, 300);
    assert.ok(miss.checker.excerpt.endsWith("xxxEND"));
    assert.ok(!/[\u0000-\u001f\u007f‮]/.test(miss.checker.excerpt));
    const ok = body({ body: "## Breaking?\nno" }, { checker: ck }).o;
    assert.deepEqual([ok.checker.ran, ok.checker.exit, ok.checker.excerpt], [true, 0, null]);
    assert.deepEqual(readdirSync(join(x.d, "scratch")), [], "the run leaves nothing in scratch");
  } finally {
    x.done();
  }
});

test("8.9.15 B2: a checker the sandbox cannot run (sandbox.py off its pin, or no file at the base) does not run", () => {
  const x = repo({ "other.py": "pass\n" });
  const d = realpathSync(mkdtempSync(join(tmpdir(), "fleet-8915-pin-")));
  try {
    const ck = { worktree: x.wt, base: x.base, path: "check.py" };
    const none = body({ body: "b" }, { checker: ck }).o;
    assert.deepEqual([none.checker.ran, none.checker.reason], [false, "the checker check.py is not a file at " + x.base]);
    writeFileSync(join(d, "pr_state.py"), readFileSync(PROG));
    writeFileSync(join(d, "sandbox.py"), readFileSync(join(SCRIPTS_SRC, "sandbox.py"), "utf8") + "\n# changed\n");
    const off = body({ body: "b" }, { checker: Object.assign({}, ck, { path: "other.py" }) }, join(d, "pr_state.py")).o;
    assert.deepEqual([off.checker.ran, off.checker.reason], [false, "sandbox unavailable: sandbox.py does not hash to its pinned sha256"]);
    assert.equal(body({ body: "b" }, {}).o.checker, null);
    // review of cae63d3: the base is 40 or 64 hex (a SHA-256 repo), as plan_ref_write.py takes it; never abbreviated
    const sha256Base = body({ body: "b" }, { checker: Object.assign({}, ck, { base: "c".repeat(64) }) }).o;
    assert.deepEqual([sha256Base.error, sha256Base.checker.reason], [null, "the checker check.py is not a file at " + "c".repeat(64)]);
    for (const bad of [{ worktree: x.wt, base: x.base.slice(0, 7), path: "c.py" }, { worktree: x.wt, base: x.base.slice(0, 39), path: "c.py" }, { worktree: x.wt, base: "c".repeat(41), path: "c.py" }, { worktree: "rel", base: x.base, path: "c.py" }, { worktree: x.wt, base: "zz", path: "c.py" }, { worktree: x.wt, base: x.base, path: "../c.py" }, { worktree: x.wt, base: x.base, path: "c.sh" }])
      assert.match(body({ body: "b" }, { checker: bad }).o.error, /bad checker in the body spec/, JSON.stringify(bad));
  } finally {
    x.done();
    rmSync(d, { recursive: true, force: true });
  }
});

test("8.9.15 B2: pr_state.py pins sandbox.py's sha256 as the other sandbox callers do", () => {
  const sha = createHash("sha256").update(readFileSync(join(SCRIPTS_SRC, "sandbox.py"))).digest("hex");
  assert.match(readFileSync(PROG, "utf8"), new RegExp("\\nSANDBOX_SHA256 = '" + sha + "'\\n"));
});
