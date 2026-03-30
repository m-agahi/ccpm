# ccpm — Claude Code Plugin Marketplace

![plugins](https://img.shields.io/badge/plugins-2-blue)

Personal plugin marketplace for [Claude Code](https://claude.ai/code).

## Plugins

### code-review (v3.7.2)

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

### update-jira (v1.0.0)

Post progress updates to Jira tickets based on session work, git activity, and PRs.

- **Targeted mode** — `/update-jira PROJ-123` — update a specific ticket from your session context
- **Scan mode** — `/update-jira` — batch-scan active tickets and recent PRs, correlate, and update

Auto-fixes PR titles (adds ticket prefix) and PR bodies (adds Jira link). Configurable per-project via memory file (Jira project, GitHub org, repos, email).

**Requirements:** Atlassian MCP server, GitHub MCP server.

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
