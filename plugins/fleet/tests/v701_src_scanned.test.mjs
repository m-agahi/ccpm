// fleet 7.0.1 (yaadgaar #55, L2190) AC3: the src file stays scanned.
// changed_defs.py skips the generated dist only; the changed definitions of
// plugins/fleet/src/build-task-run.js are still listed, even when the dist is
// the fresh build of the src at the tree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROGRAM = join(HERE, "..", "scripts", "changed_defs.py");
const { buildWorkflow } = await import(join(HERE, "..", "scripts", "build-workflow.mjs"));

const S = "plugins/fleet/src/build-task-run.js";
const D = "plugins/fleet/workflows/build-task-run.js";
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

function git(cwd, args) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }),
  });
  assert.equal(r.status, 0, "git " + args.join(" ") + ": " + r.stderr);
  return r.stdout.trim();
}

function put(dir, files) {
  for (const [p, text] of Object.entries(files)) {
    const f = join(dir, p);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text);
  }
}

// base commit holds `baseFiles`; the tree holds `treeFiles` (written over the base files); returns the program's JSON
function runProgram(baseFiles, treeFiles) {
  const dir = mkdtempSync(join(tmpdir(), "v701-src-"));
  try {
    git(dir, ["init", "-q"]);
    put(dir, baseFiles);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "base"]);
    const base = git(dir, ["rev-parse", "HEAD"]);
    put(dir, treeFiles);
    git(dir, ["add", "-A"]);
    const tree = git(dir, ["write-tree"]);
    const r = spawnSync("python3", ["-I", PROGRAM, dir, base, tree, "[]"], {
      encoding: "utf8",
      env: Object.assign({}, process.env, { PYTHONDONTWRITEBYTECODE: "1" }),
    });
    assert.equal(r.status, 0, "changed_defs.py exited " + r.status + ": " + r.stderr);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const baseFiles = {
  [S]: SRC0,
  [D]: buildWorkflow(SRC0),
  "lib/other.js": "export function keep(x) {\n  return x;\n}\n",
};
const srcDefs = (o) => o.defs.filter((d) => d.at.startsWith(S + ":"));

test("AC3: changed definitions of the src stay listed when the dist is the fresh build", () => {
  // AC3: tree S = SRC0 with 'a + 2' and 'b * 3', D = build(that)
  const s = SRC0.replace("a + 1", "a + 2").replace("b * 2", "b * 3");
  const o = runProgram(baseFiles, { [S]: s, [D]: buildWorkflow(s) });
  assert.deepEqual(srcDefs(o), [
    { name: "alpha", at: S + ":5", end: 7 },
    { name: "beta", at: S + ":9", end: 11 },
  ]);
});

test("AC3: triangulation, a change in only beta lists only beta of the src", () => {
  // AC3: only the changed definition is listed; alpha stays out
  const s = SRC0.replace("b * 2", "b * 4");
  const o = runProgram(baseFiles, { [S]: s, [D]: buildWorkflow(s) });
  assert.deepEqual(srcDefs(o), [{ name: "beta", at: S + ":9", end: 11 }]);
});

test("AC3: triangulation, a change of the top-level constant of the src lists it", () => {
  // AC3: a changed top-level definition of the src is listed with the dist fresh
  const s = SRC0.replace("const TOP = 1;", "const TOP = 2;");
  const o = runProgram(baseFiles, { [S]: s, [D]: buildWorkflow(s) });
  assert.deepEqual(srcDefs(o), [{ name: "TOP", at: S + ":13", end: 13 }]);
});
