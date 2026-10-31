# Contributing a Plugin

This guide walks you through adding a new plugin to the ccpm marketplace.

## Table of Contents

- [Before You Start](#before-you-start)
- [Plugin Structure](#plugin-structure)
- [Step 1: Create plugin.json](#step-1-create-pluginjson)
- [Step 2: Create a Skill](#step-2-create-a-skill)
- [Step 3: Add an Agent (Optional)](#step-3-add-an-agent-optional)
- [Step 4: Add Hooks (Optional)](#step-4-add-hooks-optional)
- [Step 5: Register in the Marketplace](#step-5-register-in-the-marketplace)
- [Step 6: Add a CHANGELOG](#step-6-add-a-changelog)
- [Step 7: Test Locally](#step-7-test-locally)
- [Step 8: Submit a PR](#step-8-submit-a-pr)
- [Versioning Guidelines](#versioning-guidelines)
- [Adopting the Marketplace in a Project](#adopting-the-marketplace-in-a-project)
- [Checklist](#checklist)

## Before You Start

- Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code) if you haven't already
- Clone this repo and create a feature branch
- Set up [pre-commit](https://pre-commit.com/) hooks (runs formatting and validation automatically on
  each commit):

  ```bash
  pip install pre-commit

  # Inside the repo:
  pre-commit install
  ```

- Look at the `audit-lab` plugin under `plugins/` as a working reference

## Plugin Structure

Create a directory under `plugins/` with the following layout:

```
plugins/my-plugin/
├── .claude-plugin/
│   └── plugin.json              # Plugin manifest (required)
├── skills/                      # Skills (preferred over commands/)
│   └── my-skill/
│       ├── SKILL.md             # Skill entrypoint (required)
│       └── reference.md         # Optional supporting files
├── agents/                      # Optional subagent definitions
│   └── my-agent.md
├── hooks/                       # Optional hook configurations
│   └── hooks.json
├── .mcp.json                    # Optional MCP server definitions
├── scripts/                     # Optional utility scripts
├── README.md                    # Plugin documentation
└── CHANGELOG.md                 # Version history
```

Important rules:

- `skills/`, `agents/`, `hooks/` must live at the **plugin root**, not inside `.claude-plugin/`
- All file references in hooks and MCP configs must use `${CLAUDE_PLUGIN_ROOT}` (not relative paths)
- Plugins cannot reference files outside their own directory

> **Note on commands:** You may see a `commands/` directory in older plugins. This is a legacy
> format — flat `.md` files in `commands/` still work and support the same frontmatter as skills,
> but **always use `skills/<name>/SKILL.md` for new work**. Skills support additional features
> (supporting files, nested directory discovery, live reload) that commands do not. If a skill and
> command share the same name, the skill takes precedence.

## Step 1: Create `plugin.json`

Create `.claude-plugin/plugin.json` in your plugin directory:

```json
{
  "name": "my-plugin",
  "description": "Brief description of what this plugin does",
  "author": {
    "name": "Your Name",
    "email": "you@example.com"
  },
  "repository": "https://codeberg.org/you/your-repo",
  "license": "Apache-2.0",
  "keywords": ["relevant", "keywords"]
}
```

| Field         | Required | Description                                          |
| ------------- | -------- | ---------------------------------------------------- |
| `name`        | Yes      | Kebab-case identifier (lowercase, hyphens only)      |
| `description` | Yes      | Brief description of what the plugin does            |
| `author`      | Yes      | Object with `name` (required) and `email` (optional) |
| `repository`  | No       | Source code URL                                      |
| `license`     | No       | SPDX license identifier (e.g. `Apache-2.0`)          |
| `keywords`    | No       | Tags for discovery                                   |

Rules:

- Do **not** put `version` here — it goes in `marketplace.json` only (to avoid silent conflicts)

## Step 2: Create a Skill

Skills are the primary way your plugin provides functionality. Create
`skills/<skill-name>/SKILL.md`:

```yaml
---
name: my-skill
description:
  What the skill does and when Claude should use it. Use when the user asks about X, wants to do Y,
  or mentions Z. Include specific trigger phrases (e.g. "show me the data", "run the migration").
argument-hint: "[arg1] [arg2]"
allowed-tools: Bash, Read, Grep
---

Instructions for Claude go here. Be specific and procedural.

## How to Use

Step-by-step workflow instructions...
```

### Frontmatter Fields

| Field                      | Required    | Description                                                                   |
| -------------------------- | ----------- | ----------------------------------------------------------------------------- |
| `name`                     | No          | Defaults to directory name. Lowercase, hyphens, max 64 chars                  |
| `description`              | Recommended | What the skill does and when to use it. Claude uses this to decide invocation |
| `argument-hint`            | No          | Shown in autocomplete (e.g. `[filename] [format]`)                            |
| `allowed-tools`            | No          | Tools Claude can use without per-use approval                                 |
| `disable-model-invocation` | No          | Set `true` to prevent Claude from auto-invoking (user-only trigger)           |
| `user-invocable`           | No          | Set `false` to hide from `/` menu (background knowledge only)                 |
| `context`                  | No          | Set `fork` to run in an isolated subagent context                             |
| `model`                    | No          | Model to use (`sonnet`, `opus`, `haiku`)                                      |

### Writing a Good Description

The `description` field is critical — Claude uses it to decide when to invoke your skill.

**Do:**

- Start with what the skill does: "Run database migrations against staging and production..."
- Include trigger phrases that match natural language: "when the user asks to deploy", "when they
  mention staging"
- Include domain-specific names (database names, service names, etc.) as trigger signals
- Keep it between 50-500 characters

**Don't:**

- Start with "This skill..." or repeat the skill name
- Use vague language like "helps with various tasks"
- Omit trigger scenarios

### Writing the Body

- Keep `SKILL.md` under 500 lines — move detailed reference material to supporting files
- Use imperative, procedural instructions
- Include concrete command templates with `${CLAUDE_PLUGIN_ROOT}` for file paths
- Add safety guardrails for destructive operations (use `AskUserQuestion` to confirm)
- Include fallback behavior so the skill never gets stuck

### String Substitutions

| Variable                | Description                          |
| ----------------------- | ------------------------------------ |
| `$ARGUMENTS`            | All arguments passed when invoking   |
| `$ARGUMENTS[N]`         | Specific argument by index (0-based) |
| `$0`, `$1`, etc.        | Shorthand for `$ARGUMENTS[N]`        |
| `${CLAUDE_PLUGIN_ROOT}` | Absolute path to plugin install dir  |

## Step 3: Add an Agent (Optional)

Create `agents/<agent-name>.md`:

```yaml
---
name: my-agent
description:
  Expert at X. Use proactively when Y happens or the user asks about Z.
tools: Read, Grep, Glob, Bash
model: sonnet
---

You are an expert at X. When invoked:
1. Do this first
2. Then do this
3. Report findings
```

Key fields:

| Field             | Description                                                  |
| ----------------- | ------------------------------------------------------------ |
| `name`            | Kebab-case identifier                                        |
| `description`     | When Claude should delegate to this agent. Use "proactively" |
| `tools`           | Allowlist of tools (inherits all if omitted)                 |
| `disallowedTools` | Denylist of tools                                            |
| `model`           | `sonnet`, `opus`, `haiku`, or `inherit`                      |
| `maxTurns`        | Maximum agentic turns before stopping                        |

The markdown body below the frontmatter becomes the agent's system prompt.

## Step 4: Add Hooks (Optional)

Create `hooks/hooks.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/my-script.sh",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

Common hook events: `PreToolUse`, `PostToolUse`, `Stop`, `SessionStart`, `UserPromptSubmit`.

Always use `${CLAUDE_PLUGIN_ROOT}` for script paths. Make sure scripts have executable permissions
(`chmod +x`).

## Step 5: Register in the Marketplace

Add your plugin to `.claude-plugin/marketplace.json`:

```json
{
  "plugins": [
    {
      "name": "my-plugin",
      "description": "Brief description for the plugin browser",
      "version": "1.0.0",
      "source": "./plugins/my-plugin",
      "author": {
        "name": "Your Name"
      },
      "license": "Apache-2.0",
      "category": "tools",
      "keywords": ["relevant", "keywords"],
      "homepage": "https://your-docs-site.example.com",
      "repository": "https://codeberg.org/you/your-repo"
    }
  ]
}
```

| Field         | Required | Description                                                            |
| ------------- | -------- | ---------------------------------------------------------------------- |
| `name`        | Yes      | Must match the `name` in `plugin.json`                                 |
| `description` | Yes      | Brief description shown in the plugin browser                          |
| `version`     | Yes      | Semver (`MAJOR.MINOR.PATCH`) — set **only** here, not in `plugin.json` |
| `source`      | Yes      | Relative path to the plugin directory                                  |
| `author`      | No       | Object with `name` (required) and `email` (optional)                   |
| `license`     | No       | SPDX license identifier                                                |
| `category`    | No       | Category for organization (e.g. `security`, `tools`)                   |
| `keywords`    | No       | Tags for discovery and search                                          |
| `homepage`    | No       | Documentation or project website URL                                   |
| `repository`  | No       | Source code URL                                                        |
| `tags`        | No       | Additional tags for searchability                                      |

Rules:

- Always bump the version when making changes — users won't receive updates otherwise

## Step 6: Add a CHANGELOG

Create `CHANGELOG.md` in your plugin directory following
[Keep a Changelog](https://keepachangelog.com/) format:

```markdown
# Changelog

## [1.0.0] - 2026-03-28

### Added

- Initial release
- Description of what's included
```

CI enforces this — PRs that modify plugin files without updating the corresponding `CHANGELOG.md`
will fail. The pre-commit hook catches this locally before you push.

## Step 7: Test Locally

### Load plugin without installing

```bash
claude --plugin-dir ./plugins/my-plugin
```

### Run all pre-commit checks

```bash
pre-commit run --all-files
```

### Run individual checks

```bash
# Version consistency
python3 .github/scripts/check_versions.py

# SKILL.md frontmatter
python3 .github/scripts/check_skill_frontmatter.py
```

### Debug plugin loading

```bash
claude --debug --plugin-dir ./plugins/my-plugin
```

## Step 8: Submit a PR

1. [Open an issue](https://codeberg.org/maxagahi/ccpm/issues/new) describing your change (new
   plugin, bug fix, etc.)
2. Create a feature branch: `git checkout -b feat/add-my-plugin`
3. Commit and push (pre-commit hooks will catch formatting and validation issues automatically)
4. Open a PR against `master` and reference the issue in the description (`Closes #N`, `Fixes #N`,
   or `Resolves #N`)
5. CI will validate: JSON syntax, formatting, SKILL.md frontmatter, version consistency, changelog
   updates, and a linked issue
6. Get a review and merge

> **Note:** PRs without a linked issue are automatically closed. PRs labeled `docs`, `chore`, or
> `dependencies` are exempt from this requirement.

## Versioning Guidelines

| Change Type      | Version Bump | Examples                                  |
| ---------------- | ------------ | ----------------------------------------- |
| Breaking changes | MAJOR        | Changed skill arguments, removed commands |
| New features     | MINOR        | New skills, new agents, new optional args |
| Bug fixes        | PATCH        | Fix typos, update docs, fix script bugs   |

## Adopting the Marketplace in a Project

To make it easy to discover and install plugins from this marketplace, add the following to your
project's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "maxagahi-marketplace": {
      "source": {
        "source": "codeberg",
        "repo": "maxagahi/ccpm"
      }
    }
  }
}
```

When someone opens Claude Code in the project, they'll be automatically prompted to add the
marketplace. No need to manually run `/plugin marketplace add`.

To also auto-enable specific plugins:

```json
{
  "extraKnownMarketplaces": {
    "maxagahi-marketplace": {
      "source": {
        "source": "codeberg",
        "repo": "maxagahi/ccpm"
      }
    }
  },
  "enabledPlugins": {
    "audit-lab@maxagahi-marketplace": true
  }
}
```

Commit this file to your repo so everyone gets the same plugin setup automatically.

## Checklist

Before submitting your PR, verify:

- [ ] An issue exists and is referenced in the PR description (`Closes #N`, `Fixes #N`, or
      `Resolves #N`)
- [ ] `.claude-plugin/plugin.json` has a valid `name` (kebab-case)
- [ ] `version` is set only in `marketplace.json`, not in `plugin.json`
- [ ] Skill descriptions include trigger phrases for Claude's invocation
- [ ] All file paths in hooks/MCP configs use `${CLAUDE_PLUGIN_ROOT}`
- [ ] Scripts have executable permissions (`chmod +x`) and a shebang line
- [ ] Destructive skills have `disable-model-invocation: true` or use `AskUserQuestion`
- [ ] `README.md` documents installation and usage
- [ ] `CHANGELOG.md` documents the release
- [ ] `pre-commit run --all-files` passes
- [ ] `claude plugin validate .` passes (if Claude Code is installed)
