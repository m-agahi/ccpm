#!/usr/bin/env node
// Writes the PROGRAM_SHA256, ROLE_SHA256, ROLE_DISPATCH and SHARED_SHA256 tables of
// workflows/build-task-run.js from the shipped files: the programs
// plugins/fleet/scripts/*.py (fleet 4.0.1, ledger 1996), the role prompts
// plugins/fleet/roles/*.md (fleet 5.0.0, R1, ledger 1999) and the shared prompt
// files plugins/fleet/roles/_shared/*.md (5.0.0, R3). The files are the source
// of truth; each _SHA256 table holds the sha256 of each file's exact bytes,
// sorted by name, between its _BEGIN and _END markers; ROLE_DISPATCH holds each
// role file's first DISPATCH line. The workflow does not embed the file text:
// Claude Code skips a workflow file over 524288 bytes.
//
//   node plugins/fleet/scripts/gen.mjs            write the tables
//   node plugins/fleet/scripts/gen.mjs --check    exit 1 when a table and the files differ,
//                                                 a count is not PROGRAM_COUNT / ROLE_COUNT /
//                                                 SHARED_COUNT, or the roles dir (or _shared,
//                                                 its only subdir) holds a file that is not one
// Both modes refuse a role or shared file the Read tool would cut (over
// ROLE_MAX_LINES lines, a line over ROLE_MAX_LINE characters, over
// ROLE_MAX_CHARS characters) and a role file with no DISPATCH line whose tier
// is in the workflow's TIERS.
//   --scripts <dir>  --roles <dir>  --workflow <file>   other paths (tests)

import { readFileSync, writeFileSync, readdirSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const WORKFLOW = join(HERE, "..", "workflows", "build-task-run.js");
export const SCRIPTS = HERE;
export const ROLES_DIR = join(HERE, "..", "roles");
// the number of shipped programs (28 since 4.0.0; 29 since 5.0.3: plan_dsn; 30 since 5.0.5: ignored_diff; 31 since 5.0.6: build_dir; 31 in 5.0.7: hash_diff replaces ignored_diff; 32 since 5.0.8: gh_identity; 33 since 5.0.9: session_project; 34 since 6.0.0: ruleset_surface; 35: policy; 36: pr_convention; 37: pr_body_block; 38: pr_state; 39: orch_scan; 40: ci_watch)
export const PROGRAM_COUNT = 40;
// the number of shipped role prompts (5.0.0)
// 11 since 6.0.0: fleet-ci-classifier
export const ROLE_COUNT = 11;
// the number of shared prompt files in roles/_shared (5.0.0, R3: the test_cmd allowlist)
export const SHARED_COUNT = 1;
export const SHARED_SUBDIR = "_shared";
// 5.0.0 (review of d8df90b): a role agent reads its file with the Read tool,
// which returns 2000 lines by default and cuts a longer line at 2000
// characters; 40000 characters in all
export const ROLE_MAX_LINES = 2000;
export const ROLE_MAX_LINE = 2000;
export const ROLE_MAX_CHARS = 40000;

const TABLE_RE = /\n\/\/ PROGRAM_SHA256_BEGIN\nconst PROGRAM_SHA256 = (\{[^`]*?\});\n\/\/ PROGRAM_SHA256_END\n/;
const ROLE_TABLE_RE = /\n\/\/ ROLE_SHA256_BEGIN\nconst ROLE_SHA256 = (\{[^`]*?\});\n\/\/ ROLE_SHA256_END\n/;
const DISPATCH_TABLE_RE = /\n\/\/ ROLE_DISPATCH_BEGIN\nconst ROLE_DISPATCH = (\{[^`]*?\});\n\/\/ ROLE_DISPATCH_END\n/;
const SHARED_TABLE_RE = /\n\/\/ SHARED_SHA256_BEGIN\nconst SHARED_SHA256 = (\{[^`]*?\});\n\/\/ SHARED_SHA256_END\n/;

function sha(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

// {name: sha256} of every <dir>/*.py, sorted by name
export function fileTable(dir = SCRIPTS) {
  const out = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".py")).sort()) out[f.slice(0, -3)] = sha(join(dir, f));
  return out;
}

// {name: sha256} of every <dir>/*.md, sorted by name, and the entries that are
// not a regular .md file (extra files, symlinks, directories). The one real
// (not symlinked) directory _shared is skipped here: sharedFileTable reads it.
export function roleFileTable(dir = ROLES_DIR) {
  const out = {};
  const extra = [];
  for (const f of readdirSync(dir).sort()) {
    const st = lstatSync(join(dir, f));
    if (f === SHARED_SUBDIR && st.isDirectory()) continue;
    if (!f.endsWith(".md") || !st.isFile() || !/^[a-z][a-z-]*\.md$/.test(f)) extra.push(f);
    else out[f.slice(0, -3)] = sha(join(dir, f));
  }
  return { table: out, extra };
}

// 5.0.0 (R3): {name: sha256} of every <dir>/_shared/*.md, and its entries that
// are not a regular .md file (as "_shared/<entry>"). No _shared dir: {} and [].
export function sharedFileTable(dir = ROLES_DIR) {
  const out = {};
  const extra = [];
  const sd = join(dir, SHARED_SUBDIR);
  let st = null;
  try {
    st = lstatSync(sd);
  } catch {
    return { table: out, extra };
  }
  if (!st.isDirectory()) return { table: out, extra };
  for (const f of readdirSync(sd).sort()) {
    const fst = lstatSync(join(sd, f));
    if (!fst.isFile() || !/^[a-z][a-z-]*\.md$/.test(f)) extra.push(SHARED_SUBDIR + "/" + f);
    else out[f.slice(0, -3)] = sha(join(sd, f));
  }
  return { table: out, extra };
}

// Why a prompt file's text would be cut by the Read tool (one line each).
function readLimitProblems(label, t) {
  const out = [];
  const lines = t.split("\n");
  if (t.endsWith("\n")) lines.pop();
  if (lines.length > ROLE_MAX_LINES) out.push(label + ": " + lines.length + " lines, over " + ROLE_MAX_LINES + " (the Read tool's default)");
  const long = lines.findIndex((l) => l.length > ROLE_MAX_LINE);
  if (long >= 0) out.push(label + ": line " + (long + 1) + " has " + lines[long].length + " characters, over " + ROLE_MAX_LINE + " (the Read tool cuts it)");
  if (t.length > ROLE_MAX_CHARS) out.push(label + ": " + t.length + " characters, over " + ROLE_MAX_CHARS);
  return out;
}

function parseTable(source, re, what, nameRe) {
  const m = re.exec(source);
  if (!m) throw new Error(what + " table not found between its markers in the workflow");
  const t = JSON.parse(m[1]);
  if (!t || typeof t !== "object" || Array.isArray(t)) throw new Error(what + " is not an object");
  for (const [n, v] of Object.entries(t))
    if (!nameRe.test(n) || typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) throw new Error(what + " entry " + n + " is not <name>: <sha256>");
  return t;
}

// {role: the first line of <dir>/<role>.md that starts with "DISPATCH:", or null}
export function dispatchTable(dir = ROLES_DIR) {
  const out = {};
  for (const n of Object.keys(roleFileTable(dir).table)) {
    const m = /^DISPATCH:.*$/m.exec(readFileSync(join(dir, n + ".md"), "utf8"));
    out[n] = m ? m[0] : null;
  }
  return out;
}

// Why the role files in `dir` do not fit the Read tool or name no known tier,
// one line each ([] when they all pass). The tiers and the DISPATCH pattern are
// the workflow's own (const TIERS, const DISPATCH_RE).
export function roleFileProblems(dir, source) {
  const tm = /^const TIERS = (\[[^\]]*\]);$/m.exec(source);
  const dm = /^const DISPATCH_RE = \/(.*)\/;$/m.exec(source);
  if (!tm || !dm) return ["the workflow has no const TIERS or const DISPATCH_RE"];
  const tiers = JSON.parse(tm[1]);
  const re = new RegExp(dm[1]);
  const out = [];
  for (const n of Object.keys(roleFileTable(dir).table)) {
    const t = readFileSync(join(dir, n + ".md"), "utf8");
    out.push(...readLimitProblems(n + ".md", t));
    const d = /^DISPATCH:.*$/m.exec(t);
    const m = d ? re.exec(d[0]) : null;
    if (!m || tiers.indexOf(m[1]) < 0) out.push(n + ".md: no DISPATCH line with a tier in " + tiers.join(", ") + " (got " + JSON.stringify(d ? d[0] : null) + ")");
  }
  for (const n of Object.keys(sharedFileTable(dir).table))
    out.push(...readLimitProblems(SHARED_SUBDIR + "/" + n + ".md", readFileSync(join(dir, SHARED_SUBDIR, n + ".md"), "utf8")));
  return out;
}

// the table the workflow source holds: {name: sha256}
export function programs(source) {
  return parseTable(source, TABLE_RE, "PROGRAM_SHA256", /^[a-z_]+$/);
}
export function roles(source) {
  return parseTable(source, ROLE_TABLE_RE, "ROLE_SHA256", /^[a-z][a-z-]*$/);
}
export function shared(source) {
  return parseTable(source, SHARED_TABLE_RE, "SHARED_SHA256", /^[a-z][a-z-]*$/);
}
export function dispatches(source) {
  const m = DISPATCH_TABLE_RE.exec(source);
  if (!m) throw new Error("ROLE_DISPATCH table not found between its markers in the workflow");
  return JSON.parse(m[1]);
}

// the table as the workflow writes it (deterministic)
export function render(table) {
  const names = Object.keys(table).sort();
  if (!names.length) return "{}";
  return "{\n" + names.map((n) => "  " + JSON.stringify(n) + ": " + JSON.stringify(table[n]) + ",").join("\n").replace(/,$/, "") + "\n}";
}

export function withTable(source, table) {
  if (!TABLE_RE.test(source)) throw new Error("PROGRAM_SHA256 table not found between its markers in the workflow");
  return source.replace(TABLE_RE, () => "\n// PROGRAM_SHA256_BEGIN\nconst PROGRAM_SHA256 = " + render(table) + ";\n// PROGRAM_SHA256_END\n");
}
export function withDispatchTable(source, table) {
  if (!DISPATCH_TABLE_RE.test(source)) throw new Error("ROLE_DISPATCH table not found between its markers in the workflow");
  return source.replace(DISPATCH_TABLE_RE, () => "\n// ROLE_DISPATCH_BEGIN\nconst ROLE_DISPATCH = " + render(table) + ";\n// ROLE_DISPATCH_END\n");
}
export function withRoleTable(source, table) {
  if (!ROLE_TABLE_RE.test(source)) throw new Error("ROLE_SHA256 table not found between its markers in the workflow");
  return source.replace(ROLE_TABLE_RE, () => "\n// ROLE_SHA256_BEGIN\nconst ROLE_SHA256 = " + render(table) + ";\n// ROLE_SHA256_END\n");
}
export function withSharedTable(source, table) {
  if (!SHARED_TABLE_RE.test(source)) throw new Error("SHARED_SHA256 table not found between its markers in the workflow");
  return source.replace(SHARED_TABLE_RE, () => "\n// SHARED_SHA256_BEGIN\nconst SHARED_SHA256 = " + render(table) + ";\n// SHARED_SHA256_END\n");
}
// every generated table in its place
function withTables(source, t) {
  return withSharedTable(withDispatchTable(withRoleTable(withTable(source, t.programs), t.roles), t.dispatch), t.shared);
}

function opt(argv, k, d) {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
}

// the differences between the files' table `want` and the workflow's `have`
function diff(want, have, ext, bad) {
  for (const [k, v] of Object.entries(want))
    if (!(k in have)) bad.push(k + ext + ": not in the table");
    else if (have[k] !== v) bad.push(k + ext + ": hashes " + v + ", the table holds " + have[k]);
  for (const k of Object.keys(have)) if (!(k in want)) bad.push(k + ext + ": in the table, no such file");
}

function main(argv) {
  const check = argv.includes("--check");
  const dir = opt(argv, "--scripts", SCRIPTS);
  const rdir = opt(argv, "--roles", ROLES_DIR);
  const wf = opt(argv, "--workflow", WORKFLOW);
  const want = fileTable(dir);
  const n = Object.keys(want).length;
  const { table: rwant, extra } = roleFileTable(rdir);
  const rn = Object.keys(rwant).length;
  const { table: swant, extra: sextra } = sharedFileTable(rdir);
  const sn = Object.keys(swant).length;
  const dwant = dispatchTable(rdir);
  const source = readFileSync(wf, "utf8");
  const countBad = [];
  if (n !== PROGRAM_COUNT) countBad.push(dir + " holds " + n + " programs, not " + PROGRAM_COUNT + " (change PROGRAM_COUNT when a program is added or removed)");
  if (rn !== ROLE_COUNT) countBad.push(rdir + " holds " + rn + " role files, not " + ROLE_COUNT + " (change ROLE_COUNT when a role is added or removed)");
  if (sn !== SHARED_COUNT) countBad.push(rdir + "/" + SHARED_SUBDIR + " holds " + sn + " shared files, not " + SHARED_COUNT + " (change SHARED_COUNT when a shared file is added or removed)");
  for (const f of extra) countBad.push(rdir + "/" + f + ": not a role file (only regular <role>.md files and the " + SHARED_SUBDIR + " dir may be in the roles dir)");
  for (const f of sextra) countBad.push(rdir + "/" + f + ": not a shared file (only regular <name>.md files may be in " + SHARED_SUBDIR + ")");
  for (const p of roleFileProblems(rdir, source)) countBad.push(rdir + "/" + p);
  const want4 = { programs: want, roles: rwant, dispatch: dwant, shared: swant };
  if (!check) {
    if (countBad.length) {
      console.error(countBad.join("\n"));
      return 1;
    }
    writeFileSync(wf, withTables(source, want4));
    console.log("wrote the sha256 of " + n + " programs, " + rn + " role files and " + sn + " shared files into " + wf);
    return 0;
  }
  const bad = countBad.slice();
  let have, rhave, dhave, shave;
  try {
    have = programs(source);
    rhave = roles(source);
    dhave = dispatches(source);
    shave = shared(source);
  } catch (e) {
    console.error(e.message);
    return 1;
  }
  diff(want, have, ".py", bad);
  diff(rwant, rhave, ".md", bad);
  const sbad = [];
  diff(swant, shave, ".md", sbad);
  for (const b of sbad) bad.push(SHARED_SUBDIR + "/" + b);
  for (const k of new Set(Object.keys(dwant).concat(Object.keys(dhave))))
    if (dwant[k] !== dhave[k]) bad.push(k + ".md: DISPATCH line " + JSON.stringify(dwant[k] === undefined ? null : dwant[k]) + ", ROLE_DISPATCH holds " + JSON.stringify(dhave[k] === undefined ? null : dhave[k]));
  if (!bad.length && withTables(source, { programs: have, roles: rhave, dispatch: dhave, shared: shave }) !== source) bad.push("a table is not in its generated form");
  if (bad.length) {
    console.error("PROGRAM_SHA256 / ROLE_SHA256 / ROLE_DISPATCH / SHARED_SHA256 out of date (run node plugins/fleet/scripts/gen.mjs):\n  " + bad.join("\n  "));
    return 1;
  }
  console.log(n + " programs match the PROGRAM_SHA256 table; " + rn + " role files match the ROLE_SHA256 and ROLE_DISPATCH tables; " + sn + " shared files match the SHARED_SHA256 table");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
