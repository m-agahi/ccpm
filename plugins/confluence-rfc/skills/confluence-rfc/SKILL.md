---
name: confluence-rfc
description: >
  Use when the user asks to "create an RFC", "write an RFC", "new RFC page",
  "draft an RFC on Confluence", "RFC in PP space", "create a proposal on Confluence",
  or mentions creating a Confluence RFC document.
---

# Create Confluence RFC

Create a new RFC page in Confluence following the team's established template.

## Arguments

`$ARGUMENTS` — the RFC title/topic. Example: `/confluence-rfc AWS Lambda Deployment Strategy`

If no arguments provided, ask the user for the RFC topic before proceeding.

## MCP Tool Names

All Confluence and Jira operations use the Atlassian MCP server. In this environment:

- Confluence: `mcp__plugin_claude-code-home-manager_atlassian__confluence_<action>`
- Jira: `mcp__plugin_claude-code-home-manager_atlassian__jira_<action>`

If these tools are unavailable, check the project's `settings.local.json` for the correct
prefix and update accordingly.

---

## Configuration

This skill requires a config file. Look for it in this order (first found wins):

1. **Project config**: `confluence-rfc-config.md` in the project memory directory
   (highest precedence — per-project overrides)
2. **Global config**: `~/.config/claude/confluence-rfc-config.md`
   (shared across all projects — suitable for Nix/dotfile management)

If neither exists, run the **first-run setup** (see below) and save to the global path.

The user can trigger reconfiguration by saying "reconfigure confluence-rfc".

### Config file format

```markdown
---
name: confluence-rfc-config
description: Confluence RFC configuration
type: reference
---

## Confluence

- **Base URL**: https://yourcompany.atlassian.net
- **Template page ID**: 1234567890

## Spaces

- **key**: ENG
  **name**: Engineering
  **description**: Backend, infrastructure, platform
  **rfc_root_id**: 1234567890
  **year_folders**: 2026=2345678901

- **key**: PROD
  **name**: Product
  **description**: Product design, roadmap, features
  **rfc_root_id**: 3456789012
  **year_folders**: 2026=4567890123

## Jira (optional)

- **Project prefix**: QRND
```

**Notes:**

- `year_folders` is a comma-separated list of `YEAR=PAGE_ID` pairs.
  Add new years as needed (e.g. `2026=111,2027=222`).
- The Jira section is optional. If absent, Jira ticket pre-fill is skipped.
- Multiple spaces can be listed; the skill presents them as options.

### First-run setup

If no config file is found, ask the user for:

1. **Confluence base URL** — e.g. `https://mycompany.atlassian.net`
2. **Template page ID** — the Confluence page ID of their RFC template
3. **Spaces** — for each space:
   - Space key (e.g. `ENG`)
   - Space name (e.g. `Engineering`)
   - Short description (used for auto-suggest)
   - RFC root page ID (parent of the year folders)
   - Year folder ID for the current year (if it exists already)
4. **Jira project prefix** (optional) — e.g. `ENG`, `PROJ`

Then save the config to `~/.config/claude/confluence-rfc-config.md` and confirm:

> "Config saved to `~/.config/claude/confluence-rfc-config.md`. You can manage this
> file via Nix/dotfiles to share it across machines."

---

## Workflow

### 0. Load config

Read the config file as described above. Extract:

- `{BASE_URL}` — Confluence base URL
- `{TEMPLATE_ID}` — template page ID
- `{SPACES}` — list of space definitions (key, name, description, rfc_root_id, year_folders)
- `{JIRA_PREFIX}` — Jira project prefix (may be absent)

If config is missing: run first-run setup before proceeding.

### 1. Fetch Jira ticket (if referenced)

Skip this step if `{JIRA_PREFIX}` is not configured.

If the user references a Jira ticket (e.g. `PROJ-123`), fetch it:

```
mcp__plugin_claude-code-home-manager_atlassian__jira_get_issue
  issue_key: "<PROJ-123>"
  fields: "summary,status,description,assignee,issuetype,priority"
  comment_limit: 10
```

Extract the ticket title, description, and comments to pre-fill the RFC in Step 4.

If Jira tools are unavailable, proceed without ticket context — do not block the workflow.

### 2. Fetch the template

Fetch the live RFC template from Confluence:

```
mcp__plugin_claude-code-home-manager_atlassian__confluence_get_page
  page_id: "{TEMPLATE_ID}"
  convert_to_markdown: false
```

**Do not use `convert_to_markdown: true`** — Confluence macros (TOC, status tags, time
fields) are lost in markdown. The raw storage-format HTML is required.

**If this call fails** (permissions error, page deleted, Confluence unavailable):

- Tell the user what happened and stop. Do not proceed with a guessed template.
- Suggest the user verify `{TEMPLATE_ID}` in the config or check Confluence access.

### 3. Determine space

Suggest a space from `{SPACES}` based on the topic, then confirm with the user.

**Auto-suggest:** match the topic against each space's `description` field for keywords.
If the topic clearly matches one space, suggest it. If ambiguous, list all spaces and ask.

#### 3b. Resolve the year folder

From the chosen space's `year_folders`, look up the current year:

- **Found** → use that page ID directly
- **Not found**:
  1. Use `confluence_get_page_children` on `rfc_root_id` to list existing year folders
  2. Look for a page titled with the current year (e.g. `"2027"`)
  3. If found → use its page ID; update the config to cache it for next time
  4. If not found → create it:
     ```
     mcp__plugin_claude-code-home-manager_atlassian__confluence_create_page
       space_key: "<space key>"
       parent_id: "<rfc_root_id>"
       title: "<YYYY>"
       body: ""
       content_format: "storage"
     ```
  5. Add the new year+ID to the config's `year_folders` for the space

### 4. Collect metadata

Gather or infer — do not ask for things already clear from context:

| Field                  | Default                         |
| ---------------------- | ------------------------------- |
| **Author**             | The user's name                 |
| **Department/Team**    | Ask if not clear from context   |
| **Required Reviewers** | Ask the user                    |
| **Feedback deadline**  | 2 weeks from today (YYYY-MM-DD) |
| **PM**                 | Ask if relevant                 |

### 5. Prepare content

Compose the full page content before creating anything:

1. **Start from the template** — use the raw storage-format HTML from Step 2 exactly.
2. **Identify placeholders** — look for text unambiguously marked as instructional:
   patterns like `[Author Name]`, `[YYYY-MM-DD]`, `[Reviewer 1]`, `[Proposal summary]`,
   or any bracketed text that is clearly a placeholder. Do NOT replace anything that
   isn't clearly a placeholder — when in doubt, leave it as-is.
3. **Replace placeholders** with the metadata from Step 4.
4. **Set status**: The Status field in the metadata table must show `DRAFT` (Blue). The
   status progression row must show all four tags exactly as in the template:
   `DRAFT` (Blue) / `IN REVIEW` (Yellow) / `Accepted` (Green) / `REJECTED` (Red).
   Copy the `ac:structured-macro ac:name="status"` elements verbatim from the template.
5. **Pre-fill from context** — if the conversation contains technical context (design
   discussions, investigations, architecture decisions, Jira ticket details), populate
   the Background and Solution/Proposal sections with that content instead of leaving
   placeholder text. Be specific; do not pad with generic filler. This is the primary
   value of creating RFCs through Claude.
6. **Preserve all macros** — copy every Confluence macro verbatim from the template:
   - TOC: `<ac:structured-macro ac:name="toc" ac:schema-version="1"><ac:parameter ac:name="style">none</ac:parameter></ac:structured-macro>`
   - Time: `<time datetime="YYYY-MM-DD" />` — use the feedback deadline date
   - Status: `ac:structured-macro ac:name="status"` with `title` and `colour` params

### 6. Check for duplicates

Search for an existing page with the same title before creating:

```
mcp__plugin_claude-code-home-manager_atlassian__confluence_search
  query: "RFC: <topic>"
  space_key: "<space key>"
  limit: 5
```

If a match is found: tell the user and ask whether to rename, open the existing page,
or proceed anyway.

### 7. Confirm with the user

Present a summary and wait for explicit confirmation before creating anything:

> I'll create **RFC: \<Topic Name\>** in the **\<Space Name\>** space under the
> **\<Year\>** folder, authored by **\<Author\>** with a feedback deadline of
> **\<Date\>**.
>
> Reviewers: \<list\>
>
> Shall I create this page?

Do not proceed until the user confirms. Allow them to correct any field.

### 8. Create the page

```
mcp__plugin_claude-code-home-manager_atlassian__confluence_create_page
  space_key: "<space key>"
  parent_id: "<year folder ID>"
  title: "RFC: <Topic Name>"
  body: "<full storage-format HTML from Step 5>"
  content_format: "storage"
```

**If creation fails:**

- Title conflict → ask the user to rename
- Permission denied → tell the user which space they lack write access to
- Other error → report the full error message; do not retry silently

### 9. Add labels

After successful creation, add labels for discoverability:

```
mcp__plugin_claude-code-home-manager_atlassian__confluence_add_label
  page_id: "<new page ID>"
  labels: ["rfc", "draft"]
```

Also add a label matching the space key in lowercase (e.g. `"eng"`, `"prod"`).

### 10. Confirm and share

- Show the full page URL from the create response
- State: "Status is DRAFT. Share with reviewers when ready."
- Suggest next steps:
  1. Add more detail to Background and Solution sections
  2. Tag reviewers in Confluence (use @mentions in comments)
  3. Change status to IN REVIEW when ready for feedback
  4. Set a calendar reminder for the feedback deadline

---

## Rules

- **Always load config first** — never use hardcoded page IDs
- **Always use `content_format: "storage"`** — markdown loses Confluence macros
- **Always place under the current year folder**, not the RFC root
- **Always confirm with the user before creating** (Step 7 must complete first)
- **Prepare full content before creating the page** — Steps 5, 6, 7 before Step 8
- **Never recreate macros from memory** — copy them verbatim from the fetched template
- **Never pass `comment` as a Jira field name** — use the separate `comment_limit` param
- **`<time>` macro**: `datetime` must be `YYYY-MM-DD`
- **Stop on template fetch failure** — a page created from a guessed template is worse
  than no page
- **Update the config** when a new year folder is created, so future runs skip discovery
