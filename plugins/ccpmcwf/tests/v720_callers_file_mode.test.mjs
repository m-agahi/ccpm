// fleet 7.2.0 (L2178, yaadgaar #44) AC2: callers.py file mode writes the full inline JSON to a
// content-addressed file in the run scratch and prints only a summary of hashes and counts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { SCRIPTS_SRC, scratchRepo, sh, spawnSync } from "./harness.mjs";

const CALLERS = join(SCRIPTS_SRC, "callers.py");
const fileRun = (...a) => spawnSync("python3", ["-I", CALLERS, "file", ...a], { encoding: "utf8" });
const EMPTY = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

function mainRepo(extra) {
  const wt = scratchRepo("fleet-720-file-");
  mkdirSync(join(wt, "src"));
  writeFileSync(join(wt, "src/a.py"), "foo()\n\nfoo()\n");
  writeFileSync(join(wt, "README.md"), "x\nfoo\n");
  if (extra) extra(wt);
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-qm", "x");
  return wt;
}
const tmp = () => mkdtempSync(join(tmpdir(), "fleet-720-scratch-"));

test("7.2.0 AC2: file mode writes callers-<sha256>.json and prints the summary with line and path hashes", () => {
  const wt = mainRepo();
  const S = tmp();
  try {
    const r = fileRun(wt, "docs/plans/x.md", '["foo"]', "100", S);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.deepEqual(o.symbols, {
      // 8.9.5 (yaadgaar #112): the code hashes replace path_count and paths_sha256
      foo: {
        count: 3,
        sha256: "84048ae2c9d38392fc0b8888ebb4cda38a23ad15c39f161fd299260d9546cff7",
        auto_count: 1,
        code_count: 2,
        code_sha256: "0d6929e120b4a6c7de63332677250787bb7bdaf699bbc8524ef8693ab9161a6c",
        code_path_count: 1,
        code_paths_sha256: "ab74f77bcbbda6f03ee88a40ee6ca88e13b97ead7f322c07fde1ef785f0e970f",
      },
    });
    assert.deepEqual(o.capped, []);
    assert.deepEqual(o.doctest_md, []);
    assert.deepEqual(o.args, [wt, "docs/plans/x.md", '["foo"]', "100", S]);
    assert.ok(!("occurrences" in o));
    assert.match(o.digest, /^[0-9a-f]{64}$/);
    const m = /^(.*)\/callers\/callers-([0-9a-f]{64})\.json$/.exec(o.file);
    assert.ok(m, o.file);
    assert.equal(m[1], S);
    const bytes = readFileSync(o.file);
    // property: the file's sha256 equals the 64 hex in its name
    assert.equal(createHash("sha256").update(bytes).digest("hex"), m[2]);
    const f = JSON.parse(bytes.toString("utf8"));
    assert.deepEqual(f.occurrences.foo, ["README.md:2", "src/a.py:1", "src/a.py:3"]);
    assert.deepEqual(f.auto_dont_care.foo, ["README.md:2"]);
    assert.equal(readdirSync(join(S, "callers")).length, 1);
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(S, { recursive: true, force: true });
  }
});

test("7.2.0 AC2: a capped symbol has count 0 and the hash of []", () => {
  const wt = mainRepo((w) => writeFileSync(join(w, "src/c.py"), "bar()\n".repeat(101)));
  const S = tmp();
  try {
    const r = fileRun(wt, "docs/plans/x.md", '["bar"]', "100", S);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.deepEqual(o.symbols.bar, { count: 0, sha256: EMPTY, auto_count: 0, code_count: 0, code_sha256: EMPTY, code_path_count: 0, code_paths_sha256: EMPTY });
    assert.deepEqual(o.capped, ["bar"]);
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(S, { recursive: true, force: true });
  }
});

test("7.2.0 AC2: a repeated run writes the same file once", () => {
  const wt = mainRepo();
  const S = tmp();
  try {
    const a = fileRun(wt, "docs/plans/x.md", '["foo"]', "100", S);
    const before = readFileSync(JSON.parse(a.stdout).file);
    const b = fileRun(wt, "docs/plans/x.md", '["foo"]', "100", S);
    assert.equal(a.status, 0);
    assert.equal(b.status, 0);
    assert.equal(JSON.parse(a.stdout).file, JSON.parse(b.stdout).file);
    assert.equal(readdirSync(join(S, "callers")).length, 1);
    assert.deepEqual(readFileSync(JSON.parse(b.stdout).file), before);
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(S, { recursive: true, force: true });
  }
});

test("7.2.0 AC2: a write failure and a missing scratch argument exit with FLEET_CALLERS_FILE", () => {
  const wt = mainRepo();
  const T = tmp();
  const S = tmp();
  try {
    writeFileSync(join(T, "callers"), "not a dir");
    const bad = fileRun(wt, "docs/plans/x.md", '["foo"]', "100", T);
    assert.notEqual(bad.status, 0);
    assert.equal(bad.stdout, "");
    assert.ok(bad.stderr.startsWith("FLEET_CALLERS_FILE: cannot write the callers file"), bad.stderr);
    const ok = fileRun(wt, "docs/plans/x.md", '["foo"]', "100", S);
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok("file" in JSON.parse(ok.stdout));
    const few = fileRun(wt, "docs/plans/x.md", '["foo"]', "100");
    assert.notEqual(few.status, 0);
    assert.equal(few.stdout, "");
    assert.ok(few.stderr.startsWith("FLEET_CALLERS_FILE: "), few.stderr);
  } finally {
    for (const d of [wt, T, S]) rmSync(d, { recursive: true, force: true });
  }
});
