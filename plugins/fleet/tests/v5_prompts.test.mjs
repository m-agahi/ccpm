// fleet 5.0.0 PR-3 (R3, ledger 1999): the role prompt revision. The role files
// are plugin files read by role agents that may run with no memory server, so
// they carry no yadgar contract, no page-version or CONTRACT text, no
// 1Password instruction and no second output channel (the StructuredOutput
// tool is the only one). Gates the release does not run are named as not run.
// The test_cmd / check_cmd allowlist lives in ONE pinned file,
// roles/_shared/test-cmd-allowlist.md, which the planner and the plan audit
// hash and read as a second step; its examples are run through the script's
// own validators. New inputs: prior_findings (code judge, pr-review) and
// allowed_additions (pr-review). New optional outputs: follow_ups (coder,
// passed through to the run result) and memory_notes (every role; the old
// yadgar_findings key is gone).
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { SOURCE, ARGS, happy, run, runOne, inputsOf, call, noUnscripted, ROLE_NAMES, ROLES_SRC, SCRIPTS_SRC, SCRIPTS_DIR, HASHES, FP_K1, CSHA, H, HASHES_FLAT, BRIEF } from "./harness.mjs";

const GEN = await import(join(SCRIPTS_SRC, "gen.mjs"));
const SHARED_DIR = join(ROLES_SRC, "_shared");
const ALLOWLIST = join(SHARED_DIR, "test-cmd-allowlist.md");
const ROLES_DIR = SCRIPTS_DIR.replace(/\/scripts$/, "/roles");
const fileSha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

// every prompt file the plugin ships: the ten roles and the shared files
function promptFiles() {
  const out = ROLE_NAMES.map((r) => [r + ".md", readFileSync(join(ROLES_SRC, r + ".md"), "utf8")]);
  if (existsSync(SHARED_DIR)) for (const f of readdirSync(SHARED_DIR).sort()) out.push(["_shared/" + f, readFileSync(join(SHARED_DIR, f), "utf8")]);
  return out;
}

// ---------------------------------------------------------------- prose lint

// Each pattern matches the real text the 4.x role files carried (CONTRACT
// fleet-v4 had no colon; the fenced-json rule said "exactly ONE fenced `json`
// block as the LAST thing"; the writers ran `git fetch origin --prune`).
const FORBIDDEN = [
  ["a 1Password read", /\bop read\b|op:\/\//],
  ["a yadgar page load", /agent_prompt_get/],
  ["the Yadgar findings footer", /Yadgar findings/i],
  ["the old notes key", /yadgar_findings/],
  ["a CONTRACT marker", /\bCONTRACT\b/],
  ["a fleet-vN contract name", /fleet-v\d/],
  ["a minimum page version", /page version/i],
  ["a second output channel (fenced json)", /fenced\s+`?json`?\s+block|trailing fenced json/i],
  ["a wiki link", /\[\[/],
  ["a yadgar repo path", /yadgar\/\\?_shared/],
  ["a branch fetch", /git fetch\b[^\n`]*--prune/],
  ["a fleet version annotation", /\bfleet \d+\.\d+(\.\d+)?\b/],
  ["an ADR reference", /\bADR-\d+/],
  ["a required recall call", /\brecall\(/],
  ["a memorize call", /\bmemorize\(/],
];

test("5.0.0 R3: no role or shared prompt file carries yadgar, contract, 1Password, fenced-json, wiki-link, ADR, version-annotation or fetch text", () => {
  const bad = [];
  for (const [f, t] of promptFiles()) for (const [what, re] of FORBIDDEN) if (re.test(t)) bad.push(f + ": " + what + " (" + re.exec(t)[0] + ")");
  assert.deepEqual(bad, []);
});

test("5.0.0 R3: every role file is well under 40000 characters (35000), names StructuredOutput as its only output channel, and lists memory_notes as optional", () => {
  const sizes = {};
  for (const r of ROLE_NAMES) {
    const t = readFileSync(join(ROLES_SRC, r + ".md"), "utf8");
    sizes[r] = t.length;
    assert.ok(t.length < 35000, r + ".md: " + t.length + " characters");
    assert.match(t, /StructuredOutput/, r + ": names the StructuredOutput tool");
    assert.match(t, /memory_notes/, r + ": names the optional memory_notes key");
    assert.match(t, /role_file/, r + ": names role_file in its output");
  }
  const total = Object.values(sizes).reduce((a, b) => a + b, 0);
  assert.ok(total < 150000, "all role files: " + total + " characters");
});

test("5.0.0 R3: memory is optional prose only: a role may consult a memory tool when present, never writes one", () => {
  for (const r of ROLE_NAMES) {
    const t = readFileSync(join(ROLES_SRC, r + ".md"), "utf8");
    assert.doesNotMatch(t, /recall first|recall\("|Recall first/i, r);
    if (/memory tool/i.test(t)) assert.match(t, /never (required|write)/i, r + ": a memory tool is optional and never written");
  }
});

// ---------------------------------------------------------------- truthful gates

test("5.0.0 R3: gates this release does not run are described as not run, never as run by script", () => {
  const coder = readFileSync(join(ROLES_SRC, "fleet-coder.md"), "utf8");
  assert.doesNotMatch(coder, /Gates that run on your diff/);
  assert.doesNotMatch(coder, /Mutation score/i);
  assert.doesNotMatch(coder, /runs examples you have not seen/);
  assert.match(coder, /special-case the tests/, "the no-special-casing rule is kept");
  const plan = readFileSync(join(ROLES_SRC, "scope-and-plan.md"), "utf8");
  assert.doesNotMatch(plan, /runs them against the finished code/);
  assert.match(plan, /held_out_examples/, "the planner still emits held_out_examples");
  const cj = readFileSync(join(ROLES_SRC, "fleet-code-judge.md"), "utf8");
  for (const g of ["mutation", "coverage", "security_scan", "held_out"]) assert.match(cj, new RegExp("`" + g + "`"), "code judge names gate " + g);
  assert.match(cj, /gates_not_run/);
  assert.doesNotMatch(cj, /hunk_rulings|mutant_rulings|exemptions/, "no dead output keys");
  const tw = readFileSync(join(ROLES_SRC, "fleet-test-writer.md"), "utf8");
  assert.match(tw, /[Ii]nactive/, "the mutation-augmentation section is marked inactive");
  for (const [r, t] of [["fleet-coder", coder], ["scope-and-plan", plan], ["fleet-code-judge", cj], ["fleet-test-writer", tw]])
    assert.doesNotMatch(t, /(coverage|mutation)[^.\n]*\bby script\b/i, r);
});

test("5.0.0 R3: the real inputs are documented: hash_recheck, prior_findings, frozen_tests_note, code_tree, brief, ledger_task, allowed_additions", () => {
  const t = (r) => readFileSync(join(ROLES_SRC, r + ".md"), "utf8");
  for (const k of ["hash_recheck", "prior_findings", "code_tree"]) assert.match(t("fleet-code-judge"), new RegExp("`" + k + "`"), "code judge: " + k);
  for (const k of ["frozen_tests_note", "code_tree", "follow_ups"]) assert.match(t("fleet-coder"), new RegExp("`" + k + "`"), "coder: " + k);
  for (const k of ["brief", "ledger_task"]) assert.match(t("fleet-intent-judge"), new RegExp("`" + k + "`"), "intent judge: " + k);
  assert.doesNotMatch(t("fleet-intent-judge"), /`task_body`|`rulings`/, "intent judge: no inputs the script never sends");
  for (const k of ["allowed_additions", "prior_findings"]) assert.match(t("pr-review"), new RegExp("`" + k + "`"), "pr-review: " + k);
  for (const r of ["fleet-code-judge", "pr-review"]) assert.match(t(r), /resolved.*still_present.*regressed/s, r + ": classifies prior findings");
  for (const r of ["fleet-code-judge", "pr-review", "fleet-pr-opener"]) assert.match(t(r), /first 4 characters/, r + ": the secret redaction rule");
});

// release review of #48, item 4: was "once gh pr checks reports success"
test("5.0.0 R3: pr-review is fleet-mode only, reads no secret, and counts CI only from the check runs of head_sha", () => {
  const t = readFileSync(join(ROLES_SRC, "pr-review.md"), "utf8");
  assert.doesNotMatch(t, /≤ ?40 lines|## Task list/);
  assert.doesNotMatch(t, /<\s?80|>=\s?80|Drop anything/);
  assert.doesNotMatch(t, /green[^.\n]*CI[^.\n]*IS the evidence/i);
  assert.match(t, /repos\/<repo>\/commits\/<head_sha>\/check-runs/);
  assert.doesNotMatch(t, /gh pr checks/);
  assert.doesNotMatch(t, /SELF-AUTHORED PR MODE \(use whenever|Flux|ClusterRoleBinding|kustomize|HelmRelease/);
});

test("5.0.0 R3: writers and the coder run no branch-state checks (the workspace step owns them)", () => {
  for (const r of ["fleet-test-writer", "fleet-coder"]) {
    const t = readFileSync(join(ROLES_SRC, r + ".md"), "utf8");
    assert.doesNotMatch(t, /gh pr list|ls-remote|rev-list --count/, r);
  }
});

test("5.0.0 R3: scope-and-plan and plan-audit hold no non-fleet modes", () => {
  const p = readFileSync(join(ROLES_SRC, "scope-and-plan.md"), "utf8");
  assert.doesNotMatch(p, /commit=true|advisor=|measure_first|perf-lever/);
  const a = readFileSync(join(ROLES_SRC, "plan-audit.md"), "utf8");
  assert.doesNotMatch(a, /writeback=true|## AUDIT \(/);
});

// ---------------------------------------------------------------- the shared allowlist

// The script's own validators, loaded from the workflow source.
function validators() {
  const fnText = (name) => {
    const i = SOURCE.indexOf("\nfunction " + name + "(");
    assert.ok(i >= 0, "function " + name);
    return SOURCE.slice(i, SOURCE.indexOf("\n}\n", i) + 3);
  };
  const constText = (name) => {
    const m = new RegExp("\\nconst " + name + " = [^\\n]*;\\n").exec(SOURCE);
    assert.ok(m, "const " + name);
    return m[0];
  };
  const consts = ["CMD_TOKEN_RE", "PATHS_TOKEN", "FORBIDDEN_WORD_RE", "TEST_ENV_ALLOWED", "ENV_VALUE_RE", "MAKE_TARGET_RE", "SCRIPT_ROOTS", "SCRIPT_BAD_SEGMENTS", "SCRIPT_BAD_BASENAME_RE", "SCRIPT_EXTENSIONS", "WORD_RE", "TEST_CMD_CHARS_RE", "QUOTED_EXPR_RE", "PATH_ARG_RE", "TEST_CMD_BAD_WORDS", "CARGO_NAME_RE", "PYTEST_FLAGS", "PYTEST_FLAG_RE"];
  const fns = ["parseCheckCmd", "scriptPathProblem", "relPath", "testRunnerPrefix", "testPathArg", "goPackageArg", "testArgsProblem", "splitTestCmd", "testCmdProblem"];
  return new Function(consts.map(constText).join("") + fns.map(fnText).join("") + "\nreturn { testCmdProblem, parseCheckCmd };")();
}

test("5.0.0 R3: the allowlist ships once, as roles/_shared/test-cmd-allowlist.md, pinned by SHARED_SHA256", () => {
  assert.ok(existsSync(ALLOWLIST), "the shared allowlist file");
  const pin = GEN.shared(SOURCE);
  assert.deepEqual(Object.keys(pin), ["test-cmd-allowlist"]);
  assert.equal(pin["test-cmd-allowlist"], fileSha(ALLOWLIST));
  // the two roles that used to carry their own copy carry none
  for (const r of ["scope-and-plan", "plan-audit"]) {
    const t = readFileSync(join(ROLES_SRC, r + ".md"), "utf8");
    assert.doesNotMatch(t, /-q -v -vv|DJANGO_SETTINGS_MODULE|--manifest-path|SCRIPT_ROOTS|`hack`/, r + ": no copy of the allowlist");
    assert.match(t, /test-cmd-allowlist/, r + ": points at the shared file");
  }
});

test("5.0.0 R3: every allowlist example agrees with the script's validators (the grammar matches; uv run repeats its options)", () => {
  const v = validators();
  const text = readFileSync(ALLOWLIST, "utf8");
  const ex = [...text.matchAll(/^(allow|deny) (test_cmd|check_cmd): (.*)$/gm)];
  assert.ok(ex.filter((m) => m[1] === "allow").length >= 15 && ex.filter((m) => m[1] === "deny").length >= 15, "examples: " + ex.length);
  const wrong = [];
  for (const [, verdict, kind, cmd] of ex) {
    const why = kind === "test_cmd" ? v.testCmdProblem({ command: cmd, env: {}, tools: [] }) : v.parseCheckCmd(cmd).ok ? null : v.parseCheckCmd(cmd).reason;
    if ((verdict === "allow") !== (why === null)) wrong.push(verdict + " " + kind + ": " + cmd + " -> " + (why || "allowed"));
  }
  assert.deepEqual(wrong, []);
  assert.match(text, /`-n auto`/, "the file names -n auto as denied");
  assert.ok(ex.some(([, a, k, c]) => a === "allow" && k === "test_cmd" && /--extra \S+ --extra/.test(c)), "a repeated uv --extra is an allowed example");
});

const SHARED_STEP = (f) => "sha256sum -- '" + ROLES_DIR + "/_shared/" + f + ".md'";

test("5.0.0 R3: the planner and the plan audit prompts carry the shared file's sha256sum and Read step exactly once; no other role does", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const roleCalls = out.calls.filter((c) => c.label.startsWith("role:"));
  for (const c of roleCalls) {
    const role = c.label.split(":")[1];
    const n = c.prompt.split(SHARED_STEP("test-cmd-allowlist")).length - 1;
    const reads = c.prompt.split("Read " + ROLES_DIR + "/_shared/test-cmd-allowlist.md with the Read tool").length - 1;
    const want = role === "scope-and-plan" || role === "plan-audit" ? 1 : 0;
    assert.equal(n, want, c.label + ": sha256sum steps");
    assert.equal(reads, want, c.label + ": Read steps");
    if (want) {
      assert.ok(c.opts.schema.required.includes("shared_file"), c.label + ": shared_file is required");
      assert.match(c.prompt, /shared_file: \{name: "test-cmd-allowlist", sha256: <the hex sha256sum printed in step 3>\}/);
    } else assert.ok(!("shared_file" in c.opts.schema.properties), c.label);
  }
});

test("5.0.0 R3: a planner or audit result with a wrong or missing shared_file is retried once, then stops at contract", async () => {
  for (const role of ["scope-and-plan", "plan-audit"]) {
    for (const sf of [{ name: "test-cmd-allowlist", sha256: "0".repeat(64) }, null, { name: "other", sha256: GEN.shared(SOURCE)["test-cmd-allowlist"] }]) {
      const s = happy();
      const bad = Object.assign({}, s["role:" + role], { shared_file: sf });
      s["role:" + role] = bad;
      s["role:" + role + ":retry"] = bad;
      const out = await runOne(s, ARGS);
      assert.equal(out.result.status, "needs_human", role + " " + JSON.stringify(sf));
      assert.equal(out.result.stop_gate, "contract");
      assert.match(out.result.reason, new RegExp("role " + role + " did not read the shipped shared file test-cmd-allowlist"));
      assert.ok(out.labels.includes("role:" + role + ":retry"), out.labels.join(", "));
    }
    // a good retry goes on
    const s2 = happy();
    s2["role:" + role + ":retry"] = s2["role:" + role];
    s2["role:" + role] = Object.assign({}, s2["role:" + role], { shared_file: null });
    const ok = await runOne(s2, ARGS);
    assert.equal(ok.result.status, "awaiting_confirmation", role + ": " + ok.result.reason);
  }
});

test("5.0.0 R3: preflight pins the shared dir: a changed, extra or missing shared file stops before intake", async () => {
  const { scriptsProbe } = await import("./harness.mjs");
  const cases = [
    [{ roleSums: { "_shared/test-cmd-allowlist.md": "1".repeat(64) } }, /_shared\/test-cmd-allowlist\.md hashes 1{64}/],
    [{ roleSums: { "_shared/x.md": "1".repeat(64) } }, /_shared\/x\.md is not a shipped role file/],
    [{ roleSums: { "_shared/test-cmd-allowlist.md": undefined } }, /_shared\/test-cmd-allowlist\.md is missing/],
  ];
  for (const [over, re] of cases) {
    const s = happy();
    s.preflight = { scripts_probe: scriptsProbe(over), scripts_dir: SCRIPTS_DIR };
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human", JSON.stringify(over));
    assert.equal(out.result.stop_gate, "contract");
    assert.match(out.result.reason, re);
    assert.deepEqual(out.labels, ["preflight"]);
  }
});

// ---------------------------------------------------------------- prior_findings

test("5.0.0 R3: the code judge gets prior_findings: [] in round 1 and round 1's routed code findings in round 2", async () => {
  const finding = { target: "code", criterion: "AC1", finding: "src/x.py:3 -- dead branch -- delete it" };
  const s = happy({
    script: {
      "role:fleet-code-judge:r1": { status: "ok", reason: "x", verdict: "fix_code", routed_findings: [finding] },
      "role:fleet-coder:r2": { status: "ok", changed_paths: ["src/x.py"] },
      "hasher:post-coder:r2": { status: "ok", fingerprint: { head: FP_K1.head, tree: "K2" }, hashes: HASHES },
      "role:fleet-code-judge:r2": { status: "ok", verdict: "approve", routed_findings: [] },
      "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: { head: FP_K1.head, tree: "K2" } },
    },
  });
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.deepEqual(inputsOf(call(out, "role:fleet-code-judge:r1").prompt).prior_findings, []);
  assert.deepEqual(inputsOf(call(out, "role:fleet-code-judge:r2").prompt).prior_findings, [finding]);
  assert.deepEqual(inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings, [finding]);
});

test("5.0.0 R3: pr-review gets allowed_additions and prior_findings (the previous round's blocking findings); the sweep gets neither", async () => {
  const finding = { id: "R1", severity: "blocking", category: "fail_open", file: "src/x.py", line: 3, summary: "empty input passes", evidence: "ran x" };
  const s = happy({
    script: {
      "role:pr-review:v1": { status: "ok", reason: "x", verdict: "changes_requested", findings: [finding], touches_gate: false, checked: [] },
      "role:fleet-coder:r2": { status: "ok", changed_paths: ["src/x.py"] },
      "hasher:post-coder:r2": { status: "ok", fingerprint: { head: CSHA(1), tree: "K2" }, hashes: HASHES },
      "role:fleet-code-judge:r2": { status: "ok", verdict: "approve", routed_findings: [] },
      "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: { head: CSHA(1), tree: "K2" } },
      "infra:push:p2": (prompt) => ({ status: "ok", reason: "pushed", push_result: "ok", remote_head: inputsOf(prompt).approved_sha }),
      "role:fleet-pr-opener:p2": { status: "ok", reason: "updated", pr_url: "https://github.com/o/r/pull/7", pr_number: 7, created: false, template_used: null, gates_not_run_stated: true },
      "infra:review-paths:v2": { status: "ok", reason: "listed", changed_paths: ["src/x.py"] },
      "hasher:pre-review:v2": { status: "ok", fingerprint: { head: CSHA(2), tree: "K2" } },
      "role:pr-review:v2": { status: "ok", reason: "clean", verdict: "approve", findings: [], touches_gate: false, checked: [] },
      "hasher:fp-post:pr-review:v2": { status: "ok", fingerprint: { head: CSHA(2), tree: "K2" } },
      "infra:review-cleanup:v2": { status: "ok", reason: "clean" },
    },
  });
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  const v1 = inputsOf(call(out, "role:pr-review:v1").prompt);
  const v2 = inputsOf(call(out, "role:pr-review:v2").prompt);
  assert.deepEqual(v1.prior_findings, []);
  assert.deepEqual(v2.prior_findings, [finding]);
  assert.deepEqual(v1.allowed_additions, { files: [], symbols: [], deps: [], settings: [] });
  // the code judge of the review's fix round sees the review finding as its prior finding
  const cj2 = inputsOf(call(out, "role:fleet-code-judge:r2").prompt).prior_findings;
  assert.equal(cj2.length, 1);
  assert.match(cj2[0].finding, /empty input passes/);
  // a gate change runs the sweep with the review's inputs minus prior_findings
  const g = happy({
    script: {
      "infra:review-paths:v1": { status: "ok", reason: "listed", changed_paths: ["hooks/check.py"] },
      "role:gate-change-nonweakening-sweep:v1": { status: "ok", reason: "x", verdict: "non_weakening", units: [], findings: [] },
      "hasher:fp-post:sweep:v1": { status: "ok", fingerprint: { head: CSHA(1), tree: "K1" } },
    },
  });
  const o2 = await run(g, ARGS);
  assert.equal(o2.result.status, "ok", o2.result.reason);
  const sw = o2.calls.find((c) => c.label === "role:gate-change-nonweakening-sweep:v1");
  assert.ok(sw, o2.labels.join(", "));
  assert.ok(!("prior_findings" in inputsOf(sw.prompt)), "the sweep gets no prior_findings");
});

// ---------------------------------------------------------------- outputs

test("5.0.0 R3: the coder's follow_ups pass through to the run result; absent -> []", async () => {
  const s = happy();
  s["role:fleet-coder:r1"] = Object.assign({}, s["role:fleet-coder:r1"], { follow_ups: [{ summary: "split the parser", path: "src/x.py" }, { summary: "doc gap", path: null }] });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.deepEqual(out.result.follow_ups, [{ summary: "split the parser", path: "src/x.py" }, { summary: "doc gap", path: null }]);
  const bare = await run(happy(), ARGS);
  assert.deepEqual(bare.result.follow_ups, []);
  const sc = call(out, "role:fleet-coder:r1").opts.schema;
  assert.ok(!sc.required.includes("follow_ups"));
  // PR #48 ruling 1: optional and nullable
  assert.deepEqual(sc.properties.follow_ups.type, ["array", "null"]);
});

// ---------------------------------------------------------------- PR #48 rulings

// Ruling 1 (the 4.0.3 lesson): a field the script does not require is never
// required and always accepts null, so a model's null never stops a build.
// The 5.0.0 fields (PR-1 to PR-3) and their status:
//   role_file, shared_file  required, object|null (the script checks them)
//   memory_notes            optional, array|null (every role)
//   follow_ups              optional, array|null (coder)
//   ledger_tools            optional, array|null (preflight census, advisory)
test("PR #48 ruling 1: every 5.0.0 field the script does not require is optional and nullable", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const nullable = (p) => [].concat(p.type).includes("null");
  for (const c of out.calls.filter((x) => x.label.startsWith("role:"))) {
    const s = c.opts.schema;
    assert.ok(!s.required.includes("memory_notes"), c.label);
    assert.deepEqual(s.properties.memory_notes.type, ["array", "null"], c.label + " memory_notes");
    assert.ok(s.required.includes("role_file") && nullable(s.properties.role_file), c.label + " role_file");
    if (s.properties.shared_file) assert.ok(s.required.includes("shared_file") && nullable(s.properties.shared_file), c.label + " shared_file");
  }
  const pre = call(out, "preflight").opts.schema;
  assert.ok(!pre.required.includes("ledger_tools"), "ledger_tools is advisory: not required");
  assert.deepEqual(pre.properties.ledger_tools.type, ["array", "null"]);
});

test("PR #48 ruling 1: null memory_notes and follow_ups from the coder, and a null census, never stop a build", async () => {
  const s = happy();
  s.preflight = { ledger_tools: null };
  s["role:fleet-coder:r1"] = Object.assign({}, s["role:fleet-coder:r1"], { follow_ups: null, memory_notes: null });
  s["role:scope-and-plan"] = Object.assign({}, s["role:scope-and-plan"], { memory_notes: null });
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.deepEqual(out.result.follow_ups, []);
  assert.ok(!out.result.memory_notes.some((x) => x.role === "fleet-coder"));
});

// Ruling 2: a missing Non-goals section is a routed finding the planner fixes
// in a re-plan round; it never changes the verdict on its own.
test("PR #48 ruling 2: plan-audit routes a missing Non-goals section as a finding, never as plan_defect on its own", () => {
  const t = readFileSync(join(ROLES_SRC, "plan-audit.md"), "utf8");
  assert.doesNotMatch(t, /missing "Non-goals" section → `plan_defect`/i);
  // release review of #48: the Non-goals rule now lives in the advisory section (release 2 checks its verdict rule)
  assert.match(t, /no "Non-goals" section → finding/);
});

// Ruling 3: probe mode also reads the shared file the way the planner does.
test("PR #48 ruling 3: the probe role-read also hashes and reads _shared/test-cmd-allowlist.md and returns shared_file, checked by the script", async () => {
  const pin = GEN.shared(SOURCE)["test-cmd-allowlist"];
  const ok = happy();
  delete ok.__dispatch;
  const out = await runOne(ok, { mode: "probe", repo: "/r", date: ARGS.date });
  assert.equal(out.result.status, "ok", out.result.reason);
  const c = out.calls[1];
  assert.ok(c.prompt.includes(SHARED_STEP("test-cmd-allowlist")), "the shared sha256sum step");
  assert.ok(c.prompt.includes("Read " + ROLES_DIR + "/_shared/test-cmd-allowlist.md with the Read tool"), "the shared Read step");
  assert.ok(c.opts.schema.required.includes("shared_file"));
  assert.deepEqual(out.result.probe.role_read.shared_file, { name: "test-cmd-allowlist", sha256: pin, ok: true });
  for (const sf of [null, { name: "test-cmd-allowlist", sha256: "0".repeat(64) }, { name: "x", sha256: pin }]) {
    const t = happy();
    delete t.__dispatch;
    t["infra:role-read:plan-audit"] = { status: "ok", reason: "read", role_file: { name: "plan-audit", sha256: GEN.roles(SOURCE)["plan-audit"] }, shared_file: sf };
    const o = await runOne(t, { mode: "probe", repo: "/r", date: ARGS.date });
    assert.equal(o.result.status, "needs_human", JSON.stringify(sf));
    assert.equal(o.result.stop_gate, "contract");
    assert.match(o.result.reason, /probe: the role-read agent .*did not read the shipped shared file test-cmd-allowlist/);
  }
});

// Ruling 4: the prior-finding rulings are documented where they live.
test("PR #48 ruling 4: the prior-finding rulings (routed_findings prefixes, checked entries) are documented in the role files and the README", () => {
  const cj = readFileSync(join(ROLES_SRC, "fleet-code-judge.md"), "utf8");
  assert.match(cj, /`prior still_present: `/);
  assert.match(cj, /`prior regressed: `/);
  const pr = readFileSync(join(ROLES_SRC, "pr-review.md"), "utf8");
  assert.match(pr, /"prior <id>: resolved\|still_present\|regressed — <evidence>"/);
  const readme = readFileSync(join(ROLES_SRC, "..", "README.md"), "utf8");
  assert.match(readme, /`prior still_present: `/);
  assert.match(readme, /`prior regressed: `/);
  assert.match(readme, /`"prior <id>: resolved\|still_present\|regressed — <evidence>"`/);
});

// ---------------------------------------------------------------- release review of #48 (7c7523e)

const roleText = (r) => readFileSync(join(ROLES_SRC, r + ".md"), "utf8");

test("#48 release 1: plan-audit gets the brief with its source bodies, and the file documents it", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const a = inputsOf(call(out, "role:plan-audit").prompt);
  assert.deepEqual(a.brief, inputsOf(call(out, "role:scope-and-plan").prompt).brief);
  assert.ok(Array.isArray(a.brief.sources) && a.brief.sources.length && a.brief.sources.every((s) => "body" in s));
  assert.equal(a.brief.title, BRIEF.title);
  assert.match(roleText("plan-audit"), /- `brief`: `\{title, description, sources: \[\{kind, ref, url, body, id, project\}\], repo, plan_path\}`/);
});

test("#48 release 2: plan-audit's new 5.0.0 rules (Non-goals, STRIDE, I/O failure paths, source_quote) never change the verdict on their own", () => {
  const t = roleText("plan-audit");
  const i = t.indexOf("## Planner-quality findings");
  assert.ok(i >= 0, "a section for the soft rules");
  const sec = t.slice(i, t.indexOf("\n## ", i + 5));
  for (const k of ["Non-goals", "STRIDE", "failure path", "source_quote"]) assert.match(sec, new RegExp(k), k);
  assert.match(sec, /never changes? the verdict on (its|their) own/);
  // none of them is a gating item any more
  const g0 = t.indexOf("## Acceptance criteria gate");
  const gate = t.slice(g0, t.indexOf("\n## ", g0 + 5));
  assert.doesNotMatch(gate, /STRIDE|timeout, partial|source_quote/);
  assert.doesNotMatch(t, /paraphrase presented as a quote → `untestable_criteria`/);
});

test("#48 release 3: an approving audit's routed findings go to the gate log; README and CHANGELOG say so", async () => {
  const f = { target: "plan", criterion: null, finding: "add a Non-goals section" };
  const out = await run(happy({ script: { "role:plan-audit": { status: "ok", reason: "fine", verdict: "approve", routed_findings: [f] } } }), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.planResult.gate_log.some((l) => l === "plan-audit advisory finding (approve): -: add a Non-goals section"), out.planResult.gate_log.join("\n"));
  for (const doc of ["README.md", "CHANGELOG.md"]) assert.match(readFileSync(join(ROLES_SRC, "..", doc), "utf8"), /advisory finding[^.]*gate log/, doc);
});

test("#48 release 5: pr-review never blocks on a fix that needs a change outside allowed_additions", () => {
  assert.match(roleText("pr-review"), /outside `allowed_additions`[^.]*`nit`[^.]*needs plan change/);
});

test("#48 release 6: the code judge's prior_findings keep the last judge findings across a hash-rejection round, with the hash message appended", async () => {
  const f = { target: "code", criterion: "AC1", finding: "src/x.py:3 -- dead branch -- delete it" };
  const s = happy({
    script: {
      "role:fleet-code-judge:r1": { status: "ok", reason: "x", verdict: "fix_code", routed_findings: [f] },
      "role:fleet-coder:r2": { status: "ok", changed_paths: ["src/x.py"] },
      "hasher:post-coder:r2": { status: "ok", fingerprint: { head: FP_K1.head, tree: "K2" }, hashes: H({ ...HASHES_FLAT, "tests/test_a.py": "TAMPERED" }) },
      "role:fleet-coder:r3": { status: "ok", changed_paths: ["src/x.py"] },
      "hasher:post-coder:r3": { status: "ok", fingerprint: { head: FP_K1.head, tree: "K3" }, hashes: HASHES },
      "role:fleet-code-judge:r3": { status: "ok", verdict: "approve", routed_findings: [] },
      "hasher:fp-post:code-judge:r3": { status: "ok", fingerprint: { head: FP_K1.head, tree: "K3" } },
    },
  });
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(!out.labels.includes("role:fleet-code-judge:r2"));
  const p3 = inputsOf(call(out, "role:fleet-code-judge:r3").prompt).prior_findings;
  assert.equal(p3.length, 2, JSON.stringify(p3));
  assert.deepEqual(p3[0], f);
  assert.match(p3[1].finding, /frozen test or runner-config hash changed: .*tests\/test_a\.py/);
});

test("#48 release 7: the allowlist states the pre-commit option order PRECOMMIT_CMD_RE needs", () => {
  assert.match(readFileSync(ALLOWLIST, "utf8"), /in this order[^.]*`--all-files` before `--hook-stage <stage>`/);
});

test("#48 release 8: test-writer and test judge skip the reverse-order run for a cargo or go criterion (test_args, no paths)", () => {
  for (const r of ["fleet-test-writer", "fleet-test-judge"]) assert.match(roleText(r), /`test_args`[^.]*skip the reverse-order run/, r);
});

test("#48 release 9: the sweep allows null shipped_refuses / new_refuses when the instrument is broken", () => {
  assert.match(roleText("gate-change-nonweakening-sweep"), /`shipped_refuses`[^.]*`new_refuses`[^.]*null[^.]*instrument is broken/);
});

test("5.0.0 R3: role schemas carry memory_notes only (no yadgar_findings); notes from the roles reach the result", async () => {
  assert.doesNotMatch(SOURCE, /yadgar_findings/);
  const s = happy();
  s["role:scope-and-plan"] = Object.assign({}, s["role:scope-and-plan"], { memory_notes: ["planner note"] });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  for (const c of out.calls.filter((x) => x.label.startsWith("role:"))) assert.ok(!("yadgar_findings" in c.opts.schema.properties), c.label);
  assert.ok(out.planResult.memory_notes.some((x) => x.role === "scope-and-plan" && x.notes[0] === "planner note"));
});

test("5.0.0 R3: a write-back step whose tools are absent reports every entry unavailable, never failed", () => {
  assert.doesNotMatch(SOURCE, /Tools absent -> every entry failed/);
  const n = (SOURCE.match(/every entry status unavailable, reason \\"absent\\"; call nothing/g) || []).length;
  assert.ok(n >= 4, "unavailable rules: " + n);
});
