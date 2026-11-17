// fleet 7.4.0 car 3 (#23, L2035): session_project follow-ups.
// - S1: when the digest-checked session_project ran in the repo itself or in a fleet worktree
//   under it, the gate log warns (a cd there is ignored); the run goes on.
// - S2: the no-proof texts name the next step. With args.project and no proof, intake's stop
//   says to start the session in a directory under the repo. With no args.project and no
//   session project, the write-back reason also says to pass args.project. (The AC's
//   "no args.project" stop cannot occur in intake: yaadgaarScope runs only with args.project;
//   the write-back reason is where that case lands.)
// - S3: session_project.py's header lists where it differs from the yaadgaar client's derive.
//
// dont_care: the warning's wording after "WARN session_project ran in <cwd>".

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARGS, BRIEF, SCRIPTS_SRC, happy, run, runOne } from "./harness.mjs";

const sj = (cwd) => ({ project: "o/r", source: "origin", cwd, args: [] });
const warned = (out) => out.logs.filter((l) => /WARN session_project ran in/.test(l));

test("7.4.0 #23 S1: session_project run in the repo or a fleet worktree warns; the run goes on", async () => {
  for (const cwd of ["/r", "/r/.claude/worktrees/fleet-y42-add-thing/main"]) {
    const s = happy({ script: { preflight: { session_project: sj(cwd) } } });
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "ok", cwd + ": " + out.result.reason);
    const w = warned(out);
    assert.ok(w.length >= 1, cwd + ": " + out.logs.slice(0, 20).join("\n"));
    assert.ok(w[0].includes("WARN session_project ran in " + cwd), w[0]);
  }
});

test("7.4.0 #23 S1: no warning for a directory beside the repo or under it but not a fleet worktree", async () => {
  for (const cwd of ["/r2", "/r/sub", "/home/u/git/docs"]) {
    const s = happy({ script: { preflight: { session_project: sj(cwd) } } });
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "awaiting_confirmation", cwd + ": " + out.result.reason);
    assert.deepEqual(warned(out), [], cwd);
  }
});

test("7.4.0 #23 S2: no proof with args.project: the intake stop says where to start the session", async () => {
  const s = happy({ brief: { ...BRIEF, sources: [Object.assign({}, BRIEF.sources[0], { project: "" })] } });
  s.__session_project = null;
  const out = await runOne(s, { ...ARGS, project: "o/r" });
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /no proof of the session's yaadgaar project/);
  assert.match(out.result.reason, /start the session in a directory under the repo \(a \.yadgar\/project-id or an origin remote\)/);
});

test("7.4.0 #23 S2: no args.project and no session project: the write-back reason says pass args.project", async () => {
  const s = happy();
  s.__session_project = null;
  const out = await run(s, { ...ARGS, project: undefined });
  assert.equal(out.result.status, "ok", out.result.reason);
  const e = out.result.write_back.ledger[0];
  assert.equal(e.status, "failed");
  assert.match(e.reason, /no <owner>\/<repo> project to write to \(args\.project null, session project null\)/);
  assert.match(e.reason, /pass args\.project, or start the session in a directory under the repo/);
});

test("7.4.0 #23 S3: session_project.py's header names where its derive differs from the yaadgaar client's", () => {
  const src = readFileSync(join(SCRIPTS_SRC, "session_project.py"), "utf8");
  const head = src.slice(src.indexOf("# fleet 5.0.9"), src.indexOf("import hashlib, json, os, subprocess, sys"));
  assert.match(head, /differs from the client/);
  assert.match(head, /64 passes/);
  assert.match(head, /16/);
  assert.match(head, /4096 bytes/);
});
