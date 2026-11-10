// fleet 5.0.2 (ledgers 2006, 2007, 2005): a relay that returns exactly the
// keys its prompt names passes the script's digest checks.
//
// Release smoke run wf_00e4b130-011 (5.0.1) stopped at infra:callers: "the
// relayed occurrences do not match the program's digest". callers.py prints
// {occurrences, capped, auto_dont_care, doctest_md, program, digest} and the
// digest check reads all four lists, but the prompt named only occurrences and
// capped. The agent followed the prompt; the two dropped lists read as null.
// The harness's fake relay returned the digest's key list, not the prompt's,
// so no test could see the drift. Here the relay is cut down to what the
// prompt names, and the callers output is the real program's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, symlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { HERE, SOURCE, ARGS, happy, run, runOne, inputsOf, programSha, spawnSync, scratchRepo, sh, PROGRAM_LABELS, PROGRAMS, planRefFor, buildArgs, parkOut, sha256, canon } from "./harness.mjs";

const PY = spawnSync("python3", ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim();
const CALLERS = join(HERE, "..", "scripts", "callers.py");
const FORMAT = join(HERE, "..", "scripts", "format_files.py");

// the top-level keys of the `{...}` list that starts at s[i]
function braceKeys(s, i) {
  assert.equal(s[i], "{");
  const keys = [];
  let d = 0;
  let cur = "";
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (ch === "{" || ch === "[") {
      d++;
      if (d === 1) continue;
    } else if (ch === "}" || ch === "]") {
      d--;
      if (d === 0) {
        keys.push(cur);
        break;
      }
    } else if (d === 1 && ch === ",") {
      keys.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  return keys.map((k) => k.trim().split(":")[0].trim()).filter(Boolean);
}
// the keys of the prompt's last Return line
function returnKeys(prompt) {
  const i = prompt.lastIndexOf("Return {");
  assert.ok(i >= 0, "a Return line in:\n" + prompt.slice(0, 400));
  return braceKeys(prompt, i + "Return ".length);
}
// the keys the prompt says program `name` prints: the first "prints one JSON
// object {...}" after the program's nth command (park-plan runs parked twice)
function printedKeys(prompt, name, nth) {
  const ms = [...prompt.matchAll(new RegExp("/" + name + "\\.py['\\s]", "g"))];
  assert.ok(ms.length > (nth || 0), name + " command " + (nth || 0) + " in the prompt");
  const at = ms[nth || 0].index;
  const p = prompt.indexOf("prints one JSON object {", at);
  assert.ok(p >= 0, name + ": no `prints one JSON object {...}` after its command");
  return braceKeys(prompt, prompt.indexOf("{", p));
}
const RUNS = /sha256sum -- '?[^\s'"]*\/([a-z_]+)\.py/g;
const ran = (prompt) => new Set([...String(prompt).matchAll(RUNS)].map((m) => m[1]));
const slotsOf = (label) => {
  const hit = PROGRAM_LABELS.find(([re]) => re.test(label));
  return hit ? hit[1] : [];
};
const keep = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => keys.includes(k)));

// The relay of an agent that follows its prompt: the result holds the keys the
// Return line names (file_sha256 too: the shared rule asks for it); a nested
// program slot holds the keys the prompt says the program prints.
function promptRelay(label, r, prompt) {
  if (!r || typeof r !== "object" || r.status !== "ok") return r;
  const names = ran(prompt);
  const slots = slotsOf(label).filter(([, n]) => names.has(n));
  if (!slots.length) return r;
  const ret = returnKeys(prompt);
  const out = keep(r, ret.concat(slots.some(([s]) => s === null) ? ["file_sha256"] : []));
  slots.forEach(([slot, name], i) => {
    const nth = slots.slice(0, i).filter(([, n]) => n === name).length;
    if (slot !== null && out[slot] && typeof out[slot] === "object") out[slot] = keep(out[slot], printedKeys(prompt, name, nth).concat("file_sha256"));
  });
  return out;
}

// the plan maps one changed symbol with one caller; the caller grep runs the
// real callers.py on `fixture`, with the prompt's plan path, symbols and cap
function callersScenario(fixture, relay) {
  const s = happy();
  s["role:scope-and-plan"].changed_symbols = [{ symbol: "guard_verdict", occurrences: [{ at: "chart/guards.py:10", criterion: "AC1", dont_care: null }] }];
  // replaced by the real program's output below
  s["infra:callers"] = { status: "ok", reason: "grepped", occurrences: {}, capped: [] };
  s.__mutate = {
    label: /./,
    fn: (r, prompt, label) => {
      if (/^infra:callers/.test(label)) {
        const i = inputsOf(prompt);
        const p = spawnSync(PY, ["-I", CALLERS, fixture, i.plan_path, JSON.stringify(i.symbols), String(i.cap)], { encoding: "utf8" });
        assert.equal(p.status, 0, p.stderr);
        r = Object.assign({ status: "ok", reason: "grepped" }, JSON.parse(p.stdout), { file_sha256: programSha("callers") });
      }
      return relay ? promptRelay(label, r, prompt) : r;
    },
  };
  return s;
}

function callersFixture() {
  const wt = scratchRepo("fleet-502-callers-");
  mkdirSync(join(wt, "chart"));
  writeFileSync(join(wt, "chart", "guards.py"), "#\n".repeat(9) + "def guard_verdict(x):\n    return x\n");
  sh(wt, "git", "add", "chart/guards.py");
  sh(wt, "git", "commit", "-q", "-m", "init");
  return wt;
}

test("5.0.2 2006 repro (wf_00e4b130-011): the real callers.py output, relayed with only the keys the prompt names, passes", async () => {
  const fx = callersFixture();
  try {
    const raw = JSON.parse(spawnSync(PY, ["-I", CALLERS, fx, "docs/plans/x.md", '["guard_verdict"]', "50"], { encoding: "utf8" }).stdout);
    assert.deepEqual(Object.keys(raw).sort(), ["auto_dont_care", "capped", "digest", "doctest_md", "occurrences", "program"], "callers.py prints six keys");
    assert.deepEqual(raw.occurrences, { guard_verdict: ["chart/guards.py:10"] });
    const s = callersScenario(fx, true);
    const out = await runOne(s, ARGS);
    assert.ok(out.labels.includes("infra:callers"), "the caller grep ran");
    assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
    const c = out.calls.find((x) => x.label === "infra:callers");
    for (const k of ["occurrences", "capped", "auto_dont_care", "doctest_md", "program", "file_sha256", "digest"])
      assert.ok(returnKeys(c.prompt).includes(k), "the callers Return line names " + k + ": " + c.prompt.slice(c.prompt.lastIndexOf("Return {")));
    assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  } finally {
    rmSync(fx, { recursive: true, force: true });
  }
});

test("5.0.2 2007: a plan and build whose every program relay holds only the keys its prompt names passes", async () => {
  const s = happy();
  s.__mutate = { label: /./, fn: (r, prompt, label) => promptRelay(label, r, prompt) };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.labels.some((l) => /^hasher:/.test(l)) && out.labels.some((l) => /^infra:format-code:/.test(l)), "the build ran");
});

// ---------------------------------------------------------------- the lint (2007a)

const TABLE = () => {
  const i = SOURCE.indexOf("\nconst PROGRAM_KEYS = {");
  assert.ok(i >= 0, "const PROGRAM_KEYS in the workflow");
  return new Function("return " + SOURCE.slice(SOURCE.indexOf("{", i), SOURCE.indexOf("\n};\n", i) + 2))();
};
// plan_hash and plan_ref print no digest (their output is checked against the plan)
const NO_DIGEST = ["plan_hash", "plan_ref"];

function lintCall(c, table, seen) {
  const names = ran(c.prompt);
  const slots = slotsOf(c.label).filter(([, n]) => names.has(n));
  for (const [i, [slot, name]] of slots.entries()) {
    const printed = printedKeys(c.prompt, name, slots.slice(0, i).filter(([, n]) => n === name).length);
    const modes = Object.entries(table).filter(([id]) => id.split(":")[0] === name);
    assert.ok(modes.length, name + " has PROGRAM_KEYS");
    const want = (keys) => keys.concat("program", NO_DIGEST.includes(name) ? [] : ["digest"]).sort();
    assert.ok(
      modes.some(([, keys]) => JSON.stringify(want(keys)) === JSON.stringify(printed.slice().sort())),
      c.label + ": " + name + " prints {" + printed.join(", ") + "}, which is no PROGRAM_KEYS mode of " + name,
    );
    const ret = returnKeys(c.prompt);
    if (slot === null) for (const k of printed.concat("file_sha256")) assert.ok(ret.includes(k), c.label + ": the Return line omits " + k);
    else assert.ok(ret.includes(slot), c.label + ": the Return line omits " + slot);
    seen.add(name);
  }
}

test("5.0.2 2007: every program prompt's printed and Return lists hold exactly the keys the digest check reads", async () => {
  const table = TABLE();
  const seen = new Set();
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  for (const c of out.calls) lintCall(c, table, seen);
  const fx = callersFixture();
  try {
    const cl = await runOne(callersScenario(fx, false), ARGS);
    for (const c of cl.calls) lintCall(c, table, seen);
  } finally {
    rmSync(fx, { recursive: true, force: true });
  }
  assert.ok(seen.has("callers") && seen.has("hasher") && seen.has("format_files") && seen.size >= 18, [...seen].join(", "));
});

test("5.0.2 2007: the digest checks and the prompts read the one key table (source)", () => {
  const table = TABLE();
  // PROGRAM_OUT types every key of every mode, and no other (the hasher's are in HASHER_SCHEMA)
  const at = SOURCE.indexOf("\nconst PROGRAM_OUT = {");
  const out = new Function("const STR = {}, STR_OR_NULL = {}, STRS = {}, BOOL = {}, INT = {}, STR_LISTS = {}, PROGRAM_PROP = {};\nreturn " + SOURCE.slice(SOURCE.indexOf("{", at), SOURCE.indexOf("\n};\n", at) + 2))();
  for (const [n] of PROGRAMS) {
    const union = [...new Set(Object.entries(table).filter(([id]) => id.split(":")[0] === n).flatMap(([, k]) => k))].sort();
    if (n === "hasher") continue;
    assert.deepEqual(Object.keys(out[n]).filter((k) => k !== "digest").sort(), union, n + ": PROGRAM_OUT keys are the PROGRAM_KEYS keys");
  }
  const hs = SOURCE.indexOf("\nconst HASHER_SCHEMA = {");
  const hText = SOURCE.slice(hs, SOURCE.indexOf("\n};\n", hs));
  for (const k of table.hasher.concat(table["hasher:base"])) assert.match(hText, new RegExp("\\n    " + k + ": "), "HASHER_SCHEMA types " + k);
  // the changed-definitions digest reads the table too
  assert.match(SOURCE, /for \(const k of progKeys\("changed_defs"\)\) relayed\[k\] =/);
  // every shipped program has keys, and every key list is the program's
  for (const [n] of PROGRAMS) assert.ok(Object.keys(table).some((id) => id.split(":")[0] === n), n + " has no PROGRAM_KEYS entry");
  // no digest check passes a hand-written key list
  for (const m of SOURCE.matchAll(/relayDigestOk\(\w+, (\[[^\]]*\])/g)) assert.fail("a literal key list at a digest check: " + m[0]);
  // no prompt hand-writes a program's printed list
  const lits = [...SOURCE.matchAll(/prints one JSON object \{[a-z_]/g)].map((m) => SOURCE.slice(m.index, m.index + 80));
  assert.deepEqual(lits, [], "hand-written printed lists");
  // every program-running prompt builds its lists from the table
  for (const [n] of PROGRAMS) {
    // the hasher prompt picks its mode: printsKeys(hid), hid "hasher" or "hasher:base"
    const re = n === "hasher" ? /const hid = inputs\.base_tree \? "hasher:base" : "hasher";[^]*?printsKeys\(hid\)/ : new RegExp('printsKeys\\("' + n + '[":]');
    assert.ok(re.test(SOURCE), n + ": no printsKeys(" + n + ") in a prompt");
  }
});

// ---------------------------------------------------------------- 2005: format_files prints its own `note`

test("5.0.2 2005: format_files prints `note`, never `reason`; the agent's own reason no longer collides with a digested key", async () => {
  const wt = scratchRepo("fleet-502-fmt-");
  try {
    writeFileSync(join(wt, "a.py"), "x = 1\n");
    sh(wt, "git", "add", "a.py");
    sh(wt, "git", "commit", "-q", "-m", "init");
    const p = spawnSync(PY, ["-I", FORMAT, wt, JSON.stringify({ paths: ["a.py"] }), "[]", wt, "60"], { encoding: "utf8" });
    assert.equal(p.status, 0, p.stderr);
    const o = JSON.parse(p.stdout);
    assert.ok(!("reason" in o), "format_files prints no reason key: " + Object.keys(o).join(", "));
    assert.equal(typeof o.note, "string");
    assert.equal(o.ran, false);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
  // an agent reason that is not the program's passes; the program's note is relayed
  const s = happy();
  const ref = await planRefFor(s);
  s.__mutate = { label: /^infra:format-(tests|code):/, fn: (r) => Object.assign(r, { reason: "my own words about the run" }) };
  const out = await runOne(s, buildArgs(ref));
  assert.equal(out.result.status, "ok", out.result.reason);
  const c = out.calls.find((x) => /^infra:format-code:/.test(x.label));
  assert.ok(returnKeys(c.prompt).includes("note"), "the Return line names note");
});

// ---------------------------------------------------------------- 2004: parked.py park (real git)

const PARKED = join(HERE, "..", "scripts", "parked.py");
function park(wt, plan, scratch, run) {
  const p = spawnSync(PY, ["-I", PARKED, "park", wt, plan, scratch, run], { encoding: "utf8" });
  assert.equal(p.status, 0, p.stderr);
  const o = JSON.parse(p.stdout);
  // the digest is the program's, over its PROGRAM_KEYS keys and program
  const d = Object.fromEntries(TABLE()["parked:park"].map((k) => [k, o[k]]));
  assert.equal(o.digest, sha256(canon(Object.assign(d, { program: o.program }))));
  assert.equal(o.program.sha256, programSha("parked"));
  return o;
}
const status = (wt) => sh(wt, "git", "status", "--porcelain", "--untracked-files=all");

test("5.0.2 2004 (real git): parked.py park moves a tracked, staged or untracked draft and refuses another dirty path", () => {
  const PLAN = "docs/plans/x.md";
  for (const kind of ["tracked", "staged", "untracked", "other-dirty", "clean"]) {
    const wt = scratchRepo("fleet-502-park-");
    const scratch = scratchRepo("fleet-502-scratch-");
    try {
      writeFileSync(join(wt, "README.md"), "r\n");
      mkdirSync(join(wt, "docs", "plans"), { recursive: true });
      if (kind === "tracked") writeFileSync(join(wt, PLAN), "old\n");
      sh(wt, "git", "add", ".");
      sh(wt, "git", "commit", "-q", "-m", "init");
      if (kind !== "clean") writeFileSync(join(wt, PLAN), "draft\n");
      if (kind === "staged") sh(wt, "git", "add", PLAN);
      if (kind === "other-dirty") writeFileSync(join(wt, "README.md"), "changed\n");
      const o = park(wt, PLAN, scratch, "n1-0000001");
      const dest = join(scratch, "parked", "n1-0000001", PLAN);
      assert.deepEqual(o.args, [wt, PLAN, scratch, "n1-0000001"], kind);
      if (kind === "other-dirty") {
        assert.deepEqual([o.target, o.clean, o.dirty], [null, false, ["README.md"]], kind);
        assert.equal(readFileSync(join(wt, PLAN), "utf8"), "draft\n", "nothing changed");
        assert.ok(!existsSync(dest), "nothing copied");
        continue;
      }
      if (kind === "clean") {
        assert.deepEqual([o.target, o.clean, o.dirty], [null, true, []]);
        continue;
      }
      assert.deepEqual([o.target, o.clean, o.dirty], [dest, true, []], kind);
      assert.equal(readFileSync(dest, "utf8"), "draft\n", kind + ": the draft is parked");
      assert.equal(status(wt), "", kind + ": the worktree is clean");
      assert.equal(existsSync(join(wt, PLAN)), kind === "tracked", kind);
      if (kind === "tracked") assert.equal(readFileSync(join(wt, PLAN), "utf8"), "old\n", "HEAD's copy is restored");
    } finally {
      rmSync(wt, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  // a plan path or run name the program refuses
  for (const [plan, run] of [["../x.md", "n1"], ["/etc/x.md", "n1"], ["docs//x.md", "n1"], ["docs/x.md", "used"], ["docs/x.md", "a/b"]]) {
    const p = spawnSync(PY, ["-I", PARKED, "park", "/nonexistent", plan, "/tmp", run], { encoding: "utf8" });
    assert.notEqual(p.status, 0, plan + " " + run);
  }
});

test("5.0.2 2004: the park-plan prompt runs only the park and write commands; the script reads the park program's output", async () => {
  const stop = () => happy({ script: { "role:plan-audit": { status: "ok", verdict: "plan_defect", routed_findings: [{ target: "plan", criterion: "AC1", finding: "bad" }] } } });
  const out = await runOne(stop(), ARGS);
  const pk = out.calls.find((c) => c.label === "infra:park-plan").prompt;
  assert.match(pk, /never join commands with &&, ; or if/);
  // the findings chunk steps stay: the ban covers commands the steps do not give
  assert.match(pk, /a\. `mkdir -p '[^']*park-chunks-n1-0000001'`/);
  assert.match(pk, /parked\.py' 'write'/);
  assert.doesNotMatch(pk, /git -C <worktree>|rm -f|cp -p|restore --staged/);
  assert.match(out.result.reason, /draft plan moved to .*scratch\/parked/);
  // another dirty path: the program's dirty list is the note
  const s = stop();
  s["infra:park-plan"] = (p) => parkOut(p, { target: null, clean: false, dirty: ["README.md"] });
  const o2 = await runOne(s, ARGS);
  assert.match(o2.result.reason, /draft plan left in the worktree \(park failed: other dirty paths README\.md\)/);
  // a relay that is not the program's: refused, the stop reason kept
  const t = stop();
  t.__mutate = { label: "infra:park-plan", fn: (r) => ((r.park.clean = true), (r.park.target = "/elsewhere"), r) };
  const o3 = await runOne(t, ARGS);
  assert.match(o3.result.reason, /plan-audit verdict plan_defect/);
  assert.match(o3.result.reason, /park failed: the park relay does not match the program's digest/);
});

// security review of the park mode: no write outside <scratch>/parked/<run>/,
// no symlink followed on either side
test("5.0.2 2004 security (real git): park refuses a symlinked scratch dir, a symlink at dest and a symlinked worktree dir", () => {
  const PLAN = "docs/plans/x.md";
  const parkRaw = (wt, plan, scratch) => spawnSync(PY, ["-I", PARKED, "park", wt, plan, scratch, "n1-0000001"], { encoding: "utf8" });
  for (const kind of ["parked-link", "run-link", "inner-link", "dest-link", "wt-dir-link", "dest-file"]) {
    const wt = scratchRepo("fleet-502-psec-");
    const scratch = scratchRepo("fleet-502-pscr-");
    const outside = scratchRepo("fleet-502-pout-");
    try {
      writeFileSync(join(wt, "README.md"), "r\n");
      sh(wt, "git", "add", ".");
      sh(wt, "git", "commit", "-q", "-m", "init");
      const run = join(scratch, "parked", "n1-0000001");
      if (kind === "wt-dir-link") {
        // the plan's directory in the worktree is a link to a dir outside it
        mkdirSync(join(outside, "plans"), { recursive: true });
        writeFileSync(join(outside, "plans", "x.md"), "victim\n");
        symlinkSync(outside, join(wt, "docs"));
      } else {
        mkdirSync(join(wt, "docs", "plans"), { recursive: true });
        writeFileSync(join(wt, PLAN), "draft\n");
      }
      if (kind === "parked-link") symlinkSync(outside, join(scratch, "parked"));
      if (kind === "run-link") {
        mkdirSync(join(scratch, "parked"));
        symlinkSync(outside, run);
      }
      if (kind === "inner-link") {
        mkdirSync(join(run, "docs"), { recursive: true });
        symlinkSync(outside, join(run, "docs", "plans"));
      }
      if (kind === "dest-link") {
        mkdirSync(join(run, "docs", "plans"), { recursive: true });
        writeFileSync(join(outside, "target"), "keep\n");
        symlinkSync(join(outside, "target"), join(run, PLAN));
      }
      if (kind === "dest-file") {
        // a re-park of the same run replaces a regular file it left
        mkdirSync(join(run, "docs", "plans"), { recursive: true });
        writeFileSync(join(run, PLAN), "older\n");
        const o = park(wt, PLAN, scratch, "n1-0000001");
        assert.equal(o.target, join(run, PLAN));
        assert.equal(readFileSync(join(run, PLAN), "utf8"), "draft\n");
        continue;
      }
      const p = parkRaw(wt, PLAN, scratch);
      assert.notEqual(p.status, 0, kind + ": refused; " + p.stdout);
      assert.match(p.stderr, /symlink|outside/, kind + ": " + p.stderr);
      // nothing written outside, and the worktree is untouched
      assert.deepEqual(readdirSync(outside).filter((f) => f !== ".git").sort(), kind === "dest-link" ? ["target"] : kind === "wt-dir-link" ? ["plans"] : [], kind);
      if (kind === "dest-link") assert.equal(readFileSync(join(outside, "target"), "utf8"), "keep\n");
      if (kind === "wt-dir-link") assert.equal(readFileSync(join(outside, "plans", "x.md"), "utf8"), "victim\n");
      else assert.equal(readFileSync(join(wt, PLAN), "utf8"), "draft\n", kind + ": the draft stays");
    } finally {
      for (const d of [wt, scratch, outside]) rmSync(d, { recursive: true, force: true });
    }
  }
  // `..` and absolute parts in the plan path or the run name
  for (const [plan, run] of [["docs/../../x.md", "n1"], ["/abs/x.md", "n1"], ["docs/./x.md", "n1"], ["docs/x.md", ".."], ["docs/x.md", "../n1"]]) {
    const p = spawnSync(PY, ["-I", PARKED, "park", "/nonexistent", plan, "/tmp", run], { encoding: "utf8" });
    assert.notEqual(p.status, 0, plan + " " + run);
    assert.match(p.stderr, /bad (plan path|run name)/, plan + " " + run);
  }
});
