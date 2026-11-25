// fleet 7.0.1 (yaadgaar #55, L2190) AC6: the program's build check
// (changed_defs.py) equals the JS buildWorkflow byte for byte.
//
// Each case builds the dist in JS with buildWorkflow from
// plugins/ccpmcwf/scripts/build-workflow.mjs, commits a base and a tree in a
// temporary git repo, runs changed_defs.py on them and reads the `generated`
// key of its JSON. Expected values come from the plan doc's AC6 examples.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, "..");
const PROGRAM = join(PLUGIN, "scripts", "changed_defs.py");
const { buildWorkflow: build } = await import(join(PLUGIN, "scripts", "build-workflow.mjs"));

const S = "plugins/ccpmcwf/src/build-engine.js";
const D = "plugins/ccpmcwf/workflows/build-engine.js";
const TAB = String.fromCharCode(9);

const GIT_ENV = Object.assign({}, process.env, {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
});

function git(wt, ...args) {
  const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-C", wt, ...args], {
    env: GIT_ENV,
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  if (r.status !== 0) throw new Error("git " + args.join(" ") + ": " + r.stderr);
  return r.stdout.trim();
}

function put(wt, files) {
  for (const [p, text] of Object.entries(files)) {
    const f = join(wt, p);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text);
  }
}

// runs the program on base -> tree and returns its parsed JSON
function scan(baseFiles, treeFiles) {
  const wt = mkdtempSync(join(tmpdir(), "v701-parity-"));
  try {
    git(wt, "init", "-q", "--template=");
    put(wt, baseFiles);
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "base");
    const base = git(wt, "rev-parse", "HEAD");
    put(wt, treeFiles);
    git(wt, "add", "-A");
    const tree = git(wt, "write-tree");
    const r = spawnSync("python3", ["-I", PROGRAM, wt, base, tree, "[]"], {
      env: GIT_ENV,
      encoding: "utf8",
      maxBuffer: 64 << 20,
    });
    assert.equal(r.status, 0, "changed_defs.py exited " + r.status + ": " + r.stderr);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
}

const E1 =
  'export const meta = {\n  name: "x",\n};\n' +
  TAB + TAB + "const a = 1;\n  // FOO_BEGIN\n    // plain comment\n   \nfunction f() {\n  //x\n  return a;\n}\n  // lower_BEGIN\n// BAR_END\n";

const edit = (text) => text.replace("return a;", "return a + 1;");

// base S, base D = build(S); tree S = edit(S), tree D = distOf(edit(S))
function runPair(src, distOf = build) {
  const next = edit(src);
  assert.notEqual(next, src, "fixture must contain `return a;`");
  return scan({ [S]: src, [D]: build(src) }, { [S]: next, [D]: distOf(next) });
}

test("AC6: E1 edge fixture, program build equals buildWorkflow (tabs, indented comments, blank lines, markers)", () => {
  // AC6: E1 example, generated == [D]
  const out = runPair(E1);
  assert.deepEqual(out.generated, [D]);
});

test("AC6: triangulation, equality holds across marker, whitespace and meta variants", () => {
  // AC6: property gen_build(x) == buildWorkflow(x) for every source with a meta head
  const head = 'export const meta = {\n  name: "x",\n};\n';
  const tail = "function f() {\n  return a;\n}\n";
  const sources = {
    "indented upper marker is kept": head + "\t// ZED_END\n  // A1_2_BEGIN\n" + tail,
    "lower-case marker and marker with a suffix are dropped": head + "// a_BEGIN\n// FOO_BEGIN trailing\n  // FOO_BEGINX\n" + tail,
    "whitespace-only lines with tabs and spaces": head + " \t \n\t\n   \n" + tail,
    "meta block with a comment and a blank line is kept verbatim": 'export const meta = {\n  // keep me\n\n  name: "x",\n};\n' + tail,
    // 8.6.0 (ADR-1403): the build collapses whitespace inside lines (was: "trailing whitespace inside lines is kept")
    "trailing whitespace is dropped": head + "const b = 2;  \t\n" + tail,
    "unary plus and minus after an operator keep one space": head + "x = a + +b - -c + ++d;\ny = a++ + b;\n" + tail,
    "a regex after a division keeps one space; regex text is kept": head + "x = y / /re  x/.source.length;\nz = (a) / 2 / c;\n" + tail,
    "a regex after return or ( keeps its spaces": head + "if ( /^a  b$/.test(s) ) return  /x  y/g;\nconst r = /[/ ]+/g;\n" + tail,
    "a word after a regex keeps one space": head + "x = /x/ instanceof RegExp;\n" + tail,
    "number then dot, ? then dot, < then !, - then >": head + "x = 1 .toString() + (a ? .5 : 1);\ny = a < !--b || a-- > b;\n" + tail,
    "strings, nested templates and comments are kept": head + "const s = \"a  b\" + 'c  \\' d' + `e  ${ { a : 1 }.a }  ${ `in  ${ z }  ner` }`;  // keep  this\n/* a  b */  x  =  1;\n" + tail,
    "a template spans lines": head + "const t = `a  b\n  c  ${ d  +  e }\n  f`;\n" + tail,
    "non-ASCII in identifiers, strings, regex and templates": head + "const é  =  \"ü  x\" + /ö  y/.source + `ß  ${ é }`;\n" + tail,
    "marker tables are kept as they are": head + "const  a  =  1;\n// FOO_BEGIN\nconst T = { \"a\": 1 };\n// FOO_END\nconst  u  =  2;\n" + tail,
    "a BEGIN marker with no END keeps the rest": head + "const  a  =  1;\n// FOO_BEGIN\n" + tail,
    "an END marker with no BEGIN is a plain line": head + "const  a  =  1;\n// FOO_END\nconst  u  =  2;\n" + tail,
    "a later `};` line in the body is not the meta end": head + "const o = {\n  k: 1,\n};\n" + tail,
    "meta end is the first line that is exactly `};`, not a line that only starts with it": 'export const meta = {\n  a: 1,\n};x\n};\n' + tail,
    "no final newline in the body": head + "function f() {\n  return a;\n}",
    // 8.9.4 (yaadgaar #114): the tokenizer shapes, built the same in both ports
    "a number with a trailing dot before a division or a keyword": head + "x = 1. / y / 2;\ny = 1. in x || 1. instanceof x;\nz = 2.5 / x / 3 + 1..toString();\n" + tail,
    "a division after a postfix ++ or --; a regex after a single +": head + "x = a++ / 2 / b + (b-- / y / 2);\nz = a+++/x  y/.source + (a + +/x  y/.source);\n" + tail,
    "a keyword after a dot is a property name": head + "y = a.of / 2 / b + a.in / 2 / b + a?.yield / 2 / b + x.return / 2 / x.typeof;\nw = a.\nof / 2 / b;\n" + tail,
    "of is a keyword only in a for head": head + "const of = 4; y = of / 2 / b + [...of] / 2 / b;\nfor ( const q of /a  b/.exec(s) ) f(q);\n" + tail,
    "a regex after the ) of a control head": head + "if ( x ) /a  b/.test(s);\nwhile ( f(x) ) /a  b/.test(s);\nfor ( ;; ) /a  b/.test(s);\nfor await ( const q of a ) /a  b/.test(q);\n" + tail,
    "a division after any other )": head + "x = f(a) / 2 / c + a.if(b) / 2 / c;\ny = (a)) / 2 / c;\n" + tail,
    "a regex after } is lexed as a division": head + "{ a }\n/x  y/.test(s);\n" + tail,
  };
  for (const [name, src] of Object.entries(sources)) {
    const out = runPair(src);
    assert.deepEqual(out.generated, [D], name);
  }
});

test("AC6: the real source, a one-token edit, dist rebuilt: dist excluded and never scanned", () => {
  // AC6: real source example
  const real = readFileSync(join(PLUGIN, "src", "build-engine.js"), "utf8");
  const from = 'const RELAY_RETRY_MODEL = "sonnet";';
  assert.ok(real.includes(from), "fixture needs the first RELAY_RETRY_MODEL line");
  const next = real.replace(from, 'const RELAY_RETRY_MODEL = "opus";');
  const out = scan({ [S]: real, [D]: build(real) }, { [S]: next, [D]: build(next) });
  assert.deepEqual(out.generated, [D]);
  // AC6: no defs entry whose `at` starts with D + ":"
  assert.deepEqual(
    out.defs.filter((d) => d.at.startsWith(D + ":")),
    [],
  );
});

test("AC6: marker dropped from the dist, not the build, so the dist is scanned and not generated", () => {
  // AC6: marker dropped example (the `// BAR_END` line removed from D)
  const next = edit(E1);
  const dist = build(next);
  assert.ok(dist.includes("\n// BAR_END\n"), "fixture: the build keeps the BAR_END marker");
  const out = scan({ [S]: E1, [D]: build(E1) }, { [S]: next, [D]: dist.replace("\n// BAR_END\n", "\n") });
  assert.deepEqual(out.generated, []);
});

test("AC6: triangulation, any byte-level deviation of the dist from the build is refused", () => {
  // AC6: byte for byte, tab indentation, indented comment, whitespace-only line, marker line
  const next = edit(E1);
  const dist = build(next);
  const variants = {
    "marker FOO_BEGIN removed": dist.replace("// FOO_BEGIN\n", ""),
    // 8.6.0 (ADR-1403): the build writes `const a=1;` (whitespace collapsed); E1's FOO_BEGIN..BAR_END lines stay as they are
    "tab indentation kept on the const line": dist.replace("const a=1;", TAB + TAB + "const a=1;"),
    "a collapsed space kept on the const line": dist.replace("const a=1;", "const a = 1;"),
    "a space dropped inside a marker table": dist.replace("return a + 1;", "return a+1;"),
    "indented plain comment kept": dist.replace("function f() {", "// plain comment\nfunction f() {"),
    "whitespace-only line kept": dist.replace("function f() {", "   \nfunction f() {"),
    "lower_BEGIN marker kept": dist.replace("return a + 1;", "// lower_BEGIN\nreturn a + 1;"),
    "meta indentation cut": dist.replace('  name: "x",', 'name: "x",'),
  };
  for (const [name, bad] of Object.entries(variants)) {
    assert.notEqual(bad, dist, "variant must differ: " + name);
    const out = scan({ [S]: E1, [D]: build(E1) }, { [S]: next, [D]: bad });
    assert.deepEqual(out.generated, [], name);
  }
});

test("AC6: no meta head, src and dist equal and both changed: no build, no exclusion", () => {
  // AC6: no meta head example
  const out = scan({ [S]: "const x = 1;\n", [D]: "const x = 1;\n" }, { [S]: "const x = 2;\n", [D]: "const x = 2;\n" });
  assert.deepEqual(out.generated, []);
});

test("AC6: triangulation, meta head without a closing `};` line gives no build", () => {
  // AC6: meta split, no `};` line closing the meta block
  const base = 'export const meta = {\n  name: "x",\nconst a = 1;\n';
  const next = 'export const meta = {\n  name: "x",\nconst a = 2;\n';
  const out = scan({ [S]: base, [D]: base }, { [S]: next, [D]: next });
  assert.deepEqual(out.generated, []);
});

test("8.6.0 ADR-1403: a literal that does not close gives no build in either port, so the dist is scanned", () => {
  const head = 'export const meta = {\n  name: "x",\n};\n';
  for (const tailBad of ['const s = "abc;\n', "const s = `a ${ b;\n", "x = /abc;\n"]) {
    assert.throws(() => build(head + tailBad), undefined, JSON.stringify(tailBad));
    const mk = (n) => head + "const a = " + n + ";\n" + tailBad;
    const out = scan({ [S]: mk(1), [D]: "const a = 1;\n" }, { [S]: mk(2), [D]: "const a = 2;\n" });
    assert.deepEqual(out.generated, [], JSON.stringify(tailBad));
  }
});

test("AC6: triangulation, meta head must start the source byte for byte", () => {
  // AC6: meta split, head variant (leading blank line) gives no build
  const mk = (n) => '\nexport const meta = {\n  name: "x",\n};\nconst a = ' + n + ";\n";
  const out = scan({ [S]: mk(1), [D]: mk(1) }, { [S]: mk(2), [D]: mk(2) });
  assert.deepEqual(out.generated, []);
});
