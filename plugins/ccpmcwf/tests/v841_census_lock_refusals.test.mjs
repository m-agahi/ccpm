// ccpmcwf 8.4.1 (yaadgaar #106), AC3: gate_tools.py refuses an unsafe or non-matching uv.lock and
// falls through to the PATH tier. Every case: exit 0, no traceback, no hang, and the python
// coverage value is 'coverage' (a coverage stub is on the stub dir) or 'unsupported' (none is),
// never the uv string. The census reads uv.lock as data and never runs it; these cases must fall through.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync, readFileSync, existsSync, symlinkSync, openSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERE, HAVE_PY, spawnSync } from "./harness.mjs";

const PROG = join(HERE, "..", "scripts", "gate_tools.py");
const PY = HAVE_PY ? spawnSync("python3", ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim() : null;
const IMG = "openfantasy/audit-lab@sha256:" + "ab".repeat(32);
const LF = String.fromCharCode(10);
// COV is a lock the census would credit (PyPI source), so each guard below is what refuses it
const PYPI = 'source = { registry = "https://pypi.org/simple" }' + LF;
const COV_NAME = "[[package]]" + LF + 'name = "coverage"' + LF;
const COV = COV_NAME + PYPI;
const UVSTR = "uv run --frozen coverage";
const skip = !HAVE_PY;

// setup(repo, d) plants uv.lock (or anything else); opts.noCov omits the coverage stub; opts.uvInRepo puts uv only at <repo>/bin/uv
function run(setup, { noCov = false, uvInRepo = false } = {}) {
  const d = mkdtempSync(join(tmpdir(), "fleet-841-"));
  try {
    const repo = join(d, "repo");
    const bin = join(d, "bin");
    mkdirSync(join(repo, "bin"), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(repo, "pyproject.toml"), "\n");
    const log = join(d, "calls.log");
    const put = (dir, n) => {
      writeFileSync(join(dir, n), "#!/bin/sh\necho \"" + n + " $*\" >> '" + log + "'\nexit 0\n");
      chmodSync(join(dir, n), 0o755);
    };
    put(uvInRepo ? join(repo, "bin") : bin, "uv");
    if (!noCov) put(bin, "coverage");
    setup(repo, d);
    const r = spawnSync(PY, ["-I", PROG, repo, IMG], { encoding: "utf8", env: { PATH: bin + ":" + join(repo, "bin") }, timeout: 20000 });
    return { r, out: r.status === 0 ? JSON.parse(r.stdout) : null, calls: existsSync(log) ? readFileSync(log, "utf8").trim() : "" };
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}
function lock(text) {
  return (repo) => writeFileSync(join(repo, "uv.lock"), text);
}
function expectCov(res, want = "coverage") {
  assert.equal(res.r.status, 0, "exit 0, stderr: " + res.r.stderr);
  assert.ok(!/Traceback/.test(res.r.stderr), "no traceback");
  assert.equal(res.out.matrix.python.coverage, want);
  assert.notEqual(res.out.matrix.python.coverage, UVSTR);
}

test("AC3: symlinked uv.lock is refused", { skip }, () => {
  // AC3: symlink to a file outside the repo whose text is COV
  const res = run((repo, d) => {
    writeFileSync(join(d, "outside.lock"), COV);
    symlinkSync(join(d, "outside.lock"), join(repo, "uv.lock"));
  });
  expectCov(res);
  // AC3: triangulation, the target holds more packages
  const res2 = run((repo, d) => {
    writeFileSync(join(d, "o2.lock"), '[[package]]' + LF + 'name = "pytest"' + LF + COV);
    symlinkSync(join(d, "o2.lock"), join(repo, "uv.lock"));
  });
  expectCov(res2);
});

test("AC3: uv.lock of 16777217 bytes is refused", { skip }, () => {
  // AC3: boundary, exactly 16777217 bytes
  const head = COV + "#";
  const fill = (n) => (repo) => {
    const body = head + "x".repeat(n - head.length - 1) + LF;
    assert.equal(Buffer.byteLength(body), n);
    writeFileSync(join(repo, "uv.lock"), body);
  };
  expectCov(run(fill(16777217)));
  // AC3: triangulation, a larger file
  expectCov(run(fill(16777217 + 4096)));
});

test("AC3: FIFO uv.lock does not hang and is refused", { skip }, () => {
  // AC3: FIFO nobody writes to, spawned with a 20000 ms timeout
  const res = run((repo) => {
    const m = spawnSync("mkfifo", [join(repo, "uv.lock")]);
    assert.equal(m.status, 0);
  });
  assert.equal(res.r.signal, null, "process exited before the timeout");
  expectCov(res);
});

test("AC3: directory uv.lock is refused", { skip }, () => {
  // AC3: uv.lock is a directory
  expectCov(run((repo) => mkdirSync(join(repo, "uv.lock"))));
  // AC3: triangulation, a directory that holds a coverage lock file
  expectCov(run((repo) => {
    mkdirSync(join(repo, "uv.lock"));
    writeFileSync(join(repo, "uv.lock", "uv.lock"), COV);
  }));
});

test("AC3: malformed TOML is refused", { skip }, () => {
  // AC3: '[[package]' with a missing bracket
  expectCov(run(lock("[[package]" + LF + 'name = "coverage"' + LF)));
  // AC3: triangulation, an unterminated string
  expectCov(run(lock(COV + 'x = "oops' + LF)));
});

test("AC3: non-UTF-8 uv.lock is refused", { skip }, () => {
  // AC3: 0xFF 0xFE then the UTF-8 bytes of COV
  expectCov(run((repo) => writeFileSync(join(repo, "uv.lock"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(COV)]))));
  // AC3: triangulation, a stray 0x80 byte inside an otherwise valid lock
  expectCov(run((repo) => writeFileSync(join(repo, "uv.lock"), Buffer.concat([Buffer.from(COV), Buffer.from("# "), Buffer.from([0x80]), Buffer.from(LF)]))));
});

test("AC3: coverage only as a dependency gives unsupported", { skip }, () => {
  // AC3: no coverage stub; coverage is a dependency of pytest-cov
  const dep = "[[package]]" + LF + 'name = "pytest-cov"' + LF + 'dependencies = [{ name = "coverage" }]' + LF;
  expectCov(run(lock(dep), { noCov: true }), "unsupported");
  // AC3: triangulation, another package depends on coverage
  const dep2 = "[[package]]" + LF + 'name = "other"' + LF + 'dependencies = [{ name = "coverage" }]' + LF;
  expectCov(run(lock(dep2), { noCov: true }), "unsupported");
});

test("AC3: a near name is not coverage", { skip }, () => {
  // AC3: name = "coverage-badge"
  expectCov(run(lock("[[package]]" + LF + 'name = "coverage-badge"' + LF)));
  // AC3: triangulation, name = "coverage2"
  expectCov(run(lock("[[package]]" + LF + 'name = "coverage2"' + LF)));
});

test("AC3: uv only inside the repo is never run and not used", { skip }, () => {
  // AC3: uv at <repo>/bin/uv only, no coverage stub, lock lists coverage
  const res = run(lock(COV), { noCov: true, uvInRepo: true });
  expectCov(res, "unsupported");
  assert.equal(res.calls, "", "no stub ran");
});

test("AC3: deeply nested TOML (RecursionError) is refused", { skip }, () => {
  // AC3: 200000 nested arrays
  const res = run(lock("a = " + "[".repeat(200000) + "]".repeat(200000) + LF));
  expectCov(res);
  assert.ok(!/Traceback/.test(res.r.stderr));
});

test("AC3: wrong types of package, its entries and name are refused", { skip }, () => {
  // AC3: package = 1
  expectCov(run(lock("package = 1" + LF)));
  // AC3: package = [1, "coverage"]
  expectCov(run(lock('package = [1, "coverage"]' + LF)));
  // AC3: name = 1
  expectCov(run(lock("[[package]]" + LF + "name = 1" + LF)));
  // AC3: triangulation, name = ["coverage"]
  expectCov(run(lock("[[package]]" + LF + 'name = ["coverage"]' + LF)));
});

test("AC3: property, never raises for any uv.lock content", { skip }, () => {
  // AC3: never-raises, exit 0 and one JSON line for each content
  const cases = ["", LF, "\0", "[", "]]", "= 1", 'package = "coverage"' + LF, "[package]" + LF + 'name = "coverage"' + LF, "[[package]]" + LF, "[[package]]" + LF + "name = true" + LF, "[[package]]" + LF + "name = {}" + LF];
  for (const c of cases) {
    const res = run(lock(c));
    expectCov(res);
    assert.equal(res.r.stdout.trim().split(LF).length, 1, "one JSON line for " + JSON.stringify(c));
  }
});

test("AC3: FIFO uv.lock that already holds coverage data is refused", { skip }, () => {
  // AC3: FIFO fed with COV through an O_RDWR fd kept open while the census runs; a regular-file check must refuse it
  const feed = (text) => {
    const fds = [];
    const res = run(
      (repo) => {
        const f = join(repo, "uv.lock");
        assert.equal(spawnSync("mkfifo", [f]).status, 0);
        const fd = openSync(f, "r+");
        fds.push(fd);
        writeSync(fd, text);
      },
      { noCov: false },
    );
    for (const fd of fds) closeSync(fd);
    return res;
  };
  const res = feed(COV);
  assert.equal(res.r.signal, null, "process exited before the timeout");
  expectCov(res);
  // AC3: triangulation, same fed FIFO with no coverage stub gives unsupported
  const fds2 = [];
  const res2 = run(
    (repo) => {
      const f = join(repo, "uv.lock");
      assert.equal(spawnSync("mkfifo", [f]).status, 0);
      const fd = openSync(f, "r+");
      fds2.push(fd);
      writeSync(fd, COV + '[[package]]' + LF + 'name = "pytest"' + LF);
    },
    { noCov: true },
  );
  for (const fd of fds2) closeSync(fd);
  assert.equal(res2.r.signal, null, "process exited before the timeout");
  expectCov(res2, "unsupported");
});

// S1 (PR #106 review, Max 2026-11-23: PyPI only): a coverage entry counts only when its source is
// exactly { registry = "https://pypi.org/simple" }. Any other source falls through; with no
// coverage on PATH the row is unsupported, as on base 7392bd1.
const SOURCES = {
  directory: 'source = { directory = "vendor/coverage" }',
  editable: 'source = { editable = "." }',
  path: 'source = { path = "wheels/coverage-0.0.1-py3-none-any.whl" }',
  git: 'source = { git = "https://example.invalid/evil/coverage?rev=main#0123456789abcdef0123456789abcdef01234567" }',
  url: 'source = { url = "https://example.invalid/coverage-0.0.1.tar.gz" }',
  virtual: 'source = { virtual = "." }',
  "other registry": 'source = { registry = "https://evil.example/simple" }',
  "registry with a trailing slash": 'source = { registry = "https://pypi.org/simple/" }',
  "registry plus an extra key": 'source = { registry = "https://pypi.org/simple", path = "x" }',
  "source not a table": 'source = "https://pypi.org/simple"',
  "missing source": "",
};
for (const [kind, src] of Object.entries(SOURCES)) {
  test("S1: a coverage entry with " + kind + " is not credited", { skip }, () => {
    // S1: no coverage stub, so a refused entry gives unsupported
    expectCov(run(lock(COV_NAME + 'version = "0.0.1"' + LF + src + LF), { noCov: true }), "unsupported");
    // S1: with a coverage stub on PATH the PATH tier is used
    expectCov(run(lock(COV_NAME + 'version = "0.0.1"' + LF + src + LF)), "coverage");
  });
}

test("S1: one PyPI and one non-PyPI coverage entry is not credited", { skip }, () => {
  const two = COV_NAME + 'version = "7.15.0"' + LF + PYPI + LF + COV_NAME + 'version = "0.0.1"' + LF + 'source = { directory = "vendor/coverage" }' + LF;
  expectCov(run(lock(two), { noCov: true }), "unsupported");
  // S1: triangulation, the non-PyPI entry first
  const two2 = COV_NAME + 'version = "0.0.1"' + LF + 'source = { editable = "." }' + LF + LF + COV_NAME + 'version = "7.15.0"' + LF + PYPI;
  expectCov(run(lock(two2), { noCov: true }), "unsupported");
});

test("S1: a coverage entry from the PyPI registry is credited", { skip }, () => {
  // S1: the form uv writes (checked against a real uv.lock)
  const res = run(lock(COV_NAME + 'version = "7.15.0"' + LF + PYPI), { noCov: true });
  assert.equal(res.r.status, 0, res.r.stderr);
  assert.equal(res.out.matrix.python.coverage, UVSTR);
  assert.equal(res.calls, "", "no stub ran");
});
