// fleet 7.4.0 car 3 (#31, L2103, the leak part): policy_init.py temp_copy removes its mkstemp
// file when the fchmod, write or fsync raises, then raises the error again. A driver script loads
// the helper by path and makes one of those calls raise.
//
// dont_care: the exception text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERE, spawnSync } from "./harness.mjs";

const HELPER = join(HERE, "..", "skills", "fleet-policy", "policy_init.py");
const DRIVER = [
  "import importlib.util, os, sys",
  "helper, fleet_dir, which = sys.argv[1], sys.argv[2], sys.argv[3]",
  "spec = importlib.util.spec_from_file_location('policy_init', helper)",
  "m = importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(m)",
  "def boom(*a, **k):",
  "    raise OSError(28, 'No space left on device')",
  "if which != 'none':",
  "    setattr(m.os, which, boom)",
  "try:",
  "    tmp = m.temp_copy(b'{}\\n', fleet_dir)",
  "    print('ok ' + os.path.basename(tmp))",
  "except OSError as e:",
  "    print('raised ' + str(e.errno))",
  "",
].join("\n");

function drive(which) {
  const h = mkdtempSync(join(tmpdir(), "fleet-740-pi-"));
  try {
    const fleet = join(h, "fleet");
    mkdirSync(fleet);
    const drv = join(h, "drv.py");
    writeFileSync(drv, DRIVER);
    const r = spawnSync("python3", ["-I", drv, HELPER, fleet, which], { encoding: "utf8" });
    return { out: r.stdout.trim(), err: r.stderr, left: readdirSync(fleet) };
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
}

test("7.4.0 #31 L1: a write, fchmod or fsync that raises inside temp_copy leaves no temp file in the fleet dir", () => {
  for (const which of ["write", "fchmod", "fsync"]) {
    const r = drive(which);
    assert.equal(r.out, "raised 28", which + ": " + r.out + r.err);
    assert.deepEqual(r.left, [], which + ": temp file left: " + r.left.join(", "));
  }
});

test("7.4.0 #31 L1: a good temp_copy keeps its file (control)", () => {
  const r = drive("none");
  assert.match(r.out, /^ok \.policy-init-.*\.json$/, r.out + r.err);
  assert.equal(r.left.length, 1);
});
