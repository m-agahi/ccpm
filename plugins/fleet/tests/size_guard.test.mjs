// fleet 4.0.1 (ledger 1996): every plugin workflow file stays under Claude
// Code's workflow size cap.
//
// Claude Code (2.1.296: `Sv=524288`) skips a plugin workflow file larger than
// 524288 bytes with only a warn log ("Plugin workflow X: not a regular file or
// exceeds 524288 bytes — skipping"); the workflow then is "not found" and the
// plugin is unusable. fleet 4.0.0 shipped a 573925-byte build-task-run.js.
// The guard keeps headroom under the cap. It counts bytes, not characters.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGINS = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Claude Code's cap, and the limit this repo holds itself to
const CLAUDE_CODE_WORKFLOW_CAP = 524288;
const WORKFLOW_MAX_BYTES = 480000;

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

test("4.0.1 1996: every plugins/*/workflows/*.js is at most 480000 bytes", () => {
  const files = workflowFiles();
  assert.ok(files.some((f) => f.endsWith(join("fleet", "workflows", "build-task-run.js"))), "the fleet workflow is checked");
  assert.deepEqual(oversized(files), [], "workflow files over " + WORKFLOW_MAX_BYTES + " bytes (Claude Code skips files over " + CLAUDE_CODE_WORKFLOW_CAP + " bytes silently)");
});
