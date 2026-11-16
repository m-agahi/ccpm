// fleet 7.0.1 AC4: repos without the ccpm src/dist layout are unaffected by the
// generated-dist check: `generated` is [] and every changed file is scanned.
//
// Run: node --test plugins/fleet/tests/v701_other_layouts.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkflow } from "../scripts/build-workflow.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROGRAM = join(HERE, "..", "scripts", "changed_defs.py");

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
const OTHER = "export function keep(x) {\n  return x;\n}\n";

// a scratch repo; each snapshot is a tree id (no commit, no signing, no hooks)
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "v701-other-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...a) => {
    const r = spawnSync("git", ["-C", dir, ...a], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git("init", "-q");
  const snap = (files) => {
    git("rm", "-r", "-q", "--cached", "--ignore-unmatch", ".");
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(join(dir, dirname(p)), { recursive: true });
      writeFileSync(join(dir, p), c);
    }
    git("add", "-A", "-f");
    return git("write-tree");
  };
  const scan = (base, tree) => {
    const r = spawnSync("python3", ["-I", PROGRAM, dir, base, tree, "[]"], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  return { dir, snap, scan };
}

function withRepo(fn) {
  const r = repo();
  try {
    return fn(r);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
}

const bump = (s, from, to) => {
  assert.ok(s.includes(from));
  return s.replace(from, to);
};

test("AC4: other paths, dist rebuilt, nothing is generated and both files are scanned", () => {
  withRepo(({ snap, scan }) => {
    const S = "app/src/build-task-run.js";
    const D = "app/workflows/build-task-run.js";
    const base = snap({ [S]: SRC0, [D]: buildWorkflow(SRC0) });
    const next = bump(SRC0, "a + 1", "a + 2");
    const tree = snap({ [S]: next, [D]: buildWorkflow(next) });
    const out = scan(base, tree);
    // AC4: other paths -> generated == []
    assert.deepEqual(out.generated, []);
    // AC4: every changed file is scanned as today
    assert.deepEqual(out.defs, [
      { name: "alpha", at: S + ":5", end: 7 },
      { name: "r", at: D + ":5", end: 5 },
      { name: "r", at: D + ":9", end: 9 },
    ]);
  });
});

test("AC4 triangulation: other directory, other edit, still no generated and both files scanned", () => {
  withRepo(({ snap, scan }) => {
    const S = "pkg/src/build-task-run.js";
    const D = "pkg/workflows/build-task-run.js";
    const base = snap({ [S]: SRC0, [D]: buildWorkflow(SRC0) });
    const next = bump(SRC0, "b * 2", "b * 3");
    const tree = snap({ [S]: next, [D]: buildWorkflow(next) });
    const out = scan(base, tree);
    // AC4: other paths -> generated == []
    assert.deepEqual(out.generated, []);
    // AC4: the src definition is listed, and the dist file is scanned too
    assert.ok(out.defs.some((d) => d.name === "beta" && d.at === S + ":9" && d.end === 11), JSON.stringify(out.defs));
    assert.ok(out.defs.some((d) => d.at.startsWith(D + ":")), JSON.stringify(out.defs));
  });
});

test("AC4: no src or dist files, a plain file is scanned and generated is []", () => {
  withRepo(({ snap, scan }) => {
    const base = snap({ "lib/other.js": OTHER });
    const tree = snap({ "lib/other.js": bump(OTHER, "return x;", "return x + 1;") });
    const out = scan(base, tree);
    // AC4: no such files -> generated == []
    assert.deepEqual(out.generated, []);
    assert.deepEqual(out.defs, [{ name: "keep", at: "lib/other.js:1", end: 2 }]);
  });
});

test("AC4 triangulation: another plain path and edit, generated is [] and the definition is listed", () => {
  withRepo(({ snap, scan }) => {
    const base = snap({ "tools/other.js": OTHER });
    const tree = snap({ "tools/other.js": bump(OTHER, "return x;", "return x * 2;") });
    const out = scan(base, tree);
    // AC4: no such files -> generated == []
    assert.deepEqual(out.generated, []);
    assert.deepEqual(out.defs, [{ name: "keep", at: "tools/other.js:1", end: 2 }]);
  });
});

test("AC4: dist path without a src, generated is [] and the dist definitions are scanned", () => {
  withRepo(({ snap, scan }) => {
    const D = "plugins/fleet/workflows/build-task-run.js";
    const base = snap({ [D]: buildWorkflow(SRC0) });
    const tree = snap({ [D]: buildWorkflow(bump(SRC0, "a + 1", "a + 2")) });
    const out = scan(base, tree);
    // AC4: dist path without src -> generated == []
    assert.deepEqual(out.generated, []);
    assert.ok(out.defs.some((d) => d.name === "r" && d.at === D + ":5" && d.end === 5), JSON.stringify(out.defs));
  });
});

test("AC4 triangulation: dist path without a src, another edit, generated is [] and the edited line is listed", () => {
  withRepo(({ snap, scan }) => {
    const D = "plugins/fleet/workflows/build-task-run.js";
    const base = snap({ [D]: buildWorkflow(SRC0) });
    const tree = snap({ [D]: buildWorkflow(bump(SRC0, "b * 2", "b * 3")) });
    const out = scan(base, tree);
    // AC4: dist path without src -> generated == []
    assert.deepEqual(out.generated, []);
    assert.ok(out.defs.some((d) => d.name === "r" && d.at === D + ":9" && d.end === 9), JSON.stringify(out.defs));
  });
});
