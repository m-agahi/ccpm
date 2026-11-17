// fleet 7.3.0 review fix (M1, security review): the primary guard in scratch_copy.py run is
// the agent PATH: the child's PATH lookup of a terraform-family name resolves exactly as the
// agent PATH resolves it (the nix shim the path_check gate verified, or nothing). An env PATH
// entry that holds such a name is refused, so it can never shadow the shim. The argv denylist
// is defense in depth only: it also refuses env -S/--split-string, git -c alias.*, and the
// inline-code forms of interpreters (python* -c, node -e/-p/--eval, perl -e, ruby -e).
//
// dont_care: the shim's output text beyond the marker the test prints.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SCRIPTS_SRC, spawnSync } from "./harness.mjs";

const PY = join(SCRIPTS_SRC, "scratch_copy.py");
const TF = ["terra", "form"].join("");

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-730g-")));
  const wt = join(root, "main");
  mkdirSync(wt);
  const git = (...a) => assert.equal(spawnSync("git", ["-C", wt, ...a], { encoding: "utf8" }).status, 0, a.join(" "));
  git("init", "-q", "-b", "main");
  git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init");
  // the agent PATH's shim, and a fake real binary in a dir a caller could hand in
  const shim = join(root, "shim");
  const real = join(root, "real");
  mkdirSync(shim);
  mkdirSync(real);
  writeFileSync(join(shim, TF), "#!/bin/sh\necho shim-reached\nexit 3\n", { mode: 0o755 });
  writeFileSync(join(real, TF), "#!/bin/sh\ntouch " + join(root, "real-reached") + "\n", { mode: 0o755 });
  const env = Object.assign({}, process.env, { PATH: shim + ":" + process.env.PATH });
  const py = (...a) => spawnSync("python3", ["-I", PY, ...a], { encoding: "utf8", env });
  const tmp = JSON.parse(py("make", wt).stdout).tmp;
  writeFileSync(join(tmp, "probe.sh"), TF + " plan\n");
  return { root, wt, tmp, real, py };
}

test("7.3.0 review M1: a PATH lookup in the child hits the agent PATH's shim; an env PATH dir holding the tool is refused", () => {
  const f = fixture();
  try {
    const venv = join(f.root, "venv");
    mkdirSync(venv);
    const ok = JSON.parse(f.py("run", f.wt, f.tmp, JSON.stringify(["sh", "probe.sh"]), JSON.stringify({ PATH: venv })).stdout);
    assert.match(ok.tail, /shim-reached/);
    assert.equal(ok.exit_code, 3);
    const r = f.py("run", f.wt, f.tmp, JSON.stringify(["sh", "probe.sh"]), JSON.stringify({ PATH: f.real }));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /refus/);
    assert.ok(!existsSync(join(f.root, "real-reached")));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("7.3.0 review M1: the denylist refuses env -S, git -c alias.*, and interpreter inline-code forms", () => {
  const f = fixture();
  try {
    for (const a of [
      ["env", "-S", "sh probe.sh"],
      ["env", "--split-string=sh probe.sh"],
      ["git", "-c", "alias.x=!sh probe.sh", "x"],
      ["python3", "-c", "print(1)"],
      ["python3.12", "-Bc", "print(1)"],
      ["node", "-e", "1"],
      ["node", "--eval", "1"],
      ["node", "-p", "1"],
      ["perl", "-e", "1"],
      ["perl", "-ne", "1"],
      ["ruby", "-e", "1"],
    ]) {
      const r = f.py("run", f.wt, f.tmp, JSON.stringify(a));
      assert.notEqual(r.status, 0, JSON.stringify(a));
      assert.match(r.stderr, /refus/, JSON.stringify(a));
    }
    // a script file is still a command
    writeFileSync(join(f.tmp, "t.py"), "print('py-ran')\n");
    assert.match(JSON.parse(f.py("run", f.wt, f.tmp, JSON.stringify(["python3", "t.py"])).stdout).tail, /py-ran/);
    assert.equal(JSON.parse(f.py("run", f.wt, f.tmp, JSON.stringify(["git", "-c", "core.pager=cat", "status"])).stdout).exit_code, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
