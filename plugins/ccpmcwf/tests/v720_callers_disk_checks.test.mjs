// fleet 7.2.0 (L2178, yaadgaar #44) AC7: the script checks every disk-path relay: the file path,
// the summary entries, the page fields, the joins, the digest and args retries, the args after
// the retry, and a failed read relay.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, happy, runOne, callersDisk, callersFileStub, callersReadStub } from "./harness.mjs";

const FOO = [{ symbol: "foo", occurrences: [{ at: "src/a.py:1", criterion: "AC1", dont_care: null }, { at: "src/a.py:3", criterion: null, dont_care: "a test helper" }] }];
const FOO_DATA = { foo: { hits: ["src/a.py:1", "src/a.py:3"] } };
// 8.9.5 (yaadgaar #112): ac6 maps the code hit and one of two doc hits, so it is neither the full set nor the
// code set and reads part all (there is no auto part)
const B_DATA = { b_sym: { hits: ["docs/b.md:4", "docs/c.md:1", "src/b.py:2"], auto: ["docs/b.md:4", "docs/c.md:1"] } };
function ac5(opts) {
  const s = happy();
  s["role:scope-and-plan"].changed_symbols = FOO;
  return callersDisk(s, "infra:callers", FOO_DATA, opts);
}
function ac6(opts) {
  const s = happy();
  s["role:scope-and-plan"].changed_symbols = [{ symbol: "b_sym", occurrences: [{ at: "src/b.py:2", criterion: "AC1", dont_care: null }, { at: "docs/b.md:4", criterion: null, dont_care: "a doc" }] }];
  return callersDisk(s, "infra:callers", B_DATA, opts);
}
const failedWith = (out, prefix) => {
  assert.equal(out.result.status, "failed", out.result.reason);
  assert.ok(String(out.result.reason).startsWith(prefix), out.result.reason);
};
const count = (out, l) => out.labels.filter((x) => x === l).length;

test("7.2.0 AC7: a callers file outside the run scratch halts failed", async () => {
  failedWith(await runOne(ac5({ file: { file: "/tmp/x/callers/callers-" + "a".repeat(64) + ".json" } }), ARGS), "infra:callers:file: the callers file ");
});

test("7.2.0 AC7: a summary missing a batch symbol or with an invalid entry halts failed", async () => {
  const s = happy();
  s["role:scope-and-plan"].changed_symbols = FOO.concat([{ symbol: "bar", occurrences: [{ at: "src/r.py:1", criterion: "AC1", dont_care: null }] }]);
  callersDisk(s, "infra:callers", FOO_DATA);
  failedWith(await runOne(s, ARGS), "infra:callers:file: the summary has no valid entry for bar");
  for (const bad of [{ auto_count: 3 }, { code_count: 1 }, { code_path_count: 3 }, { code_paths_sha256: "xyz" }]) {
    const t = happy();
    t["role:scope-and-plan"].changed_symbols = FOO;
    callersDisk(t, "infra:callers", { foo: Object.assign({ summary: bad }, FOO_DATA.foo) });
    failedWith(await runOne(t, ARGS), "infra:callers:file: the summary has no valid entry for foo");
  }
});

test("7.2.0 AC7: a read page with another index, or joined pages that differ from the summary, halt failed", async () => {
  failedWith(await runOne(ac6({ read: { page: { index: 1, count: 1 } } }), ARGS), "infra:callers:read:all:0: the read page");
  failedWith(await runOne(ac6({ read: (i) => (i.part === "all" ? { hits: { b_sym: ["docs/b.md:4", "docs/c.md:1"] } } : {}) }), ARGS), "infra:callers:read:all: the read occurrences of b_sym do not match the summary");
});

test("7.2.0 AC7: a file relay that misses its digest gets one digest retry", async () => {
  const s = ac5();
  const good = s["infra:callers:file"];
  s["infra:callers:file"] = (p) => Object.assign(good(p), { digest: "f".repeat(64) });
  s["infra:callers:file:digest-retry"] = good;
  const out = await runOne(s, ARGS);
  assert.equal(count(out, "infra:callers:file:digest-retry"), 1, out.labels.join(", "));
  assert.ok(out.labels.includes("role:plan-audit"), out.result.reason);
});

test("7.2.0 AC7: a file relay on other args gets one args retry; a retry on other args again halts failed", async () => {
  const s = ac5();
  const good = s["infra:callers:file"];
  const other = callersFileStub(FOO_DATA, (i) => ({ args: ["/elsewhere/main", i.plan_path, JSON.stringify(i.symbols), String(i.cap), i.scratch_dir] }));
  s["infra:callers:file"] = other;
  s["infra:callers:file:args-retry"] = good;
  const out = await runOne(s, ARGS);
  assert.equal(count(out, "infra:callers:file:args-retry"), 1, out.labels.join(", "));
  assert.ok(out.labels.includes("role:plan-audit"), out.result.reason);
  // example 9 (A2): the args retry is wrong too
  const t = ac5();
  t["infra:callers:file"] = other;
  t["infra:callers:file:args-retry"] = other;
  const o2 = await runOne(t, ARGS);
  assert.equal(count(o2, "infra:callers:file:args-retry"), 1, o2.labels.join(", "));
  failedWith(o2, "infra:callers:file: the program ran on other arguments");
  assert.ok(!o2.labels.includes("role:plan-audit"));
});

test("7.2.0 AC7: faithful relays get no retry, read the part-all page and reach the plan audit", async () => {
  const out = await runOne(ac6(), ARGS);
  assert.ok(!out.labels.some((l) => /:(digest|args)-retry$/.test(l)), out.labels.join(", "));
  assert.ok(out.labels.includes("infra:callers:read:all:0"), out.labels.join(", "));
  assert.ok(out.labels.includes("role:plan-audit"), out.result.reason);
});

test("7.2.0 AC7: a failed read relay halts failed with its label", async () => {
  const s = ac6();
  s["infra:callers:read:all:0"] = { status: "failed", reason: "boom" };
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "failed", out.result.reason);
  assert.ok(String(out.result.reason).includes("infra:callers:read:all:0"), out.result.reason);
});

// non-weakening: each check on the disk path fails closed (mutation evidence for the gates)
test("7.2.0 AC7 (non-weakening): a file or read relay that misses its digest twice halts failed", async () => {
  const s = ac5();
  const good = s["infra:callers:file"];
  s["infra:callers:file"] = (p) => Object.assign(good(p), { digest: "f".repeat(64) });
  failedWith(await runOne(s, ARGS), "infra:callers:file: the relayed summary does not match the program's digest");
  const t = ac6();
  const rd = t["infra:callers:read:all:0"];
  t["infra:callers:read:all:0"] = (p) => Object.assign(rd(p), { digest: "f".repeat(64) });
  const o2 = await runOne(t, ARGS);
  assert.equal(count(o2, "infra:callers:read:all:0:digest-retry"), 1, o2.labels.join(", "));
  failedWith(o2, "infra:callers:read:all:0: the relayed page does not match the program's digest");
});

test("7.2.0 AC7 (non-weakening): a read relay on other args after its retry, or with a symbol it was not asked for, halts failed", async () => {
  const s = ac6({ read: (i) => ({ args: [i.file, i.part, '["other"]', String(i.page)] }) });
  const out = await runOne(s, ARGS);
  assert.equal(count(out, "infra:callers:read:all:0:args-retry"), 1, out.labels.join(", "));
  failedWith(out, "infra:callers:read:all:0: the program ran on other arguments");
  failedWith(await runOne(ac6({ read: { hits: { b_sym: ["docs/b.md:4"], zz: ["x:1"] } } }), ARGS), "infra:callers:read:all:0: the read page");
});

test("7.2.0 AC7 (non-weakening): a part-all join that differs from the summary, or whose auto hits differ from auto_count, halts failed", async () => {
  const map = (at) => [{ symbol: "x_sym", occurrences: [{ at, criterion: "AC1", dont_care: null }] }];
  const s = happy();
  s["role:scope-and-plan"].changed_symbols = map("src/x.py:2");
  callersDisk(s, "infra:callers", { x_sym: { hits: ["src/x.py:1"] } }, { read: { hits: { x_sym: ["src/x.py:7"] } } });
  failedWith(await runOne(s, ARGS), "infra:callers:read:all: the read occurrences of x_sym do not match the summary count or sha256");
  // the summary says no auto hit, but README.md is a doc file: the script's own list disagrees
  const t = happy();
  t["role:scope-and-plan"].changed_symbols = map("src/x.py:9");
  callersDisk(t, "infra:callers", { x_sym: { hits: ["README.md:1", "src/x.py:1"] } });
  failedWith(await runOne(t, ARGS), "infra:callers:read:all: the auto hits of x_sym do not match the summary auto_count");
});
