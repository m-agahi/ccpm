# Changelog

All notable changes to the local-code-review plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [3.6.3] - 2026-03-30

### Changed

- **Datetime prefix on ticket draft filenames**: Ticket drafts now use `YYMMDDHHMM-NNNN-slug.md`
  format (e.g., `2603301430-0001-division-by-zero.md`) instead of `NNNN-slug.md`. Timestamp is
  derived from the review report filename, preventing filename collisions across multiple runs.

## [3.6.2] - 2026-03-30

### Changed

- **Review path selection uses operational question**: The "What should I review?" prompt now uses
  the `AskUserQuestion` tool to present a clickable multi-choice UI instead of plain text.
- **Parallel agent timeout increased to 30 minutes**: Was 10 minutes. Agents that need to build
  dependencies (e.g., dependency-checker, type-checker) now have enough time to complete.

## [3.6.1] - 2026-03-30

### Fixed

- **Version detection in multi-plugin repos**: `find_version()` returned the marketplace-level
  version (`metadata.version`) instead of the plugin version from the `plugins[]` array. Now checks
  `plugins[]` first, matching by `name == "code-review"`.
- **Setup summary hidden by collapsed output**: Claude Code collapses long Bash output, hiding the
  version banner and registry info box. SKILL.md now re-displays version, languages, agent count,
  and registry status as regular text after setup completes.

## [3.6.0] - 2026-03-30

### Added

- **Private registry authentication**: New `~/.config/code-review/registries.yml` config file for
  mounting package manager credentials (Maven, npm, pip, Go, Gradle, Cargo, Composer, NuGet) into
  the review container. Works with any registry: Google Artifact Registry, AWS CodeArtifact, Nexus,
  Artifactory, GitHub Packages, etc. Example template at `registries.example.yml`.
- **Auto-create registries config**: On first run, the example config is automatically copied to
  `~/.config/code-review/registries.yml`. Users just uncomment the entries they need.
- **Registries info box**: Setup output now shows a cyan-bordered box with registry configuration
  status — active mounts, first-time setup instructions, or a reminder to configure.

### Changed

- **Version printed once**: Removed the duplicate version lookup from SKILL.md. Version is now only
  printed by `review-cli.py setup` (the `── local-code-review v{version} ──` banner).
- **Cleaner skill output**: Simplified the run-agents instruction message shown to users.

## [3.5.5] - 2026-03-28

### Fixed

- **Go tools use pre-built binaries**: Switch golangci-lint, staticcheck, shfmt, and actionlint from
  `go install` to pre-built binary downloads. Fixes arm64 build timeout under QEMU emulation.

### Added

- **Checkstyle in Docker image**: Pre-baked checkstyle v13.3.0 jar. Eliminates runtime download for
  Java style checking.
- **google-java-format in Docker image**: Pre-baked google-java-format v1.35.0 jar. Eliminates
  runtime download for Java formatting checks.

## [3.5.4] - 2026-03-28

### Fixed

- **Auto-pull Docker image from registry**: `check_image_exists()` now tries pulling the image from
  the registry before failing, instead of only checking locally and telling users to build. Error
  message updated to suggest `docker pull` first, with local build as fallback.

## [3.5.3] - 2026-03-28

### Fixed

- **NVD API key for faster builds**: Pass `NVD_API_KEY` as a Docker build arg so the
  dependency-check database download uses the API key instead of rate-limited anonymous access.
- **Build failures now fail the workflow**: The build-images script exits with non-zero if any
  image build or push fails.

## [3.5.2] - 2026-03-28

### Fixed

- **CI image build**: Fixed release workflow to use `node:22-bookworm` with Docker CLI for
  container image builds. Switched to `DOCKER_HOST` for host daemon access.
- **pip-audit pinned to 2.9.0**: Reverted from 2.10.0 due to `tomli` dependency conflict with
  semgrep (semgrep needs `tomli~=2.0.1`, pip-audit 2.10.0 needs `tomli>=2.2.1`).

## [3.5.0] - 2026-03-28

### Added

- **Pre-built Docker image from registry**: The container image is now published to
  `codeberg.org/maxagahi/ccpm/code-review` on every release. `container.sh` pulls from the registry
  automatically — no local build required. Falls back to `localhost/review-tools:latest` if the
  registry is unreachable.
- **CI image build**: The release workflow builds and pushes Docker images for any plugin that
  contains a Dockerfile.

### Changed

- **Prettier formatting**: Applied consistent formatting to plugin.json, agent specs, review-tools.yml,
  and SKILL.md. No functional changes.

### Updated

- **Binary tools**: Gitleaks 8.30.0→8.30.1, PMD 7.22.0→7.23.0, Zizmor 1.22.0→1.23.1,
  Terraform 1.13.4→1.14.8, golangci-lint v1.64.8→v2.11.4, shfmt v3.12.0→v3.13.0
- **Python packages**: semgrep 1.154.0→1.156.0, checkov 3.2.508→3.2.513, ruff 0.11.0→0.15.8,
  mypy 1.15.0→1.19.1, pip-audit 2.9.0→2.10.0, sqlfluff 3.3.1→4.1.0, yamllint 1.37.0→1.38.0,
  hypothesis 6.130.0→6.151.9, pytest 8.3.5→9.0.2, pytest-cov 6.1.1→7.1.0
- **Node packages**: pyright 1.1.400→1.1.408, eslint 9.22.0→10.1.0, prettier 3.5.3→3.8.1,
  typescript 5.8.2→6.0.2

## [3.4.0] - 2026-03-26

### Added

- **System build dependencies in image**: Added `build-essential`, `pkg-config`, `libssl-dev` to
  base image. Rust crates with native dependencies (openssl, reqwest) now compile without runtime installs.
- **GTK/WebKit dev libraries in image**: Added `libgtk-3-dev`, `libglib2.0-dev`,
  `libwebkit2gtk-4.1-dev` for Dioxus and other GTK-based Rust projects. `cargo check` works
  out of the box on GUI projects.
- **Simplified Ruby layer**: Removed redundant `build-essential` install/purge from Ruby gems step
  since it's now in the base system layer.

## [3.3.0] - 2026-03-26

### Added

- **Rust toolchain in review container**: Added rustup with stable toolchain, clippy, and rustfmt
  to the Docker image. Enables `cargo clippy`, `cargo check`, and `rustfmt --check` for Rust projects.
- **Rust support in type-checker agent**: Added `cargo check --workspace --all-targets` and
  `cargo clippy --workspace --all-targets` with key error categories (borrow checker, trait bounds,
  clippy correctness/perf/style).
- **Rust support in linter agent**: Added `cargo clippy` linting and `rustfmt --check` formatting
  checks with clippy lint category documentation.
- **Per-agent timeout for fuzz tester**: Fuzz agent gets 30 minutes (was 10) to handle overnight
  intensity (10k iterations) plus Rust compilation time. Other agents unchanged at 10 minutes.

## [3.2.2] - 2026-03-18

### Fixed

- **Cleanup runs before Jira tickets**: Swapped the order of CLEANUP and TICKETS steps in the skill
  workflow. The container is no longer needed after reading the report, so it gets torn down before
  the optional Jira ticket creation (which runs on the host, not in the container).

## [3.2.1] - 2026-03-18

### Fixed

- **SonarQube port conflicts**: Use a random free port instead of hardcoded 9876 when starting the
  SonarQube container. Prevents failures when previous containers still hold the port.
- **SonarQube container left running**: Auto-stop the SonarQube container at the end of `run-agents`
  instead of requiring manual `cleanup`. The container is only needed during the scan agent.

## [3.2.0] - 2026-03-18

### Changed

- **Command converted to Skill**: `commands/review-local.md` replaced by `skills/review-local/SKILL.md`
  for progressive disclosure and supporting-file support.
- **Agent allowed-tools expanded**: All 10 container agents now declare `["Bash", "Read", "Grep", "Glob"]`
  instead of only `["Bash"]`. Aligns with Claude Code plugin conventions.
- **Portable version lookup**: `review-cli.py` and the skill both use a `find_version()` helper that
  walks up to the `.git` boundary looking for `marketplace.json` or `.claude-plugin/marketplace.json`.
  Works in both single-plugin (Codeberg) and multi-plugin (Quinyx marketplace) repo layouts.

### Fixed

- **Docker scripts missing executable bit**: `docker/scripts/run_tooling_check.sh` and
  `docker/scripts/run_trivy_report.sh` now have `chmod +x`.

## [3.1.4] - 2026-03-15

### Added

- **tflint AWS plugin pre-baked into image**: `tflint --init` with the AWS ruleset (v0.35.0) runs at
  build time, caching the 70MB plugin. Saves ~10-15s per review on Terraform projects.

## [3.1.3] - 2026-03-15

### Added

- **OWASP NVD database pre-baked into image**: `dependency-check --updateonly` runs at build time,
  caching the ~500MB NVD database. Saves 3-5 minutes per review.

### Changed

- **dependency-checker uses `--noupdate`**: Agent prompt updated to always pass `--noupdate` flag.
  The DB is pre-baked — downloading updates at runtime caused the agent to time out at 10 minutes.

## [3.1.2] - 2026-03-15

### Fixed

- **Cleanup removes setup artifacts**: `prompts/`, `manifest.json`, `execution-plan.json`, and
  `results-status.json` are now removed during cleanup. Only reports, tickets, image-improvements,
  and cost-manifest persist.
- **SonarQube cleanup uses slug-based names**: `run_cleanup.sh` now finds all `sonarqube-*`
  containers instead of only the hardcoded `sonarqube-review` name.

## [3.1.1] - 2026-03-15

### Fixed

- **Duplicate reports**: Report-generator sometimes wrote two report files in a single run (revising
  its own work). Now the Python orchestrator generates a fixed timestamp and appends it to the
  report-generator prompt with strict instructions to use that exact filename.

## [3.1.0] - 2026-03-15

### Changed

- **`run-agents` is user-run, not plugin-run**: The command file no longer executes `run-agents` via
  the Bash tool. Instead it prints the command for the user to run in their terminal. This ensures
  live heartbeat output, Ctrl+C support, and no dropped output from background execution. The plugin
  waits for the user to confirm completion, then reads the report.

## [3.0.11] - 2026-03-15

### Changed

- **Watch-style heartbeat**: Replaces the old appending heartbeat with an in-place status table
  (like `watch`). Shows all agents in a fixed table with status icon, model, elapsed time `mm:ss`,
  cost, and findings indicator. Updates every 10s by overwriting previous output.

## [3.0.10] - 2026-03-15

### Fixed

- **Report shows real project path instead of `/workspace`**: The original host project path is now
  injected into every agent's context block. Report-generator uses it for the "Directory" field.

## [3.0.9] - 2026-03-15

### Added

- **Monorepo `.gitignore` support**: If the reviewed subdirectory has no `.gitignore`, `container.sh`
  copies the repo root's `.gitignore` into `/workspace/` after the workspace copy. Prevents false
  "missing .gitignore entries" findings when reviewing monorepo subdirectories.
- **Parallel heartbeat**: Every 30s during parallel phase, prints which agents are still running
  (with elapsed time) and which new findings appeared.

## [3.0.8] - 2026-03-14

### Added

- **Parallel agent timeout (10 min)**: Each parallel agent is killed after 600s. Prevents agents
  from spinning indefinitely on futile operations (e.g., repeated Maven compiles against private
  registries). Timed-out agents show `⏱ killed after Xs (timeout)` in output.

## [3.0.7] - 2026-03-14

### Fixed

- **Host Claude polling during run-agents**: Command file now explicitly says "Do NOT run this in
  the background" and "Do NOT poll for output, run ls, ps, cat". Prevents the host Claude from
  wasting time and money running exploratory commands while agents execute.
- **Agent budgets too high**: Reduced from flat $5/agent to per-model: opus=$3, sonnet=$2, haiku=$1.
  Sequential agents also reduced. Prevents agents from spending excessive time on futile operations
  (e.g., repeated Maven compiles against private registries).

## [3.0.6] - 2026-03-14

### Fixed

- **Cost always showed $0.00**: `_parse_claude_output` looked for `cost_usd` but `claude -p` outputs
  `total_cost_usd`. Fixed to use the correct field name.
- **Cleanup deleted cost-manifest.json**: `run_cleanup.sh` removed all JSON files from
  `.local-review/`. Now preserves `cost-manifest.json` alongside reports and tickets.

## [3.0.5] - 2026-03-14

### Changed

- **Scripts moved into Docker image**: `run_tooling_check.sh` and `run_trivy_report.sh` moved from
  `scripts/` (host) to `docker/scripts/` (baked into image at `/opt/review-scripts/`). They now run
  as direct bash scripts inside the container — no `docker exec` wrappers, no `cexec()` helper.
- **Python calls scripts via `docker exec`**: `run_tooling_check()` now does
  `docker exec cname bash /opt/review-scripts/run_tooling_check.sh`. Scripts in the execution plan
  use `container_cmd` instead of `host_cmd`.

### Removed

- `scripts/run_tooling_check.sh` and `scripts/run_trivy_report.sh` from host — replaced by
  container-native versions in `docker/scripts/`.

## [3.0.4] - 2026-03-14

### Changed

- **Cost section removed from report**: Report-generator no longer calculates or includes review
  costs. Cost summary is printed by the Python orchestrator at the end of `run-agents` using actual
  `claude -p` JSON output data.
- **All scripts write inside container**: `run_trivy_report.sh` and `run_tooling_check.sh` now write
  all output (findings, JSON, etc.) to `/tmp/review-work/` inside the container instead of directly
  to `.local-review/` on the host. No more junk files (trivy-fs.json, hadolint JSON, etc.) on host.
- **Trivy script container-native**: Dockerfile scanning, grep checks, and quality checks all run
  inside the container. Removed host-side Docker image build+scan (requires host Docker socket
  plumbing that doesn't fit v3 architecture).

## [3.0.3] - 2026-03-14

### Fixed

- **Intermediate data no longer copied to host**: Findings, scanner JSON, and runtime-installs.txt
  stay in `/tmp/review-work/` inside the container as designed. Only final outputs (report,
  improvements, tickets) are copied to `.local-review/` after sequential agents complete.
- **`_check_findings` probes inside container**: Was checking host `.local-review/` for findings
  files that now only exist in `/tmp/review-work/` inside the container.

## [3.0.2] - 2026-03-14

### Fixed

- **Sequential agent timeout**: Increased from 600s (10min) to 1800s (30min). The ticket-drafter
  was timing out on larger reports.

## [3.0.1] - 2026-03-14

### Fixed

- **Auth inside container**: `claude -p` requires `ANTHROPIC_API_KEY` env var, not a mounted
  `config.json`. Now extracts `primaryApiKey` from `~/.claude/config.json` and passes it as an env
  var to the container.
- **Root + `--dangerously-skip-permissions`**: Claude Code refuses this combination for security.
  Removed the flag — permissions are pre-configured in `/root/.claude/settings.json` baked into the
  Docker image.

## [3.0.0] - 2026-03-14

### Changed

- **Python-orchestrated agents inside container**: All LLM orchestration eliminated. Python runs
  `claude -p` CLI calls inside the container — one process per agent, managed via `subprocess.Popen`.
  No Agent tool, no Skill tool, no permission prompts, no improvisation.
- **Host command is trivial**: `review-local.md` asks 1 question, runs 3 scripts (`setup`,
  `run-agents`, `cleanup`). All complexity is in deterministic Python code.
- **In-container execution**: Agent specs updated to run commands directly (`cat`, `grep`, `find`,
  `semgrep scan`) instead of via `docker exec`. Findings written to `/tmp/review-work/` inside the
  container, then copied to host `.local-review/` by the Python orchestrator.
- **New execution plan format**: v3.0.0 plan has `parallel` and `sequential` arrays instead of
  `steps`. Each item specifies `type` (agent/script), `model`, `max_budget_usd`.
- **Context block rewritten**: No more `docker exec` instructions — agents told they run inside the
  container directly with prompt injection defense preserved.
- **SonarQube lifecycle managed by Python**: `_start_sonarqube()` handles container start, health
  check, and URL injection into the agent prompt. Agent just runs `sonar-scanner` directly.
- **Cost manifest from actual data**: `cost-manifest.json` now includes `total_cost_usd`,
  `duration_s`, and token `usage` from `claude -p` JSON output.
- **ticket-drafter model**: opus → sonnet (sufficient for ticket generation).
- **Concurrency limit**: Max 4 parallel `claude -p` processes to avoid memory pressure.

### Added

- `review-cli.py run-agents <dir>` — new command that runs all agents inside the container via
  `claude -p`, collects findings, writes cost manifest, and prints summary.
- Claude Code CLI (`@anthropic-ai/claude-code`) added to Docker image with pre-configured
  permissions.
- Auth passthrough in `container.sh`: `ANTHROPIC_API_KEY` env var and `~/.claude/.credentials.json`
  mount for OAuth.
- `/tmp/review-work/` directory created in container for intermediate agent data.

### Removed

- `agents/orchestrator.md` — no longer needed. Python handles all orchestration.
- LLM-based plan execution from `review-local.md` — replaced by `python3 run-agents`.
- `docker exec` commands from all 11 agent specs — agents run natively inside container.
- Orchestrator entry from cost manifest — there is no orchestrator agent.

## [2.4.0] - 2026-03-14

### Changed

- **Orchestrator eliminated**: The command file now reads `execution-plan.json` and launches agents
  directly, removing the orchestrator agent that consistently ignored its instructions and
  improvised instead of following the plan.
- **All agents mandatory**: Removed the optional agent selection question. All applicable agents
  run every time (`--agents all`). One less LLM decision point to go wrong.
- **Parallel reviews**: Container name is now `review-{project-slug}` (e.g. `review-forecast-settings`)
  instead of the hardcoded `review-tools`. Multiple reviews on different projects can run
  simultaneously. Name derived identically in container.sh, review-cli.py, and all scripts.
- **Language detection baked into image**: `detect_languages.sh` script is COPY'd into the Docker
  image at `/opt/review-scripts/` during build. Single `docker exec` call replaces 15+ individual
  `find` calls — much faster, zero host tools required.
- **Zero host tool dependencies**: All file operations (scc, find, glob) moved to container.
  The host only needs `docker` and `python3` (for the CLI script).
- **Version banner**: `── local-code-review v{version} ──` prints from the setup script and the
  command reads `marketplace.json` to display version before any work.

### Fixed

- **Removed stale SKILL.md**: `/local-code-review` was loading an old v1.0.0 skill file from
  `~/.claude/skills/` instead of the plugin command. Deleted the skill — use
  `/claude-code-review-plugin:review-local` for the correct v2 flow.
- **Setup timeout**: Command file requests 5-minute Bash timeout (was hitting 2-minute default).
- **checkmake module path**: Fixed `github.com/checkmake/checkmake` → `github.com/mrtazz/checkmake`
  in Dockerfile (upstream module rename).

## [2.0.0] - 2026-03-14

### Changed

- **Container-only agents**: All 11 review agents now operate exclusively inside the container via
  `docker exec`. Removed host tool dependencies (Read/Write/Glob/Grep) from agent allowed-tools.
  Agents use `docker exec review-tools cat/grep/find` for all file operations and write findings
  via heredoc into the container's `/workspace/.local-review/`.
- **JSON execution plan**: New `generate-prompts` command in review-cli.py composes agent prompts
  (agent spec + container-only context block) and writes `execution-plan.json`. The orchestrator
  reads this plan and executes steps mechanically — no more prompt composition or context injection
  by the LLM.
- **Simplified orchestrator**: Rewritten from ~150 lines of prose instructions to ~60 lines. Reads
  `execution-plan.json`, processes each step by type (parallel_agents, bash, agent). No manifest
  parsing, no context block construction, no agent spec reading.
- **Simplified permissions**: Replaced `Write(*)` with `Read(*)` — agents no longer write to host
  filesystem. Orchestrator needs Read only for pre-generated prompt files.

### Added

- `review-cli.py generate-prompts <dir>` — reads manifest + agent specs, writes composed prompts
  to `.local-review/prompts/*.txt` and execution plan to `.local-review/execution-plan.json`
- Container-only context block appended to every agent prompt with prompt injection defense

### Removed

- Host filesystem access from all review agents (Read, Write, Glob, Grep tools)
- Orchestrator's responsibility for prompt composition and context injection
- `Write(*)` permission requirement

## [1.0.0] - 2026-03-10

### Added

- Initial release
- Security scanning with Trivy (container, filesystem, and secret scanning)
- Static analysis via SonarQube
- Dependency auditing for npm, pip, Go, and Maven projects
- Automated report generation with findings summary
- All analysis runs locally inside a containerised review-tools image
