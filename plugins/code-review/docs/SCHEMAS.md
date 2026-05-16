# JSON Schema Reference — code-review plugin

Field documentation for machine-readable outputs produced by the code-review plugin.

## findings.json (schema_version 1.1)

The canonical source of truth for a review run. Written by `report-generator`.

| Field                  | Type     | Description                                                                             |
| ---------------------- | -------- | --------------------------------------------------------------------------------------- |
| `_about`               | object   | Metadata block identifying this file's purpose and sibling files.                       |
| `_about.purpose`       | string   | Human/LLM description of the file's role.                                               |
| `_about.produced_by`   | string   | Agent that wrote this file.                                                             |
| `_about.human_view`    | string   | Filename of the human-readable rendering (review.md).                                   |
| `_about.sibling_files` | string[] | Related output files in the same run directory.                                         |
| `_about.field_docs`    | string   | Path to this schema reference file.                                                     |
| `schema_version`       | string   | Schema version (currently `"1.1"`).                                                     |
| `run_id`               | string   | Timestamp-based run identifier (YYYYMMDD-HHMMSS). Shared across all artifacts in a run. |
| `generated_at`         | string   | ISO 8601 UTC timestamp when this file was written.                                      |
| `project.path`         | string   | Absolute path to the reviewed project on the host.                                      |
| `project.languages`    | string[] | Languages detected in the project.                                                      |
| `findings`             | object[] | Array of deduplicated findings. See finding fields below.                               |

### Finding fields

| Field                    | Type         | Description                                                                                                                                |
| ------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                     | string       | Short unique identifier (e.g., `H-1`, `C-2`). Matches IDs in review.md.                                                                    |
| `category`               | string       | Broad category: `security`, `quality`, `dependencies`, `container`, `coverage`, `infra`, `lint`, `types`.                                  |
| `subcategory`            | string       | Specific finding type (e.g., `xss-stored`, `hardcoded-credentials`, `algorithm-bug`).                                                      |
| `severity`               | string       | `critical`, `high`, `medium`, `low`, or `info`.                                                                                            |
| `risk`                   | string       | Derived risk from CIA × likelihood matrix: `critical`, `high`, `medium`, `low`, or `info`.                                                 |
| `impact.confidentiality` | string       | CIA confidentiality axis: `none`, `low`, `medium`, or `high`.                                                                              |
| `impact.integrity`       | string       | CIA integrity axis: `none`, `low`, `medium`, or `high`.                                                                                    |
| `impact.availability`    | string       | CIA availability axis: `none`, `low`, `medium`, or `high`.                                                                                 |
| `likelihood`             | string       | Exploitability/reachability estimate: `low`, `medium`, or `high`.                                                                          |
| `confidence`             | string       | Evidence strength: `confirmed`, `heuristic`, or `speculative`. Optional; defaults to `heuristic`.                                          |
| `verification_steps`     | string[]     | Imperative steps to verify the finding (max 3). Optional; defaults to `[]`. Required when `confidence == "speculative"`.                   |
| `title`                  | string       | Short one-line title.                                                                                                                      |
| `locations`              | object[]     | Code locations where the finding was observed.                                                                                             |
| `locations[].file`       | string       | File path (relative to project root).                                                                                                      |
| `locations[].line`       | integer      | Line number.                                                                                                                               |
| `locations[].snippet`    | string       | Code snippet (≤200 chars).                                                                                                                 |
| `description`            | string       | 1–3 sentence description of the finding.                                                                                                   |
| `fix`                    | string       | 1–3 sentence remediation guidance.                                                                                                         |
| `fix_snippet`            | string       | Optional code snippet showing the fix.                                                                                                     |
| `tools`                  | string[]     | Tools/agents that identified this finding.                                                                                                 |
| `related`                | string[]     | IDs of related findings (e.g., `["M-3"]`).                                                                                                 |
| `grep_pattern`           | string\|null | PCRE2-compatible regex that matches this antipattern, or `null` if not regex-expressible.                                                  |
| `pattern_matches`        | object[]     | Additional locations found by pattern propagation (same schema as `locations`).                                                            |
| `tool_version_mismatch`  | boolean      | Present and `true` when a scanner's language runtime version differs from the project's target version. Implies `confidence: speculative`. |

### Confidence tiers

| Tier          | Meaning                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `confirmed`   | Deterministic tool match at exact line; verifiable in seconds via grep/rerun. `verification_steps` may be empty.       |
| `heuristic`   | Pattern matched but reachability or exploitability needs human check. 0–3 verification steps recommended.              |
| `speculative` | Cross-file inference, runtime-dependent reasoning, or low-signal pattern match. At least 1 verification step REQUIRED. |

### Tool-to-confidence defaults

| Source                                                                                       | Default confidence |
| -------------------------------------------------------------------------------------------- | ------------------ |
| gitleaks, semgrep (non-audit rules), trivy, phpstan (level ≥5), checkov, sonarqube bug rules | `confirmed`        |
| semgrep audit rules, pmd, ruff S-rules, eslint-plugin-security, sonarqube code smells, phpcs | `heuristic`        |
| code-quality-reviewer LLM judgement, architectural findings                                  | `heuristic`        |
| cross-file inference, "depends on runtime", "if reachable" phrasing                          | `speculative`      |

**Cross-tool boost:** if 2+ distinct tools flag the same location, confidence is bumped one tier (capped at `confirmed`).

**Note:** `confidence` (does this finding exist?) is orthogonal to `likelihood` (is it exploitable?).
Example: XSS sink behind admin auth = `likelihood: low`, `confidence: confirmed`.

---

## summary.json (schema_version 1.1)

Pre-computed rollup of findings.json counts. Written by `report-generator`.

| Field            | Type   | Description                                                                                              |
| ---------------- | ------ | -------------------------------------------------------------------------------------------------------- |
| `_about`         | object | Metadata block (see findings.json above for field definitions).                                          |
| `schema_version` | string | Schema version (currently `"1.1"`).                                                                      |
| `run_id`         | string | Run identifier — matches findings.json.                                                                  |
| `generated_at`   | string | ISO 8601 UTC timestamp.                                                                                  |
| `counts`         | object | Finding counts by severity: `critical`, `high`, `medium`, `low`, `info`.                                 |
| `by_impact_axis` | object | Counts per CIA axis and level (`confidentiality`, `integrity`, `availability` → `high/medium/low/none`). |
| `by_category`    | object | Counts per category (e.g., `security: 3, quality: 7`).                                                   |
| `by_module`      | object | Counts per file path.                                                                                    |
| `tooling`        | object | Tool availability status: `ok`, `missing`, or `error` per tool name.                                     |

---

## tickets.json (schema_version 1.1)

Jira-ready ticket drafts. Written on-demand by `ticket-drafter` only when the user requests ticket
creation. Absent by default.

| Field                     | Type     | Description                                               |
| ------------------------- | -------- | --------------------------------------------------------- |
| `_about`                  | object   | Metadata block.                                           |
| `schema_version`          | string   | Schema version (currently `"1.1"`).                       |
| `run_id`                  | string   | Run identifier — matches findings.json.                   |
| `generated_at`            | string   | ISO 8601 UTC timestamp.                                   |
| `tickets`                 | object[] | Array of ticket drafts.                                   |
| `tickets[].id`            | string   | Ticket identifier (e.g., `TICKET-001`).                   |
| `tickets[].title`         | string   | Concise ticket summary (starts with action verb).         |
| `tickets[].severity`      | string   | `critical`, `high`, `medium`, `low`, or `info`.           |
| `tickets[].risk`          | string   | Derived risk level.                                       |
| `tickets[].impact`        | object   | CIA impact axes (same as finding).                        |
| `tickets[].likelihood`    | string   | Exploitability estimate.                                  |
| `tickets[].jira_priority` | integer  | Jira priority ID (3=High, 4=Medium, 5=Low). Never 1 or 2. |
| `tickets[].category`      | string   | Broad category (e.g., `security`, `quality`).             |
| `tickets[].type`          | string   | Jira issue type: `Bug` or `Task`.                         |
| `tickets[].finding_ids`   | string[] | IDs of source findings from findings.json.                |
| `tickets[].files`         | string[] | Affected file paths (relative to repo root).              |
| `tickets[].description`   | string   | Full ticket description.                                  |
| `tickets[].fix`           | string   | Remediation guidance.                                     |
| `tickets[].fix_snippet`   | string   | Optional code snippet showing the fix.                    |
| `tickets[].labels`        | string[] | Jira labels to apply.                                     |

---

## test-cases.json

Suggested test cases for untested modules. Written on-demand by `test-case-suggester` only when
coverage findings exist in findings.json. Absent by default.

| Field            | Type     | Description                                              |
| ---------------- | -------- | -------------------------------------------------------- |
| `schema_version` | string   | Schema version.                                          |
| `run_id`         | string   | Run identifier.                                          |
| `modules`        | object[] | One entry per untested module with suggested test cases. |

---

## cost-manifest.json

Per-agent cost and duration data from `claude -p` output. Written by `review-cli.py`. For
debugging and audit purposes only — not a source of truth for findings.

---

_This file is referenced by `_about.field_docs` in all findings.json and summary.json outputs._
