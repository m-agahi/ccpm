// fleet 7.3.0 (#40 + #58, Max ruling 2026-11-17): only call-shaped hits (the name, optional
// spaces or tabs, then `(`) count toward the 100-hit cap of callers.py. The cap stays 100.
// Every git grep -w hit is still listed and mapped, call-shaped or not (a constant, a guard
// or a bare reference is a real occurrence); only the cap count changes. A small map keeps the
// base behaviour.
//
// dont_care: the order of keys in the printed object; the exact capped-finding wording beyond
// "call-shaped".

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SCRIPTS_SRC, SOURCE, ROLE_TEXT, spawnSync } from "./harness.mjs";

// 8.9.14 (yaadgaar #119): callers.py takes the runtime-doc list last (the engine's default here)
const RD = '["roles/**/*.md"]';

function repoWith(files) {
  const repo = mkdtempSync(join(tmpdir(), "fleet-730c-"));
  const git = (...a) => assert.equal(spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" }).status, 0, a.join(" "));
  git("init", "-q", "-b", "main");
  for (const [p, t] of Object.entries(files)) writeFileSync(join(repo, p), t);
  git("add", "-A");
  git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "init");
  return repo;
}
function callers(repo, syms, cap = "100") {
  const r = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "callers.py"), repo, "plan.md", JSON.stringify(syms), cap, RD], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("7.3.0 #40: 101 bare-word hits with 3 call-shaped ones are not capped; every hit is listed", () => {
  // f.py: 98 bare lines + 3 calls (one with a space, one with a tab) = 101 hits
  const lines = [];
  for (let i = 0; i < 98; i++) lines.push("x = of");
  lines.push("of(1)", "y = of (2)", "z = of\t(3)");
  const repo = repoWith({ "f.py": lines.join("\n") + "\n" });
  try {
    const o = callers(repo, ["of"]);
    assert.deepEqual(o.capped, []);
    assert.equal(o.occurrences.of.length, 101);
    assert.ok(o.occurrences.of.includes("f.py:1") && o.occurrences.of.includes("f.py:101"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("7.3.0 #40: more than 100 call-shaped hits stay capped (the cap is 100)", () => {
  const lines = [];
  for (let i = 0; i < 101; i++) lines.push("of(" + i + ")");
  const repo = repoWith({ "f.py": lines.join("\n") + "\n" });
  try {
    const o = callers(repo, ["of"]);
    assert.deepEqual(o.capped, ["of"]);
    assert.deepEqual(o.occurrences.of, []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("7.3.0 #40: a longer identifier followed by ( is not a call of the symbol; a small map is unchanged", () => {
  const lines = ["proof(1)", "of_x(2)", "a.of(3)", "of = 1"];
  const repo = repoWith({ "f.py": lines.join("\n") + "\n" });
  try {
    // cap 1: only a.of(3) is call-shaped; -w drops proof and of_x
    const o = callers(repo, ["of"], "1");
    assert.deepEqual(o.capped, []);
    assert.deepEqual(o.occurrences.of, ["f.py:3", "f.py:4"]);
    // two call-shaped hits over cap 1 -> capped
    const repo2 = repoWith({ "g.py": "of(1)\nof(2)\n" });
    try {
      assert.deepEqual(callers(repo2, ["of"], "1").capped, ["of"]);
    } finally {
      rmSync(repo2, { recursive: true, force: true });
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("7.3.0 #40: the workflow and the planner name the call-shaped cap", () => {
  assert.match(SOURCE, /more than " \+ MAX_SYMBOL_HITS \+ " call-shaped occurrences/);
  assert.match(ROLE_TEXT["scope-and-plan"].replace(/\s+/g, " "), /more than 100 call-shaped hits for one symbol/);
});
