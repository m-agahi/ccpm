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

   **Confirm mode.** `confirm` is `"ask"` by default: the interactive confirmation in step 7. Use
   `"auto"` only when the user asked for an unattended or goal run (for example "build L42
   unattended", "run the fleet on L42 without asking", or a goal/loop that runs without the user).
   Never pick `"auto"` on your own for an interactive request.

5. **Workflow tool.** Check that `Workflow` is among the tools you can call now. If it is not, say
   "the fleet needs the Workflow tool, which this session does not have" and stop. Never run the
   roles yourself by hand: the gates exist only in the workflow script.
6. **Plan.**

   ```
   Workflow({ name: "fleet:build-task-run",
              args: { mode: "plan", input: "<input>", repo: "<repo>", date: "<date>",
                      project: "<project, if any>", confirm: "<ask | auto>" } })
   ```

   Pass `args` as an object, not a JSON string. Wait for the result. Do not narrate progress.

   - `confirm: "ask"`: any status other than `awaiting_confirmation` -> report it as in step 9 and
     stop.
   - `confirm: "auto"`: the workflow does not ask. It runs its intent, command and scope gates and,
     when they pass, builds in the same run: the result is the build result
     (`auto_confirmed: true`); report it as in step 9 and skip steps 7 and 8. When a gate fails, the result is
     `needs_human` with `failed_check` and `needs_max_section`: show `needs_max_section` verbatim
     and stop. Do not ask, do not retry, do not switch to `"ask"`. After Max rules in the task, the
     run is repeated with step 8 and `confirm: "auto"` (the same `plan_ref`).
   - `confirm: "auto"` and the result is `awaiting_confirmation` (the code judge found the plan
     wrong and the workflow re-planned): show `proposed_plan_change`, `tldr`, `plan_diff` and
     `commands`, say the old work is on `superseded_ref` and `superseded_tree_ref`, and stop. Do
     not ask: an unattended run has no one to answer.

7. **Confirm.** Show the user, in this order:

   - `tldr`, verbatim;
   - `plan_diff`, as a bullet list (`["new plan"]` means no plan existed before);
   - fleet size: `fleet_size.criteria` criteria, about `fleet_size.est_agents` agents, about
     `fleet_size.est_rounds` fix rounds;
   - `plan_path` and the branch (`plan_ref.branch`). The plan is committed locally only.
   - `commands`: EVERY entry, its `command` VERBATIM in a code span (never paraphrased, shortened
     or summarised), with its `env` (every name and value, verbatim; `{}` when empty) and `tools`
     (test_cmd), its `rule_source` and `run_by` (`roles` = the test command the agents run,
     `code-judge (optional)` = a check the code judge may run, `nobody` = refused, with its
     `note`). These are the only commands the roles run; approving the plan approves them. Say so
     in the question.

   Then ask with AskUserQuestion: "Build this plan and run the commands listed above?" with the
   options "Build" and "Stop". On "Stop"
   (or any other answer), say the plan stays committed locally on the branch and stop.

8. **Build.** On "Build":

   ```
   Workflow({ name: "fleet:build-task-run",
              args: { mode: "build", plan_ref: <plan_ref from the last result, unchanged>,
                      date: "<date>", project: "<project, if any>" } })
   ```

   For a repeat after a ruling on an auto-mode stop, add `confirm: "auto"`: the workflow re-reads
   the task and runs its gates again before it builds. On `needs_human` with `needs_max_section`,
   show it verbatim and stop.

   `plan_ref` is small: `{branch, plan_commit, ref_path, ref_sha256, repo}`. Pass it exactly as the
   workflow returned it. The full plan ref lives in the plan commit; the workflow checks it against
   `ref_sha256` and refuses a mismatch.

   If the result is `awaiting_confirmation` again, the code judge found the plan wrong and the
   workflow re-planned. Show `proposed_plan_change` (a bullet list), then the new `tldr`,
   `plan_diff`, fleet size and `commands` (verbatim, as in step 7), and say that the old work is saved on `superseded_ref`. Ask again as
   in step 7. On "Build", repeat step 8 with the NEW `plan_ref`.

9. **Report.** Relay, in this order:
   - `status` and `reason`. `needs_human` means a gate stopped the run on purpose: quote the reason
     and the last `gate_log` lines, and say what a human must decide.
   - `branch`, `rounds`, `cumulative`, `role_versions`.
   - `pr_url` when present. The PR is a **draft**. The user reviews and merges it. Never mark it
     ready, never merge it, never enable auto-merge.
   - `review`: verdict, rounds, blocking findings and nits, the sweep verdict when it ran, and the
     model used. With `confirm: "auto"`, also `auto_confirmed` and the `intent` verdict.
   - `gates_not_run`: list every gate the run did not execute.
   - Write-back: `ledger_status` and `comment_status`. On `failed`, show `comment_text` (and any
     `section_text`) so the user can post it by hand.
   - `yadgar_findings`, grouped by role, so the main thread can capture them.

## Re-running

A second plan run for the same input reuses the branch and worktree under
`<repo>/.claude/worktrees/fleet-<task id>-<slug>/` and updates the plan in place, with a new plan
commit. If the branch already has build commits, plan mode stops: run build, or delete the branch.
Writers and the coder never commit: the only build commits are made by the workflow's commit step
after the code judge approves.

A build re-run with the same `plan_ref` resumes at the last completed gate. After the commit, the
push, the PR, the review and the write-back, the workflow records a local run-state ref. When a
later step failed (for example the push, on an SSH identity), fix the cause and run step 8 again
with the same `plan_ref`: the result says `resumed_at`, and no writer, coder or judge runs again.
A `needs_human` "run-state mismatch" means the branch or worktree changed since that milestone;
"approved but unresumable" means build commits exist without a run-state. Relay the reason; a
human pushes by hand or deletes the branch.

`stop_gate: "iac"` means the repo's hooks would run IaC tooling. "pre-push hooks run IaC tooling"
comes after the commit: tell the user to push the branch by hand. "commit hooks run IaC tooling"
comes before the commit: the tests and code stay uncommitted in the fleet worktree for the user to
commit and push by hand. Never push or commit for the user, and never bypass a hook.

A build that stopped before its commit step leaves uncommitted tests and code in the fleet
worktree, and a build started again with the same `plan_ref` stops with `needs_human` on the dirty
worktree. Tell the user: a human must commit, stash or clean that work first. The
workflow never deletes a branch or a worktree (it removes only the review's scratch worktrees). It
resets the fleet branch only during a re-plan after `plan_wrong`, and only after it saved the
uncommitted work on `superseded_ref`.
