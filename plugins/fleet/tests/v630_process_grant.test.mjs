// fleet 6.3.0, part C: ADR-1233, the PROCESS grant (ledger 2108).
//
// .fleet-test-db.json may carry an optional `grants` list. "PROCESS" is the
// only accepted value; any other value refuses the declaration in all three
// checks (test_db_decl.py, the workflow, db_up.py). db_up grants PROCESS to the
// role users of the run's own throwaway container only. With no key, the SQL
// and the args are as before, byte for byte.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync as rawSpawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ARGS, happy, run, call, inputsOf, gitEnv, SCRIPTS_SRC } from "./harness.mjs";

const PY3 = rawSpawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
const DECL = { version: 1, engine: "mariadb", major: "11.4", env: "YADGAR_TEST_DSN" };
const BAD = [["SUPER"], ["process"], ["PROCESS", "SUPER"], ["PROCESS", "PROCESS"], ["ALL PRIVILEGES"], "PROCESS", [1], null, {}];

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
  const d = mkdtempSync(join(tmpdir(), "fleet-db-grant-"));
  const bin = join(d, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "podman"), PODMAN_STUB);
  chmodSync(join(bin, "podman"), 0o755);
  const env = { PATH: bin, HOME: d, STUB_LOG: join(d, "log") };
  writeFileSync(env.STUB_LOG, "");
  return { env, log: () => readFileSync(env.STUB_LOG, "utf8").split("\n").filter(Boolean) };
}
const runUp = (args, st) => rawSpawnSync(PY3, ["-I", join(SCRIPTS_SRC, "db_up.py")].concat(args), { encoding: "utf8", env: st.env, timeout: 60000 });
const IMG = "docker.io/library/mariadb@sha256:" + "d".repeat(64);
const DBS = ["fleet_plan", "fleet_audit"];
const UP = (extra) => ["up", "fleet-db-l42-1", IMG, "21600", "n1-0000001", JSON.stringify(DBS)].concat(extra || []);
const ADD = (extra) => ["add", "fleet-db-l42-1", JSON.stringify(DBS)].concat(extra || []);
const sqlLineOf = (st) => {
  const l = st.log().filter((x) => x.includes("CREATE DATABASE"));
  assert.equal(l.length, 1, st.log().join("\n"));
  return l[0];
};
const own = (users, d) => "CREATE DATABASE IF NOT EXISTS " + d + "; CREATE OR REPLACE USER '" + d + "'@'%' IDENTIFIED BY '" + users[d] + "'; GRANT ALL PRIVILEGES ON " + d + ".* TO '" + d + "'@'%';";

test("6.3.0 C (ADR-1233) db_up: grant:PROCESS gives each role user PROCESS ON *.* in this container (exact SQL); with a prefix too", { skip: !PY3 }, () => {
  for (const [mode, args, pre] of [["up", UP(["grant:PROCESS"]), false], ["add", ADD(["grant:PROCESS"]), false], ["up", UP(["iam_db_", "grant:PROCESS"]), true], ["add", ADD(["iam_db_", "grant:PROCESS"]), true]]) {
    const st = stubDir();
    const r = runUp(args, st);
    assert.equal(r.status, 0, mode + ": " + r.stderr);
    const o = JSON.parse(r.stdout);
    assert.deepEqual(o.args, args);
    const want = DBS.map((d) => own(o.users, d) + (pre ? " GRANT ALL PRIVILEGES ON `iam\\_db\\_%`.* TO '" + d + "'@'%';" : "") + " GRANT PROCESS ON *.* TO '" + d + "'@'%';").join(" ");
    assert.ok(sqlLineOf(st).endsWith(" -e " + want), mode + "\n" + sqlLineOf(st) + "\n" + want);
    // the grant goes only through the exec into this run's own container
    assert.ok(st.log().filter((x) => x.includes("GRANT PROCESS")).every((x) => x.startsWith("exec -e MYSQL_PWD=") && x.includes(" fleet-db-l42-1 mariadb ")));
  }
});

test("6.3.0 C db_up: no grant argument: the SQL is as before (no PROCESS); any other grant argument exits 2 and runs no podman", { skip: !PY3 }, () => {
  const st = stubDir();
  const r = runUp(UP(), st);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(sqlLineOf(st).endsWith(" -e " + DBS.map((d) => own(JSON.parse(r.stdout).users, d)).join(" ")));
  assert.ok(!sqlLineOf(st).includes("PROCESS"));
  for (const extra of [["grant:SUPER"], ["grant:process"], ["grant:PROCESS", "grant:PROCESS"], ["grant:ALL"], ["iam_db_", "grant:FILE"], ["iam_db_", "a_"]]) {
    const s2 = stubDir();
    const x = runUp(UP(extra), s2);
    assert.equal(x.status, 2, JSON.stringify(extra) + ": " + x.stderr);
    assert.deepEqual(s2.log(), [], JSON.stringify(extra));
  }
});

test("6.3.0 C test_db_decl: grants [\"PROCESS\"] (or []) is accepted; any other value refuses the declaration; absent is as before", { skip: !PY3 }, () => {
  const d = mkdtempSync(join(tmpdir(), "fleet-decl-grant-"));
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
  assert.deepEqual(declOf(DECL).decl, DECL);
  for (const ok of [["PROCESS"], []]) assert.deepEqual(declOf(Object.assign({}, DECL, { grants: ok })).decl.grants, ok);
  for (const v of BAD) {
    const o = declOf(Object.assign({}, DECL, { grants: v }));
    assert.equal(o.decl, null, JSON.stringify(v));
    assert.match(o.error, /grants/, JSON.stringify(v));
  }
  assert.match(declOf(Object.assign({}, DECL, { grants: ["SUPER"] })).error, /grants may hold only "PROCESS" \(ADR-1233\), not "SUPER"/);
});

function withDecl(s, decl) {
  const td = (prompt) => ({ decl, error: null, args: [inputsOf(prompt).main_worktree, inputsOf(prompt).default_branch] });
  const bs = s["infra:branch-scan"];
  const vp = s["infra:verify-plan"];
  s["infra:branch-scan"] = (prompt) => Object.assign(JSON.parse(JSON.stringify(bs)), { test_db: td(prompt) });
  s["infra:verify-plan"] = (prompt) => Object.assign(JSON.parse(JSON.stringify(vp)), { test_db: td(prompt) });
  return s;
}

test("6.3.0 C workflow: grants [\"PROCESS\"] sends grant:PROCESS to db_up; absent sends nothing new", async () => {
  const out = await run(withDecl(happy(), Object.assign({}, DECL, { grants: ["PROCESS"] })), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const c = call(out.plan, "infra:db-up");
  assert.deepEqual(inputsOf(c.prompt).grants, ["PROCESS"]);
  assert.match(c.prompt, / 'up' 'fleet-db-\S+' '\S+' '21600' '\S+' '\[[^\]]*\]' 'grant:PROCESS'\n/);
  assert.ok(out.logs.some((l) => /each user also has PROCESS, ADR-1233/.test(l)));
  const plain = await run(withDecl(happy(), DECL), ARGS);
  const p = call(plain.plan, "infra:db-up");
  assert.ok(!("grants" in inputsOf(p.prompt)));
  assert.ok(!p.prompt.includes("grant:"));
});

for (const v of BAD)
  test("6.3.0 C workflow: grants " + JSON.stringify(v) + " halts before any role or container", async () => {
    const out = await run(withDecl(happy(), Object.assign({}, DECL, { grants: v })), ARGS);
    assert.equal(out.result.status, "needs_human");
    assert.equal(out.result.stop_gate, "db");
    assert.match(out.result.reason, /\.fleet-test-db\.json.*grants/);
    assert.ok(!out.labels.some((l) => /^role:|db-up/.test(l)), out.labels.join(", "));
  });
