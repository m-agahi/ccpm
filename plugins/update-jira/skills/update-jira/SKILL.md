---
name: update-jira
description:
  Post progress updates to Jira tickets based on session work, git activity, and PRs.
  Use when the user wants to update Jira, post progress, sync PR activity to tickets,
  or says "update jira", "post to jira", "jira update".
---

# Update Jira

**User input:** "$ARGUMENTS"

Two modes of operation:

- **Targeted mode** — `/update-jira PROJ-123` or `/update-jira <ticket-url> <pr-url>` — updates a specific ticket
- **Scan mode** — `/update-jira` (no args) — scans all active tickets and recent PRs, correlates them, and updates in batch

## Configuration

This skill needs to know your Jira project, GitHub org, and repos. Look for config in
this order (first found wins):

1. **Project config**: `update-jira-config.md` in the project memory directory — highest
   precedence, allows per-project overrides.
2. **Global config**: `~/.config/claude/update-jira-config.md` — shared across all projects,
   suitable for Nix/dotfile management. Non-Nix users can also place their config here manually.

If neither exists, ask the user for:

1. **Jira email** — their Jira account email (for `mcp__atlassian__jira_get_user_profile`)
2. **Jira project key** — e.g. `PROJ`, `ENG`, `PLATFORM`
3. **Jira base URL** — e.g. `https://mycompany.atlassian.net`
4. **GitHub org** — e.g. `mycompany`
5. **GitHub repos** — comma-separated list of repos to scan for PRs

Then save the config to `~/.config/claude/update-jira-config.md` (global, works for
everyone) and inform the user they can also manage it via Nix/dotfiles.
The user can update config by saying "reconfigure update-jira".

Throughout this skill, replace these placeholders with the configured values:

- `{PROJECT}` → Jira project key
- `{JIRA_BASE}` → Jira base URL
- `{ORG}` → GitHub org
- `{REPOS}` → list of repos
- `{EMAIL}` → Jira email

## Memory Files

This skill uses persistent memory files in the project memory directory:

- **`update-jira-config.md`** — configuration (project, org, repos, email, base URL)
- **`jira-tickets.md`** — cached active tickets (refreshed every run)
- **`update-jira-state.md`** — last run timestamp, user info

---

## Scan Mode (no arguments)

### 1. Identify the user

- Use `mcp__atlassian__jira_get_user_profile` with `user_identifier: "{EMAIL}"` to get the current user's Jira `accountId` and display name.
- Use `mcp__github__search_users` or `gh api user` to get the GitHub username.

### 2. Scan Jira tickets

- Use `mcp__atlassian__jira_search` with JQL: `project = {PROJECT} AND assignee = currentUser() AND status IN ("New", "To Do", "In Progress") ORDER BY updated DESC` and `limit: 50`, `fields: "summary,status,updated,issuetype"`.
- Save results to memory file `jira-tickets.md` — **refresh every run** (overwrite previous cache).
- Cache format per ticket: ticket key, title, status, last updated.
- Present a summary to the user: "Found X active tickets assigned to you."

### 3. Scan PRs across repos

For each repo in `{REPOS}`:

- Use `mcp__github__list_pull_requests` with `state: "all"`, `sort: "updated"`, `direction: "desc"` to find PRs.
- **Time window**: filter PRs updated since the last run timestamp (from `update-jira-state.md`). If no previous run exists, use **today** (start of current day).
- Filter results to only PRs by the user (check `user.login`).
- Includes open, merged, and closed PRs.
- Run all repo scans **in parallel** for speed.
- **Note**: MCP results can be very large. If output is saved to a file, use Bash with python/jq to filter for the user's PRs and time window.

### 4. Correlate PRs to tickets

- For each PR, search for ticket IDs matching `[A-Z]+-\d+` in:
  - PR title
  - PR body
  - Branch name
  - Commit messages
- Group PRs under their matched tickets.
- **Epic handling**: if a matched ticket is an Epic, use `mcp__atlassian__jira_search` with JQL `parent = {PROJECT}-XXXXX` to fetch child issues and try to match PRs to the most relevant child based on title/description keywords. If no child matches, update the Epic itself.

### 5. Handle unmatched PRs

- If a PR has no ticket match:
  - Search unassigned tickets in the `{PROJECT}` project for keywords from the PR title/branch to find possible matches.
  - If a possible match is found, ask: **"PR #X in repo Y looks related to {PROJECT}-123 — [ticket title]. Want to assign it to yourself and link it?"**
  - If no match found, add to the **skipped PRs list** (reported at the end).

### 6. Update tickets one by one

For each ticket that has matched PRs:

1. **Generate the progress comment** (see comment format below).
2. **Generate PR fixes** — for each related PR:
   - PR title: add ticket number prefix (`{PROJECT}-123 - <title>`) if missing
   - PR body: add `Jira: {JIRA_BASE}/browse/{PROJECT}-123` at the top if missing
3. **Show the draft** to the user:
   - The Jira comment
   - Proposed PR title/body changes (if any)
   - Ask: **"Want me to post this? Any changes?"**
   - Ask: **"Should I also change the ticket status?"**
4. **On approval ("post")**: execute everything immediately — post Jira comment, update all PR titles/bodies, transition ticket status. No further prompts.
5. Move to the next ticket.

### 7. Summary

After all tickets are processed:

- List any **unmatched PRs** that were skipped (repo, PR number, title, URL).
- Save the current timestamp to `update-jira-state.md` as the last run time.
- Report: "Updated X tickets, fixed Y PRs, Z PRs skipped."

---

## Targeted Mode (with arguments)

When invoked with specific ticket URLs, PR URLs, or ticket keys:

### 1. Identify the ticket

- **Check arguments first** — extract ticket keys from provided URLs or keys.
- **Check conversation context** — if Jira tickets were mentioned or worked on during this session, suggest those.
- **Optionally check git state** — run `git rev-parse --show-toplevel` and `git branch --show-current`. Extract ticket IDs matching `[A-Z]+-\d+` from the branch name.
  - **Always tell the user what you found and where:** e.g., "I see you're in repo `my-service` on branch `feature/{PROJECT}-123-foo` — should I update {PROJECT}-123?"
  - The user may be in a repo unrelated to their Jira work. Git state is a **hint**, not truth.
- If no ticket is found, ask: **"Which Jira ticket should I update?"**

### 2. Confirm the ticket

- Fetch ticket details using `mcp__atlassian__jira_get_issue` with the issue key.
- Present to the user:
  > I'll update **{PROJECT}-123 — [ticket title]** (status: In Progress). Correct?
- **Wait for explicit confirmation.** Allow the user to correct the ticket key.

### 3. Generate the progress comment

Build a structured comment from:

- **Session context** — what was discussed, worked on, decided, or debugged in this conversation
- **Git state** (if relevant) — branch, recent commits, changed files, open PRs
- **PR info** (if provided) — PR title, state, files changed, reviewers
- **Blockers** — any issues or blockers mentioned during the session
- **Next steps** — what the user plans to do next

### 4. User approval

- Show the full draft comment and any proposed PR title/body changes.
- Ask: **"Want me to post this? Any changes?"**
- Ask: **"Should I also change the ticket status?"**
- Apply any edits the user requests.

### 5. Post the update

On approval ("post"): execute everything immediately:

- Post Jira comment
- Update PR title (add ticket prefix) and body (add Jira link) if needed
- Transition ticket status if requested
- Confirm: "Posted update to {PROJECT}-123."

### 6. Multiple tickets

- If the user worked on multiple things, ask: **"Want to update any other tickets?"**

---

## Jira Comment Format

Use Markdown format (the MCP `mcp__atlassian__jira_add_comment` tool accepts Markdown and converts it automatically):

```
### Progress Update — YYYY-MM-DD HH:MM

**What was done:**
- [bullet points summarizing work from PRs and session context]

**Current state:**
- [branch/PR status, deployment state, or other context]

**Blockers:**
- [any blockers, or "None"]

**Next steps:**
- [planned next actions]
```

## PR Update Rules

- **PR title**: must include ticket number as prefix: `{PROJECT}-123 - <original title>`
  - Skip if ticket number already present anywhere in the title.
  - Use `gh api repos/{ORG}/<repo>/pulls/<number> --method PATCH -f title="<new title>"` (no MCP update tool exists).
- **PR body**: must include a Jira link at the top:
  ```
  Jira: {JIRA_BASE}/browse/{PROJECT}-123
  ```
  - Skip if the body already contains a link to the ticket.
  - Use `gh api repos/{ORG}/<repo>/pulls/<number> --method PATCH -f body="<new body>"` (no MCP update tool exists).

## Important Rules

- **Always confirm before posting.** Show the draft and wait for approval. Never post without it.
- **When the user says "post", execute immediately.** Post the Jira comment, update PRs, and transition status in one go. No further prompts.
- **MCP first for GitHub.** Always use `mcp__github__*` tools for reads (get PR, list PRs, get issue). Fall back to `gh api` only for operations with no MCP equivalent (e.g., PATCH to update PR title/body).
- **No permission prompts for reads and PR updates.** Fetching Jira ticket details, reading PR info, and updating PR title/body should execute without asking for user permission. These are low-risk operations.
- **Git context is optional.** The primary source of truth is the conversation, PRs, and the user's input.
- **Keep comments concise.** Aim for 4-8 bullet points total. Managers want a quick scan, not an essay.
- **Use Markdown** for Jira comments (the MCP tools accept Markdown and convert automatically).
- **Jira API access**: ALWAYS use the Atlassian MCP tools (`mcp__atlassian__jira_*`) instead of curl. Key tools:
  - `mcp__atlassian__jira_get_user_profile` — get user info by email/username/accountId
  - `mcp__atlassian__jira_search` — JQL search for tickets (supports `limit`, `fields`, `start_at`)
  - `mcp__atlassian__jira_get_issue` — get single issue details
  - `mcp__atlassian__jira_add_comment` — post a comment (Markdown format)
  - `mcp__atlassian__jira_get_transitions` — list available status transitions
  - `mcp__atlassian__jira_transition_issue` — change issue status (use `get_transitions` first to get the `transition_id`)
  - `mcp__atlassian__jira_update_issue` — update issue fields
- **Never use curl for Jira.** The MCP server handles auth and formatting automatically.
- **Run repo scans in parallel** for speed during scan mode.
