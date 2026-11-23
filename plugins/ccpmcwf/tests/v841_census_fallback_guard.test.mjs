// ccpmcwf 8.4.1 AC2 (yaadgaar #106): when the uv tier does not apply, the python row of the gate
// census keeps today's result: PATH `coverage` when which('coverage') finds it on the cleaned PATH,
// else `unsupported`. A coverage planted inside the repo and a repo .venv/bin/coverage are never
// reported (the venv tier is dropped). A relative <repo> reads no repo file. The node row is unchanged.
//
// Guard file: the examples hold on the shipped code; they fail when the new uv tier accepts input
// it must refuse. Every run uses python3 by absolute path, PATH = a stub dir and <repo>/bin only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative as relPath } from "node:path";
import { HERE, HAVE_PY, spawnSync } from "./harness.mjs";

const PROG = join(HERE, "..", "scripts", "gate_tools.py");
const PY = HAVE_PY ? spawnSync("python3", ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim() : null;
const IMG = "openfantasy/audit-lab@sha256:" + "ab".repeat(32);
const LF = String.fromCharCode(10);
const lock = (name) => "[[package]]" + LF + 'name = "' + name + '"' + LF;

// gate_tools.py on a temp repo. markers/files: relative paths written under the repo.
// stubs: names put on the stub dir; planted: names put in <repo>/bin (on PATH, inside the repo);
// inRepo: extra executable stubs at repo-relative paths (for example .venv/bin/coverage).
// Each stub appends its argv to calls.log. relative: true passes the string 'repo' with cwd = the temp dir;
// relative: 'root' passes the repo path relative to '/' (the program chdirs to '/' before any read, so
// this relative path still reaches the real temp repo for a program that wrongly accepts it).
function census({ markers = [], files = {}, stubs = [], planted = [], inRepo = [], relative = false } = {}) {
  const d = mkdtempSync(join(tmpdir(), "fleet-841-ac2-"));
  try {
    const repo = join(d, "repo");
    const bin = join(d, "bin");
    mkdirSync(join(repo, "bin"), { recursive: true });
    mkdirSync(bin);
    const log = join(d, "calls.log");
    const put = (file, n) => {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, "#!/bin/sh\necho \"" + n + " $*\" >> '" + log + "'\nexit 0\n");
      chmodSync(file, 0o755);
    };
    for (const m of markers) writeFileSync(join(repo, m), "\n");
    for (const [p, c] of Object.entries(files)) writeFileSync(join(repo, p), c);
    for (const n of stubs) put(join(bin, n), n);
    for (const n of planted) put(join(repo, "bin", n), n);
    for (const p of inRepo) put(join(repo, p), p);
    const r = spawnSync(PY, ["-I", PROG, relative === "root" ? relPath("/", repo) : relative ? "repo" : repo, IMG], {
      encoding: "utf8",
      cwd: d,
      env: { PATH: bin + ":" + join(repo, "bin") },
    });
    assert.equal(r.status, 0, r.stderr);
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim() : "";
    return { out: JSON.parse(r.stdout), calls };
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

test("AC2: python row is PATH `coverage` when no uv.lock exists (main)", { skip: !HAVE_PY }, () => {
  // AC2: temp repo with pyproject.toml, no uv.lock, no .venv, `coverage` stub on the stub dir
  const a = census({ markers: ["pyproject.toml"], stubs: ["coverage"] });
  assert.equal(a.out.matrix.python.coverage, "coverage");
  // AC2: triangulation, another python marker file gives the same PATH tier
  const b = census({ markers: ["requirements.txt"], stubs: ["coverage"] });
  assert.equal(b.out.matrix.python.coverage, "coverage");
});

test("AC2: python row is unsupported when no tool is anywhere (boundary)", { skip: !HAVE_PY }, () => {
  // AC2: temp repo with pyproject.toml; no tool anywhere
  const a = census({ markers: ["pyproject.toml"] });
  assert.equal(a.out.matrix.python.coverage, "unsupported");
  // AC2: triangulation, a repo with no marker at all
  const b = census({});
  assert.equal(b.out.matrix.python.coverage, "unsupported");
});

test("AC2: a coverage planted inside the repo is never reported (refusal)", { skip: !HAVE_PY }, () => {
  // AC2: `coverage` stub only at <repo>/bin/coverage, on PATH, inside the repo
  const a = census({ markers: ["pyproject.toml"], planted: ["coverage"] });
  assert.equal(a.out.matrix.python.coverage, "unsupported");
  assert.equal(a.calls, "");
  // AC2: triangulation, a planted coverage in a repo whose python marker is requirements.txt, no uv.lock
  const b = census({ markers: ["requirements.txt"], planted: ["coverage"] });
  assert.equal(b.out.matrix.python.coverage, "unsupported");
  assert.equal(b.calls, "");
});

test("AC2: a uv.lock without coverage, uv and coverage on PATH, keeps PATH `coverage` (boundary)", { skip: !HAVE_PY }, () => {
  // AC2: uv.lock lists only pytest; uv stub and coverage stub on the stub dir
  const a = census({ markers: ["pyproject.toml"], files: { "uv.lock": lock("pytest") }, stubs: ["uv", "coverage"] });
  assert.equal(a.out.matrix.python.coverage, "coverage");
  // AC2: triangulation, another package name
  const b = census({ markers: ["pyproject.toml"], files: { "uv.lock": lock("requests") }, stubs: ["uv", "coverage"] });
  assert.equal(b.out.matrix.python.coverage, "coverage");
});

test("AC2: a uv.lock without coverage, uv on PATH, no coverage is unsupported (refusal)", { skip: !HAVE_PY }, () => {
  // AC2: uv.lock lists only pytest; uv stub on the stub dir; no coverage anywhere
  const a = census({ markers: ["pyproject.toml"], files: { "uv.lock": lock("pytest") }, stubs: ["uv"] });
  assert.equal(a.out.matrix.python.coverage, "unsupported");
  // AC2: triangulation, another package name
  const b = census({ markers: ["pyproject.toml"], files: { "uv.lock": lock("requests") }, stubs: ["uv"] });
  assert.equal(b.out.matrix.python.coverage, "unsupported");
});

test("AC2: a uv.lock with coverage but no uv on PATH keeps PATH `coverage` (boundary)", { skip: !HAVE_PY }, () => {
  // AC2: uv.lock lists coverage; no uv on any PATH dir; coverage stub on the stub dir
  const a = census({ markers: ["pyproject.toml"], files: { "uv.lock": lock("coverage") }, stubs: ["coverage"] });
  assert.equal(a.out.matrix.python.coverage, "coverage");
  // AC2: triangulation, the lock also lists pytest first
  const b = census({ markers: ["pyproject.toml"], files: { "uv.lock": lock("pytest") + LF + lock("coverage") }, stubs: ["coverage"] });
  assert.equal(b.out.matrix.python.coverage, "coverage");
});

test("AC2: a uv.lock with coverage, no uv and no coverage is unsupported (refusal)", { skip: !HAVE_PY }, () => {
  // AC2: uv.lock lists coverage; no uv and no coverage on any PATH dir
  const a = census({ markers: ["pyproject.toml"], files: { "uv.lock": lock("coverage") } });
  assert.equal(a.out.matrix.python.coverage, "unsupported");
  // AC2: triangulation, the lock lists coverage as the 2nd of 2 packages; no uv and no coverage anywhere
  const b = census({ markers: ["pyproject.toml"], files: { "uv.lock": lock("pytest") + LF + lock("coverage") } });
  assert.equal(b.out.matrix.python.coverage, "unsupported");
});

test("AC2: a repo .venv/bin/coverage is never reported (venv tier dropped, refusal)", { skip: !HAVE_PY }, () => {
  // AC2: <repo>/.venv/bin/coverage is a regular 0755 stub; no uv.lock; no coverage on PATH
  const a = census({ markers: ["pyproject.toml"], inRepo: [".venv/bin/coverage"] });
  assert.equal(a.out.matrix.python.coverage, "unsupported");
  assert.equal(a.calls, "");
  // AC2: triangulation, the venv stub beside a uv.lock without coverage and uv on PATH
  const b = census({ markers: ["pyproject.toml"], files: { "uv.lock": lock("pytest") }, stubs: ["uv"], inRepo: [".venv/bin/coverage"] });
  assert.equal(b.out.matrix.python.coverage, "unsupported");
  assert.equal(b.calls, "");
});

test("AC2: a relative <repo> reads no repo file (boundary)", { skip: !HAVE_PY }, () => {
  // AC2: coverage stub on the stub dir; the repo argument is the relative string 'repo'
  const a = census({ relative: true, stubs: ["coverage"] });
  assert.equal(a.out.matrix.python.coverage, "coverage");
  assert.deepEqual(a.out.languages, ["other"]);
  // AC2: triangulation, a relative repo whose uv.lock lists coverage, with uv on PATH, still reads no file;
  // the repo argument is relative to '/', so a program that accepted it would reach the real repo
  const b = census({ relative: "root", markers: ["pyproject.toml"], files: { "uv.lock": lock("coverage") }, stubs: ["coverage", "uv"] });
  assert.equal(b.out.matrix.python.coverage, "coverage");
  assert.deepEqual(b.out.languages, ["other"]);
});

test("AC2: the node row is unchanged (main)", { skip: !HAVE_PY }, () => {
  // AC2: temp repo with package.json; `c8` stub on the stub dir
  const a = census({ markers: ["package.json"], stubs: ["c8"] });
  assert.equal(a.out.matrix.node.coverage, "c8");
  // AC2: triangulation, jest is found first in the node tool order, and no tool is unsupported
  const b = census({ markers: ["package.json"], stubs: ["jest", "c8"] });
  assert.equal(b.out.matrix.node.coverage, "jest");
  const c = census({ markers: ["package.json"] });
  assert.equal(c.out.matrix.node.coverage, "unsupported");
});

test("AC2: a coverage-listing uv.lock with uv on PATH never changes the node, go, rust or other rows (refusal)", { skip: !HAVE_PY }, () => {
  const UVRUN = "uv run --frozen coverage";
  // AC2: package.json plus a uv.lock listing coverage; uv stub and c8 stub on the stub dir; the node row stays c8
  const a = census({ markers: ["package.json"], files: { "uv.lock": lock("coverage") }, stubs: ["uv", "c8"] });
  assert.equal(a.out.matrix.node.coverage, "c8");
  // AC2: same lock and uv stub, no node tool anywhere; the node row stays unsupported
  const b = census({ markers: ["package.json"], files: { "uv.lock": lock("coverage") }, stubs: ["uv"] });
  assert.equal(b.out.matrix.node.coverage, "unsupported");
  for (const row of ["go", "rust", "other"]) {
    assert.notEqual(b.out.matrix[row].coverage, UVRUN);
    assert.notEqual(a.out.matrix[row].coverage, UVRUN);
  }
  // AC2: triangulation, jest first in the node tool order, uv lock present
  const c = census({ markers: ["package.json"], files: { "uv.lock": lock("coverage") }, stubs: ["uv", "jest", "c8"] });
  assert.equal(c.out.matrix.node.coverage, "jest");
});
