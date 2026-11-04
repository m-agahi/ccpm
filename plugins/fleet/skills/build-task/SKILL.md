---
name: build-task
description:
  Build one task end to end with a gated role fleet - plan, plan audit, tests per acceptance
  criterion, test judge, hash freeze, coder, code judge, draft PR. Use when the user runs
  /build-task, or asks to "build task L123 with the fleet", "run the fleet on docs/plans/x.md", or
  "build this plan tests-first".
argument-hint: "<ledger id | plan path>"
disable-model-invocation: true
allowed-tools:
  - Workflow
  - Workflow(fleet:build-task-run)
  - Bash(git rev-parse *)
  - Bash(git remote get-url *)
  - Bash(date *)
---

# build-task

Run the `fleet:build-task-run` workflow for one task and relay its result. The workflow does all
the work. You only collect its arguments, start it, wait for it and report.

## Usage

```
/build-task <ledger id | plan path>
```

- A ledger id (for example `L42` or a task number) names a task in the project's task ledger. The
  planner reads the task.
- A plan path (any argument that ends in `.md` or contains `/`) names an existing plan doc, relative
  to the repo root. The planner refines it and emits the criteria.

## Steps

1. **Argument.** Take `$ARGUMENTS` as the task. Empty -> print the usage line above and stop.
2. **Repo.** Run `git rev-parse --show-toplevel`. Failure -> say "run /build-task inside a git
   repository" and stop. Use the output as `repo`.
3. **Date.** Run `date -u +%F`. Use the output as `date`. The workflow cannot read the clock; the
   planner names the plan doc with this date.
4. **Title (required for a ledger id).** Read the task with the task-ledger read tool available
   in this session and use its title as `title`. The workflow builds the branch name
   `fleet/<task id>-<slugified title>` from it and stops without one. No ledger tool, or no title
   -> say so and stop. A plan path needs no title.
5. **Project (optional).** Use the `<owner>/<repo>` project key from the session banner, if one is
   shown, as `project`. Otherwise omit it; the workflow derives it from the `origin` remote.
6. **Workflow tool.** Check that `Workflow` is among the tools you can call now. If it is not, say
   "the fleet needs the Workflow tool, which this session does not have" and stop. Never run the
   roles yourself by hand: the gates exist only in the workflow script.
7. **Run.**

   ```
   Workflow({ name: "fleet:build-task-run",
              args: { task: "<task>", repo: "<repo>", date: "<date>",
                      title: "<title, if any>", project: "<project, if any>" } })
   ```

   Pass `args` as an object, not a JSON string. Wait for the result. Do not narrate progress; the
   workflow logs every gate decision itself.

8. **Report.** Relay, in this order:
   - `status` and `reason`. `needs_human` means a gate stopped the run on purpose: quote the reason
     and the last `gate_log` lines, and say what a human must decide.
   - `branch`, `path` (always `full` in v1), `rounds`, `role_versions`.
   - `pr_url` when present. The PR is a **draft**. Max reviews and merges it. Never mark it ready,
     never merge it, never enable auto-merge.
   - `gates_not_run`: list every gate the run did not execute. An approval in v1 rests on the judges'
     own checks without these gates.
   - `yadgar_findings`, grouped by role, so the main thread can capture them.

## Re-running

A second `/build-task` with the same argument reuses the same branch and worktrees under
`<repo>/.claude/worktrees/fleet-<task id>-<slug>/`. Every role checks existing commits before it
writes, so a re-run continues instead of starting over. The workflow never deletes a branch or a
worktree.
