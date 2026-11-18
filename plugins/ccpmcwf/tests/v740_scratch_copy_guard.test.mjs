// fleet 7.4.0 car 5 (#70 items 1, 2): the scratch_copy.py run denylist (defense in depth; the
// agent PATH shim stays the primary guard) and the auto gates' test_cmd shape.
// - U1 (item 1): for a shell interpreter (sh, bash, dash, zsh, ksh) the inline-code check scans the
//   whole argv, so `+O`/`+o` options and value options (`--rcfile x`) no longer end the scan.
//   Value-taking options per interpreter (ruby/perl -I, -r; node -C, --conditions, --title,
//   --input-type; python --check-hash-based-pycs) skip their value. The shipped scan (no value
//   skip) runs too, and either one refusing refuses, so no argv the shipped scan refused passes.
// - U2 (item 2): commandShapeProblems refuses a test_cmd whose argv has an inline-code form, with
//   the same form list as scratch_copy.py: "test_cmd runs inline code".
//
// dont_care: the refusal wording after "refusing"; the problem wording after "runs inline code".

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SOURCE, SCRIPTS_SRC, spawnSync } from "./harness.mjs";

const PY = join(SCRIPTS_SRC, "scratch_copy.py");
// a fake executable name only: the file below with this name is a temp-dir shell stub
const TF = "terraform";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-740u-")));
  const wt = join(root, "main");
  mkdirSync(wt);
  const git = (...a) => assert.equal(spawnSync("git", ["-C", wt, ...a], { encoding: "utf8" }).status, 0, a.join(" "));
  git("init", "-q", "-b", "main");
  git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init");
  const shim = join(root, "shim");
  mkdirSync(shim);
  writeFileSync(join(shim, TF), "#!/bin/sh\ntouch " + join(root, "shim-reached") + "\nexit 3\n", { mode: 0o755 });
  const env = Object.assign({}, process.env, { PATH: shim + ":" + process.env.PATH });
  const py = (...a) => spawnSync("python3", ["-I", PY, ...a], { encoding: "utf8", env });
  const tmp = JSON.parse(py("make", wt).stdout).tmp;
  writeFileSync(join(tmp, "t.py"), "print('py-ran')\n");
  writeFileSync(join(tmp, "t.sh"), "echo sh-ran\n");
  const refused = (argv) => {
    const r = py("run", wt, tmp, JSON.stringify(argv));
    return r.status !== 0 && /refusing .* with an inline program string/.test(r.stderr);
  };
  return { root, wt, tmp, py, refused };
}

// the JS check from the source: inlineCodeArgv(tokens) -> true for an inline-code form
const fnOf = (name) => SOURCE.slice(SOURCE.indexOf("function " + name + "("), SOURCE.indexOf("\n}\n", SOURCE.indexOf("function " + name + "(")) + 2);
const inlineCodeArgv = Function("return (" + fnOf("inlineCodeArgv") + ")")();
const commandShapeProblems = Function("inlineCodeArgv", "PRECOMMIT_CMD_RE", "return (" + fnOf("commandShapeProblems") + ")")(inlineCodeArgv, /^pre-commit run (\S+)$/);

const REFUSE = [
  ["bash", "+O", "extglob", "-c", TF + " plan"],
  ["bash", "+o", "posix", "-c", TF + " plan"],
  ["bash", "--rcfile", "x", "-c", TF + " plan"],
  ["bash", "--init-file", "x", "-c", TF + " plan"],
  ["ruby", "-I", "lib", "-e", "x"],
  ["ruby", "-r", "json", "-e", "x"],
  ["perl", "-I", "lib", "-e", "x"],
  ["node", "-C", "dev", "-e", "x"],
  ["node", "--conditions", "dev", "-p", "x"],
  ["node", "--title", "t", "--eval", "x"],
  ["node", "--input-type", "module", "-e", "x"],
  ["python3", "--check-hash-based-pycs", "always", "-c", "x"],
  ["sh", "t.sh", "-c", "x"],
  ["timeout", "60", "bash", "-lc", "x"],
  ["ksh", "-c", "x"],
  // the shipped scan refused these; a value skip alone would not
  ["ruby", "-I", "-e", "x"],
  ["node", "-C", "-e", "x"],
  // the shipped forms
  ["sh", "-c", "x"],
  ["python3", "-c", "x"],
  ["perl", "-ne", "x"],
  ["env", "-S", "sh t.sh"],
  ["env", "--split-string=sh t.sh"],
  ["git", "-c", "alias.x=!sh t.sh", "x"],
];
const RUNS = [["python3", "t.py", "-c", "x"], ["python3", "-m", "json.tool", "-c"], ["true"], ["python3", "-W", "ignore", "t.py"], ["node", "-C", "dev", "t.js"], ["ruby", "-I", "lib", "t.rb"]];

test("7.4.0 #70 U1: scratch_copy.py run refuses the bypass forms; a plain command runs", () => {
  const f = fixture();
  try {
    for (const a of REFUSE) assert.ok(f.refused(a), JSON.stringify(a));
    assert.ok(!existsSync(join(f.root, "shim-reached")), "no -c string ran");
    const r = f.py("run", f.wt, f.tmp, JSON.stringify(["pytest", "-q"]));
    assert.equal(r.status, 0, r.stderr);
    assert.ok("exit_code" in JSON.parse(r.stdout));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("7.4.0 #70 U1/U2: the JS check and scratch_copy.py agree on every corpus argv", () => {
  const f = fixture();
  try {
    for (const a of REFUSE.concat(RUNS)) assert.equal(inlineCodeArgv(a), f.refused(a), JSON.stringify(a));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("7.4.0 #70 U2: the auto gates refuse an inline-code test_cmd; pytest -q has no problem", () => {
  const T = (command) => commandShapeProblems([{ id: "T", kind: "test_cmd", command, run_by: "fleet" }]).problems;
  for (const c of ["sh -c 'pytest'", "bash -c pytest", "python3 -c 1", "node -e 1", "node --eval 1", "perl -e 1", "ruby -e 1", "timeout 60 sh -c pytest"]) {
    const p = T(c);
    assert.equal(p.length, 1, c);
    assert.match(p[0], /^T: test_cmd runs inline code/, c);
  }
  assert.deepEqual(T("pytest -q"), []);
  assert.deepEqual(T("npm test -- <paths>"), []);
  assert.deepEqual(T("python -m pytest -c pytest.ini"), []);
});
