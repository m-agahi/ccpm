// fleet 7.4.0 car 6 (#72): the hasher freezes the [tool.pytest] table of every pyproject.toml
// (an absent file as MISSING, a new file as an added key), so in a greenfield repo the coder can
// never create the first pyproject.toml. The supported route: the plan names pyproject.toml in a
// criterion's own test_files, the test writer of that criterion creates it, and the freeze
// snapshots the new content (the whole file and its [tool.pytest] table).
// - P1: a writer round that owns pyproject.toml (in its criterion's test_files, in the writer's
//   files) and creates it with a [tool.pytest] table passes the writer-round check; the freeze
//   map holds the new file and section.
// - P2 (non-weakening): a coder edit to [tool.pytest] after the freeze is still a hash violation.
// - P3 (non-weakening): a writer that changes the [tool.pytest] table of a pyproject.toml its
//   criterion does NOT own still stops at ownership; so does one whose criterion owns another
//   pyproject.toml (the section's own file decides, not its base name).
// - P4: the hasher (real program) puts a writer-created pyproject.toml in the freeze maps: the
//   whole file (as a test file) and its [tool.pytest] section; after a later edit of the table
//   both keys differ.
// - P5: the planner rule and the README name the route; the roles never pass a runner-config
//   file of test_files as a <paths> argument.
//
// dont_care: the wording of the hash-violation finding after the key names.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ARGS, happy, run, inputsOf, H, FP_PRE, FP_TESTS, FP_K1, scratchRepo, sh, runHasher, HAVE_PY, ROLE_TEXT, HERE } from "./harness.mjs";

const T = ["tests/test_a.py", "pyproject.toml"];
const crit = [
  { id: "AC1", text: "behaviour 1", test_files: T },
  { id: "AC2", text: "behaviour 2", test_files: ["tests/test_b.py"] },
];
const PRE = { "tests/test_b.py": "hb0" };
const POST = { "tests/test_a.py": "ha", "tests/test_b.py": "hb", "pyproject.toml": "pp1", "pyproject.toml#tool.pytest": "hp1" };

function route(postCoder, writerFiles) {
  const s = happy({ criteria: crit });
  s["role:fleet-test-writer:AC1:r1"] = Object.assign({}, s["role:fleet-test-writer:AC1:r1"], { files: writerFiles || T.slice() });
  s["hasher:pre-writers:r1"] = { status: "ok", fingerprint: FP_PRE, hashes: H(PRE) };
  s["hasher:post-writers:r1"] = { status: "ok", fingerprint: FP_TESTS, changed: ["tests/test_a.py", "tests/test_b.py", "pyproject.toml"], hashes: H(POST) };
  s["hasher:freeze:f1"] = { status: "ok", fingerprint: FP_TESTS, hashes: H(POST) };
  s["hasher:post-coder:r1"] = { status: "ok", fingerprint: FP_K1, hashes: H(postCoder || POST) };
  return s;
}

test("7.4.0 #72 P1: a writer that owns pyproject.toml creates it before the freeze; the run goes on", async () => {
  const out = await run(route(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.logs.some((l) => /test round 1: writers ok: AC1, AC2/.test(l)), out.logs.join("\n"));
});

test("7.4.0 #72 P2: a coder edit to [tool.pytest] after the freeze stays a hash violation", async () => {
  const out = await run(route(Object.assign({}, POST, { "pyproject.toml": "pp2", "pyproject.toml#tool.pytest": "hp2" })), ARGS);
  assert.notEqual(out.result.status, "ok", out.result.reason);
  assert.ok(out.logs.some((l) => /code round 1: hash violation on .*pyproject\.toml#tool\.pytest/.test(l)), out.logs.join("\n"));
  // the table alone (the file's other bytes kept by a forged file hash) is refused too
  const t = await run(route(Object.assign({}, POST, { "pyproject.toml#tool.pytest": "hp2" })), ARGS);
  assert.ok(t.logs.some((l) => /code round 1: hash violation on pyproject\.toml#tool\.pytest/.test(l)), t.logs.join("\n"));
});

test("7.4.0 #72 P3: a section of a pyproject.toml no criterion of the round owns still stops at ownership", async () => {
  // AC1 owns no pyproject.toml: the writer creates one anyway
  const s = route(null, ["tests/test_a.py"]);
  s["role:scope-and-plan"] = Object.assign({}, s["role:scope-and-plan"], { criteria: [{ id: "AC1", text: "behaviour 1", test_files: ["tests/test_a.py"] }, crit[1]] });
  s["hasher:post-writers:r1"] = Object.assign({}, s["hasher:post-writers:r1"], { changed: ["tests/test_a.py", "tests/test_b.py"], hashes: H(Object.assign({}, POST, { "pyproject.toml": undefined })) });
  delete s["hasher:post-writers:r1"].hashes.files["pyproject.toml"];
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "ownership");
  assert.match(out.result.reason, /pyproject\.toml#tool\.pytest/);
  // a criterion that owns pkg/pyproject.toml does not own the root file's table
  const s2 = route(null, ["tests/test_a.py", "pkg/pyproject.toml"]);
  const c2 = [{ id: "AC1", text: "behaviour 1", test_files: ["tests/test_a.py", "pkg/pyproject.toml"] }, crit[1]];
  s2["role:scope-and-plan"] = Object.assign({}, s2["role:scope-and-plan"], { criteria: c2 });
  const p2 = { "tests/test_a.py": "ha", "tests/test_b.py": "hb", "pkg/pyproject.toml": "pp1", "pyproject.toml#tool.pytest": "hp1" };
  s2["hasher:post-writers:r1"] = { status: "ok", fingerprint: FP_TESTS, changed: ["tests/test_a.py", "tests/test_b.py", "pkg/pyproject.toml"], hashes: H(p2) };
  const o2 = await run(s2, ARGS);
  assert.equal(o2.result.stop_gate, "ownership", o2.result.reason);
  assert.match(o2.result.reason, /pyproject\.toml#tool\.pytest/);
});

test("7.4.0 #72 P4: the hasher freezes a writer-created pyproject.toml whole and by its [tool.pytest] table", { skip: !HAVE_PY && "no tomllib" }, () => {
  const wt = scratchRepo("fleet-740pp-");
  try {
    mkdirSync(join(wt, "tests"));
    writeFileSync(join(wt, "tests", "test_a.py"), "def test_a():\n    assert True\n");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-q", "-m", "base");
    const before = runHasher(wt, "hash", ["tests/test_a.py", "pyproject.toml"]);
    assert.equal(before.hashes["pyproject.toml"], "MISSING");
    assert.ok(!("pyproject.toml#tool.pytest" in before.hashes));
    // the test writer creates it (untracked, before the freeze)
    writeFileSync(join(wt, "pyproject.toml"), '[project]\nname = "x"\nversion = "0"\n\n[tool.pytest.ini_options]\naddopts = "-q"\n');
    const frozen = runHasher(wt, "hash", ["tests/test_a.py", "pyproject.toml"]);
    assert.match(frozen.hashes["pyproject.toml"], /^[0-9a-f]{64}$/);
    assert.match(frozen.hashes["pyproject.toml#tool.pytest"], /^[0-9a-f]{64}$/);
    // the coder edits the table
    writeFileSync(join(wt, "pyproject.toml"), '[project]\nname = "x"\nversion = "0"\n\n[tool.pytest.ini_options]\naddopts = "-q -p no:x"\n');
    const after = runHasher(wt, "hash", ["tests/test_a.py", "pyproject.toml"]);
    assert.notEqual(after.hashes["pyproject.toml#tool.pytest"], frozen.hashes["pyproject.toml#tool.pytest"]);
    assert.notEqual(after.hashes["pyproject.toml"], frozen.hashes["pyproject.toml"]);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("7.4.0 #72 P5: the planner rule, the README route and the <paths> rule in every role that runs tests", () => {
  const sp = ROLE_TEXT["scope-and-plan"];
  assert.match(sp, /first `pyproject\.toml`/);
  assert.match(sp, /test_files/);
  const readme = readFileSync(join(HERE, "..", "README.md"), "utf8");
  assert.match(readme, /greenfield/i);
  assert.match(readme, /first `pyproject\.toml`/);
  for (const r of ["fleet-test-writer", "fleet-test-judge", "fleet-code-judge", "fleet-coder"])
    assert.match(ROLE_TEXT[r], /runner-config file in `test_files` \(`pyproject\.toml`/, r);
});
