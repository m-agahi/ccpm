---
name: build-task
description:
  Build a NON-TRIVIAL code change with a gated role fleet - plan, plan audit, tests per acceptance
  criterion, test judge, hash freeze, coder, code judge, draft PR - after the user confirms the plan.
  Use for features, bug fixes and multi-file changes, when the user runs /build-task, or asks to
  "build L123 with the fleet", "run the fleet on ABC-42", "build this issue tests-first". Takes a
  ledger id, a Jira key, a GitHub or Codeberg issue or PR URL, a plan path, or a plain description.
  Do NOT use for one-line or mechanical edits (typo, rename, version bump, config tweak, formatting).
argument-hint: "<ledger id | Jira key | issue or PR URL | plan path | description>"
allowed-tools:
  - Workflow
  - Workflow(fleet:build-task-run)
  - AskUserQuestion
  - Bash(git rev-parse *)
  - Bash(git remote get-url *)
  - Bash(date *)
---

# build-task

Run the `fleet:build-task-run` workflow for one change: first in plan mode, then, after the user
confirms, in build mode. The workflow does all the work. You collect its arguments, start it, show
the plan, ask for confirmation, start the build and report.

## When to skip the fleet

The fleet costs many agents and several minutes. Skip it, and make the change directly, when the
change is one line or mechanical: a typo, a rename, a version bump, a config value, formatting, a
comment, or any edit with no new behaviour that one obvious diff covers. Use the fleet for features,
bug fixes, and changes that span several files or need tests to pin new behaviour. When the user
runs `/build-task` explicitly, always use the fleet.

## Usage

```
/build-task <ledger id | Jira key | issue or PR URL | plan path | description>
```

## Steps

1. **Input.** Take `$ARGUMENTS` as `input`. If it is empty and the request came from the
   conversation, use the user's description of the change. Still empty -> print the usage line and
   stop.
2. **Repo.** Run `git rev-parse --show-toplevel`. Failure -> say "run /build-task inside a git
   repository" and stop. Use the output as `repo`.
3. **Date.** Run `date -u +%F`. Use the output as `date`. The workflow cannot read the clock.
4. **Project (optional).** Use the `<owner>/<repo>` project key from the session banner, if one is
   shown, as `project`. It scopes ledger reads and the ledger write-back. Otherwise omit it.
5. **Workflow tool.** Check that `Workflow` is among the tools you can call now. If it is not, say
   "the fleet needs the Workflow tool, which this session does not have" and stop. Never run the
   roles yourself by hand: the gates exist only in the workflow script.
6. **Plan.**

   ```
   Workflow({ name: "fleet:build-task-run",
              args: { mode: "plan", input: "<input>", repo: "<repo>", date: "<date>",
                      project: "<project, if any>" } })
   ```

   Pass `args` as an object, not a JSON string. Wait for the result. Do not narrate progress. Any
   status other than `awaiting_confirmation` -> report it as in step 9 and stop.

7. **Confirm.** Show the user, in this order:

   - `tldr`, verbatim;
   - `plan_diff`, as a bullet list (`["new plan"]` means no plan existed before);
   - fleet size: `fleet_size.criteria` criteria, about `fleet_size.est_agents` agents, about
     `fleet_size.est_rounds` fix rounds;
   - `plan_path` and the branch (`plan_ref.branch`). The plan is committed locally only.

   Then ask with AskUserQuestion: "Build this plan?" with the options "Build" and "Stop". On "Stop"
   (or any other answer), say the plan stays committed locally on the branch and stop.

8. **Build.** On "Build":

   ```
   Workflow({ name: "fleet:build-task-run",
              args: { mode: "build", plan_ref: <plan_ref from the last result, unchanged>,
                      date: "<date>", project: "<project, if any>" } })
   ```

   Pass `plan_ref` exactly as the workflow returned it. Do not edit, reorder or re-type any field:
   the workflow checks a seal over it and refuses a changed one.

   If the result is `awaiting_confirmation` again, the code judge found the plan wrong and the
   workflow re-planned. Show `proposed_plan_change` (a bullet list), then the new `tldr`,
   `plan_diff` and fleet size, and say that the old work is saved on `superseded_ref`. Ask again as
   in step 7. On "Build", repeat step 8 with the NEW `plan_ref`.

9. **Report.** Relay, in this order:
   - `status` and `reason`. `needs_human` means a gate stopped the run on purpose: quote the reason
     and the last `gate_log` lines, and say what a human must decide.
   - `branch`, `rounds`, `cumulative`, `role_versions`.
   - `pr_url` when present. The PR is a **draft**. The user reviews and merges it. Never mark it
     ready, never merge it, never enable auto-merge.
   - `gates_not_run`: list every gate the run did not execute.
   - Write-back: `ledger_status` and `comment_status`. On `failed`, show `comment_text` (and any
     `section_text`) so the user can post it by hand.
   - `yadgar_findings`, grouped by role, so the main thread can capture them.

## Re-running

A second plan run for the same input reuses the branch and worktree under
`<repo>/.claude/worktrees/fleet-<task id>-<slug>/` and updates the plan in place. A build run
started again with the same `plan_ref` continues on the same criterion branches. The workflow never
deletes a branch or a worktree. It resets the fleet branch only during a re-plan after
`plan_wrong`, and only after it saved the old head on `superseded_ref`.
