#!/usr/bin/env bash
# Runs Trivy + Hadolint scans and writes findings-trivy.md.
# Runs INSIDE the audit-lab-tools container (no docker exec).
# All intermediate files go to /tmp/review-work/.
# Usage: run_trivy_report.sh

set -euo pipefail

WORK="/tmp/review-work"
FINDINGS="${WORK}/findings-trivy.md"
mkdir -p "$WORK"

cd /workspace

# Check tool availability
HAVE_TRIVY=false
HAVE_HADOLINT=false
trivy version &>/dev/null && HAVE_TRIVY=true
hadolint --version &>/dev/null && HAVE_HADOLINT=true

if ! $HAVE_TRIVY; then
  cat > "$FINDINGS" << 'EOF'
## Trivy/Container Scan Results

**Trivy is not installed in the container.** Rebuild the image.

### Recommendations
- Rebuild the audit-lab-tools Docker image and re-run the scan.
EOF
  echo "Trivy not in container — skipping scan."
  exit 0
fi

# --- Filesystem vulnerability scan ---
echo "Running Trivy filesystem scan..."
trivy fs --severity HIGH,CRITICAL --format json --output ${WORK}/trivy-fs.json /workspace 2>/dev/null || true

# --- Parse filesystem results ---
FS_VULNS=""
if [[ -f "${WORK}/trivy-fs.json" ]]; then
  FS_VULNS=$(jq -r '
    [.Results[]? | select(.Vulnerabilities) | .Vulnerabilities[]? |
      select(.Severity == "HIGH" or .Severity == "CRITICAL") |
      "| \(.PkgName) | \(.InstalledVersion) | \(.VulnerabilityID) | \(.Severity) | \(.FixedVersion // "N/A") |"
    ] | join("\n")
  ' ${WORK}/trivy-fs.json 2>/dev/null) || FS_VULNS=""
fi

# --- Find and scan Dockerfiles ---
DOCKERFILES=$(find /workspace -maxdepth 3 -name "Dockerfile*" \
  -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/.local-review/*" 2>/dev/null) || DOCKERFILES=""

declare -a DOCKERFILE_SECTIONS=()

if [[ -n "$DOCKERFILES" ]]; then
  while IFS= read -r dockerfile; do
    [[ -z "$dockerfile" ]] && continue
    REL_PATH="${dockerfile#/workspace/}"
    SAFE_NAME=$(echo "$REL_PATH" | tr '/' '-' | tr '.' '-')

    # Detect Lambda images
    IS_LAMBDA=false
    grep -qE 'lambda/(python|nodejs|java|go|ruby|dotnet)|CMD.*lambda_function' "$dockerfile" 2>/dev/null && IS_LAMBDA=true

    # Trivy config scan
    echo "Scanning Dockerfile: $REL_PATH ..."
    trivy config --severity HIGH,CRITICAL --format json --output "${WORK}/trivy-dockerfile-${SAFE_NAME}.json" "$dockerfile" 2>/dev/null || true

    TRIVY_DF_FINDINGS=""
    local_filter=""
    if $IS_LAMBDA; then
      local_filter='select(.ID != "DS-0002" and .ID != "DS-0026" and .ID != "AVD-DS-0010") |'
    fi
    if [[ -f "${WORK}/trivy-dockerfile-${SAFE_NAME}.json" ]]; then
      TRIVY_DF_FINDINGS=$(jq -r "
        [.Results[]? | .Misconfigurations[]? |
          select(.Severity == \"HIGH\" or .Severity == \"CRITICAL\") |
          ${local_filter}
          \"- **\\(.Severity)** \\(.ID): \\(.Title) — \\(.Message)\"
        ] | join(\"\\n\")
      " "${WORK}/trivy-dockerfile-${SAFE_NAME}.json" 2>/dev/null) || TRIVY_DF_FINDINGS=""
    fi

    # Hadolint
    HADOLINT_FINDINGS=""
    if $HAVE_HADOLINT; then
      HADOLINT_RAW=$(hadolint --format json "$dockerfile" 2>/dev/null) || HADOLINT_RAW="[]"
      local_filter=""
      if $IS_LAMBDA; then
        local_filter='select(.code != "DL3002") |'
      fi
      echo "$HADOLINT_RAW" > "${WORK}/hadolint-${SAFE_NAME}.json"
      HADOLINT_FINDINGS=$(jq -r "
        [.[] | select(.level == \"error\" or .level == \"warning\") |
          ${local_filter}
          \"- **\\(.level | ascii_upcase)** \\(.code): \\(.message) (line \\(.line))\"
        ] | join(\"\\n\")
      " "${WORK}/hadolint-${SAFE_NAME}.json" 2>/dev/null) || HADOLINT_FINDINGS=""
    fi

    # Dockerfile quality checks
    QUALITY_NOTES=""
    if ! grep -qE '^FROM .+@sha256:' "$dockerfile" 2>/dev/null && ! $IS_LAMBDA; then
      QUALITY_NOTES+="- Base image not pinned to digest\n"
    fi
    FROM_COUNT=$(grep -c '^FROM ' "$dockerfile" 2>/dev/null) || FROM_COUNT=0
    if ! grep -qE '^FROM .+ AS ' "$dockerfile" 2>/dev/null && [[ $FROM_COUNT -le 1 ]]; then
      QUALITY_NOTES+="- No multi-stage build\n"
    fi
    if ! grep -qE '^USER ' "$dockerfile" 2>/dev/null && ! $IS_LAMBDA; then
      QUALITY_NOTES+="- Running as root (no USER directive)\n"
    fi
    if ! grep -qE '^HEALTHCHECK ' "$dockerfile" 2>/dev/null && ! $IS_LAMBDA; then
      QUALITY_NOTES+="- No HEALTHCHECK defined\n"
    fi
    if grep -qE 'COPY.*\.(env|key|pem|secret)' "$dockerfile" 2>/dev/null; then
      QUALITY_NOTES+="- Potential secret copied into image\n"
    fi

    # Build section
    SECTION="#### \`$REL_PATH\`"
    [[ $IS_LAMBDA == true ]] && SECTION+="\n*(AWS Lambda image — root/HEALTHCHECK/pinning rules suppressed)*"
    [[ -n "$TRIVY_DF_FINDINGS" ]] && SECTION+="\n\n**Trivy misconfigurations:**\n$TRIVY_DF_FINDINGS"
    [[ -n "$HADOLINT_FINDINGS" ]] && SECTION+="\n\n**Hadolint findings:**\n$HADOLINT_FINDINGS"
    [[ -n "$QUALITY_NOTES" ]] && SECTION+="\n\n**Quality checks:**\n$(echo -e "$QUALITY_NOTES")"
    if [[ -z "$TRIVY_DF_FINDINGS" && -z "$HADOLINT_FINDINGS" && -z "$QUALITY_NOTES" ]]; then
      SECTION+="\nNo issues found."
    fi

    DOCKERFILE_SECTIONS+=("$SECTION")

  done <<< "$DOCKERFILES"
fi

# --- Count totals ---
FS_COUNT=0
[[ -n "$FS_VULNS" ]] && FS_COUNT=$(echo "$FS_VULNS" | wc -l)

# --- Write findings ---
{
  echo "## Trivy/Container Scan Results"
  echo ""
  echo "### Filesystem Vulnerabilities"
  if [[ -n "$FS_VULNS" ]]; then
    echo "| Package | Version | Vulnerability | Severity | Fixed In |"
    echo "|---------|---------|--------------|----------|----------|"
    echo "$FS_VULNS"
  else
    echo "No HIGH/CRITICAL filesystem vulnerabilities found."
  fi

  if [[ ${#DOCKERFILE_SECTIONS[@]} -gt 0 ]]; then
    echo ""
    echo "### Dockerfile Issues"
    for section in "${DOCKERFILE_SECTIONS[@]}"; do
      echo ""
      echo -e "$section"
    done
  fi

  echo ""
  echo "### Summary"
  echo "- Filesystem vulnerabilities (HIGH/CRITICAL): $FS_COUNT"
  echo "- Dockerfiles scanned: ${#DOCKERFILE_SECTIONS[@]}"
  echo "- Hadolint: $($HAVE_HADOLINT && echo 'used' || echo 'not installed')"

  echo ""
  echo "### Recommendations"
  if [[ $FS_COUNT -gt 0 ]]; then
    echo "- Update vulnerable dependencies to fixed versions listed above"
  fi
  if [[ $FS_COUNT -eq 0 && ${#DOCKERFILE_SECTIONS[@]} -eq 0 ]]; then
    echo "- No issues found. Keep dependencies up to date."
  fi
} > "$FINDINGS"

echo "=== Trivy Scan Complete ==="
echo "Filesystem vulns: $FS_COUNT | Dockerfiles: ${#DOCKERFILE_SECTIONS[@]}"

exit 0
