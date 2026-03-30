---
name: review-local
description:
  Comprehensive local code review — security, quality, dependencies, SonarQube, Trivy, and more.
  Never pushes to remote.
---

**User input:** "$ARGUMENTS"

## FIRST: Ask what to review

If "$ARGUMENTS" is not empty, use it as the path. Skip to SETUP.

Otherwise ask ONLY this (nothing else in the message):

> What should I review?
>
> 1. Current directory
> 2. Custom path

Wait for the user's answer. Then proceed to SETUP.

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

## RUN AGENTS (user runs manually in terminal)

**Do NOT run `run-agents` via the Bash tool.** It takes 10-50 minutes and must run in the user's
terminal for live progress output. Print this message to the user:

> **Setup complete.** Run this in your terminal to start the review:
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

Ask: "Create Jira tickets? (jira / no)"

- jira → launch the **jira-ticket-creator** Agent from `${CLAUDE_PLUGIN_ROOT}/agents/jira-ticket-creator.md` (runs on host with MCP tools, NOT inside container)
- no → skip
