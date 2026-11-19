// fleet 4.0.1 (ledger 1996): every plugin workflow file stays under Claude
// Code's workflow size cap.
//
// Claude Code (2.1.296: `Sv=524288`) skips a plugin workflow file larger than
// 524288 bytes with only a warn log ("Plugin workflow X: not a regular file or
// exceeds 524288 bytes — skipping"); the workflow then is "not found" and the
// plugin is unusable. fleet 4.0.0 shipped a 573925-byte build-engine.js.
// The guard keeps headroom under the cap. It counts bytes, not characters.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGINS = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Claude Code's cap, and the limit this repo holds itself to
const CLAUDE_CODE_WORKFLOW_CAP = 524288;
// ADR-1316 as amended 2026-11-19 (#91): 520000 (8.0.0: 495000; was 480000)
const WORKFLOW_MAX_BYTES = 520000;

// every plugins/*/workflows/*.js, or the files a caller names
export function workflowFiles(root = PLUGINS) {
  const out = [];
  for (const p of readdirSync(root).sort()) {
    const dir = join(root, p, "workflows");
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir).sort()) if (f.endsWith(".js")) out.push(join(dir, f));
  }
  return out;
}

// [file, bytes] of every file over the limit
export function oversized(files, max = WORKFLOW_MAX_BYTES) {
  return files.map((f) => [f, statSync(f).size]).filter(([, n]) => n > max);
}

test("4.0.1 1996: the size limit leaves headroom under Claude Code's workflow cap", () => {
  assert.ok(WORKFLOW_MAX_BYTES < CLAUDE_CODE_WORKFLOW_CAP);
});

test("4.0.1 1996: every plugins/*/workflows/*.js is at most 520000 bytes (ADR-1316 amended 2026-11-19; was 495000)", () => {
  const files = workflowFiles();
  assert.ok(files.some((f) => f.endsWith(join("ccpmcwf", "workflows", "build-engine.js"))), "the fleet workflow is checked");
  assert.deepEqual(oversized(files), [], "workflow files over " + WORKFLOW_MAX_BYTES + " bytes (Claude Code skips files over " + CLAUDE_CODE_WORKFLOW_CAP + " bytes silently)");
});

// #91: the build script header and the README state the same limit as the guard
test("#91: build-workflow.mjs and the README state the 520000-byte limit and cite ADR-1316 as amended", () => {
  const head = readFileSync(join(PLUGINS, "ccpmcwf", "scripts", "build-workflow.mjs"), "utf8").split("\n").slice(0, 10).join("\n");
  assert.match(head, /at most 520000 bytes/);
  assert.match(head, /ADR-1316 as\n\/\/ amended on 2026-11-19/);
  assert.equal(WORKFLOW_MAX_BYTES, 520000);
  assert.match(readFileSync(join(PLUGINS, "ccpmcwf", "README.md"), "utf8"), /520000 bytes \(ADR-1316 as amended on 2026-11-19/);
});
