// ccpmcwf 8.2.4 (yaadgaar #86): the held-out runner relays the sealed store hash, never the output digest.
//
// Run wf_ae59597d-2f6 stopped at "role:fleet-held-out-runner:r1: store_digest off the seal": held_out.py show
// printed both sha256 (the sealed store hash) and digest (the relay digest of the output), and a sonnet runner
// copied digest into store_digest. show now also prints store_digest (equal to sha256), and the role file names
// that key and forbids digest. The engine check stays strict (store_digest must equal held_out.sha256).
//
// dont_care: the wording of the role text past the named keys; the order of the keys in show's output.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERE, HAVE_PY, SOURCE, ARGS, happy, run, inputsOf, sha256, canon, spawnSync } from "./harness.mjs";

const PROG = join(HERE, "..", "scripts", "held_out.py");
const ROLE = readFileSync(join(HERE, "..", "roles", "fleet-held-out-runner.md"), "utf8");
const TASK = "y42";
const DOC = "# plan\n\nAC1: given g, when f(1), then 2.\n";

test("8.2.4 #86 R1: the role file sets store_digest to the printed store_digest (= sha256) and forbids the digest key", () => {
  const named = ROLE.split("\n").filter((l) => l.includes("`store_digest`"));
  assert.ok(named.length >= 2, "step 1 and the Output section name store_digest");
  assert.match(ROLE, /`store_digest` to the printed `store_digest` \(it equals the printed `sha256` and `held_out\.sha256`\)/);
  assert.match(ROLE, /Never use the printed `digest` key/);
  assert.match(ROLE, /`store_digest` \(the printed `store_digest`, never `digest`; null when `store` is not `ok`\)/);
  assert.match(ROLE, /It prints `\{examples, sha256, store_digest, args, program, digest\}`/);
});

test("8.2.4 #86 R2: the program lists store_digest for show (relay keys and the output schema)", () => {
  assert.match(SOURCE, /"held_out:show": \["examples", "sha256", "store_digest", "args"\]/);
  assert.match(SOURCE, /\n  held_out: \{ store_digest: STR, sha256: STR_OR_NULL,/);
});

test("8.2.4 #86 P1: held_out.py show prints store_digest == sha256 == the sealed hash, digest differs and covers every other key", { skip: !HAVE_PY }, () => {
  const d = mkdtempSync(join(tmpdir(), "fleet-824-"));
  try {
    mkdirSync(join(d, "main", "docs", "plans"), { recursive: true });
    writeFileSync(join(d, "main", "docs", "plans", "x.md"), DOC);
    const cdir = join(d, "scratch", "chunks", "held-out-t");
    mkdirSync(cdir, { recursive: true });
    const payload = { examples: [{ criterion_id: "AC1", given: "g", when: "f(9)", then: "81" }], visible: [null] };
    const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    writeFileSync(join(cdir, "0.b64"), b64);
    const env = { PATH: "/nonexistent", HOME: join(d, "home"), XDG_CONFIG_HOME: join(d, "xdg") };
    const py = spawnSync("python3", ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim();
    const w = spawnSync(py, ["-I", PROG, "write", join(d, "main"), TASK, "docs/plans/x.md", sha256(DOC), cdir, "1", sha256(JSON.stringify(payload)), JSON.stringify([{ i: 0, sha256: sha256(b64) }])], { encoding: "utf8", env });
    assert.equal(w.status, 0, w.stderr);
    const sealed = JSON.parse(w.stdout).sha256;
    assert.match(sealed, /^[0-9a-f]{64}$/);
    const s = spawnSync(py, ["-I", PROG, "show", TASK, sha256(DOC), sealed], { encoding: "utf8", env });
    assert.equal(s.status, 0, s.stderr);
    const o = JSON.parse(s.stdout);
    assert.equal(o.sha256, sealed);
    assert.equal(o.store_digest, sealed);
    assert.notEqual(o.digest, o.sha256);
    assert.notEqual(o.digest, o.store_digest);
    const { digest, ...rest } = o;
    assert.equal(digest, sha256(canon(rest)), "the digest covers every other key, store_digest included");
    assert.ok("store_digest" in rest);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("8.2.4 #86 E1: a runner that relays show's digest as store_digest stops the run 'store_digest off the seal'", async () => {
  const R1 = "role:fleet-held-out-runner:r1";
  const s = happy({ criteria: [{ id: "AC1", text: "[unit] b", test_files: ["tests/test_1.py"], examples: [{ given: "g", when: "f(1)", then: "2", kind: "main" }], dont_care: [], property: null, guards_existing: false, spec_quote: null }] });
  s["role:scope-and-plan"].held_out_examples = [{ criterion_id: "AC1", given: "g", when: "f(9)", then: "81" }];
  s[R1] = (p) => {
    const ho = inputsOf(p).held_out;
    const showDigest = sha256("the program output digest, not the store hash");
    assert.notEqual(showDigest, ho.sha256);
    return { status: "ok", reason: "ran 1", store: "ok", store_digest: showDigest, results: [{ criterion: "AC1", index: 0, pass: true }] };
  };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "gates");
  assert.match(out.result.reason, /store_digest off the seal/);
});
