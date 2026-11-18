// fleet 8.0.0 car F: the fixes of reviews A and B (r8-review-findings.md).
// - A-H1: a gate's result of an earlier round of this build is never lost: a not_run after an
//   earlier ran (or after findings), or a partial after an earlier ran with findings, stops at
//   gate gates; the mark survives a resume (gates_seen in the run state).
// - G2 ruling: a red baseline in the copy reruns the suite at the plan base; base green and tree
//   red stops at gates (a reason that starts "tree red").

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { HERE, SOURCE, ARGS, spawnSync, ROLE_TEXT, PB, PSHA, happy, run, runOne, inputsOf, call, commitStub, FP_K2, HASHES, mutOut, secOut, coverOut, stateJsonOf } from "./harness.mjs";

const SCRIPTS = join(HERE, "..", "scripts");
const SKILL = join(HERE, "..", "skills", "build-task");

const approve = (over) => Object.assign({ status: "ok", reason: "good", verdict: "approve", routed_findings: [], hash_check: { match: true, mismatched: [] }, suite_result: { command: "pytest", exit_code: 0 } }, over);
const fixCode = approve({ verdict: "fix_code", routed_findings: [{ target: "code", criterion: null, finding: "tidy" }] });
const R2 = {
  "role:fleet-coder:r2": { status: "ok", changed_paths: ["src/x.py"] },
  "hasher:post-coder:r2": { status: "ok", fingerprint: FP_K2, hashes: HASHES },
  "role:fleet-code-judge:r2": approve(),
  "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: FP_K2 },
};
// a gates stub: each slot the harness default, with the given overrides
const gs = (cov, mut, sec) => (p) => ({ status: "ok", reason: "ran", coverage: coverOut(p, cov), mutation: mutOut(p, mut), security_scan: secOut(p, sec) });
const UNCOV = { status: "ran", reason: "2 uncovered added line(s) in 1 file(s)", findings: [{ path: "src/x.py", lines: [3, 4] }] };
const CLEAN = { status: "ran", reason: null, findings: [] };
const SURV = { status: "ran", reason: "0 killed, 1 survived of 1 mutant(s)", survived: [{ id: "m1", path: "src/x.py", line: 3, op: "flip: == -> !=" }] };
const MCLEAN = { status: "ran", reason: "1 killed, 0 survived of 1 mutant(s)", killed: 1 };
const NR = { status: "not_run", reason: "baseline red in scratch copy at the tree and at the base (exit 1, 1): the environment" };

async function rounds(r1, r2, j1) {
  return run(happy({ script: Object.assign({ "infra:gates:r1": r1, "infra:gates:r2": r2, "role:fleet-code-judge:r1": j1 || approve() }, R2) }), ARGS);
}
const stopsAtGates = (out, re) => {
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "gates");
  assert.match(out.result.reason, re);
  assert.ok(!out.labels.includes("role:fleet-code-judge:r2"), "no judge after the stop");
};

test("8.0.0 car F A-H1: coverage findings in round 1, not_run in round 2 -> needs_human at gates", async () => {
  const out = await rounds(gs(UNCOV), gs(NR));
  stopsAtGates(out, /^infra:gates:r2: gate coverage not_run .*after an earlier round's result/);
});

test("8.0.0 car F A-H1: mutation survivors in round 1, not_run in round 2 -> needs_human at gates", async () => {
  const out = await rounds(gs(null, SURV), gs(null, NR));
  stopsAtGates(out, /^infra:gates:r2: gate mutation not_run /);
});

test("8.0.0 car F A-H1: any not_run after an earlier clean ran stops; a partial stops only after a ran with findings", async () => {
  stopsAtGates(await rounds(gs(CLEAN), gs(NR), fixCode), /gate coverage not_run/);
  stopsAtGates(await rounds(gs(null, MCLEAN), gs(null, NR), fixCode), /gate mutation not_run/);
  stopsAtGates(await rounds(gs(UNCOV), gs({ status: "partial", reason: "the 540 s deadline was hit before the coverage report", findings: [] })), /gate coverage partial/);
  // security review of car F: a partial after a partial with findings stops too (bit 4)
  stopsAtGates(await rounds(gs({ status: "partial", reason: "not measured (not python): a.js", findings: UNCOV.findings }), gs({ status: "partial", reason: "not measured (not python): a.js", findings: [] })), /gate coverage partial .*after an earlier round's result/);
  const sec = { status: "ran", reason: null, findings: [{ path: "src/x.py", lines: [3], rule: "grep: shell=True", kind: "code" }] };
  stopsAtGates(await rounds(gs(null, null, sec), gs()), /gate security_scan partial/);
  // a partial after a clean ran: no stop (a .js file next to the python one is partial)
  const ok = await rounds(gs(CLEAN), gs({ status: "partial", reason: "not measured (not python): a.js", findings: [] }), fixCode);
  assert.equal(ok.result.status, "ok", ok.result.reason);
  // not_run in both rounds: no earlier result, no stop (the harness default)
  const nr = await rounds(gs(), gs(), fixCode);
  assert.equal(nr.result.status, "ok", nr.result.reason);
});

test("8.0.0 car F G2 ruling: tree red with a green base -> needs_human at gates in that round", async () => {
  const red = { status: "not_run", reason: "tree red, base green: the judged tree fails test_cmd in the scratch copy (exit 1)" };
  for (const s of [gs(red), gs(null, red)]) {
    const out = await run(happy({ script: { "infra:gates:r1": s } }), ARGS);
    stopsAtGates(out, /^infra:gates:r1: gate (coverage|mutation) not_run \(tree red, base green/);
  }
});

test("8.0.0 car F A-H1: the earlier-result mark is saved in the run state (gates_seen) and restored on a resume", async () => {
  const out = await run(happy({ script: { "infra:gates:r1": gs(CLEAN, MCLEAN) } }), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const st = stateJsonOf(call(out, "infra:state:committed:r1").prompt);
  assert.deepEqual(st.gates_seen, { coverage: 1, mutation: 1, security_scan: 0 });
  const st2 = stateJsonOf(call(await run(happy(), ARGS), "infra:state:committed:r1").prompt);
  assert.deepEqual(st2.gates_seen, { coverage: 0, mutation: 0, security_scan: 0 });
  assert.match(SOURCE, /for \(const \[g, n\] of Object\.entries\(Object\(resume\.gates_seen\)\)\)/);
});

test("8.0.0 car F A-H2: gitleaks runs with the plugin's pinned config: the default rules with no global path allowlist", () => {
  const src = readFileSync(join(SCRIPTS, "sec_scan.py"), "utf8");
  const pin = /\nGITLEAKS_SHA256 = '([0-9a-f]{64})'\n/.exec(src);
  assert.ok(pin, "GITLEAKS_SHA256");
  const toml = readFileSync(join(SKILL, "gitleaks.toml"));
  assert.equal(pin[1], createHash("sha256").update(toml).digest("hex"));
  const t = toml.toString("utf8");
  // the global [allowlist] keeps its regexes and stopwords, but no paths list (lock files, node_modules/, go.sum)
  const glob = t.slice(t.indexOf("\n[allowlist]\n"), t.indexOf("\n[[rules]]\n"));
  assert.ok(glob.length > 0 && !/\npaths = \[/.test(glob), glob);
  assert.ok(!/^\s*(\[extend\]|useDefault)/m.test(t), "useDefault inherits the default path allowlist");
  assert.ok(!/node_modules|package-lock|go\\\.\(\?:mod\|sum/.test(glob));
  assert.ok((t.match(/\n\[\[rules\]\]\n/g) || []).length >= 200, "the default rules");
  assert.match(src, /'--config', '\/rules\/gitleaks\.toml'/);
});

// A-M7: a re-plan in the same run would reset state.gates and drop a held-out result this build already read
const HO = [{ criterion_id: "AC1", given: "g", when: "f(9)", then: "10" }];
const CRIT = [{ id: "AC1", text: "[unit] behaviour 1", test_files: ["tests/test_1.py"], examples: [{ given: "g", when: "f(1)", then: "2", kind: "main" }], dont_care: [], property: null, guards_existing: false, spec_quote: null }];
const PLAN_WRONG = { status: "ok", reason: "plan wrong", verdict: "plan_wrong", routed_findings: [{ target: "plan", criterion: "AC1", finding: "AC1 is wrong -- Proposed plan change: fix AC1" }], hash_check: { match: true, mismatched: [] }, suite_result: { command: "pytest", exit_code: 1 }, gates_not_run: [], obligations_check: [] };
function replanHO(pass) {
  const s = happy({ criteria: CRIT });
  s["role:scope-and-plan"].held_out_examples = HO;
  return Object.assign(s, {
    "role:fleet-held-out-runner:r1": (p) => ({ status: "ok", reason: "ran", store: "ok", store_digest: inputsOf(p).held_out.sha256, results: [{ criterion: "AC1", index: 0, pass }] }),
    "role:fleet-code-judge:r1": PLAN_WRONG,
    "infra:replan-worktree": (p) => ({ status: "ok", reason: "ok", head: inputsOf(p).plan_commit }),
    "role:scope-and-plan:replan": Object.assign({}, s["role:scope-and-plan"], { tldr: "re-planned" }),
    "role:plan-audit:replan": { status: "ok", reason: "fine", verdict: "approve", routed_findings: [] },
    "infra:stage-plan:replan": { status: "ok", reason: "staged", plan_sha256: PSHA },
    "infra:commit-plan:replan": commitStub(s.__store, "0123456789ab", PSHA),
    "infra:replan-reset": (p) => ({ status: "ok", reason: "reset", head: PB, superseded_head: inputsOf(p).expected_head }),
    // the first plan's auto gates (unattended)
    "hasher:pre-intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "role:fleet-intent-judge": { status: "ok", reason: "matches the task", verdict: "approve", deviations: [], coverage: { covered: true, missing: [] }, classification: { change_kind: "approve", new_behaviour: "approve", quote: "add a thing" } },
    "hasher:fp-post:intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "infra:precommit-ids": { status: "ok", reason: "read", present: true, ids: ["prettier", "check-json"], parser: "yaml" },
  });
}
test("8.0.0 car F A-M7: an unattended re-plan after this build read the held-out store asks (needs the human, the re-plan ready)", async () => {
  for (const pass of [false, true]) {
    const out = await runOne(replanHO(pass), Object.assign({}, ARGS, { unattended: true }));
    assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
    const d = (out.result.auto_decisions || []).map((x) => x.gate + ": " + x.decision + " (" + x.reason + ")");
    assert.ok(d.includes("plan_wrong: ask (code-judge re-plan 1: this build already ran the held-out gate)"), d.join("\n"));
  }
});

// A-M6: the planner's outputs other than the held-out list never carry a held-out example (when and then together)
test("8.0.0 car F A-M6: a memory_notes entry that holds a held-out example is dropped; tldr, plan_diff and criteria text are redacted", async () => {
  const s = happy({ criteria: CRIT });
  const p = s["role:scope-and-plan"];
  p.held_out_examples = HO;
  p.memory_notes = ["keep this note", "f(9) gives 10 (held-out)", "f(9) alone is fine"];
  p.tldr = "add thing; f(9) is 10";
  p.plan_diff = ["step one", "check f(9) == 10"];
  p.criteria = CRIT.map((c) => Object.assign({}, c, { text: c.text + " (e.g. f(9) -> 10)" }));
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const all = JSON.stringify(out.result) + out.logs.join("\n") + out.calls.filter((c) => c.label !== "infra:held-out:write").map((c) => c.prompt).join("\n");
  assert.ok(!/f\(9\)[^"]*10/.test(all), "no held-out example in the result, the logs or a later prompt");
  const notes = [].concat(...(out.result.memory_notes || []).map((x) => x.notes));
  assert.ok(notes.includes("keep this note") && notes.includes("f(9) alone is fine"), JSON.stringify(notes));
  assert.ok(!notes.some((n) => /10/.test(n)));
});

// B-M1: a held-out test run that hits its deadline is not a failing example
test("8.0.0 car F B-M1: scratch_copy run kills the child's process group at its deadline (at most 540 s) and says timed_out", () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-r8f-"));
  const repo = join(root, "main");
  mkdirSync(repo);
  try {
    const git = (...a) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git("add", "-A");
    git("-c", "user.email=a@b", "-c", "user.name=a", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
    const PY = join(SCRIPTS, "scratch_copy.py");
    const py = (env, ...a) => spawnSync("python3", ["-I", PY, ...a], { encoding: "utf8", env: Object.assign({ PATH: process.env.PATH }, env) });
    const tmp = JSON.parse(py({}, "make", repo).stdout).tmp;
    const t0 = Date.now();
    // a grandchild that would outlive its parent: the whole group goes
    writeFileSync(join(tmp, "s.sh"), "sleep 30 &\nsleep 30\n");
    const r = py({ FLEET_SCRATCH_RUN_DEADLINE: "1" }, "run", repo, tmp, JSON.stringify(["sh", join(tmp, "s.sh")]));
    assert.ok(Date.now() - t0 < 8000, "returns at the deadline");
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.timed_out, true);
    assert.equal(o.exit_code, null);
    const ok = JSON.parse(py({}, "run", repo, tmp, JSON.stringify(["true"])).stdout);
    assert.equal(ok.timed_out, false);
    assert.equal(ok.exit_code, 0);
    const src = readFileSync(PY, "utf8");
    assert.match(src, /DEADLINE = min\(540, int\(_dl\)\)/);
    py({}, "remove", repo, tmp);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("8.0.0 car F B-M1 (review M2): a runner that reports store timeout stops at gates in every round (never not_run, never fix_code); the role asks for timeout 600000 ms", async () => {
  const s = happy({ criteria: CRIT });
  s["role:scope-and-plan"].held_out_examples = HO;
  s["role:fleet-held-out-runner:r1"] = { status: "ok", reason: "timed out", store: "timeout", store_digest: null, results: null };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "gates", out.result.reason);
  assert.match(out.result.reason, /role:fleet-held-out-runner:r1: a held-out test run hit its deadline/);
  assert.ok(!out.labels.includes("role:fleet-code-judge:r1"), "no judge, no fix_code round");
  const role = ROLE_TEXT["fleet-held-out-runner"];
  assert.match(role, /timeout 600000 ms/);
  assert.match(role, /"timeout"/);
});

// B-M2: the preflight's image check and pull fit the 600 s Bash call: the pull <= 480 s, the whole <= 560 s
test("8.0.0 car F B-M2: gate_tools.py bounds the pull at 480 s and the whole at 560 s (a test knob lowers it)", () => {
  const d = mkdtempSync(join(tmpdir(), "fleet-r8f-gt-"));
  try {
    const sleep = spawnSync("sh", ["-c", "command -v sleep"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(join(d, "podman"), "#!/bin/sh\ncase \"$1\" in image) exit 1;; pull) exec " + sleep + " 30;; esac\nexit 0\n");
    chmodSync(join(d, "podman"), 0o755);
    const img = "docker.io/x/y@sha256:" + "a".repeat(64);
    const t0 = Date.now();
    const py = spawnSync("python3", ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim();
    const r = spawnSync(py, ["-I", join(SCRIPTS, "gate_tools.py"), "/nonexistent-repo", img], { encoding: "utf8", env: { PATH: d, FLEET_GATE_TOOLS_DEADLINE: "2" } });
    assert.ok(Date.now() - t0 < 10000, "stops at the deadline: " + (Date.now() - t0) + " ms");
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.container.present, false);
    assert.match(o.container.reason, /TimeoutExpired/);
    const src = readFileSync(join(SCRIPTS, "gate_tools.py"), "utf8");
    assert.match(src, /TOTAL = min\(560, int\(_dl\)\) if re\.match\(r'\^\[1-9\]\[0-9\]\{0,3\}\$', _dl\) else 560/);
    assert.match(src, /'pull', image\], 480\)/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// B-M3: db_up's cold pull (podman run) fits the 600 s Bash call the prompt asks for
test("8.0.0 car F B-M3: db_up bounds podman run (the cold pull) at 480 s and the whole at 560 s; the prompt asks for timeout 600000 ms", async () => {
  const d = mkdtempSync(join(tmpdir(), "fleet-r8f-db-"));
  try {
    const sleep = spawnSync("sh", ["-c", "command -v sleep"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(join(d, "podman"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '" + join(d, "log") + "'\ncase \"$1\" in run) if [ \"$2\" = \"--help\" ]; then printf '      --timeout uint\\n'; exit 0; fi; exec " + sleep + " 30;; esac\nexit 0\n");
    chmodSync(join(d, "podman"), 0o755);
    const py = spawnSync("python3", ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim();
    const t0 = Date.now();
    const r = spawnSync(py, ["-I", join(SCRIPTS, "db_up.py"), "up", "fleet-db-y42-1", "docker.io/library/mariadb@sha256:" + "d".repeat(64), "21600", "n1-0000001", JSON.stringify(["fleet_plan"]), "f_"], { encoding: "utf8", env: { PATH: d, HOME: d, FLEET_DB_UP_DEADLINE: "2" } });
    assert.ok(Date.now() - t0 < 10000, "stops at the bound: " + (Date.now() - t0) + " ms");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /podman run .*bound/);
    assert.ok(readFileSync(join(d, "log"), "utf8").includes("rm -f fleet-db-y42-1"), "the container is removed");
    const src = readFileSync(join(SCRIPTS, "db_up.py"), "utf8");
    assert.match(src, /timeout=480\)/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
  assert.match(SOURCE, /"Run this one command as one Bash call with timeout 600000 ms:\\n" \+\n\s+progCmd\("db_up"/);
  assert.ok(!/900000/.test(SOURCE));
});

// A-L11: a scratch copy a role left (it died before remove) is swept by the next reset and the teardown
test("8.0.0 car F A-L11: build_dir reset and clean remove leftover scratch copy-* and guard-* dirs, and nothing else in scratch", () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-r8f-bd-"));
  try {
    const sc = join(home, "scratch");
    const bd = (...a) => spawnSync("python3", ["-I", join(SCRIPTS, "build_dir.py"), ...a], { encoding: "utf8" });
    for (const mode of ["reset", "clean"]) {
      for (const d of ["copy-abc", "guard-x", "chunks", "keep"]) mkdirSync(join(sc, d, "sub"), { recursive: true });
      const r = mode === "reset" ? bd("reset", sc, "n1", "k1") : bd("clean", sc);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!existsSync(join(sc, "copy-abc")) && !existsSync(join(sc, "guard-x")), mode);
      assert.ok(existsSync(join(sc, "chunks")) && existsSync(join(sc, "keep")), mode);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// car F security review (MEDIUM 1): every string leaf of the plan but the held-out list, matched case- and space-blind
test("8.0.0 car F review M1: a held-out when/then in criteria examples, dont_care, property or spec_quote is redacted (case and spacing ignored)", async () => {
  const s = happy({ criteria: CRIT });
  const p = s["role:scope-and-plan"];
  p.held_out_examples = HO;
  p.criteria = CRIT.map((c) => Object.assign({}, c, { examples: c.examples.concat([{ given: "g", when: "F(9)", then: " 10", kind: "edge" }]), dont_care: ["f(9)  gives 10"], property: "F(9)\t== 10", spec_quote: "f(9) -> 10" }));
  const out = await runOne(s, ARGS);
  const all = JSON.stringify(out.result) + out.logs.join("\n") + out.calls.filter((c) => c.label !== "infra:held-out:write").map((c) => c.prompt).join("\n");
  assert.ok(!/f\(9\)[^"]*10/i.test(all), "no held-out example anywhere but the write step");
  assert.ok(out.calls.some((c) => c.prompt.includes("(held-out text redacted)")));
});

// B-L2, B-L3: the agent cap holds the held-out runner and the code round's run-state write
test("8.0.0 car F B-L2/B-L3: heldOutRun reserves its agent before it counts it; the code-round reserve counts infra:state:committed (11)", () => {
  const ho = SOURCE.slice(SOURCE.indexOf("async function heldOutRun("));
  assert.match(ho.slice(0, ho.indexOf("state.agents++") + 15), /reserve\(1, label\);\n\s+state\.agents\+\+/);
  assert.match(SOURCE, /reserve\(11 \+ \(planFacts\.changed_symbols \? 1 : 0\)/);
});

// B-L5: the db sweep fits a 180 s Bash call; the push probe's one 120 s dry run fits RUN_180S
test("8.0.0 car F B-L5: db_sweep stops at its 150 s bound (a test knob lowers it) and still prints; the prompt asks for timeout 180000 ms", () => {
  const d = mkdtempSync(join(tmpdir(), "fleet-r8f-sw-"));
  try {
    const sleep = spawnSync("sh", ["-c", "command -v sleep"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(join(d, "podman"), "#!/bin/sh\nexec " + sleep + " 30\n");
    chmodSync(join(d, "podman"), 0o755);
    const py = spawnSync("python3", ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim();
    const t0 = Date.now();
    const r = spawnSync(py, ["-I", join(SCRIPTS, "db_sweep.py")], { encoding: "utf8", env: { PATH: d, HOME: d, FLEET_DB_SWEEP_DEADLINE: "2" } });
    assert.ok(Date.now() - t0 < 10000, "stops at the bound");
    assert.equal(r.status, 0, r.stderr);
    assert.match(JSON.parse(r.stdout).errors.join(" "), /bound/);
    assert.match(readFileSync(join(SCRIPTS, "db_sweep.py"), "utf8"), /TOTAL = min\(150, int\(_dl\)\)/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
  assert.match(SOURCE, /\? "1\. " \+ RUN_180S \+ progCmd\("db_sweep", \[\]\)/);
  assert.match(readFileSync(join(SCRIPTS, "push.py"), "utf8"), /'--porcelain', 'origin', args\[2\] \+ ':refs\/heads\/' \+ args\[3\]\], stdout=subprocess\.PIPE, stderr=subprocess\.STDOUT, stdin=subprocess\.DEVNULL, timeout=120,/);
});
