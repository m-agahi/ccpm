#!/usr/bin/env bash
# Checks all review tools and writes findings-tooling.md.
# Runs INSIDE the audit-lab-tools container (no docker exec).
# Usage: run_tooling_check.sh

set -euo pipefail

WORK="/tmp/review-work"
FINDINGS="${WORK}/findings-tooling.md"
mkdir -p "$WORK"

# --- Tool check functions ---

declare -a INSTALLED_ROWS=()
declare -a MISSING_ROWS=()
declare -a DB_UPDATES=()

check_tool() {
  local name="$1" cmd="$2" version_flag="${3:---version}" affected_agent="$4"

  local ver
  ver=$("$cmd" $version_flag 2>/dev/null | grep -v '^$' | head -1 | sed 's/\x1b\[[0-9;]*m//g') || ver=""

  if [[ -n "$ver" && "$ver" != *"not found"* && "$ver" != *"No such file"* ]]; then
    INSTALLED_ROWS+=("| $name | $ver | OK | container |")
  else
    MISSING_ROWS+=("| $name | rebuild image | See agent notes | $affected_agent |")
  fi
}

# --- Check all tools ---

# Core scanners
check_tool "trivy" "trivy" "version" "trivy-scanner"
check_tool "hadolint" "hadolint" "--version" "trivy-scanner"
check_tool "gitleaks" "gitleaks" "version" "security-reviewer"
check_tool "semgrep" "semgrep" "--version" "security-reviewer"
check_tool "checkov" "checkov" "--version" "security-reviewer"
check_tool "sonar-scanner" "sonar-scanner" "--version" "sonarqube-scanner"

# Dependency tools
check_tool "npm" "npm" "--version" "dependency-checker"
check_tool "pip-audit" "pip-audit" "--version" "dependency-checker"

# Type checkers
check_tool "mypy" "mypy" "--version" "type-checker"
check_tool "pyright" "pyright" "--version" "type-checker"
check_tool "staticcheck" "staticcheck" "--version" "type-checker"
check_tool "shellcheck" "shellcheck" "--version" "type-checker, linter"

# Linters/formatters
check_tool "ruff" "ruff" "--version" "linter"
check_tool "golangci-lint" "golangci-lint" "--version" "linter"
check_tool "pmd" "pmd" "--version" "linter"
check_tool "shfmt" "shfmt" "--version" "linter"
check_tool "sqlfluff" "sqlfluff" "version" "linter"
check_tool "jscpd" "jscpd" "--version" "linter"
check_tool "eslint" "eslint" "--version" "linter"

# GHA security
check_tool "zizmor" "zizmor" "--version" "gha-security"
check_tool "actionlint" "actionlint" "--version" "gha-security"

# Fuzz / test tools
check_tool "pytest" "pytest" "--version" "fuzz-tester"

# Claude Code CLI
check_tool "claude" "claude" "--version" "run-agents"

# --- Check vulnerability database freshness ---

DB_AGE=$(python3 -c "
import json, datetime, pathlib, sys
p = pathlib.Path('/root/.cache/trivy/db/metadata.json')
if not p.exists():
    print(999); sys.exit()
try:
    m = json.loads(p.read_text())
    updated = datetime.datetime.fromisoformat(m.get('UpdatedAt','').replace('Z','+00:00'))
    age = datetime.datetime.now(datetime.timezone.utc) - updated
    print(int(age.total_seconds() // 3600))
except: print(999)
" 2>/dev/null) || DB_AGE=999

if [[ $DB_AGE -gt 24 ]]; then
  DB_UPDATES+=("- Trivy CVE DB: ${DB_AGE}h old, updating...")
  if trivy image --download-db-only 2>&1 | tail -1 | grep -qi 'error\|fail'; then
    DB_UPDATES+=("- Trivy CVE DB: **update failed**")
  else
    DB_UPDATES+=("- Trivy CVE DB: updated successfully")
  fi
else
  DB_UPDATES+=("- Trivy CVE DB: ${DB_AGE}h old (fresh, skipping update)")
fi

DB_UPDATES+=("- Semgrep rules: pre-cached in image, auto-updated on scan")
DB_UPDATES+=("- Gitleaks rules: bundled with binary")

# --- Write findings ---

{
  echo "## Tooling Status"
  echo ""
  echo "### Installed Tools"
  echo "| Tool | Version | Status | Location |"
  echo "|------|---------|--------|----------|"
  for row in "${INSTALLED_ROWS[@]}"; do
    echo "$row"
  done
  echo ""

  if [[ ${#MISSING_ROWS[@]} -gt 0 ]]; then
    echo "### Missing Tools"
    echo "| Tool | Fix | What Was Skipped | Affected Agent |"
    echo "|------|-----|------------------|----------------|"
    for row in "${MISSING_ROWS[@]}"; do
      echo "$row"
    done
    echo ""
    echo "**To fix missing tools:** Rebuild the audit-lab-tools Docker image from the plugin's \`docker/\` directory."
    echo ""
  else
    echo "### Missing Tools"
    echo "All tools available — full coverage."
    echo ""
  fi

  echo "### Database Updates"
  for line in "${DB_UPDATES[@]}"; do
    echo "$line"
  done
} > "$FINDINGS"

# --- Console output ---

echo "=== Tooling Check Complete ==="
echo "Installed: ${#INSTALLED_ROWS[@]} tools"
echo "Missing: ${#MISSING_ROWS[@]} tools"
echo "Trivy DB age: ${DB_AGE}h"

exit 0
