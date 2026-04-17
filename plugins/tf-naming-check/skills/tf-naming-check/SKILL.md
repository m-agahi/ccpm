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

`$ARGUMENTS` — optional path to scan (e.g. `modules/networking` or an absolute path).
If omitted, scans all `.tf` files under the current working directory where Claude is running.

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

## Step 2: Determine scan root and find .tf files

Determine the scan root:

- If `$ARGUMENTS` is set, use it as the scan root (resolve relative to `pwd` if not absolute)
- Otherwise, use `pwd` (current working directory where Claude is running)

Use `Glob("**/*.tf", path=<scan-root>)`. Then filter out paths containing:

- `.terraform/`
- `vendor/`
- `.terragrunt-cache/`
- `.terraform.lock.hcl` (not a directory but worth noting)

Report: `Found N .tf files to check under <scan-root>.`

---

## Step 3: Read .tf files

Read all found files. If more than 30 files, read in parallel batches of 20.

---

## Step 4: Analyze — spawn Haiku agent

Spawn an Agent with `model="haiku"` using this prompt (substitute real values):

```
You are a Terraform naming convention and style checker. Apply the rulebook below
strictly and literally — do not infer or invent rules beyond what is written.

---
RULEBOOK:
{full contents of tf-naming-config.md}

---
FILES:
{for each file: "=== path/to/file.tf ===\n{file contents}\n"}

---
TASK:
Check every file against the rulebook for two categories of issues:

1. NAMING — every block label (resource, variable, output, local, module, data
   source names) against the naming rules.

2. STRUCTURE — for every resource, module, and data block:
   a. Meta-arguments (count, for_each, provider, providers, source) must appear
      at the TOP of the block before any other arguments. Flag if they don't.
   b. Exactly one blank line must follow the last meta-argument before the
      remaining arguments. Flag if missing or if there are extra blank lines.
      (Skip this check if the block has no meta-arguments.)
   c. All argument keys within the block must be in alphabetical order. Flag any
      that are out of order.
   d. Map literal values ({ key = value }) must have their keys in alphabetical
      order. Flag any that are out of order.
   e. List literal values (["a", "b"]) of strings must have their elements in
      alphabetical order. Flag any that are out of order.
   These checks also apply recursively to nested blocks.

For each violation output one line in this exact format:
  SEVERITY | relative/path/to/file.tf:LINE | identifier_or_block | rule violated | suggested fix

Severity values: ERROR (wrong format, wrong order of meta-args, unsorted keys),
WARNING (missing blank line after meta-args, unsorted map/list values),
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
