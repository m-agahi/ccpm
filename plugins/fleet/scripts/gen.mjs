#!/usr/bin/env node
// Writes plugins/fleet/scripts/<name>.py from the program constants of
// workflows/build-task-run.js (fleet 4.0.0, ledger 1993). The constants are the
// source of truth: the workflow script cannot read files, so it holds each
// program and checks the sha256 the shipped file prints of itself. Each file is
// the constant's value plus "\n".
//
//   node plugins/fleet/scripts/gen.mjs            write the files
//   node plugins/fleet/scripts/gen.mjs --check    exit 1 on any changed, missing or extra file
//   --out <dir>                                   another directory (tests)

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const WORKFLOW = join(HERE, "..", "workflows", "build-task-run.js");

// [[file name, constant name, value]] in the order of the workflow's programTable()
export function programs(source) {
  const t = /PROGRAM_TABLE = \{\n([\s\S]*?)\n {4}\};/.exec(source);
  if (!t) throw new Error("programTable() not found in " + WORKFLOW);
  const out = [];
  for (const m of t[1].matchAll(/^ {6}([a-z_]+): ([A-Z_]+_PY),$/gm)) {
    const [, name, c] = m;
    const v = new RegExp("\\n// " + c + "_BEGIN\\nconst " + c + " = String\\.raw`([\\s\\S]*?)`;\\n// " + c + "_END\\n").exec(source);
    if (!v) throw new Error(c + ": no String.raw block between its BEGIN and END markers");
    // String.raw keeps the text as written: only ${ and a backtick would differ
    if (v[1].includes("${") || v[1].includes("`") || v[1].includes("\r")) throw new Error(c + ": holds ${, a backtick or a CR");
    out.push([name, c, v[1]]);
  }
  if (!out.length) throw new Error("programTable() lists no program");
  return out;
}

function main(argv) {
  const check = argv.includes("--check");
  const i = argv.indexOf("--out");
  const dir = i >= 0 ? argv[i + 1] : HERE;
  const progs = programs(readFileSync(WORKFLOW, "utf8"));
  const want = new Map(progs.map(([n, , v]) => [n + ".py", v + "\n"]));
  if (!check) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    for (const [f, body] of want) writeFileSync(join(dir, f), body);
    console.log("wrote " + want.size + " programs to " + dir);
    return 0;
  }
  const bad = [];
  for (const [f, body] of want) {
    const p = join(dir, f);
    if (!existsSync(p)) bad.push(f + ": missing");
    else if (readFileSync(p, "utf8") !== body) bad.push(f + ": differs from its constant");
  }
  for (const f of readdirSync(dir)) if (f.endsWith(".py") && !want.has(f)) bad.push(f + ": no constant ships it");
  if (bad.length) {
    console.error("scripts out of date (run node plugins/fleet/scripts/gen.mjs):\n  " + bad.join("\n  "));
    return 1;
  }
  console.log(want.size + " programs match their constants");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
