// fleet 4.0.0 whole-branch review fixes: the precommit-ids digest and tier,
// the workspace tier, the unreadable parked prior, the re-frozen resume, the
// short-path writer halt, old refs under build auto, and the test DSN in the
// committed plan.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  spawnSync,
  ARGS,
  PC,
  SOURCE,
  SCRIPTS_SRC,
  happy,
  run,
  runOne,
  call,
  inputsOf,
  noUnscripted,
  redigest,
  relayDigestOf,
  scratchRepo,
  sh,
} from "./harness.mjs";

// confirm auto with a pre-commit check_cmd: the hook ids are read.
function precommitScript(ids) {
  const s = happy();
  Object.assign(s, {
    "hasher:pre-intent": { status: "ok", fingerprint: { head: PC, tree: "P0" } },
    "role:fleet-intent-judge": {
      status: "ok",
      reason: "matches the task",
      verdict: "approve",
      deviations: [],
      coverage: { covered: true, missing: [] },
    },
    "hasher:fp-post:intent": { status: "ok", fingerprint: { head: PC, tree: "P0" } },
    "infra:precommit-ids": { status: "ok", reason: "read", present: true, ids: ids || ["prettier", "check-json"], parser: "yaml", error: null },
  });
  s["role:scope-and-plan"] = Object.assign({}, s["role:scope-and-plan"], { repo_obligations: [{ id: "fmt", kind: "other", instruction: "format", check_cmd: "pre-commit run prettier --all-files" }] });
  s["role:fleet-code-judge:r1"] = Object.assign({}, s["role:fleet-code-judge:r1"], { obligations_check: [{ id: "fmt", met: true, evidence: "ran", check_exit: 0 }] });
  return s;
}
const AUTO = { ...ARGS, confirm: "auto" };
const okish = (o) => o.result && (o.result.status === "ok" || o.result.status === "awaiting_confirmation");

// ---------------------------------------------------------------- fix 2: workspace on sonnet

test("review fix 2: the workspace step runs on sonnet (its default_branch/base_ref feed the diff base)", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  for (const c of out.calls.filter((x) => x.label === "workspace")) assert.equal(c.opts.model, "sonnet");
  assert.ok(out.calls.some((x) => x.label === "workspace"));
});

// ---------------------------------------------------------------- fix 1: precommit-ids digest and tier

test("review fix 1: infra:precommit-ids runs on sonnet", async () => {
  const out = await run(precommitScript(), AUTO);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(call(out, "infra:precommit-ids").opts.model, "sonnet");
});

test("review fix 1: a precommit-ids relay that drops a duplicate hook id after the program printed it stops", async () => {
  // the program saw the hook twice (G2 refuses that); the relay drops one
  const s = precommitScript(["prettier", "prettier"]);
  s.__mutate = { label: "infra:precommit-ids", fn: (r) => Object.assign(r, { ids: ["prettier"] }) };
  const out = await run(s, AUTO);
  assert.ok(!okish(out), "a relay that does not match the digest passed G2: " + out.result.status);
  assert.match(out.result.reason, /precommit-ids.*digest/);
});

test("review fix 1: a precommit-ids relay of another revision stops", async () => {
  const s = precommitScript();
  s.__mutate = { label: "infra:precommit-ids", fn: (r, prompt) => redigest("infra:precommit-ids", Object.assign(r, { args: [r.args ? r.args[0] : "/x", "f".repeat(40)] }), prompt) };
  const out = await run(s, AUTO);
  assert.ok(!okish(out), out.result.status);
  assert.match(out.result.reason, /precommit-ids.*(argument|args)/);
});

test("review fix 1: the precommit-ids prompt asks for the digest and the args", async () => {
  const out = await run(precommitScript(), AUTO);
  const p = call(out, "infra:precommit-ids").prompt;
  assert.match(p, /\{present, ids, parser, error, args, program, digest\}/);
  assert.match(p, /recomputes the digest/);
});

test("review fix 1 (real git): precommit_ids.py prints every key and a digest on every path", () => {
  const wt = scratchRepo("fleet-pci-");
  writeFileSync(join(wt, "a.txt"), "a\n");
  sh(wt, "git", "add", "a.txt");
  sh(wt, "git", "commit", "-q", "-m", "a");
  const absent = sh(wt, "git", "rev-parse", "HEAD").trim();
  writeFileSync(join(wt, ".pre-commit-config.yaml"), "repos:\n  - repo: local\n    hooks:\n      - id: prettier\n      - id: check-json\n");
  sh(wt, "git", "add", ".pre-commit-config.yaml");
  sh(wt, "git", "commit", "-q", "-m", "cfg");
  const good = sh(wt, "git", "rev-parse", "HEAD").trim();
  writeFileSync(join(wt, ".pre-commit-config.yaml"), "repos: [\n");
  sh(wt, "git", "add", ".pre-commit-config.yaml");
  sh(wt, "git", "commit", "-q", "-m", "bad");
  const bad = sh(wt, "git", "rev-parse", "HEAD").trim();
  const keys = ["present", "ids", "parser", "error", "args"];
  const seen = {};
  for (const [name, rev] of [["absent", absent], ["good", good], ["bad", bad]]) {
    const r = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "precommit_ids.py"), wt, rev], { encoding: "utf8" });
    assert.equal(r.status, 0, name + ": " + r.stderr);
    const o = JSON.parse(r.stdout);
    for (const k of keys.concat(["program", "digest"])) assert.ok(k in o, name + " prints " + k);
    assert.deepEqual(o.args, [wt, rev], name);
    assert.equal(o.program.name, "precommit_ids", name);
    assert.equal(o.digest, relayDigestOf(o, keys), name + ": the digest covers every key and the program");
    seen[name] = o;
  }
  assert.equal(seen.absent.present, false);
  assert.equal(seen.absent.error, null);
  assert.ok(seen.good.parser === "yaml" ? seen.good.error === null : typeof seen.good.error === "string");
  if (seen.good.parser === "yaml") assert.deepEqual(seen.good.ids, ["prettier", "check-json"]);
  assert.equal(typeof seen.bad.error, "string");
});

test("review fix 1: precommit_ids routes every print through one emit with the digest", () => {
  const m = /\/\/ PRECOMMIT_IDS_PY_BEGIN\n([\s\S]*?)\n\/\/ PRECOMMIT_IDS_PY_END/.exec(SOURCE);
  assert.ok(m);
  const prints = m[1].split("\n").filter((l) => /\bprint\(/.test(l));
  assert.equal(prints.length, 1, prints.join("\n"));
});
