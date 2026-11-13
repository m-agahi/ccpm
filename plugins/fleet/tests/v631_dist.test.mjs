// fleet 6.3.1 (ledger 2129): the workflow ships as a build output.
//
// The commented source is plugins/fleet/src/build-task-run.js. The Claude Code
// plugin loader registers every plugins/<p>/workflows/*.js, so the source lives
// outside workflows/. scripts/build-workflow.mjs writes
// workflows/build-task-run.js from it: the `export const meta` block verbatim,
// then the body through a line stripper (indentation, empty and comment-only
// lines cut); esbuild --minify-whitespace (a pinned version) is an equivalence
// check of source and dist, not the build. The dist is committed: the plugin installs from
// git. These tests fail when the dist is stale, and they fail (never skip) when
// esbuild cannot run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { SOURCE, SRC_PATH, DIST, DIST_PATH, compile } from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, "..");
const BUILD = join(PLUGIN, "scripts", "build-workflow.mjs");
const B = await import(BUILD);
const GEN = await import(join(PLUGIN, "scripts", "gen.mjs"));

test("6.3.1 2129: the source lives outside workflows/ and the dist is the only workflow file", () => {
  assert.equal(relative(PLUGIN, SRC_PATH), join("src", "build-task-run.js"));
  assert.equal(relative(PLUGIN, DIST_PATH), join("workflows", "build-task-run.js"));
  assert.equal(B.SRC, SRC_PATH);
  assert.equal(B.DIST, DIST_PATH);
  assert.deepEqual(readdirSync(join(PLUGIN, "workflows")), ["build-task-run.js"]);
  assert.deepEqual(readdirSync(join(PLUGIN, "src")), ["build-task-run.js"]);
  assert.equal(SOURCE, readFileSync(SRC_PATH, "utf8"));
  assert.equal(DIST, readFileSync(DIST_PATH, "utf8"));
});

test("6.3.1 2129: esbuild is pinned to one exact version", () => {
  assert.match(B.ESBUILD_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(B.ESBUILD_SPEC, "esbuild@" + B.ESBUILD_VERSION);
});

test("6.3.1 2129: the committed dist is the build of the committed source", () => {
  assert.ok(B.buildWorkflow(SOURCE) === DIST, "workflows/build-task-run.js is stale: run `node plugins/fleet/scripts/build-workflow.mjs` and commit both files");
});

test("6.3.1 2129: the source and the dist minify (esbuild --minify-whitespace) to the same bytes; fails, never skips, when esbuild cannot run", () => {
  let diff;
  try {
    diff = B.equivalence(SOURCE, DIST);
  } catch (e) {
    assert.fail("cannot run esbuild " + B.ESBUILD_VERSION + " via npx: " + e.message + "\nThis test never skips: it needs Node's npx and the npm registry (or the npx cache).");
  }
  assert.equal(diff, null);
  // the check sees a change inside a line
  const i = DIST.indexOf('const FLEET_VERSION = "');
  assert.ok(i > 0);
  assert.notEqual(B.equivalence(SOURCE, DIST.slice(0, i) + DIST.slice(i).replace('= "', '= "x')), null);
});

test("6.3.1 2129: build-workflow.mjs --check passes on the committed files", () => {
  const r = spawnSync("node", [BUILD, "--check"], { encoding: "utf8", timeout: 300000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("6.3.1 2129: the dist keeps the meta block byte for byte, the table markers and the lines; it drops only comment lines, empty lines and indentation", () => {
  const { meta, body } = B.splitMeta(SOURCE);
  assert.ok(meta.startsWith("export const meta = {\n"));
  assert.ok(meta.endsWith("\n};\n"));
  assert.ok(DIST.startsWith(meta), "dist starts with the source's meta block");
  assert.ok(DIST.endsWith("\n"));
  const lines = DIST.slice(meta.length).split("\n").slice(0, -1);
  const comments = lines.filter((l) => l.startsWith("//"));
  const markers = body.split("\n").filter((l) => B.MARKER_RE.test(l));
  assert.ok(markers.length >= 10, "the source has its table markers");
  assert.deepEqual(comments, markers, "only the table markers stay as comment lines");
  assert.ok(lines.every((l) => l !== "" && !/^[ \t]/.test(l)));
  const kept = body.split("\n").map((l) => l.replace(/^[ \t]+/, "")).filter((l) => l !== "" && (!l.startsWith("//") || B.MARKER_RE.test(l)));
  assert.deepEqual(lines, kept);
  assert.equal(typeof compile(DIST), "function");
  // the FLEET_VERSION literal survives (the preflight looks for fleet/<version>/scripts)
  const v = /^const FLEET_VERSION = "(\d+\.\d+\.\d+)";$/m.exec(SOURCE)[1];
  assert.match(DIST, new RegExp('^const FLEET_VERSION = "' + v.replace(/\./g, "\\.") + '";$', "m"));
});

test("6.3.1 2129: gen.mjs reads the same tables from the dist as from the source", () => {
  assert.deepEqual(GEN.programs(DIST), GEN.programs(SOURCE));
  assert.deepEqual(GEN.roles(DIST), GEN.roles(SOURCE));
  assert.deepEqual(GEN.dispatches(DIST), GEN.dispatches(SOURCE));
  assert.deepEqual(GEN.shared(DIST), GEN.shared(SOURCE));
});

test("6.3.1 2129: the dist holds no control or invisible format character (the loader refuses them)", () => {
  const bad = [];
  for (const [i, ch] of [...DIST].entries()) {
    if (ch === "\n" || ch === "\t") continue;
    if (/[\p{Cc}\p{Cf}\u00a0\u2028\u2029]/u.test(ch)) bad.push(i + ": U+" + ch.codePointAt(0).toString(16));
  }
  assert.deepEqual(bad, []);
});

test("6.3.1 2129: the dist stays at most 480000 bytes, under Claude Code's 524288-byte cap (ADR-1189)", () => {
  const n = statSync(DIST_PATH).size;
  assert.ok(480000 < 524288);
  assert.ok(n <= 480000, "dist is " + n + " bytes");
  assert.ok(existsSync(SRC_PATH));
});
