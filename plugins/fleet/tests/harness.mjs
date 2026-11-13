// Shared scenario-test harness for workflows/build-task-run.js (fleet 4.0.0, S1 task 0).
//
// Moved verbatim from build_task_run.test.mjs: the compiled-script runner with
// stubbed globals, the agent stubs and their auto-fill rules, the happy-path
// script, and the helpers several test files share. Each stream's tests import
// from here; no test() lives in this file.

import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync as rawSpawnSync } from "node:child_process";

// 3.1.0: every python3 program a test runs is bounded in time and output, on
// top of the program's own rlimits (a red run of an adversarial-input test
// must fail fast, never grow).
export const PY_SPAWN_LIMITS = { timeout: 300000, maxBuffer: 16 << 20, killSignal: "SIGKILL" };
export function spawnSync(cmd, args, opts) {
  return rawSpawnSync(cmd, args, cmd === "python3" ? Object.assign({}, PY_SPAWN_LIMITS, opts) : opts);
}
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const SCRIPT_PATH = join(HERE, "..", "workflows", "build-task-run.js");
export const SOURCE = readFileSync(SCRIPT_PATH, "utf8");

export const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// src: a fault-injected copy of the script (tests only); default the script
export function compile(src) {
  const body = (src || SOURCE).replace(/^export const meta/m, "const meta");
  return new AsyncFunction(
    "agent",
    "parallel",
    "pipeline",
    "phase",
    "log",
    "args",
    "budget",
    "workflow",
    "Date",
    "Math",
    body,
  );
}

export const ThrowingDate = function () {
  throw new Error("Date is unavailable in workflow scripts");
};
ThrowingDate.now = () => {
  throw new Error("Date.now is unavailable in workflow scripts");
};
export const SafeMath = Object.create(Math);
SafeMath.random = () => {
  throw new Error("Math.random is unavailable in workflow scripts");
};

// Extract the JSON inputs a role-runner or infra prompt carries. 5.0.0 (R1):
// a role prompt starts with the role file's text, which may itself hold a
// line starting "Inputs: " (documentation); the workflow's line is the last
// one that parses as JSON.
export function inputsOf(prompt) {
  const all = [...String(prompt).matchAll(/^Inputs: (.*)$/gm)];
  assert.ok(all.length, "prompt has an Inputs: line:\n" + prompt);
  for (let i = all.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(all[i][1]);
    } catch (e) {
      if (i === 0) throw e;
    }
  }
}

// The ten fleet roles (5.0.0, R1: their prompts ship as plugins/fleet/roles/<role>.md).
export const ROLE_NAMES = [
  "scope-and-plan",
  "plan-audit",
  "fleet-test-writer",
  "fleet-test-judge",
  "fleet-coder",
  "fleet-code-judge",
  "fleet-pr-opener",
  "fleet-intent-judge",
  "pr-review",
  "gate-change-nonweakening-sweep",
  "fleet-ci-classifier",
];
export const ROLES_SRC = join(HERE, "..", "roles");
// the shipped role file text, by role
export const ROLE_TEXT = Object.fromEntries(ROLE_NAMES.map((r) => [r, readFileSync(join(ROLES_SRC, r + ".md"), "utf8")]));
// The role texts a scenario runs with (5.0.0): the shipped files, with
// script.__dispatch[role] in place of the first DISPATCH line (null: no
// DISPATCH line) and script.__roleText[role] in place of the whole text. A
// scenario that changes a text runs on a copy of the workflow whose
// ROLE_SHA256 and ROLE_DISPATCH pin the changed texts (the files stay the
// source of truth). Role stubs return the role_file the scenario's file hashes to.
export function scenarioRoles(script) {
  const out = {};
  for (const r of ROLE_NAMES) {
    let t = ROLE_TEXT[r];
    const d = script && script.__dispatch;
    if (d && Object.prototype.hasOwnProperty.call(d, r)) t = d[r] === null ? t.replace(/^DISPATCH:.*\n/m, "") : t.replace(/^DISPATCH:.*$/m, () => d[r]);
    const rt = script && script.__roleText;
    if (rt && Object.prototype.hasOwnProperty.call(rt, r)) t = rt[r];
    out[r] = t;
  }
  return out;
}

// Keys each role must return on status ok (the frozen fleet-v4 contract).
// The harness fills missing ones with neutral defaults for terse override
// stubs; a stub with __raw: true is returned as written (drift tests).
export const REQUIRED_DEFAULTS = {
  "scope-and-plan": { plan_path: "docs/plans/x.md", criteria: [], est_diff_lines: 80, new_behaviour: true, allowed_additions: { files: [], symbols: [], deps: [], settings: [] }, held_out_examples: [], tldr: "adds a thing", plan_diff: ["new plan"], repo_obligations: [], test_cmd: { command: "pytest <paths>", paths_placeholder: "<paths>", env: {}, tools: [] }, changed_symbols: [], change_kind: "feature" },
  "plan-audit": { verdict: "approve", routed_findings: [] },
  "fleet-test-writer": { criterion_id: "AC1", tests: [], files: [] },
  "fleet-test-judge": { verdict: "approve", routed_findings: [], checked: [] },
  "fleet-coder": { changed_paths: [], suite_result: { command: "pytest", exit_code: 0 }, added_symbols: [], frozen_tests_red_at_start: true, obligations_done: [] },
  "fleet-code-judge": { verdict: "approve", routed_findings: [], suite_result: { command: "pytest", exit_code: 0 }, hash_check: { match: true, mismatched: [] }, gates_not_run: [], obligations_check: [] },
  "fleet-pr-opener": { pr_url: null, pr_number: null, created: true, template_used: null, gates_not_run_stated: true },
  "fleet-intent-judge": { verdict: "approve", deviations: [], coverage: { covered: true, missing: [] }, classification: { change_kind: "approve", new_behaviour: "approve", quote: "the task text" } },
  "pr-review": { verdict: "approve", findings: [], touches_gate: false, checked: [] },
  "gate-change-nonweakening-sweep": { verdict: "non_weakening", units: [], findings: [] },
  "fleet-ci-classifier": { checks: [] },
};

// The skill passes a fresh run_nonce on every invocation; scenario args that
// do not name one get the default (null means "no nonce" in a test).
export const NONCE = "n1-0000001";

// 5.0.0 (R2): a preflight stub with no ledger_tools reports every ledger read
// tool (a session with yadgar and yaadgaar); v5_adapters scripts the others.
export const LEDGER_TOOLS_ALL = ["mcp__yaadgaar__read_task", "mcp__yadgar__task_get"];
export function withNonce(args) {
  if (!args || typeof args !== "object" || !args.mode || "run_nonce" in args) return args;
  return Object.assign({}, args, { run_nonce: NONCE });
}

// 3.0.0 (ledger 1952): the relayed infra programs print a digest over these
// keys. Stubs that give none get the program's digest (a key absent counts as
// null, as in the script); branch-scan stubs written with message text are
// turned into the program's metadata entries first.
// 5.0.2 (ledger 2007): the keys every digest check reads, from the workflow's
// own PROGRAM_KEYS table: a harness copy drifted along with the script, which
// is how a prompt that named fewer keys than its digest stayed green.
export const PROGRAM_KEYS = (() => {
  const i = SOURCE.indexOf("\nconst PROGRAM_KEYS = {");
  if (i < 0) throw new Error("no PROGRAM_KEYS table in the workflow");
  return new Function("return " + SOURCE.slice(SOURCE.indexOf("{", i), SOURCE.indexOf("\n};\n", i) + 2))();
})();
export const K = (id) => {
  if (!PROGRAM_KEYS[id]) throw new Error("no PROGRAM_KEYS entry " + id);
  return PROGRAM_KEYS[id];
};
export const RELAY_KEYS = [
  [/^infra:fleet-scan:/, K("fleet_scan")],
  [/^infra:read-state$/, K("read_state")],
  [/^infra:review-paths:/, K("review_paths")],
  [/^infra:check-scripts/, K("script_check")],
  [/^infra:branch-scan$/, K("branch_scan")],
  [/^infra:format-(tests|code):/, K("format_files")],
  // 3.1.0 (ledger 1959)
  [/^infra:verify-plan$/, K("verify_since")],
  // 3.1.0 (ledger 1935c)
  [/^infra:push(:p\d+)?$/, K("push_classify")],
  [/^infra:hook-surface:/, K("hook_surface")],
];
// 3.1.0: the IaC push gate program's output, with its digest
// 5.0.2 (ledger 2004): the park program's output for a park-plan prompt
// (`over` replaces keys of the park object: {clean: false, dirty: [...]})
export function parkOut(prompt, over) {
  const i = inputsOf(prompt);
  const park = Object.assign({ target: i.scratch + "/parked/" + i.run + "/" + i.plan_path, clean: true, dirty: [], args: [i.worktree, i.plan_path, i.scratch, i.run] }, over);
  return { status: "ok", reason: "parked", park };
}
export function tfGateRelay(over) {
  const r = Object.assign({ status: "ok", reason: "scanned", touched: false, iac_files: [], problems: [], hints: [], args: ["/r/.claude/worktrees/fleet-l42-add-thing/main", "master", "0".repeat(40), "git@github.com:o/r.git"] }, over);
  r.digest = sha256(canon({ touched: r.touched, iac_files: r.iac_files, problems: r.problems, hints: r.hints, args: r.args }));
  return r;
}
// 3.1.1: a PATH re-check relay (the PATH check program's output plus status)
export function pathRecheckOut(tools, args) {
  const pc = {
    tools: Object.assign(Object.fromEntries(["terra" + "form", "to" + "fu", "t" + "fp", "terra" + "grunt", "dig" + "ger", "atlan" + "tis"].map((t) => [t, null])), tools || {}),
    args,
    path_problems: [],
    // 4.0.0: the shipped program's self-hash, inside the digest
    program: programOf("path_check"),
  };
  pc.digest = sha256(canon(pc));
  // the sha256sum line before it (outside the digest)
  pc.file_sha256 = programSha("path_check");
  return Object.assign({ status: "ok", reason: "checked" }, pc);
}
// 3.1.1: the origin URL program's output
export function remoteUrlOut(url, repo) {
  const o = { url: url === undefined ? null : url, args: [repo] };
  o.digest = sha256(canon(o));
  return o;
}
// 5.0.9 (ledger 2032): session_project.py's output (fillPrograms adds program and digest)
export function sessionProjectOut(project) {
  return { project, source: project ? "origin" : null, cwd: "/home/u/git/docs", args: [] };
}
// 5.0.8 (ledger 2030): gh_identity.py's output for its args. over: {<slug>:
// tried list} (default: gh with push, so gh-personal is never tried)
export const GH_DEFAULT_TRIED = [{ cmd: "gh", installed: true, push: true }];
export function ghPickOf(tried) {
  const t = tried.find((x) => x.push === true) || tried.find((x) => x.push === false);
  return { gh_cmd: t ? t.cmd : null, push: !!t && t.push === true };
}
export function ghIdOut(args, origin, over) {
  const slugs = [];
  for (const x of (args[0] !== "-" && origin ? [origin] : []).concat(args.slice(1))) if (slugs.indexOf(x) < 0) slugs.push(x);
  const repos = {};
  for (const x of slugs) {
    const tried = JSON.parse(JSON.stringify((over && over[x]) || GH_DEFAULT_TRIED));
    repos[x] = Object.assign(ghPickOf(tried), { tried });
  }
  const o = { origin: args[0] !== "-" ? origin || null : null, repos, args };
  o.digest = sha256(canon(o));
  return o;
}
export function relayDigestOf(r, keys) {
  const o = {};
  // 4.0.0 (1993): the programs' digest covers their self-hash
  if (r && r.program !== undefined) o.program = r.program;
  for (const k of keys) o[k] = r[k] === undefined ? null : r[k];
  return sha256(canon(o));
}
// One plan-ref entry as the branch-scan program prints it: no content; the
// program's own task_id, plan_path and ref_ok.
export function scanEntry(e) {
  if (!e || typeof e !== "object" || !("content" in e)) return e;
  const out = Object.assign({}, e);
  delete out.content;
  let r = null;
  try {
    r = typeof e.content === "string" ? JSON.parse(e.content) : null;
  } catch (err) {
    r = null;
  }
  const obj = r && typeof r === "object" && !Array.isArray(r) ? r : null;
  out.task_id = obj && typeof obj.task_id === "string" ? obj.task_id : null;
  out.plan_path = obj && typeof obj.plan_path === "string" ? obj.plan_path : null;
  let ok = !!obj && typeof e.content === "string" && sha256(e.content) === e.sha256 && typeof obj.seal === "string";
  if (ok) {
    const o = Object.assign({}, obj);
    delete o.seal;
    ok = obj.seal === sha256(canon(o)) && obj.branch === "fleet/" + obj.task_id + "-" + obj.slug;
  }
  out.ref_ok = ok;
  // the program hashes the bytes it read: a stub's mismatched sha256 is a broken ref
  return out;
}
// 3.1.0 review: the programs echo their arguments; a stub that gives none
// echoes what the prompt passed (the push stub: a temp file and its exit code).
export function fillArgs(label, r, prompt) {
  if (!r || typeof r !== "object" || r.status !== "ok" || "args" in r || "digest" in r) return r;
  if (/^infra:verify-plan$/.test(label)) {
    const i = inputsOf(prompt);
    r.args = [i.main_worktree, i.plan_base, i.plan_path];
  } else if (/^infra:hook-surface:/.test(label)) r.args = [inputsOf(prompt).worktree, inputsOf(prompt).rev, JSON.stringify(inputsOf(prompt).targets)];
  else if (/^infra:push(:p\d+)?$/.test(label) && r.push_result === "hook_rejected") r.args = ["/tmp/fleet-push.out", String(r.exit_code)];
  else if (/^infra:precommit-ids/.test(label)) r.args = [inputsOf(prompt).main_worktree, inputsOf(prompt).plan_commit];
  return r;
}
export function withRelayDigest(label, r) {
  if (!r || typeof r !== "object" || r.status !== "ok" || "digest" in r) return r;
  const hit = RELAY_KEYS.find(([re]) => re.test(label));
  if (!hit) return r;
  if (/^infra:branch-scan$/.test(label) && Array.isArray(r.refs)) r.refs = r.refs.map(scanEntry);
  r.digest = relayDigestOf(r, hit[1]);
  return r;
}

export async function runOne(script, args0) {
  const args = withNonce(args0);
  const calls = [];
  const unscripted = [];
  const logs = [];
  const counters = {};
  // before the freeze, the worktree holds what the first freeze will hash
  const f1 = script["hasher:freeze:f1"];
  let lastHashes = f1 && typeof f1 === "object" && !Array.isArray(f1) && f1.hashes ? f1.hashes : null;
  const fleetRefs = {};
  const rawResults = new WeakSet();
  // 4.0.0 (1993): every prompt runs shipped programs by path; none pastes one
  const agent = async (prompt, opts = {}) => {
    const label = opts.label;
    if (typeof prompt === "string" && (prompt.includes("python3 -I -c") || prompt.includes("<<'FLEET_") || prompt.includes("python3 -I - ")))
      throw new Error("AC-1993-1: prompt " + label + " pastes a program");
    // 5.0.7 (ledger 2020): an unscripted digest retry replays its step's script
    // (a broken relay stays broken: two mismatches stop as before);
    // 6.2.2 (2104): so does the preflight relay retry
    // (preflight:relay-retry; script.__mutate sees the real label)
    const base = label === "preflight:relay-retry" ? "preflight" : label.replace(/:(digest|args)-retry$/, "");
    const inner = base !== label && !(label in script) ? Object.assign({}, opts, { label: base, realLabel: label }) : opts;
    let r = await agentInner(prompt, inner);
    // 5.0.9 (ledger 2032): the session's yaadgaar project: script.__session_project, else args.project
    if (base === "preflight" && r && typeof r === "object" && !rawResults.has(r) && !("session_project" in r))
      r.session_project = sessionProjectOut("__session_project" in script ? script.__session_project : (args && args.project) || null);
    if (r && typeof r === "object" && !rawResults.has(r)) r = fillPrograms(base, r, prompt);
    const mut = script.__mutate;
    if (mut && r && typeof r === "object" && (mut.label instanceof RegExp ? mut.label.test(base) : mut.label === base)) r = mut.fn(r, prompt, label);
    return r;
  };
  const agentInner = async (prompt, opts = {}) => {
    const label = opts.label;
    calls.push({ label: opts.realLabel || label, prompt, opts });
    // 3.1.0: preflight returns the PATH check program's output (no IaC tool on PATH)
    if (label === "preflight" && script.preflight && typeof script.preflight === "object" && !("path_check" in script.preflight) && !script.preflight.__raw_path_check) {
      const pc = { tools: { ["terra" + "form"]: null, ["to" + "fu"]: null, ["t" + "fp"]: null, ["terra" + "grunt"]: null, ["dig" + "ger"]: null, ["atlan" + "tis"]: null }, args: [inputsOf(prompt).repo], path_problems: [] };
      pc.digest = sha256(canon(pc));
      return Object.assign({ ledger_tools: LEDGER_TOOLS_ALL.slice() }, JSON.parse(JSON.stringify(script.preflight)), { path_check: pc });
    }
    // 5.0.0 (review of d8df90b): an unscripted probe role-read reads the scenario's file
    if (!(label in script) && /^infra:role-read:/.test(label)) {
      const role = inputsOf(prompt).role;
      const r = { status: "ok", reason: "read", role_file: { name: role, sha256: roleTable[role] } };
      // PR #48 ruling 3: and the role's shared file
      if (SHARED_FOR_ROLE[role]) r.shared_file = { name: SHARED_FOR_ROLE[role], sha256: SHARED_PIN[SHARED_FOR_ROLE[role]] };
      return r;
    }
    // the bytecode purge is mechanical; unscripted purges succeed by default
    if (!(label in script) && /^infra:purge-bytecode:/.test(label)) return { status: "ok", reason: "purged", purged: 0 };
    // 4.0.0 (1986): unscripted parked-run reads find no parked draft
    if (!(label in script) && /^infra:load-parked$/.test(label)) {
      const i = inputsOf(prompt);
      return { status: "ok", reason: "read", parked: null, args: [i.scratch, i.plan_tip_time === null ? "null" : String(i.plan_tip_time)] };
    }
    // 4.0.0 (1985, S3): unscripted push-access probes find access (a new branch)
    if (!(label in script) && /^infra:push-probe$/.test(label))
      return { status: "ok", reason: "probed", access: "ok", result: "ok", exit_code: 0, auth_line: null, args: ["/tmp/fleet-probe.out", "0"] };
    // unscripted plan parks move the draft and leave the worktree clean
    if (!(label in script) && /^infra:park-plan/.test(label)) return parkOut(prompt);
    // unscripted plan formatting changes nothing (the hooks found nothing to fix)
    if (!(label in script) && /^infra:format-plan/.test(label)) return { status: "ok", reason: "formatted", changed_paths: [] };
    // unscripted fixer-hook runs change nothing (3.0.0)
    if (!(label in script) && /^infra:format-(tests|code):/.test(label)) {
      const sel = inputsOf(prompt).select;
      return withRelayDigest(label, { status: "ok", reason: "ran the fixers", note: "ran pre-commit run --files", ran: true, runs: 1, stable: true, files: sel.paths || [], changed: [], refused: [], purged: 0, purged_paths: [], frozen_changed: [], frozen_map: fmHandle(prompt), hook_failed: false, hook_failures: [], hook_head: "", hook_sha256: "", hook_timeout: [], fix_timeout: false, unknown_hooks: [] });
    }
    // 3.1.0: unscripted IaC pre-push gates find no IaC file in the PR diff
    if (!(label in script) && /^infra:tf-gate:/.test(label)) {
      const i = inputsOf(prompt);
      return tfGateRelay({ args: [i.main_worktree, i.default_branch, i.approved_sha, i.remote_url] });
    }
    // 3.1.0: unscripted remote-head reads find no remote branch
    if (!(label in script) && /^infra:remote-head:/.test(label)) {
      const i = inputsOf(prompt);
      const r = { status: "ok", reason: "read", head: null, args: [i.main_worktree, i.branch, i.remote_url] };
      r.digest = sha256(canon({ head: r.head, args: r.args }));
      return r;
    }
    // 3.1.1: unscripted PATH re-checks find no IaC tool on PATH
    if (!(label in script) && /^infra:path-check:/.test(label)) {
      const i = inputsOf(prompt);
      return pathRecheckOut({}, [i.repo, i.token]);
    }
    // 3.1.0: unscripted hook-surface reads find no hook entry file
    if (!(label in script) && /^infra:hook-surface:/.test(label))
      return withRelayDigest(label, fillArgs(label, { status: "ok", reason: "read", surface: [], make_paths: {}, error: null }, prompt));
    // 6.0.0 (ledger 2042): an unscripted convention read finds no convention (the conventional fallback)
    if (!(label in script) && /^infra:pr-convention:/.test(label))
      return { status: "ok", reason: "read", title: { style: "conventional", types: ["feat", "fix", "perf", "revert", "chore", "refactor", "docs", "style", "test", "build", "ci"], key_required: false }, body: { template: null, template_repo: null, required_sections: null, min_chars: null, checker: null }, source: ["title: no convention found; the fallback type(component): summary"], unreadable: [], args: inputsOf(prompt).args };
    // 6.0.0 (ledger 2033): an unscripted policy read finds no policy file
    if (!(label in script) && label === "infra:policy")
      return { status: "ok", reason: "read", profile: null, file: "/home/u/.config/fleet/policy.json", policy_sha256: null, caps: { pr_ready: true, ci_watch: true, ci_watch_minutes: 60, stats: true, merge: "never", update_branch: "never", ci_trigger: false, review_post: "none" }, matched: "no policy file", error: null, args: inputsOf(prompt).args };
    // 6.0.0 (ledger 2044): an unscripted stats edit writes the block (wall time 2m)
    if (!(label in script) && /^infra:pr-stats/.test(label)) {
      const a = inputsOf(prompt).args;
      const block = Buffer.from(a[3], "base64").toString("utf8").replace("@@WALL@@", "2m");
      return { status: "ok", reason: "written", replaced: false, wall_s: 120, block_sha256: sha256(block), body_sha256_before: "0".repeat(64), body_sha256_after: "1".repeat(64), headers_missing: [], error: null, args: a };
    }
    // 6.0.0 (ledger 2045): an unscripted ready step marks the draft ready at the approved sha
    if (!(label in script) && /^infra:pr-ready/.test(label)) {
      const a = inputsOf(prompt).args;
      return { status: "ok", reason: "ready", mode: "ready", was_draft: true, is_draft: false, head: a[4], state: "OPEN", error: null, args: a };
    }
    // 6.0.0 (ledger 2034): unscripted CI steps: no orchestrator or IaC sign, one green check, and the PR state changes succeed
    if (!(label in script) && /^infra:orch-scan/.test(label))
      return { status: "ok", reason: "scanned", orchestrator: false, iac_repo: false, apply_on_merge: false, hook_surface_pr: false, reasons: [], error: null, args: inputsOf(prompt).args };
    if (!(label in script) && /^infra:ci-watch:/.test(label)) {
      const a = inputsOf(prompt).args;
      return { status: "ok", reason: "watched", state: "green", checks: [{ name: "test", state: "SUCCESS", bucket: "pass", url: "https://github.com/o/r/actions/runs/11/job/12" }], failed: [], required: true, head: a[3], elapsed_s: 300, error: null, args: a };
    }
    if (!(label in script) && /^infra:pr-merge/.test(label)) {
      const a = inputsOf(prompt).args;
      return { status: "ok", reason: "merged", mode: "merge", merged: true, auto_enabled: false, method: "squash", merge_sha: "e".repeat(40), blocked: null, merge_state: "CLEAN", head: a[4], branch_deleted: true, error: null, args: a };
    }
    if (!(label in script) && /^infra:pr-update/.test(label)) {
      const a = inputsOf(prompt).args;
      return { status: "ok", reason: "updated", mode: "update", updated: true, head: "d".repeat(40), base: "c".repeat(40), overlap: [], error: null, args: a };
    }
    // review fixes: the log read finds the watched failures' tails; a resume finds the PR open; a fetch lands on the new head
    if (!(label in script) && /^infra:ci-logs:/.test(label)) {
      const a = inputsOf(prompt).args;
      return { status: "ok", reason: "read", mode: "logs", head: a[4], logs: [{ name: "test", url: "https://github.com/o/r/actions/runs/77/job/88", run_id: "77", excerpt: "FAILED tests/test_a.py::test_x", verified: true }], error: null, args: a };
    }
    if (!(label in script) && /^infra:pr-view/.test(label)) {
      const a = inputsOf(prompt).args;
      return { status: "ok", reason: "read", mode: "view", state: "OPEN", head: a[4], merge_sha: null, error: null, args: a };
    }
    if (!(label in script) && /^infra:pr-fetch/.test(label)) {
      const a = inputsOf(prompt).args;
      return { status: "ok", reason: "fetched", mode: "fetch", head: a[4], tree: "T".repeat(1), error: null, args: a };
    }
    if (!(label in script) && /^infra:ci-rerun/.test(label)) {
      const a = inputsOf(prompt).args;
      return { status: "ok", reason: "reran", mode: "rerun", rerun: JSON.parse(a[3]), error: null, args: a };
    }
    if (!(label in script) && /^infra:fleet-cleanup/.test(label))
      return { status: "ok", reason: "removed", mode: "cleanup", removed: true, deleted: true, error: null, args: inputsOf(prompt).args };
    // 6.0.0 (ledger 2041): unscripted ruleset reads find a repo with no ruleset and a user owner
    if (!(label in script) && /^infra:ruleset-surface:/.test(label))
      return { status: "ok", reason: "read", surface: [], sources: [], read: ["self-references in 0 local workflow file(s)", "rules/branches/main: 0 rule(s)", "owner o is not an organization: no org rulesets"], unreadable: [], error: null, args: inputsOf(prompt).args };
    // 3.1.0: unscripted ledger reads find a task with a body page
    // 2034.5: the CI follow-up write lands like the write-back
    if (!(label in script) && /^infra:ledger-writeback:ci$/.test(label)) return { status: "ok", reason: "ok", results: inputsOf(prompt).tasks.map((t) => ({ key: t.key, status: "written" })) };
    if (!(label in script) && /^infra:ledger-read:pre(:ci)?$/.test(label))
      return { status: "ok", reason: "read", results: inputsOf(prompt).tasks.map((t) => ({ key: t.key, status: "ok", title: "T" + t.id, body_slug: "o_r_task-" + t.id, has_marker: false })) };
    // 5.0.8 (ledger 2030): an unscripted gh check reads the scenario's answers
    if (!(label in script) && /^infra:gh-identity:/.test(label)) return Object.assign({ status: "ok", reason: "checked" }, ghIdOut(inputsOf(prompt).args, null, script.__gh));
    // 5.0.6 (ledger 2019): unscripted build-dir resets and the teardown succeed
    if (!(label in script) && /^infra:build-(reset:|clean$)/.test(label)) return buildDirOut(inputsOf(prompt).args);
    // 5.0.7 (ledger 2020): an unscripted comparison reads the registered maps
    if (!(label in script) && /^infra:hash-diff:/.test(label)) {
      const o = hashDiffOut(inputsOf(prompt).args);
      if (o.exit) return { status: "failed", reason: o.exit };
      return fillPrograms(label, Object.assign({ status: "ok", reason: "compared" }, o), prompt);
    }
    // unscripted build caller checks find no modified existing definition
    if (!(label in script) && /^infra:changed-defs:/.test(label)) return defsOut([]);
    // unscripted fleet-internal scans find no .fleet/ path in the PR diff
    // 6.1.0 D6 (2051): given a base tip, the program prints it (and its digest covers it)
    // 6.1.0 review B2: the relay returns exactly the keys the prompt lists (base only when listed)
    if (!(label in script) && /^infra:fleet-scan:/.test(label) && inputsOf(prompt).base) {
      const m = /It prints one JSON object \{([^}]*)\}/.exec(prompt);
      const listed = m ? m[1].split(", ") : [];
      return Object.assign({ status: "ok", reason: "scanned", diff: [], commits: [] }, listed.indexOf("base") >= 0 ? { base: inputsOf(prompt).base } : {});
    }
    if (!(label in script) && /^infra:fleet-scan:/.test(label)) return withRelayDigest(label, { status: "ok", reason: "scanned", diff: [], commits: [] });
    // run-state writes are mechanical too: the ref lands on the expected head
    if (!(label in script) && /^infra:state:/.test(label)) {
      fleetRefs["fleetref:" + inputsOf(prompt).state_ref] = "f".repeat(40);
      return { status: "ok", reason: "written", head: inputsOf(prompt).expected_head, state_sha: "f".repeat(40) };
    }
    // 4.0.0 (1981): an unscripted test database starts (podman stubbed out)
    if (!(label in script) && /^infra:db-up/.test(label)) {
      const i = inputsOf(prompt);
      const users = Object.fromEntries(i.dbs.map((d) => [d, sha256(d).slice(0, 32)]));
      const up = { name: i.name, port: 40000, dbs: i.dbs, users, expiry: i.mode === "up" ? { mechanism: "podman-timeout", expires: 1700000000 } : null, args: (i.mode === "up" ? ["up", i.name, i.image, String(i.ttl), i.nonce, JSON.stringify(i.dbs)] : ["add", i.name, JSON.stringify(i.dbs)]).concat(i.test_db_prefix ? [i.test_db_prefix] : []) };
      if (i.mode !== "up") up.port = null;
      return Object.assign({ status: "ok", reason: "up", up }, i.mode === "up" ? { sweep: { podman: true, removed: [], kept: [], errors: [] } } : {});
    }
    if (!(label in script) && /^infra:db-down$/.test(label)) {
      const i = inputsOf(prompt);
      return { status: "ok", reason: "removed", down: { removed: true, absent: false, error: null, args: [i.name, i.nonce] } };
    }
    // 4.0.0 (1987): unscripted freeze-ref writes land on the freeze tree
    if (!(label in script) && /^infra:freeze-ref:/.test(label)) {
      const i = inputsOf(prompt);
      fleetRefs["fleetref:" + i.ref] = i.tree;
      return { status: "ok", reason: "written", ref_target: i.tree };
    }
    // 4.0.0: unscripted verify steps read what the commit-plan stubs wrote
    if (!(label in script) && /^infra:verify-plan-commit/.test(label)) return verifyStub(script.__store || {})(prompt);
    // 4.0.0 (1983): every confirm mode gets up to 2 re-plan rounds; an
    // unscripted round step (":audit-fix", ":audit-fix-2") repeats the
    // round-0 stub, so a plan the stubs refuse is refused in every round
    const roundBase = (k) => {
      const rb = /^(.*?)(:audit-fix(?:-[0-9]+)?)$/.exec(k);
      return !(k in script) && rb && !script.__noRoundFallback && rb[1] in script ? rb[1] : k;
    };
    let key = roundBase(label);
    // 4.0.0 (1984): an unscripted drift retry repeats the role's answer for
    // that label (or its round-0 stub); script "<label>:retry" to differ
    if (!(key in script) && /^role:.+:retry$/.test(label)) key = roundBase(label.slice(0, -":retry".length));
    // 6.0.0 review S6: an unscripted step of the soft CI write-back (labels ending :ci) finds nothing
    if (!(key in script) && /^infra:[a-z-]+(:[a-z]+)*:ci$/.test(label)) return null;
    if (!(key in script)) {
      unscripted.push(label);
      return null;
    }
    let r = script[key];
    if (Array.isArray(r)) {
      const i = counters[key] || 0;
      counters[key] = i + 1;
      r = r[Math.min(i, r.length - 1)];
    }
    if (typeof r === "function") r = r(prompt, opts);
    if (r === undefined || r === null) return null;
    r = JSON.parse(JSON.stringify(r));
    const raw = r.__raw === true;
    delete r.__raw;
    if (raw) rawResults.add(r);
    // 5.0.0 (R2): a preflight stub with its own path_check still gets the full census
    if (label === "preflight" && !raw && !("ledger_tools" in r)) r.ledger_tools = LEDGER_TOOLS_ALL.slice();
    // 5.0.7 (ledger 2020): format_files lists the changed paths that are
    // frozen (a JSON list, or "@<files map>" read from the registry)
    if (/^infra:format-(tests|code):/.test(label) && !raw && r && r.status === "ok" && Array.isArray(r.changed)) {
      // a stub digest over the 5.0.6 keys, or the 6.2.1 keys, covers the newer keys too
      const HOOK_KEYS = ["hook_failed", "hook_failures", "hook_head", "hook_sha256", "hook_timeout", "fix_timeout", "unknown_hooks"];
      const k621 = K("format_files").filter((k) => HOOK_KEYS.indexOf(k) < 0);
      const k6 = k621.filter((k) => k !== "frozen_changed" && k !== "frozen_map");
      const legacy = typeof r.digest === "string" && (r.digest === sha256(canon(pick(r, k6))) || r.digest === sha256(canon(pick(r, k621))));
      if (!("frozen_changed" in r)) {
        const fz = inputsOf(prompt).frozen;
        const file = typeof fz === "string" && fz.startsWith("@") ? byHandle(inputsOf(prompt).scratch_dir, "files", fz.slice(1)) : null;
        const keys = file ? Object.keys(MAP_REG.get(file)) : Array.isArray(fz) ? fz : [];
        r.frozen_changed = r.changed.filter((x) => keys.indexOf(x) >= 0).sort();
        r.frozen_map = file ? file.slice(-69, -5) : null;
      }
      // 6.2.2 (2107): a stub with no hook status passed every hook
      if (!("hook_failed" in r)) r.hook_failed = false;
      for (const [k, v] of [["hook_failures", []], ["hook_head", ""], ["hook_sha256", ""], ["hook_timeout", []], ["fix_timeout", false]]) if (!(k in r)) r[k] = v;
      if (!("unknown_hooks" in r)) r.unknown_hooks = [];
      if (legacy) r.digest = sha256(canon(pick(r, K("format_files"))));
    }
    if (!raw) withRelayDigest(label, fillArgs(label, r, prompt));
    // 3.1.1: the workspace step relays the origin URL program's output; a stub
    // that gives only remote_url gets that program's output for it
    if (label === "workspace" && !raw && r.status === "ok" && !("remote_url_check" in r)) r.remote_url_check = remoteUrlOut(r.remote_url, inputsOf(prompt).repo);
    // 5.0.8 (ledger 2030): a stub with no gh_check gets the program's output
    // for the args the prompt sent (script.__gh: {<slug>: tried list})
    if (label === "workspace" && !raw && r.status === "ok" && !("gh_check" in r)) r.gh_check = ghIdOut(inputsOf(prompt).gh_args, r.remote_slug, script.__gh);
    // hasher stubs that give only a fingerprint carry the maps of the last
    // hasher result forward (nothing changed; the judge fingerprint compares
    // the maps too) and list no changed paths
    if (label.startsWith("hasher:") && !raw && r.status === "ok") {
      if (!("hashes" in r)) r.hashes = JSON.parse(JSON.stringify(lastHashes || DEFAULT_HASHES));
      if (!("changed" in r)) r.changed = [];
      // the real hasher sees the run-state refs the workflow's own state writes made
      // (5.0.7: in a summarised git map, its inline entries)
      const g = r.hashes.git && isSummary(r.hashes.git) ? r.hashes.git.inline || (r.hashes.git.inline = {}) : r.hashes.git || (r.hashes.git = {});
      if (!Object.keys(g).some((k) => k.startsWith("fleetref:"))) Object.assign(g, fleetRefs);
      // 4.0.0 (1987): a scripted freeze ref is in the repo from then on
      else for (const k of Object.keys(g)) if (/^fleetref:refs\/fleet\/[^/]+\/freeze$/.test(k) && !(k in fleetRefs)) fleetRefs[k] = g[k];
      // a stub that models other refs only still sees the freeze ref
      for (const [k, v] of Object.entries(fleetRefs)) if (/\/freeze$/.test(k) && !(k in g)) g[k] = v;
      // 5.0.7 (ledger 2020): a stub's maps travel as their summaries (the
      // maps are registered by file, as the program writes them)
      lastHashes = JSON.parse(JSON.stringify(r.hashes));
      r.hashes = summarizeHashes(r.hashes, inputsOf(prompt).scratch_dir);
      // the program's digest over what it printed (2.1.5)
      if (!("digest" in r)) {
        const o = { fingerprint: r.fingerprint, hashes: r.hashes };
        if (inputsOf(prompt).base_tree) o.changed = r.changed;
        r.digest = sha256(canon(o));
      }
    }
    // 4.0.0 (1981): a read step's stub with no test_db finds no declaration
    if (/^infra:(branch-scan|verify-plan)$/.test(label) && !raw && r.status === "ok" && !("test_db" in r)) {
      const i = inputsOf(prompt);
      r.test_db = { decl: null, error: null, args: [i.main_worktree, i.default_branch] };
    }
    // a run-state write moves its ref
    if (label.startsWith("infra:state:") && !raw && r.status === "ok" && typeof r.state_sha === "string")
      fleetRefs["fleetref:" + inputsOf(prompt).state_ref] = r.state_sha;
    // a terse writer stub reports exactly its criterion's test files
    if (label.startsWith("role:fleet-test-writer:") && !raw && r.status === "ok" && !("files" in r))
      r.files = inputsOf(prompt).test_files;
    // 6.0.0 (ledger 2042): a PR opener stub reports the title it was given
    if (label.startsWith("role:fleet-pr-opener") && !raw && r.status === "ok" && !("title" in r)) r.title = inputsOf(prompt).title;
    // 5.0.0 (R1): a role agent reports the role file it read (raw stubs too,
    // unless they name role_file themselves)
    if (label.startsWith("role:") && !("role_file" in r)) {
      const role = label.split(":")[1];
      r.role_file = { name: role, sha256: roleTable[role] };
    }
    // 5.0.0 (R3): the planner and the audit report the shared file they read
    if (label.startsWith("role:") && !("shared_file" in r)) {
      const name = SHARED_FOR_ROLE[label.split(":")[1]];
      if (name) r.shared_file = { name, sha256: SHARED_PIN[name] };
    }
    if (label.startsWith("role:") && !raw) {
      const role = label.split(":")[1];
      if (r.status === "ok")
        for (const [k, v] of Object.entries(REQUIRED_DEFAULTS[role] || {})) if (!(k in r)) r[k] = v;
    }
    return r;
  };
  const parallel = async (thunks) =>
    Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)));
  const pipeline = async (items, ...stages) =>
    Promise.all(
      items.map(async (item, idx) => {
        let prev = item;
        try {
          for (const s of stages) prev = await s(prev, item, idx);
          return prev;
        } catch {
          return null;
        }
      }),
    );
  // script.__source: a fault-injected script text, for a halt no stub can reach
  // 5.0.0: a scenario's changed role texts are pinned in a copy of the source
  const roleText = scenarioRoles(script);
  const roleTable = Object.fromEntries(ROLE_NAMES.map((r) => [r, sha256(roleText[r])]));
  let src = script.__source || SOURCE;
  if (ROLE_NAMES.some((r) => roleText[r] !== ROLE_TEXT[r])) {
    const disp = Object.fromEntries(ROLE_NAMES.map((r) => [r, (/^DISPATCH:.*$/m.exec(roleText[r]) || [null])[0]]));
    src = GEN.withDispatchTable(GEN.withRoleTable(src, roleTable), disp);
  }
  CUR_ROLES.table = roleTable;
  const fn = compile(src);
  // a crashed run rethrows; its logs travel on the error (2.1.6)
  const crashed = (e) => {
    if (e && typeof e === "object") e.__logs = logs;
    throw e;
  };
  const result = await fn(
    agent,
    parallel,
    pipeline,
    () => {},
    (m) => logs.push(m),
    args,
    // 6.0.0 (ledger 2044): script.__budget, a budget whose spent() a test drives
    script.__budget || { total: null, spent: () => 0, remaining: () => Infinity },
    async () => {
      throw new Error("nested workflow not expected");
    },
    ThrowingDate,
    SafeMath,
  ).catch(crashed);
  return { result, calls, unscripted, logs, labels: calls.map((c) => c.label) };
}

// Plan mode, then (when it returns awaiting_confirmation) build mode with the
// returned plan_ref, as the skill does after Max confirms. The merged view
// holds both runs' calls; .plan and .build hold each run alone.
export async function run(script, args, buildOver) {
  const plan = await runOne(script, args);
  if (!plan.result || plan.result.status !== "awaiting_confirmation" || !args || typeof args !== "object" || args.mode !== "plan")
    return Object.assign({}, plan, { plan, build: null });
  const bargs = Object.assign({}, args, { mode: "build", plan_ref: plan.result.plan_ref }, buildOver || {});
  delete bargs.input;
  const build = await runOne(script, bargs);
  return {
    result: build.result,
    planResult: plan.result,
    calls: plan.calls.concat(build.calls),
    unscripted: plan.unscripted.concat(build.unscripted),
    logs: plan.logs.concat(build.logs),
    labels: plan.labels.concat(build.labels),
    plan,
    build,
  };
}

export function call(out, label) {
  const c = out.calls.find((x) => x.label === label);
  assert.ok(c, "expected a call labelled " + label + "; got " + out.labels.join(", "));
  return c;
}

export function noUnscripted(out) {
  assert.deepEqual(out.unscripted, [], "unscripted agent labels");
}

export const ARGS = {
  mode: "plan",
  input: "L42",
  repo: "/r",
  project: "o/r",
  date: "2026-11-04",
  run_nonce: NONCE,
};
export const PC ="abc1234def0";
// 6.0.0 (ledger 2042): the branch commit the dangling plan commit PC sits on
export const PB = "b0de1234567";
// the plan doc's own blob id, as verify resolves it with replacement objects off
export const PBLOB = "b10b".repeat(10);
export const PSHA = "a".repeat(64);
export const BRIEF = {
  title: "Add Thing!",
  description: "add a thing",
  sources: [{ kind: "ledger", ref: "42", url: null, body: "task body" }],
  repo: "/r",
  plan_path: null,
};
// Fingerprints are {head, tree}. Writers and the coder never commit, so the
// head stays at the plan commit until the commit step; only the tree moves.
// FP_PRE: the plan commit before the writers; FP_PLAN (= FP_TESTS): the
// worktree holding the approved tests.
export const FP_PRE = { head: PB, tree: "T0" };
export const FP_TESTS = { head: PB, tree: "T1" };
export const FP_PLAN = FP_TESTS;
export const FP_K1 = { head: PB, tree: "K1" };
export const FP_K2 = { head: PB, tree: "K2" };
export const FP_M3 = { head: PB, tree: "M3" };
// the commit step's head for code round m
export const CSHA = (m) => "c00000" + m;
// Hasher output is four maps plus a suspicious list. Fixtures are written as
// flat prefixed keys and converted: "git:<k>" -> git, "symlink:<k>" ->
// symlinks, a key with "#" -> sections, anything else -> files.
// 5.0.5 (ledger 2018): the hasher relays a summary of the ignored map and
// writes the map to <scratch>/hashes/ignored-<sha256 of the file>.json.
// 5.0.7 (ledger 2020): every map, as <map>-<sha256>.json. A stub may still
// give the maps: the harness relays their summaries, as the program would, and
// keeps each map by file path for the hash-diff stub.
export const SETTINGS_LOCAL = ".claude/settings.local.json";
export const HASH_MAP_NAMES = ["files", "sections", "git", "symlinks", "ignored"];
const MAP_REG = new Map();
export function registerMap(file, map) {
  MAP_REG.set(file, map);
}
// 5.0.7: a role input's frozen map m, read from its file (as a role reads it)
export function frozenMap(inputs, m) {
  const f = inputs && inputs.frozen_config_sections && inputs.frozen_config_sections[m];
  return f ? MAP_REG.get(f) : undefined;
}
export function registerIgnored(summary, map) {
  registerMap(summary.file, map);
}
const isSummary = (ig) => !!ig && typeof ig === "object" && typeof ig.count === "number";
export function ignoredSummary(map, scratch) {
  const rest = Object.fromEntries(Object.entries(map).filter(([k]) => k !== SETTINGS_LOCAL));
  const s = {
    count: Object.keys(rest).length,
    sha256: sha256(canon(rest)),
    settings: SETTINGS_LOCAL in map ? map[SETTINGS_LOCAL] : null,
    file: scratch + "/hashes/ignored-" + sha256(canon(map)) + ".json",
  };
  registerMap(s.file, map);
  return s;
}
const INLINE_GIT = (k) => k === "core.hooksPath" || k.startsWith("fleetref:");
export function mapSummary(m, map, scratch) {
  if (m === "ignored") return ignoredSummary(map, scratch);
  const body = m === "git" ? Object.fromEntries(Object.entries(map).filter(([k]) => !INLINE_GIT(k))) : map;
  const s = { count: Object.keys(body).length, sha256: sha256(canon(body)), file: scratch + "/hashes/" + m + "-" + sha256(canon(body)) + ".json" };
  if (m === "git") s.inline = Object.fromEntries(Object.entries(map).filter(([k]) => INLINE_GIT(k)));
  registerMap(s.file, body);
  return s;
}
export function summarizeHashes(h, scratch) {
  const o = Object.assign({}, h);
  for (const m of HASH_MAP_NAMES) if (h[m] && typeof h[m] === "object" && !isSummary(h[m])) o[m] = mapSummary(m, h[m], scratch);
  return o;
}
// the script's view of a map: the summary as one key "*" ("<sha256>/<count>")
// plus the inline keys (ignored: the settings file; git: hooks path, refs)
export function mapView(m, map) {
  if (m === "ignored") return ignoredView(map);
  const body = Object.fromEntries(Object.entries(map || {}).filter(([k]) => !(m === "git" && INLINE_GIT(k))));
  const v = { "*": sha256(canon(body)) + "/" + Object.keys(body).length };
  if (m === "git") for (const [k, x] of Object.entries(map || {})) if (INLINE_GIT(k)) v[k] = x;
  return v;
}
export function ignoredView(map) {
  const rest = Object.fromEntries(Object.entries(map || {}).filter(([k]) => k !== SETTINGS_LOCAL));
  const v = { "*": sha256(canon(rest)) + "/" + Object.keys(rest).length };
  if (map && SETTINGS_LOCAL in map) v[SETTINGS_LOCAL] = map[SETTINGS_LOCAL];
  return v;
}
// the full sha of a format prompt's frozen map handle (null: a path list)
function fmHandle(prompt) {
  const fz = inputsOf(prompt).frozen;
  const f = typeof fz === "string" && fz.startsWith("@") ? byHandle(inputsOf(prompt).scratch_dir, "files", fz.slice(1)) : null;
  return f ? f.slice(-69, -5) : null;
}
// the registered map file of <scratch>/hashes/<map>-<12-hex handle>*.json
function byHandle(scratch, m, pre) {
  const hits = [...MAP_REG.keys()].filter((f) => f.startsWith(scratch + "/hashes/" + m + "-" + pre) && /-[0-9a-f]{64}\.json$/.test(f));
  return hits.length === 1 ? hits[0] : null;
}
// the hash-diff program over registered maps (its output, unrelayed); 5.0.7
// review: args <scratch> (<map> <old handle> <new handle>)+
export function hashDiffOut(args) {
  const out = { changed: [], total: null, counts: {}, resolved: {}, error: null, args: args.slice() };
  const rows = [];
  for (let i = 1; i < args.length; i += 3) {
    const [m, pa, pb] = args.slice(i, i + 3);
    const fa = byHandle(args[0], m, pa);
    const fb = byHandle(args[0], m, pb);
    // the program exits non-zero on a handle that names no file, or two
    if (!fa || !fb) return { exit: "0 files match " + m + "-" + (fa ? pb : pa) + "*.json in " + args[0] + "/hashes: need exactly one, so a missing state never reads as no change" };
    out.resolved[m] = [fa.slice(-69, -5), fb.slice(-69, -5)];
    const drop = (x) => Object.fromEntries(Object.entries(x).filter(([k]) => !(m === "ignored" && k === SETTINGS_LOCAL)));
    const a = drop(MAP_REG.get(fa));
    const b = drop(MAP_REG.get(fb));
    out.counts[m] = [Object.keys(a).length, Object.keys(b).length];
    for (const k of [...new Set(Object.keys(a).concat(Object.keys(b)))].sort())
      if (a[k] !== b[k]) rows.push([m, k, !(k in a) ? "added" : !(k in b) ? "removed" : "changed"]);
  }
  return Object.assign(out, { changed: rows.slice(0, 50), total: rows.length });
}
// 5.0.6 (ledger 2019): the build vars a role gets, one row per tool (kept
// here apart from the workflow's BUILD_ENV_ROWS, so a drift there fails)
export const BUILD_ROWS = [
  ["CARGO_TARGET_DIR", "cargo-target"],
  ["PYTHONPYCACHEPREFIX", "pycache"],
  ["MYPY_CACHE_DIR", "mypy-cache"],
  ["RUFF_CACHE_DIR", "ruff-cache"],
  ["COVERAGE_FILE", "coverage"],
  ["TURBO_CACHE_DIR", "turbo-cache"],
];
// the happy run's scratch dir (repo /r, task l42-add-thing)
export const BUILD_SCRATCH = "/r/.claude/worktrees/fleet-l42-add-thing/scratch";
export function buildEnvOf(key, scratch = BUILD_SCRATCH, nonce = NONCE) {
  return Object.fromEntries(BUILD_ROWS.map(([k, sub]) => [k, scratch + "/build/" + nonce + "/" + key + "/" + sub]));
}
// the build vars as the shell assignments of a prefix (K='v' K='v'), as a
// regex source
export function buildAssignsRe(key) {
  return Object.entries(buildEnvOf(key)).map(([k, v]) => (k + "='" + v + "'").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join(" ");
}
export const TEST_ENV0 = { PYTHONDONTWRITEBYTECODE: "1", PYTEST_ADDOPTS: "-p no:cacheprovider" };
// a role's test_env: TEST_ENV, its build vars, then any DSN
export function roleTestEnv(key, extra) {
  return Object.assign({}, TEST_ENV0, buildEnvOf(key), extra || {});
}
// the calls result.agents counts: the build-dir teardown runs after the
// result is made (in main's finally, as the database teardown does)
export function countedCalls(calls) {
  return calls.filter((c) => c.label !== "infra:build-clean");
}
// 5.0.6 (ledger 2019): the emit-site check (v506_build_env and the
// multi-round, auto and database scenarios run it).
// The steps that run commands in the worktree without the build vars, and why.
const EXEMPT = {
  // plan mode: probes run in a scratch worktree, never in the worktree itself, before the build's first hasher
  "role:scope-and-plan": "plan mode",
  "role:plan-audit": "plan mode",
  // plan mode, before the build's first hasher: its output is part of the baseline
  "infra:format-plan": "plan mode",
};
const HOOKS_IN_WORKTREE = /^infra:(commit:r\d+|push(:p\d+)?)$/;
const FORMAT_IN_SCRATCH = /^infra:format-(tests|code):/;

export function prefixOf(env) {
  return "env " + Object.entries(env).map(([k, v]) => k + "='" + String(v).replace(/'/g, "'\\''") + "'").join(" ") + " ";
}

// Every prompt that carries a test command, a test_env or runs the repo's
// hooks in the worktree carries the exact prefix of a dir that a reset
// emptied after the previous role and before it. A new site without it fails.
export function buildEnvSites(out) {
  const keysSeen = new Map();
  let lastReset = null;
  let checked = 0;
  for (const c of out.calls) {
    if (/^infra:build-reset:/.test(c.label)) {
      lastReset = inputsOf(c.prompt).args.slice(3);
      continue;
    }
    if (FORMAT_IN_SCRATCH.test(c.label)) {
      // the fixer program runs pre-commit in a scratch checkout under scratch_dir
      assert.match(c.prompt, /format_files\.py/, c.label);
      continue;
    }
    if (!/^(role:|infra:)/.test(c.label) || /:fallback$|:retry$/.test(c.label)) continue;
    const base = c.label.replace(/:replan$/, "");
    let i = null;
    try {
      i = inputsOf(c.prompt);
    } catch (e) {
      continue;
    }
    const runsTests = i && ("test_cmd" in i || "test_env" in i);
    const runsHooks = HOOKS_IN_WORKTREE.test(c.label);
    if (!runsTests && !runsHooks) continue;
    if (base in EXEMPT || /^infra:format-plan/.test(base)) {
      assert.ok(!("test_env_prefix" in i), c.label + " is exempt and gets no prefix");
      continue;
    }
    if (c.label.startsWith("role:fleet-pr-opener")) continue;
    const env = runsHooks ? i.hook_env : i.test_env;
    assert.ok(env && typeof env === "object", c.label + " has its env");
    const m = /\/build\/[^/]+\/([^/]+)\/cargo-target$/.exec(env.CARGO_TARGET_DIR || "");
    assert.ok(m, c.label + ": no build dir in " + JSON.stringify(env));
    const key = m[1];
    assert.deepEqual(Object.fromEntries(Object.entries(env).filter(([k]) => BUILD_ROWS.some((r) => r[0] === k))), buildEnvOf(key, i.scratch_dir || BUILD_SCRATCH), c.label);
    if (runsHooks) assert.ok(c.prompt.includes(prefixOf(env).slice(4)), c.label + " runs its hooks with the prefix");
    else {
      assert.equal(i.test_env_prefix, prefixOf(env), c.label);
      assert.match(i.test_env_note, /test_env_prefix/, c.label);
    }
    assert.ok(lastReset && lastReset.includes(key), c.label + ": no reset of " + key + " right before it");
    if (!runsHooks || !keysSeen.has(key)) {
      assert.ok(!keysSeen.has(key) || keysSeen.get(key) === base, c.label + " shares " + key + " with " + keysSeen.get(key));
      keysSeen.set(key, base);
    }
    checked++;
  }
  return checked;
}

// 5.0.6 (ledger 2019): build_dir.py's output for its args, as a stub relays it
export function buildDirOut(args) {
  const r = { status: "ok", reason: args[0] === "reset" ? "reset" : "cleaned", args: args.slice() };
  if (args[0] === "reset") r.dirs = args.slice(3).map((k) => args[1] + "/build/" + args[2] + "/" + k);
  else Object.assign(r, { removed: true, bytes: 0 });
  return r;
}
export function H(flat, suspicious) {
  const h = { files: {}, sections: {}, git: {}, symlinks: {}, ignored: {}, suspicious: suspicious || [] };
  for (const [k, v] of Object.entries(flat)) {
    if (k.startsWith("git:")) h.git[k.slice(4)] = v;
    else if (k.startsWith("symlink:")) h.symlinks[k.slice(8)] = v;
    else if (k.includes("#")) h.sections[k] = v;
    else h.files[k] = v;
  }
  return h;
}
export const HASHES_FLAT = {
  "tests/test_a.py": "ha",
  "tests/test_b.py": "hb",
  "pyproject.toml#tool.pytest": "hp",
};
export const HASHES = H(HASHES_FLAT);
export const DEFAULT_HASHES = HASHES;
export const CONFIG_ONLY = H({ "pyproject.toml#tool.pytest": "hp" });

export function criteria(n = 2) {
  return Array.from({ length: n }, (_, i) => ({
    id: "AC" + (i + 1),
    text: "behaviour " + (i + 1),
    test_files: ["tests/test_" + String.fromCharCode(97 + i) + ".py"],
  }));
}

export const sha256 = (t) => createHash("sha256").update(t, "utf8").digest("hex");

// The sealed ref the commit-plan prompt writes as the tag message (heredoc
// body + newline).
// 4.0.0 (1993): the message a chunk-writer prompt carries as base64 chunks
// ("chunk <i> sha256 <hex>:" then the text), decoded; null when it has none.
export function chunkedContentOf(prompt) {
  const parts = [...String(prompt).matchAll(/^chunk (\d+) sha256 ([0-9a-f]{64}):\n([A-Za-z0-9+/=]*)$/gm)];
  if (!parts.length) return null;
  parts.forEach((m, i) => assert.equal(Number(m[1]), i, "chunks in order"));
  return Buffer.from(parts.map((m) => m[3]).join(""), "base64").toString("utf8");
}
export function refContentOf(prompt) {
  return chunkedContentOf(prompt);
}

// One entry of the plan-ref reader's output, as the real program prints it.
export function refEntry(name, target, content) {
  return { name, tag_sha: "7".repeat(40), type: "tag", target, target_type: "commit", sha256: sha256(content), content };
}

// The plan refs of task l42 in the store: refs/fleet/l42/plan targets
// store.__planHead (PC when unset; null means no ref), and every earlier
// plan ref is kept as refs/fleet/l42/plan-<n>. store[<commit>] is the tag
// message whose target is that commit.
export function planRefsOf(store, taskId) {
  const out = [];
  const t = taskId || store.__task || "l42";
  const head = "__planHead" in store ? store.__planHead : PC;
  if (head && store[head] !== undefined) out.push(refEntry("refs/fleet/" + t + "/plan", head, store[head]));
  (store.__archived || []).forEach((h, i) => out.push(refEntry("refs/fleet/" + t + "/plan-" + (i + 1), h, store[h])));
  return out;
}

// commit-plan stub: the commit holds only plan_path; the sealed ref becomes
// the tag message at refs/fleet/l42/plan (an earlier one is archived).
export function commitStub(store, head, planSha) {
  return (prompt) => {
    const c = refContentOf(prompt);
    if (c == null) return { status: "failed", reason: "no ref content in the prompt" };
    const prev = "__planHead" in store ? store.__planHead : null;
    if (prev && prev !== head) (store.__archived || (store.__archived = [])).push(prev);
    store[head] = c;
    store.__planHead = head;
    store.__task = inputsOf(prompt).task_id;
    // 4.0.0: what the verify step reads back (6.0.0: the plan commit is off the branch, on plan_base)
    const i = inputsOf(prompt);
    // a re-plan worktree (no branch) sits on the plan commit it replaces
    store.__commit = { head, planSha, planPath: i.plan_path, worktree: i.worktree, base: i.plan_base, wtHead: i.branch ? i.plan_base : prev };
    const plan_file = i.worktree.replace(/\/+[^/]+\/*$/, "") + "/plan/" + i.plan_path;
    return { status: "ok", reason: "committed", plan_commit: head, plan_base: i.plan_base, tag_sha: "7".repeat(40), reused: false, plan_file, dirty: [] };
  };
}

// 4.0.0 (1993): the read-only verify step after commit-plan: the three
// programs' outputs over the store the commit stub wrote.
export function verifyStub(store) {
  return (prompt) => {
    const i = inputsOf(prompt);
    const c = store.__commit || {};
    const refs = planRefsOf(store, i.task_id).map((e) => {
      const o = { ...e };
      delete o.content;
      return o;
    });
    return {
      status: "ok",
      reason: "verified",
      plan_files: { head: c.wtHead || c.base || null, commit: c.head || null, parent: c.base || null, files: [i.plan_path], args: [i.worktree, i.plan_commit], dsn_paths: [] },
      plan_hash: { plan_sha256: c.planSha || null, blob: PBLOB },
      plan_ref: { refs },
    };
  };
}

// ---------------------------------------------------------------- 4.0.0 (1993): shipped programs
//
// The programs ship as files under plugins/fleet/scripts/; the harness gives
// each stubbed program output the self-hash the shipped file prints, so the
// script's own check (its PROGRAM_SHA256 table entry, 4.0.1) meets the file's. A stub that
// names a program, or a __raw stub, is left alone.
export const SCRIPTS_SRC = join(HERE, "..", "scripts");
export const SCRIPTS_DIR = "/home/u/.claude/plugins/cache/mkt/fleet/6.2.2/scripts";
const GEN = await import(join(SCRIPTS_SRC, "gen.mjs"));
// [[program name, sha256 the workflow's PROGRAM_SHA256 table holds]] (4.0.1)
export const PROGRAMS = Object.entries(GEN.programs(SOURCE));
// 5.0.0 (R3): the shared prompt files (roles/_shared/<name>.md) and the roles that read them
export const SHARED_PIN = GEN.shared(SOURCE);
export const SHARED_FOR_ROLE = { "scope-and-plan": "test-cmd-allowlist", "plan-audit": "test-cmd-allowlist" };
export function programTableSha(name) {
  const hit = PROGRAMS.find(([n]) => n === name);
  assert.ok(hit, name);
  return hit[1];
}
// the text of the shipped program scripts/<name>.py, without its final newline
// (4.0.1: the files are the source; the workflow embeds no program text)
export function programText(name) {
  const body = readFileSync(join(SCRIPTS_SRC, name + ".py"), "utf8");
  assert.ok(body.endsWith("\n"), name + ".py ends with a newline");
  return body.slice(0, -1);
}
// the program as the 4.0.0 marker extraction returned it: no leading newline
function programBody(name) {
  return programText(name).replace(/^\n/, "");
}
// [[the 4.0.0 constant name, program body]] of every shipped program, and
// their text one after another: what tests searched the workflow source for
// before 4.0.1 moved the programs out of it
export const PROGRAM_BODIES = PROGRAMS.map(([n]) => [n.toUpperCase() + "_PY", programBody(n)]);
export const PROGRAMS_TEXT = PROGRAM_BODIES.map(([, b]) => b).join("\n");
// the sha256 of the shipped FILE (not of the table entry): the cross-check
export function programSha(name) {
  return sha256(readFileSync(join(SCRIPTS_SRC, name + ".py"), "utf8"));
}
// A shell-quoted word.
export function shq(v) {
  return "'" + String(v).replace(/'/g, "'\\''") + "'";
}
// 4.0.0: the shell command a test runs to write a sealed plan ref (or a run
// state) for real, through the shipped chunk writer, as the agents do (chunks
// in <dirname(wt)>/scratch). It prints `<head> <tag object>` like the 3.x command.
let refWrites = 0;
function chunkWriteCmd(program, wt, target, json, outKey, extra = [], headKey = "head") {
  const msg = json + "\n";
  const b64 = Buffer.from(msg, "utf8").toString("base64");
  const dir = join(dirname(wt), "scratch", "chunks-test-" + process.pid + "-" + ++refWrites);
  const chunks = [];
  for (let i = 0; i < b64.length; i += 4000) chunks.push(b64.slice(i, i + 4000));
  const shas = chunks.map((c, i) => ({ i, sha256: sha256(c) }));
  return (
    "set -o pipefail; mkdir -p " + shq(dir) + " && " +
    chunks.map((c, i) => "printf '%s' " + shq(c) + " > " + shq(dir + "/" + i + ".b64")).join(" && ") +
    " && python3 -I " + [join(SCRIPTS_SRC, program + ".py"), wt, target].map(shq).concat(extra, [dir, String(chunks.length), sha256(msg), JSON.stringify(shas)].map(shq)).join(" ") +
    " | python3 -I -c 'import json, sys; o = json.load(sys.stdin); print(o[\"" + headKey + "\"], o[\"" + outKey + "\"])'"
  );
}
// 6.0.0 (ledger 2042): the program seals <plan_path> (written when absent) as a plan
// commit on HEAD, off the branch; it prints the plan commit and the tag object
export function planRefWriteCmd(wt, taskId, json, planPath = "docs/plans/x.md") {
  const f = join(wt, planPath);
  return (
    "mkdir -p " + shq(dirname(f)) + " && { [ -f " + shq(f) + " ] || printf '# plan\\n' > " + shq(f) + "; } && base=$(git -C " + shq(wt) + " rev-parse HEAD) && " +
    chunkWriteCmd("plan_ref_write", wt, taskId, json, "tag_sha", ['"$base"', shq(planPath)], "plan_commit")
  );
}
export function stateWriteCmd(wt, stateRef, json) {
  return chunkWriteCmd("state_write", wt, stateRef, json, "state_sha");
}
export function programOf(name) {
  return { name, sha256: programSha(name) };
}
// 4.0.0 security review: the preflight probe's output lines for a scripts dir.
// over: {home, hits: [{hit, real, symlink, roles_real, roles_symlink}],
// sums: {name: sha|undefined}, roleSums: {file name: sha|undefined}, extra: [lines]}
// 5.0.0 (R1): each hit's sibling roles dir and the sha256sum of its files
// (the scenario's ROLE_SHA256 inside runOne, the shipped files otherwise).
export const CUR_ROLES = { table: null };
export function roleFileSums() {
  const t = CUR_ROLES.table || Object.fromEntries(ROLE_NAMES.map((r) => [r, sha256(ROLE_TEXT[r])]));
  const out = Object.fromEntries(Object.entries(t).map(([r, v]) => [r + ".md", v]));
  for (const [n, v] of Object.entries(SHARED_PIN)) out["_shared/" + n + ".md"] = v;
  return out;
}
export function scriptsProbe(over = {}) {
  const home = "home" in over ? over.home : "/home/u";
  const hits = over.hits || [{ hit: SCRIPTS_DIR }];
  const lines = ["home=" + home];
  for (const h of hits) {
    lines.push("hit=" + h.hit);
    if (h.real !== null) lines.push("real=" + ("real" in h ? h.real : h.hit));
    lines.push("symlink=" + (h.symlink || "no"));
    const rd = h.hit.replace(/\/scripts$/, "") + "/roles";
    if (h.roles_real !== null) lines.push("roles_real=" + ("roles_real" in h ? h.roles_real : rd));
    lines.push("roles_symlink=" + (h.roles_symlink || "no"));
  }
  if (hits.length === 1) {
    const hl = [];
    const sums = Object.assign(Object.fromEntries(PROGRAMS.map(([n]) => [n, programSha(n)])), over.sums || {});
    for (const [n, v] of Object.entries(sums)) if (v !== undefined) hl.push(v + "  " + hits[0].hit + "/" + n + ".py");
    const rd = hits[0].hit.replace(/\/scripts$/, "") + "/roles";
    const rs = Object.assign(roleFileSums(), over.roleSums || {});
    for (const [f, v] of Object.entries(rs)) if (v !== undefined) hl.push(v + "  " + rd + "/" + f);
    // 6.2.2 (2104): the probe's own count of its hash lines, before them
    lines.push("hash_lines=" + hl.filter((x) => /^[0-9a-f]{64} /.test(x)).length, ...hl);
  }
  return lines.concat(over.extra || []);
}
// the probe command a preflight prompt carries
export async function PREFLIGHT_PROBE() {
  const o = await runOne(happy(), ARGS);
  const m = /as one Bash call: (bash -c '[^\n]*')\n/.exec(o.calls[0].prompt);
  assert.ok(m, "the preflight prompt carries the probe");
  return m[1];
}
// Recomputes every program slot's digest of a result as the program would
// have printed it (a test that forges one field keeps the digest valid, so
// only the check under test can catch it).
export function redigest(label, r, prompt) {
  const hit = PROGRAM_LABELS.find(([re]) => re.test(label));
  for (const [slot, , keys0] of hit ? hit[1] : []) {
    const o = slot ? r[slot] : r;
    if (!o || typeof o !== "object" || !keys0) continue;
    const keys = keys0 === "hasher" ? K(inputsOf(prompt).base_tree ? "hasher:base" : "hasher") : fleetScanKeys(label, keys0, prompt);
    o.digest = sha256(canon(Object.assign(pick(o, keys), { program: o.program })));
  }
  return r;
}
// the sha256 of every shipped program: what a hasher run prints as scripts
// 5.0.7 (ledger 2020): the hasher relays {count, sha256} of that map
export function scriptsSummary(map = allScripts()) {
  return { count: Object.keys(map).length, sha256: sha256(canon(map)) };
}
export function allScripts() {
  return Object.fromEntries(PROGRAMS.map(([n]) => [n, programSha(n)]));
}
// [label, [[slot (null: the result itself), program, digest keys (null: no digest)]]]
export const PROGRAM_LABELS = [
  [/^preflight$/, [["path_check", "path_check", K("path_check")], ["session_project", "session_project", K("session_project")]]],
  [/^infra:path-check:/, [[null, "path_check", K("path_check")]]],
  [/^workspace$/, [["remote_url_check", "remote_url", K("remote_url")], ["gh_check", "gh_identity", K("gh_identity")]]],
  // 5.0.8 (ledger 2030): a repo the workspace step did not check
  [/^infra:gh-identity:/, [[null, "gh_identity", K("gh_identity")]]],
  [/^hasher:/, [[null, "hasher", "hasher"]]],
  [/^infra:branch-scan$/, [[null, "branch_scan", K("branch_scan")], ["test_db", "test_db_decl", K("test_db_decl")]]],
  // 4.0.0 (1986)
  [/^infra:load-parked$/, [[null, "parked", K("parked:read")]]],
  // 5.0.2 (ledger 2004): the park program moves the draft
  [/^infra:park-plan/, [["park", "parked", K("parked:park")], ["findings_write", "parked", K("parked:write")]]],
  [/^infra:stage-plan/, [["plan_hash", "plan_hash", K("plan_hash")]]],
  [/^infra:format-(tests|code):/, [[null, "format_files", K("format_files")]]],
  // 5.0.3 (ledger 2010): the DSN precheck after the plan hooks
  [/^infra:format-plan/, [["dsn_check", "plan_dsn", K("plan_dsn")]]],
  [/^infra:commit-plan/, [[null, "plan_ref_write", K("plan_ref_write")]]],
  // 4.0.0 review: dsn_paths, the committed files that hold mysql://
  [/^infra:verify-plan-commit/, [["plan_files", "plan_files", K("plan_files")], ["plan_hash", "plan_hash", K("plan_hash")], ["plan_ref", "plan_ref", null]]],
  [/^infra:load-ref/, [[null, "plan_ref", null]]],
  [/^infra:verify-plan$/, [[null, "verify_since", K("verify_since")], ["plan_hash", "plan_hash", K("plan_hash")], ["test_db", "test_db_decl", K("test_db_decl")]]],
  [/^infra:read-state$/, [[null, "read_state", K("read_state")]]],
  [/^infra:state:/, [[null, "state_write", K("state_write")]]],
  [/^infra:tf-gate:/, [[null, "tf_gate", K("tf_gate")]]],
  [/^infra:remote-head:/, [[null, "remote_head", K("remote_head")]]],
  [/^infra:fleet-scan:/, [[null, "fleet_scan", K("fleet_scan")]]],
  [/^infra:callers/, [[null, "callers", K("callers")]]],
  [/^infra:changed-defs:/, [[null, "changed_defs", K("changed_defs")]]],
  [/^infra:push(:p\d+)?$/, [[null, "push_classify", K("push_classify")]]],
  // 4.0.0 (1985, S3)
  [/^infra:push-probe$/, [[null, "push_probe", K("push_probe")]]],
  [/^infra:hook-surface:/, [[null, "hook_surface", K("hook_surface")]]],
  // 6.0.0 (ledger 2041)
  [/^infra:ruleset-surface:/, [[null, "ruleset_surface", K("ruleset_surface")]]],
  // 6.0.0 (ledger 2033)
  [/^infra:policy$/, [[null, "policy", K("policy")]]],
  // 6.0.0 (ledger 2044)
  [/^infra:pr-stats/, [[null, "pr_body_block", K("pr_body_block")]]],
  // 6.0.0 (ledgers 2045, 2034)
  [/^infra:pr-ready/, [[null, "pr_state", K("pr_state:ready")]]],
  [/^infra:pr-merge/, [[null, "pr_state", K("pr_state:merge")]]],
  [/^infra:pr-update/, [[null, "pr_state", K("pr_state:update")]]],
  [/^infra:ci-rerun/, [[null, "pr_state", K("pr_state:rerun")]]],
  [/^infra:ci-logs/, [[null, "pr_state", K("pr_state:logs")]]],
  [/^infra:pr-view/, [[null, "pr_state", K("pr_state:view")]]],
  [/^infra:pr-fetch/, [[null, "pr_state", K("pr_state:fetch")]]],
  [/^infra:fleet-cleanup/, [[null, "pr_state", K("pr_state:cleanup")]]],
  [/^infra:orch-scan/, [[null, "orch_scan", K("orch_scan")]]],
  [/^infra:ci-watch:/, [[null, "ci_watch", K("ci_watch")]]],
  // 6.0.0 (ledger 2042)
  [/^infra:pr-convention:/, [[null, "pr_convention", K("pr_convention")]]],
  [/^infra:review-paths:/, [[null, "review_paths", K("review_paths")]]],
  // 4.0.0 review: the hook ids feed G2 and carry a digest
  [/^infra:precommit-ids/, [[null, "precommit_ids", K("precommit_ids")]]],
  [/^infra:check-scripts/, [[null, "script_check", K("script_check")]]],
  // 4.0.0 (1981)
  [/^infra:db-up/, [["sweep", "db_sweep", K("db_sweep")], ["up", "db_up", K("db_up")]]],
  [/^infra:db-down$/, [["down", "db_down", K("db_down")]]],
  // 5.0.7 (ledger 2020): the capped list of changed hasher keys
  [/^infra:hash-diff:/, [[null, "hash_diff", K("hash_diff")]]],
  // 5.0.6 (ledger 2019): the per-role build dirs
  [/^infra:build-reset:/, [[null, "build_dir", K("build_dir:reset")]]],
  [/^infra:build-clean$/, [[null, "build_dir", K("build_dir:clean")]]],
];
// 6.1.0 D6: fleet_scan.py prints base (in its digest) only when it was given one
function fleetScanKeys(label, keys0, prompt) {
  return /^infra:fleet-scan:/.test(label) && keys0 && inputsOf(prompt).base ? K("fleet_scan:base") : keys0;
}
function pick(o, keys) {
  const x = {};
  for (const k of keys) x[k] = o[k] === undefined ? null : o[k];
  return x;
}
// Gives each program output of a stub result its self-hash. A digest the stub
// computed without one (a valid 3.x digest) is recomputed with it; a digest
// that was wrong stays wrong; a missing one is computed.
export function fillPrograms(label, r, prompt) {
  if (!r || typeof r !== "object") return r;
  const isPre = label === "preflight";
  if (!isPre && r.status !== "ok") return r;
  if (isPre) {
    if (!("scripts_dir" in r)) r.scripts_dir = SCRIPTS_DIR;
    if (!("scripts_probe" in r)) r.scripts_probe = scriptsProbe();
  }
  // flat 3.x stub fields become the program outputs the prompt asks for
  if (/^infra:stage-plan/.test(label) && !("plan_hash" in r) && "plan_sha256" in r) r.plan_hash = { plan_sha256: r.plan_sha256, blob: null };
  if (/^infra:verify-plan$/.test(label)) {
    if (!("plan_hash" in r) && "plan_sha256" in r) r.plan_hash = { plan_sha256: r.plan_sha256, blob: PBLOB };
  }
  // 6.0.0 security review: plan_hash echoes its args (the prompt's)
  if (r.plan_hash && typeof r.plan_hash === "object" && !("args" in r.plan_hash) && !("digest" in r.plan_hash)) {
    const i = inputsOf(prompt);
    r.plan_hash.args = /^infra:stage-plan/.test(label) ? [i.worktree, "", i.plan_path] : /^infra:verify-plan-commit/.test(label) ? [i.worktree, i.plan_commit, i.plan_path] : [i.main_worktree, i.plan_commit, i.plan_path];
  }
  if (/^infra:verify-plan$/.test(label)) {
  }
  // 5.0.3 (ledger 2010): a format-plan stub with no dsn_check finds no DSN
  if (/^infra:format-plan/.test(label) && !("dsn_check" in r)) {
    const i = inputsOf(prompt);
    r.dsn_check = { holds: false, lines: [], args: [i.worktree, i.plan_path] };
  }
  const hit = PROGRAM_LABELS.find(([re]) => re.test(label));
  if (!hit) return r;
  for (const [slot, name, keys0] of hit[1]) {
    const o = slot ? r[slot] : r;
    if (!o || typeof o !== "object" || "program" in o) continue;
    // a 3.x stub digest covers the keys bar the hasher's scripts
    const keys = keys0 === "hasher" ? K(inputsOf(prompt).base_tree ? "hasher:base" : "hasher").filter((k) => k !== "scripts") : fleetScanKeys(label, keys0, prompt);
    const was = keys && typeof o.digest === "string" ? o.digest : null;
    const valid3 = was !== null && was === sha256(canon(pick(o, keys)));
    o.program = programOf(name);
    // the sha256sum line the same Bash call printed (4.0.0 security review)
    if (!("file_sha256" in o)) o.file_sha256 = programSha(name);
    // every hasher run hashes the shipped programs beside it
    const extra = keys0 === "hasher" ? { scripts: "scripts" in o ? o.scripts : (o.scripts = scriptsSummary()) } : {};
    if (keys && (was === null || valid3)) o.digest = sha256(canon(Object.assign(pick(o, keys), extra, { program: o.program })));
  }
  return r;
}

// load-ref stub: the plan-ref reader over the store, in the prompt's mode
// (2.1.5): no content in the entries; "chunks" adds the plan ref's message
// in pieces of at most 1000 characters.
export function loadStub(store) {
  return (prompt) => {
    const inp = inputsOf(prompt);
    const all = planRefsOf(store, inp.task_id);
    const refs = all.map((e) => {
      const o = { ...e };
      delete o.content;
      return o;
    });
    const r = { status: "ok", reason: "read", refs };
    if (inp.mode === "chunks") {
      const e = all.find((x) => x.name === inp.plan_ref);
      if (e && typeof e.content === "string") {
        r.chunks = [];
        for (let i = 0; i < e.content.length; i += 1000) r.chunks.push(e.content.slice(i, i + 1000));
      }
    }
    return r;
  };
}

// commit-step stub: hooks pass; the commit holds exactly the judged tree.
export function commitStepStub(m, live) {
  return (prompt) => {
    const code = inputsOf(prompt).code_tree;
    if (live) Object.assign(live, { head: CSHA(m), tree: code });
    return {
      status: "ok",
      reason: "committed",
      commit_result: "committed",
      staged_tree: code,
      worktree_tree: code,
      head: CSHA(m),
      head_tree: code,
    };
  };
}

// The ledger call intake reports for a brief: read_task for each yaadgaar source.
export function triedFor(brief) {
  return (brief.sources || []).filter((x) => x.kind === "yaadgaar").map((x) => ({ ledger: "yaadgaar", project: null, call: "read_task(number=" + x.ref + ")", error: null }));
}

export function happy(over = {}) {
  const crit = over.criteria || criteria(2);
  const store = {};
  // the last commit the commit step made: the review's worktree state
  const live = {};
  const reviewState = () => ({ status: "ok", fingerprint: { head: live.head, tree: live.tree } });
  const s = {
    __store: store,
    // 5.0.0 (R1): the scripts and roles probe and the PATH check are filled in
    preflight: {},
    // every role on sonnet (the shipped DISPATCH lines differ; v5_roles runs them)
    __dispatch: Object.fromEntries(ROLE_NAMES.map((k) => [k, "DISPATCH: model=sonnet"])),
    intake: { status: "ok", reason: "resolved", brief: over.brief || BRIEF, tried: over.tried || triedFor(over.brief || BRIEF) },
    "infra:branch-scan": { status: "ok", reason: "scanned", head: PB, commits: [], refs: [] },
    "infra:stage-plan": { status: "ok", reason: "staged", plan_sha256: PSHA },
    "infra:commit-plan": commitStub(store, PC, PSHA),
    "infra:verify-plan-commit": verifyStub(store),
    "infra:load-ref": loadStub(store),
    "infra:read-state": { status: "ok", reason: "no run-state", exists: false },
    "infra:verify-plan": {
      status: "ok",
      reason: "verified",
      head: PB,
      plan_sha256: PSHA,
      is_ancestor: true,
      commits_since: [],
      plan_touched: [],
      changed_since: [],
      replace_refs: [],
    },
    "infra:push": (prompt) => ({ status: "ok", reason: "pushed", push_result: "ok", remote_head: inputsOf(prompt).approved_sha }),
    "infra:ledger-writeback": (prompt) => ({
      status: "ok",
      reason: "ok",
      results: inputsOf(prompt).tasks.map((t) => ({ key: t.key, status: "written" })),
    }),
    workspace: {
      status: "ok",
      reason: "created",
      default_branch: "master",
      base_ref: "B0",
      remote_slug: "o/r",
      remote_url: "git@github.com:o/r.git",
    },
    "role:scope-and-plan": {
      status: "ok",
      reason: "planned",
      artefacts: ["docs/plans/x.md"],
      plan_path: "docs/plans/x.md",
      component: "thing",
      criteria: crit,
      est_diff_lines: 80,
      new_behaviour: true,
      tldr: "adds a thing",
      plan_diff: ["new plan"],
      fleet_estimate: { criteria: crit.length, agents: 20, rounds: 1 },
      memory_notes: ["planner fact"],
    },
    "role:plan-audit": { status: "ok", reason: "fine", verdict: "approve", routed_findings: [] },
    "hasher:pre-writers:r1": { status: "ok", fingerprint: FP_PRE },
    "hasher:post-writers:r1": (prompt) => ({
      status: "ok",
      fingerprint: FP_TESTS,
      changed: crit.flatMap((c) => c.test_files),
    }),
    "role:fleet-test-judge:r1": {
      status: "ok",
      reason: "good",
      verdict: "approve",
      routed_findings: [],
      checked: [],
      memory_notes: ["judge fact"],
    },
    "hasher:fp-post:test-judge:r1": { status: "ok", fingerprint: FP_TESTS },
    "hasher:freeze:f1": { status: "ok", fingerprint: FP_TESTS, hashes: HASHES },
    "role:fleet-coder:r1": {
      status: "ok",
      reason: "done",
      changed_paths: ["src/x.py"],
      frozen_tests_red_at_start: true,
      suite_result: { command: "pytest", exit_code: 0 },
    },
    "hasher:post-coder:r1": { status: "ok", fingerprint: FP_K1, hashes: HASHES },
    "role:fleet-code-judge:r1": {
      status: "ok",
      reason: "good",
      verdict: "approve",
      routed_findings: [],
      hash_check: { match: true, mismatched: [] },
      suite_result: { command: "pytest", exit_code: 0 },
    },
    "hasher:fp-post:code-judge:r1": { status: "ok", fingerprint: FP_K1 },
    "infra:commit:r1": commitStepStub(1, live),
    "infra:commit:r2": commitStepStub(2, live),
    "infra:commit:r3": commitStepStub(3, live),
    "infra:review-paths:v1": { status: "ok", reason: "listed", changed_paths: ["src/x.py", "tests/test_a.py"] },
    "hasher:pre-review:v1": reviewState,
    "role:pr-review:v1": { status: "ok", reason: "clean", verdict: "approve", findings: [], touches_gate: false, checked: ["diff"] },
    "hasher:fp-post:pr-review:v1": reviewState,
    "infra:review-cleanup:v1": { status: "ok", reason: "clean" },
    "role:fleet-pr-opener": {
      status: "ok",
      reason: "opened",
      pr_url: "https://github.com/o/r/pull/7",
      pr_number: 7,
      created: true,
      template_used: ".github/pull_request_template.md",
      gates_not_run_stated: true,
      memory_notes: ["pr fact"],
    },
  };
  for (const c of crit) {
    s["role:fleet-test-writer:" + c.id + ":r1"] = {
      status: "ok",
      reason: "red",
      criterion_id: c.id,
      tests: [],
      files: c.test_files.slice(),
    };
  }
  return Object.assign(s, over.script || {});
}

// The hasher's Python program ships as scripts/hasher.py (4.0.1: no longer
// embedded in the workflow). Run it for real against a scratch git repo.
export function hasherPy() {
  return programBody("hasher");
}

export function sh(cwd, ...cmd) {
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(cmd.join(" ") + ": " + r.stderr);
  return r.stdout;
}

// mode is kept for the older call sites; the program always hashes.
// 5.0.5 (ledger 2018): the program writes its ignored map to a scratch dir
// and prints a summary; for the older assertions hashes.ignored is that map
// again (read from the file) and the printed summary is ignored_summary.
export function runHasherRaw(wt, mode, files, baseTree) {
  const scratch = mkdtempSync(join(tmpdir(), "fleet-hasher-scratch-"));
  try {
    const r = spawnSync("python3", ["-I", "-", wt, JSON.stringify(files), baseTree || "", scratch], {
      input: hasherPy(),
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error("hasher failed: " + r.stderr);
    const out = JSON.parse(r.stdout);
    out.ignored_summary = out.hashes.ignored;
    // 5.0.7: every map is on disk; the older assertions read the maps back
    out.summaries = out.hashes;
    out.hashes = Object.assign({}, out.hashes);
    out.mapText = {};
    for (const m of HASH_MAP_NAMES) out.hashes[m] = JSON.parse((out.mapText[m] = readFileSync(out.summaries[m].file, "utf8")));
    Object.assign(out.hashes.git, out.summaries.git.inline);
    out.stdout = r.stdout;
    return out;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Flatten the four maps to prefixed keys for the older assertions.
export function runHasher(wt, mode, files) {
  const out = runHasherRaw(wt, mode, files);
  if (!out.hashes) return out;
  const h = out.hashes;
  const flat = Object.assign({}, h.files, h.sections);
  for (const [k, v] of Object.entries(h.git)) flat["git:" + k] = v;
  for (const [k, v] of Object.entries(h.symlinks)) flat["symlink:" + k] = v;
  return { fingerprint: out.fingerprint, hashes: flat, suspicious: h.suspicious };
}

export const py = spawnSync("python3", ["-c", "import tomllib"]);
export const HAVE_PY = py.status === 0;

export function scratchRepo(prefix) {
  const wt = mkdtempSync(join(tmpdir(), prefix));
  sh(wt, "git", "init", "-q");
  sh(wt, "git", "config", "user.email", "t@example.com");
  sh(wt, "git", "config", "user.name", "t");
  sh(wt, "git", "config", "commit.gpgsign", "false");
  return wt;
}

export function canon(v) {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object")
    return (
      "{" +
      Object.keys(v)
        .sort()
        .filter((k) => v[k] !== undefined)
        .map((k) => JSON.stringify(k) + ":" + canon(v[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(v === undefined ? null : v);
}

export async function planRefFor(s) {
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  return out.result.plan_ref;
}

export function buildArgs(ref, over) {
  return Object.assign({ mode: "build", plan_ref: ref, date: "2026-11-04", repo: "/r", project: "o/r" }, over || {});
}

// A hermetic git env for real-repo tests: own HOME and global config.
export function gitEnv(dir, globalCfg) {
  const env = Object.assign({}, process.env, { HOME: dir, XDG_CONFIG_HOME: join(dir, ".config"), GIT_CONFIG_GLOBAL: globalCfg, GIT_CONFIG_NOSYSTEM: "1" });
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

export function extractFn(begin, end, name) {
  const m = new RegExp(begin + "\\n([\\s\\S]*?)\\n\\/\\/ " + end).exec(SOURCE);
  assert.ok(m, begin + " markers");
  const q = (x) => "'" + String(x).replace(/'/g, "'\\''") + "'";
  return Function("q", "return (" + m[1].trim().replace(new RegExp("^function " + name), "function").replace(/shQuote/g, "q") + ")")(q);
}

// The program a 4.0.0 <NAME>_PY constant held, read from scripts/<name>.py
// (4.0.1). begin and end stay for the callers; the name comes from constName.
export function extractPy(begin, end, constName) {
  assert.match(constName, /^[A-Z_]+_PY$/, constName);
  assert.equal(begin, constName + "_BEGIN");
  assert.equal(end, constName + "_END");
  return programBody(constName.slice(0, -3).toLowerCase());
}

export function scriptCheckPy() {
  return programBody("script_check");
}

// The state JSON a run-state write step carries (quoted heredoc body).
export function stateJsonOf(prompt) {
  const c = chunkedContentOf(prompt);
  return c === null ? null : JSON.parse(c);
}

export const CHUNK = 1000;
export function chunksOf(c) {
  const out = [];
  for (let i = 0; i < c.length; i += CHUNK) out.push(c.slice(i, i + CHUNK));
  return out;
}

export function defsOut(defs, more) {
  const o = Object.assign({ defs, excluded: [], unclassified: [], unattributed: [] }, more || {});
  return { status: "ok", reason: "listed", ...o, digest: sha256(canon(o)) };
}
