## Purpose

Prove a gate/hook/CI-predicate change refuses everything the SHIPPED gate refuses — per-unit refusing-direction mutation sweep, both gates, ADR-0645. Use before merging any gate modification.

## Prompt

DISPATCH: model=opus (fallback=sonnet) — adversarial old-vs-new gate differential

# Pattern: gate-change non-weakening sweep

Use when a pull request MODIFIES an existing gate — a pre-commit hook, a CI predicate, a linter, any check producing a verdict — and the question is whether it still refuses everything the shipped version refuses. This is NOT the same job as reviewing a gate by poison input (ADR-0606), which asks whether the gate refuses what it must. A modification raises the other question, and a change's own test suite structurally cannot answer it.

**The governing rule is ADR-0645:** a gate change may not merge while it accepts any input the shipped gate refuses. Not when the loosening is disclosed in the body. Not when an older version of the gate shared the blind spot. A restored hole is a hole. So the sweep's output is a merge verdict, not a footnote.

## Why the change's own evidence never suffices

A green tree is consistent with unlimited weakening. A suite that asserts "the gate refuses X" passes for a gate that refuses X and nothing else. Every mutation an author naturally writes points the CONFIRMING direction — a case the new gate refuses — because the opposite mutation is the one that makes their change look worse. Only an old-red/new-green pair detects a loosening, and nobody writes it by accident.

## The protocol

1. **Get both gates as files.** The shipped one from the default branch (`git show origin/main:<path>`), the candidate from the PR branch (`git show origin/<branch>:<path>`). Byte-verify the shipped copy against the branch you claim it came from; a stale local copy invalidates the whole sweep.

2. **Enumerate the units the gate governs on a REAL target tree** — handlers, files, rules, resources, whatever the gate iterates. Do not accept a unit list from the dispatch or the PR body without confirming it against the tree. Report the list you measured.

3. **For each unit, construct the mutation the gate exists to catch**, then run BOTH gates and record both exit codes. Restore between units. Locate the mutation site by its TEXT, never by line number — line numbers move and a sweep that silently mutates the wrong line produces confident nonsense.

4. **Classify every row.** Shipped-red + candidate-green is a LOOSENED unit and blocks the merge. Report the count even when it contradicts what the dispatch expects; a corrected figure is the deliverable.

5. **Sweep the other consumer trees too**, not just the one where the problem was found. A loosening measured on one tree says nothing about the others, and a rule that tightens on one tree can loosen on another.

## Two failure modes that have each already produced a wrong conclusion

**An empty argument list exits 0 having examined nothing.** `python3 gate.py $(find src -name '*.rs')` run from anywhere but the tree root expands to nothing, the gate loops over zero paths, and it exits 0 — indistinguishable from a pass. This single cause can reproduce an entire set of contradictory observations at once. **Print the examined-unit count beside every exit code, always.** A tree reporting 0 units is a broken run, not a clean repo. If your instrument reports zero where a figure is known non-zero, say your instrument is broken rather than reporting the zero — that admission is more useful than the number.

**A plausible mechanism story loses to one grep.** "The registrations moved to submodules, so the parent kept the constructor and the gate sees nothing" is the shape of reasoning that gets this backwards. Settle every claim about which files a gate reads, or what a refactor moved where, by running the gate or grepping the tree. Never by reasoning from the shape of the change.

## Label every measurement with its tree

A sweep that spans two trees — pre-refactor and post-refactor, or shipped-target and candidate-target — will give OPPOSITE answers on the same mutation by design. That is exactly the pair a reader transposes. Attach the ref to every figure at the point you state it, not once in a preamble.

## Report

- The per-unit table: unit, mutation site (file + the exact text removed), shipped exit code, candidate exit code, verdict.
- Examined-unit count per tree, beside each exit code.
- The loosened count, stated first if non-zero.
- For each loosened unit, the MECHANISM — what the candidate follows or credits that the shipped gate does not. Distinct mechanisms matter more than the count: a hop-count fix cannot close a zero-hop case, and knowing that changes the fix.
- Where a proposed fix makes some in-code exemption or escape hatch load-bearing, characterise that hatch's soundness. An unsound escape hatch on a gate is the same hole wearing different clothes.

## Do not

- Do not bend the candidate to make the sweep look good.
- Do not merge. The sweep informs a merge decision that is not yours.
- Do not report a mechanism you inferred; report one you reproduced.

## Fleet mode (when the input carries fleet: true)

Inputs: `{pr_number, repo, base_ref, head_sha, worktree, scratch_dir, changed_paths, fleet:true}`, plus `test_env` and `test_env_note` (fleet 4.0.0) when the repo declares a throwaway test database. Use the DSN in `test_env` as given, in the scratch worktrees too.
Rules:

- Never mutate `worktree` (it is fingerprinted). Create two detached worktrees with these two commands:

  - `git -C <worktree> -c core.hooksPath=/dev/null worktree add --detach <scratch_dir>/sweep-shipped <base_ref>`
  - `git -C <worktree> -c core.hooksPath=/dev/null worktree add --detach <scratch_dir>/sweep-new <head_sha>`

  (hooks off for scratch worktrees only — never for commits or pushes). Apply refusing-direction mutations and run the shipped gate and the new gate on the same inputs there.

- Remove both worktrees with `git worktree remove --force`, then run `git worktree prune`, before you report, even when you fail.
- Verdicts:
  - `not_applicable`: no gate or check in changed_paths. Return `units: []`.
  - `weakening`: any unit where the shipped gate refuses and the new gate accepts.
  - `non_weakening`: none of those.
- Check which direction of each flag is the strict one before you judge.
- End with exactly ONE fenced json block as the LAST thing:

```json
{
  "status": "ok|needs_human|failed",
  "reason": "<one line>",
  "verdict": "non_weakening|weakening|not_applicable",
  "units": [
    {
      "unit": "<gate/check name>",
      "mutation": "<input variant>",
      "shipped_refuses": true,
      "new_refuses": true
    }
  ],
  "findings": [
    {
      "id": "S1",
      "severity": "blocking|nit",
      "category": "fail_open|correctness|other",
      "file": "<path>",
      "line": 0,
      "summary": "<one line>",
      "evidence": "<command+output>"
    }
  ],
  "yadgar_findings": ["<bullets>"]
}
```

Required on ok: verdict, units (array), findings (array). Every weakening unit also appears as a blocking finding. Since fleet 4.0.0 the schema lists the required keys on every status: on `needs_human` or `failed`, set each one you have no value for to null. On `ok`, a missing key, a `null` where the type does not allow it, or a wrong type is contract drift: the workflow sends the result back to you once, then stops the run.
