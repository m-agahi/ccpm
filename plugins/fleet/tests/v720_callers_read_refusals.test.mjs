// fleet 7.2.0 (L2178, yaadgaar #44) AC4: callers.py read mode refuses bad arguments and files
// with a FLEET_CALLERS_READ marker and prints nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { SCRIPTS_SRC, scratchRepo, sh, spawnSync } from "./harness.mjs";

const CALLERS = join(SCRIPTS_SRC, "callers.py");
const py = (...a) => spawnSync("python3", ["-I", CALLERS, ...a], { encoding: "utf8" });

test("7.2.0 AC4: every refusal exits non-zero with empty stdout and FLEET_CALLERS_READ; the control reads", () => {
  const wt = scratchRepo("fleet-720-refuse-");
  const S = mkdtempSync(join(tmpdir(), "fleet-720-scratch-"));
  const D = mkdtempSync(join(tmpdir(), "fleet-720-other-"));
  try {
    mkdirSync(join(wt, "src"));
    writeFileSync(join(wt, "src/a.py"), "foo()\n\nfoo()\n");
    writeFileSync(join(wt, "README.md"), "x\nfoo\n");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "x");
    const f = py("file", wt, "docs/plans/x.md", '["foo"]', "100", S);
    assert.equal(f.status, 0, f.stderr);
    const F = JSON.parse(f.stdout).file;
    const bytes = readFileSync(F);
    const changed = join(D, basename(F));
    // one byte changed, still a valid callers object: only the hash check refuses it
    writeFileSync(changed, bytes.toString("utf8").replace("README.md:2", "README.md:9"));
    assert.notEqual(readFileSync(changed, "utf8"), bytes.toString("utf8"));
    writeFileSync(join(D, "callers-ABC.json"), bytes);
    const cases = [
      ["read", F, "all", '["foo"]'],
      ["read", join(D, "callers-ABC.json"), "all", '["foo"]', "0"],
      ["read", changed, "all", '["foo"]', "0"],
      ["read", F, "code", '["foo"]', "0"],
      ["read", F, "all", "[]", "0"],
      ["read", F, "all", '["foo","foo"]', "0"],
      ["read", F, "all", '"foo"', "0"],
      ["read", F, "all", '["nope"]', "0"],
      ["read", F, "all", '["foo"]', "-1"],
      ["read", F, "all", '["foo"]', "1"],
    ];
    for (const c of cases) {
      const r = py(...c);
      assert.notEqual(r.status, 0, c.join(" "));
      assert.equal(r.stdout, "", c.join(" "));
      assert.ok(r.stderr.startsWith("FLEET_CALLERS_READ: "), c.join(" ") + " -> " + r.stderr);
    }
    // example 2: the control
    assert.equal(py("read", F, "all", '["foo"]', "0").status, 0);
  } finally {
    for (const d of [wt, S, D]) rmSync(d, { recursive: true, force: true });
  }
});
