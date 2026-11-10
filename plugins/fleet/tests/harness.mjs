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
export const RELAY_KEYS = [
  [/^infra:fleet-scan:/, ["diff", "commits"]],
  [/^infra:read-state$/, ["exists", "target", "message", "head", "head_tree", "clean"]],
  [/^infra:review-paths:/, ["changed_paths"]],
  [/^infra:check-scripts/, ["checks"]],
  [/^infra:branch-scan$/, ["commits", "refs", "plan_tip_time"]],
  [/^infra:format-(tests|code):/, ["ran", "reason", "runs", "stable", "files", "changed", "refused"]],
  // 3.1.0 (ledger 1959)
  [/^infra:verify-plan$/, ["head", "is_ancestor", "commits_since", "plan_touched", "changed_since", "args"]],
  // 3.1.0 (ledger 1935c)
  [/^infra:push(:p\d+)?$/, ["push_result", "exit_code", "hook_tail", "args"]],
  [/^infra:hook-surface:/, ["surface", "make_paths", "error", "args"]],
];
// 3.1.0: the IaC push gate program's output, with its digest
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
    r.args = [i.main_worktree, i.plan_commit, i.plan_path];
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
    let r = await agentInner(prompt, opts);
    if (r && typeof r === "object" && !rawResults.has(r)) r = fillPrograms(label, r, prompt);
    const mut = script.__mutate;
    if (mut && r && typeof r === "object" && (mut.label instanceof RegExp ? mut.label.test(label) : mut.label === label)) r = mut.fn(r, prompt);
    return r;
  };
  const agentInner = async (prompt, opts = {}) => {
    const label = opts.label;
    calls.push({ label, prompt, opts });
    // 3.1.0: preflight returns the PATH check program's output (no IaC tool on PATH)
    if (label === "preflight" && script.preflight && typeof script.preflight === "object" && !("path_check" in script.preflight) && !script.preflight.__raw_path_check) {
      const pc = { tools: { ["terra" + "form"]: null, ["to" + "fu"]: null, ["t" + "fp"]: null, ["terra" + "grunt"]: null, ["dig" + "ger"]: null, ["atlan" + "tis"]: null }, args: [inputsOf(prompt).repo], path_problems: [] };
      pc.digest = sha256(canon(pc));
      return Object.assign({ ledger_tools: LEDGER_TOOLS_ALL.slice() }, JSON.parse(JSON.stringify(script.preflight)), { path_check: pc });
    }
    // 5.0.0 (review of d8df90b): an unscripted probe role-read reads the scenario's file
    if (!(label in script) && /^infra:role-read:/.test(label)) {
      const role = inputsOf(prompt).role;
      return { status: "ok", reason: "read", role_file: { name: role, sha256: roleTable[role] } };
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
    if (!(label in script) && /^infra:park-plan/.test(label)) return { status: "ok", reason: "parked", target: inputsOf(prompt).dest, clean: true };
    // unscripted plan formatting changes nothing (the hooks found nothing to fix)
    if (!(label in script) && /^infra:format-plan/.test(label)) return { status: "ok", reason: "formatted", changed_paths: [] };
    // unscripted fixer-hook runs change nothing (3.0.0)
    if (!(label in script) && /^infra:format-(tests|code):/.test(label)) {
      const sel = inputsOf(prompt).select;
      return withRelayDigest(label, { status: "ok", reason: "ran pre-commit run --files", ran: true, runs: 1, stable: true, files: sel.paths || [], changed: [], refused: [] });
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
    // 3.1.0: unscripted ledger reads find a task with a body page
    if (!(label in script) && /^infra:ledger-read:pre$/.test(label))
      return { status: "ok", reason: "read", results: inputsOf(prompt).tasks.map((t) => ({ key: t.key, status: "ok", title: "T" + t.id, body_slug: "o_r_task-" + t.id, has_marker: false })) };
    // unscripted build caller checks find no modified existing definition
    if (!(label in script) && /^infra:changed-defs:/.test(label)) return defsOut([]);
    // unscripted fleet-internal scans find no .fleet/ path in the PR diff
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
      const up = { name: i.name, port: 40000, dbs: i.dbs, users, expiry: i.mode === "up" ? { mechanism: "podman-timeout", expires: 1700000000 } : null, args: i.mode === "up" ? ["up", i.name, i.image, String(i.ttl), i.nonce, JSON.stringify(i.dbs)] : ["add", i.name, JSON.stringify(i.dbs)] };
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
    if (!raw) withRelayDigest(label, fillArgs(label, r, prompt));
    // 3.1.1: the workspace step relays the origin URL program's output; a stub
    // that gives only remote_url gets that program's output for it
    if (label === "workspace" && !raw && r.status === "ok" && !("remote_url_check" in r)) r.remote_url_check = remoteUrlOut(r.remote_url, inputsOf(prompt).repo);
    // hasher stubs that give only a fingerprint carry the maps of the last
    // hasher result forward (nothing changed; the judge fingerprint compares
    // the maps too) and list no changed paths
    if (label.startsWith("hasher:") && !raw && r.status === "ok") {
      if (!("hashes" in r)) r.hashes = JSON.parse(JSON.stringify(lastHashes || DEFAULT_HASHES));
      if (!("changed" in r)) r.changed = [];
      // the real hasher sees the run-state refs the workflow's own state writes made
      const g = r.hashes.git || (r.hashes.git = {});
      if (!Object.keys(g).some((k) => k.startsWith("fleetref:"))) Object.assign(g, fleetRefs);
      // 4.0.0 (1987): a scripted freeze ref is in the repo from then on
      else for (const k of Object.keys(g)) if (/^fleetref:refs\/fleet\/[^/]+\/freeze$/.test(k) && !(k in fleetRefs)) fleetRefs[k] = g[k];
      // a stub that models other refs only still sees the freeze ref
      for (const [k, v] of Object.entries(fleetRefs)) if (/\/freeze$/.test(k) && !(k in g)) g[k] = v;
      lastHashes = r.hashes;
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
    { total: null, spent: () => 0, remaining: () => Infinity },
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
export const FP_PRE = { head: PC, tree: "T0" };
export const FP_TESTS = { head: PC, tree: "T1" };
export const FP_PLAN = FP_TESTS;
export const FP_K1 = { head: PC, tree: "K1" };
export const FP_K2 = { head: PC, tree: "K2" };
export const FP_M3 = { head: PC, tree: "M3" };
// the commit step's head for code round m
export const CSHA = (m) => "c00000" + m;
// Hasher output is four maps plus a suspicious list. Fixtures are written as
// flat prefixed keys and converted: "git:<k>" -> git, "symlink:<k>" ->
// symlinks, a key with "#" -> sections, anything else -> files.
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
    // 4.0.0: what the verify step reads back
    store.__commit = { head, planSha, planPath: inputsOf(prompt).plan_path, worktree: inputsOf(prompt).worktree };
    return { status: "ok", reason: "committed", head, tag_sha: "7".repeat(40) };
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
      plan_files: { head: c.head || null, files: [i.plan_path], args: [i.worktree], dsn_paths: [] },
      plan_hash: { plan_sha256: c.planSha || null },
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
export const SCRIPTS_DIR = "/home/u/.claude/plugins/cache/mkt/fleet/4.0.3/scripts";
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
function chunkWriteCmd(program, wt, target, json, outKey) {
  const msg = json + "\n";
  const b64 = Buffer.from(msg, "utf8").toString("base64");
  const dir = join(dirname(wt), "scratch", "chunks-test-" + process.pid + "-" + ++refWrites);
  const chunks = [];
  for (let i = 0; i < b64.length; i += 4000) chunks.push(b64.slice(i, i + 4000));
  const shas = chunks.map((c, i) => ({ i, sha256: sha256(c) }));
  return (
    "set -o pipefail; mkdir -p " + shq(dir) + " && " +
    chunks.map((c, i) => "printf '%s' " + shq(c) + " > " + shq(dir + "/" + i + ".b64")).join(" && ") +
    " && python3 -I " + [join(SCRIPTS_SRC, program + ".py"), wt, target, dir, String(chunks.length), sha256(msg), JSON.stringify(shas)].map(shq).join(" ") +
    " | python3 -I -c 'import json, sys; o = json.load(sys.stdin); print(o[\"head\"], o[\"" + outKey + "\"])'"
  );
}
export function planRefWriteCmd(wt, taskId, json) {
  return chunkWriteCmd("plan_ref_write", wt, taskId, json, "tag_sha");
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
    const sums = Object.assign(Object.fromEntries(PROGRAMS.map(([n]) => [n, programSha(n)])), over.sums || {});
    for (const [n, v] of Object.entries(sums)) if (v !== undefined) lines.push(v + "  " + hits[0].hit + "/" + n + ".py");
    const rd = hits[0].hit.replace(/\/scripts$/, "") + "/roles";
    const rs = Object.assign(roleFileSums(), over.roleSums || {});
    for (const [f, v] of Object.entries(rs)) if (v !== undefined) lines.push(v + "  " + rd + "/" + f);
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
    const keys = keys0 === "hasher" ? ["fingerprint", "hashes"].concat(inputsOf(prompt).base_tree ? ["changed"] : []) : keys0;
    const extra = keys0 === "hasher" ? { scripts: o.scripts === undefined ? null : o.scripts } : {};
    o.digest = sha256(canon(Object.assign(pick(o, keys), extra, { program: o.program })));
  }
  return r;
}
// the sha256 of every shipped program: what a hasher run prints as scripts
export function allScripts() {
  return Object.fromEntries(PROGRAMS.map(([n]) => [n, programSha(n)]));
}
const PC_KEYS = ["tools", "args", "path_problems"];
// [label, [[slot (null: the result itself), program, digest keys (null: no digest)]]]
export const PROGRAM_LABELS = [
  [/^preflight$/, [["path_check", "path_check", PC_KEYS]]],
  [/^infra:path-check:/, [[null, "path_check", PC_KEYS]]],
  [/^workspace$/, [["remote_url_check", "remote_url", ["url", "args"]]]],
  [/^hasher:/, [[null, "hasher", "hasher"]]],
  [/^infra:branch-scan$/, [[null, "branch_scan", ["commits", "refs", "plan_tip_time"]], ["test_db", "test_db_decl", ["decl", "error", "args"]]]],
  // 4.0.0 (1986)
  [/^infra:load-parked$/, [[null, "parked", ["parked", "args"]]]],
  [/^infra:park-plan/, [["findings_write", "parked", ["written", "sha256", "args"]]]],
  [/^infra:stage-plan/, [["plan_hash", "plan_hash", null]]],
  [/^infra:format-(tests|code):/, [[null, "format_files", ["ran", "reason", "runs", "stable", "files", "changed", "refused"]]]],
  [/^infra:commit-plan/, [[null, "plan_ref_write", ["head", "tag_sha"]]]],
  // 4.0.0 review: dsn_paths, the committed files that hold mysql://
  [/^infra:verify-plan-commit/, [["plan_files", "plan_files", ["head", "files", "args", "dsn_paths"]], ["plan_hash", "plan_hash", null], ["plan_ref", "plan_ref", null]]],
  [/^infra:load-ref/, [[null, "plan_ref", null]]],
  [/^infra:verify-plan$/, [[null, "verify_since", ["head", "is_ancestor", "commits_since", "plan_touched", "changed_since", "args"]], ["plan_hash", "plan_hash", null], ["plan_hash_head", "plan_hash", null], ["test_db", "test_db_decl", ["decl", "error", "args"]]]],
  [/^infra:read-state$/, [[null, "read_state", ["exists", "target", "message", "head", "head_tree", "clean"]]]],
  [/^infra:state:/, [[null, "state_write", ["head", "state_sha"]]]],
  [/^infra:tf-gate:/, [[null, "tf_gate", ["touched", "iac_files", "problems", "hints", "args"]]]],
  [/^infra:remote-head:/, [[null, "remote_head", ["head", "args"]]]],
  [/^infra:fleet-scan:/, [[null, "fleet_scan", ["diff", "commits"]]]],
  [/^infra:callers/, [[null, "callers", ["occurrences", "capped", "auto_dont_care", "doctest_md"]]]],
  [/^infra:changed-defs:/, [[null, "changed_defs", ["defs", "excluded", "unclassified", "unattributed"]]]],
  [/^infra:push(:p\d+)?$/, [[null, "push_classify", ["push_result", "exit_code", "hook_tail", "args"]]]],
  // 4.0.0 (1985, S3)
  [/^infra:push-probe$/, [[null, "push_probe", ["access", "result", "exit_code", "auth_line", "args"]]]],
  [/^infra:hook-surface:/, [[null, "hook_surface", ["surface", "make_paths", "error", "args"]]]],
  [/^infra:review-paths:/, [[null, "review_paths", ["changed_paths"]]]],
  // 4.0.0 review: the hook ids feed G2 and carry a digest
  [/^infra:precommit-ids/, [[null, "precommit_ids", ["present", "ids", "parser", "error", "args"]]]],
  [/^infra:check-scripts/, [[null, "script_check", ["checks"]]]],
  // 4.0.0 (1981)
  [/^infra:db-up/, [["sweep", "db_sweep", ["podman", "removed", "kept", "errors"]], ["up", "db_up", ["name", "port", "dbs", "users", "expiry", "args"]]]],
  [/^infra:db-down$/, [["down", "db_down", ["removed", "absent", "error", "args"]]]],
];
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
  if (/^infra:stage-plan/.test(label) && !("plan_hash" in r) && "plan_sha256" in r) r.plan_hash = { plan_sha256: r.plan_sha256 };
  if (/^infra:verify-plan$/.test(label)) {
    if (!("plan_hash" in r) && "plan_sha256" in r) r.plan_hash = { plan_sha256: r.plan_sha256 };
    if (!("plan_hash_head" in r) && "plan_sha256_head" in r) r.plan_hash_head = { plan_sha256: r.plan_sha256_head };
  }
  const hit = PROGRAM_LABELS.find(([re]) => re.test(label));
  if (!hit) return r;
  for (const [slot, name, keys0] of hit[1]) {
    const o = slot ? r[slot] : r;
    if (!o || typeof o !== "object" || "program" in o) continue;
    const keys = keys0 === "hasher" ? ["fingerprint", "hashes"].concat(inputsOf(prompt).base_tree ? ["changed"] : []) : keys0;
    const was = keys && typeof o.digest === "string" ? o.digest : null;
    const valid3 = was !== null && was === sha256(canon(pick(o, keys)));
    o.program = programOf(name);
    // the sha256sum line the same Bash call printed (4.0.0 security review)
    if (!("file_sha256" in o)) o.file_sha256 = programSha(name);
    // every hasher run hashes the shipped programs beside it
    const extra = keys0 === "hasher" ? { scripts: "scripts" in o ? o.scripts : (o.scripts = allScripts()) } : {};
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
    "infra:branch-scan": { status: "ok", reason: "scanned", commits: [], refs: [] },
    "infra:stage-plan": { status: "ok", reason: "staged", plan_sha256: PSHA },
    "infra:commit-plan": commitStub(store, PC, PSHA),
    "infra:verify-plan-commit": verifyStub(store),
    "infra:load-ref": loadStub(store),
    "infra:read-state": { status: "ok", reason: "no run-state", exists: false },
    "infra:verify-plan": {
      status: "ok",
      reason: "verified",
      head: PC,
      plan_sha256: PSHA,
      plan_sha256_head: PSHA,
      is_ancestor: true,
      commits_since: [],
      plan_touched: [],
      changed_since: [],
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
export function runHasherRaw(wt, mode, files, baseTree) {
  const r = spawnSync("python3", ["-I", "-", wt, JSON.stringify(files)].concat(baseTree ? [baseTree] : []), {
    input: hasherPy(),
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error("hasher failed: " + r.stderr);
  return JSON.parse(r.stdout);
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
