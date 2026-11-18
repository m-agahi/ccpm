// fleet 7.0.1 AC1: changed_defs.py reports the generated dist in `generated` and does not scan it
// when the dist blob equals buildWorkflow(src blob) at the tree AND at the base (review S1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkflow } from "../scripts/build-workflow.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROGRAM = resolve(HERE, "..", "scripts", "changed_defs.py");
const S = "plugins/ccpmcwf/src/build-engine.js";
const D = "plugins/ccpmcwf/workflows/build-engine.js";
const OTHER = "export function keep(x) {\n  return x;\n}\n";
const SRC0 =
  [
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
  ].join("\n") + "\n";

function git(cwd, ...args) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8" });
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

// base files and tree files (a null value deletes the path); returns the program's JSON and the worktree
function scan(baseFiles, treeFiles, exclude = [], afterTree = null) {
  const wt = mkdtempSync(join(tmpdir(), "v701-skip-"));
  try {
    git(wt, "init", "-q");
    put(wt, baseFiles);
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "base");
    const base = git(wt, "rev-parse", "HEAD");
    put(wt, Object.fromEntries(Object.entries(treeFiles).filter(([, v]) => v !== null)));
    for (const [p, v] of Object.entries(treeFiles)) if (v === null) rmSync(join(wt, p));
    git(wt, "add", "-A");
    const tree = git(wt, "write-tree");
    if (afterTree) afterTree(wt);
    const r = spawnSync("python3", ["-I", PROGRAM, wt, base, tree, JSON.stringify(exclude)], { encoding: "utf8" });
    assert.equal(r.status, 0, "changed_defs.py: " + r.stderr);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
}

const baseFiles = () => ({ [S]: SRC0, [D]: buildWorkflow(SRC0), "lib/other.js": OTHER });
const withA2 = SRC0.replace("a + 1", "a + 2");

test("AC1: main: fresh dist is generated and not scanned", () => {
  // AC1: main example
  const o = scan(baseFiles(), { [S]: withA2, [D]: buildWorkflow(withA2) });
  assert.deepStrictEqual(o.generated, [D]);
  assert.deepStrictEqual(o.defs, [{ name: "alpha", at: S + ":5", end: 7 }]);
  assert.deepStrictEqual(o.excluded, []);
  assert.deepStrictEqual(o.unattributed, []);
  assert.deepStrictEqual(o.unclassified, []);
});

test("AC1: triangulation: another src change, fresh dist", () => {
  // AC1: main example with b * 2 -> b * 5
  const src = SRC0.replace("b * 2", "b * 5");
  const o = scan(baseFiles(), { [S]: src, [D]: buildWorkflow(src) });
  assert.deepStrictEqual(o.generated, [D]);
  assert.deepStrictEqual(o.defs, [{ name: "beta", at: S + ":9", end: 11 }]);
  assert.deepStrictEqual(o.unattributed, []);
});

test("AC1: boundary: the check reads tree blobs, not the disk", () => {
  // AC1: worktree file D overwritten with garbage after write-tree
  const o = scan(baseFiles(), { [S]: withA2, [D]: buildWorkflow(withA2) }, [], (wt) => writeFileSync(join(wt, D), "garbage\n"));
  assert.deepStrictEqual(o.generated, [D]);
  assert.deepStrictEqual(o.defs, [{ name: "alpha", at: S + ":5", end: 7 }]);
});

test("AC1: boundary: stale base dist is scanned", () => {
  // AC1 (corrected by review S1): the dist is skipped only when it is the fresh build at BOTH ends.
  // Base D is a hand-edited stale build (an extra top-level const); the tree regenerates D from src.
  // The dropped const is a changed dist definition with no changed src line, so D must be scanned.
  const stale = buildWorkflow(SRC0) + "const staleProbe = 2;\n";
  const o = scan({ ...baseFiles(), [D]: stale }, { [S]: withA2, [D]: buildWorkflow(withA2) });
  assert.deepStrictEqual(o.generated, []);
  assert.ok(
    o.defs.some((d) => d.name === "staleProbe" && d.at.startsWith(D + ":")),
    "stale base dist def staleProbe reported: " + JSON.stringify(o.defs),
  );
});

test("AC1: boundary: dist not in the diff", () => {
  // AC1: only line 4 comment changes in S; D unchanged
  const o = scan(baseFiles(), { [S]: SRC0.replace("// c", "// d") });
  assert.deepStrictEqual(o.generated, []);
  assert.deepStrictEqual(o.defs, []);
  assert.deepStrictEqual(o.unattributed, [S + ":4"]);
});

test("AC1: triangulation: dist not in the diff, other comment text", () => {
  // AC1: a different comment edit on line 4 still leaves generated empty
  const o = scan(baseFiles(), { [S]: SRC0.replace("// c", "// zzz") });
  assert.deepStrictEqual(o.generated, []);
  assert.deepStrictEqual(o.defs, []);
  assert.deepStrictEqual(o.unattributed, [S + ":4"]);
});

test("AC1: boundary: exclude wins over generated", () => {
  // AC1: main tree with D excluded
  const o = scan(baseFiles(), { [S]: withA2, [D]: buildWorkflow(withA2) }, [D]);
  assert.deepStrictEqual(o.excluded, [D]);
  assert.deepStrictEqual(o.generated, []);
});
