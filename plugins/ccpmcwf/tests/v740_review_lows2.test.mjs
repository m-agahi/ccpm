// fleet 7.4.0 review (B-M1, B-m2, B-m8, A-m2, A-m3, A-m4): the npm plan guard, the nested-npm
// reader, submodule-blind diffs and the format exemption.
// - B-M1: the #39 walk-up guard stops only when the root package.json at HEAD is not a JSON object
//   or its scripts.<name> is not a string (the new `pkg:scripts.<name>` target). The nested
//   `npm:<name>` entry is for R4 only: a root scripts.test of `npm run -w packages/web test` or of
//   `cd web && npm run build && jest` plans with no finding. With no root package.json the plan
//   still stops. In the nested reader `-w X`, `--workspace X`, `--prefix X` (and the other valued
//   flags) are never the script name, and a run in another package gives no R4 entry.
// - B-m8: `yarn test:unit` names the script test:unit, not test.
// - A-m4: yarn never takes the `--if-present` skip (`yarn run X` runs a package binary when the
//   script is missing).
// - B-m2: hook_surface's re.split passes maxsplit by keyword.
// - A-m2: every git diff-tree in scripts/*.py passes --ignore-submodules=none (a .gitmodules
//   `ignore = all` hides a gitlink change from diff-tree otherwise); fleet_scan.py refuses a PR
//   that adds or changes a submodule.*.ignore key.
// - A-m3: format_files' config_like compares names lower-cased and covers jest.setup.*,
//   setupTests.*, vitest.workspace.* and any path under __mocks__/.
//
// dont_care: the wording of program errors after the pinned phrases.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ARGS, SCRIPTS_SRC, happy, runOne, call, inputsOf, spawnSync } from "./harness.mjs";

function gitEnv(dir) {
  return Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: join(dir, ".gc"), GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
}
function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-740rl-"));
  const env = gitEnv(dir);
  const wt = join(dir, "wt");
  mkdirSync(wt);
  const g = (...a) => {
    const r = spawnSync("git", ["-C", wt, "-c", "commit.gpgsign=false"].concat(a), { encoding: "utf8", env });
    assert.equal(r.status, 0, a.join(" ") + ": " + r.stderr);
    return r.stdout.trim();
  };
  g("init", "-q", "-b", "main");
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(dirname(join(wt, p)), { recursive: true });
    writeFileSync(join(wt, p), t);
  }
  g("add", "-A");
  g("commit", "-q", "-m", "a", "--allow-empty");
  const hs = (targets) => {
    const r = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "hook_surface.py"), wt, "HEAD", JSON.stringify(targets)], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.error, null);
    return o.make_paths;
  };
  return { dir, wt, env, g, hs };
}
const pkg = (scripts) => JSON.stringify({ scripts });

// ---------------------------------------------------------------- B-M1, B-m8, A-m4, B-m2

test("7.4.0 review B-M1: pkg:scripts.<name> is [] only for a JSON-object root package.json with a string scripts.<name>", () => {
  const shapes = {
    workspace: pkg({ test: "npm run -w packages/web test" }),
    cdBuild: pkg({ test: "cd web && npm run build && jest" }),
    plain: pkg({ test: "jest" }),
  };
  for (const [k, text] of Object.entries(shapes)) {
    const r = repo({ "package.json": text });
    try {
      const mp = r.hs(["npm:test", "pkg:scripts.test"]);
      assert.deepEqual(mp["pkg:scripts.test"], [], k);
      // R4: the nested reader stays fail closed where it cannot follow the script
      if (k !== "plain") assert.equal(mp["npm:test"], undefined, k + ": " + JSON.stringify(mp));
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  }
  // (a package.json that is not an object is a hook-surface read error: the plan stops there)
  for (const files of [{}, { "package.json": pkg({ build: "x" }) }, { "package.json": pkg({ test: ["jest"] }) }]) {
    const r = repo(files);
    try {
      assert.equal(r.hs(["pkg:scripts.test"])["pkg:scripts.test"], undefined, JSON.stringify(files));
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  }
});

test("7.4.0 review B-M1: a valued flag (-w X, --workspace X, --prefix X) is never the script name; another package's run has no R4 entry", () => {
  const forms = ["npm run -w packages test", "npm run --workspace packages test", "npm run --workspace=packages test", "npm run --prefix packages test", "pnpm run --filter packages test", "pnpm run -C packages test"];
  for (const f of forms) {
    // the root has a "packages" script: the old reader followed it as the script name
    const r = repo({ "package.json": pkg({ test: f, packages: "node evil.js" }) });
    try {
      const mp = r.hs(["npm:test"]);
      assert.equal(mp["npm:test"], undefined, f + ": " + JSON.stringify(mp));
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  }
  // a no-value flag still lets the name through
  const r = repo({ "package.json": pkg({ test: "npm run --silent lint", lint: "node scripts/lint.js" }), "scripts/lint.js": "" });
  try {
    assert.deepEqual(r.hs(["npm:test"])["npm:test"], ["scripts/lint.js"]);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("7.4.0 review B-m8: yarn test:unit names the script test:unit, not test", () => {
  const r = repo({ "package.json": pkg({ test: "yarn test:unit", "test:unit": "node scripts/unit.js" }), "scripts/unit.js": "" });
  try {
    assert.deepEqual(r.hs(["npm:test"])["npm:test"], ["scripts/unit.js"]);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
  // a missing test:unit is no longer read as the (present) test script
  const m = repo({ "package.json": pkg({ test: "yarn test:unit" }) });
  try {
    assert.equal(m.hs(["npm:test"])["npm:test"], undefined);
  } finally {
    rmSync(m.dir, { recursive: true, force: true });
  }
});

test("7.4.0 review A-m4: yarn never takes the --if-present skip; npm and pnpm keep it", () => {
  for (const [f, skip] of [["yarn run --if-present lint", false], ["yarn run lint --if-present", false], ["npm run --if-present lint", true], ["pnpm run lint --if-present", true]]) {
    const r = repo({ "package.json": pkg({ test: "jest && " + f }) });
    try {
      const v = r.hs(["npm:test"])["npm:test"];
      if (skip) assert.ok(Array.isArray(v), f);
      else assert.equal(v, undefined, f);
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  }
});

test("7.4.0 review B-m2: hook_surface's re.split passes maxsplit by keyword", () => {
  const src = readFileSync(join(SCRIPTS_SRC, "hook_surface.py"), "utf8");
  assert.doesNotMatch(src, /re\.split\([^)]*, 1\)/);
  assert.match(src, /re\.split\(r'&&\|\[;\|\\n\]', t\[m\.start\(\):\], maxsplit=1\)/);
});

// the workflow guard
const hsOut = (mp) => (p) => {
  const i = inputsOf(p);
  return { status: "ok", reason: "read", surface: [], make_paths: mp, error: null, args: [i.worktree, i.rev, JSON.stringify(i.targets)] };
};
function npmPlan(cmd, mp) {
  const s = happy();
  for (const x of ["", ":audit-fix", ":audit-fix-2"]) {
    if (x) s["role:scope-and-plan" + x] = Object.assign({}, s["role:scope-and-plan"]);
    s["role:scope-and-plan" + x] = Object.assign({}, s["role:scope-and-plan" + x], { test_cmd: { command: cmd, paths_placeholder: null, env: {}, tools: [] } });
    s["infra:hook-surface:plan" + x] = hsOut(mp);
  }
  return s;
}

test("7.4.0 review B-M1: the plan guard reads only pkg:scripts.<name>: no npm: entry plans on; no root script still stops", async () => {
  // the two repo shapes: the nested reader gives no npm:test entry, the root script is a string
  const ok = await runOne(npmPlan("npm test", { "pkg:scripts.test": [] }), ARGS);
  assert.equal(ok.result.status, "awaiting_confirmation", ok.result.reason);
  assert.ok(!ok.labels.includes("role:scope-and-plan:audit-fix"), ok.labels.join(", "));
  assert.deepEqual(inputsOf(call(ok, "infra:surfaces:plan").prompt).targets, ["npm:test", "pkg:scripts.test"]);
  // no root package.json (or no string scripts.test): the walk-up stop, even with an npm: entry
  const stop = await runOne(npmPlan("npm test", { "npm:test": [] }), ARGS);
  assert.equal(stop.result.status, "needs_human", stop.result.reason);
  assert.match(stop.result.reason, /npm would walk up into the main checkout/);
});

// ---------------------------------------------------------------- A-m2

test("7.4.0 review A-m2: every git diff-tree in scripts/*.py passes --ignore-submodules=none", () => {
  const bad = [];
  let n = 0;
  for (const f of readdirSync(SCRIPTS_SRC).filter((x) => x.endsWith(".py")))
    for (const l of readFileSync(join(SCRIPTS_SRC, f), "utf8").split("\n"))
      if (/'diff-tree'/.test(l)) {
        n++;
        if (!/'diff-tree', '--ignore-submodules=none'/.test(l)) bad.push(f + ": " + l.trim());
      }
  assert.ok(n >= 7, "diff-tree calls: " + n);
  assert.deepEqual(bad, []);
});

// a repo with a submodule gitlink whose .gitmodules says ignore = all; base on refs/remotes/origin/main
function subRepo(ignoreAtBase) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-740sm-"));
  const env = gitEnv(dir);
  const g = (cwd, ...a) => {
    const r = spawnSync("git", ["-C", cwd, "-c", "commit.gpgsign=false"].concat(a), { encoding: "utf8", env });
    assert.equal(r.status, 0, a.join(" ") + ": " + r.stderr);
    return r.stdout.trim();
  };
  const sub = join(dir, "sub");
  mkdirSync(sub);
  g(sub, "init", "-q");
  g(sub, "commit", "-q", "--allow-empty", "-m", "s1");
  const s1 = g(sub, "rev-parse", "HEAD");
  g(sub, "commit", "-q", "--allow-empty", "-m", "s2");
  const s2 = g(sub, "rev-parse", "HEAD");
  const wt = join(dir, "wt");
  mkdirSync(wt);
  g(wt, "init", "-q", "-b", "main");
  g(wt, "update-index", "--add", "--cacheinfo", "160000," + s1 + ",sub");
  writeFileSync(join(wt, ".gitmodules"), '[submodule "sub"]\n\tpath = sub\n\turl = ../sub\n' + (ignoreAtBase ? "\tignore = all\n" : ""));
  g(wt, "add", ".gitmodules");
  g(wt, "commit", "-q", "-m", "base");
  g(wt, "update-ref", "refs/remotes/origin/main", "HEAD");
  g(wt, "checkout", "-q", "-b", "fleet/x");
  return { dir, wt, env, g, s2 };
}
const scan = (r, sha) => spawnSync("python3", ["-I", join(SCRIPTS_SRC, "fleet_scan.py"), r.wt, "main", sha], { encoding: "utf8", env: r.env });

test("7.4.0 review A-m2: fleet_scan lists a gitlink change in a commit although .gitmodules says ignore = all", () => {
  const r = subRepo(true);
  try {
    r.g(r.wt, "update-index", "--cacheinfo", "160000," + r.s2 + ",sub");
    r.g(r.wt, "commit", "-q", "-m", "bump");
    const p = scan(r, r.g(r.wt, "rev-parse", "HEAD"));
    assert.equal(p.status, 0, p.stderr);
    const o = JSON.parse(p.stdout);
    assert.deepEqual(o.diff, ["sub"]);
    assert.deepEqual(o.commits[0].files, ["sub"]);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("7.4.0 review A-m2: fleet_scan refuses a PR that adds or changes a submodule ignore key; other .gitmodules edits pass", () => {
  for (const [atBase, body, refused] of [
    [false, '[submodule "sub"]\n\tpath = sub\n\turl = ../sub\n\tignore = all\n', true],
    [true, '[submodule "sub"]\n\tpath = sub\n\turl = ../sub\n\tignore = dirty\n', true],
    [false, '[submodule "sub"]\n\tpath = sub\n\turl = ../other\n', false],
  ]) {
    const r = subRepo(atBase);
    try {
      writeFileSync(join(r.wt, ".gitmodules"), body);
      r.g(r.wt, "add", ".gitmodules");
      r.g(r.wt, "commit", "-q", "-m", "gm");
      const p = scan(r, r.g(r.wt, "rev-parse", "HEAD"));
      if (refused) {
        assert.notEqual(p.status, 0, body);
        assert.match(p.stderr, /submodule ignore key/);
      } else assert.equal(p.status, 0, p.stderr);
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------- A-m3

test("7.4.0 review A-m3: config_like is case-blind and covers jest.setup, setupTests, vitest.workspace and __mocks__/", () => {
  const src = readFileSync(join(SCRIPTS_SRC, "format_files.py"), "utf8");
  const a = src.indexOf("CONFIG_NAMES = ");
  const b = src.indexOf("def dir_offenders");
  assert.ok(a > 0 && b > a);
  const probe = ["jest.setup.js", "src/setupTests.ts", "vitest.workspace.ts", "src/__mocks__/fs.js", "__mocks__/x.js", "CONFTEST.py", "Jest.Config.js", "PyProject.toml", "Package.json", "src/app.py", "README.md"];
  const py = src.slice(a, b) + "\nimport json\nprint(json.dumps([config_like(q) for q in " + JSON.stringify(probe) + "]))\n";
  const r = spawnSync("python3", ["-I", "-c", py], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [true, true, true, true, true, true, true, true, true, false, false]);
});
