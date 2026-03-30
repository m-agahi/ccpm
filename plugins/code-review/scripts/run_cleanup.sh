#!/usr/bin/env bash
# Cleans up ephemeral files left by review tools, test runners, and build systems.
# Usage: run_cleanup.sh <reviewed_dir> [repo_root]
# Does NOT delete: .local-review/review-*.md, .local-review/tickets/, source code, git-tracked files, lock files

set -euo pipefail

REVIEWED_DIR="${1:-.}"
REPO_ROOT="${2:-$(git rev-parse --show-toplevel 2>/dev/null || echo "$REVIEWED_DIR")}"

DIRS_REMOVED=0
FILES_REMOVED=0
BYTES_RECLAIMED=0

remove_dirs() {
  local base="$1"
  shift
  for pattern in "$@"; do
    while IFS= read -r -d '' dir; do
      [[ "$dir" == *"/secret-files/"* ]] && continue
      local size
      size=$(du -sb "$dir" 2>/dev/null | cut -f1) || size=0
      BYTES_RECLAIMED=$((BYTES_RECLAIMED + size))
      rm -rf "$dir"
      DIRS_REMOVED=$((DIRS_REMOVED + 1))
    done < <(find "$base" -type d -name "$pattern" -not -path '*/.git/*' -not -path '*/secret-files/*' -print0 2>/dev/null)
  done
}

remove_files() {
  local base="$1"
  shift
  for pattern in "$@"; do
    while IFS= read -r -d '' file; do
      [[ "$file" == *"/secret-files/"* ]] && continue
      local size
      size=$(stat -c%s "$file" 2>/dev/null) || size=0
      BYTES_RECLAIMED=$((BYTES_RECLAIMED + size))
      rm -f "$file"
      FILES_REMOVED=$((FILES_REMOVED + 1))
    done < <(find "$base" -type f -name "$pattern" -not -path '*/.git/*' -not -path '*/secret-files/*' -print0 2>/dev/null)
  done
}

# Detect languages present
detect_lang() { [[ -n $(find "$REVIEWED_DIR" -maxdepth 3 -name "$1" -print -quit 2>/dev/null) ]]; }

# Python
if detect_lang "*.py" || detect_lang "pyproject.toml" || detect_lang "requirements.txt"; then
  remove_dirs "$REVIEWED_DIR" __pycache__ .pytest_cache .hypothesis .mypy_cache .ruff_cache .tox .nox htmlcov "*.egg-info"
  remove_files "$REVIEWED_DIR" "*.pyc" "*.pyo" ".coverage" ".coverage.*" "coverage.xml" "coverage.json"
fi

# JavaScript / TypeScript
if detect_lang "package.json" || detect_lang "*.ts" || detect_lang "*.js"; then
  remove_dirs "$REVIEWED_DIR" .nyc_output .parcel-cache .turbo storybook-static .jscpd
  remove_files "$REVIEWED_DIR" ".eslintcache" "tsconfig.tsbuildinfo" "junit.xml"
  # .next/.cache only
  find "$REVIEWED_DIR" -type d -name ".cache" -path "*/.next/.cache" -not -path '*/secret-files/*' -exec rm -rf {} + 2>/dev/null || true
fi

# Java / Kotlin
if detect_lang "pom.xml" || detect_lang "build.gradle" || detect_lang "*.java"; then
  for subdir in "build/reports" "build/test-results" "target/surefire-reports" "target/site"; do
    while IFS= read -r -d '' d; do
      rm -rf "$d"
      DIRS_REMOVED=$((DIRS_REMOVED + 1))
    done < <(find "$REVIEWED_DIR" -type d -path "*/$subdir" -not -path '*/.git/*' -not -path '*/secret-files/*' -print0 2>/dev/null)
  done
  # .gradle in project root only
  [[ -d "$REVIEWED_DIR/.gradle" ]] && rm -rf "$REVIEWED_DIR/.gradle" && DIRS_REMOVED=$((DIRS_REMOVED + 1))
  remove_files "$REVIEWED_DIR" "hs_err_pid*.log"
  # *.class only inside build/ or target/
  find "$REVIEWED_DIR" \( -path "*/build/*.class" -o -path "*/target/*.class" \) -not -path '*/secret-files/*' -delete 2>/dev/null || true
fi

# Go
if detect_lang "go.mod"; then
  remove_files "$REVIEWED_DIR" "coverage.out" "coverage.html" "*.test"
fi

# Rust
if detect_lang "Cargo.toml"; then
  for subdir in "target/debug/incremental" "target/release/incremental"; do
    [[ -d "$REVIEWED_DIR/$subdir" ]] && rm -rf "$REVIEWED_DIR/$subdir" && DIRS_REMOVED=$((DIRS_REMOVED + 1))
  done
fi

# .NET / C#
if detect_lang "*.csproj" || detect_lang "*.sln"; then
  remove_dirs "$REVIEWED_DIR" obj TestResults
  while IFS= read -r -d '' d; do
    rm -rf "$d"
    DIRS_REMOVED=$((DIRS_REMOVED + 1))
  done < <(find "$REVIEWED_DIR" -type d \( -path "*/bin/Debug" -o -path "*/bin/Release" \) -not -path '*/secret-files/*' -print0 2>/dev/null)
  remove_files "$REVIEWED_DIR" "*.trx"
fi

# PHP
if detect_lang "composer.json" || detect_lang "*.php"; then
  remove_dirs "$REVIEWED_DIR" .phpunit.cache infection
  remove_files "$REVIEWED_DIR" ".phpcs-cache" ".php-cs-fixer.cache" ".phpunit.result.cache" "infection.log"
fi

# Fuzz test artifacts (created by fuzz-tester agent, not part of the project)
# Remove fuzz test .py files only if they were created by the review (untracked in git)
_in_git_repo=false
git -C "$REVIEWED_DIR" rev-parse --is-inside-work-tree &>/dev/null && _in_git_repo=true
while IFS= read -r -d '' fuzz_file; do
  if [[ "$_in_git_repo" == true ]]; then
    git ls-files --error-unmatch "$fuzz_file" &>/dev/null || {
      rm -f "$fuzz_file"
      FILES_REMOVED=$((FILES_REMOVED + 1))
    }
  else
    rm -f "$fuzz_file"
    FILES_REMOVED=$((FILES_REMOVED + 1))
  fi
done < <(find "$REVIEWED_DIR" -not -path '*/.git/*' -not -path '*/secret-files/*' \( -name "test_fuzz*.py" -o -name "fuzz_test*.py" -o -name "fuzz_tests.py" \) -print0 2>/dev/null)
# Remove .hypothesis dir (hypothesis fuzz state)
remove_dirs "$REVIEWED_DIR" .hypothesis

# Scanner artifacts (all languages)
remove_dirs "$REVIEWED_DIR" .scannerwork ".trivy-cache"
remove_files "$REVIEWED_DIR" "report-task.txt"
# sonar-project.properties only if untracked
if [[ -f "$REVIEWED_DIR/sonar-project.properties" ]]; then
  git ls-files --error-unmatch "$REVIEWED_DIR/sonar-project.properties" &>/dev/null || {
    rm -f "$REVIEWED_DIR/sonar-project.properties"
    FILES_REMOVED=$((FILES_REMOVED + 1))
  }
fi

# SonarQube containers + volumes (started by orchestrator — slug-based naming)
for sq in $(docker ps -a --format '{{.Names}}' 2>/dev/null | grep '^sonarqube-'); do
  echo "Removing SonarQube container + volumes: $sq"
  docker rm -fv "$sq" >/dev/null 2>&1
done

# Clean .local-review/ artifacts (keep review-*.md, tickets/, image-improvements.md, cost-manifest.json)
clean_local_review() {
  local dir="$1/.local-review"
  [[ -d "$dir" ]] || return 0
  # Remove JSON, SARIF, XML, log files (keep cost-manifest.json)
  for ext in json sarif xml log stderr.log; do
    find "$dir" -maxdepth 1 -name "*.$ext" ! -name 'cost-manifest.json' -delete 2>/dev/null || true
  done
  # Remove non-report .md files (keep review-*.md, image-improvements.md)
  find "$dir" -maxdepth 1 -name '*.md' ! -name 'review-*.md' ! -name 'image-improvements.md' -delete 2>/dev/null || true
  # Remove setup artifacts
  rm -rf "$dir/prompts" 2>/dev/null || true
  rm -f "$dir/manifest.json" "$dir/execution-plan.json" "$dir/results-status.json" 2>/dev/null || true
}

clean_local_review "$REVIEWED_DIR"
[[ "$REPO_ROOT" != "$REVIEWED_DIR" ]] && clean_local_review "$REPO_ROOT"

# Summary
MB_RECLAIMED=$(awk "BEGIN {printf \"%.1f\", $BYTES_RECLAIMED / 1048576}")
if [[ $DIRS_REMOVED -eq 0 && $FILES_REMOVED -eq 0 ]]; then
  echo "Nothing to clean — workspace is already tidy."
else
  echo "Cleaned:"
  echo "  - $DIRS_REMOVED directories removed"
  echo "  - $FILES_REMOVED files removed"
  echo "  - ~${MB_RECLAIMED} MB reclaimed"
fi

exit 0
