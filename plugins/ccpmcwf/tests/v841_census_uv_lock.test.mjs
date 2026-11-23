// ccpmcwf 8.4.1 (yaadgaar #106), AC1: the gate census python row, uv tier.
// A python repo whose root uv.lock has a [[package]] named "coverage", with `uv` on the cleaned
// PATH, reports `uv run --frozen coverage`. It wins over PATH coverage. The census runs no process
// for it (the stub call log stays empty).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERE, HAVE_PY, spawnSync } from "./harness.mjs";

const PROG = join(HERE, "..", "scripts", "gate_tools.py");
const PY = HAVE_PY ? spawnSync("python3", ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim() : null;
const IMG = "openfantasy/audit-lab@sha256:" + "ab".repeat(32);
const LF = String.fromCharCode(10);
const UV_RUN = "uv run --frozen coverage";

// gate_tools.py on a temp repo. PATH = the stub dir, then <repo>/bin. Each stub appends its argv to calls.log.
function census({ markers = ["pyproject.toml"], lock, stubs = {} }) {
  const d = mkdtempSync(join(tmpdir(), "fleet-841-"));
  try {
    const repo = join(d, "repo");
    const bin = join(d, "bin");
    mkdirSync(join(repo, "bin"), { recursive: true });
    mkdirSync(bin);
    for (const m of markers) writeFileSync(join(repo, m), LF);
    if (lock !== undefined) writeFileSync(join(repo, "uv.lock"), lock);
    const log = join(d, "calls.log");
    for (const [n, c] of Object.entries(stubs)) {
      writeFileSync(join(bin, n), "#!/bin/sh\necho \"" + n + " $*\" >> '" + log + "'\nexit " + c + "\n");
      chmodSync(join(bin, n), 0o755);
    }
    const r = spawnSync(PY, ["-I", PROG, repo, IMG], { encoding: "utf8", env: { PATH: bin + ":" + join(repo, "bin") } });
    assert.equal(r.status, 0, r.stderr);
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim() : "";
    return { out: JSON.parse(r.stdout), calls };
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

const MAIN_LOCK = "[[package]]" + LF + 'name = "coverage"' + LF + 'version = "7.17.4"' + LF;

test("8.4.1 AC1: uv.lock locks coverage and uv is on PATH -> uv run --frozen coverage; no stub ran", { skip: !HAVE_PY }, () => {
  // AC1: main example
  const { out, calls } = census({ lock: MAIN_LOCK, stubs: { uv: 0, coverage: 0 } });
  assert.equal(out.matrix.python.coverage, UV_RUN);
  assert.equal(out.matrix.python.mutation, "builtin");
  // AC1: the census runs neither uv nor coverage
  assert.equal(calls, "");
});

test("8.4.1 AC1: the uv tier wins over PATH coverage; a different lock still gives the same value", { skip: !HAVE_PY }, () => {
  // AC1: triangulation, coverage stub present, no version key, other package first
  const lock = "[[package]]" + LF + 'name = "attrs"' + LF + LF + "[[package]]" + LF + 'name = "coverage"' + LF;
  const { out, calls } = census({ lock, stubs: { uv: 0, coverage: 0 } });
  assert.equal(out.matrix.python.coverage, UV_RUN);
  // AC1: property, calls.log stays empty
  assert.equal(calls, "");
});

test("8.4.1 AC1: coverage is the 2nd of 3 packages", { skip: !HAVE_PY }, () => {
  // AC1: boundary example
  const lock = "[[package]]" + LF + 'name = "pytest"' + LF + LF + "[[package]]" + LF + 'name = "coverage"' + LF + LF + "[[package]]" + LF + 'name = "pluggy"' + LF;
  const { out } = census({ lock, stubs: { uv: 0 } });
  assert.equal(out.matrix.python.coverage, UV_RUN);
});

test("8.4.1 AC1: coverage is the last of 3 packages (triangulation)", { skip: !HAVE_PY }, () => {
  // AC1: triangulation of the boundary example
  const lock = "[[package]]" + LF + 'name = "pluggy"' + LF + LF + "[[package]]" + LF + 'name = "pytest"' + LF + LF + "[[package]]" + LF + 'name = "coverage"' + LF;
  const { out } = census({ lock, stubs: { uv: 0 } });
  assert.equal(out.matrix.python.coverage, UV_RUN);
});

test("8.4.1 AC1: a lock of exactly 16777216 bytes is read", { skip: !HAVE_PY }, () => {
  // AC1: boundary example, cap
  const head = "[[package]]" + LF + 'name = "coverage"' + LF + "#";
  const k = 16777216 - head.length - 1;
  const lock = head + "x".repeat(k) + LF;
  assert.equal(Buffer.byteLength(lock), 16777216);
  const { out } = census({ lock, stubs: { uv: 0 } });
  assert.equal(out.matrix.python.coverage, UV_RUN);
});

test("8.4.1 AC1: no python marker (only package.json) still fills the python row", { skip: !HAVE_PY }, () => {
  // AC1: boundary example, no python marker
  const { out } = census({ markers: ["package.json"], lock: MAIN_LOCK, stubs: { uv: 0 } });
  assert.deepEqual(out.languages, ["node"]);
  assert.equal(out.matrix.python.coverage, UV_RUN);
});

test("8.4.1 AC1: package as an inline list mixing a non-table and a table named coverage", { skip: !HAVE_PY }, () => {
  // AC1: a top-level package list holding a table named exactly coverage, after a non-table entry
  const lock = 'package = [1, {name = "coverage"}]' + LF;
  const { out, calls } = census({ lock, stubs: { uv: 0 } });
  assert.equal(out.matrix.python.coverage, UV_RUN);
  // AC1: the census runs no process
  assert.equal(calls, "");
});
