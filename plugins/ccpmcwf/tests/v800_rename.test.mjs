// fleet 8.0.0 car R, yaadgaar #38 (L2146): the plugin is renamed to ccpmcwf (Max ruling
// 2026-11-16: "ccpmcwf", short for ccpm coding workflow). Dir plugins/ccpmcwf, commands
// /ccpmcwf:*, the workflow ccpmcwf:build-engine (was fleet:build-task-run), the agent
// ccpmcwf:judge. Internals are kept: refs/fleet/*, the fleet/ branch and fleet- worktree
// prefixes, ~/.config/fleet, ~/.cache/fleet, the fleet_* DB names, the role file names and
// the write-back markers, so existing branches, refs and state keep working.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SCRIPTS_SRC, SCRIPTS_DIR, SOURCE, ARGS, happy, runOne, scriptsProbe } from "./harness.mjs";

const P = join(SCRIPTS_SRC, "..");
const REPO = join(P, "..", "..");
const read = (...p) => readFileSync(join(P, ...p), "utf8");
const DIST_FILE = join(P, "workflows", "build-engine.js");

test("8.0.0 R (#38) B1: the marketplace entry is ccpmcwf at ./plugins/ccpmcwf; no fleet entry", () => {
  const mk = JSON.parse(readFileSync(join(REPO, ".claude-plugin", "marketplace.json"), "utf8"));
  const e = mk.plugins.filter((p) => p.name === "ccpmcwf");
  assert.equal(e.length, 1);
  assert.equal(e[0].source, "./plugins/ccpmcwf");
  assert.equal(e[0].version, "8.9.8");
  assert.equal(mk.plugins.filter((p) => p.name === "fleet").length, 0);
});

test("8.0.0 R (#38) B2, B3: the manifest names ccpmcwf; plugins/ccpmcwf exists and plugins/fleet does not", () => {
  assert.equal(JSON.parse(read(".claude-plugin", "plugin.json")).name, "ccpmcwf");
  assert.ok(P.endsWith(join("plugins", "ccpmcwf")), P);
  assert.ok(!existsSync(join(REPO, "plugins", "fleet")), "plugins/fleet is gone");
  const readme = readFileSync(join(REPO, "README.md"), "utf8");
  assert.match(readme, /^### ccpmcwf \(v8\.9\.8\)$/m);
  assert.doesNotMatch(readme, /^### fleet /m);
  assert.match(read("README.md"), /\/plugin install ccpmcwf@maxagahi-marketplace/);
});

test("8.0.0 R (#38) B4: the one shipped workflow is build-engine.js, built from src/build-engine.js, meta.name build-engine", () => {
  assert.deepEqual(readdirSync(join(P, "workflows")), ["build-engine.js"]);
  assert.deepEqual(readdirSync(join(P, "src")), ["build-engine.js"]);
  assert.match(readFileSync(DIST_FILE, "utf8"), /^export const meta = \{\n {2}name: "build-engine",\n/);
  assert.match(SOURCE, /^export const meta = \{\n {2}name: "build-engine",\n/);
});

test("8.0.0 R (#38) B5: the description says it is the internal engine of /ccpmcwf:build-task, one line per mode", () => {
  const m = /^ {2}description:\n {4}("(?:[^"\\]|\\.)*"),\n/m.exec(SOURCE);
  assert.ok(m, "a one-string description");
  const d = JSON.parse(m[1]);
  assert.ok(d.startsWith("Internal engine of /ccpmcwf:build-task. Do not invoke directly."), d);
  const lines = d.split("\n");
  for (const mode of ["plan", "build", "probe"]) {
    const l = lines.filter((x) => x.startsWith(mode + ": "));
    assert.equal(l.length, 1, mode);
    assert.match(l[0], /\/ccpmcwf:build-task/, mode);
  }
});

test("8.0.0 R (#38) B6: no skill, role, agent, src or workflow names fleet:build-task-run, fleet:judge or fleet:ledger-writer", () => {
  const files = [
    ...["build-task", "plan-task", "fleet-policy"].map((s) => ["skills", s, "SKILL.md"]),
    ...readdirSync(join(P, "roles")).filter((f) => f.endsWith(".md")).map((f) => ["roles", f]),
    ...readdirSync(join(P, "roles", "_shared")).map((f) => ["roles", "_shared", f]),
    ...readdirSync(join(P, "agents")).map((f) => ["agents", f]),
    ["src", "build-engine.js"],
    ["workflows", "build-engine.js"],
  ];
  for (const f of files) assert.doesNotMatch(read(...f), /fleet:(build-task-run|judge|ledger-writer)\b/, f.join("/"));
  const skill = read("skills", "build-task", "SKILL.md");
  assert.match(skill, /^ {2}- Workflow\(ccpmcwf:build-engine\)$/m);
  assert.equal(skill.match(/Workflow\(\{ name: "ccpmcwf:build-engine",/g).length, 3);
  assert.match(SOURCE, /^const JUDGE_AGENT = "ccpmcwf:judge";/m);
  assert.match(read("agents", "judge.md"), /ccpmcwf:build-engine workflow/);
  // the install hints name the new plugin
  assert.doesNotMatch(skill, /fleet plugin|fleet install/);
  assert.equal(skill.match(/reinstall the ccpmcwf plugin and run `\/reload-plugins`/g).length, 2);
});

test("8.0.0 R (#38) B7, B8: the internals keep their names (refs/fleet/*, fleet/ branches, ~/.config/fleet, ~/.cache/fleet)", () => {
  assert.match(SOURCE, /return "refs\/fleet\/" \+ taskId \+ "\/plan";/);
  assert.match(read("scripts", "plan_ref_write.py"), /ref = 'refs\/fleet\/' \+ target \+ '\/plan'/);
  assert.match(read("scripts", "fleet_branch.py"), /'refs\/heads\/fleet\/'/);
  assert.match(read("scripts", "policy.py"), /os\.path\.expanduser\('~\/\.config'\), 'fleet', 'policy\.json'\)/);
  assert.match(read("scripts", "sec_scan.py"), /fleet/);
  // the role file names stay fleet-*.md
  assert.ok(existsSync(join(P, "roles", "fleet-coder.md")));
});

test("8.0.0 R (#38) probe: the preflight globs .../cache/*/ccpmcwf/<version>/scripts and finds the scripts and roles dirs there", async () => {
  assert.equal(SCRIPTS_DIR, "/home/u/.claude/plugins/cache/mkt/ccpmcwf/8.9.8/scripts");
  const s = happy();
  delete s.__dispatch;
  const out = await runOne(s, { mode: "probe", repo: "/r", date: ARGS.date });
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.result.probe.scripts_dir, SCRIPTS_DIR);
  assert.equal(out.result.probe.roles_dir, "/home/u/.claude/plugins/cache/mkt/ccpmcwf/8.9.8/roles");
  assert.ok(out.calls[0].prompt.includes('for d in "$HOME"/.claude/plugins/cache/*/ccpmcwf/8.9.8/scripts;'));
  assert.ok(!out.calls[0].prompt.includes("/fleet/8.9.8/"));
});

test("8.0.0 R (#38) probe: a scripts dir of the old fleet install is refused, and the reason names ccpmcwf", async () => {
  const old = "/home/u/.claude/plugins/cache/mkt/fleet/8.0.0/scripts";
  const s = happy();
  s.preflight = Object.assign({}, s.preflight, { scripts_dir: old, scripts_probe: scriptsProbe({ hits: [{ hit: old }] }) });
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "contract");
  assert.match(out.result.reason, /install ccpmcwf 8\.9\.8 from the marketplace/);
  assert.deepEqual(out.labels, ["preflight"]);
});
