// fleet 7.4.0 (#11, L2012): the test_db_prefix test gaps.
// - A prefix with a trailing newline ("iam_db_\n") is refused by all three checks (db_up.py,
//   test_db_decl.py, the workflow). Python's re.match would accept it; the checks use fullmatch
//   (and the JS regex has no m flag), so the case pins that choice.
// - The shortest good prefixes "f_" and "fl_" are accepted, and the grant pattern escapes the
//   underscore (`f\_%`), so they never LIKE-match the role databases' fleet_ names.
//
// Tests only: the shipped checks already behave this way (the plan says so too).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync as rawSpawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ARGS, happy, run, inputsOf, gitEnv, SCRIPTS_SRC } from "./harness.mjs";

const PY3 = rawSpawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
const DECL = { version: 1, engine: "mariadb", major: "11.4", env: "YADGAR_TEST_DSN" };
const NL = "iam_db_\n";
const GOOD = ["f_", "fl_"];

const PODMAN_STUB = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$STUB_LOG"',
  'case "$1" in',
  '  run) if [ "$2" = "--help" ]; then printf "      --timeout uint   Maximum length of time\\n"; exit 0; fi; printf "cid\\n"; exit 0;;',
  '  port) printf "127.0.0.1:40001\\n"; exit 0;;',
  '  exec) if [ "$3" = "printenv" ]; then printf "%s\\n" "0123456789abcdef0123456789abcdef"; fi; exit 0;;',
  "  rm) exit 0;;",
  '  container) printf "1\\n"; exit 0;;',
  "esac",
  "exit 0",
].join("\n") + "\n";

function stubDir() {
  const d = mkdtempSync(join(tmpdir(), "fleet-740-db-"));
  const bin = join(d, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "podman"), PODMAN_STUB);
  chmodSync(join(bin, "podman"), 0o755);
  const env = { PATH: bin, HOME: d, STUB_LOG: join(d, "log") };
  writeFileSync(env.STUB_LOG, "");
  return { env, log: () => readFileSync(env.STUB_LOG, "utf8").split("\n").filter(Boolean) };
}
const IMG = "docker.io/library/mariadb@sha256:" + "d".repeat(64);
const DBS = ["fleet_plan", "fleet_audit"];
const UP = (p) => ["up", "fleet-db-y42-1", IMG, "21600", "n1-0000001", JSON.stringify(DBS), p];
const runUp = (args, st) => rawSpawnSync(PY3, ["-I", join(SCRIPTS_SRC, "db_up.py")].concat(args), { encoding: "utf8", env: st.env, timeout: 60000 });

test("7.4.0 #11 T1: db_up refuses test_db_prefix \"iam_db_\\n\" (exit 2, no podman call)", { skip: !PY3 }, () => {
  const st = stubDir();
  const r = runUp(UP(NL), st);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /test_db_prefix/);
  assert.deepEqual(st.log(), []);
});

test("7.4.0 #11 T1: db_up accepts f_ and fl_; the grant pattern escapes the underscore", { skip: !PY3 }, () => {
  for (const v of GOOD) {
    const st = stubDir();
    const r = runUp(UP(v), st);
    assert.equal(r.status, 0, v + ": " + r.stderr);
    const sql = st.log().find((x) => x.includes("CREATE DATABASE"));
    assert.ok(sql.includes("ON `" + v.replace(/_/g, "\\_") + "%`.* TO 'fleet_plan'@'%';"), v + ": " + sql);
  }
  // f_ is exactly `f\_%`
  const st = stubDir();
  runUp(UP("f_"), st);
  assert.ok(st.log().some((x) => x.includes("ON `f\\_%`.*")));
});

test("7.4.0 #11 T1: test_db_decl refuses \"iam_db_\\n\" and accepts f_, fl_", { skip: !PY3 }, () => {
  const d = mkdtempSync(join(tmpdir(), "fleet-740-decl-"));
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
  const bad = declOf(Object.assign({}, DECL, { test_db_prefix: NL }));
  assert.equal(bad.decl, null);
  assert.match(bad.error, /test_db_prefix/);
  for (const v of GOOD) {
    const o = declOf(Object.assign({}, DECL, { test_db_prefix: v }));
    assert.equal(o.error, null, v);
    assert.equal(o.decl.test_db_prefix, v);
  }
});

function withDecl(s, decl) {
  const td = (prompt) => ({ decl, error: null, args: [inputsOf(prompt).main_worktree, inputsOf(prompt).default_branch] });
  const bs = s["infra:branch-scan"];
  const vp = s["infra:verify-plan"];
  s["infra:branch-scan"] = (prompt) => Object.assign(JSON.parse(JSON.stringify(bs)), { test_db: td(prompt) });
  s["infra:verify-plan"] = (prompt) => Object.assign(JSON.parse(JSON.stringify(vp)), { test_db: td(prompt) });
  return s;
}

test("7.4.0 #11 T1: the workflow halts on test_db_prefix \"iam_db_\\n\" before any role", async () => {
  const out = await run(withDecl(happy(), Object.assign({}, DECL, { test_db_prefix: NL })), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "db");
  assert.match(out.result.reason, /test_db_prefix/);
  assert.ok(!out.labels.some((l) => /^role:|db-up/.test(l)), out.labels.join(", "));
});

test("7.4.0 #11 T1: the workflow accepts f_ and fl_ and passes them to db_up", async () => {
  for (const v of GOOD) {
    const out = await run(withDecl(happy(), Object.assign({}, DECL, { test_db_prefix: v })), ARGS);
    assert.equal(out.result.status, "ok", v + ": " + out.result.reason);
    assert.equal(inputsOf(out.plan.calls.find((c) => c.label === "infra:db-up").prompt).test_db_prefix, v);
  }
});
