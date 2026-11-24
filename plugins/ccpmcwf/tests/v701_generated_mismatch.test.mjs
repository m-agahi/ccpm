// fleet 7.0.1 (yaadgaar #55, L2190), AC2: a dist that differs from the build of the
// src at the tree is scanned as today and is not reported in `generated`.
//
// Each test builds a throwaway git repo (own temp dir), commits a base, writes the tree,
// and runs `python3 -I changed_defs.py <wt> <base> <tree> '[]'`. The dist is built in JS
// with the real `buildWorkflow`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROGRAM = join(HERE, "..", "scripts", "changed_defs.py");
const { buildWorkflow } = await import(join(HERE, "..", "scripts", "build-workflow.mjs"));

const S = "plugins/ccpmcwf/src/build-engine.js";
const D = "plugins/ccpmcwf/workflows/build-engine.js";
const OTHER = "lib/other.js";
const OTHER_TEXT = "export function keep(x) {\n  return x;\n}\n";

const SRC0 = [
  "export const meta = {",
  '  name: "x",',
  "};",
  "// c",
  "async function alpha(a) {",
  "  const r = a + 1;",
  "  return r;",
  "}",
  "function beta(b) {",
  "  const r = b * 2;",
  "  return r;",
  "}",
  "const TOP = 1;",
  "",
].join("\n");

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

function git(wt, ...args) {
  const r = spawnSync("git", ["-C", wt, ...args], {
    encoding: "utf8",
    env: Object.assign({}, process.env, GIT_ENV),
  });
  assert.equal(r.status, 0, "git " + args.join(" ") + ": " + r.stderr);
  return r.stdout.trim();
}

function put(wt, files) {
  for (const [p, text] of Object.entries(files)) {
    const f = join(wt, p);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text);
  }
}

// base: files committed; tree: files written over it (a null value deletes the file) and
// snapshotted with write-tree. Returns the program's exit status and parsed JSON.
function scan(base, tree, exclude = []) {
  const wt = mkdtempSync(join(tmpdir(), "v701-mismatch-"));
  try {
    git(wt, "init", "-q");
    put(wt, Object.assign({ [OTHER]: OTHER_TEXT }, base));
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "base");
    const baseId = git(wt, "rev-parse", "HEAD");
    for (const [p, text] of Object.entries(tree)) {
      if (text === null) rmSync(join(wt, p));
      else put(wt, { [p]: text });
    }
    git(wt, "add", "-A");
    const treeId = git(wt, "write-tree");
    const r = spawnSync("python3", ["-I", PROGRAM, wt, baseId, treeId, JSON.stringify(exclude)], {
      encoding: "utf8",
      env: Object.assign({}, process.env, GIT_ENV),
    });
    let out = null;
    try {
      out = JSON.parse(r.stdout);
    } catch {
      out = null;
    }
    return { status: r.status, stderr: r.stderr, out };
  } finally {
    rmSync(wt, { recursive: true, force: true });
    assert.equal(existsSync(wt), false);
  }
}

const withA = (n) => SRC0.replace("a + 1", "a + " + n);
const withB = (n) => SRC0.replace("b * 2", "b * " + n);
const defsAt = (out, path) => out.defs.filter((d) => d.at.startsWith(path + ":"));
// a hand edit of the built dist; 8.6.0 (ADR-1403): the dist writes `a+1` and `b*2` (whitespace collapsed)
function handEdit(from, to) {
  const d = buildWorkflow(SRC0);
  const e = d.replace(from, to);
  assert.notEqual(e, d, "the dist holds " + from);
  return e;
}

test("AC2: hand edit in the dist, src unchanged: the dist is scanned and not generated", () => {
  // AC2: hand edit (a + 1 -> a + 9 in D only)
  const { status, out } = scan({ [S]: SRC0, [D]: buildWorkflow(SRC0) }, { [S]: SRC0, [D]: handEdit("a+1", "a+9") });
  assert.equal(status, 0);
  assert.deepEqual(out.generated, []);
  assert.deepEqual(out.defs, [
    { name: "r", at: D + ":5", end: 5 },
    { name: "r", at: D + ":9", end: 9 },
  ]);
});

test("AC2 triangulation: a different hand edit (b * 2 -> b * 7) is scanned, not generated", () => {
  // AC2: hand edit, different line and value
  const { status, out } = scan({ [S]: SRC0, [D]: buildWorkflow(SRC0) }, { [S]: SRC0, [D]: handEdit("b*2", "b*7") });
  assert.equal(status, 0);
  assert.deepEqual(out.generated, []);
  assert.ok(defsAt(out, D).some((d) => d.name === "r" && d.at === D + ":9" && d.end === 9), JSON.stringify(out.defs));
});

test("AC2: src and dist both changed but the dist is not the build of the src", () => {
  // AC2: both changed, mismatch (S has a + 2, D has a + 3)
  const { status, out } = scan({ [S]: SRC0, [D]: buildWorkflow(SRC0) }, { [S]: withA(2), [D]: handEdit("a+1", "a+3") });
  assert.equal(status, 0);
  assert.deepEqual(out.generated, []);
  assert.deepEqual(out.defs, [
    { name: "alpha", at: S + ":5", end: 7 },
    { name: "r", at: D + ":5", end: 5 },
    { name: "r", at: D + ":9", end: 9 },
  ]);
});

test("AC2 triangulation: src with a + 5, dist built from a + 6, is scanned, not generated", () => {
  // AC2: both changed, mismatch, different values
  const { status, out } = scan({ [S]: SRC0, [D]: buildWorkflow(SRC0) }, { [S]: withA(5), [D]: buildWorkflow(withA(6)) });
  assert.equal(status, 0);
  assert.deepEqual(out.generated, []);
  assert.ok(defsAt(out, D).length > 0, JSON.stringify(out.defs));
  assert.ok(defsAt(out, S).some((d) => d.name === "alpha"), JSON.stringify(out.defs));
});

test("AC2: src deleted at the tree (blob absent): exit 0, no exclusion, dist scanned", () => {
  // AC2: src missing (failure: blob absent)
  const { status, stderr, out } = scan({ [S]: SRC0, [D]: buildWorkflow(SRC0) }, { [S]: null, [D]: buildWorkflow(withA(2)) });
  assert.equal(status, 0, stderr);
  assert.deepEqual(out.generated, []);
  assert.ok(out.defs.some((d) => d.name === "r" && d.at === D + ":5" && d.end === 5), JSON.stringify(out.defs));
});

test("AC2 triangulation: src deleted, dist edited on line 9: exit 0, dist scanned", () => {
  // AC2: src missing, different dist edit (b * 5 on D line 9)
  const { status, stderr, out } = scan({ [S]: SRC0, [D]: buildWorkflow(SRC0) }, { [S]: null, [D]: buildWorkflow(withB(5)) });
  assert.equal(status, 0, stderr);
  assert.deepEqual(out.generated, []);
  assert.ok(out.defs.some((d) => d.name === "r" && d.at === D + ":9" && d.end === 9), JSON.stringify(out.defs));
});

test("AC2: dist deleted at the tree: nothing generated, the deleted dist definitions are listed", () => {
  // AC2: dist deleted
  const { status, out } = scan({ [S]: SRC0, [D]: buildWorkflow(SRC0) }, { [D]: null });
  assert.equal(status, 0);
  assert.deepEqual(out.generated, []);
  assert.ok(out.defs.some((d) => d.name === "TOP" && d.at === D + ":12" && d.end === 12), JSON.stringify(out.defs));
});

test("AC2 triangulation: dist deleted, base src with one more top-level const: its dist line is listed", () => {
  // AC2: dist deleted, different base (ZED on dist line 13)
  const SRC1 = SRC0 + "const ZED = 2;\n";
  const { status, out } = scan({ [S]: SRC1, [D]: buildWorkflow(SRC1) }, { [D]: null });
  assert.equal(status, 0);
  assert.deepEqual(out.generated, []);
  assert.ok(out.defs.some((d) => d.name === "ZED" && d.at === D + ":13" && d.end === 13), JSON.stringify(out.defs));
});

test("AC2: dist one byte off (extra trailing newline) is not generated", () => {
  // AC2: one byte off
  const s = withA(2);
  const { status, out } = scan({ [S]: SRC0, [D]: buildWorkflow(SRC0) }, { [S]: s, [D]: buildWorkflow(s) + "\n" });
  assert.equal(status, 0);
  assert.deepEqual(out.generated, []);
});

test("AC2 triangulation: dist one byte short (no trailing newline) is not generated", () => {
  // AC2: one byte off, other direction
  const s = withA(2);
  const { status, out } = scan({ [S]: SRC0, [D]: buildWorkflow(SRC0) }, { [S]: s, [D]: buildWorkflow(s).slice(0, -1) });
  assert.equal(status, 0);
  assert.deepEqual(out.generated, []);
});
