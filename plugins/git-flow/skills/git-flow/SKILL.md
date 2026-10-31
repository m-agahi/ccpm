---
name: git-flow
description: >
  Safe git workflow enforcer for worktree-based development. Use when the user
  asks to commit, push, create a PR, branch, or do any git operation. Also
  triggers on "git flow", "create branch", "open PR", "push my changes",
  "commit this", "clean up branch", or similar git workflow requests.
allowed-tools: Bash, Read, Glob, Grep
---

# git-flow

Safe git workflow for worktree-based development. Prevents committing to master,
pushing to merged branches, and other common mistakes.

## Arguments

`$ARGUMENTS` — optional subcommand: `branch`, `commit`, `push`, `pr`, `cleanup`, `status`.
If no subcommand is given, infer the action from context (what was the user asking to do?).

---

## Core Rules (ALWAYS apply — no exceptions)

1. **Never commit or push to `master`** — if `git branch --show-current` returns `master`,
   stop immediately and ask the user which branch to use.
2. **Never use a merged branch** — if the branch has a merged or closed upstream PR,
   stop and ask the user to start fresh with the `branch` subcommand.
3. **Always check branch before any git write operation** — run
   `git branch --show-current && git status` first.
4. **Worktree-first** — new work always starts in its own worktree. Use `git worktree add`
   when a worktree is needed. Never use `git checkout -b` to start work.
5. **Always look for the PR template** before creating a PR (`.github/`, `.gitea/`,
   `.forgejo/`, repo root or `docs/` — see the `pr` subcommand). Use it if found.
6. **Conventional commits**: `type(scope): subject` — e.g., `feat(git-flow): add safety guards`.
7. **Never `git add -A`** — always stage specific files by name.
8. **Never force-push** unless the user explicitly asks.
9. **Never amend commits** unless the user explicitly asks — always create a new commit.

---

## Worktree Context

This repo uses worktree-first development:

- Each branch lives in its own isolated directory at
  `~/.local/share/worktrees/<repo>/<branch>`
- Worktrees are created with `git worktree add ~/.local/share/worktrees/<repo>/<branch> -b <branch> origin/master`
- Use `git -C <worktree-path>` when operating on a worktree from outside its directory

To detect the current context:

```bash
git branch --show-current        # current branch name
git rev-parse --show-toplevel    # current worktree root
git worktree list                # all active worktrees
```

---

## Safety Decision Tree

Before any git write operation (commit, push, branch, merge, rebase):

```
Is current branch == "master"?
  YES → STOP. Tell the user. Ask which branch to use.
  NO  → Is this branch merged?
          YES → STOP. Tell the user. Offer to start a new branch.
          NO  → Proceed.
```

Check if branch is merged:

```bash
# Check if remote branch still exists (deleted = likely merged)
git ls-remote --heads origin <branch>

# Or ask the forge — detect the host first (see "Forge Detection" below)
# GitHub:
gh pr list --repo "$OWNER/$REPO" --head "$BRANCH" --state all --json number,state,mergedAt

# Forgejo / Gitea / Codeberg:
curl -s -H "Authorization: token $TOKEN" \
  "https://$HOST/api/v1/repos/$OWNER/$REPO/pulls?state=closed&head=$BRANCH&limit=5" \
  | python3 -c "import json,sys; prs=json.load(sys.stdin); print(any(p.get('merged') for p in prs))"
```

---

## Forge Detection

Derive host, owner and repo from the `origin` remote. Never hard-code them.

```bash
URL=$(git remote get-url origin)
# Handles https://host/owner/repo(.git), git@host:owner/repo(.git), ssh://git@host/owner/repo(.git)
HOST=$(printf '%s' "$URL" | sed -E 's#^[a-z+]+://##; s#^[^@/]*@##; s#[:/].*$##')
SLUG=$(printf '%s' "$URL" | sed -E 's#^[a-z+]+://[^/]+/##; s#^[^@/]*@[^:/]+[:/]##; s#\.git$##')
OWNER=${SLUG%%/*}
REPO=${SLUG#*/}
BRANCH=$(git branch --show-current)
BASE=$(git symbolic-ref --short refs/remotes/origin/HEAD | sed 's#^origin/##')
```

`HOST` can be an SSH alias (e.g. `github-personal`). Resolve it with
`ssh -G "$HOST" | awk '/^hostname /{print $2}'`.

| Resolved host                                              | Forge           | PR tool             |
| ---------------------------------------------------------- | --------------- | ------------------- |
| `github.com` (or a GitHub Enterprise host known to `gh`)   | GitHub          | `gh` CLI            |
| `codeberg.org`, or a host whose `/api/v1/version` responds | Forgejo / Gitea | REST API via `curl` |
| Anything else                                              | Unknown         | Ask the user        |

**Forgejo / Gitea token:** read it from an env var the user already has set
(e.g. `CODEBERG_TOKEN`, `FORGEJO_TOKEN`), or ask the user which 1Password
reference to `op read`.

```bash
TOKEN="${CODEBERG_TOKEN:-$FORGEJO_TOKEN}"   # empty → ask the user for an op:// reference
```

Never print the token. Never write a token value into
a file or a commit.

---

## Subcommands

### `status`

Run a context check and report:

```bash
git branch --show-current
git status
git log --oneline -5
git worktree list
```

Report:

- Current branch and worktree path
- Uncommitted/staged changes
- Whether the branch has a remote tracking branch
- Safety status (green = not on master/merged, red = unsafe)

---

### `branch` — Start new work

1. Check if already in a non-master worktree:

   ```bash
   git branch --show-current
   ```

   - Already on a feature branch → tell the user, skip to `commit`.

2. Determine branch name — infer from Jira ticket, topic, or ask the user.
   Convention: `feat/<topic>`, `fix/<topic>`, `chore/<topic>`.

3. Sync master:

   ```bash
   git -C <main-repo-root> fetch origin
   git -C <main-repo-root> reset --hard origin/master
   ```

4. Create the worktree:

   ```bash
   WORKTREE=~/.local/share/worktrees/<repo>/<branch>
   git -C <main-repo-root> worktree add "$WORKTREE" -b <branch> origin/master
   ```

5. Confirm the worktree is ready and report the path. All subsequent operations
   use `git -C $WORKTREE`.

---

### `commit` — Stage and commit

**Guard first**: `git branch --show-current` → if `master`, STOP.

1. Show diff:

   ```bash
   git status
   git diff --stat
   ```

2. Stage specific files (never `git add -A`):

   ```bash
   git add <file1> <file2> ...
   ```

3. Write commit message — conventional commits:

   - Format: `type(scope): subject` (subject ≤ 72 chars, imperative mood)
   - Types: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `ci`

4. Commit:

   ```bash
   git commit -m "type(scope): subject"
   ```

5. If pre-commit hooks fail:
   - Read the error carefully
   - Fix the issue (often: prettier reformatted files → re-stage them)
   - Create a **new** commit — never amend

---

### `push` — Push to remote

**Guard first**: `git branch --show-current` → if `master`, STOP.

1. Check for upstream:
   ```bash
   git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null
   ```
2. First push: `git push -u origin <branch>`
3. Subsequent: `git push`
4. Report push result and offer to create a PR.

---

### `pr` — Create pull request

**Guard first**: `git branch --show-current` → if `master`, STOP.

1. Ensure branch is pushed (run `push` steps if not).

2. Check for PR template:

   ```bash
   find . -maxdepth 3 -not -path './.git/*' -iname 'pull_request_template*' 2>/dev/null
   # Typical locations: .github/, .gitea/, .forgejo/, repo root, docs/
   ```

   On GitHub, also check the org fallback:
   `gh api repos/$OWNER/.github/contents/.github 2>/dev/null`.

3. Fill the template from commit history and session context. Keep every
   template section header. Infer issue number from branch name if possible
   (e.g. `feat/65-topic` → `#65`).

4. Detect the forge, owner and repo (see **Forge Detection** above). Determine
   the base branch (`$BASE`) from `origin/HEAD`.

5. Create the PR with the tool for that forge.

   **GitHub** — use `gh`:

   ```bash
   gh pr create --repo "$OWNER/$REPO" --base "$BASE" --head "$BRANCH" \
     --title "<PR title>" --body-file <filled-template-file>
   ```

   **Forgejo / Gitea / Codeberg** — use the REST API (`gh` does not work here):

   ```bash
   python3 -c 'import json,sys; print(json.dumps({"title": sys.argv[1], "head": sys.argv[2], "base": sys.argv[3], "body": open(sys.argv[4]).read()}))' \
     "<PR title>" "$BRANCH" "$BASE" <filled-template-file> > /tmp/pr.json
   curl -s -X POST \
     -H "Authorization: token $TOKEN" \
     -H "Content-Type: application/json" \
     "https://$HOST/api/v1/repos/$OWNER/$REPO/pulls" \
     --data @/tmp/pr.json
   ```

6. Verify the PR body kept every template section header
   (`gh pr view <N> --json body` on GitHub; `GET /api/v1/repos/$OWNER/$REPO/pulls/<N>`
   on Forgejo). Report the PR URL.

---

### `cleanup` — Remove branch after merge

1. Confirm branch and worktree path:

   ```bash
   git branch --show-current
   git worktree list
   ```

2. Switch to master in the main repo:

   ```bash
   git -C <main-repo-root> checkout master
   git -C <main-repo-root> pull
   ```

3. Remove the worktree:

   ```bash
   git worktree remove <worktree-path>
   ```

4. Delete local branch:

   ```bash
   git branch -d <branch>
   ```

5. Optionally delete remote branch (ask the user first):
   ```bash
   git push origin --delete <branch>
   ```

---

## First-Run: Hook Setup

On first invocation, check if the git-flow guard hook is active:

```bash
python3 -c "
import json, os
path = os.path.expanduser('~/.claude/settings.json')
d = json.load(open(path))
hooks = d.get('hooks', {})
pre = hooks.get('PreToolUse', [])
has_guard = any('git-flow-guard' in str(h) for h in pre)
print('configured' if has_guard else 'missing')
"
```

If `missing`, offer to configure it automatically. See the
[git-flow hook setup guide](../../README.md#git-flow-hook-setup) in the ccpm README.

---

## Rules Summary

| Rule                 | Detail                                                    |
| -------------------- | --------------------------------------------------------- |
| No push to master    | Stop and ask the user which branch to use                 |
| No merged branches   | Stop and offer to start a new branch                      |
| Check branch first   | Always run `git branch --show-current` before write ops   |
| Worktree-first       | Use `git worktree add`, never `git checkout -b`           |
| No `git add -A`      | Stage specific files only                                 |
| No force-push        | Unless explicitly asked                                   |
| No amend             | Create new commits; never amend unless asked              |
| Conventional commits | `type(scope): subject` format                             |
| Forge-aware PRs      | GitHub → `gh`; Forgejo/Gitea → REST API with user's token |
| Pre-commit failure   | Re-stage reformatted files and create a new commit        |
