// fleet 4.0.3 (ledger 1998): every value the script checks by type comes
// through a schema that types it. Run wf_d6901710-32d (4.0.2) stopped at
// preflight: `role scope-and-plan version missing in preflight (frozen
// minimum 29)`. The preflight agent relayed versions as strings ("29");
// roleTableProblem reads `typeof got === "number"`, and PREFLIGHT_SCHEMA had
// `versions: {type: "object"}` with no value type. The same model-variance
// class (a typed read through an untyped schema path) was open at the
// relayed program outputs (PROGRAM_OUT), test_cmd.env, the test writer's
// tests[].covers and the sweep's units.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { SOURCE, ARGS, happy, run, PROGRAM_LABELS } from "./harness.mjs";

// ---------------------------------------------------------------- schemas

const constBlock = (name, end) => {
  const i = SOURCE.indexOf("\nconst " + name + " = ");
  assert.ok(i >= 0, "const " + name + " in the workflow");
  return SOURCE.slice(i, SOURCE.indexOf(end, i) + end.length);
};
// the workflow's constants and schemas section (STRICT-widened role schemas
// included), plus the program output table and the PATH re-check schema
function loadSchemas() {
  const a = SOURCE.indexOf("// ---------------------------------------------------------------- constants");
  const b = SOURCE.indexOf("// ---------------------------------------------------------------- pure helpers");
  assert.ok(a >= 0 && b > a, "the constants and schemas section");
  const body =
    SOURCE.slice(a, b) +
    ["STRS", "BOOL", "INT", "STR_LISTS"].map((n) => constBlock(n, ";\n")).join("") +
    constBlock("PROGRAM_OUT", "\n};") +
    constBlock("PATH_RECHECK_SCHEMA", "\n};");
  return new Function(
    body +
      "\nreturn { SCHEMAS, INFRA_SCHEMA, INTAKE_SCHEMA, HASHER_SCHEMA, PREFLIGHT_SCHEMA, ROLE_RELAY_SCHEMA, PUSH_PROBE_SCHEMA, PATH_RECHECK_SCHEMA, PROGRAM_OUT, ROLES };",
  )();
}
const S = loadSchemas();

function schemaOf(id) {
  if (id.startsWith("role:")) return S.SCHEMAS[id.slice(5)];
  if (id.startsWith("prog:")) {
    const p = S.PROGRAM_OUT[id.slice(5)];
    return p ? { type: "object", properties: p } : null;
  }
  return {
    infra: S.INFRA_SCHEMA,
    intake: S.INTAKE_SCHEMA,
    hasher: S.HASHER_SCHEMA,
    preflight: S.PREFLIGHT_SCHEMA,
    role_relay: S.ROLE_RELAY_SCHEMA,
    push_probe: S.PUSH_PROBE_SCHEMA,
    path_recheck: S.PATH_RECHECK_SCHEMA,
  }[id];
}

// The nodes at a path: "a.b" properties, "[]" items, "*" every value of a map
// (additionalProperties and every declared property). [] when a step is untyped.
function nodesAt(root, path) {
  let nodes = [root];
  for (const seg of path ? path.split(".") : []) {
    const next = [];
    for (const n0 of nodes) {
      let name = seg;
      let items = false;
      if (name.endsWith("[]")) {
        items = true;
        name = name.slice(0, -2);
      }
      let ns;
      if (name === "*") {
        ns = [];
        const ap = n0 && n0.additionalProperties;
        if (!ap || typeof ap !== "object") return [];
        ns.push(ap);
        for (const v of Object.values((n0 && n0.properties) || {})) ns.push(v);
      } else if (name === "") ns = [n0];
      else ns = [n0 && n0.properties ? n0.properties[name] : undefined];
      for (let n of ns) {
        if (items) n = n && n.items;
        if (!n || typeof n !== "object") return [];
        next.push(n);
      }
    }
    nodes = next;
  }
  return nodes;
}

const ALLOWED = {
  string: ["string"],
  "string-re": ["string"],
  number: ["number", "integer"],
  "number-literal": ["number", "integer"],
  integer: ["integer"],
  boolean: ["boolean"],
  array: ["array"],
  object: ["object"],
};

// spec: "<schema id>:<path>" (the read needs exactly that type there, null
// aside), "!<id>:<path>" (a guard that refuses the type: the path is typed
// and never that type), "~<id>:<path>" (a filter over a role-owned union
// that includes the type), or "parsed: <why>" (not an agent result).
function specProblem(spec, kind) {
  if (spec.startsWith("parsed:")) return null;
  const mode = spec[0] === "!" || spec[0] === "~" ? spec[0] : "=";
  const s = mode === "=" ? spec : spec.slice(1);
  const i = s.indexOf(":", s.startsWith("role:") || s.startsWith("prog:") ? 5 : 0);
  const root = schemaOf(s.slice(0, i));
  if (!root) return "no schema " + s.slice(0, i);
  const nodes = nodesAt(root, s.slice(i + 1));
  if (!nodes.length) return "untyped path (a step has no schema)";
  const allowed = ALLOWED[kind];
  for (const n of nodes) {
    if (n.type === undefined) return "untyped node";
    const t = [].concat(n.type).filter((x) => x !== "null");
    if (!t.length) return "typed null only";
    if (mode === "=" && !t.every((x) => allowed.includes(x))) return "typed " + JSON.stringify(n.type) + ", read as " + kind;
    if (mode === "!" && t.some((x) => allowed.includes(x))) return "typed " + JSON.stringify(n.type) + ", guarded against " + kind;
    if (mode === "~" && !t.some((x) => allowed.includes(x))) return "typed " + JSON.stringify(n.type) + ", filtered for " + kind;
  }
  return null;
}

// ---------------------------------------------------------------- the reads

// Every type-sensitive read in the workflow, discovered from the source:
// typeof, Number.isInteger/isFinite, Array.isArray, === true/false, === an
// integer literal and <NAME>_RE.test(...). Key: "<expr> <kind> @ <function>"
// (the enclosing top-level function or const).
const E = String.raw`([A-Za-z_$][\w$]*(?:\??\.[\w$]+|\[[^\]]+\])*)`;
const PATTERNS = [
  [new RegExp(String.raw`typeof\s+` + E + String.raw`\s*[!=]==?\s*"(\w+)"`, "g"), (m) => m[2]],
  [new RegExp(String.raw`Number\.is(?:Integer|Finite|SafeInteger)\(\s*` + E + String.raw`\s*\)`, "g"), () => "integer"],
  [new RegExp(String.raw`Array\.isArray\(\s*` + E + String.raw`\s*\)`, "g"), () => "array"],
  [new RegExp(E + String.raw`\s*[!=]==\s*(?:true|false)\b`, "g"), () => "boolean"],
  [new RegExp(E + String.raw`\s*[!=]==\s*-?\d+\b`, "g"), () => "number-literal"],
  [new RegExp(String.raw`[A-Z_0-9]+_RE\.test\(\s*` + E + String.raw`\s*\)`, "g"), () => "string-re"],
];
// Each key maps to its number of occurrences: a READS entry is a spec (one
// occurrence) or [spec, n], so a new read that repeats an existing key (a
// nested function shares its parent's name) changes the count and fails.
function typedReads() {
  const out = new Map();
  let fn = "(top)";
  for (const line of SOURCE.split("\n")) {
    const f = /^(?:async\s+)?function\s+(\w+)/.exec(line) || /^const\s+(\w+)\s*=/.exec(line);
    if (f) fn = f[1];
    for (const [re, kind] of PATTERNS)
      for (const m of line.matchAll(re)) {
        const k = m[1] + " " + kind(m) + " @ " + fn;
        out.set(k, (out.get(k) || 0) + 1);
      }
  }
  return out;
}

const SP = "role:scope-and-plan:";
const OB = SP + "repo_obligations[]";
const CJ = "role:fleet-code-judge:";
const IJ = "role:fleet-intent-judge:";
const PARSED_REF = "parsed: the sealed plan ref (sha256-checked tag message, JSON.parse)";
const PARSED_PARK = "parsed: a parked findings.json (JSON.parse of digest-checked chunks)";
const PARSED_ROUND = "parsed: the script's round snapshot (or a parked findings.json)";
const PARSED_ARGS = "parsed: the workflow args";
const PARSED_LOCAL = "parsed: a script-built value";
const PARSED_TOKEN = "parsed: a token the script split from a typed string";

// fn -> {"<expr> <kind>": spec}. A read with no entry fails; so does an
// entry the source no longer has, and an agent path not typed for the read.
const READS = {
  STRICT: { "p.enum array": "parsed: a schema property, not an agent result" },
  stripHeldOut: { "v array": PARSED_LOCAL, "v object": PARSED_LOCAL },
  gatesNotRun: { "g object": CJ + "gates_not_run[]", "judgeList array": CJ + "gates_not_run" },
  // 5.0.0 (R1): the DISPATCH line comes from the relayed role text the script hashed
  parseDispatch: { "line string": "parsed: a line of the role text the script hashed against ROLE_SHA256" },
  sameState: { "length number-literal": PARSED_LOCAL },
  planFactsProblem: {
    "testCmd object": SP + "test_cmd",
    "testCmd array": "!" + SP + "test_cmd",
    "testCmd.command string": SP + "test_cmd.command",
    "obligations array": SP + "repo_obligations",
    "o object": OB,
    "o array": "!" + OB,
    "o.id string": OB + ".id",
    "o.instruction string": OB + ".instruction",
    "f string": OB + ".files[]",
    "o.files array": OB + ".files",
    "o.check_cmd string": OB + ".check_cmd",
  },
  relPath: { "p string": PARSED_LOCAL },
  parseCheckCmd: {
    "cmd string": OB + ".check_cmd",
    "cmd string-re": OB + ".check_cmd",
    "x string-re": PARSED_TOKEN,
    "t.length number-literal": PARSED_TOKEN,
    "t[1] string-re": PARSED_TOKEN,
    "i number-literal": PARSED_LOCAL,
  },
  testPathArg: { "x string-re": PARSED_TOKEN },
  testArgsProblem: { "x string-re": PARSED_TOKEN },
  splitTestCmd: { "cmd string-re": SP + "test_cmd.command", "expr string-re": PARSED_TOKEN },
  testCmdProblem: {
    "cmd string": SP + "test_cmd.command",
    "cmd string-re": SP + "test_cmd.command",
    "x string-re": [SP + "test_cmd.tools[]", 2],
    "x string": SP + "test_cmd.tools[]",
    "env object": SP + "test_cmd.env",
    "env array": "!" + SP + "test_cmd.env",
    "env[k] string": SP + "test_cmd.env.*",
    "env[k] string-re": [SP + "test_cmd.env.*", 2],
    "tc.tools array": SP + "test_cmd.tools",
  },
  criterionTestArgsProblem: { "ta string": SP + "criteria[].test_args", "testCmd.command string": SP + "test_cmd.command" },
  criterionCommand: { "c.test_args string": SP + "criteria[].test_args" },
  commandsOf: { "o.check_cmd string": OB + ".check_cmd", "o.check_cmd_rejected string": "parsed: the script's own demoted obligation" },
  obligationFailures: {
    "check array": CJ + "obligations_check",
    "e.met boolean": [CJ + "obligations_check[].met", 2],
    "notRun array": CJ + "gates_not_run",
    "o.check_cmd string": [OB + ".check_cmd", 2],
    "e.check_exit integer": CJ + "obligations_check[].check_exit",
    "e.check_exit number-literal": CJ + "obligations_check[].check_exit",
    "o.files array": OB + ".files",
  },
  canonical: { "v array": PARSED_LOCAL, "v object": PARSED_LOCAL },
  namesFor: { "raw string": PARSED_ARGS },
  planRefMetaProblem: { "e object": "prog:plan_ref:refs[]" },
  planRefEntryProblem: {
    "e object": "prog:plan_ref:refs[]",
    "e.content string": "parsed: message text, checked against its sha256 here",
    "e.sha256 string": "prog:plan_ref:refs[].sha256",
    "e.sha256 string-re": "prog:plan_ref:refs[].sha256",
  },
  relayDigestOk: {
    "r object": "parsed: any program relay (each slot is typed by PROGRAM_OUT, tested below)",
    "r.digest string": "parsed: every digest key is typed string in PROGRAM_OUT (tested below)",
    "r.digest string-re": "parsed: every digest key is typed string in PROGRAM_OUT (tested below)",
  },
  programProblem: {
    "r object": "parsed: any program relay",
    "r.program object": "infra:program",
    "r.program array": "!infra:program",
    "p.sha256 string": "infra:program.sha256",
  },
  nullable: { "p.enum array": "parsed: a schema property, not an agent result" },
  mergeProp: { "base object": "parsed: a schema property, not an agent result" },
  scriptsProbeOf: {
    "x string": "preflight:scripts_probe[]",
    "probe array": "preflight:scripts_probe",
    "homes.length number-literal": PARSED_LOCAL,
    "hits.length number-literal": PARSED_LOCAL,
    "hit string-re": PARSED_TOKEN,
    "reals.length number-literal": [PARSED_LOCAL, 2],
    "links.length number-literal": PARSED_LOCAL,
    // 5.0.0 (R1): the roles dir lines
    "rreals.length number-literal": [PARSED_LOCAL, 2],
    "rlinks.length number-literal": PARSED_LOCAL,
    "dir string": "preflight:scripts_dir",
  },
  scriptsMapProblem: { "map object": "hasher:scripts", "map array": "!hasher:scripts" },
  loadParked: {
    // the chunk lists, and the parked findings' symbols filter (parsed)
    "x string": ["prog:parked:parked.draft_chunks[]", 2],
    "a array": "prog:parked:parked.draft_chunks",
    "k object": "prog:parked:parked",
    "k.run string": "prog:parked:parked.run",
    "k.run string-re": "prog:parked:parked.run",
    "k.plan_path string": "prog:parked:parked.plan_path",
    "f object": [PARSED_PARK, 2],
    "f array": PARSED_PARK,
    "f.rounds array": [PARSED_PARK, 2],
    "x object": [PARSED_PARK, 2],
    "x array": PARSED_PARK,
    "c array": PARSED_PARK,
    "x.round number-literal": PARSED_PARK,
    "f.reason string": PARSED_PARK,
    "y object": PARSED_PARK,
    "x.findings array": PARSED_PARK,
    "f.symbols array": PARSED_PARK,
    "x string-re": PARSED_PARK,
    "r0.new_behaviour boolean": PARSED_PARK,
  },
  formatFiles: {
    "r.ran boolean": "prog:format_files:ran",
    "r.stable boolean": "prog:format_files:stable",
    "r.files array": "prog:format_files:files",
    "r.changed array": "prog:format_files:changed",
    "r.refused array": "prog:format_files:refused",
  },
  purgeBytecode: { "r.purged number": "infra:purged" },
  pathRelayProblem: {
    "pc.tools object": "prog:path_check:tools",
    "pc.tools array": "!prog:path_check:tools",
    "t object": "prog:path_check:tools.*",
    "t array": "!prog:path_check:tools.*",
    "t.path string": "prog:path_check:tools.*.path",
    "t.shim boolean": "prog:path_check:tools.*.shim",
    "pc.path_problems array": "prog:path_check:path_problems",
  },
  pathCheck: { "t.shim boolean": "prog:path_check:tools.*.shim" },
  collect: { "r.yadgar_findings array": SP + "yadgar_findings" },
  jsType: { "v array": "parsed: the drift check's own type helper" },
  typeMatches: { "v integer": "parsed: the drift check's own type helper" },
  hasher: {
    "h[m] object": "hasher:hashes.files",
    "h.suspicious array": "hasher:hashes.suspicious",
    "r.changed array": "hasher:changed",
    "r.digest string": "hasher:digest",
  },
  cleanRepo: { "r string": "intake:brief.repo" },
  // 5.0.0 (R1): the role file relay (roleTableProblem and rolesFromRef are gone)
  rolePrompt: { "text string": PARSED_LOCAL },
  roleRelayProblem: { "r.chunks array": "prog:role_files:chunks", "c string": "prog:role_files:chunks[]" },
  pushProbe: { "r.args array": "push_probe:args", "r.args.length number-literal": PARSED_LOCAL },
  workspaceStep: { "uc object": "infra:remote_url_check", "uc.url string": ["prog:remote_url:url", 2], "ws.remote_host string": "infra:remote_host" },
  briefProblem: {
    "b object": "intake:brief",
    "b.title string": "intake:brief.title",
    "b.sources array": "intake:brief.sources",
    "src.ref string": "intake:brief.sources[].ref",
    "b.plan_path string": "intake:brief.plan_path",
  },
  ledgerFor: { "project string": PARSED_ARGS, "project string-re": PARSED_ARGS },
  intakeHaltReason: {
    "it.reason string": "intake:reason",
    "t object": "intake:tried[]",
    "it.tried array": "intake:tried",
    "v string": "intake:tried[].ledger",
    "t.project string": "intake:tried[].project",
    "t.error string": "intake:tried[].error",
  },
  yaadgaarProjectProblem: { "sources array": "intake:brief.sources", "s.project string": "intake:brief.sources[].project" },
  yaadgaarIdProblem: {
    "t.call string": "intake:tried[].call",
    "tried array": "intake:tried",
    "s.id string": "intake:brief.sources[].id",
    "s.id string-re": "intake:brief.sources[].id",
  },
  cleanBrief: {
    "b.description string": "intake:brief.description",
    "src.url string": "intake:brief.sources[].url",
    "src.body string": "intake:brief.sources[].body",
    "src.id string": "intake:brief.sources[].id",
  },
  confusableCp: { "c number-literal": [PARSED_LOCAL, 2] },
  confusableIn: { "v string": "parsed: walks any plan text value", "v array": "parsed: walks any plan text value", "v object": "parsed: walks any plan text value" },
  screenCheckCmds: { "o.check_cmd string": OB + ".check_cmd" },
  scriptPathsOf: { "o.check_cmd string": OB + ".check_cmd" },
  checkScripts: { "r.checks object": "prog:script_check:checks", "o.check_cmd string": OB + ".check_cmd", "c.ok boolean": "prog:script_check:checks.*.ok" },
  planPathProblem: { "s string-re": "parsed: a path the caller type-checked" },
  roundSuffix: { "n number-literal": [PARSED_LOCAL, 2] },
  roundSnapshot: {
    "plan.criteria array": SP + "criteria",
    "plan.new_behaviour boolean": SP + "new_behaviour",
    "c object": SP + "criteria[]",
    "c array": "!" + SP + "criteria[]",
  },
  relaxedReasons: {
    "r0 object": PARSED_ROUND,
    "r0 array": PARSED_ROUND,
    "r0.criteria array": PARSED_ROUND,
    "r0.new_behaviour boolean": PARSED_ROUND,
    "now.new_behaviour boolean": PARSED_ROUND,
    "f.criterion string": PARSED_ROUND,
    "prior.findings array": PARSED_ROUND,
    "c0 object": PARSED_ROUND,
  },
  replanWithFindings: {
    "e object": SP + "changed_symbols[]",
    "rawMap array": SP + "changed_symbols",
    "e array": "!" + SP + "changed_symbols[]",
    "prior.symbols array": PARSED_ROUND,
    "x string": PARSED_ROUND,
    "x string-re": PARSED_ROUND,
    "prior.findings array": PARSED_ROUND,
    "prior.criteria_by_round array": PARSED_ROUND,
  },
  occurrenceKey: { "at string": SP + "changed_symbols[].occurrences[].at" },
  changedSymbolFindings: {
    "e object": SP + "changed_symbols[]",
    "e array": "!" + SP + "changed_symbols[]",
    "sym string": SP + "changed_symbols[].symbol",
    "sym string-re": SP + "changed_symbols[].symbol",
    "e.occurrences array": SP + "changed_symbols[].occurrences",
    "o object": SP + "changed_symbols[].occurrences[]",
    "o.criterion string": SP + "changed_symbols[].occurrences[].criterion",
    "o.dont_care string": SP + "changed_symbols[].occurrences[].dont_care",
  },
  docOrLockFile: { "b string-re": [PARSED_TOKEN, 2] },
  callerCheck: {
    "occ object": "prog:callers:occurrences",
    "occ array": "!prog:callers:occurrences",
    "r.capped array": "prog:callers:capped",
    "x string": ["prog:callers:occurrences.*[]", 2],
    "occ[n] array": "prog:callers:occurrences.*",
    "r.doctest_md array": "prog:callers:doctest_md",
    "r.auto_dont_care object": "prog:callers:auto_dont_care",
    "r.auto_dont_care array": "!prog:callers:auto_dont_care",
    "adc[n] array": "prog:callers:auto_dont_care.*",
    "h string": ["prog:callers:auto_dont_care.*[]", 2],
  },
  buildCallerFindings: { "d.end number": "prog:changed_defs:defs[].end", "d.name string-re": "prog:changed_defs:defs[].name" },
  buildCallerCheck: {
    "r.defs array": "prog:changed_defs:defs",
    "x string": "prog:changed_defs:excluded[]",
    "r[k] array": "prog:changed_defs:unclassified",
    "d.name string": "prog:changed_defs:defs[].name",
    "d.at string": "prog:changed_defs:defs[].at",
    "d.end number": "prog:changed_defs:defs[].end",
    "r.digest string": "prog:changed_defs:digest",
  },
  hookSurface: { "r.surface array": "prog:hook_surface:surface" },
  isHookPath: { "p string-re": PARSED_LOCAL },
  planScopePaths: {
    "f string": SP + "criteria[].test_files[]",
    "c.test_files array": SP + "criteria[].test_files",
    "pf.changed_symbols array": SP + "changed_symbols",
    "e.occurrences array": SP + "changed_symbols[].occurrences",
    "o.at string": SP + "changed_symbols[].occurrences[].at",
  },
  makeTargets: { "o.check_cmd string": OB + ".check_cmd" },
  planScopeFiles: {
    "pf.allowed_additions.files array": SP + "allowed_additions.files",
    "f string": [SP + "allowed_additions.files[]", 2],
    "o.files array": OB + ".files",
  },
  afterRounds: { "n number-literal": PARSED_LOCAL },
  planAndAudit: {
    "plan.plan_path string": SP + "plan_path",
    "plan.criteria array": SP + "criteria",
    "x string": SP + "plan_diff[]",
    "plan.plan_diff array": SP + "plan_diff",
    "plan.tldr string": SP + "tldr",
    "plan.changed_symbols array": SP + "changed_symbols",
    "plan.est_diff_lines number": SP + "est_diff_lines",
    "plan.new_behaviour boolean": SP + "new_behaviour",
    "plan[HELD_OUT_KEY] array": SP + "held_out_examples",
    "fmt.changed_paths array": "infra:changed_paths",
    "plan.fleet_estimate object": SP + "fleet_estimate",
    "est.criteria number": SP + "fleet_estimate.criteria",
    "est.agents number": SP + "fleet_estimate.agents",
    "est.rounds number": SP + "fleet_estimate.rounds",
  },
  isShortPath: { "pf.est_diff_lines number": SP + "est_diff_lines", "pf.new_behaviour boolean": SP + "new_behaviour" },
  commitPlanAndRef: {
    "stagedSha string": "prog:plan_hash:plan_sha256",
    "stagedSha string-re": "prog:plan_hash:plan_sha256",
    "r.head string": "prog:plan_ref_write:head",
    "r.tag_sha string": "prog:plan_ref_write:tag_sha",
    "r.head string-re": "prog:plan_ref_write:head",
    "r.tag_sha string-re": "prog:plan_ref_write:tag_sha",
    "r.reused boolean": "infra:reused",
  },
  verifyPlanCommit: {
    "pf.head string": "prog:plan_files:head",
    "pf.files array": "prog:plan_files:files",
    "pf.head string-re": "prog:plan_files:head",
    "pf.dsn_paths array": "prog:plan_files:dsn_paths",
    "ph.plan_sha256 string": "prog:plan_hash:plan_sha256",
    "ph.plan_sha256 string-re": "prog:plan_hash:plan_sha256",
    "pr.refs array": "prog:plan_ref:refs",
    "files.length number-literal": PARSED_LOCAL,
  },
  makePlanRef: { "f.project string": PARSED_ARGS },
  preflightRecordProblem: {
    "p object": PARSED_REF,
    "p array": PARSED_REF,
    "p.fleet_version string": PARSED_REF,
    // 5.0.0 (R1): {fleet_version, role_sha256}; a 4.x record's maps are not read
    "p.role_sha256 object": PARSED_REF,
    "p.role_sha256 array": PARSED_REF,
  },
  isPlanCommit: {
    "c.files array": "prog:branch_scan:commits[].files",
    "e.sha256 string": "prog:branch_scan:refs[].sha256",
    "e.sha256 string-re": "prog:branch_scan:refs[].sha256",
    "e.plan_path string": "prog:branch_scan:refs[].plan_path",
    "e.ref_ok boolean": "prog:branch_scan:refs[].ref_ok",
    "files.length number-literal": PARSED_LOCAL,
  },
  validRemoteUrl: { "u string": "prog:remote_url:url" },
  fencePathProblem: { "q string-re": PARSED_LOCAL },
  scopeProblems: { "f string": [SP + "allowed_additions.files[]", 2], "aa.files array": SP + "allowed_additions.files" },
  hookIdProblems: { "cfg.present boolean": "prog:precommit_ids:present", "cfg.ids array": "prog:precommit_ids:ids" },
  intentProblems: {
    "d.allowed_by string": IJ + "deviations[].allowed_by",
    "d.fails_closed boolean": IJ + "deviations[].fails_closed",
    "r.coverage.covered boolean": IJ + "coverage.covered",
    "cl object": IJ + "classification",
    "cl array": "!" + IJ + "classification",
    "cl.quote string": IJ + "classification.quote",
  },
  autoGates: { "r.deviations array": IJ + "deviations", "r.classification object": IJ + "classification" },
  defaultBlockers: { "pf.new_behaviour boolean": SP + "new_behaviour", "raw string-re": PARSED_ARGS },
  planMode: {
    "input.input string": PARSED_ARGS,
    "raw string-re": PARSED_ARGS,
    "scan.commits array": "prog:branch_scan:commits",
    "scan.refs array": "prog:branch_scan:refs",
    "tip integer": "prog:branch_scan:plan_tip_time",
    "pk.clean boolean": "infra:clean",
  },
  tinyRefProblem: {
    "t object": PARSED_ARGS,
    "t.branch string": PARSED_ARGS,
    "t.branch string-re": PARSED_ARGS,
    "t.plan_commit string": PARSED_ARGS,
    "t.plan_commit string-re": PARSED_ARGS,
    "t.plan_ref string": PARSED_ARGS,
    "t.ref_sha256 string": PARSED_ARGS,
    "t.ref_sha256 string-re": PARSED_ARGS,
  },
  planRefProblem: {
    "r object": PARSED_REF,
    "r.seal string": PARSED_REF,
    "r[k] string": PARSED_REF,
    "r.plan_sha256 string-re": PARSED_REF,
    "r.criteria array": PARSED_REF,
    "r.history object": PARSED_REF,
    "r.project string": PARSED_REF,
  },
  // 5.0.0 (R1): buildMode no longer reads fresh_preflight (main still type-checks it)
  buildMode: { "input.plan_ref object": PARSED_ARGS, "input.freeze_digest string": PARSED_ARGS },
  buildFromRef: {
    "r.refs array": "prog:plan_ref:refs",
    "c string": "prog:plan_ref:chunks[]",
    "r.chunks array": "prog:plan_ref:chunks",
    "loaded.project string": PARSED_REF,
    "pf object": PARSED_REF,
    "pf.commands array": PARSED_REF,
    "o.check_cmd string": PARSED_REF,
    "pf.remote_url string": PARSED_REF,
    "input.freeze_digest string": [PARSED_ARGS, 3],
    "v.head string": "prog:verify_since:head",
    "v.head string-re": "prog:verify_since:head",
    "v.is_ancestor boolean": ["prog:verify_since:is_ancestor", 2],
    "v.commits_since array": "prog:verify_since:commits_since",
    "v.plan_touched array": "prog:verify_since:plan_touched",
    "v.changed_since array": "prog:verify_since:changed_since",
    "ref.plan_facts.est_diff_lines number": PARSED_REF,
    "pf.new_behaviour boolean": PARSED_REF,
    "pf.changed_symbols array": PARSED_REF,
    "rs.exists boolean": "prog:read_state:exists",
    "st object": ["parsed: JSON.parse of the run-state message (digest-checked read_state)", 2],
    "st.approved_sha string": "parsed: JSON.parse of the run-state message (digest-checked read_state)",
    "rs.clean boolean": "prog:read_state:clean",
    "refTree string": "hasher:hashes.git.*",
    "ref.plan_diff array": PARSED_REF,
    "x string": "prog:tf_gate:iac_files[]",
    "a array": "prog:tf_gate:iac_files",
    "r.touched boolean": "prog:tf_gate:touched",
    "rh.head string": "prog:remote_head:head",
    "r.diff array": "prog:fleet_scan:diff",
    "r.commits array": "prog:fleet_scan:commits",
    "c.files array": "prog:fleet_scan:commits[].files",
    "r.gates_not_run_stated boolean": "role:fleet-pr-opener:gates_not_run_stated",
    "r.state_sha string": "prog:state_write:state_sha",
    "pa[0] string": "prog:push_classify:args[]",
    "pa array": "prog:push_classify:args",
    "pa.length number-literal": PARSED_LOCAL,
    "push.hook_tail string": "prog:push_classify:hook_tail",
    "push.exit_code number-literal": "prog:push_classify:exit_code",
    "resume.rounds object": "parsed: the run-state (JSON.parse of a digest-checked message)",
    "t object": "~role:fleet-test-writer:tests[]",
    "t.covers string": "role:fleet-test-writer:tests[].covers",
    "i number-literal": PARSED_LOCAL,
    "e.name string": "prog:plan_ref:refs[].name",
    "cs.head string": "infra:head",
    "cs.head string-re": "infra:head",
  },
  reviewStep: {
    "rp.changed_paths array": "prog:review_paths:changed_paths",
    "p string-re": PARSED_LOCAL,
    "r.touches_gate boolean": ["role:pr-review:touches_gate", 2],
    "u.shipped_refuses boolean": "role:gate-change-nonweakening-sweep:units[].shipped_refuses",
    "u.new_refuses boolean": "role:gate-change-nonweakening-sweep:units[].new_refuses",
  },
  writeBodies: {
    "ctx.project string": PARSED_ARGS,
    "ctx.project string-re": PARSED_ARGS,
    "t.title string": "infra:results[].title",
    "r.results array": "infra:results",
    "h.page_tags array": "infra:results[].page_tags",
    "h.has_marker boolean": "infra:results[].has_marker",
  },
  writeBack: {
    "pre.results array": "infra:results",
    "h.body_slug string": "infra:results[].body_slug",
    "r.results array": ["infra:results", 2],
    "s.id string": "parsed: a cleanBrief source of the sealed plan ref",
    "rd.results array": "infra:results",
    "h.id string": "infra:results[].id",
    "h.version integer": "infra:results[].version",
    "h.has_marker boolean": "infra:results[].has_marker",
    "s.text string-re": PARSED_LOCAL,
    "l.results array": "infra:results",
    "hit.has_marker boolean": "infra:results[].has_marker",
    "p.results array": "infra:results",
  },
  testDbDeclProblem: {
    // the repo's own .fleet-test-db.json: these checks ARE the refusal of a wrong file
    "d object": "parsed: the repo's declaration file (test_db_decl decl)",
    "d array": "parsed: the repo's declaration file (test_db_decl decl)",
    "d.version number-literal": "parsed: the repo's declaration file (test_db_decl decl)",
    "d.major string": "parsed: the repo's declaration file (test_db_decl decl)",
    "d.env string": "parsed: the repo's declaration file (test_db_decl decl)",
    "d.env string-re": "parsed: the repo's declaration file (test_db_decl decl)",
  },
  dbUsersOk: { "users object": "prog:db_up:users", "users array": "!prog:db_up:users", "users[d] string": "prog:db_up:users.*" },
  testDbStep: {
    "t object": "infra:test_db",
    "name string-re": PARSED_LOCAL,
    "sw.removed array": "prog:db_sweep:removed",
    "sw.errors array": "prog:db_sweep:errors",
    "u.port integer": "prog:db_up:port",
    "ex object": "prog:db_up:expiry",
    "ex.expires integer": "prog:db_up:expiry.expires",
  },
  dbTeardown: {
    "r object": "parsed: any agent result (a null or non-object is refused)",
    "d.removed boolean": "prog:db_down:removed",
    "d.absent boolean": "prog:db_down:absent",
    "d.error string": "prog:db_down:error",
  },
  main: {
    "input.fresh_preflight boolean": PARSED_ARGS,
    "input.date string": PARSED_ARGS,
    "input.date string-re": PARSED_ARGS,
    "input.run_nonce string": PARSED_ARGS,
    "input.run_nonce string-re": PARSED_ARGS,
    "input.freeze_digest string": PARSED_ARGS,
    "input string": PARSED_ARGS,
    "input object": PARSED_ARGS,
    "length number-literal": PARSED_LOCAL,
  },
};

test("4.0.3 1998: every type-sensitive read in the workflow has a READS entry, and every agent path it names is typed for that read", () => {
  const found = typedReads();
  assert.ok(found.size >= 380, "reads discovered: " + found.size);
  const table = new Map();
  for (const [fn, m] of Object.entries(READS)) for (const [k, e] of Object.entries(m)) table.set(k + " @ " + fn, Array.isArray(e) ? e : [e, 1]);
  const problems = [];
  for (const [key, count] of found) {
    const entry = table.get(key);
    if (entry === undefined) {
      problems.push(key + ": no READS entry (map it to the schema path the value comes through, or mark it parsed)");
      continue;
    }
    const [spec, n] = entry;
    if (count !== n) problems.push(key + ": " + count + " occurrence(s), READS says " + n + " (map the new read, then set the count)");
    const kind = key.split(" @ ")[0].split(" ").pop();
    const p = specProblem(spec, kind);
    if (p) problems.push(key + " -> " + spec + ": " + p);
  }
  for (const key of table.keys()) if (!found.has(key)) problems.push(key + ": stale READS entry");
  assert.deepEqual(problems, []);
  const agent = [...table.values()].filter(([s]) => !s.startsWith("parsed:")).length;
  assert.ok(agent >= 200, "agent-path reads checked: " + agent);
});

// 5.0.0 (R1): the 4.0.2 preflight versions map is gone; the same check on the
// relay's chunks (an array with no item type is untyped for a string read)
test("4.0.3 1998: the READS check catches an untyped path (5.0.0: a relay chunks array with no item type fails it)", () => {
  const old = S.PROGRAM_OUT.role_files.chunks;
  S.PROGRAM_OUT.role_files.chunks = { type: "array" };
  try {
    assert.equal(specProblem("prog:role_files:chunks[]", "string"), "untyped path (a step has no schema)");
  } finally {
    S.PROGRAM_OUT.role_files.chunks = old;
  }
  assert.equal(specProblem("prog:role_files:chunks[]", "string"), null);
  // a string-typed path read as a number fails; a guard and a union pass
  assert.match(specProblem("preflight:scripts_dir", "number"), /typed \["string","null"\], read as number/);
  assert.equal(specProblem("!prog:callers:auto_dont_care", "array"), null);
  assert.equal(specProblem("~role:fleet-test-writer:tests[]", "object"), null);
});

// ---------------------------------------------------------------- program outputs

// the keys each program prints (PROGRAM_LABELS' digest keys; the hasher's are
// HASHER_SCHEMA's), plus the keys the script reads from a digest-less program
const UNDIGESTED = { plan_hash: ["plan_sha256"], plan_ref: ["refs", "chunks"], role_files: ["role", "chunks"] };

function fullyTyped(n, at, out) {
  if (!n || typeof n !== "object" || n.type === undefined) return out.push(at + ": untyped");
  const t = [].concat(n.type);
  if (t.includes("array")) fullyTyped(n.items, at + "[]", out);
  if (t.includes("object") && !n.properties && !n.additionalProperties && !/\.decl$/.test(at)) out.push(at + ": object with no typed keys");
  for (const [k, v] of Object.entries(n.properties || {})) fullyTyped(v, at + "." + k, out);
  if (n.additionalProperties && typeof n.additionalProperties === "object") fullyTyped(n.additionalProperties, at + ".*", out);
  return out;
}

test("4.0.3 1998: PROGRAM_OUT types every key each shipped program prints, at every depth (the decl file aside)", () => {
  const progs = new Map();
  for (const [, slots] of PROGRAM_LABELS) for (const [, name, keys] of slots) if (name !== "hasher") progs.set(name, keys || UNDIGESTED[name]);
  const problems = [];
  for (const [name, keys] of progs) {
    const out = S.PROGRAM_OUT[name];
    if (!out) {
      problems.push(name + ": no PROGRAM_OUT entry");
      continue;
    }
    for (const k of keys) if (!out[k]) problems.push(name + "." + k + ": not in PROGRAM_OUT");
    if (keys !== UNDIGESTED[name] && !(out.digest && out.digest.type === "string")) problems.push(name + ".digest: not typed string");
    for (const [k, v] of Object.entries(out)) fullyTyped(v, name + "." + k, problems);
  }
  // the hasher's keys live in HASHER_SCHEMA
  fullyTyped(S.HASHER_SCHEMA.properties.hashes, "hasher.hashes", problems);
  fullyTyped(S.HASHER_SCHEMA.properties.fingerprint, "hasher.fingerprint", problems);
  assert.deepEqual(problems, []);
  assert.deepEqual(Object.keys(S.PROGRAM_OUT).sort(), [...progs.keys(), "hasher"].sort(), "one entry per shipped program");
});

test("4.0.3 1998: every program-running dispatch gets the program's typed keys at each slot (per-call schema)", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  let n = 0;
  for (const c of out.calls) {
    const hit = PROGRAM_LABELS.find(([re]) => re.test(c.label));
    if (!hit || !c.opts.schema) continue;
    for (const [slot, name] of hit[1]) {
      const base = slot === null ? c.opts.schema : c.opts.schema.properties[slot];
      if (!base || !base.properties || !base.properties.program) continue;
      for (const [k, want] of Object.entries(S.PROGRAM_OUT[name] || {})) {
        n++;
        const got = base.properties[k];
        assert.ok(got, c.label + ": " + (slot || "top") + "." + k + " missing");
        const strip = (t) => [].concat(t).filter((x) => x !== "null").sort();
        assert.deepEqual(strip(got.type), strip(want.type), c.label + ": " + (slot || "top") + "." + k);
        // merged into the base property (4.0.3 review): every PROGRAM_OUT type is there, the base may add keys
        const holds = (g, w, at) => {
          if (!w) return;
          assert.ok(g, c.label + ": " + at + " missing");
          assert.deepEqual(strip(g.type), strip(w.type), c.label + ": " + at);
          holds(g.items, w.items, at + "[]");
          holds(g.additionalProperties, w.additionalProperties, at + ".*");
          for (const [q, v] of Object.entries(w.properties || {})) holds((g.properties || {})[q], v, at + "." + q);
        };
        holds(got, want, (slot || "top") + "." + k);
      }
    }
  }
  assert.ok(n >= 100, "typed slot keys checked: " + n);
});

// ---------------------------------------------------------------- validation

// A minimal JSON-schema validator: type (incl. integer), properties,
// required, additionalProperties (schema or bool), items, enum.
function validate(s, v, at = "$", out = []) {
  if (!s || typeof s !== "object") return out;
  if (s.type !== undefined) {
    const t = [].concat(s.type);
    const js = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
    const ok = t.some((x) => x === js || (x === "integer" && js === "number" && Number.isInteger(v)));
    if (!ok) {
      out.push(at + ": " + JSON.stringify(v) + " is not " + t.join("|"));
      return out;
    }
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => e === v)) out.push(at + ": " + JSON.stringify(v) + " not in enum");
  if (Array.isArray(v)) {
    if (s.items) v.forEach((x, i) => validate(s.items, x, at + "[" + i + "]", out));
  } else if (v && typeof v === "object") {
    for (const k of s.required || []) if (!(k in v)) out.push(at + "." + k + ": required");
    for (const [k, x] of Object.entries(v)) {
      if (s.properties && k in s.properties) validate(s.properties[k], x, at + "." + k, out);
      else if (s.additionalProperties === false) out.push(at + "." + k + ": not allowed");
      else if (s.additionalProperties && typeof s.additionalProperties === "object") validate(s.additionalProperties, x, at + "." + k, out);
    }
  }
  return out;
}

const ints = (n) => Object.fromEntries(S.ROLES.map((r, i) => [r, n + i]));

// 5.0.0 (R1): was "a preflight with string versions fails its schema; integer
// versions pass". The preflight relays no role table now; the typed relay is
// the role file relay. Its per-call schema refuses chunks that are not a list
// of strings, and the probe lines must be strings.
test("5.0.0 R1 (was 4.0.3 1998 repro wf_d6901710-32d): the preflight and role relay schemas refuse mistyped values", async () => {
  const out = await run(happy(), ARGS);
  const pre = out.calls.find((c) => c.label === "preflight").opts.schema;
  assert.deepEqual(validate(pre, { scripts_probe: ["home=/h"], scripts_dir: null, path_check: null, reason: "ok" }), []);
  assert.ok(validate(pre, { scripts_probe: [1], scripts_dir: null, path_check: null, reason: "ok" }).length);
  assert.ok(validate(pre, { scripts_probe: "home=/h", scripts_dir: null, path_check: null, reason: "ok" }).length);
  const sch = out.calls.find((c) => c.label === "infra:role-relay:plan-audit").opts.schema;
  const prog = { name: "role_files", sha256: "a".repeat(64) };
  const good = { status: "ok", reason: "relayed", role: "plan-audit", chunks: ["# x", "y"], program: prog, file_sha256: "a".repeat(64) };
  assert.deepEqual(validate(sch, good), []);
  assert.ok(validate(sch, Object.assign({}, good, { chunks: "# x y" })).length, "chunks as one string");
  assert.ok(validate(sch, Object.assign({}, good, { chunks: ["# x", 2] })).length, "a non-string chunk");
  assert.ok(validate(sch, Object.assign({}, good, { role: 3 })).length);
  const { program, ...noProgram } = good;
  assert.deepEqual(validate(sch, noProgram), ["$.program: required"]);
  // a failed relay may give null
  assert.deepEqual(validate(sch, { status: "failed", reason: "exit 1", role: null, chunks: null, program: null, file_sha256: null }), []);
});

// 5.0.0 (R1): was "the run still stops on a string version that reaches the
// script". A mistyped chunk that reaches the script still stops the run.
test("5.0.0 R1 (was 4.0.3 1998 string version reaches the script): a non-string chunk that reaches the script stops the run (the check is not loosened)", async () => {
  const s = happy();
  s.__mutate = { label: /^infra:role-relay:scope-and-plan/, fn: (r) => Object.assign(r, { chunks: r.chunks.concat([29]) }) };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "contract");
  assert.match(out.result.reason, /role file scope-and-plan hash mismatch .*relay returned no chunks/);
});

test("4.0.3 1998: every result the happy run's agents return fits the schema they were given", async () => {
  const s = happy();
  const got = [];
  s.__mutate = { label: /./, fn: (r, prompt) => (got.push([prompt, r]), r) };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const used = new Set();
  const problems = [];
  for (const [prompt, r] of got) {
    const i = out.calls.findIndex((c, j) => !used.has(j) && c.prompt === prompt);
    assert.ok(i >= 0, "a call for each result");
    used.add(i);
    const c = out.calls[i];
    if (c.opts.schema) for (const e of validate(c.opts.schema, JSON.parse(JSON.stringify(r)))) problems.push(c.label + " " + e);
  }
  assert.ok(got.length >= 40, "results checked: " + got.length);
  assert.deepEqual(problems, []);
});

// 5.0.0 (R1): was "the preflight prompt asks for every role key and integer
// versions". The relay prompt asks for every part, in order, copied exactly.
test("5.0.0 R1 (was 4.0.3 1998 preflight prompt): the relay prompt runs every part in order and asks for the chunks copied exactly", async () => {
  const out = await run(happy(), ARGS);
  const p = out.calls.find((c) => c.label === "infra:role-relay:plan-audit").prompt;
  assert.match(p, /role_files\.py' '\/home\/u\/\.claude\/plugins\/cache\/mkt\/fleet\/4\.0\.3\/roles' 'plan-audit' '0'/);
  assert.match(p, /part 7: sha256sum -- /);
  assert.match(p, /chunks = every chunk of part 0, then every chunk of part 1, and so on, in order, each one copied exactly, byte for byte/);
  assert.match(p, /NEVER shorten, summarise/);
  const pre = out.calls.find((c) => c.label === "preflight").prompt;
  assert.doesNotMatch(pre, /versions|contract|agent_prompt_get/);
  assert.match(pre, /Return \{scripts_probe, scripts_dir, path_check, reason\}\./);
});

// ---------------------------------------------------------------- 4.0.3 review

// the workflow's programSchema (and its helpers) over the loaded schemas
function loadProgramSchema() {
  const grab = (name) => {
    const i = SOURCE.indexOf("\nfunction " + name + "(");
    assert.ok(i >= 0, "function " + name);
    return SOURCE.slice(i, SOURCE.indexOf("\n}\n", i) + 3);
  };
  const fns = ["nullable", "mergeProp", "programSchema"].map(grab).join("");
  return new Function("PROGRAM_OUT", "PROGRAM_PROP", constBlock("FILE_SHA_HEX", ";\n") + fns + "\nreturn programSchema;")(
    S.PROGRAM_OUT,
    S.INFRA_SCHEMA.properties.program,
  );
}

test("4.0.3 review: fields the script never reads accept null where the role page allows no value", () => {
  const tw = S.SCHEMAS["fleet-test-writer"].properties.tests;
  // a guards_existing test passes on current code: no red_kind, no failure excerpt
  assert.deepEqual(validate(tw, [{ file: "t.py", name: "t1", covers: "AC1: x", red_kind: null, failure_excerpt: null }]), []);
  // covers is the short-path split key: still a string
  assert.ok(validate(tw, [{ file: "t.py", name: "t1", covers: null }]).length);
  const units = S.SCHEMAS["gate-change-nonweakening-sweep"].properties.units;
  // a broken instrument: no measured verdict
  assert.deepEqual(validate(units, [{ unit: "u", mutation: "m", shipped_refuses: null, new_refuses: null }]), []);
  assert.ok(validate(units, [{ unit: "u", mutation: "m", shipped_refuses: "true", new_refuses: false }]).length);
});

test("4.0.3 review: PROGRAM_OUT merges into the base schema; no item requirement or typed key of INFRA_SCHEMA is lost", () => {
  const ps = loadProgramSchema();
  const at = (name) => ps(S.INFRA_SCHEMA, [[null, name]]).properties;
  const vs = at("verify_since");
  assert.deepEqual(vs.commits_since.items.required, ["sha", "subject"]);
  assert.ok(validate(vs.commits_since, [{ sha: "a" }]).length, "commits_since[] still requires subject");
  const cd = at("changed_defs");
  assert.deepEqual(cd.defs.items.required, ["name", "at", "end"]);
  assert.deepEqual(cd.defs.items.properties.end, { type: "integer" });
  const bs = at("branch_scan");
  assert.deepEqual(bs.commits.items.properties.ref_content, { type: ["string", "null"] });
  assert.deepEqual(bs.commits.items.required, ["sha", "subject"]);
  assert.deepEqual(bs.commits.items.properties.files, { type: "array", items: { type: "string" } });
  // fleet_scan prints commits without a subject: a base requirement the program never fills is not kept
  const fs = at("fleet_scan");
  assert.deepEqual(fs.commits.items.required, ["sha"]);
  assert.deepEqual(validate(fs.commits, [{ sha: "a", files: ["x"] }]), []);
  // remote_head prints head null when origin has no branch; 4.0.2 refused it (INFRA head: string)
  const rh = at("remote_head");
  assert.deepEqual(validate(rh.head, null), []);
  assert.deepEqual(validate(rh.head, "abc"), []);
  // a nested slot keeps the base slot's typed keys too
  const pf = ps(S.INFRA_SCHEMA, [["plan_files", "plan_files"]]).properties.plan_files;
  assert.deepEqual(pf.properties.head, { type: "string" });
  assert.deepEqual(pf.required.slice().sort(), ["file_sha256", "program"]);
  // the shared schema is never changed
  assert.deepEqual(S.INFRA_SCHEMA.properties.commits_since.items.required, ["sha", "subject"]);
  assert.equal(S.INFRA_SCHEMA.properties.head.type, "string");
});
