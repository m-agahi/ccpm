// fleet 7.3.0 (car-1 follow-up; Max ruled "Exempt writers") A28: the chunk
// writers of a run-state written after the PR is open sit outside the agent
// cap, as infra:state:shipped does (TAIL_RE): no reserve, counted as tail in
// softDispatch (TAIL_WRITER_RE, so no other soft label changes). The pre-PR
// state writers keep the cap.
//
// dont_care: how the regex is spelled.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SOURCE } from "./harness.mjs";

const TAIL_RE = new Function("return " + /\nconst TAIL_WRITER_RE = (\/.*\/);\n/.exec(SOURCE)[1])();
const fn = (name) => {
  const i = SOURCE.indexOf("async function " + name + "(");
  return SOURCE.slice(i, SOURCE.indexOf("\n}\n", i));
};

test("7.3.0 A28: the post-PR state chunk writers are tail labels; the pre-PR ones are not", () => {
  for (const l of ["infra:state-chunks:shipped:r0w0", "infra:state-chunks:shipped:p2:r1w0", "infra:state-chunks:reviewed:v1:r1w0", "infra:state-chunks:pr_open:p1:r0w0", "infra:state-chunks:written_back:r0w0"])
    assert.ok(TAIL_RE.test(l), l);
  for (const l of ["infra:state-chunks:committed:r1:r0w0", "infra:state-chunks:pushed:p1:r0w0", "infra:plan-chunks:r0w0", "infra:park-chunks:r0w0"]) assert.ok(!TAIL_RE.test(l), l);
});

test("7.3.0 A28: softDispatch counts a tail label before its cap check; writeChunksParallel reserves nothing for a tail prefix", () => {
  const sd = fn("softDispatch");
  assert.ok(/if \(TAIL_WRITER_RE\.test\(label\)\) state\.tail\+\+;\n  else if \(capped\(\) \+ 1 > MAX_AGENTS\)/.test(sd), sd);
  assert.ok(sd.indexOf("state.tail++") < sd.indexOf("capped() + 1 > MAX_AGENTS"), sd);
  const w = fn("writeChunksParallel");
  assert.match(w, /if \(!soft && !TAIL_WRITER_RE\.test\(prefix\)\) reserve\(/);
});
