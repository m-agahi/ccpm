// fleet 7.3.0 (car-1 follow-up; Max ruled "Exempt writers") A28: the chunk
// writers of a run-state written after the PR is open sit outside the agent
// cap, as infra:state:shipped does: no reserve, counted as tail in
// softDispatch. "After the PR is open" is the PR state when saveState runs
// (pr with a pr_number, also on a resume), not the state label: a review-fix
// round's committed and pushed states are post-PR too. The pre-PR state
// writers keep the cap. No other soft label changes.
//
// dont_care: how the helper is spelled beyond its name.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SOURCE } from "./harness.mjs";

const body = (name, kw = "function ") => {
  const i = SOURCE.indexOf(kw + name + "(");
  assert.ok(i >= 0, name);
  return SOURCE.slice(i, SOURCE.indexOf("\n}\n", i) + 2);
};
const tailWriterOf = (state) => new Function("state", body("tailWriter") + "\nreturn tailWriter;")(state);

test("7.3.0 A28: a state chunk writer is a tail agent only while saveState writes a post-PR run-state", () => {
  const on = tailWriterOf({ tailWriters: true });
  const off = tailWriterOf({ tailWriters: false });
  for (const l of ["infra:state-chunks:shipped:r0w0", "infra:state-chunks:committed:r2:r1w0", "infra:state-chunks:pushed:p2:r0w0", "infra:state-chunks:reviewed:v1:r0w0"]) {
    assert.equal(on(l), true, l);
    assert.equal(off(l), false, l);
  }
  for (const l of ["infra:plan-chunks:r0w0", "infra:park-chunks:r0w0", "infra:yaadgaar-writeback:ci", "infra:state:shipped"]) assert.equal(on(l), false, l);
});

test("7.3.0 A28: saveState sets the post-PR flag from the PR state around its writers and clears it after", () => {
  const ss = body("saveState", "async function ");
  assert.match(ss, /state\.tailWriters = !!\(pr && pr\.pr_number != null\);/);
  assert.match(ss, /finally \{\n\s*state\.tailWriters = false;/);
  assert.ok(ss.indexOf("state.tailWriters = !!") < ss.indexOf("writeChunksParallel("), "set before the writers");
  assert.ok(ss.indexOf("state.tailWriters = false") > ss.indexOf("chunkRounds("), "cleared after the rewrite rounds");
});

test("7.3.0 A28: softDispatch counts a tail writer before its cap check; writeChunksParallel reserves nothing for one", () => {
  const sd = body("softDispatch", "async function ");
  assert.match(sd, /if \(tailWriter\(label\)\) state\.tail\+\+;\n\s*else if \(capped\(\) \+ 1 > MAX_AGENTS\)/);
  assert.match(body("writeChunksParallel", "async function "), /if \(!soft && !tailWriter\(prefix\)\) reserve\(/);
});
