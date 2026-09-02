#!/usr/bin/env bash
# Detect languages in /workspace by checking for file extensions and special files.
# Outputs one language per line (canonical names matching review-tools.yml).
# Runs inside the container — called via: docker exec audit-lab-tools bash /workspace/.local-review/detect_languages.sh
# Or copied in and executed.

set -euo pipefail
cd /workspace

found=()

has_files() { find . -maxdepth 10 -name "$1" -not -path "*/node_modules/*" -not -path "*/.git/*" -print -quit 2>/dev/null | grep -q .; }

# Manifest files at root (fast, reliable)
[ -f pom.xml ] || [ -f build.gradle ] || [ -f build.gradle.kts ] && found+=(java)
[ -f package.json ]     && found+=(javascript)
[ -f go.mod ]           && found+=(go)
[ -f Cargo.toml ]       && found+=(rust)
[ -f composer.json ]    && found+=(php)
[ -f Gemfile ]          && found+=(ruby)
[ -f requirements.txt ] || [ -f pyproject.toml ] || [ -f setup.py ] && found+=(python)

# Source files (deep search for languages without manifest files)
has_files "*.py"         && found+=(python)
has_files "*.java"       && found+=(java)
has_files "*.kt"         && found+=(kotlin)
has_files "*.ts"         && found+=(typescript)
has_files "*.tsx"        && found+=(typescript)
has_files "*.js"         && found+=(javascript)
has_files "*.jsx"        && found+=(javascript)
has_files "*.go"         && found+=(go)
has_files "*.rs"         && found+=(rust)
has_files "*.php"        && found+=(php)
has_files "*.sh"         && found+=(shell)
has_files "*.sql"        && found+=(sql)
has_files "*.tf"         && found+=(hcl)
has_files "*.tfvars"     && found+=(hcl)
has_files "Makefile"     && found+=(makefile)
has_files "Dockerfile*"  && found+=(docker)
has_files "Chart.yaml"   && found+=(helm)

# GitHub Actions
if [ -d .github/workflows ] && find .github/workflows -maxdepth 1 \( -name "*.yml" -o -name "*.yaml" \) -print -quit 2>/dev/null | grep -q .; then
  found+=(github-actions)
fi

# Deduplicate and sort
printf '%s\n' "${found[@]}" | sort -u
