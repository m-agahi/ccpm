// ccpmcwf 8.9.16 (yaadgaar #139): test_db_decl.py fails closed when git cannot read .fleet-test-db.json at
// origin/<default>. Only an empty listing of the root tree means "no file" (the shape runtime_docs.py has since 8.9.14).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { SCRIPTS_SRC, scratchRepo, sh, spawnSync } from "./harness.mjs";

const READER = join(SCRIPTS_SRC, "test_db_decl.py");
const CFG = ".fleet-test-db.json";
const DECL = { version: 1, engine: "mariadb", major: "11.4", env: "APP_TEST_DSN" };

function repo(setup, fn) {
  const wt = scratchRepo("fleet-8916-db-");
  try {
    writeFileSync(join(wt, "a.txt"), "a\n");
    setup(wt);
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "base");
    sh(wt, "git", "update-ref", "refs/remotes/origin/master", "HEAD");
    fn(wt);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
}
const read = (wt) => {
  const r = spawnSync("python3", ["-I", READER, wt, "master"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const withDecl = (wt) => writeFileSync(join(wt, CFG), JSON.stringify(DECL));
const dropObject = (wt, oid) => rmSync(join(wt, ".git", "objects", oid.slice(0, 2), oid.slice(2)));

test("8.9.16 (#139): a blob git cannot read is an error, never 'no declaration'", () => {
  repo(withDecl, (wt) => {
    dropObject(wt, sh(wt, "git", "rev-parse", "refs/remotes/origin/master:" + CFG).trim());
    const o = read(wt);
    assert.equal(o.decl, null);
    assert.equal(o.error, "git cannot read .fleet-test-db.json at origin/master");
  });
});

test("8.9.16 (#139): a root tree git cannot read is a list error", () => {
  repo(withDecl, (wt) => {
    dropObject(wt, sh(wt, "git", "rev-parse", "refs/remotes/origin/master^{tree}").trim());
    const o = read(wt);
    assert.equal(o.decl, null);
    assert.equal(o.error, "git cannot list the tree of origin/master");
  });
});

test("8.9.16 (#139): a directory or a symlink at the path is not a file", () => {
  repo((wt) => {
    mkdirSync(join(wt, CFG));
    writeFileSync(join(wt, CFG, "x"), "x");
  }, (wt) => {
    const o = read(wt);
    assert.equal(o.decl, null);
    assert.equal(o.error, ".fleet-test-db.json is not a file");
  });
  repo((wt) => {
    writeFileSync(join(wt, "real.json"), JSON.stringify(DECL));
    symlinkSync("real.json", join(wt, CFG));
  }, (wt) => {
    const o = read(wt);
    assert.equal(o.decl, null);
    assert.equal(o.error, ".fleet-test-db.json is not a file");
  });
});

test("8.9.16 (#139): no file is still no declaration and no error", () => {
  repo(() => {}, (wt) => {
    const o = read(wt);
    assert.equal(o.decl, null);
    assert.equal(o.error, null);
  });
});

test("8.9.16 (#139): an executable file (mode 100755) is read like a plain one", () => {
  repo((wt) => {
    withDecl(wt);
    chmodSync(join(wt, CFG), 0o755);
  }, (wt) => {
    assert.match(sh(wt, "git", "ls-tree", "refs/remotes/origin/master", "--", CFG), /^100755 blob /);
    const o = read(wt);
    assert.equal(o.error, null);
    assert.deepEqual(o.decl, DECL);
  });
});

test("8.9.16 (#139): a bad declaration keeps its error text; the output shape is unchanged", () => {
  repo((wt) => writeFileSync(join(wt, CFG), "{"), (wt) => {
    const o = read(wt);
    assert.equal(o.error, ".fleet-test-db.json is not JSON");
    assert.deepEqual(Object.keys(o).sort(), ["args", "decl", "digest", "error", "program"]);
    assert.equal(o.program.name, "test_db_decl");
  });
});
