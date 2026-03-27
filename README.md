# ccpm — Claude Code Plugin Marketplace

Personal plugin marketplace for [Claude Code](https://claude.ai/code).

## Plugins

### code-review (v3.4.0)

Comprehensive local code review with 12 specialized agents. All analysis runs locally inside a Docker container — nothing is pushed to remote.

**Agents included:**

| Agent | Model | What it does |
|-------|-------|--------------|
| code-quality-reviewer | opus | Bugs, design patterns, performance, maintainability |
| security-reviewer | opus | OWASP Top 10, injection, Semgrep, Gitleaks |
| dependency-checker | sonnet | CVEs, outdated versions, license compliance |
| sonarqube-scanner | sonnet | Full SonarQube static analysis |
| trivy-scanner | script | Container & filesystem vulnerabilities, Hadolint |
| fuzz-tester | sonnet | Property-based testing (Hypothesis, fast-check, etc.) |
| type-checker | haiku | tsc, mypy, pyright, staticcheck, ShellCheck, sqlfluff |
| linter | haiku | ESLint, ruff, golangci-lint, PMD, phpcs, clippy |
| gha-security | sonnet | GitHub Actions workflow security (zizmor, actionlint) |
| report-generator | sonnet | Deduplicates and compiles all findings |
| improvement-advisor | haiku | Suggests Docker image and tooling improvements |
| jira-ticket-creator | sonnet | Creates Jira tickets from findings (optional) |

**Languages supported:** Python, Java, Kotlin, JavaScript, TypeScript, Go, Rust, PHP, Ruby, Shell, SQL, Terraform/HCL, Docker, Helm, Makefiles, GitHub Actions.

**Requirements:** Docker, Claude Code CLI.

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

## Local development

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
