// fleet 6.3.4 (ledger 2176): large plan refs. The workflow script has no
// filesystem, so the sealed plan ref still travels through agents, but no one
// agent copies more than a bounded piece, and only a piece that fails its
// sha256 is copied again by a fresh agent.
// - plan mode: writer steps (infra:plan-chunks:*) write at most 8 base64
//   chunks each; the commit step carries no chunk text, runs plan_ref_write
//   (unchanged: per-chunk sha256 list, whole-message sha256) and relays its
//   exit-3 bad_chunks list, which sends only those chunks to fresh writers.
// - build mode: load-ref reads the ref in parts (plan_ref.py part mode); a part
//   whose chunks do not match its sha256 is read once more; the joined parts
//   must still match ref_sha256.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARGS,
  BRIEF,
  PC,
  HAVE_PY,
  SCRIPTS_SRC,
  SOURCE,
  happy,
  runOne,
  call,
  noUnscripted,
  inputsOf,
  sha256,
  planRefFor,
  buildArgs,
  loadStub,
  chunkWriterStub,
  writerChunksOf,
  writersContentOf,
  commitShasOf,
  gitEnv,
  planRefWriteCmd,
  PART_CHARS,
  CHUNK,
} from "./harness.mjs";

// a brief whose description makes the sealed ref at least `kb` KiB
function bigHappy(kb) {
  return happy({ brief: { ...BRIEF, description: "Large plan ref: ünï 🚀 — ".repeat(Math.ceil((kb * 1024) / 20)) } });
}
const writers = (out) => out.labels.filter((l) => /^infra:plan-chunks/.test(l));

test("6.3.4 2176: writer steps carry at most 8 chunks each; the commit step carries no chunk text", async () => {
  const s = bigHappy(256);
  const out = await runOne(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const sealed = s.__store[PC];
  assert.ok(Buffer.byteLength(sealed, "utf8") >= 256 * 1024, "the sealed ref is at least 256 KiB");
  const w = writers(out);
  assert.ok(w.length >= 10, "several writers: " + w.length);
  const seen = [];
  for (const l of w) {
    const ch = writerChunksOf(call(out, l).prompt);
    const ids = Object.keys(ch).map(Number);
    assert.ok(ids.length >= 1 && ids.length <= 8, l + " carries " + ids.length + " chunks");
    for (const [i, t] of Object.entries(ch)) assert.ok(t.length <= 4000, "chunk " + i);
    seen.push(...ids);
    assert.ok(!call(out, l).prompt.includes("plan_ref_write.py"), l + " runs no program");
  }
  assert.deepEqual(seen.sort((a, b) => a - b), Array.from({ length: seen.length }, (_, i) => i), "every chunk once");
  assert.equal(writersContentOf(out), sealed, "the writers' chunks are the sealed bytes");
  const cp = call(out, "infra:commit-plan").prompt;
  assert.deepEqual(writerChunksOf(cp), {}, "the commit step carries no chunk text");
  assert.ok(cp.includes("plan_ref_write.py"));
  assert.equal(commitShasOf(cp).length, seen.length, "the program still checks every chunk's sha256");
  assert.match(cp, /bad_chunks/);
  // the writers all run before the commit step
  const ci = out.labels.indexOf("infra:commit-plan");
  for (const l of w) assert.ok(out.labels.indexOf(l) < ci, l);
  assert.equal(out.result.plan_ref.ref_sha256, sha256(sealed));
});

test("6.3.4 2176: the sealed agent count includes the first-round writers", async () => {
  const small = happy();
  const o1 = await runOne(small, ARGS);
  assert.equal(o1.result.status, "awaiting_confirmation", o1.result.reason);
  const s = bigHappy(64);
  const o2 = await runOne(s, ARGS);
  assert.equal(o2.result.status, "awaiting_confirmation", o2.result.reason);
  assert.equal(writers(o1).length, 1);
  assert.ok(writers(o2).length > 1);
  // the same run but for its writers: the sealed counts differ by the extra writers
  assert.equal(JSON.parse(s.__store[PC]).history.agents - JSON.parse(small.__store[PC]).history.agents, writers(o2).length - 1);
  assert.equal(o2.labels.length - o1.labels.length, writers(o2).length - 1);
});

test("6.3.4 2176: a bad chunk goes to one fresh writer; only that chunk is written again", async () => {
  const s = bigHappy(64);
  let hit = false;
  s["infra:plan-chunks:r0w1"] = chunkWriterStub((i, t) => (!hit && i === 9 ? ((hit = true), t.slice(0, -5)) : t));
  const out = await runOne(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const fix = writers(out).filter((l) => /:r1w/.test(l));
  assert.deepEqual(fix, ["infra:plan-chunks:r1w0"]);
  assert.deepEqual(Object.keys(writerChunksOf(call(out, fix[0]).prompt)), ["9"]);
  assert.ok(out.labels.includes("infra:commit-plan:rewrite-1"));
  assert.equal(out.labels.filter((l) => /^infra:commit-plan/.test(l)).length, 2);
  assert.ok(out.result.gate_log.some((l) => /chunk\(s\) 9 .*fresh writer/.test(l)), out.result.gate_log.join("\n"));
});

test("6.3.4 2176: chunks that stay bad after 2 rewrite rounds stop the run fail-closed", async () => {
  const s = bigHappy(64);
  const bad = chunkWriterStub((i, t) => (i === 3 ? "AAAA" + t.slice(4) : t));
  s["infra:plan-chunks:r0w0"] = bad;
  s["infra:plan-chunks:r1w0"] = bad;
  s["infra:plan-chunks:r2w0"] = bad;
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "failed");
  assert.equal(out.result.stop_gate, "commit");
  assert.match(out.result.reason, /chunk\(s\) 3 still do not match/);
  assert.ok(!out.labels.includes("infra:verify-plan-commit"));
  assert.equal(s.__store[PC], undefined, "no ref was sealed");
});

test("6.3.4 2176: a bad_chunks list out of range stops the run", async () => {
  const s = happy();
  s["infra:commit-plan"] = { status: "failed", reason: "bad chunks", bad_chunks: [99] };
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "failed");
  assert.match(out.result.reason, /bad_chunks/);
});

test("6.3.4 2176: build mode reads a large ref in parts of at most PART_CHARS", async () => {
  const s = bigHappy(256);
  const tiny = await planRefFor(s);
  const out = await runOne(s, buildArgs(tiny));
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  const parts = out.labels.filter((l) => /^infra:load-ref/.test(l));
  const n = Math.ceil([...s.__store[PC]].length / PART_CHARS);
  assert.ok(n >= 8, "parts: " + n);
  assert.deepEqual(parts, ["infra:load-ref"].concat(Array.from({ length: n - 1 }, (_, k) => "infra:load-ref:p" + (k + 1))));
  for (const [k, l] of parts.entries()) {
    const i = inputsOf(call(out, l).prompt);
    assert.equal(i.mode, "part");
    assert.equal(i.part, k);
    assert.match(call(out, l).prompt, new RegExp(" 'part:refs/fleet/y42/plan:" + k + "'\\n"));
  }
});

test("6.3.4 2176: one bad part is read once more; the other parts are not", async () => {
  const s = bigHappy(128);
  const tiny = await planRefFor(s);
  const good = loadStub(s.__store);
  s["infra:load-ref:p2"] = (p) => {
    const r = good(p);
    r.chunks = r.chunks.slice(0, -3);
    return r;
  };
  const out = await runOne(s, buildArgs(tiny));
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.deepEqual(out.labels.filter((l) => /^infra:load-ref.*:retry$/.test(l)), ["infra:load-ref:p2:retry"]);
});

test("6.3.4 2176: a part that is bad twice stops the build (chunks do not match ref_sha256)", async () => {
  const s = bigHappy(128);
  const tiny = await planRefFor(s);
  const good = loadStub(s.__store);
  const bad = (p) => {
    const r = good(p);
    r.chunks = r.chunks.slice();
    r.chunks[1] = "[truncated]";
    return r;
  };
  s["infra:load-ref:p1"] = bad;
  s["infra:load-ref:p1:retry"] = bad;
  const out = await runOne(s, buildArgs(tiny));
  // 7.3.0 (#47b): an intact ref whose parts do not join is a relay failure
  assert.equal(out.result.status, "failed");
  assert.match(out.result.reason, /load-ref: the relayed parts do not join to ref_sha256 .* is intact; re-run build with the same plan_ref/);
  assert.ok(!out.labels.some((x) => x.startsWith("role:")));
});

test("6.3.4 2176: a part whose ref metadata changed stops at once, with no re-read", async () => {
  const s = bigHappy(128);
  const tiny = await planRefFor(s);
  const good = loadStub(s.__store);
  s["infra:load-ref:p1"] = (p) => {
    const r = good(p);
    r.refs = r.refs.map((e) => (e.name === tiny.plan_ref ? { ...e, sha256: "e".repeat(64) } : e));
    return r;
  };
  const out = await runOne(s, buildArgs(tiny));
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /plan ref missing or changed; re-run plan.*message sha256 e+ is not /);
  assert.ok(!out.labels.includes("infra:load-ref:p1:retry"));
});

test("6.3.4 2176: a part relay with no usable part count stops the build", async () => {
  const s = happy();
  const tiny = await planRefFor(s);
  const good = loadStub(s.__store);
  s["infra:load-ref"] = s["infra:load-ref:retry"] = (p) => {
    const r = good(p);
    delete r.part;
    return r;
  };
  const out = await runOne(s, buildArgs(tiny));
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /plan ref missing or changed; re-run plan/);
});

test("6.3.4 2176: the shipped programs round-trip a 256 KiB plan ref (plan_ref_write, then plan_ref part mode)", { skip: !HAVE_PY }, () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-v634-"));
  const wt = join(home, "repo");
  try {
    const cfg = join(home, "gitconfig");
    writeFileSync(cfg, "[user]\n\temail = t@example.com\n\tname = t\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = master\n");
    const env = gitEnv(home, cfg);
    spawnSync("git", ["init", "-q", wt], { env });
    writeFileSync(join(wt, "a.py"), "a\n");
    spawnSync("git", ["-C", wt, "add", "-A"], { env });
    spawnSync("git", ["-C", wt, "commit", "-qm", "i"], { env });
    const big = { task_id: "y42", body: "x y — ü 🚀 ".repeat(24000) };
    const msg = JSON.stringify(big) + "\n";
    assert.ok(Buffer.byteLength(msg, "utf8") >= 256 * 1024);
    const w = spawnSync("bash", ["-s"], { input: planRefWriteCmd(wt, "y42", JSON.stringify(big)), encoding: "utf8", env, maxBuffer: 1 << 26 });
    // (the command is longer than one argv string may be; bash reads it from stdin)
    assert.equal(w.status, 0, w.stderr);
    const prog = join(SCRIPTS_SRC, "plan_ref.py");
    const read = (mode) => {
      const r = spawnSync("python3", ["-I", prog, wt, "y42", mode], { encoding: "utf8", env, maxBuffer: 1 << 26 });
      return r;
    };
    const p0 = JSON.parse(read("part:refs/fleet/y42/plan:0").stdout);
    assert.equal(p0.part.index, 0);
    assert.equal(p0.part.count, Math.ceil([...msg].length / PART_CHARS));
    assert.ok(p0.part.count >= 8);
    assert.ok(!("content" in p0.refs[0]));
    assert.equal(p0.refs[0].sha256, sha256(msg));
    const all = [p0];
    for (let k = 1; k < p0.part.count; k++) all.push(JSON.parse(read("part:refs/fleet/y42/plan:" + k).stdout));
    for (const [k, r] of all.entries()) {
      assert.equal(r.part.index, k);
      assert.equal(r.part.count, p0.part.count);
      assert.ok(r.chunks.every((c) => [...c].length <= CHUNK), "at most 1000 code points per chunk");
      assert.ok([...r.chunks.join("")].length <= PART_CHARS);
      assert.equal(sha256(r.chunks.join("")), r.part.sha256);
      assert.deepEqual(r.program.name, "plan_ref");
    }
    assert.equal(all.map((r) => r.chunks.join("")).join(""), msg, "the joined parts are the exact bytes");
    for (const bad of ["part:refs/fleet/y42/plan:" + p0.part.count, "part:refs/fleet/y42/plan:-1", "part:refs/fleet/y42/plan:x", "part:refs/heads/master:0"])
      assert.notEqual(read(bad).status, 0, bad + " is refused");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("6.3.4 2176: the committed dist is the build of the committed source", async () => {
  // the scenario tests run the dist; a stale dist would test old code
  const B = await import(new URL("../scripts/build-workflow.mjs", import.meta.url));
  const dist = readFileSync(new URL("../workflows/build-task-run.js", import.meta.url), "utf8");
  assert.ok(B.buildWorkflow(SOURCE) === dist, "workflows/build-task-run.js is stale: run node plugins/fleet/scripts/build-workflow.mjs");
});

// review of PR #71, F1: bad_chunks steer a rewrite only on a failed relay
test("6.3.4 2176 F1: an ok commit relay that also carries bad_chunks stops failed; no rewrite runs", async () => {
  const s = happy();
  const base = s["infra:commit-plan"];
  s["infra:commit-plan"] = (p) => Object.assign(base(p), { bad_chunks: [0] });
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "failed");
  assert.equal(out.result.stop_gate, "commit");
  assert.match(out.result.reason, /status ok and bad_chunks/);
  assert.doesNotMatch(out.result.reason, /nothing was sealed/);
  assert.ok(!out.labels.some((l) => /rewrite|:r1w/.test(l)), out.labels.join(", "));
  assert.ok(!out.labels.includes("infra:verify-plan-commit"));
});

// F2: a part count mis-copied in part 0 is a relay error, not a changed ref
test("6.3.4 2176 F2: part 0 relays a count too low; part 0 is read once more and the build goes on", async () => {
  const s = bigHappy(128);
  const tiny = await planRefFor(s);
  const good = loadStub(s.__store);
  const n = Math.ceil([...s.__store[PC]].length / PART_CHARS);
  assert.ok(n >= 5, "parts: " + n);
  // the first read of part 0 says 1 part; every other read is right (unscripted parts fall back to this stub)
  let first = true;
  s["infra:load-ref"] = (p) => {
    const r = good(p);
    if (first && inputsOf(p).part === 0) r.part = { ...r.part, count: 1 };
    first = false;
    return r;
  };
  s["infra:load-ref:retry"] = good;
  const out = await runOne(s, buildArgs(tiny));
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.labels.includes("infra:load-ref:retry"));
  // the second pass reads parts 1..n-1 under the new count, none twice
  assert.deepEqual(out.labels.filter((l) => /^infra:load-ref:p[0-9]+/.test(l)), Array.from({ length: n - 1 }, (_, k) => "infra:load-ref:p" + (k + 1) + ":c" + n));
});

test("6.3.4 2176 F2: part 0 relays a count too high; its short part is a relay error, read once more", async () => {
  const s = happy();
  const tiny = await planRefFor(s);
  const good = loadStub(s.__store);
  s["infra:load-ref"] = (p) => {
    const r = good(p);
    r.part = { ...r.part, count: 5 };
    return r;
  };
  s["infra:load-ref:retry"] = good;
  const out = await runOne(s, buildArgs(tiny));
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.labels.includes("infra:load-ref:retry"));
  assert.ok(!out.labels.some((l) => /^infra:load-ref:p[0-9]+/.test(l)), out.labels.join(", "));
});

test("6.3.4 2176 F2: a short part that is not the last is read once more", async () => {
  const s = bigHappy(128);
  const tiny = await planRefFor(s);
  const good = loadStub(s.__store);
  // a consistent part (its sha256 is over its own chunks) that lost its tail
  s["infra:load-ref:p1"] = (p) => {
    const r = good(p);
    r.chunks = r.chunks.slice(0, -1);
    r.part = { ...r.part, sha256: sha256(r.chunks.join("")) };
    return r;
  };
  const out = await runOne(s, buildArgs(tiny));
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.labels.includes("infra:load-ref:p1:retry"));
});

// F4: a part whose count differs from part 0's is read once more (kills dropping p.count === count)
test("6.3.4 2176 F4: a part that relays another part count is read once more", async () => {
  const s = bigHappy(128);
  const tiny = await planRefFor(s);
  const good = loadStub(s.__store);
  s["infra:load-ref:p2"] = (p) => {
    const r = good(p);
    r.part = { ...r.part, count: r.part.count + 1 };
    return r;
  };
  const out = await runOne(s, buildArgs(tiny));
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.deepEqual(out.labels.filter((l) => /^infra:load-ref.*:retry$/.test(l)), ["infra:load-ref:p2:retry"]);
});
