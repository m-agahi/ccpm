#!/usr/bin/env node
// fleet 6.3.1 (ledger 2129): builds the shipped workflow from its commented source.
//
// The source is plugins/ccpmcwf/src/build-engine.js; the Claude Code plugin
// loader registers every plugins/<p>/workflows/*.js, so the source lives outside
// workflows/. The dist plugins/ccpmcwf/workflows/build-engine.js is committed
// (the plugin installs from git) and must stay at most 520000 bytes (ADR-1353;
// Claude Code skips a workflow file over 524288 bytes).
//
// The dist is the source's `export const meta = {...};` block byte for byte,
// then every other source line with its leading whitespace cut, minus the
// lines that are only a `//` comment and the empty lines (stripLines). The
// `// <NAME>_BEGIN` and `// <NAME>_END` table markers stay.
//
// 8.6.0 (ADR-1403): then the whitespace inside each line is collapsed
// (collapse): a space or tab run outside string, template, regex and comment
// text is dropped, or cut to one space where dropping it could join two
// tokens (two word characters, `+ +`, `- -`, `/ /`, `/ *`, `- >`, `< !`,
// a digit and `.`, `? .`, a regex literal and a word). Newlines stay, so the
// line count and the column-0 definitions do not change; no identifier,
// string or token is touched. The lines from a BEGIN marker to the next END
// marker stay as they are (gen.mjs and the tests rewrite those tables).
//
// The line cut is safe only while no string or comment spans a line. The
// build proves it each time: esbuild --minify-whitespace of the source body and
// of the dist body (each wrapped in one async function, since the body holds
// top-level return and await) must be the same bytes, or the build fails.
// esbuild's own output is not shipped: it renames identifiers that shadow an
// outer name (args -> args2) and rewrites `undefined` to `void 0`.
// scripts/changed_defs.py gen_build is a byte-for-byte port of buildWorkflow.
//
//   node plugins/ccpmcwf/scripts/build-workflow.mjs           gen.mjs (tables into the source), then write the dist
//   node plugins/ccpmcwf/scripts/build-workflow.mjs --check   exit 1 when gen.mjs --check fails, the dist is stale,
//                                                           or the esbuild check differs
//
// esbuild runs as `npx --yes --prefer-offline esbuild@<ESBUILD_VERSION>` (an exact
// version, the way CI runs prettier) with npm_config_ignore_scripts=true, so no
// install script runs; no node_modules in the repo.

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Script } from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SRC = join(HERE, "..", "src", "build-engine.js");
export const DIST = join(HERE, "..", "workflows", "build-engine.js");
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

// the line-stripped dist text for a source text: meta, then the body lines
// with indentation, empty lines and comment-only lines cut (pure)
export function stripLines(source) {
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

// 8.6.0 (ADR-1403): the tokens after which a `/` starts a regex literal, not a division
// (8.9.4: `of` only inside a for head; a word after a single `.` is a property name, never one of these)
const REGEX_AFTER = new Set(["return", "typeof", "instanceof", "in", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
// 8.9.4 (yaadgaar #114): the words before a `(` whose `)` ends a statement head, so a `/` after that `)` starts a regex
const HEADS = new Set(["if", "while", "with", "for"]);
const DECLS = new Set(["const", "let", "var"]);
// an identifier, keyword or number character (any non-ASCII character counts)
const isWord = (c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_" || c === "$" || c === "\\" || c === "#" || c >= "\x80";
// (8.9.4, review of #120: `*/` too, so a misread regex never closes a block comment early)
const JOINS = new Set(["++", "--", "//", "/*", "*/", "->", "<!"]);

// 8.6.0 (ADR-1403): `text` with each space or tab run outside string, template,
// regex and comment text dropped, or cut to one space where the chars on both
// sides could join; newlines stay. Throws on a literal that does not close.
export function collapse(text) {
  const out = [];
  const tpl = []; // open `${` per template level: the depth of { inside it
  const n = text.length;
  let i = 0;
  let last = ""; // the last token: "w" word, "r" regex, "v" other value, "p" punctuator, "d" a single `.`
  let word = ""; // the last word ("" for a property name after a single `.`)
  let prev = ""; // the word before `word` when the two are adjacent tokens
  const parens = []; // per open `(`: "f" a for head, "F" one past its `of`, "c" an if, while or with head, "" any other
  const tplText = () => {
    const s = i;
    for (;;) {
      if (i >= n) throw new Error("a template literal does not close");
      const c = text[i];
      if (c === "\\") i += 2;
      else if (c === "`") {
        out.push(text.slice(s, ++i));
        last = "v";
        return;
      } else if (c === "$" && text[i + 1] === "{") {
        i += 2;
        out.push(text.slice(s, i));
        tpl.push(0);
        last = "p";
        return;
      } else i++;
    }
  };
  while (i < n) {
    const c = text[i];
    if (c === " " || c === "\t") {
      let j = i;
      while (text[j] === " " || text[j] === "\t") j++;
      const a = out.length ? out[out.length - 1].slice(-1) : "";
      const b = j < n ? text[j] : "";
      if (a !== "" && a !== "\n" && b !== "" && b !== "\n" && ((isWord(a) && isWord(b)) || JOINS.has(a + b) || (a >= "0" && a <= "9" && b === ".") || (a === "?" && b === ".") || (last === "r" && a === "/" && isWord(b)) || (last === "w" && a === "." && isWord(b)))) out.push(" ");
      i = j;
    } else if (c === "\n") {
      out.push(c);
      i++;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (text[j] !== c) {
        if (j >= n || text[j] === "\n") throw new Error("a string does not close on its line");
        j += text[j] === "\\" ? 2 : 1;
      }
      out.push(text.slice(i, ++j));
      i = j;
      last = "v";
    } else if (c === "`") {
      out.push(c);
      i++;
      tplText();
    } else if (c === "/" && text[i + 1] === "/") {
      const j = text.indexOf("\n", i);
      out.push(text.slice(i, j < 0 ? n : j));
      i = j < 0 ? n : j;
    } else if (c === "/" && text[i + 1] === "*") {
      const j = text.indexOf("*/", i + 2);
      if (j < 0) throw new Error("a block comment does not close");
      out.push(text.slice(i, j + 2));
      i = j + 2;
    } else if (c === "/" && (last === "w" ? REGEX_AFTER.has(word) || word === "of" : last !== "v" && last !== "r")) {
      let j = i + 1;
      let cls = false;
      while (j < n && text[j] !== "\n" && (cls || text[j] !== "/")) {
        if (text[j] === "\\") j++;
        else if (text[j] === "[") cls = true;
        else if (text[j] === "]") cls = false;
        j++;
      }
      if (text[j] !== "/") throw new Error("a regex literal does not close on its line");
      j++;
      while (j < n && isWord(text[j])) j++;
      out.push(text.slice(i, j));
      i = j;
      last = "r";
    } else if (isWord(c)) {
      let j = i;
      while (j < n && isWord(text[j])) j++;
      // 8.9.4: a number takes one trailing `.` and the word chars after it (`1.`, `1.5e3`)
      if (c >= "0" && c <= "9" && text[j] === ".") for (j++; j < n && isWord(text[j]); ) j++;
      const w = text.slice(i, j);
      // a property name is a plain identifier, and so is every `of` but the first one after the binding of a for head
      // (`for (const of of /re/...)`, not `for (q of !of / 2)`)
      const kw = w === "of" && parens[parens.length - 1] === "f" && (last === "v" || (last === "w" && !REGEX_AFTER.has(word) && !DECLS.has(word)));
      if (kw) parens[parens.length - 1] = "F";
      const plain = last === "d" || (w === "of" && !kw);
      prev = last === "w" ? word : "";
      word = plain ? "" : w;
      out.push(w);
      i = j;
      last = "w";
    } else if ((c === "+" || c === "-") && text[i + 1] === c) {
      // 8.9.4: `++` and `--` are one token; a `/` after one is a division
      out.push(c + c);
      i += 2;
      last = "v";
    } else {
      i++;
      if (c === "}" && tpl.length && tpl[tpl.length - 1] === 0) {
        tpl.pop();
        out.push(c);
        tplText();
        continue;
      }
      if (c === "{" && tpl.length) tpl[tpl.length - 1]++;
      if (c === "}" && tpl.length) tpl[tpl.length - 1]--;
      out.push(c);
      const head = c === ")" ? parens.pop() : "";
      if (c === "(") parens.push(last !== "w" ? "" : word === "for" || (word === "await" && prev === "for") ? "f" : HEADS.has(word) ? "c" : "");
      last = c === "." && last !== "d" && out[out.length - 2] !== "." ? "d" : c === ")" ? (head ? "p" : "v") : c === "]" || c === "}" ? "v" : "p";
    }
  }
  if (tpl.length) throw new Error("a template expression does not close");
  return out.join("");
}

// the dist text for a source text (pure; no esbuild): stripLines, then each
// run of lines outside the BEGIN..END marker tables through collapse
export function buildWorkflow(source) {
  const stripped = stripLines(source);
  const { meta, body } = splitMeta(stripped);
  const out = [];
  let run = [];
  let table = false;
  const flush = () => {
    if (run.length) out.push(collapse(run.join("\n")));
    run = [];
  };
  for (const line of body.slice(0, -1).split("\n")) {
    if (!table && MARKER_RE.test(line) && line.endsWith("_BEGIN")) {
      flush();
      table = true;
    }
    if (table) out.push(line);
    else run.push(line);
    if (table && MARKER_RE.test(line) && line.endsWith("_END")) table = false;
  }
  flush();
  return meta + out.join("\n") + "\n";
}

// esbuild --minify-whitespace of `code`; throws when esbuild cannot run or fails
export function minifyWhitespace(code) {
  // 6.3.2: no install script runs (esbuild's platform binary comes as an optional dependency); the npx cache first
  const r = spawnSync("npx", ["--yes", "--prefer-offline", ESBUILD_SPEC, "--minify-whitespace", "--charset=ascii", "--log-level=error"], {
    input: code,
    env: Object.assign({}, process.env, { npm_config_ignore_scripts: "true" }),
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
  // 8.9.4 (review of #120): the dist body must compile; esbuild folds a regex in a truthy position
  // (`/re/ && f()` gives `f()`), so a regex the collapse broke can minify to the same bytes
  try {
    new Script(WRAP_HEAD + "\n" + splitMeta(dist).body + "\n}\n", { filename: "dist" });
  } catch (e) {
    return "the dist does not compile: " + e.message;
  }
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
    console.error(DIST + " is stale: run node plugins/ccpmcwf/scripts/build-workflow.mjs and commit it with the source");
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
