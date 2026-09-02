---
name: review-local
description:
  Comprehensive local code review — security, quality, dependencies, SonarQube, Trivy, and more.
  Never pushes to remote.
---

**User input:** "$ARGUMENTS"

## FIRST: Ask what to review

If "$ARGUMENTS" is not empty, use it as the path. Skip to SETUP.

Otherwise, use the **AskUserQuestion** tool to ask. Use these parameters:

- question: "What should I review?"
- header: "Review path"
- options:
  1. label: "Current directory", description: "Review the current working directory"
  2. label: "Custom path", description: "Specify a different directory to review"

If the user picks "Current directory", use the current working directory. If "Custom path" or
"Other", use the path they provide. Then proceed to SETUP.

## SETUP (run FIRST — before any other bash command)

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/review-cli.py setup REVIEW_DIR --agents all
```

Replace `REVIEW_DIR` with the absolute path. All agents run — no selection needed.

**Use a 5-minute timeout** for this command (timeout: 300000). It starts a container, checks 22+
tools, detects languages, and generates prompts — this takes 1-3 minutes.

This single command handles EVERYTHING: permissions, container start, tooling check, language
detection, agent filtering, manifest, prompt generation, and execution plan. Do NOT run container.sh,
find, ls, mkdir, docker exec, git diff, run_tooling_check.sh, or any other commands before or
instead of this script.

## SHOW SETUP SUMMARY

Claude Code collapses long Bash output, so the user won't see the setup script's banners.
After setup completes, **read the manifest and re-display key info as regular text**:

1. Read `REVIEW_DIR/.local-review/manifest.json` to get version, languages, and agent count.
2. Check `~/.config/audit-lab/registries.yaml` — if all mount entries are commented out, registries
   are **not configured**.
3. Print a summary like this (adjust to actual values):

> **local-audit-lab vX.Y.Z**
>
> Languages detected: java, docker, hcl
> Agents: N parallel + M scripts + K sequential
>
> (Counts vary by language selection; read manifest.json for exact values.)
>
> Private registries: not configured
> Edit `~/.config/audit-lab/registries.yaml` to mount credentials for Maven, npm, pip, etc.

If registries ARE configured (uncommented mounts exist), show which ones are active instead.

If the setup script printed a **PRIVATE REGISTRY AUTH NOT CONFIGURED** warning, surface it
prominently in your summary to the user. Do not bury it. Mention that the user can read
`<PLUGIN_ROOT>/docs/REGISTRIES.md` for setup steps (replace `<PLUGIN_ROOT>` with the actual
value of `${CLAUDE_PLUGIN_ROOT}`).

## RUN AGENTS (user runs manually in terminal)

**Do NOT run `run-agents` via the Bash tool.** It takes 10-50 minutes and must run in the user's
terminal for live progress output. Print this message to the user:

> Run this in your terminal to start the review:
>
> ```
> python3 PLUGIN_ROOT/scripts/review-cli.py run-agents REVIEW_DIR
> ```
>
> You'll see a live status table showing agent progress.
> Come back here when it finishes and I'll read the report.

Replace `PLUGIN_ROOT` with the actual value of `${CLAUDE_PLUGIN_ROOT}` and `REVIEW_DIR` with the
absolute path.

**Then wait for the user to say it's done.** Do NOT run any commands while waiting. Do NOT poll,
check files, or run `ls`/`ps`/`cat`. Just wait.

## AFTER USER CONFIRMS RUN-AGENTS IS DONE

Print results to the user:

1. Report path (newest `REVIEW_DIR/.local-review/review-*.md`)
2. Read the report and show findings by severity
3. Top 3 critical issues

## CLEANUP

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/review-cli.py cleanup REVIEW_DIR
```

## TICKETS (Jira creation — optional, runs on host)

Ask: "Create Jira tickets? (yes/no)"

- **yes** →
  1. Launch the **ticket-drafter** Agent from `${CLAUDE_PLUGIN_ROOT}/agents/ticket-drafter.md`
     (runs inside container — generates `tickets.json` from `findings.json`)
  2. After ticket-drafter completes, launch the **jira-ticket-creator** Agent from
     `${CLAUDE_PLUGIN_ROOT}/agents/jira-ticket-creator.md`
     (runs on host with MCP tools — creates tickets interactively one by one)
- **no** → skip both agents
