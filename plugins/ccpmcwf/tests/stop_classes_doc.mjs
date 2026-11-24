#!/usr/bin/env node
// ccpmcwf 8.8.0 (yaadgaar #108 step 5, ADR-1397): the stop-site scan and the generator of
// docs/stop-classes.md. It lives in tests/ (not scripts/: preflight refuses unknown files there).
//
//   node plugins/ccpmcwf/tests/stop_classes_doc.mjs          write docs/stop-classes.md from the source
//   node plugins/ccpmcwf/tests/stop_classes_doc.mjs --check  exit 1 when the file is not the source's table
//
// v880_stop_class.test.mjs runs the check, so a new stop site regenerates the table (no hand edit).
// The scan is text-based (no parser in the repo): comment-only lines are blanked, string and template
// text is skipped when it splits arguments, and a regex literal holds no quote or unbalanced bracket.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SRC = join(HERE, "..", "src", "build-engine.js");
export const DOC = join(HERE, "..", "docs", "stop-classes.md");
export const STOP_FNS = ["halt", "stop", "planFindingsStop"];

export const ATOM = /^("[smt]"|J_[A-Z0-9_]+(\([^?:]*\))?)$/;
const TERNARY = /^([^?]+)\?\s*([^:]+?)\s*:\s*(.+)$/s;
const NAME = { '"s"': "safety", '"m"': "mechanical", '"t"': "transient", '"j"': "judgment" };
const nameOf = (a) => NAME[a] || (/^J_/.test(a) ? "judgment" : "?");

// the text with comment-only lines blanked (line numbers kept)
function blankComments(text) {
  return text
    .split("\n")
    .map((l) => (/^\s*\/\//.test(l) ? "" : l))
    .join("\n");
}
// the text with the content of every string and template literal blanked (quotes kept)
function blankStrings(text) {
  let out = "";
  let q = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === "\\") {
        out += "  ";
        i++;
      } else if (c === q) {
        q = null;
        out += c;
      } else out += c === "\n" ? "\n" : " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") q = c;
    out += c;
  }
  return out;
}
// the top-level arguments of the call whose "(" is at open, and the offset of its ")"
function callArgs(blank, open) {
  const args = [];
  let depth = 0;
  let q = null;
  let start = open + 1;
  let i = open + 1;
  for (; i < blank.length; i++) {
    const c = blank[i];
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") q = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth-- === 0) break;
    } else if (c === "," && depth === 0) {
      args.push(blank.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = blank.slice(start, i).trim();
  if (last) args.push(last);
  return { args, end: i };
}

// every call of halt(, the global stop( and planFindingsStop(: {callee, cls, args, line, fn, text}
export function stopSites(text) {
  const lines = text.split("\n");
  const blank = blankComments(text);
  const re = /(^|[^A-Za-z0-9_$.])(halt|stop|planFindingsStop)\(/g;
  const out = [];
  let m;
  while ((m = re.exec(blank))) {
    const at = m.index + m[1].length;
    const lineStart = blank.lastIndexOf("\n", at) + 1;
    if (/function\s+$/.test(blank.slice(lineStart, at))) continue;
    const open = at + m[2].length;
    const { args, end } = callArgs(blank, open);
    const line = blank.slice(0, at).split("\n").length;
    let fn = "(top)";
    for (let k = line - 1; k >= 0; k--) {
      const f = /^(?:async )?function (\w+)/.exec(lines[k]);
      if (f) {
        fn = f[1];
        break;
      }
    }
    out.push({ callee: m[2], cls: args[0] || "", args, line, fn, text: blank.slice(at, Math.min(end + 1, at + 800)) });
  }
  return out;
}
// 8.8.0 (review S1): halt, stop and planFindingsStop are only called or declared, never used as a value
// (an alias such as `const h = halt` or `[halt][0](...)` would hide a site from the scan)
export function valueUses(text) {
  const blank = blankStrings(blankComments(text));
  const re = /(^|[^A-Za-z0-9_$.])(halt|stop|planFindingsStop)\b/g;
  const out = [];
  let m;
  while ((m = re.exec(blank))) {
    const at = m.index + m[1].length;
    const after = blank.slice(at + m[2].length);
    const lineStart = blank.lastIndexOf("\n", at) + 1;
    // a call, or the declaration `function halt(`
    if (/^\s*\(/.test(after)) continue;
    // an object key (`stop:`) names a property, not the function
    if (/^\s*:/.test(after) && /[{,]\s*$/.test(blank.slice(lineStart, at))) continue;
    out.push("line " + blank.slice(0, at).split("\n").length + ": " + m[2] + " used as a value");
  }
  return out;
}
export function classProblem(s) {
  // planFindingsStop's own halt and halt's stop pass their caller's class on
  if (s.cls === "cls" && ((s.callee === "halt" && s.fn === "planFindingsStop") || (s.callee === "stop" && s.fn === "halt"))) return null;
  if (s.callee === "planFindingsStop" && s.cls === '"j"') return null;
  if (ATOM.test(s.cls)) return null;
  const t = TERNARY.exec(s.cls);
  if (t && ATOM.test(t[2]) && ATOM.test(t[3])) return null;
  return "line " + s.line + " (" + s.fn + "): " + s.callee + "(" + s.cls + ", ...) names no stop class";
}
// the class names a site's argument can produce, e.g. "transient / safety"
export function classNames(s) {
  if (s.cls === "cls") return "per caller";
  const t = TERNARY.exec(s.cls);
  if (!t || ATOM.test(s.cls)) return nameOf(s.cls);
  const a = nameOf(t[2]);
  const b = nameOf(t[3]);
  return a === b ? a : a + " / " + b;
}

// ---------------------------------------------------------------- the reasons

const SPECIAL = [
  [/^cls$/, "passes its caller's class on (each caller names one)"],
  [/ic\.opts\.agentType === JUDGE_AGENT/, "a null result: transient for a read-only (judge) step, which 8.7.0 already retried once; safety for a write step, whose first attempt may have written"],
  [/ROLE_AGENT\[role\] === JUDGE_AGENT/, "a null role result: transient for a judge-type role (read only); safety for a writer or coder (its attempt may have written)"],
  [/^t \? "t" : "s"$/, "only ruleset_surface.py reads GitHub: its own error shape with no HTTP status (gh crashed or timed out) is transient; a hook_surface error (it names repo files) and any other error are safety"],
  [/^"t"$/, "CI checks still pending or unresolved at the watch deadline: the same watch later can resolve it"],
  [/^"m"$/, "a deterministic repair with no judgment"],
];
const JREASON = [
  [/full path but no testable criteria/, "no criterion names a test file: the task or plan needs a human edit"],
  [/CALLER_SUMMARY_CAP_ONE/, "one symbol has too many callers to relay: a narrower name or scope is a human choice"],
  [/the auto lists of/, "doc and lock hits need more reads than a caller check may take: map them or narrow the scope"],
  [/plan-audit verdict/, "the plan audit did not approve (a human reads its findings); a missing verdict is a relay contract break (safety)"],
  [/ug\.reason/, "the task requires a gate the census reports unsupported: run unattended, or edit the task"],
  [/stillClaims/, "the PR body still states test counts after one scripted rewrite: a human edits the body"],
  [/a finding targets the plan after update-branch/, "a review finding targets the plan on the forge's merge: re-plan on the new base or fix by hand"],
  [/PR body claim still flagged/, "a PR body claim is still flagged after one body update: a human edits the body"],
  [/re-review after update-branch/, "the re-review after update-branch requests changes: no coder round runs on the forge's merge"],
  [/requested changes again/, "the review rounds are spent: a human fixes or re-plans"],
  [/in a code round after update-branch/, "the code judge rejects after update-branch: no writer or re-plan runs on the forge's merge"],
  [/CI red after update-branch/, "CI red caused by the diff after update-branch: no CI-fix round runs then"],
  [/CI still red after/, "CI red caused by the diff after the CI-fix rounds"],
  [/pre_freeze_hooks still fail after/, "the writers' tests still fail the policy's format hooks after the test rounds"],
  [/test rounds exhausted/, "the test rounds are spent without test-judge approval"],
  [/code rounds exhausted/, "the code rounds are spent without code-judge approval"],
  [/frozen tests are red at the start/, "the augmentation round's new tests fail on the approved tree"],
  [/surviving mutant/, "the code judge ruled surviving mutants target tests after the one round a run may take"],
  [/^halt\(J_PR, "needs_human", w2?(, "role")?\)$/, "the pr-opener set a wrong title or left out gates_not_run after one scripted retry: a human edits the PR"],
];
const PF = [
  [/test DSN URL/, "safety", "a DSN in the plan doc (DSN rule)"],
  [/np[mx] test_cmd/, "safety", "the test command would resolve outside the worktree (command rule)"],
  [/plan sweep verdict weakening/, "safety", "the plan sweep found a weakening (intent rule)"],
  [/contract drift/, "judgment", "the planner's output breaks its contract after the re-plan rounds (8.5.5 routes these to the planner first)"],
  [/criteria refused/, "judgment", "criterion ids or test_files the planner did not fix in its rounds"],
  [/invisible or confusable/, "judgment", "a criterion holds a confusable character the planner did not fix"],
  [/changed_symbols/, "judgment", "the caller map is incomplete after the re-plan rounds (a narrower scope is a human choice)"],
  [/plan-audit verdict/, "judgment", "the plan audit refused the plan after the re-plan rounds"],
];
const GATE = {
  hash: "a hash, freeze or refs check (hash rule)",
  fingerprint: "the worktree changed under a step (fingerprint rule)",
  ownership: "a role touched a path it does not own (ownership rule)",
  scope: "a path outside the scope fence, or the plan doc in the diff (scope rule)",
  iac: "IaC rule: an IaC change or an unshimmed IaC tool",
  "iac-push": "IaC diffs never push automatically",
  hooks: "hook surface or hook run (hook rule)",
  commands: "command allowlist",
  db: "test database or DSN rule",
  contract: "a role, program or agent identity or contract mismatch",
  role: "a role or step reported a stop, or its output is unusable; cause unknown",
  cap: "agent cap",
  budget: "run budget: never auto-repaired (ADR-1397 budget next to the cap)",
  push: "push access is not known or is refused",
  refs: "refs/replace could change what a sealed object id reads as",
  resume: "run-state or resume trust",
  commit: "the commit or its tree is not the checked one",
  review: "the review state does not match the pushed head, or a review role broke its contract",
  merge: "work-owner merge rule: a merge is Max's",
  ci: "CI head or state is not the approved one",
  stats: "PR body block or unattended disclosure check",
  policy: "policy file error",
  relaunch: "relay rulings: the relayed launch is not the build request",
  intent: "intent rule",
  audit: "plan audit",
  gates: "a gate result is missing or refused",
  callers: "the approved tree changes code the sealed caller map does not cover",
  plan: "plan check",
};
const FN_REASON = [
  [/^requireProgram$/, "the program relay is missing or reports an error (program identity)"],
  [/^chunkRounds$/, "chunk files do not hash to their sha256 (hash rule)"],
  [/^(hasher|expandKeys)$/, "the hasher view is unusable (hash rule)"],
  [/^normCriteria$/, "a sealed plan's criteria break the contract (build mode; plan mode routes these to the planner)"],
  [/^verifyPlanCommit$/, "plan-ref trust: the plan commit or ref is not the sealed one"],
  [/^(callerCheck|buildCallerCheck)$/, "a program's output breaks the script's own rules (program contract)"],
];
const TEXT_REASON = [
  [/hasher output is over the 65536-byte relay cap/, "the hasher output is over the relay cap: paging needs a hasher.py change, and a re-run would overflow again"],
  [/test-count phrases than the program reports/, "a truncated claims list fails closed (8.7.0 keeps it a stop)"],
  [/^halt\("s", "needs_human", msg/, "per caller gate: ownership or hash (ownership rule)"],
  [/noPushText\(remoteSlug\), stopGate/, "push access is not known or is refused"],
  [/which a resumed run cannot start/, "a resumed run cannot start a coder round (run-state trust)"],
  [/augmentation round \(test round/, "a test writer broke the augmentation contract (role contract)"],
  [/^halt\("s", "needs_human", w\)$/, "the test judge broke its routing contract after one scripted retry"],
  [/coderFile/, "the coder's result breaks its role contract"],
  [/pr-opener returned ok with no PR|pr-opener retry named/, "the pr-opener's PR is not the expected one (identity)"],
  [/the run-state landed on/, "run-state landed on another head (run-state trust)"],
  [/refFacts\.msg|unsafe commit subject|lpb \+/, "plan-ref trust: the sealed ref facts are refused"],
  [/^halt\("s", "needs_human", oh\)$/, "repo or branch identity"],
  [/the callers file /, "relay contract: a required field is missing or malformed"],
];
function safetyReason(gate, text, callee, fn) {
  for (const [re, r] of TEXT_REASON) if (re.test(text)) return r;
  for (const [re, r] of FN_REASON) if (re.test(fn)) return r;
  if (/RELAY_MISMATCH|NOT_DIGEST|OTHER_ARGS|do not match the program's digest|off its digest|do not match the summary|do not match the request|does not match the request|do not join to ref_sha256|is not the program's/.test(text)) return "relay digest or args mismatch: the copy may be altered";
  if (/LEGACY_REF|legacy|fleet 5\.x|before 6\.0\.0/.test(text)) return "version or legacy ref";
  if (callee === "stop") return "an argument check (run-state, plan-ref or checkpoint trust)";
  if (/plan changed since approval|plan ref missing or changed|merge commit \(possibly update-branch\)|project mismatch/.test(text)) return "plan-ref trust: the approved plan is not what the branch holds";
  const g = gate.replace(/"/g, "");
  if (g && GATE[g]) return GATE[g];
  if (/returned no result/.test(text)) return "a write step returned no result; its attempt may have written";
  if (/returned " \+ (r|it)\.status|returned " \+ st|" \+ it\.status \+ ": "/.test(text)) return "a step reported failed or needs_human; cause unknown";
  if (/returned no |no usable|has no |not a list|no .* list/.test(text)) return "relay contract: a required field is missing or malformed";
  if (/held by run/.test(text)) return "another run holds this task (ownership)";
  if (/intake|re-read of/.test(text)) return "intake or ruling re-read: source, ledger or project identity";
  if (/origin|remote_slug|default branch|several fleet branches|empty slug/.test(text)) return "repo or branch identity";
  if (/internal:/.test(text)) return "internal invariant";
  if (/infra:replan|superseded_head|is at /.test(text)) return "a ref or head is not the expected one";
  if (/push_result|origin\//.test(text)) return "push did not land the approved commit";
  if (/plan_path|planner wrote/.test(text)) return "plan path mismatch (contract)";
  if (/verdict plan_wrong without|no verdict/.test(text)) return "a judge broke its verdict contract";
  if (/branch has build commits/.test(text)) return "a branch with build commits and no usable plan ref";
  if (/INFRA_TIER|scripts_dir|preflight/.test(text)) return "install or preflight identity";
  return "not clearly mechanical, judgment or transient (conservative default)";
}
function reasonOf(s, msg) {
  const names = classNames(s);
  if (s.callee === "planFindingsStop") {
    const p = PF.find(([re]) => re.test(msg));
    if (!p || p[1] !== names) throw new Error("line " + s.line + ": no planFindingsStop reason for class " + names);
    return p[2];
  }
  const sp = SPECIAL.find(([re]) => re.test(s.cls));
  if (sp) return sp[1];
  if (names.split(" / ").includes("judgment")) {
    const j = JREASON.find(([re]) => re.test(s.text));
    if (!j) throw new Error("line " + s.line + ": no judgment reason: " + s.text.slice(0, 120));
    return j[1];
  }
  return safetyReason(s.callee === "halt" ? s.args[3] || "" : s.callee === "planFindingsStop" ? s.args[7] || "" : "", s.text, s.callee, s.fn);
}

// ---------------------------------------------------------------- the document

const cell = (x) => x.replace(/\s+/g, " ").replace(/\|/g, "\\|").replace(/`/g, "'");
export function render(source) {
  const sites = stopSites(source);
  const rows = sites.map((s, i) => {
    const gate = s.callee === "halt" ? s.args[3] : s.callee === "planFindingsStop" ? s.args[7] : null;
    const msg = s.callee === "halt" ? s.args[2] : s.callee === "stop" ? s.args[2] : s.args[3];
    const g = gate ? cell(gate.replace(/"/g, "")) : s.callee === "stop" ? "(stop)" : "-";
    return { n: i + 1, fn: s.fn, gate: g, names: classNames(s), site: cell(msg || "").slice(0, 110), reason: reasonOf(s, msg || "") };
  });
  const count = {};
  for (const r of rows) for (const c of r.names.split(" / ")) count[c] = (count[c] || 0) + 1;
  const counts = ["safety", "judgment", "transient", "mechanical", "per caller"].map((c) => c + " " + (count[c] || 0)).join(", ");
  return [
    "# Stop classes of build-engine.js (ccpmcwf 8.9.0)",
    "",
    "yaadgaar #108 step 5, ADR-1397. Every stop site of `src/build-engine.js` names its stop class in",
    "script code, as the first argument of `halt`, `stop` or `planFindingsStop`. No LLM sets or",
    "changes a class at run time. The run result carries the class as `stop_class`, next to",
    "`stop_gate` (null on `ok` and `awaiting_confirmation`).",
    "",
    "This file is generated: run `node plugins/ccpmcwf/tests/stop_classes_doc.mjs` after a change to a",
    "stop site. `tests/v880_stop_class.test.mjs` fails when the file is not the source's table.",
    "",
    "<!-- prettier-ignore -->",
    "| Code | Class | Meaning (ADR-1397) |",
    "| --- | --- | --- |",
    '| `"s"` | safety | Always stops. Never repaired or re-run automatically. |',
    '| `"m"` | mechanical | A deterministic script repair with no judgment. No call site uses it in 8.8.0; `resume_with` is mechanical. |',
    '| `"t"` | transient | One retry is reasonable. |',
    "| `J_<NAME>` | judgment | One bounded repair round, then needs_human with the 2-3 options the const carries. |",
    "",
    "Rules:",
    "",
    "- When a site is not clearly mechanical, judgment or transient, it is safety.",
    "- Safety covers: the hook surface, IaC, hash, freeze, fingerprint and ownership, the scope fence, the",
    "  command allowlist, the DSN rule, secret paths, the work-owner merge rule, intent refusals, role,",
    "  contract and program identity, relay digest or args mismatches, run-state, plan-ref and checkpoint",
    "  trust, version and legacy refs, push access, the agent cap and the run budget.",
    "- The run budget is safety, not its own class: safety is the only class that is never repaired or",
    "  re-run, which is what a spent budget needs. Its stop still returns its options.",
    "- A null agent result is transient only for a read-only (judge) step; a write step's null is safety",
    "  (its first attempt may have written).",
    "- A hook-surface stop is transient only for ruleset_surface.py's own error shape with no HTTP",
    "  status; hook_surface.py makes no GitHub call, and its errors name repo files.",
    "- 8.8.0 changes no behaviour except the hook_surface text above: no stop becomes a repair. Step 6",
    "  (8.9.0: `recover` on every stop result and the skill re-run) keys on this class only.",
    "",
    "Counts of the call sites (a two-class site counts in both): " + counts + "; " + rows.length + " sites. The",
    "three stops that return without `halt` are listed after the table.",
    "",
    "<!-- prettier-ignore -->",
    "| # | Function | Gate | Class | Site | Reason |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map((r) => "| " + r.n + " | `" + r.fn + "` | " + r.gate + " | " + r.names + " | " + r.site + " | " + r.reason + " |"),
    "",
    "## Stops that return without halt",
    "",
    "These three stops return a result directly; each sets its class next to its stop gate.",
    "",
    "<!-- prettier-ignore -->",
    "| Function | Stop | Class | Reason |",
    "| --- | --- | --- | --- |",
    "| `autoFailResult` | auto-confirm: a check failed | safety | an auto-confirm gate (intent, scope, commands, hooks) failed: Max confirms the plan |",
    "| `planMode` | branch has build commits; resume_with build | mechanical | the skill runs build with the sealed plan_ref: a deterministic hop with no judgment |",
    "| `(top)` | build-engine was started without args | safety | an argument check |",
    "",
  ].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const want = render(readFileSync(SRC, "utf8"));
  if (process.argv.includes("--check")) {
    let have = "";
    try {
      have = readFileSync(DOC, "utf8");
    } catch {}
    if (have !== want) {
      console.error(DOC + " is not the table of " + SRC + ": run node plugins/ccpmcwf/tests/stop_classes_doc.mjs");
      process.exit(1);
    }
    console.log(DOC + " matches the source");
  } else {
    writeFileSync(DOC, want);
    console.log("wrote " + DOC);
  }
}
