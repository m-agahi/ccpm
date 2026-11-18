// fleet 7.3.0 review fix (M2): the Write rule in settings.local.json covers only the chunk
// files, <scratch>/chunks/<dir>/<i>.b64 (no nonce in the rule, so its sha stays the same
// across a resume), and the three chunk dirs (plan-ref-*, state-*, park-chunks-*) live under
// <scratch>/chunks/. No Write rule covers ci-*.json, parked/, hashes/ or callers/. The
// workspace step rewrites a settings file with other content (a 7.2.0-era or car-4 worktree).
//
// dont_care: the chunk dir names below chunks/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { happy, run, ARGS, call, inputsOf } from "./harness.mjs";

const ROOT = "/r/.claude/worktrees/fleet-y42-add-thing";
const SCR = ROOT + "/scratch";

// a gitignore-style match of the Claude Code permission rule: * stays inside one path segment
function covers(rule, path) {
  const m = /^Write\(\/(.*)\)$/.exec(rule);
  if (!m) return false;
  const re = new RegExp("^" + m[1].replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*") + "$");
  return re.test(path);
}

test("7.3.0 review M2: the scratch Write rule covers <scratch>/chunks/*/*.b64 only", async () => {
  const out = await run(happy(), ARGS);
  const set = JSON.parse(inputsOf(call(out.plan, "workspace").prompt).settings_local_json);
  const main = ROOT + "/main";
  assert.deepEqual(set.permissions.allow, ["Edit(/" + main + "/**)", "Write(/" + main + "/**)", "Write(/" + SCR + "/chunks/*/*.b64)"]);
  const scratchRules = set.permissions.allow.filter((r) => r.indexOf(SCR) >= 0);
  for (const p of [SCR + "/ci-n1-p1-w1.json", SCR + "/parked/n1/findings.json", SCR + "/parked/used/x", SCR + "/hashes/a", SCR + "/callers/c.json", SCR + "/chunks/x.b64", SCR + "/chunks/a/b/0.b64", SCR + "/plan-ref-n1/0.b64"])
    assert.ok(!scratchRules.some((r) => covers(r, p)), p);
  assert.ok(scratchRules.some((r) => covers(r, SCR + "/chunks/plan-ref-n1-0000001/0.b64")));
});

test("7.3.0 review M2: the plan-ref, park and run-state chunk dirs are under <scratch>/chunks/", async () => {
  const out = await run(happy(), ARGS);
  const dirs = [];
  for (const c of out.plan.calls.concat(out.build.calls)) {
    const i = inputsOf(c.prompt);
    if (i && typeof i.chunk_dir === "string") dirs.push(i.chunk_dir);
    for (const m of c.prompt.matchAll(/write the file (\S+)\/<i>\.b64/g)) dirs.push(m[1]);
  }
  assert.ok(dirs.some((d) => /\/plan-ref-/.test(d)), dirs.join(", "));
  assert.ok(dirs.some((d) => /\/state-/.test(d)), dirs.join(", "));
  for (const d of dirs) assert.match(d, new RegExp("^" + SCR + "/chunks/[^/]+$"), d);
});
