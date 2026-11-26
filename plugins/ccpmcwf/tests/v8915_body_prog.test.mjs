// ccpmcwf 8.9.15 (yaadgaar #131, #130): pr_state.py body, the read-only PR body facts.
// headers_missing: given headers and the template's heading lines that are no line of the body;
// short: under min_chars; quotes: 12+ characters after whitespace collapse, present (no case
// folding) in the body with the script-written blocks and every heading line removed; checks: the
// named checks' buckets (fail, else pending, else pass, else missing). The PR must be OPEN at <sha>.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
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
function body(cfg, spec) {
  const e = setup(cfg);
  try {
    const sp = Object.assign({ headers: [], template: null, min_chars: null, quotes: [], checks: [] }, spec);
    const r = spawnSync(PY, ["-I", PROG, "body", "gh", "o/r", "7", SHA, b64(JSON.stringify(sp))], { encoding: "utf8", env: { PATH: e.bin + ":/usr/bin:/bin", HOME: e.dir }, timeout: 60000 });
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
