#!/usr/bin/env node
// fleet 6.3.1 (ledger 2129): builds the shipped workflow from its commented source.
//
// The source is plugins/fleet/src/build-task-run.js; the Claude Code plugin
// loader registers every plugins/<p>/workflows/*.js, so the source lives outside
// workflows/. The dist plugins/fleet/workflows/build-task-run.js is committed
// (the plugin installs from git) and must stay at most 480000 bytes (ADR-1189;
// Claude Code skips a workflow file over 524288 bytes).
//
// The dist is the source's `export const meta = {...};` block byte for byte,
// then every other source line with its leading whitespace cut, minus the
// lines that are only a `//` comment and the empty lines. The `// <NAME>_BEGIN`
// and `// <NAME>_END` table markers stay. Nothing inside a line changes: no
// identifier, string or token is touched.
//
// The cut is safe only while no string, template or comment spans a line. The
// build proves it each time: esbuild --minify-whitespace of the source body and
// of the dist body (each wrapped in one async function, since the body holds
// top-level return and await) must be the same bytes, or the build fails.
// esbuild's own output is not shipped: it renames identifiers that shadow an
// outer name (args -> args2) and rewrites `undefined` to `void 0`.
//
//   node plugins/fleet/scripts/build-workflow.mjs           gen.mjs (tables into the source), then write the dist
//   node plugins/fleet/scripts/build-workflow.mjs --check   exit 1 when gen.mjs --check fails, the dist is stale,
//                                                           or the esbuild check differs
//
// esbuild runs as `npx --yes esbuild@<ESBUILD_VERSION>` (an exact version, the
// way CI runs prettier); no node_modules in the repo.

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SRC = join(HERE, "..", "src", "build-task-run.js");
export const DIST = join(HERE, "..", "workflows", "build-task-run.js");
export const GEN = join(HERE, "gen.mjs");
export const ESBUILD_VERSION = "0.28.2";
export const ESBUILD_SPEC = "esbuild@" + ESBUILD_VERSION;
// gen.mjs finds its tables between these lines
export const MARKER_RE = /^\/\/ [A-Z0-9_]+_(BEGIN|END)$/;

const META_HEAD = "export const meta = {\n";
const META_TAIL = "\n};\n";
const WRAP_HEAD = "async function __fleet_workflow_body__(){";

// {meta, body}: meta is the source's first statement, `export const meta = {` up
// to and with the first line that is only `};`
export function splitMeta(source) {
  if (!source.startsWith(META_HEAD)) throw new Error("the source does not start with `export const meta = {`");
  const i = source.indexOf(META_TAIL);
  if (i < 0) throw new Error("the source has no `};` line closing the meta block");
  return { meta: source.slice(0, i + META_TAIL.length), body: source.slice(i + META_TAIL.length) };
}

// the dist text for a source text (pure; no esbuild)
export function buildWorkflow(source) {
  const { meta, body } = splitMeta(source);
  const out = [];
  for (const line of body.split("\n")) {
    const t = line.replace(/^[ \t]+/, "");
    if (t === "") continue;
    if (t.startsWith("//") && !MARKER_RE.test(t)) continue;
    out.push(t);
  }
  return meta + out.join("\n") + "\n";
}

// esbuild --minify-whitespace of `code`; throws when esbuild cannot run or fails
export function minifyWhitespace(code) {
  const r = spawnSync("npx", ["--yes", ESBUILD_SPEC, "--minify-whitespace", "--charset=ascii", "--log-level=error"], {
    input: code,
    encoding: "utf8",
    maxBuffer: 64 << 20,
    timeout: 300000,
  });
  if (r.error) throw new Error("npx " + ESBUILD_SPEC + ": " + r.error.message);
  if (r.status !== 0) throw new Error("npx " + ESBUILD_SPEC + " exited " + r.status + ": " + String(r.stderr).trim());
  return r.stdout;
}

const wrapped = (text) => minifyWhitespace(WRAP_HEAD + "\n" + splitMeta(text).body + "\n}\n");

// null when the source and the dist minify to the same bytes, else the first difference
export function equivalence(source, dist) {
  if (splitMeta(source).meta !== splitMeta(dist).meta) return "the meta blocks differ";
  const a = wrapped(source);
  const b = wrapped(dist);
  if (a === b) return null;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return "esbuild --minify-whitespace differs at byte " + i + ": source " + JSON.stringify(a.slice(Math.max(0, i - 80), i + 80)) + ", dist " + JSON.stringify(b.slice(Math.max(0, i - 80), i + 80));
}

function gen(check) {
  const r = spawnSync("node", [GEN].concat(check ? ["--check"] : []), { encoding: "utf8" });
  process.stdout.write(r.stdout || "");
  process.stderr.write(r.stderr || "");
  return r.status === 0;
}

function main(argv) {
  const check = argv.includes("--check");
  if (!gen(check)) return 1;
  const source = readFileSync(SRC, "utf8");
  const dist = buildWorkflow(source);
  if (check && readFileSync(DIST, "utf8") !== dist) {
    console.error(DIST + " is stale: run node plugins/fleet/scripts/build-workflow.mjs and commit it with the source");
    return 1;
  }
  const diff = equivalence(source, dist);
  if (diff) {
    console.error("the dist is not the source's code (a string, template or comment spans a line?): " + diff);
    return 1;
  }
  if (check) {
    console.log(DIST + " is the build of " + SRC + " (" + Buffer.byteLength(dist) + " bytes; esbuild " + ESBUILD_VERSION + " check passed)");
    return 0;
  }
  writeFileSync(DIST, dist);
  console.log("wrote " + DIST + ": " + Buffer.byteLength(dist) + " bytes from " + Buffer.byteLength(source) + " source bytes (esbuild " + ESBUILD_VERSION + " check passed)");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
