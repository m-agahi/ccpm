// fleet 5.0.1 (ledger 2003): a faithful PATH check relay passes; the real
// program's output runs through the real acceptance code.
//
// Run wf_6b4383d3-b45 (plan mode, 5.0.0) stopped at preflight with "the PATH
// check could not complete: preflight returned no usable path_check". The
// relay was the program's output, plus file_sha256 twice: next to `program`
// (as asked) and inside `program`. relayDigestOk hashed the relayed `program`
// with the extra key, so the digest the program printed did not match.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERE, happy, runOne, ARGS, inputsOf, programSha, sha256, canon, spawnSync, planRefFor, buildArgs } from "./harness.mjs";

const PATH_CHECK = join(HERE, "..", "scripts", "path_check.py");
const NOT_SHIMMED = /terraform tooling on PATH is not shimmed/;
const TOOLS = ["terra" + "form", "to" + "fu", "t" + "fp", "terra" + "grunt", "dig" + "ger", "atlan" + "tis"];
const PROBE = { mode: "probe", repo: "/r", date: ARGS.date };

// the absolute python3: the program runs with a PATH of the test's choice
const PY = spawnSync("python3", ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim();

// path_check.py reads PATH entries and the head of each file it finds; it
// runs none of them. `pathEnv` is the PATH the program sees.
function realPathCheck(args, pathEnv) {
  const r = spawnSync(PY, ["-I", PATH_CHECK].concat(args), { encoding: "utf8", env: { PATH: pathEnv } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

// the relay as the preflight prompt asks: file_sha256 next to program
const sibling = (o) => Object.assign({}, o, { file_sha256: programSha("path_check") });
// the relay of run wf_6b4383d3-b45: file_sha256 also inside program
const journal = (o) => Object.assign(sibling(o), { program: Object.assign({}, o.program, { file_sha256: programSha("path_check") }) });

// Every PATH check of the run (preflight and each re-check) returns the real
// program's output for the args its prompt gives, relayed by `relay`.
function realScenario(pathEnv, relay) {
  const s = happy();
  s.__mutate = {
    label: /^(preflight|infra:path-check:.*)$/,
    fn: (r, prompt) => {
      const i = inputsOf(prompt);
      if (/^preflight\b/.test(prompt) || "scripts_probe" in r) {
        r.path_check = relay(realPathCheck([i.repo], pathEnv));
        return r;
      }
      return Object.assign({ status: "ok", reason: "checked" }, relay(realPathCheck([i.repo, i.token], pathEnv)));
    },
  };
  return s;
}

function scratch() {
  return mkdtempSync(join(tmpdir(), "fleet-501-"));
}

test("5.0.1: the real path_check output, relayed with file_sha256 next to program or also inside it, passes in plan and probe mode", async () => {
  const empty = scratch();
  try {
    const raw = realPathCheck(["/r"], empty);
    assert.deepEqual(Object.keys(raw.program).sort(), ["name", "sha256"], "the program prints {name, sha256}");
    assert.equal(raw.program.sha256, programSha("path_check"));
    for (const [what, relay] of [["sibling", sibling], ["journal", journal]]) {
      const plan = await runOne(realScenario(empty, relay), ARGS);
      assert.equal(plan.result.status, "awaiting_confirmation", what + ": " + plan.result.reason);
      assert.ok(plan.labels.some((l) => /^infra:path-check:/.test(l)), what + ": the re-checks ran the real program too");
      const probe = await runOne(realScenario(empty, relay), PROBE);
      assert.equal(probe.result.status, "ok", what + ": " + probe.result.reason);
    }
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("5.0.1: the journal-shaped relay with shims (path, real, shim) passes; the digest is the program's", async () => {
  // a shim lives in /nix/store, which a test cannot write: the program's own
  // digest over the journal's tools, computed as path_check.py does
  const pc = { tools: Object.fromEntries(TOOLS.map((t) => [t, { path: "/nix/store/x-claude-agent-shims/bin/" + t, real: "/nix/store/x-claude-agent-shims/bin/" + t, shim: true }])), args: ["/r"], path_problems: [], program: { name: "path_check", sha256: programSha("path_check") } };
  pc.digest = sha256(canon(pc));
  for (const mode of [ARGS, PROBE]) {
    const s = happy();
    s.preflight = Object.assign({}, s.preflight, { path_check: journal(pc), __raw_path_check: true });
    const out = await runOne(s, mode);
    assert.equal(out.result.status, mode.mode === "plan" ? "awaiting_confirmation" : "ok", mode.mode + ": " + out.result.reason);
  }
});

test("5.0.1: the real program still stops a run for a non-shim tool and a relative PATH entry", async () => {
  const dir = scratch();
  try {
    // a plain file named like the tool: the program reads its head, never runs it
    writeFileSync(join(dir, TOOLS[0]), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, TOOLS[0]), 0o755);
    for (const relay of [sibling, journal]) {
      const out = await runOne(realScenario(dir, relay), ARGS);
      assert.equal(out.result.status, "needs_human");
      assert.match(out.result.reason, NOT_SHIMMED);
      assert.ok(out.result.reason.includes(TOOLS[0] + " at " + join(dir, TOOLS[0])), out.result.reason);
      assert.deepEqual(out.labels, ["preflight"]);
    }
    const rel = await runOne(realScenario(dir + ":rel", sibling), PROBE);
    assert.equal(rel.result.status, "needs_human");
    assert.match(rel.result.reason, /relative PATH entry/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("5.0.1: a relay that is not the program's output still refuses, with what failed", async () => {
  const empty = scratch();
  try {
    const raw = () => realPathCheck(["/r"], empty);
    const F = programSha("path_check");
    for (const [what, pc, re] of [
      ["a tampered tool", Object.assign(sibling(raw()), { tools: Object.assign(raw().tools, { [TOOLS[1]]: { path: "/x", real: "/x", shim: true } }) }), /digest/],
      ["a missing tool", (() => { const o = sibling(raw()); delete o.tools[TOOLS[5]]; return o; })(), /tools/],
      ["other args", sibling(realPathCheck(["/other"], empty)), /args/],
      ["a program.file_sha256 that differs from the sibling", Object.assign(sibling(raw()), { program: { name: "path_check", sha256: F, file_sha256: "0".repeat(64) } }), /digest/],
      ["another key inside program", Object.assign(sibling(raw()), { program: { name: "path_check", sha256: F, extra: "x" } }), /digest/],
      ["program.file_sha256 with no sibling", (() => { const o = journal(raw()); delete o.file_sha256; return o; })(), /sha256sum line/],
      ["a digest of another output", Object.assign(sibling(raw()), { digest: "1".repeat(64) }), /digest/],
    ]) {
      for (const mode of [ARGS, PROBE]) {
        const s = happy();
        s.preflight = Object.assign({}, s.preflight, { path_check: pc, __raw_path_check: true });
        const out = await runOne(s, mode);
        assert.equal(out.result.status, "needs_human", what);
        assert.match(out.result.reason, NOT_SHIMMED, what);
        assert.match(out.result.reason, /could not complete/, what);
        assert.match(out.result.reason, re, what + ": " + out.result.reason);
      }
    }
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

// the same defect class at the other digest checks that include `program`
const inProgram = (o) => (o.program = Object.assign({}, o.program, { file_sha256: o.file_sha256 }), o);

test("5.0.1: file_sha256 copied into program is read as the printed program at the remote URL check and the hasher", async () => {
  const ws = happy();
  ws.__mutate = { label: "workspace", fn: (r) => (r.remote_url_check && inProgram(r.remote_url_check), r) };
  const a = await runOne(ws, ARGS);
  assert.equal(a.result.status, "awaiting_confirmation", "workspace: " + a.result.reason);
  assert.ok(!a.logs.some((l) => /origin URL relay unusable/.test(l)), "the origin URL relay is usable");
  const wsBad = happy();
  wsBad.__mutate = { label: "workspace", fn: (r) => ((r.remote_url_check.program = Object.assign({}, r.remote_url_check.program, { file_sha256: "0".repeat(64) })), r) };
  const a2 = await runOne(wsBad, ARGS);
  assert.ok(a2.logs.some((l) => /origin URL relay unusable/.test(l)), "a program.file_sha256 that is not the sibling's is refused");
  // the hashers run in build mode
  const h = happy();
  const ref = await planRefFor(h);
  h.__mutate = { label: /^hasher:/, fn: (r) => inProgram(r) };
  const b = await runOne(h, buildArgs(ref));
  assert.equal(b.result.status, "ok", "hasher: " + b.result.reason);
  // a value that is not the sibling's is refused there too
  h.__mutate = { label: /^hasher:/, fn: (r) => ((r.program = Object.assign({}, r.program, { file_sha256: "0".repeat(64) })), r) };
  const c = await runOne(h, buildArgs(ref));
  assert.equal(c.result.status, "failed");
  assert.match(c.result.reason, /digest/);
});

test("5.0.1: file_sha256 copied into program passes the changed-definitions digest in build mode", async () => {
  const s = happy();
  const ref = await planRefFor(s);
  s.__mutate = { label: /^infra:changed-defs:/, fn: (r) => inProgram(r) };
  const out = await runOne(s, buildArgs(ref));
  assert.ok(out.labels.some((l) => /^infra:changed-defs:/.test(l)), "the build ran the changed-definitions step");
  assert.equal(out.result.status, "ok", out.result.reason);
});

test("5.0.1: the file_sha256 rule says it is a sibling of program, never inside it", async () => {
  const out = await runOne(happy(), ARGS);
  const p = out.calls.find((c) => c.label === "preflight").prompt;
  assert.match(p, /never a key inside `program`/);
});
