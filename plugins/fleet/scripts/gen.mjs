#!/usr/bin/env node
// Writes the PROGRAM_SHA256 table of workflows/build-task-run.js from the
// shipped programs plugins/fleet/scripts/*.py (fleet 4.0.1, ledger 1996). The
// .py files are the source of truth; the table holds the sha256 of each file's
// exact bytes, sorted by program name, between the PROGRAM_SHA256_BEGIN and
// PROGRAM_SHA256_END markers. The workflow does not embed the program text:
// Claude Code skips a workflow file over 524288 bytes.
//
//   node plugins/fleet/scripts/gen.mjs            write the table
//   node plugins/fleet/scripts/gen.mjs --check    exit 1 when the table and the files differ,
//                                                 or the count is not PROGRAM_COUNT
//   --scripts <dir>  --workflow <file>            other paths (tests)

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const WORKFLOW = join(HERE, "..", "workflows", "build-task-run.js");
export const SCRIPTS = HERE;
// the number of shipped programs (28 in 4.0.0 and 4.0.1)
export const PROGRAM_COUNT = 28;

const TABLE_RE = /\n\/\/ PROGRAM_SHA256_BEGIN\nconst PROGRAM_SHA256 = (\{[^`]*?\});\n\/\/ PROGRAM_SHA256_END\n/;

// {name: sha256} of every <dir>/*.py, sorted by name
export function fileTable(dir = SCRIPTS) {
  const out = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".py")).sort())
    out[f.slice(0, -3)] = createHash("sha256").update(readFileSync(join(dir, f))).digest("hex");
  return out;
}

// the table the workflow source holds: {name: sha256}
export function programs(source) {
  const m = TABLE_RE.exec(source);
  if (!m) throw new Error("PROGRAM_SHA256 table not found between its markers in the workflow");
  const t = JSON.parse(m[1]);
  if (!t || typeof t !== "object" || Array.isArray(t)) throw new Error("PROGRAM_SHA256 is not an object");
  for (const [n, v] of Object.entries(t))
    if (!/^[a-z_]+$/.test(n) || typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) throw new Error("PROGRAM_SHA256 entry " + n + " is not <name>: <sha256>");
  return t;
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

function opt(argv, k, d) {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
}

function main(argv) {
  const check = argv.includes("--check");
  const dir = opt(argv, "--scripts", SCRIPTS);
  const wf = opt(argv, "--workflow", WORKFLOW);
  const want = fileTable(dir);
  const n = Object.keys(want).length;
  const source = readFileSync(wf, "utf8");
  if (!check) {
    if (n !== PROGRAM_COUNT) {
      console.error(dir + " holds " + n + " programs, not " + PROGRAM_COUNT + " (change PROGRAM_COUNT when a program is added or removed)");
      return 1;
    }
    writeFileSync(wf, withTable(source, want));
    console.log("wrote the sha256 of " + n + " programs into " + wf);
    return 0;
  }
  const bad = [];
  let have;
  try {
    have = programs(source);
  } catch (e) {
    console.error(e.message);
    return 1;
  }
  if (n !== PROGRAM_COUNT) bad.push(dir + " holds " + n + " programs, not " + PROGRAM_COUNT);
  for (const [k, v] of Object.entries(want))
    if (!(k in have)) bad.push(k + ".py: not in the table");
    else if (have[k] !== v) bad.push(k + ".py: hashes " + v + ", the table holds " + have[k]);
  for (const k of Object.keys(have)) if (!(k in want)) bad.push(k + ".py: in the table, no such file");
  if (!bad.length && withTable(source, have) !== source) bad.push("the table is not in its generated form");
  if (bad.length) {
    console.error("PROGRAM_SHA256 out of date (run node plugins/fleet/scripts/gen.mjs):\n  " + bad.join("\n  "));
    return 1;
  }
  console.log(n + " programs match the PROGRAM_SHA256 table");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
