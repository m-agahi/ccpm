---
name: tf-naming-check
description: >
  Use when the user asks to "check tf naming", "review terraform names",
  "tf lint", "naming issues in terraform", "check my terraform naming",
  "tf naming conventions", "review tf", "terraform lint names", or similar
  Terraform naming-related requests.
allowed-tools: Glob, Read, Agent, Bash
---

# tf-naming-check

Checks Terraform code against a naming convention rulebook and reports violations.

## Arguments

`$ARGUMENTS` — optional path prefix to limit scope (e.g. `modules/networking`).
If omitted, scans all `.tf` files under the project root.

---

## Step 1: Load config

Find the rulebook config in this order (first found wins):

1. `<project-root>/tf-naming-config.md` — project-level override
2. `~/.claude/skills/tf-naming-check/tf-naming-check/tf-naming-config.md` — installed default

```bash
git rev-parse --show-toplevel 2>/dev/null || pwd
```

Use the result as `<project-root>`. Read the first config file found.

If neither exists, stop and tell the user:

> No `tf-naming-config.md` found. Copy `tf-naming-config.md` from the plugin
> directory to `<project-root>/tf-naming-config.md` and edit it to match your
> team's conventions, then re-run.

Do not proceed without a config.

---

## Step 2: Scan for .tf files

Use `Glob("**/*.tf")` from the project root. Then filter out paths containing:

- `.terraform/`
- `vendor/`
- `.terragrunt-cache/`
- `.terraform.lock.hcl` (not a directory but worth noting)

If `$ARGUMENTS` is set, only include files whose path starts with that prefix.

Report: `Found N .tf files to check.`

---

## Step 3: Read .tf files

Read all found files. If more than 30 files, read in parallel batches of 20.

---

## Step 4: Analyze — spawn Haiku agent

Spawn an Agent with `model="haiku"` using this prompt (substitute real values):

```
You are a Terraform naming convention checker. Apply the rulebook below strictly
and literally — do not infer or invent rules beyond what is written.

---
RULEBOOK:
{full contents of tf-naming-config.md}

---
FILES:
{for each file: "=== path/to/file.tf ===\n{file contents}\n"}

---
TASK:
Check every block label (resource names, variable names, output names, local
names, module names, data source names) in every file against the rulebook.

For each violation output one line in this exact format:
  SEVERITY | relative/path/to/file.tf:LINE | identifier | rule violated | suggested fix

Severity values: ERROR (wrong format — e.g. camelCase), WARNING (anti-pattern),
INFO (suggestion only).

Report only violations. If a file is fully compliant, skip it.
If there are zero violations across all files, output exactly: NO_VIOLATIONS
```

---

## Step 5: Report

Parse the agent output and display:

```
## tf-naming-check

Scanned {N} files — {X} errors, {Y} warnings, {Z} suggestions

### ERRORS — must fix
| File | Line | Identifier | Issue | Suggested fix |
|------|------|------------|-------|---------------|
...

### WARNINGS — should fix
| File | Line | Identifier | Issue | Suggested fix |
|------|------|------------|-------|---------------|
...

### INFO — suggestions
| File | Line | Identifier | Issue | Suggested fix |
|------|------|------------|-------|---------------|
...
```

If `NO_VIOLATIONS`: output `All checked files follow the naming conventions.`

---

## Rules

- Never check `.terraform/`, `vendor/`, or `.terragrunt-cache/` directories
- Always load config before scanning — a missing config is a hard stop, not a warning
- Never invent rules not present in the config
- The Haiku agent checks; this skill only orchestrates and formats
