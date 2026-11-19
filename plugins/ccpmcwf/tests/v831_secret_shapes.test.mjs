// 8.3.1 (yaadgaar #99 a): the secret-like path check refuses real secret-file shapes only; a source
// file whose name merely holds "secret" (a secret scanner module, its tests) goes on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ARGS, SRC_PATH, happy, run } from "./harness.mjs";

const SRC = readFileSync(SRC_PATH, "utf8");
const mk = () => Object.assign(happy(), { __source: SRC });
const withFiles = (s, files) => Object.assign(s["role:scope-and-plan"], { allowed_additions: { files, symbols: [], deps: [], settings: [] } });

const PASS = ["packages/core/src/daneel_core/output_scan/secrets.py", "packages/core/tests/test_output_scan_secrets.py", "detectors/secrets.py"];
const STOP = [
  "deploy/secrets/x.yaml",
  "config/secrets.yaml",
  "keys/id_rsa",
  // kept shapes
  ".env",
  ".env.local",
  ".envrc",
  "certs/server.pem",
  "keys/deploy.key",
  "certs/client.p12",
  "certs/client.pfx",
  "home/id_rsa.pub",
  "home/.ssh/id_ed25519",
  "home/.ssh/id_ecdsa.pub",
  "home/.ssh/id_dsa",
  "aws_credentials.json",
  ".aws/credentials",
  "kubeconfig",
  "home/.kube/kubeconfig.yaml",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "config/secret.json",
  "config/Secrets.YML",
  "client_secret.json",
  "config/secrets.toml",
  "notes/secret.txt",
  "src/secret/db.py",
  "src\\secrets\\db.py",
  "SECRETS/app.py",
];

test("8.3.1 (#99 a): a source file named *secret* passes the plan-time scope check", async () => {
  for (const f of PASS) {
    const s = mk();
    withFiles(s, [f]);
    const out = await run(s, ARGS);
    assert.ok(!/secret-like path/.test(String(out.result.reason || "")), f + ": " + out.result.reason);
    assert.ok(out.labels.some((l) => l.startsWith("role:plan-audit")), f + ": reaches plan-audit");
  }
});

test("8.3.1 (#99 a): every real secret-file shape still stops before plan-audit", async () => {
  for (const f of STOP) {
    const s = mk();
    withFiles(s, [f]);
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "needs_human", f);
    assert.equal(out.result.stop_gate, "scope", f);
    assert.ok(String(out.result.reason).includes("path " + JSON.stringify(f) + ": secret-like path"), f + ": " + out.result.reason);
    assert.ok(!out.labels.some((l) => l.startsWith("role:plan-audit")), f + ": plan-audit never ran");
  }
});
