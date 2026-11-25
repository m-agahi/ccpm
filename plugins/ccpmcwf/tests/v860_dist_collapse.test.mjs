// ccpmcwf 8.6.0 (ADR-1403, yaadgaar #113): the build collapses whitespace
// inside the lines of the dist.
//
// scripts/build-workflow.mjs first cuts indentation, empty lines and
// comment-only lines (stripLines), then drops every space or tab run outside
// string, template, regex and comment text, or keeps one space where dropping
// it could join two tokens. Newlines stay, so the line count does not change.
// Lines from a `// <NAME>_BEGIN` marker to the next `// <NAME>_END` marker stay
// as they are: gen.mjs and the test harness rewrite those tables in the dist.
//
// The committed-dist property below uses its own simple literal stripper, not
// the build's tokenizer, so the build cannot pass by agreeing with itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { SOURCE, DIST } from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, "..");
const BUILD = join(PLUGIN, "scripts", "build-workflow.mjs");
const B = await import(BUILD);

const HEAD = 'export const meta = {\n  name: "x",\n};\n';
// the dist body for a source body
const body = (text) => B.buildWorkflow(HEAD + text).slice(HEAD.length);

test("8.6.0 ADR-1403: whitespace inside lines is dropped where no two tokens join", () => {
  assert.equal(body("  const  x  =  { a : 1 , b : [ 2 , 3 ] } ;  \n"), "const x={a:1,b:[2,3]};\n");
  assert.equal(body("if ( a ) {\n\treturn  f ( x ) ;\n}\n"), "if(a){\nreturn f(x);\n}\n");
  assert.equal(body("async function  g ( a ,  b )  {  }\n"), "async function g(a,b){}\n");
  assert.equal(body("typeof  x  ===  \"y\"  &&  y  instanceof  Z ;\n"), 'typeof x==="y"&&y instanceof Z;\n');
  assert.equal(body("const f = async ( a ) => a  *  2 ;\n"), "const f=async(a)=>a*2;\n");
});

test("8.6.0 ADR-1403: one space stays where dropping it changes the tokens", () => {
  assert.equal(body("x = a + +b;\n"), "x=a+ +b;\n");
  assert.equal(body("x = a - -b;\n"), "x=a- -b;\n");
  assert.equal(body("x = a++ + b;\n"), "x=a++ +b;\n");
  assert.equal(body("x = a + ++b;\n"), "x=a+ ++b;\n");
  assert.equal(body("x = y / /re/.source.length;\n"), "x=y/ /re/.source.length;\n");
  assert.equal(body("x = 1 .toString();\n"), "x=1 .toString();\n");
  assert.equal(body("x = a ? .5 : 1;\n"), "x=a? .5:1;\n");
  assert.equal(body("x = /x/ instanceof RegExp;\n"), "x=/x/ instanceof RegExp;\n");
  assert.equal(body("x = a < !--b;\n"), "x=a< !--b;\n");
  assert.equal(body("x = a-- > b;\n"), "x=a-- >b;\n");
  assert.equal(body("return  x ;\n"), "return x;\n");
});

test("8.6.0 ADR-1403: string, template, regex and comment text is kept byte for byte", () => {
  assert.equal(body("const s = \"a  b\" + 'c  d' + `e  ${ f  +  g }  h`;\n"), "const s=\"a  b\"+'c  d'+`e  ${f+g}  h`;\n");
  assert.equal(body("const s = `x ${ { a: 1 }.a } y ${ `in  ${ z }  ner` }`;\n"), "const s=`x ${{a:1}.a} y ${`in  ${z}  ner`}`;\n");
  assert.equal(body('const q = "say \\"a  b\\"  " + \'it\\\'s  x\';\n'), 'const q="say \\"a  b\\"  "+\'it\\\'s  x\';\n');
  assert.equal(body("const t = s.split(/[ \\t]+/);\n"), "const t=s.split(/[ \\t]+/);\n");
  assert.equal(body("if (/^a  b$/.test(s)) return /x  y/g;\n"), "if(/^a  b$/.test(s))return/x  y/g;\n");
  assert.equal(body("const re = /[/ ]+/g;\n"), "const re=/[/ ]+/g;\n");
  assert.equal(body("x = (a) / 2 / c;\n"), "x=(a)/2/c;\n");
  assert.equal(body("x = 1;  // keep  this  text\n"), "x=1;// keep  this  text\n");
  assert.equal(body("/* a  b */  x  =  1;\n"), "/* a  b */x=1;\n");
  assert.equal(body("const é  =  \"ü  x\" ;  é  +  1;\n"), 'const é="ü  x";é+1;\n');
});

test("8.6.0 ADR-1403: lines from a BEGIN marker to the next END marker stay as they are", () => {
  const src = "const  a  =  1;\n// FOO_BEGIN\nconst T = { \"a\": 1 };\n// FOO_END\nconst  u  =  2;\n";
  assert.equal(body(src), 'const a=1;\n// FOO_BEGIN\nconst T = { "a": 1 };\n// FOO_END\nconst u=2;\n');
  // a BEGIN with no END keeps the rest of the body
  assert.equal(body("const  a = 1;\n// FOO_BEGIN\nconst  b = 2;\n"), "const a=1;\n// FOO_BEGIN\nconst  b = 2;\n");
  // an END with no BEGIN is a plain marker line
  assert.equal(body("const  a = 1;\n// FOO_END\nconst  b = 2;\n"), "const a=1;\n// FOO_END\nconst b=2;\n");
});

test("8.9.4 yaadgaar #114: a number takes a trailing dot, so a division or a keyword after it lexes right", () => {
  assert.equal(body("x = 1. / y / 2;\n"), "x=1./y/2;\n");
  assert.equal(body("y = 1. in x;\n"), "y=1. in x;\n");
  assert.equal(body("y = 1. instanceof x;\n"), "y=1. instanceof x;\n");
  assert.equal(body("y = 2.5 / x / 3 + 1..toString();\n"), "y=2.5/x/3+1..toString();\n");
  assert.equal(body("x = 1 .toString() + 1.5 .toFixed();\n"), "x=1 .toString()+1.5 .toFixed();\n");
});

test("8.9.4 yaadgaar #114: a slash after a postfix ++ or -- is a division", () => {
  assert.equal(body("x = a++ / 2 / b;\n"), "x=a++/2/b;\n");
  assert.equal(body("x = b-- / y / 2;\n"), "x=b--/y/2;\n");
  // guards: a single + before a slash still starts a regex
  assert.equal(body("x = a+++/x  y/.source.length;\n"), "x=a+++/x  y/.source.length;\n");
  assert.equal(body("x = a + +/x  y/.source.length;\n"), "x=a+ +/x  y/.source.length;\n");
});

test("8.9.4 yaadgaar #114: a keyword after a dot is a property name; of is a keyword only in a for head", () => {
  assert.equal(body("y = a.of / 2 / b;\n"), "y=a.of/2/b;\n");
  assert.equal(body("y = a.in / 2 / b;\n"), "y=a.in/2/b;\n");
  assert.equal(body("y = a?.yield / 2 / b;\n"), "y=a?.yield/2/b;\n");
  assert.equal(body("y = x.return / 2 / x.typeof;\n"), "y=x.return/2/x.typeof;\n");
  assert.equal(body("y = a.\nof / 2 / b;\n"), "y=a.\nof/2/b;\n");
  assert.equal(body("const of = 4; y = of / 2 / b;\n"), "const of=4;y=of/2/b;\n");
  assert.equal(body("for ( const q of /a  b/.exec(s) ) f(q);\n"), "for(const q of/a  b/.exec(s))f(q);\n");
  assert.equal(body("y = [...of] / 2 / b;\n"), "y=[...of]/2/b;\n");
});

test("8.9.4 yaadgaar #114: a regex after the ) of an if, while, with or for head keeps its text", () => {
  assert.equal(body("if ( x ) /a  b/.test(s);\n"), "if(x)/a  b/.test(s);\n");
  assert.equal(body("while ( f(x) ) /a  b/.test(s);\n"), "while(f(x))/a  b/.test(s);\n");
  assert.equal(body("for ( ;; ) /a  b/.test(s);\n"), "for(;;)/a  b/.test(s);\n");
  assert.equal(body("for await ( const q of a ) /a  b/.test(q);\n"), "for await(const q of a)/a  b/.test(q);\n");
  // any other ) is a value: a division follows
  assert.equal(body("x = f(a) / 2 / c;\n"), "x=f(a)/2/c;\n");
  assert.equal(body("x = a.if(b) / 2 / c;\n"), "x=a.if(b)/2/c;\n");
  assert.equal(body("x = (a)) / 2 / c;\n"), "x=(a))/2/c;\n");
});

test("8.9.4 yaadgaar #114: a regex after } stays lexed as a division, and the esbuild check fails it", () => {
  // block or object literal needs statement context; the collapse does not track it
  assert.equal(body("{ a }\n/x  y/.test(s);\n"), "{a}\n/x y/.test(s);\n");
});

test("8.6.0 ADR-1403: the build fails on a string, template or regex that does not close", () => {
  for (const bad of ['const s = "abc;\n', "const s = 'abc;\n", "const s = `abc;\n", "const s = `a ${ b;\n", "x = /abc;\n"]) {
    assert.throws(() => body(bad), undefined, JSON.stringify(bad));
  }
});

test("8.6.0 ADR-1403: the line count of the dist is the line count of stripLines", () => {
  assert.equal(DIST.split("\n").length, B.stripLines(SOURCE).split("\n").length);
  assert.ok(B.buildWorkflow(SOURCE) === DIST, "the committed dist is the build of the source");
});

// a simple literal stripper, independent of the build's tokenizer: regex
// literals after an operator or keyword, then strings and templates, then comments
const W = /[A-Za-z0-9_$\\#\u0080-\uffff]/;
const PAIRS = ["++", "--", "//", "/*", "->", "<!"];
const spaceNeeded = (a, b) => (W.test(a) && W.test(b)) || PAIRS.includes(a + b) || (/[0-9]/.test(a) && b === ".") || (a === "?" && b === ".") || (a === "/" && W.test(b));
function looseSpaces(dist) {
  const { body: b } = B.splitMeta(dist);
  const bad = [];
  let verbatim = false;
  for (const [n, l] of b.split("\n").entries()) {
    if (B.MARKER_RE.test(l) && l.endsWith("_BEGIN")) verbatim = true;
    if (!verbatim) {
      const s = l
        .replace(/(^|[=(,:;[!&|?{}>]|return|typeof)\/(?:[^/\\[\n]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[a-z]*/g, "$1/x/")
        .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""')
        .replace(/\/\/.*$/, "")
        .replace(/\/\*.*?\*\//g, "");
      if (/^[ \t]|[ \t]$/.test(s)) bad.push(n + ": " + l);
      else if (/\t| {2}/.test(s)) bad.push(n + ": " + l);
      else
        for (let i = 0; i < s.length; i++)
          if (s[i] === " " && !spaceNeeded(s[i - 1], s[i + 1])) {
            bad.push(n + ": " + l);
            break;
          }
    }
    if (B.MARKER_RE.test(l) && l.endsWith("_END")) verbatim = false;
  }
  return bad;
}

test("8.6.0 ADR-1403: the committed dist holds no droppable space outside literals and marker tables", () => {
  assert.ok(looseSpaces(B.stripLines(SOURCE)).length > 1000, "the check sees the spaces of the line-stripped build");
  assert.deepEqual(looseSpaces(DIST).slice(0, 20), []);
});

test("8.6.0 ADR-1403: the collapse frees at least 35000 bytes against the line-stripped build", () => {
  const stripped = Buffer.byteLength(B.stripLines(SOURCE));
  const dist = Buffer.byteLength(DIST);
  assert.ok(stripped - dist >= 35000, "freed " + (stripped - dist) + " bytes (stripLines " + stripped + ", dist " + dist + ")");
});

test("8.6.0 ADR-1403: changed_defs.py finds the same column-0 definitions in the dist as in the line-stripped build", () => {
  const dir = mkdtempSync(join(tmpdir(), "v860-defs-"));
  try {
    const a = join(dir, "stripped.js");
    const d = join(dir, "dist.js");
    writeFileSync(a, B.stripLines(SOURCE));
    writeFileSync(d, DIST);
    const py = [
      "import re, sys, json",
      "src = open(sys.argv[1]).read()",
      "i, j = src.index('\\nIDENT = re.compile'), src.index('\\ndef indent(')",
      "g = {'re': re}",
      "exec(src[i:j], g)",
      "names = lambda f: sorted(n for n in (g['defname']('js', l) for l in open(f).read().split('\\n')) if n)",
      "print(json.dumps([names(sys.argv[2]), names(sys.argv[3])]))",
    ].join("\n");
    const r = spawnSync("python3", ["-I", "-c", py, join(PLUGIN, "scripts", "changed_defs.py"), a, d], { encoding: "utf8", maxBuffer: 64 << 20 });
    assert.equal(r.status, 0, r.stderr);
    const [want, got] = JSON.parse(r.stdout);
    assert.ok(want.length > 500, "the stripped build has its definitions: " + want.length);
    assert.deepEqual(got, want);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("8.6.0 ADR-1403: --check exits non-zero, never skips, when the esbuild check cannot run", () => {
  const dir = mkdtempSync(join(tmpdir(), "v860-npx-"));
  try {
    const npx = join(dir, "npx");
    writeFileSync(npx, "#!/bin/sh\ncat >/dev/null\necho 'fake npx: no registry' >&2\nexit 7\n");
    chmodSync(npx, 0o755);
    const env = Object.assign({}, process.env, { PATH: dir + ":" + process.env.PATH });
    const r = spawnSync(process.execPath, [BUILD, "--check"], { encoding: "utf8", env, timeout: 300000 });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /npx esbuild@\d+\.\d+\.\d+ exited 7/);
    assert.doesNotMatch(r.stderr, /is stale|out of date/);
    // the dist on disk is not touched
    assert.equal(readFileSync(B.DIST, "utf8"), DIST);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
