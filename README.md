# ccpm — Claude Code Plugin Marketplace

![plugins](https://img.shields.io/badge/plugins-6-blue)

Personal plugin marketplace for [Claude Code](https://claude.ai/code).

## Plugins

### code-review (v4.0.0)

Comprehensive local code review with 12 specialized agents. All analysis runs locally inside a Docker container — nothing is pushed to remote.

**Agents included:**

| Agent                 | Model  | What it does                                          |
| --------------------- | ------ | ----------------------------------------------------- |
| code-quality-reviewer | opus   | Bugs, design patterns, performance, maintainability   |
| security-reviewer     | opus   | OWASP Top 10, injection, Semgrep, Gitleaks            |
| dependency-checker    | sonnet | CVEs, outdated versions, license compliance           |
| sonarqube-scanner     | sonnet | Full SonarQube static analysis                        |
| trivy-scanner         | script | Container & filesystem vulnerabilities, Hadolint      |
| fuzz-tester           | sonnet | Property-based testing (Hypothesis, fast-check, etc.) |
| type-checker          | haiku  | tsc, mypy, pyright, staticcheck, ShellCheck, sqlfluff |
| linter                | haiku  | ESLint, ruff, golangci-lint, PMD, phpcs, clippy       |
| gha-security          | sonnet | GitHub Actions workflow security (zizmor, actionlint) |
| report-generator      | sonnet | Deduplicates and compiles all findings                |
| improvement-advisor   | haiku  | Suggests Docker image and tooling improvements        |
| jira-ticket-creator   | sonnet | Creates Jira tickets from findings (optional)         |

**Languages supported:** Python, Java, Kotlin, JavaScript, TypeScript, Go, Rust, PHP, Ruby, Shell, SQL, Terraform/HCL, Docker, Helm, Makefiles, GitHub Actions.

**Requirements:** Docker, Claude Code CLI.

#### Configuration

##### Private registries

If your project pulls from private package registries (Maven, npm, pip, Go, etc.), configure credential mounts so the review container can resolve dependencies:

```bash
# Edit the config (auto-created on first run from the bundled template)
$EDITOR ~/.config/code-review/registries.yml
```

Uncomment the entries you need and point them at your local credential files. Supported registries:

| Package manager | Source file                    | Works with                                        |
| --------------- | ------------------------------ | ------------------------------------------------- |
| Maven           | `~/.m2/settings.xml`           | Nexus, Artifactory, AWS CodeArtifact, GitHub Pkgs |
| npm             | `~/.npmrc`                     | npm Enterprise, Artifactory, GitHub Pkgs, GitLab  |
| pip             | `~/.config/pip/pip.conf`       | Private PyPI, AWS CodeArtifact, Artifactory       |
| Go              | `~/.netrc`                     | Private modules, GOPROXY                          |
| Gradle          | `~/.gradle/gradle.properties`  | Nexus, Artifactory, GitHub Pkgs                   |
| Cargo           | `~/.cargo/credentials.toml`    | Private crate registries                          |
| Composer        | `~/.config/composer/auth.json` | Private Packagist, Satis                          |
| NuGet           | `~/.nuget/NuGet/NuGet.Config`  | Azure Artifacts, GitHub Pkgs, private NuGet feeds |

You can also pass environment variables (e.g., `GOPROXY`, `PIP_INDEX_URL`) via the `env:` section in the same file.

### update-jira (v1.1.0)

Post progress updates to Jira tickets based on session work, git activity, and PRs.

- **Targeted mode** — `/update-jira PROJ-123` — update a specific ticket from your session context
- **Scan mode** — `/update-jira` — batch-scan active tickets and recent PRs, correlate, and update

Auto-fixes PR titles (adds ticket prefix) and PR bodies (adds Jira link). Configurable per-project via memory file (Jira project, GitHub org, repos, email).

**Requirements:** Atlassian MCP server, GitHub MCP server.

### git-flow (v1.0.1)

Safe git workflow enforcer for worktree-based development.

- Guards against committing or pushing to `master`
- Guards against operating on merged/closed branches
- Worktree-first branching — uses `git worktree add` instead of `git checkout -b`
- Handles commit, push, PR creation (Codeberg/Forgejo), and branch cleanup
- Detects merged branches via `git ls-remote` and optional Forgejo API check
- First-run setup wizard configures the companion `PreToolUse` hook automatically

**Subcommands:** `branch`, `commit`, `push`, `pr`, `cleanup`, `status`.
If no subcommand is given, the skill infers the action from context.

**Requirements:** `op` CLI (1Password) for Codeberg PAT when creating PRs.

#### git-flow hook setup

The git-flow skill works best with a `PreToolUse` hook that injects a safety
reminder before every `git` Bash command — even when the skill is not explicitly
invoked. The skill detects if this hook is missing on first run and offers to
configure it automatically.

To set it up manually:

**1. Create the hook script:**

```bash
mkdir -p ~/.claude/hooks
cat > ~/.claude/hooks/git-flow-guard.sh << 'EOF'
#!/bin/bash
INPUT=$(cat)
CMD=$(echo "$INPUT" | python3 -c "import json,sys; \
  d=json.load(sys.stdin); \
  print(d.get('tool_input',{}).get('command',''))" 2>/dev/null)
if echo "$CMD" | grep -qw "git"; then
  printf '{"type":"context","text":"[GIT-FLOW GUARD] Check branch before proceeding: run git branch --show-current. NEVER commit or push to master. NEVER operate on a merged branch. Follow the git-flow skill rules."}'
fi
EOF
chmod +x ~/.claude/hooks/git-flow-guard.sh
```

**2. Add the hook to `~/.claude/settings.json`** under `hooks.PreToolUse`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/hooks/git-flow-guard.sh",
            "timeout": 5000
          }
        ]
      }
    ]
  }
}
```

### tf-naming-check (v1.1.0)

Terraform naming convention checker powered by a Haiku agent.

- Reads a team-editable `tf-naming-config.md` rulebook — ships with opinionated defaults based on the HashiCorp style guide
- Project-level override: place `tf-naming-config.md` in your project root to take precedence over the installed default
- Scans all `**/*.tf` files, skipping `.terraform/`, `vendor/`, and `.terragrunt-cache/`
- Optional path-prefix scoping: `/tf-naming-check modules/networking`
- Three-tier severity reporting: ERROR (wrong format), WARNING (anti-pattern), INFO (suggestion)

**Default rulebook covers:** resources, variables, outputs, locals, modules, data sources, and tags — including AWS subnet/security group Name tag patterns and region-dash exceptions.

**Requirements:** None — no external tools or MCP servers needed.

#### Configuration

The skill ships with a default config at `~/.claude/skills/tf-naming-check/tf-naming-check/tf-naming-config.md`.
To customise rules for a project, copy it to the project root:

```bash
cp ~/.claude/skills/tf-naming-check/tf-naming-check/tf-naming-config.md ./tf-naming-config.md
```

Then edit `tf-naming-config.md` to add, remove, or adjust rules. The project-level file takes precedence automatically.

## Installation

### 1. Add the marketplace

```
/plugin marketplace add https://codeberg.org/maxagahi/ccpm.git
```

### 2. Install a plugin

```
/plugin install code-review@maxagahi-marketplace
```

Or interactively: run `/plugin`, go to **Discover**, and select the plugin.

### 3. Use it

```
/code-review:review-local
```

## Development

### Pre-commit hooks

This repo uses [pre-commit](https://pre-commit.com/) to catch issues before they reach CI.

```bash
# Install pre-commit (once)
pip install pre-commit

# Set up the git hooks (once, from the repo root)
pre-commit install
```

After that, every `git commit` automatically runs:

| Hook                       | What it does                                                         |
| -------------------------- | -------------------------------------------------------------------- |
| `check-json`               | Validates JSON syntax                                                |
| `check-yaml`               | Validates YAML syntax                                                |
| `end-of-file-fixer`        | Ensures files end with a newline                                     |
| `trailing-whitespace`      | Strips trailing whitespace                                           |
| `mixed-line-ending`        | Enforces consistent line endings                                     |
| `prettier`                 | Auto-formats JSON, Markdown, and YAML                                |
| `validate-plugin-versions` | Fails if version is set in both `marketplace.json` and `plugin.json` |
| `update-plugin-count`      | Auto-updates the plugin count badge in this README                   |
| `update-plugin-versions`   | Auto-updates plugin version strings in this README                   |
| `check-skill-frontmatter`  | Validates YAML frontmatter in `SKILL.md` files                       |
| `check-changelog`          | Fails if a modified plugin has no CHANGELOG entry                    |

To run all hooks manually (without committing):

```bash
pre-commit run --all-files
```

To run a specific hook:

```bash
pre-commit run check-json --all-files
pre-commit run check-changelog --all-files
```

### Local plugin development

To develop plugins locally without reinstalling after every change, symlink the plugin into the local marketplace directory and sync to cache:

```bash
# Create the symlink (one-time setup)
ln -sfn /path/to/ccpm/plugins/code-review ~/.claude/plugins/local/local-code-review

# After making changes, sync to cache
rsync -avL --delete \
  ~/.claude/plugins/local/local-code-review/ \
  ~/.claude/plugins/cache/local-plugins/local-code-review/unknown/ \
  --exclude='.git' --exclude='LICENSE' --exclude='README.md'
```

Restart Claude Code after syncing to pick up changes.

## License

Apache-2.0
