// ccpmcwf 8.2.2 (yaadgaar #83): a private repo on a free GitHub plan.
//
// `rules/branches/<b>` of a private repo on the free plan answers HTTP 403
// "Upgrade to GitHub Pro or make this repository public to enable this
// feature." Rulesets are off on that plan, so no ruleset or required workflow
// can exist: ruleset_surface reports the read in `unreadable` (the engine
// writes a warning gate line and gates_not_run org-rulesets) and keeps the
// local floor, the way the no-GitHub-host case does. Only a 403 whose API
// message says so counts; the program decides from the real status and body,
// and its digest covers the result. Every other 403, a 404 and any other
// status still set `error` (the run stops at hooks).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCRIPTS_SRC, ARGS, happy, run, call, inputsOf, spawnSync } from "./harness.mjs";

const PY = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
const GIT = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
const UPGRADE = "Upgrade to GitHub Pro or make this repository public to enable this feature.";
const RULES = "repos/m/p/rules/branches/main";

// a stub gh: the last argument maps to [status, body]; with -i the status line comes first
function home(table) {
  const h = mkdtempSync(join(tmpdir(), "fleet-822-"));
  const bin = join(h, "bin");
  mkdirSync(bin);
  symlinkSync(GIT, join(bin, "git"));
  writeFileSync(join(bin, "gh.json"), JSON.stringify(table));
  writeFileSync(
    join(bin, "gh"),
    "#!" + PY + "\nimport json, os, sys\n" +
      "t = json.load(open(" + JSON.stringify(join(bin, "gh.json")) + "))\n" +
      "st, body = t.get(sys.argv[-1], [404, {'message': 'Not Found'}])\n" +
      "if '-i' in sys.argv:\n    sys.stdout.write('HTTP/2.0 %d X\\r\\n\\r\\n' % st)\n" +
      "sys.stdout.write(body if isinstance(body, str) else json.dumps(body))\n" +
      "if st >= 300:\n    sys.stderr.write('gh: X (HTTP %d)\\n' % st)\n    sys.exit(1)\n",
  );
  chmodSync(join(bin, "gh"), 0o755);
  const repo = join(h, "repo");
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  writeFileSync(join(repo, ".github", "workflows", "ci.yml"), "jobs:\n  a:\n    steps:\n      - uses: ./tools/act\n");
  spawnSync(GIT, ["init", "-q", repo]);
  spawnSync(GIT, ["-C", repo, "add", "-A"]);
  return { h, bin, repo };
}
function surface(rules) {
  const e = home({ "repos/m/p": [200, { id: 9, owner: { type: "User" } }], [RULES]: rules });
  try {
    const r = spawnSync(PY, ["-I", join(SCRIPTS_SRC, "ruleset_surface.py"), e.repo, "gh", "m/p", "main"], { encoding: "utf8", env: { PATH: e.bin, HOME: e.bin }, timeout: 120000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(e.h, { recursive: true, force: true });
  }
}

test("8.2.2 #83: an upgrade-403 on the rules read is a warning: error null, the local floor stands, unreadable names it", () => {
  const o = surface([403, { message: UPGRADE, documentation_url: "https://docs.github.com/rest" }]);
  assert.equal(o.error, null);
  assert.deepEqual(o.surface, ["tools/act/"]);
  assert.equal(o.unreadable.length, 1);
  assert.match(o.unreadable[0], /^rules of m\/p branch main not available \(HTTP 403: rulesets need GitHub Pro or a public repo\): hosting-side required workflows not checked$/);
});

test("8.2.2 #83: a plain 403 on the rules read still sets error (the run stops)", () => {
  const o = surface([403, { message: "Resource not accessible by integration" }]);
  assert.equal(o.error, "rules of m/p branch main not readable (HTTP 403)");
  assert.deepEqual(o.unreadable, []);
});

test("8.2.2 #83: a 404 on the rules read is unchanged", () => {
  const o = surface([404, { message: "Not Found" }]);
  assert.equal(o.error, "rules of m/p branch main not readable (HTTP 404)");
  assert.deepEqual(o.unreadable, []);
});

test("8.2.2 #83: the upgrade text in a 200 body, a non-403 status or a non-message field does not count", () => {
  // a 200 whose body is not a list: not readable, as before
  assert.equal(surface([200, { message: UPGRADE }]).error, "rules of m/p branch main not readable (HTTP 200)");
  for (const st of [401, 404, 422, 500]) {
    const o = surface([st, { message: UPGRADE }]);
    assert.equal(o.error, "rules of m/p branch main not readable (HTTP " + st + ")", String(st));
    assert.deepEqual(o.unreadable, []);
  }
  // the text outside the API message field, or a body that is not JSON
  assert.equal(surface([403, { message: "Forbidden", errors: [UPGRADE] }]).error, "rules of m/p branch main not readable (HTTP 403)");
  assert.equal(surface([403, UPGRADE]).error, "rules of m/p branch main not readable (HTTP 403)");
});

test("8.2.2 #83: the engine takes the program's upgrade line as a warning; the run goes on with org-rulesets in gates_not_run", async () => {
  const gap = surface([403, { message: UPGRADE }]).unreadable[0].replace("m/p", "o/r");
  const s = happy();
  s["infra:ruleset-surface:plan"] = (p) => ({ status: "ok", reason: "read", surface: [], sources: [], read: ["self-references in 0 local workflow file(s)"], unreadable: [gap], error: null, args: inputsOf(p).args });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.plan.logs.includes("warning: " + gap), out.plan.logs.join("\n"));
  assert.ok(inputsOf(call(out, "role:fleet-pr-opener").prompt).gates_not_run.some((x) => x.gate === "org-rulesets" && x.reason === gap));
  assert.ok(out.result.gates_not_run.some((x) => x.gate === "org-rulesets"));
});
