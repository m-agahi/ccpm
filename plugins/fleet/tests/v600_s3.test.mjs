// fleet 6.0.0, stream 3: ledger 2044 (PR body stats block), 2045 (mark ready),
// 2034 (CI-watch, classification, CI-fix rounds, policy-gated merge).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCRIPTS_SRC, ARGS, happy, run, call, inputsOf, spawnSync, stateJsonOf, sha256 } from "./harness.mjs";

const PY = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
const DEFAULT_CAPS = { pr_ready: true, ci_watch: true, ci_watch_minutes: 60, stats: true, merge: "never", update_branch: "never", ci_trigger: false, review_post: "none" };
const polOut = (over) => (p) => Object.assign({ status: "ok", reason: "read", profile: null, file: "/h/.config/fleet/policy.json", policy_sha256: null, caps: Object.assign({}, DEFAULT_CAPS), matched: "no policy file", error: null, now: 1000, args: inputsOf(p).args }, over);

// a fake gh on PATH: a Python script that serves `pr view --json body` and `pr edit --body-file`
// from <dir>/body.md; "fail_edit" in <dir>/mode makes the edit fail, "drop" drops headings
function fakeGh(body, mode) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-600gh-"));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "body.md"), body);
  writeFileSync(join(dir, "mode"), mode || "");
  const prog =
    "#!" + PY + "\nimport json, sys\nD = " + JSON.stringify(dir) + "\na = sys.argv[1:]\nmode = open(D + '/mode').read()\nopen(D + '/calls', 'a').write(json.dumps(a) + '\\n')\n" +
    "if a[:2] == ['pr', 'view']:\n    print(json.dumps({'body': open(D + '/body.md').read()}))\n" +
    "elif a[:2] == ['pr', 'edit']:\n    if mode == 'fail_edit':\n        sys.exit('HTTP 403')\n    t = open(a[a.index('--body-file') + 1]).read()\n    if mode == 'drop':\n        t = '\\n'.join(x for x in t.split('\\n') if not x.startswith('## '))\n    open(D + '/body.md', 'w').write(t)\nelse:\n    sys.exit('unexpected ' + json.dumps(a))\n";
  writeFileSync(join(dir, "bin", "gh"), prog);
  chmodSync(join(dir, "bin", "gh"), 0o755);
  return dir;
}
function bodyBlock(dir, tpl, t0, headers) {
  const args = ["gh", "o/r", "7", Buffer.from(tpl, "utf8").toString("base64"), t0, JSON.stringify(headers || [])];
  const r = spawnSync(PY, ["-I", join(SCRIPTS_SRC, "pr_body_block.py")].concat(args), { encoding: "utf8", env: { PATH: join(dir, "bin") + ":/usr/bin:/bin", HOME: dir } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const TPL = "<details><summary>Built with ccpm fleet 6.0.0</summary>\n\n| metric | value |\n|---|---|\n| wall time | @@WALL@@ |\n\n</details>\n<!-- ccpm-fleet-stats -->";

// ---------------------------------------------------------------- 2044: pr_body_block.py

test("6.0.0 2044: pr_body_block.py appends the block when absent and fills the wall time", () => {
  const dir = fakeGh("## Summary\n\nDoes a thing.\n\n## Test plan\n\n- ran it\n");
  try {
    const o = bodyBlock(dir, TPL, "0", ["## Summary", "## Test plan"]);
    assert.equal(o.error, null);
    assert.equal(o.replaced, false);
    assert.ok(o.wall_s > 1e9);
    const body = readFileSync(join(dir, "body.md"), "utf8");
    assert.ok(body.startsWith("## Summary\n\nDoes a thing.\n\n## Test plan\n\n- ran it\n\n<details>"), body);
    assert.match(body, /\| wall time \| \d+h \d+m \|/);
    const block = body.slice(body.indexOf("<details>")).replace(/\n$/, "");
    assert.equal(o.block_sha256, sha256(block));
    assert.deepEqual(o.headers_missing, []);
    assert.equal(o.program.name, "pr_body_block");
    assert.match(o.digest, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("6.0.0 2044: pr_body_block.py replaces only the block; the rest of the body stays byte-identical", () => {
  const old = "<details><summary>Built with ccpm fleet 5.9.9</summary>\nold\n</details>\n<!-- ccpm-fleet-stats -->";
  const before = "## Summary\n\nx\n\n" + old + "\n\n## Notes\n\ntail text\n";
  const dir = fakeGh(before);
  try {
    const o = bodyBlock(dir, TPL, "-", []);
    assert.equal(o.error, null);
    assert.equal(o.replaced, true);
    assert.equal(o.wall_s, null);
    const body = readFileSync(join(dir, "body.md"), "utf8");
    assert.equal(body, before.replace(old, TPL.replace("@@WALL@@", "not measured")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("6.0.0 2044: pr_body_block.py reports an error when the edit fails or a template header is lost", () => {
  for (const [mode, re] of [["fail_edit", /gh pr edit: .*HTTP 403/], ["drop", /lost header\(s\): ## Summary/]]) {
    const dir = fakeGh("## Summary\n\nx\n", mode);
    try {
      const o = bodyBlock(dir, TPL, "0", ["## Summary"]);
      assert.match(String(o.error), re, mode);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // a template without its markers or the wall placeholder is refused before any gh call
  const dir = fakeGh("x");
  try {
    const r = spawnSync(PY, ["-I", join(SCRIPTS_SRC, "pr_body_block.py"), "gh", "o/r", "7", Buffer.from("no markers").toString("base64"), "0", "[]"], { encoding: "utf8", env: { PATH: join(dir, "bin") + ":/usr/bin:/bin" } });
    assert.notEqual(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 2044: the stats step in the build

function blockOf(out, label = "infra:pr-stats") {
  return Buffer.from(inputsOf(call(out, label).prompt).args[3], "base64").toString("utf8");
}

test("6.0.0 2044: after the write-back the build writes a stats block of script counters into the PR body", async () => {
  const s = happy();
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const L = out.build.labels;
  assert.ok(L.indexOf("infra:state:written_back") < L.indexOf("infra:pr-stats"), L.join(", "));
  const a = inputsOf(call(out, "infra:pr-stats").prompt).args;
  // the default policy stub prints no now: the wall time is not measured
  assert.deepEqual([a[0], a[1], a[2], a[4], a[5]], ["gh", "o/r", String(out.result.pr_number), "-", "[]"]);
  const block = blockOf(out);
  assert.ok(block.startsWith("<details><summary>Built with ccpm fleet 6.0.0</summary>\n\n| metric | value |\n|---|---|\n"), block);
  assert.ok(block.endsWith("</details>\n<!-- ccpm-fleet-stats -->"), block);
  for (const row of ["| acceptance criteria | 2 |", "| code rounds | 1 |", "| wall time (build) | @@WALL@@ |", "| independent review | approve (sweep: not triggered) |", "| output tokens (approx.) | "])
    assert.ok(block.indexOf(row) >= 0, row + " in\n" + block);
  assert.match(block, /\| tests written \| \d+ \(1 test rounds\) \|/);
  assert.match(block, /\| audit rounds \| 1 \|/);
  assert.match(block, /\| agents \| \d+ \|/);
  assert.match(block, /\| gates passed \| \d+ \|/);
  assert.ok(block.indexOf("https://github.com/m-agahi/ccpm") >= 0);
  // no internal path, run id, ledger id or session name
  assert.doesNotMatch(block, /refs\/fleet|wf_|\/home\/|\/r\/|\bL\d+\b|fleet\/l42|n1-0000001|\.claude/);
  assert.ok(out.build.logs.some((l) => /^infra:pr-stats: stats block added in /.test(l)), out.build.logs.join("\n"));
});

test("6.0.0 2044: output tokens per model come from budget.spent() growth around each agent call", async () => {
  const s = happy();
  let spent = 0;
  s.__budget = { total: null, spent: () => (spent += 1500), remaining: () => Infinity };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const row = blockOf(out).split("\n").find((l) => l.indexOf("| output tokens (approx.) |") === 0);
  // every return books 1 500 per spent() read on that call's model: each model's count is a multiple of 1.5k
  assert.match(row, /^\| output tokens \(approx\.\) \| haiku \d+k, sonnet \d+k \|$/, row);
  const s2 = happy();
  s2.__budget = { total: null };
  const o2 = await run(s2, ARGS);
  assert.equal(o2.result.status, "ok", o2.result.reason);
  assert.ok(blockOf(o2).indexOf("output tokens") < 0, "no spent(): no token row");
});

test("6.0.0 2044: policy stats false skips the block; a block mismatch or a program error stops (gate stats)", async () => {
  const s = happy();
  s["infra:policy"] = polOut({ caps: Object.assign({}, DEFAULT_CAPS, { stats: false }) });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(!out.build.labels.some((l) => /^infra:pr-stats/.test(l)));
  assert.ok(out.build.logs.indexOf("stats block off (policy stats false)") >= 0);
  for (const [over, re] of [[{ block_sha256: "0".repeat(64) }, /stats block is not the script's block/], [{ error: "the re-read body lost header(s): ## Summary" }, /lost header/]]) {
    const s2 = happy();
    s2["infra:pr-stats"] = (p) => {
      const a = inputsOf(p).args;
      return Object.assign({ status: "ok", reason: "w", replaced: false, wall_s: 5, block_sha256: sha256(Buffer.from(a[3], "base64").toString("utf8").replace("@@WALL@@", "5s")), body_sha256_before: null, body_sha256_after: null, headers_missing: [], error: null, args: a }, over);
    };
    const o = await run(s2, ARGS);
    assert.equal(o.result.status, "needs_human");
    assert.equal(o.result.stop_gate, "stats");
    assert.match(o.result.reason, re);
  }
});

test("6.0.0 2044: plan-audit rounds are sealed in the plan ref's history", async () => {
  const s = happy();
  const out = await run(s, ARGS);
  assert.equal(out.planResult.cumulative.audits, 1);
});

test("6.0.0 2044: the run-state records shipped after the stats step, with the tests-written counter", async () => {
  const s = happy();
  const states = {};
  for (const label of ["infra:state:written_back", "infra:state:shipped"])
    s[label] = (prompt) => {
      const st = stateJsonOf(prompt);
      states[st.last_gate] = st;
      return { status: "ok", reason: "written", head: inputsOf(prompt).expected_head, state_sha: "f".repeat(40) };
    };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(states.shipped && states.written_back);
  assert.equal(states.shipped.tests_written, states.written_back.tests_written);
});
