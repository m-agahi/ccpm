// fleet 7.2.0 (L2178, yaadgaar #44) AC3: callers.py read mode pages over all listed symbols at
// once, 50 entries a page, for parts all, auto and paths.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SCRIPTS_SRC, scratchRepo, sh, spawnSync } from "./harness.mjs";

const CALLERS = join(SCRIPTS_SRC, "callers.py");
const py = (...a) => spawnSync("python3", ["-I", CALLERS, ...a], { encoding: "utf8" });
function withRepo(files, syms, fn) {
  const wt = scratchRepo("fleet-720-read-");
  const S = mkdtempSync(join(tmpdir(), "fleet-720-scratch-"));
  try {
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(join(wt, p, ".."), { recursive: true });
      writeFileSync(join(wt, p), c);
    }
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "x");
    const r = py("file", wt, "docs/plans/x.md", JSON.stringify(syms), "100", S);
    assert.equal(r.status, 0, r.stderr);
    fn(JSON.parse(r.stdout).file);
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(S, { recursive: true, force: true });
  }
}
const read = (F, part, syms, page) => {
  const r = py("read", F, part, syms, String(page));
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const MAIN = { "src/a.py": "foo()\n\nfoo()\n", "README.md": "x\nfoo\n", "src/b.py": "x\nbaz()\n" };

// 8.9.5 (yaadgaar #112): no part auto; part paths lists code paths only (README.md is a doc)
test("7.2.0 AC3: parts all and paths of one page over two symbols; no auto key", () => {
  withRepo(MAIN, ["baz", "foo"], (F) => {
    const a = read(F, "all", '["baz","foo"]', 0);
    assert.equal(a.part, "all");
    assert.deepEqual(a.page, { index: 0, count: 1 });
    assert.deepEqual(a.hits, { baz: ["src/b.py:2"], foo: ["README.md:2", "src/a.py:1", "src/a.py:3"] });
    assert.ok(!("auto" in a));
    assert.deepEqual(a.args, [F, "all", '["baz","foo"]', "0"]);
    assert.match(a.digest, /^[0-9a-f]{64}$/);
    const p = read(F, "paths", '["baz","foo"]', 0);
    assert.equal(p.part, "paths");
    assert.deepEqual(p.page, { index: 0, count: 1 });
    assert.deepEqual(p.hits, { baz: ["src/b.py"], foo: ["src/a.py"] });
  });
});

test("7.2.0 AC3: 60 hits make two pages in code-point order; joining the pages gives the full list", () => {
  withRepo({ "src/m.py": "many()\n".repeat(60) }, ["many"], (F) => {
    const p0 = read(F, "all", '["many"]', 0);
    const p1 = read(F, "all", '["many"]', 1);
    assert.deepEqual(p0.page, { index: 0, count: 2 });
    assert.equal(p0.hits.many.length, 50);
    assert.deepEqual(p0.hits.many.slice(0, 3), ["src/m.py:1", "src/m.py:10", "src/m.py:11"]);
    assert.deepEqual(p1.page, { index: 1, count: 2 });
    assert.deepEqual(p1.hits.many, ["src/m.py:55", "src/m.py:56", "src/m.py:57", "src/m.py:58", "src/m.py:59", "src/m.py:6", "src/m.py:60", "src/m.py:7", "src/m.py:8", "src/m.py:9"]);
    const all = p0.hits.many.concat(p1.hits.many);
    assert.deepEqual(all, Array.from({ length: 60 }, (_, i) => "src/m.py:" + (i + 1)).sort());
  });
});

test("7.2.0 AC3: a page spans symbols in code-point order; a symbol with no entry on the page has no key", () => {
  withRepo({ "src/p.py": "aa1()\n".repeat(30), "src/q.py": "aa2()\n".repeat(30) }, ["aa1", "aa2"], (F) => {
    const p0 = read(F, "all", '["aa2","aa1"]', 0);
    const p1 = read(F, "all", '["aa2","aa1"]', 1);
    assert.equal(p0.page.count, 2);
    assert.equal(p0.hits.aa1.length, 30);
    assert.equal(p0.hits.aa2.length, 20);
    assert.deepEqual(Object.keys(p1.hits), ["aa2"]);
    assert.equal(p1.hits.aa2.length, 10);
  });
  withRepo({ "src/n.py": "x\n" }, ["nothing_here"], (F) => {
    const p = read(F, "all", '["nothing_here"]', 0);
    assert.deepEqual(p.page, { index: 0, count: 1 });
    assert.deepEqual(p.hits, {});
  });
});
