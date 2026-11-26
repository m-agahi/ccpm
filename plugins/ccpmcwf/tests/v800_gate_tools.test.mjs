// fleet 8.0.0 car G1: gate plumbing, the gate tool census and the size guard.
// gate_tools.py <repo> <image> runs as a third program in the preflight agent. It finds the
// repo's languages (marker files), the host coverage tools (which() on a PATH with no entry
// inside the repo) and the security container: the runtime (podman, else docker) and whether
// the pinned audit-lab image is present locally (the runtime's read-only image check, run only
// for an image pinned by digest). Mutation is the built-in mutator. Host scanners are never
// reported (ADR-1315). The census is advisory: an unusable relay marks no gate available and
// never stops the run. The shared helpers gatePrompt/runGate/unruled and state.gates are the
// plumbing the later cars use; gatesNotRun() is derived from state.gates (ADR-1316).
//
// ACs (plan-8.0.0-gates.md, G1):
// - G1-1: the probe lists each gate per language, with a tool or `unsupported`.
// - G1-2: a missing tool is logged at preflight, before intake.
// - G1-3 (non-weakening): with no gate result, gates_not_run holds exactly mutation, coverage,
//   security_scan and held_out, in that order, with today's reasons.
// - G1-4: a malformed or digest-failed census does not stop the run and marks no gate available.
// - G1-5: the source names no IaC binary.
//
// Every program test runs python3 by absolute path with PATH set to a stub-only dir; podman and
// docker are stub scripts there. No real container runtime runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERE, HAVE_PY, SOURCE, ARGS, happy, run, runOne, sha256, canon, spawnSync, programSha, relayDigestOf, K } from "./harness.mjs";

const PROG = join(HERE, "..", "scripts", "gate_tools.py");
const README = readFileSync(join(HERE, "..", "README.md"), "utf8");
const PY = HAVE_PY ? spawnSync("python3", ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim() : null;
const IMG = "openfantasy/audit-lab@sha256:" + "ab".repeat(32);
const AUDIT_IMAGE = (/\nconst AUDIT_IMAGE = "([^"]*)";/.exec(SOURCE) || [])[1];
const PROBE = { mode: "probe", repo: "/r", date: ARGS.date, run_nonce: ARGS.run_nonce };
const FOUR = [
  { gate: "mutation", reason: "fleet v2: mutation/coverage/scan gates are not run yet" },
  { gate: "coverage", reason: "fleet v2: mutation/coverage/scan gates are not run yet" },
  { gate: "security_scan", reason: "fleet v2: mutation/coverage/scan gates are not run yet" },
  // 8.0.0 (G4): the default before a code round's runner result (was "fleet v2: held-out execution is not run yet")
  { gate: "held_out", reason: "runs in the code rounds only" },
];

// gate_tools.py on a temp repo with marker files, PATH = a dir of stub scripts only.
// stubs: {name: exit code}; each stub appends its argv to <dir>/calls.log.
// planted: stubs placed in <repo>/bin, which is put on PATH after the stub dir.
function census({ markers = [], stubs = {}, planted = {}, image = IMG } = {}) {
  const d = mkdtempSync(join(tmpdir(), "fleet-g1-"));
  try {
    const repo = join(d, "repo");
    const bin = join(d, "bin");
    mkdirSync(join(repo, "bin"), { recursive: true });
    mkdirSync(bin);
    for (const m of markers) writeFileSync(join(repo, m), "\n");
    const log = join(d, "calls.log");
    const put = (dir, n, code) => {
      writeFileSync(join(dir, n), "#!/bin/sh\necho \"" + n + " $*\" >> '" + log + "'\nexit " + code + "\n");
      chmodSync(join(dir, n), 0o755);
    };
    for (const [n, c] of Object.entries(stubs)) put(bin, n, c);
    for (const [n, c] of Object.entries(planted)) put(join(repo, "bin"), n, c);
    const r = spawnSync(PY, ["-I", PROG, repo, image], { encoding: "utf8", env: { PATH: bin + ":" + join(repo, "bin") } });
    assert.equal(r.status, 0, r.stderr);
    return { out: JSON.parse(r.stdout), raw: r.stdout, calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [], repo };
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}
// the digest the workflow recomputes (relayDigestOk)
function digestOk(o) {
  const x = { program: o.program };
  for (const k of K("gate_tools")) x[k] = o[k] === undefined ? null : o[k];
  return sha256(canon(x)) === o.digest;
}

// a named function's source from src/ (function name(...) { ... } up to its closing line)
function grabFn(name) {
  const m = new RegExp("\\n(async )?function " + name + "\\(").exec(SOURCE);
  assert.ok(m, "function " + name);
  const i = m.index + 1;
  return SOURCE.slice(i, SOURCE.indexOf("\n}\n", i) + 2);
}
function grabConst(name) {
  const i = SOURCE.indexOf("\nconst " + name + " = ");
  assert.ok(i >= 0, "const " + name);
  return SOURCE.slice(i + 1, SOURCE.indexOf(";\n", i) + 2);
}

test("8.0.0 G1: AUDIT_IMAGE is the audit-lab image pinned by a digest (G7: the real index digest); gates is a stop gate", () => {
  assert.match(AUDIT_IMAGE, /^docker\.io\/openfantasy\/audit-lab@sha256:[0-9a-f]{64}$/);
  const gates = JSON.parse(/const STOP_GATES = (\[[^\]]*\]);/.exec(SOURCE)[1]);
  assert.ok(gates.includes("gates"), "STOP_GATES has gates");
  assert.match(README, /`gates`/);
});

test("8.0.0 G1-1: the census lists each gate per language with a tool, builtin or unsupported", { skip: !HAVE_PY }, () => {
  const { out, calls } = census({ markers: ["pyproject.toml", "package.json"], stubs: { coverage: 0, c8: 0, podman: 0 } });
  assert.deepEqual(out.languages, ["python", "node"]);
  assert.deepEqual(Object.keys(out.matrix), ["python", "node", "go", "rust", "other"]);
  assert.deepEqual(out.matrix.python, { coverage: "coverage", mutation: "builtin", security: "container" });
  // 8.0.0 (G7): the built-in mutator supports python (pytest) only
  assert.deepEqual(out.matrix.node, { coverage: "c8", mutation: "unsupported", security: "container" });
  assert.deepEqual(out.matrix.go, { coverage: "unsupported", mutation: "unsupported", security: "container" });
  assert.deepEqual(out.matrix.rust, { coverage: "unsupported", mutation: "unsupported", security: "container" });
  assert.deepEqual(out.matrix.other, { coverage: "unsupported", mutation: "unsupported", security: "container" });
  assert.deepEqual(out.container, { runtime: "podman", image: IMG, present: true, reason: null });
  assert.deepEqual(calls, ["podman image exists " + IMG], "only the read-only image check ran");
  assert.equal(out.program.sha256, programSha("gate_tools"));
  assert.ok(digestOk(out), "the workflow's digest");
  assert.equal(out.args[1], IMG);
});

test("8.0.0 G1-1: with every tool absent, coverage and security are unsupported and mutation stays builtin (G7: python only)", { skip: !HAVE_PY }, () => {
  const { out, calls } = census({ markers: ["go.mod", "Cargo.toml"] });
  assert.deepEqual(out.languages, ["go", "rust"]);
  for (const l of ["python", "node", "go", "rust"]) assert.deepEqual(out.matrix[l], { coverage: "unsupported", mutation: l === "python" ? "builtin" : "unsupported", security: "unsupported" }, l);
  assert.deepEqual(out.container, { runtime: null, image: IMG, present: false, reason: "no container runtime (podman or docker)" });
  assert.deepEqual(calls, []);
  assert.deepEqual(census().out.languages, ["other"], "no marker file");
});

test("8.0.0 G1: a PENDING (or any unpinned) image is never checked: not available, image digest not pinned", { skip: !HAVE_PY }, () => {
  // 8.0.0 (G7): AUDIT_IMAGE is pinned now; the former placeholder stays an example
  for (const image of ["openfantasy/audit-lab@sha256:PENDING", "openfantasy/audit-lab:latest", "openfantasy/audit-lab@sha256:" + "AB".repeat(32), "x@sha256:abc"]) {
    const { out, calls } = census({ markers: ["package.json"], stubs: { podman: 0, docker: 0 }, image });
    assert.deepEqual(calls, [], image + ": no runtime call");
    assert.deepEqual(out.container, { runtime: "podman", image, present: false, reason: "image digest not pinned" }, image);
    assert.equal(out.matrix.node.security, "unsupported");
  }
});

test("8.0.0 G1: docker only when podman is absent; a missing image is not available with the reason (G7: after one failed pull)", { skip: !HAVE_PY }, () => {
  const { out, calls } = census({ stubs: { docker: 1 } });
  assert.deepEqual(calls, ["docker image inspect " + IMG, "docker pull " + IMG]);
  assert.equal(out.container.runtime, "docker");
  assert.equal(out.container.present, false);
  assert.equal(out.container.reason, "image not present locally (exit 1); pull failed (exit 1)");
  const both = census({ stubs: { docker: 0, podman: 1 } });
  assert.deepEqual(both.calls, ["podman image exists " + IMG, "podman pull " + IMG], "podman first");
  assert.equal(both.out.container.present, false);
});

test("8.0.0 G1: host scanners are never reported or run; a runtime planted inside the repo is not used", { skip: !HAVE_PY }, () => {
  const host = census({ markers: ["pyproject.toml"], stubs: { semgrep: 0, gitleaks: 0 } });
  assert.deepEqual(host.calls, []);
  assert.equal(host.out.matrix.python.security, "unsupported");
  assert.ok(!/semgrep|gitleaks/.test(host.raw), "no host scanner in the output");
  const planted = census({ markers: ["pyproject.toml"], planted: { podman: 0, coverage: 0 } });
  assert.deepEqual(planted.calls, [], "the repo's own podman never runs");
  assert.equal(planted.out.container.runtime, null);
  assert.equal(planted.out.matrix.python.coverage, "unsupported", "a coverage inside the repo is not a host tool");
});

test("8.0.0 G1-5: gate_tools.py names no IaC binary and no host scanner; it runs the image check (G7: and one pull of the pinned image)", () => {
  const src = readFileSync(PROG, "utf8");
  const pathTools = new Function(grabConst("PATH_TOOLS") + "\nreturn PATH_TOOLS;")();
  assert.equal(pathTools.length, 6);
  for (const n of pathTools.concat(["checkov", "tfsec", "trivy", "terrascan", "kics", "tflint", "semgrep", "gitleaks", "bandit", "trufflehog"]))
    assert.ok(!new RegExp("\\b" + n + "\\b", "i").test(src), "gate_tools.py names " + n);
  assert.equal(src.match(/subprocess\.\w+\(/g).length, 1, "one subprocess call");
  assert.ok(!/'(run|exec)'/.test(src), "no run or exec verb");
  assert.deepEqual(src.match(/'pull'.*$/gm), ["'pull', image], 480)"], "one pull, of the pinned image only");
});

// ---------------------------------------------------------------- the workflow

test("8.0.0 G1-1: the preflight prompt runs gate_tools.py on the repo and AUDIT_IMAGE; the probe returns the census", async () => {
  const out = await runOne(happy(), PROBE);
  assert.equal(out.result.status, "ok", out.result.reason);
  const pre = out.calls.find((c) => c.label === "preflight").prompt;
  assert.ok(pre.includes("sha256sum -- <scripts_dir>/gate_tools.py && python3 -I <scripts_dir>/gate_tools.py '/r' '" + AUDIT_IMAGE + "'"), "the census command");
  assert.match(pre, /Return \{ledger_tools, scripts_probe, scripts_dir, path_check, session_project, gate_tools, reason\}\./);
  const g = out.result.probe.gate_tools;
  assert.ok(g, "the probe carries the census");
  assert.deepEqual(Object.keys(g.matrix), ["python", "node", "go", "rust", "other"]);
  for (const [l, row] of Object.entries(g.matrix))
    for (const gate of ["coverage", "mutation", "security"]) assert.ok(row[gate] === "unsupported" || row[gate] === "builtin" || /^[a-z0-9-]+$/.test(row[gate]), l + "." + gate);
  assert.equal(g.container.reason, "no container runtime (podman or docker)");
  assert.equal(out.labels.filter((l) => /preflight/.test(l)).length, 1, "no extra agent");
});

test("8.0.0 G1-2: each missing gate tool is logged at preflight, before intake", async () => {
  const out = await runOne(happy(), ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const end = out.logs.findIndex((l) => /^preflight: all \d+ role files/.test(l));
  const lines = out.logs.map((l, i) => [l, i]).filter(([l]) => /^gate census/.test(l));
  assert.ok(lines.length >= 2, out.logs.join("\n"));
  for (const [l, i] of lines) assert.ok(i < end, "logged in preflight: " + l);
  assert.ok(lines.some(([l]) => /coverage unsupported/.test(l)), "a missing coverage tool is named");
  assert.ok(lines.some(([l]) => /security: not available: no container runtime \(podman or docker\)/.test(l)), "the container reason");
  assert.ok(out.labels.indexOf("preflight") < out.labels.indexOf("intake"));
});

test("8.0.0 G1-3 (non-weakening): with no gate result, gates_not_run is exactly today's four, in today's order", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  // 8.0.0 (G2): the happy run has a coverage gate result (not_run: no coverage tool); the same four, in
  // the same order, coverage with the gate's own reason
  // 8.0.0 (G4): and a held-out runner result (not_run: no store file on this machine, the harness default)
  // 8.0.0 (G5): and a mutation gate result (not_run: the harness default, no mutation run)
  // 8.0.0 (G7): and a security gate result (partial: the harness default, no container runtime)
  const own = { coverage: "no coverage tool: coverage is not on PATH", held_out: "store file missing on this machine", mutation: "tool absent: no mutation run", security_scan: "container scan not run: no container runtime (podman or docker); always-on checks only" };
  assert.deepEqual(out.result.gates_not_run, FOUR.map((x) => (own[x.gate] ? { gate: x.gate, reason: own[x.gate] } : x)));
  // the derived function: no state.gates entry, an earlier round's ran, a partial, the judge list
  const src = [grabConst("HELD_OUT_NOT_RUN"), grabConst("SCRIPT_FINDINGS_NOT_RUN"), grabConst("GATE_DEFAULTS"), grabFn("gatesNotRun")].join("\n");
  const make = (state) => new Function("state", src + "\nreturn gatesNotRun;")(state);
  assert.deepEqual(make({ gates: {}, rounds: { code: 1 } })(undefined), FOUR);
  assert.deepEqual(make({ gates: {}, rounds: { code: 1 } })(null), FOUR);
  const old = { status: "ran", reason: null, round: 1 };
  assert.deepEqual(make({ gates: { coverage: old, mutation: old }, rounds: { code: 2 } })(), FOUR, "a ran result of an earlier round counts for nothing");
  const now = make({ gates: { coverage: { status: "ran", reason: null, round: 2 }, mutation: { status: "partial", reason: "3 of 9 not run", round: 2 }, security_scan: { status: "not_run", reason: "no runtime", round: 2 } }, rounds: { code: 2 } });
  assert.deepEqual(now(), [
    { gate: "mutation", reason: "3 of 9 not run" },
    { gate: "security_scan", reason: "no runtime" },
    FOUR[3],
  ]);
  // the union with the judge's list, as before
  const j = [{ gate: "coverage", reason: "judge" }, "x", null];
  assert.deepEqual(make({ gates: {}, rounds: { code: 1 } })(j), [{ gate: "coverage", reason: "judge" }, FOUR[0], FOUR[2], FOUR[3]]);
});

// the census relay, broken in each way G1-4 names
function brokenCensus(fn) {
  const s = happy();
  // 8.9.11 (#125): and its one retry, broken the same way
  s.__mutate = { label: /^(preflight|infra:gate-tools:preflight:relay-retry)$/, fn: (r) => Object.assign(r, { gate_tools: fn(r.gate_tools) }) };
  return s;
}
const reDigest = (o) => Object.assign(o, { digest: relayDigestOf(o, K("gate_tools")) });
const BROKEN = {
  "a wrong digest": (g) => Object.assign(g, { digest: "0".repeat(64) }),
  "no relay": () => null,
  "a string": () => "census",
  "a malformed matrix under a good digest": (g) => reDigest(Object.assign(g, { matrix: "x" })),
  "languages not a list under a good digest": (g) => reDigest(Object.assign(g, { languages: "node" })),
  "other args (a host image)": (g) => reDigest(Object.assign(g, { args: [g.args[0], "semgrep:latest"] })),
  "another program": (g) => Object.assign(g, { program: { name: "path_check", sha256: programSha("path_check") } }),
};

test("8.0.0 G1-4: a malformed or digest-failed census never stops the run and marks no gate available", async () => {
  const base = await runOne(happy(), ARGS);
  for (const [what, fn] of Object.entries(BROKEN)) {
    const out = await runOne(brokenCensus(fn), ARGS);
    assert.equal(out.result.status, base.result.status, what + ": " + out.result.reason);
    // 8.9.11 (#125): one retry, one extra agent, right after preflight
    const want = base.labels.slice();
    want.splice(want.indexOf("preflight") + 1, 0, "infra:gate-tools:preflight:relay-retry");
    assert.deepEqual(out.labels, want, what + ": one retry, one extra agent");
    assert.ok(out.logs.some((l) => l.startsWith("gate census unusable (no digest-checked gate_tools after one retry): no gate tool available")), what);
    assert.ok(!out.logs.some((l) => /^gate census (python|node|go|rust|other|security):/.test(l)), what + ": no tool claimed");
    const probe = await runOne(brokenCensus(fn), PROBE);
    assert.equal(probe.result.status, "ok", what);
    assert.equal(probe.result.probe.gate_tools, null, what + ": the probe shows no census");
  }
});

test("8.0.0 G1: unruled lists each finding no reasoned ruling covers (ADR-1316)", () => {
  const unruled = new Function(grabFn("unruled") + "\nreturn unruled;")();
  const f = [{ id: "a" }, { id: "b" }, { id: "c" }, { path: "x" }, null];
  const rulings = [{ id: "a", reason: "covered by the e2e suite" }, { id: "b", reason: "  " }, { id: "c" }, "c", null];
  assert.deepEqual(unruled(f, rulings), [{ id: "b" }, { id: "c" }, { path: "x" }, null]);
  assert.deepEqual(unruled(f.slice(0, 1), null), [{ id: "a" }], "no rulings");
  assert.deepEqual(unruled("x", rulings), [], "no findings list");
  assert.deepEqual(unruled([], rulings), []);
});

// runGate with stubbed dispatch: results by label, in order
function gateRig(results) {
  const state = { gates: {}, rounds: { code: 2 } };
  const logs = [];
  const labels = [];
  const prompts = [];
  class Stop extends Error {}
  const env = {
    state,
    INFRA_STEP: "Infra step: ",
    RUN_EXACT: "Run:\n",
    // 8.5.7: prompt fragments built once
    PRINTS_ONE: "It prints one JSON object ",
    RECOMPUTES: " (the script recomputes the digest)",
    // 8.0.0 (G2): the gate prompt names its gates in an Inputs line
    inputsLine: (o) => "Inputs: " + JSON.stringify(o) + "\n",
    DIGEST_RETRY: ":digest-retry",
    INFRA_SCHEMA: {},
    JUDGE_AGENT: "ccpmcwf:judge",
    progCmd: (n, a) => "sha256sum -- /s/" + n + ".py && python3 -I /s/" + n + ".py " + a.join(" "),
    printsKeys: () => "{status, reason, findings, args, program, digest}",
    relayAs: (s) => "relay it whole as " + s,
    progKeys: () => ["status", "reason", "findings", "args"],
    canonical: (v) => JSON.stringify(v),
    relayDigestOk: (x) => !!x && typeof x === "object" && x.digest === "good",
    gate: (m) => logs.push(m),
    halt: (cls, status, msg, g) => {
      throw new Stop(status + "|" + g + "|" + msg);
    },
    dispatch: async (label, prompt) => {
      labels.push(label);
      prompts.push(prompt);
      return results.shift();
    },
  };
  const src = [grabConst("GATE_STATUS"), grabFn("gatePrompt"), grabFn("gateResult"), grabFn("runGate")].join("\n");
  const runGate = new Function(...Object.keys(env), src + "\nreturn runGate;")(...Object.values(env));
  return { runGate, state, logs, labels, prompts };
}
const SLOTS = [["coverage", "cover_diff", ["/w", "b"]], ["security_scan", "sec_scan", ["/w"]]];
const res = (status, args, extra) => Object.assign({ status, reason: status === "ran" ? null : "why", findings: [], args, digest: "good" }, extra || {});

test("8.0.0 G1: runGate stores each digest-checked result for the code round; one retry, then stop gate gates", async () => {
  const ok = { status: "ok", coverage: res("ran", ["/w", "b"], { findings: [{ id: "f1" }] }), security_scan: res("not_run", ["/w"]) };
  const a = gateRig([ok]);
  await a.runGate("infra:gates:r2", SLOTS, "Code");
  assert.deepEqual(a.labels, ["infra:gates:r2"]);
  // 8.0.0 car F (A-H1): + seen (1 ran, 2 with findings, 4 partial with findings)
  assert.deepEqual(a.state.gates.coverage, { status: "ran", reason: null, findings: [{ id: "f1" }], round: 2, seen: 3 });
  assert.deepEqual(a.state.gates.security_scan, { status: "not_run", reason: "why", findings: [], round: 2, seen: 0 });
  assert.ok(a.prompts[0].includes("python3 -I /s/cover_diff.py /w b") && a.prompts[0].includes("python3 -I /s/sec_scan.py /w"));
  // a bad digest, other args or an erroring tool: one retry
  for (const bad of [Object.assign({}, ok.coverage, { digest: "bad" }), Object.assign({}, ok.coverage, { args: ["/x", "b"] }), res("error", ["/w", "b"]), null]) {
    const b = gateRig([Object.assign({}, ok, { coverage: bad }), ok]);
    await b.runGate("infra:gates:r2", SLOTS, "Code");
    assert.deepEqual(b.labels, ["infra:gates:r2", "infra:gates:r2:digest-retry"]);
    assert.equal(b.state.gates.coverage.status, "ran");
    const c = gateRig([Object.assign({}, ok, { coverage: bad }), Object.assign({}, ok, { coverage: bad })]);
    await assert.rejects(c.runGate("infra:gates:r2", SLOTS, "Code"), (e) => /^needs_human\|gates\|infra:gates:r2/.test(e.message) && /coverage/.test(e.message));
    assert.deepEqual(c.state.gates, {}, "nothing stored on a stop");
  }
});
