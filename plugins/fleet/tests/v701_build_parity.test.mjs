// fleet 7.0.1 (yaadgaar #55, L2190) AC6: the program's build check
// (changed_defs.py) equals the JS buildWorkflow byte for byte.
//
// Each case builds the dist in JS with buildWorkflow from
// plugins/fleet/scripts/build-workflow.mjs, commits a base and a tree in a
// temporary git repo, runs changed_defs.py on them and reads the `generated`
// key of its JSON. Expected values come from the plan doc's AC6 examples.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, "..");
const PROGRAM = join(PLUGIN, "scripts", "changed_defs.py");
const { buildWorkflow: build } = await import(join(PLUGIN, "scripts", "build-workflow.mjs"));

const S = "plugins/fleet/src/build-task-run.js";
const D = "plugins/fleet/workflows/build-task-run.js";
const TAB = String.fromCharCode(9);

const GIT_ENV = Object.assign({}, process.env, {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
});

function git(wt, ...args) {
  const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-C", wt, ...args], {
    env: GIT_ENV,
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  if (r.status !== 0) throw new Error("git " + args.join(" ") + ": " + r.stderr);
  return r.stdout.trim();
}

function put(wt, files) {
  for (const [p, text] of Object.entries(files)) {
    const f = join(wt, p);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text);
  }
}

// runs the program on base -> tree and returns its parsed JSON
function scan(baseFiles, treeFiles) {
  const wt = mkdtempSync(join(tmpdir(), "v701-parity-"));
  try {
    git(wt, "init", "-q", "--template=");
    put(wt, baseFiles);
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "base");
    const base = git(wt, "rev-parse", "HEAD");
    put(wt, treeFiles);
    git(wt, "add", "-A");
    const tree = git(wt, "write-tree");
    const r = spawnSync("python3", ["-I", PROGRAM, wt, base, tree, "[]"], {
      env: GIT_ENV,
      encoding: "utf8",
      maxBuffer: 64 << 20,
    });
    assert.equal(r.status, 0, "changed_defs.py exited " + r.status + ": " + r.stderr);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
}

const E1 =
  'export const meta = {\n  name: "x",\n};\n' +
  TAB + TAB + "const a = 1;\n  // FOO_BEGIN\n    // plain comment\n   \nfunction f() {\n  //x\n  return a;\n}\n  // lower_BEGIN\n// BAR_END\n";

const edit = (text) => text.replace("return a;", "return a + 1;");

// base S, base D = build(S); tree S = edit(S), tree D = distOf(edit(S))
function runPair(src, distOf = build) {
  const next = edit(src);
  assert.notEqual(next, src, "fixture must contain `return a;`");
  return scan({ [S]: src, [D]: build(src) }, { [S]: next, [D]: distOf(next) });
}

test("AC6: E1 edge fixture, program build equals buildWorkflow (tabs, indented comments, blank lines, markers)", () => {
  // AC6: E1 example, generated == [D]
  const out = runPair(E1);
  assert.deepEqual(out.generated, [D]);
});

test("AC6: triangulation, equality holds across marker, whitespace and meta variants", () => {
  // AC6: property gen_build(x) == buildWorkflow(x) for every source with a meta head
  const head = 'export const meta = {\n  name: "x",\n};\n';
  const tail = "function f() {\n  return a;\n}\n";
  const sources = {
    "indented upper marker is kept": head + "\t// ZED_END\n  // A1_2_BEGIN\n" + tail,
    "lower-case marker and marker with a suffix are dropped": head + "// a_BEGIN\n// FOO_BEGIN trailing\n  // FOO_BEGINX\n" + tail,
    "whitespace-only lines with tabs and spaces": head + " \t \n\t\n   \n" + tail,
    "meta block with a comment and a blank line is kept verbatim": 'export const meta = {\n  // keep me\n\n  name: "x",\n};\n' + tail,
    "trailing whitespace inside lines is kept": head + "const b = 2;  \t\n" + tail,
    "a later `};` line in the body is not the meta end": head + "const o = {\n  k: 1,\n};\n" + tail,
    "meta end is the first line that is exactly `};`, not a line that only starts with it": 'export const meta = {\n  a: 1,\n};x\n};\n' + tail,
    "no final newline in the body": head + "function f() {\n  return a;\n}",
  };
  for (const [name, src] of Object.entries(sources)) {
    const out = runPair(src);
    assert.deepEqual(out.generated, [D], name);
  }
});

test("AC6: the real source, a one-token edit, dist rebuilt: dist excluded and never scanned", () => {
  // AC6: real source example
  const real = readFileSync(join(PLUGIN, "src", "build-task-run.js"), "utf8");
  const from = 'const RELAY_RETRY_MODEL = "sonnet";';
  assert.ok(real.includes(from), "fixture needs the first RELAY_RETRY_MODEL line");
  const next = real.replace(from, 'const RELAY_RETRY_MODEL = "opus";');
  const out = scan({ [S]: real, [D]: build(real) }, { [S]: next, [D]: build(next) });
  assert.deepEqual(out.generated, [D]);
  // AC6: no defs entry whose `at` starts with D + ":"
  assert.deepEqual(
    out.defs.filter((d) => d.at.startsWith(D + ":")),
    [],
  );
});

test("AC6: marker dropped from the dist, not the build, so the dist is scanned and not generated", () => {
  // AC6: marker dropped example (the `// BAR_END` line removed from D)
  const next = edit(E1);
  const dist = build(next);
  assert.ok(dist.includes("\n// BAR_END\n"), "fixture: the build keeps the BAR_END marker");
  const out = scan({ [S]: E1, [D]: build(E1) }, { [S]: next, [D]: dist.replace("\n// BAR_END\n", "\n") });
  assert.deepEqual(out.generated, []);
});

test("AC6: triangulation, any byte-level deviation of the dist from the build is refused", () => {
  // AC6: byte for byte, tab indentation, indented comment, whitespace-only line, marker line
  const next = edit(E1);
  const dist = build(next);
  const variants = {
    "marker FOO_BEGIN removed": dist.replace("// FOO_BEGIN\n", ""),
    "tab indentation kept on the const line": dist.replace("const a = 1;", TAB + TAB + "const a = 1;"),
    "indented plain comment kept": dist.replace("function f() {", "// plain comment\nfunction f() {"),
    "whitespace-only line kept": dist.replace("function f() {", "   \nfunction f() {"),
    "lower_BEGIN marker kept": dist.replace("return a + 1;", "// lower_BEGIN\nreturn a + 1;"),
    "meta indentation cut": dist.replace('  name: "x",', 'name: "x",'),
  };
  for (const [name, bad] of Object.entries(variants)) {
    assert.notEqual(bad, dist, "variant must differ: " + name);
    const out = scan({ [S]: E1, [D]: build(E1) }, { [S]: next, [D]: bad });
    assert.deepEqual(out.generated, [], name);
  }
});

test("AC6: no meta head, src and dist equal and both changed: no build, no exclusion", () => {
  // AC6: no meta head example
  const out = scan({ [S]: "const x = 1;\n", [D]: "const x = 1;\n" }, { [S]: "const x = 2;\n", [D]: "const x = 2;\n" });
  assert.deepEqual(out.generated, []);
});

test("AC6: triangulation, meta head without a closing `};` line gives no build", () => {
  // AC6: meta split, no `};` line closing the meta block
  const base = 'export const meta = {\n  name: "x",\nconst a = 1;\n';
  const next = 'export const meta = {\n  name: "x",\nconst a = 2;\n';
  const out = scan({ [S]: base, [D]: base }, { [S]: next, [D]: next });
  assert.deepEqual(out.generated, []);
});

test("AC6: triangulation, meta head must start the source byte for byte", () => {
  // AC6: meta split, head variant (leading blank line) gives no build
  const mk = (n) => '\nexport const meta = {\n  name: "x",\n};\nconst a = ' + n + ";\n";
  const out = scan({ [S]: mk(1), [D]: mk(1) }, { [S]: mk(2), [D]: mk(2) });
  assert.deepEqual(out.generated, []);
});
