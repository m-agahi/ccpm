// fleet 5.0.3 (ledger 2011): an optional test_db_prefix in .fleet-test-db.json.
//
// yadgarhq/iam-db's tests run DROP DATABASE IF EXISTS iam_db_<x> and CREATE
// DATABASE iam_db_<x>. db_up grants each role user its own fleet_* database
// only, so those statements fail with ERROR 1044. With the key set, db_up adds
// one grant per role user on the LIKE pattern `<prefix, each _ escaped>%`.*,
// in the same throwaway container (127.0.0.1, one per run). Without the key
// the SQL is the 5.0.2 SQL, byte for byte. A bad value refuses the whole
// declaration in all three checks: test_db_decl.py, the workflow and db_up.py.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync as rawSpawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ARGS, PC, happy, run, runOne, call, inputsOf, noUnscripted, gitEnv, SCRIPTS_SRC, SOURCE } from "./harness.mjs";

const PY3 = rawSpawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
const DECL = { version: 1, engine: "mariadb", major: "11.4", env: "YADGAR_TEST_DSN" };
const PDECL = Object.assign({}, DECL, { test_db_prefix: "iam_db_" });

// every value the three checks must refuse
const BAD = [
  ["uppercase", "Iam_db_"],
  ["no trailing _", "iam_db"],
  ["the role dbs' fleet_", "fleet_"],
  ["fleet_x_", "fleet_x_"],
  ["m_ (LIKE-matches mysql)", "m_"],
  ["my_ (LIKE-matches mysql)", "my_"],
  ["s_ (LIKE-matches sys)", "s_"],
  ["sys_ (starts with a system schema)", "sys_"],
  ["mysql_", "mysql_"],
  ["information_", "information_"],
  ["performance_", "performance_"],
  ["p_ (LIKE-matches performance_schema)", "p_"],
  ["a %", "iam%_"],
  ["a backtick", "iam`_"],
  ["a backslash", "iam\\_"],
  ["a quote", "iam'_"],
  ["a space", "iam _"],
  ["too long (33)", "a" + "b".repeat(31) + "_"],
  ["empty", ""],
  ["only _", "_"],
  ["a number", 7],
  ["true", true],
  ["null", null],
  ["a list", ["iam_db_"]],
];
const GOOD = ["iam_db_", "a_", "a" + "b".repeat(30) + "_", "task_db_"];

// ---------------------------------------------------------------- db_up.py, against a podman stub

// exec printenv returns a root password, so the add mode runs too
const PODMAN_STUB = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$STUB_LOG"',
  'case "$1" in',
  '  run) if [ "$2" = "--help" ]; then printf "      --timeout uint   Maximum length of time\\n"; exit 0; fi; printf "cid\\n"; exit 0;;',
  '  port) printf "127.0.0.1:40001\\n"; exit 0;;',
  '  exec) if [ "$3" = "printenv" ]; then printf "%s\\n" "0123456789abcdef0123456789abcdef"; fi; exit 0;;',
  '  rm) exit 0;;',
  '  container) printf "1\\n"; exit 0;;',
  "esac",
  "exit 0",
].join("\n") + "\n";

function stubDir() {
  const d = mkdtempSync(join(tmpdir(), "fleet-db-prefix-"));
  const bin = join(d, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "podman"), PODMAN_STUB);
  chmodSync(join(bin, "podman"), 0o755);
  const env = { PATH: bin, HOME: d, STUB_LOG: join(d, "log") };
  writeFileSync(env.STUB_LOG, "");
  return { env, log: () => readFileSync(env.STUB_LOG, "utf8").split("\n").filter(Boolean) };
}
function runUp(args, st) {
  return rawSpawnSync(PY3, ["-I", join(SCRIPTS_SRC, "db_up.py")].concat(args), { encoding: "utf8", env: st.env, timeout: 60000 });
}
const IMG = "docker.io/library/mariadb@sha256:" + "d".repeat(64);
const DBS = ["fleet_plan", "fleet_audit"];
const UP = (extra) => ["up", "fleet-db-l42-1", IMG, "21600", "n1-0000001", JSON.stringify(DBS)].concat(extra || []);
const ADD = (extra) => ["add", "fleet-db-l42-1", JSON.stringify(DBS)].concat(extra || []);

// the 5.0.2 statement, rebuilt from the printed users
function sql502(users) {
  return DBS.map((d) => "CREATE DATABASE IF NOT EXISTS " + d + "; CREATE OR REPLACE USER '" + d + "'@'%' IDENTIFIED BY '" + users[d] + "'; GRANT ALL PRIVILEGES ON " + d + ".* TO '" + d + "'@'%';").join(" ");
}
// with test_db_prefix iam_db_: the extra grant follows the own-db grant
function sqlIam(users) {
  return DBS.map(
    (d) =>
      "CREATE DATABASE IF NOT EXISTS " + d + "; CREATE OR REPLACE USER '" + d + "'@'%' IDENTIFIED BY '" + users[d] + "'; GRANT ALL PRIVILEGES ON " + d + ".* TO '" + d + "'@'%'; GRANT ALL PRIVILEGES ON `iam\\_db\\_%`.* TO '" + d + "'@'%';"
  ).join(" ");
}
const sqlLineOf = (st) => {
  const l = st.log().filter((x) => x.includes("CREATE DATABASE"));
  assert.equal(l.length, 1, st.log().join("\n"));
  return l[0];
};

test("2011 db_up: with test_db_prefix iam_db_ each role user also gets ALL on `iam\\_db\\_%`.* (exact SQL)", { skip: !PY3 }, () => {
  for (const [mode, args] of [["up", UP(["iam_db_"])], ["add", ADD(["iam_db_"])]]) {
    const st = stubDir();
    const r = runUp(args, st);
    assert.equal(r.status, 0, mode + ": " + r.stderr);
    const o = JSON.parse(r.stdout);
    assert.deepEqual(o.args, args, mode);
    const want = sqlIam(o.users);
    // the literal backslash reaches the server: `iam\_db\_%`
    assert.ok(want.includes("ON `iam\\_db\\_%`.* TO 'fleet_plan'@'%';"));
    assert.ok(sqlLineOf(st).endsWith(" -e " + want), mode + "\n" + sqlLineOf(st) + "\n" + want);
  }
});

test("2011 db_up: without test_db_prefix the SQL and the args are the 5.0.2 ones, byte for byte", { skip: !PY3 }, () => {
  for (const [mode, args] of [["up", UP()], ["add", ADD()]]) {
    const st = stubDir();
    const r = runUp(args, st);
    assert.equal(r.status, 0, mode + ": " + r.stderr);
    const o = JSON.parse(r.stdout);
    assert.deepEqual(o.args, args);
    assert.ok(sqlLineOf(st).endsWith(" -e " + sql502(o.users)), mode + "\n" + sqlLineOf(st));
    assert.ok(!sqlLineOf(st).includes("`"), "no pattern grant");
    assert.deepEqual(Object.keys(o).sort(), ["args", "dbs", "digest", "expiry", "name", "port", "program", "users"]);
  }
});

test("2011 db_up: a bad test_db_prefix exits 2 and runs no podman", { skip: !PY3 }, () => {
  for (const [name, v] of BAD) {
    if (typeof v !== "string") continue;
    for (const args of [UP([v]), ADD([v])]) {
      const st = stubDir();
      const r = runUp(args, st);
      assert.equal(r.status, 2, name + ": " + r.stderr);
      assert.match(r.stderr, /test_db_prefix/, name);
      assert.deepEqual(st.log(), [], name);
    }
  }
  // one argument too many is still a usage error
  const st = stubDir();
  assert.equal(runUp(UP(["iam_db_", "x"]), st).status, 2);
  assert.deepEqual(st.log(), []);
});

// ---------------------------------------------------------------- test_db_decl.py, in a real repo

test("2011 test_db_decl: test_db_prefix is the one optional key; a bad value refuses the declaration", { skip: !PY3 }, () => {
  const d = mkdtempSync(join(tmpdir(), "fleet-decl-prefix-"));
  const env = gitEnv(d, join(d, "gitconfig"));
  writeFileSync(join(d, "gitconfig"), "[user]\n\tname = t\n\temail = t@example.com\n[commit]\n\tgpgsign = false\n");
  const up = join(d, "up");
  const wt = join(d, "wt");
  const g = (cwd, ...a) => {
    const r = rawSpawnSync("git", a, { cwd, env, encoding: "utf8" });
    assert.equal(r.status, 0, a.join(" ") + ": " + r.stderr);
  };
  mkdirSync(up);
  g(up, "init", "-q", "-b", "master");
  g(d, "clone", "-q", up, wt);
  let n = 0;
  const declOf = (obj) => {
    writeFileSync(join(up, ".fleet-test-db.json"), JSON.stringify(obj));
    g(up, "add", ".fleet-test-db.json");
    g(up, "commit", "-q", "--allow-empty", "-m", "d" + n++);
    g(wt, "fetch", "-q", "origin");
    const r = rawSpawnSync(PY3, ["-I", join(SCRIPTS_SRC, "test_db_decl.py"), wt, "master"], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  // without the key: as before
  assert.deepEqual(declOf(DECL).decl, DECL);
  for (const v of GOOD) {
    const o = declOf(Object.assign({}, DECL, { test_db_prefix: v }));
    assert.equal(o.error, null, v);
    assert.equal(o.decl.test_db_prefix, v);
  }
  for (const [name, v] of BAD) {
    const o = declOf(Object.assign({}, DECL, { test_db_prefix: v }));
    assert.equal(o.decl, null, name);
    assert.match(o.error, /test_db_prefix/, name);
  }
  // any other extra key is still refused
  const x = declOf(Object.assign({}, PDECL, { host: "db.example" }));
  assert.equal(x.decl, null);
  assert.match(x.error, /keys must be/);
});

// ---------------------------------------------------------------- the workflow

function withDecl(s, decl) {
  const td = (prompt) => ({ decl, error: null, args: [inputsOf(prompt).main_worktree, inputsOf(prompt).default_branch] });
  const bs = s["infra:branch-scan"];
  const vp = s["infra:verify-plan"];
  s["infra:branch-scan"] = (prompt) => Object.assign(JSON.parse(JSON.stringify(bs)), { test_db: td(prompt) });
  s["infra:verify-plan"] = (prompt) => Object.assign(JSON.parse(JSON.stringify(vp)), { test_db: td(prompt) });
  return s;
}
const AUTO = {
  "hasher:pre-intent": { status: "ok", fingerprint: { head: PC, tree: "P0" } },
  "role:fleet-intent-judge": {
    status: "ok",
    reason: "matches the task",
    verdict: "approve",
    deviations: [],
    coverage: { covered: true, missing: [] },
    classification: { change_kind: "approve", new_behaviour: "approve", quote: "the task" },
  },
  "hasher:fp-post:intent": { status: "ok", fingerprint: { head: PC, tree: "P0" } },
};

test("2011 workflow: a declared test_db_prefix goes to db_up in the up and the add step, and to the roles' note", async () => {
  const s = withDecl(happy(), PDECL);
  Object.assign(s, JSON.parse(JSON.stringify(AUTO)));
  const out = await runOne(s, Object.assign({}, ARGS, { confirm: "auto" }));
  assert.equal(out.result.status, "ok", out.result.reason);
  for (const l of ["infra:db-up", "infra:db-up:add"]) {
    const c = call(out, l);
    assert.equal(inputsOf(c.prompt).test_db_prefix, "iam_db_", l);
  }
  assert.match(call(out, "infra:db-up").prompt, / 'up' 'fleet-db-\S+' '\S+' '21600' '\S+' '\[[^\]]*\]' 'iam_db_'\n/);
  assert.match(call(out, "infra:db-up:add").prompt, / 'add' 'fleet-db-\S+' '\[[^\]]*\]' 'iam_db_'\n/);
  assert.match(inputsOf(call(out, "role:fleet-coder:r1").prompt).test_env_note, /iam_db_/);
});

test("2011 workflow: without test_db_prefix the db_up commands and inputs are as before", async () => {
  const out = await run(withDecl(happy(), DECL), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  const c = call(out.plan, "infra:db-up");
  assert.ok(!("test_db_prefix" in inputsOf(c.prompt)));
  assert.match(c.prompt, / 'up' 'fleet-db-\S+' '\S+' '21600' '\S+' '\[[^\]]*\]'\n/);
  assert.ok(!/test_db_prefix|iam_db_/.test(inputsOf(call(out.build, "role:fleet-coder:r1").prompt).test_env_note));
});

for (const [name, v] of BAD) {
  test("2011 workflow: test_db_prefix " + name + " halts before any role", async () => {
    const out = await run(withDecl(happy(), Object.assign({}, DECL, { test_db_prefix: v })), ARGS);
    assert.equal(out.result.status, "needs_human");
    assert.equal(out.result.stop_gate, "db");
    assert.match(out.result.reason, /\.fleet-test-db\.json.*test_db_prefix/);
    assert.ok(!out.labels.some((l) => /^role:|db-up/.test(l)), out.labels.join(", "));
  });
}

test("2011 workflow: a test_db_prefix that changes during the run halts", async () => {
  const s = withDecl(happy(), PDECL);
  Object.assign(s, JSON.parse(JSON.stringify(AUTO)));
  const vp = s["infra:verify-plan"];
  s["infra:verify-plan"] = (prompt) => {
    const r = vp(prompt);
    r.test_db.decl = Object.assign({}, PDECL, { test_db_prefix: "task_db_" });
    return r;
  };
  const out = await runOne(s, Object.assign({}, ARGS, { confirm: "auto" }));
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "db");
  assert.match(out.result.reason, /changed during the run/);
});

test("2011 workflow: the JS check and the programs name the same system schemas", () => {
  for (const s of ["mysql", "sys", "information_schema", "performance_schema"]) {
    assert.ok(SOURCE.includes('"' + s + '"'), s);
    for (const p of ["db_up.py", "test_db_decl.py"]) assert.ok(readFileSync(join(SCRIPTS_SRC, p), "utf8").includes("'" + s + "'"), p + " " + s);
  }
});
