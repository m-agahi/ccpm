// 8.3.0 (#87): the commit and PR title summary comes from the plan tldr, never the intake slug,
// and holds no absolute path token.
// 8.3.0 (#90): the visible PR text names ccpmcwf, not fleet.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, SOURCE, happy, run, inputsOf } from "./harness.mjs";

test("#87: an input with an absolute path gives a title built from the tldr, with no path words", async () => {
  const s = happy();
  s["role:scope-and-plan"] = Object.assign({}, s["role:scope-and-plan"], { tldr: "fix add in /home/max/git/fleet-smoke-node/src/calc.js so it returns a+b\nmore" });
  const out = await run(s, ARGS);
  const subj = out.calls.filter((c) => /^infra:commit:r/.test(c.label)).map((c) => inputsOf(c.prompt).subject);
  const titles = out.calls.filter((c) => /^role:fleet-pr-opener/.test(c.label)).map((c) => inputsOf(c.prompt).title);
  assert.ok(subj.length && titles.length, out.result.reason);
  for (const x of subj.concat(titles)) assert.doesNotMatch(x, /home|max|git|smoke|node/i, x);
  assert.equal(subj[0], "feat(thing): fix add in so it returns a b");
});

test("#90: the PR text the workflow writes names ccpmcwf, not fleet", () => {
  assert.match(SOURCE, /Built with ccpmcwf " \+ FLEET_VERSION/);
  assert.match(SOURCE, /Claude Code marketplace coding workflow/);
  assert.doesNotMatch(SOURCE, /Built with ccpm fleet|measured by the fleet|\[ccpm\]\(https:\/\/github.com\/m-agahi\/ccpm\) fleet/);
});
