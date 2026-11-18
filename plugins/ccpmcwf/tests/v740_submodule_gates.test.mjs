// fleet 7.4.0 car 3, X1 (car-2 report): tf_gate.py and changed_defs.py run porcelain `git diff`
// with --ignore-submodules=none, so diff.ignoreSubmodules=all cannot hide a gitlink bump.
// - tf_gate.py reads through a scratch bare repo with an empty config, so the setting reaches it
//   only from the user's global config (here GIT_CONFIG_GLOBAL). A bumped gitlink inside a dir
//   that existing IaC runs at plan time (a data external program) is a problem.
// - changed_defs.py runs in the worktree, so the repo's own config is enough. A gitlink has no
//   blob to scan: it is listed as unclassified (the callers gate checks it against the plan).
//
// dont_care: the stub git's shape; the problem text past the path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCRIPTS_SRC, sh, spawnSync } from "./harness.mjs";

const PY = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
const GIT = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
const sp = (n) => join(SCRIPTS_SRC, n + ".py");

function cfg(wt) {
  sh(wt, "git", "init", "-q", "-b", "master");
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"], ["core.hooksPath", "/dev/null"]]) sh(wt, "git", "config", k, v);
}
// a repo with stack/main.tf (an existing data external program) and a gitlink at stack/vendor
// (an embedded repo); bump() commits a new gitlink commit in the superproject
function repo() {
  const home = mkdtempSync(join(tmpdir(), "fleet-740-x1-"));
  const wt = join(home, "repo");
  const sm = join(wt, "stack", "vendor");
  mkdirSync(sm, { recursive: true });
  cfg(wt);
  cfg(sm);
  writeFileSync(join(sm, "run.sh"), "echo a\n");
  sh(sm, "git", "add", "run.sh");
  sh(sm, "git", "commit", "-qm", "a");
  writeFileSync(join(wt, "stack", "main.tf"), 'data "external" "x" {\n  program = ["sh", "vendor/run.sh"]\n}\n');
  writeFileSync(join(wt, "x.py"), "def f():\n    return 1\n");
  sh(wt, "git", "add", "stack/main.tf", "stack/vendor", "x.py");
  sh(wt, "git", "commit", "-qm", "base");
  const base = sh(wt, "git", "rev-parse", "HEAD").trim();
  writeFileSync(join(sm, "run.sh"), "echo b\n");
  sh(sm, "git", "commit", "-qam", "b");
  sh(wt, "git", "add", "stack/vendor");
  sh(wt, "git", "commit", "-qm", "bump");
  const head = sh(wt, "git", "rev-parse", "HEAD").trim();
  return { home, wt, base, head, done: () => rmSync(home, { recursive: true, force: true }) };
}

test("7.4.0 X1: tf_gate.py sees a gitlink bump under a global diff.ignoreSubmodules=all", () => {
  const r = repo();
  try {
    const bin = join(r.home, "bin");
    mkdirSync(bin);
    // ls-remote answers the base (the repo has it, so nothing is fetched); every other verb is real git
    writeFileSync(
      join(bin, "git"),
      "#!" + PY + "\nimport os, sys\na = sys.argv[1:]\ni = 0\nverb = None\n" +
        "while i < len(a):\n    if a[i] in ('-c', '-C'):\n        i += 2\n        continue\n    if a[i].startswith('-'):\n        i += 1\n        continue\n    verb = a[i]\n    break\n" +
        "if verb == 'ls-remote':\n    sys.stdout.write(" + JSON.stringify(r.base) + " + '\\t' + a[-1] + '\\n')\n    sys.exit(0)\n" +
        "os.execv(" + JSON.stringify(GIT) + ", [" + JSON.stringify(GIT) + "] + a)\n",
    );
    chmodSync(join(bin, "git"), 0o755);
    const gc = join(r.home, "gitconfig");
    writeFileSync(gc, "[diff]\n\tignoreSubmodules = all\n");
    const o = spawnSync(PY, ["-I", sp("tf_gate"), r.wt, "master", r.head, "https://example.com/o/r.git"], { encoding: "utf8", env: { PATH: bin, HOME: r.home, GIT_CONFIG_GLOBAL: gc } });
    assert.equal(o.status, 0, o.stderr);
    const out = JSON.parse(o.stdout);
    assert.ok(out.problems.some((p) => p.includes("changes code that existing IaC runs at plan time: stack/vendor")), JSON.stringify(out.problems));
  } finally {
    r.done();
  }
});

test("7.4.0 X1: changed_defs.py lists a gitlink bump as unclassified under the repo's diff.ignoreSubmodules=all", () => {
  const r = repo();
  try {
    sh(r.wt, "git", "config", "diff.ignoreSubmodules", "all");
    const o = spawnSync(PY, ["-I", sp("changed_defs"), r.wt, r.base, r.head, "[]"], { encoding: "utf8" });
    assert.equal(o.status, 0, o.stderr);
    const out = JSON.parse(o.stdout);
    assert.deepEqual(out.unclassified, ["stack/vendor"], o.stdout);
    assert.deepEqual(out.defs, []);
  } finally {
    r.done();
  }
});

test("7.4.0 X1: the porcelain tree diffs of tf_gate and changed_defs carry --ignore-submodules=none", () => {
  const src = (n) => spawnSync("cat", [sp(n)], { encoding: "utf8" }).stdout;
  const tf = src("tf_gate");
  assert.match(tf, /run\('diff', '--ignore-submodules=none', '--name-only', '-z', '--no-renames', rng, '--'\)/);
  assert.match(tf, /run\('diff', '--ignore-submodules=none', '--raw', '-z', '--no-renames', rng, '--'\)/);
  const cd = src("changed_defs");
  assert.match(cd, /run\('diff', '--ignore-submodules=none', '--name-status', '-z', '-M', base, tree, '--'\)/);
});
