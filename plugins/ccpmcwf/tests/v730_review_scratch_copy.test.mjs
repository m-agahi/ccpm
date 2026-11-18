// fleet 7.3.0 review fixes (B1, M1): scratch_copy.py derives the scratch dir from the
// worktree (<dirname(worktree)>/scratch, the fleet layout), and every mode names the
// worktree: make <worktree> [<rev>], run <worktree> <tmp> <argv json> [<env json>],
// patch <worktree> <tmp> <file> <old b64> <new b64>, remove <worktree> <tmp>. A <tmp> must
// be a direct child copy-* of that scratch dir AND a registered worktree of <worktree>
// before run, patch or remove touches it. run refuses terraform-family programs anywhere
// in argv and a shell given -c; an env PATH (absolute entries only) goes first. patch is
// the judges' way to change a copy (ccpmcwf:judge has no Edit or Write tool): exactly one
// occurrence, a regular file inside <tmp>.
//
// dont_care: the copy-* suffix; the wording of the refusal messages beyond what is pinned.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SCRIPTS_SRC, spawnSync } from "./harness.mjs";

const PY = join(SCRIPTS_SRC, "scratch_copy.py");
const py = (...a) => spawnSync("python3", ["-I", PY, ...a], { encoding: "utf8" });
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-730r-")));
  const wt = join(root, "main");
  mkdirSync(wt);
  const git = (...a) => {
    const r = spawnSync("git", ["-C", wt, ...a], { encoding: "utf8" });
    assert.equal(r.status, 0, a.join(" ") + ": " + r.stderr);
    return r.stdout;
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(wt, "gate.py"), "def ok(x):\n    return x > 0\n# x > 0 again\n");
  git("add", "-A");
  git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "init");
  return { root, wt, scratch: join(root, "scratch"), git };
}

test("7.3.0 review M1: make derives <dirname(worktree)>/scratch; run and remove take the worktree, not a scratch dir", () => {
  const f = fixture();
  try {
    const m = py("make", f.wt);
    assert.equal(m.status, 0, m.stderr);
    const o = JSON.parse(m.stdout);
    assert.match(o.tmp, new RegExp("^" + f.scratch + "/copy-[^/]+$"));
    assert.deepEqual(o.args, [f.wt]);
    const r = JSON.parse(py("run", f.wt, o.tmp, JSON.stringify(["false"])).stdout);
    assert.equal(r.exit_code, 1);
    const rm = py("remove", f.wt, o.tmp);
    assert.equal(rm.status, 0, rm.stderr);
    assert.equal(JSON.parse(rm.stdout).removed, true);
    assert.ok(!existsSync(o.tmp));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("7.3.0 review M1: run, patch and remove refuse a tmp that is not a registered copy-* child of the derived scratch dir", () => {
  const f = fixture();
  try {
    mkdirSync(f.scratch, { recursive: true });
    // a copy-* dir no worktree registers: remove must not delete it
    const fake = join(f.scratch, "copy-fake");
    mkdirSync(fake);
    writeFileSync(join(fake, "keep"), "x");
    assert.notEqual(py("remove", f.wt, fake).status, 0);
    assert.ok(existsSync(join(fake, "keep")));
    assert.notEqual(py("run", f.wt, fake, JSON.stringify(["true"])).status, 0);
    // a registered worktree that is not named copy-*, the scratch dir itself, a nested dir, the worktree
    const other = join(f.scratch, "judge-mut");
    f.git("worktree", "add", "-q", "--detach", other, "HEAD");
    for (const t of [other, f.scratch, f.wt, join(f.scratch, "copy-fake", "x")]) {
      assert.notEqual(py("remove", f.wt, t).status, 0, t);
      assert.notEqual(py("run", f.wt, t, JSON.stringify(["true"])).status, 0, t);
    }
    assert.ok(existsSync(other));
    // the old scratch_dir argument form is refused
    const o = JSON.parse(py("make", f.wt).stdout);
    assert.notEqual(py("run", f.scratch, o.tmp, JSON.stringify(["true"])).status, 0);
    assert.notEqual(py("remove", f.wt, f.scratch, o.tmp).status, 0);
    assert.notEqual(py("make", f.wt, f.scratch, "HEAD").status, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("7.3.0 review M1: run refuses terraform-family programs anywhere in argv and a shell with -c; nothing runs", () => {
  const f = fixture();
  try {
    const o = JSON.parse(py("make", f.wt).stdout);
    const refused = [
      ["terraform", "plan"],
      ["/usr/local/bin/tofu", "plan"],
      ["timeout", "60", "terraform", "plan"],
      ["env", "A=1", "tfp"],
      ["nice", "-n", "5", "terragrunt", "plan"],
      ["digger"],
      ["atlantis", "plan"],
      ["sh", "-c", "touch marker"],
      ["bash", "-lc", "touch marker"],
      ["timeout", "9", "zsh", "-ec", "touch marker"],
    ];
    for (const a of refused) {
      const r = py("run", f.wt, o.tmp, JSON.stringify(a));
      assert.notEqual(r.status, 0, JSON.stringify(a));
      assert.match(r.stderr, /refus/, JSON.stringify(a));
    }
    assert.ok(!existsSync(join(o.tmp, "marker")));
    // a shell running a script file is a command, not a -c string
    writeFileSync(join(o.tmp, "s.sh"), "echo ran\n");
    const s = JSON.parse(py("run", f.wt, o.tmp, JSON.stringify(["bash", "s.sh"])).stdout);
    assert.equal(s.exit_code, 0);
    assert.match(s.tail, /ran/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("7.3.0 review M1: an env PATH does not crash run; its absolute entries go first; a relative entry is refused", () => {
  const f = fixture();
  try {
    const o = JSON.parse(py("make", f.wt).stdout);
    const bin = join(f.root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "fleet-probe"), "#!/bin/sh\necho probe-from-env-path\n", { mode: 0o755 });
    const r = py("run", f.wt, o.tmp, JSON.stringify(["fleet-probe"]), JSON.stringify({ PATH: bin }));
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.exit_code, 0, out.tail);
    assert.match(out.tail, /probe-from-env-path/);
    // the system PATH stays reachable after the env entries
    const g = JSON.parse(py("run", f.wt, o.tmp, JSON.stringify(["git", "--version"]), JSON.stringify({ PATH: bin })).stdout);
    assert.equal(g.exit_code, 0, g.tail);
    assert.notEqual(py("run", f.wt, o.tmp, JSON.stringify(["true"]), JSON.stringify({ PATH: "rel/bin:" + bin })).status, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("7.3.0 review B1: patch replaces exactly one occurrence in a regular file inside the copy", () => {
  const f = fixture();
  try {
    const o = JSON.parse(py("make", f.wt).stdout);
    const p = py("patch", f.wt, o.tmp, "gate.py", b64("    return x > 0\n"), b64("    return True\n"));
    assert.equal(p.status, 0, p.stderr);
    assert.deepEqual(JSON.parse(p.stdout).args, [f.wt, o.tmp, "gate.py"]);
    assert.equal(readFileSync(join(o.tmp, "gate.py"), "utf8"), "def ok(x):\n    return True\n# x > 0 again\n");
    // the fleet worktree is untouched
    assert.match(readFileSync(join(f.wt, "gate.py"), "utf8"), /return x > 0/);
    // two occurrences, none, a path out of the copy, a symlink, bad base64: refused, file unchanged
    writeFileSync(join(o.tmp, "two.txt"), "a\na\n");
    assert.notEqual(py("patch", f.wt, o.tmp, "two.txt", b64("a"), b64("b")).status, 0);
    assert.equal(readFileSync(join(o.tmp, "two.txt"), "utf8"), "a\na\n");
    assert.notEqual(py("patch", f.wt, o.tmp, "gate.py", b64("nothere"), b64("b")).status, 0);
    assert.notEqual(py("patch", f.wt, o.tmp, "../main/gate.py", b64("return x > 0"), b64("return 1")).status, 0);
    assert.notEqual(py("patch", f.wt, o.tmp, "/etc/hostname", b64("a"), b64("b")).status, 0);
    symlinkSync(join(f.wt, "gate.py"), join(o.tmp, "link.py"));
    assert.notEqual(py("patch", f.wt, o.tmp, "link.py", b64("return x > 0"), b64("return 1")).status, 0);
    assert.match(readFileSync(join(f.wt, "gate.py"), "utf8"), /return x > 0/);
    assert.notEqual(py("patch", f.wt, o.tmp, "gate.py", "!!notbase64", b64("b")).status, 0);
    // patch on an unregistered copy-* dir is refused
    const fake = join(f.scratch, "copy-fake");
    mkdirSync(fake);
    writeFileSync(join(fake, "f"), "a");
    assert.notEqual(py("patch", f.wt, fake, "f", b64("a"), b64("b")).status, 0);
    assert.equal(readFileSync(join(fake, "f"), "utf8"), "a");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
