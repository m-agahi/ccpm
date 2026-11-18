// fleet 7.4.0, hasher.py hook_refs (the tokens of a local pre-commit hook):
// - #16 (a) (L2021): a `--opt=value` token whose value is a repo file freezes that file (and its
//   dir tree, as every other referenced file does). Before, every `-` token was skipped, so
//   `ruff check --config=ruff.toml src` left ruff.toml free. A pure tightening.
// - #20 (L2026, Max ruling Q1 = (a)): in a non-lenient hook, a token of digits only, and the token
//   right after a PATH command named in the read-only subcommand table (cargo metadata/tree,
//   go mod verify/graph, git reads), are arguments, not unresolvable paths. Field hit: reachgraph `cargo metadata --locked --offline --format-version 1`
//   stopped at the freeze ("unresolvable local hook cargo-locked: 1, ... : metadata").
//   Every other plain token stays refused (non-weakening, K3 and the table below).
//
// dont_care: the order of `suspicious`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { SCRIPTS_SRC, sh, spawnSync, HASH_MAP_NAMES } from "./harness.mjs";

const HASHER = join(SCRIPTS_SRC, "hasher.py");
const GIT = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
const PY = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();

// a PATH that holds git and the stub tools only: the result never depends on the host's tools
const BIN = mkdtempSync(join(tmpdir(), "fleet-740-refs-bin-"));
symlinkSync(GIT, join(BIN, "git"));
for (const t of ["cargo", "go", "pytest", "python", "ruff", "flake8", "mytool"]) writeFileSync(join(BIN, t), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
const ENV = { PATH: BIN, HOME: BIN, GIT_CONFIG_NOSYSTEM: "1" };

const HOOK = (entry, args) =>
  "repos:\n  - repo: local\n    hooks:\n      - id: h\n        name: h\n        entry: " + entry + "\n" + (args ? "        args: " + JSON.stringify(args) + "\n" : "") + "        language: system\n        pass_filenames: false\n";

function repo() {
  const home = mkdtempSync(join(tmpdir(), "fleet-740-refs-"));
  const wt = join(home, "repo");
  const scratch = join(home, "scratch");
  mkdirSync(join(wt, "src"), { recursive: true });
  mkdirSync(join(wt, "cfg"), { recursive: true });
  mkdirSync(scratch);
  sh(wt, "git", "init", "-q");
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"]]) sh(wt, "git", "config", k, v);
  writeFileSync(join(wt, "ruff.toml"), "line-length = 100\n");
  writeFileSync(join(wt, "cfg", "lint.toml"), "x = 1\n");
  writeFileSync(join(wt, "cfg", "other.txt"), "o\n");
  writeFileSync(join(wt, "src", "x.py"), "x = 1\n");
  writeFileSync(join(wt, "Cargo.toml"), "[package]\nname = \"x\"\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-qm", "base");
  const hash = (entry, args) => {
    writeFileSync(join(wt, ".pre-commit-config.yaml"), HOOK(entry, args));
    const r = spawnSync(PY, ["-I", HASHER, wt, "[]", "", scratch], { encoding: "utf8", env: ENV });
    assert.equal(r.status, 0, r.stderr);
    const relay = JSON.parse(r.stdout);
    const files = JSON.parse(readFileSync(relay.hashes.files.file, "utf8"));
    return { files, bad: relay.hashes.suspicious };
  };
  return { wt, hash, done: () => rmSync(home, { recursive: true, force: true }) };
}

test("7.4.0 #16a K1: `flake8 --config=ruff.toml src` freezes ruff.toml (the plan's `ruff check` form needs a table word: `check` is no table entry)", () => {
  const f = repo();
  try {
    const o = f.hash("flake8 --config=ruff.toml src");
    assert.deepEqual(o.bad, []);
    assert.ok("ruff.toml" in o.files, Object.keys(o.files).join(", "));
  } finally {
    f.done();
  }
});

test("7.4.0 #16a K1: a `--opt=value` in args freezes the file and its dir tree (as any referenced file)", () => {
  const f = repo();
  try {
    const o = f.hash("flake8", ["--config=cfg/lint.toml", "src"]);
    assert.deepEqual(o.bad, []);
    assert.ok("cfg/lint.toml" in o.files);
    assert.ok("cfg/other.txt" in o.files, "the dir tree of a referenced file is frozen");
  } finally {
    f.done();
  }
});

test("7.4.0 #16a K1: `--max-line-length=100` adds nothing and is not bad; a value that is no repo file is skipped as before", () => {
  const f = repo();
  try {
    const base = f.hash("flake8 src");
    for (const entry of ["flake8 --max-line-length=100 src", "flake8 --config=nosuch.toml src", "flake8 --x=/etc/passwd src", "flake8 --x=../up src", "flake8 --x= src"]) {
      const o = f.hash(entry);
      assert.deepEqual(o.bad, [], entry);
      assert.deepEqual(Object.keys(o.files).sort(), Object.keys(base.files).sort(), entry);
    }
  } finally {
    f.done();
  }
});

test("7.4.0 #20 K2 (Max ruling Q1 (a)): `cargo metadata --locked --offline --format-version 1` has no bad token", () => {
  const f = repo();
  try {
    assert.deepEqual(f.hash("cargo metadata --locked --offline --format-version 1").bad, []);
    // security review of car 2: only subcommands that run no repo code (no build.rs, proc macro,
    // test or generated input): cargo metadata and tree, go mod verify/graph/why, git reads
    for (const entry of ["cargo tree --locked", "go mod", "go mod verify", "go mod graph", "git diff --exit-code", "git status", "git log -1", "pytest -q -n 4", "git ls-files"]) assert.deepEqual(f.hash(entry).bad, [], entry);
  } finally {
    f.done();
  }
});

// non-weakening: each of these was refused by the shipped gate and stays refused
test("7.4.0 #20 K3 non-weakening: unknown plain tokens stay unresolvable", () => {
  const f = repo();
  try {
    for (const [entry, tok] of [
      ["pytest -p myplug", "myplug"],
      ["python check_x", "check_x"],
      ["cargo frobnicate", "frobnicate"],
      // a subcommand counts only right after its command
      ["cargo --locked metadata", "metadata"],
      ["cargo tree metadata", "metadata"],
      // security review of car 2: subcommands that build or run repo code stay refused
      ["cargo build", "build"],
      ["cargo check", "check"],
      ["cargo clippy", "clippy"],
      ["cargo test", "test"],
      ["cargo nextest", "nextest"],
      ["cargo doc", "doc"],
      ["cargo fmt", "fmt"],
      ["go test", "test"],
      ["go build", "build"],
      ["go vet", "vet"],
      ["go generate", "generate"],
      ["go mod tidy", "tidy"],
      ["go mod download", "download"],
      ["go mod graph verify", "verify"],
      ["cargo verify", "verify"],
      ["git commit", "commit"],
      // the table is per tool: go's words are not cargo's, and other tools have none
      ["cargo vet", "vet"],
      ["cargo mod", "mod"],
      ["mytool metadata", "metadata"],
      ["ruff diff", "diff"],
      // digits only: not a sign, a dot or a letter
      ["pytest 1x", "1x"],
      ["pytest 1.5", "1.5"],
      ["pytest +1", "+1"],
    ]) {
      assert.deepEqual(f.hash(entry).bad, ["unresolvable local hook h: " + tok], entry);
    }
    // the command token itself stays strict: a digit or a table word is no command
    assert.deepEqual(f.hash("1 2").bad, ["unresolvable local hook h: 1"]);
    assert.deepEqual(f.hash("metadata").bad, ["unresolvable local hook h: metadata"]);
    // a repo script named like a table tool gives its argument no pass
    mkdirSync(join(f.wt, "tools"), { recursive: true });
    writeFileSync(join(f.wt, "tools", "cargo"), "#!/bin/sh\n", { mode: 0o755 });
    assert.deepEqual(f.hash("tools/cargo metadata").bad, ["unresolvable local hook h: metadata"]);
    // the 5.0.5 directory cases
    for (const [entry, tok] of [["pytest nosuch/ -q", "nosuch/"], ["pytest . -q", "."], ["pytest ../ -q", "../"]]) assert.deepEqual(f.hash(entry).bad, ["unresolvable local hook h: " + tok], entry);
    // -c payloads stay refused
    assert.deepEqual(f.hash("python -c 1").bad, ["unresolvable local hook h: inline payload after -c"]);
  } finally {
    f.done();
  }
});

test("7.4.0 #20 (security review): a cargo table pass freezes cargo's execution config (.cargo/config*, rust-toolchain*), absent ones as MISSING", () => {
  const f = repo();
  try {
    const none = f.hash("cargo tree --locked");
    assert.deepEqual(none.bad, []);
    for (const k of [".cargo/config.toml", ".cargo/config", "rust-toolchain.toml", "rust-toolchain"]) assert.equal(none.files[k], "MISSING", k);
    mkdirSync(join(f.wt, ".cargo"), { recursive: true });
    writeFileSync(join(f.wt, ".cargo", "config.toml"), "[build]\nrustc-wrapper = \"x\"\n");
    writeFileSync(join(f.wt, ".cargo", "config"), "\n");
    writeFileSync(join(f.wt, "rust-toolchain.toml"), "[toolchain]\nchannel = \"stable\"\n");
    writeFileSync(join(f.wt, "rust-toolchain"), "stable\n");
    // before: not frozen by any other rule
    const plain = f.hash("mytool src");
    for (const k of [".cargo/config.toml", ".cargo/config", "rust-toolchain.toml", "rust-toolchain"]) assert.ok(!(k in plain.files), k + " is frozen without the cargo hook; the test would be vacuous");
    const o = f.hash("cargo metadata --locked --offline --format-version 1");
    assert.deepEqual(o.bad, []);
    for (const k of [".cargo/config.toml", ".cargo/config", "rust-toolchain.toml", "rust-toolchain"]) assert.ok(k in o.files, k + ": " + Object.keys(o.files).join(", "));
  } finally {
    f.done();
  }
});
