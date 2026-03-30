#!/usr/bin/env bash
# Container lifecycle manager for the review-tools sidecar.
# Usage: container.sh <start|stop|exec|status> [args...]
#
# start <project_dir>  — start container with project mounted at /workspace
# stop                  — stop and remove container
# exec <command...>     — run a command inside the container
# status                — check if container is running

set -euo pipefail

REGISTRY_IMAGE="codeberg.org/maxagahi/ccpm/code-review:latest"
LOCAL_IMAGE="localhost/review-tools:latest"
IMAGE_NAME=""
SOURCE_MOUNT="/workspace-src"
WORKSPACE="/workspace"

_resolve_image() {
  # Use registry image if available, otherwise fall back to local
  if docker image inspect "$REGISTRY_IMAGE" >/dev/null 2>&1; then
    IMAGE_NAME="$REGISTRY_IMAGE"
  elif docker pull "$REGISTRY_IMAGE" >/dev/null 2>&1; then
    IMAGE_NAME="$REGISTRY_IMAGE"
  elif docker image inspect "$LOCAL_IMAGE" >/dev/null 2>&1; then
    IMAGE_NAME="$LOCAL_IMAGE"
  else
    echo "Pulling image from registry..."
    if docker pull "$REGISTRY_IMAGE" 2>/dev/null; then
      IMAGE_NAME="$REGISTRY_IMAGE"
    else
      echo "ERROR: No image available. Either pull from registry or build locally:" >&2
      PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
      echo "  docker pull $REGISTRY_IMAGE" >&2
      echo "  docker build -t $LOCAL_IMAGE $PLUGIN_ROOT/docker/" >&2
      return 1
    fi
  fi
  echo "Using image: $IMAGE_NAME"
}

_container_name() {
  # Derive unique container name from project directory
  local dir="${1:-.}"
  local slug
  slug="$(basename "$dir" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g')"
  echo "review-${slug}"
}

cmd_start() {
  local project_dir="${1:-.}"
  project_dir="$(cd "$project_dir" 2>/dev/null && pwd)" || {
    echo "ERROR: Invalid project directory: $1" >&2
    return 1
  }
  CONTAINER_NAME="$(_container_name "$project_dir")"

  # Already running?
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER_NAME}$"; then
    # Check if the same project is mounted at the read-only source mount (/workspace-src)
    local current_mount
    current_mount=$(docker inspect "$CONTAINER_NAME" --format '{{range .Mounts}}{{if eq .Destination "/workspace-src"}}{{.Source}}{{end}}{{end}}' 2>/dev/null) || current_mount=""
    if [[ "$current_mount" == "$project_dir" ]]; then
      echo "Container '$CONTAINER_NAME' already running with $project_dir mounted."
      return 0
    else
      echo "Container running with different project ($current_mount). Restarting..."
      cmd_stop
    fi
  fi

  # Exists but stopped?
  if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER_NAME}$"; then
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1
  fi

  # Resolve image (registry or local)
  _resolve_image || return 1

  echo "Starting review-tools container..."
  # Ensure Podman socket is running (idempotent, user-level only)
  if command -v podman &>/dev/null && ! [[ -S "/run/user/$(id -u)/podman/podman.sock" ]]; then
    systemctl --user start podman.socket 2>/dev/null || true
  fi

  # Mount Podman/Docker socket if available (needed for Trivy image scanning).
  # Use an array so the optional mount args are never word-split or glob-expanded.
  local extra_args=()
  local podman_sock="/run/user/$(id -u)/podman/podman.sock"
  if [[ -S "$podman_sock" ]]; then
    extra_args+=(-v "${podman_sock}:/var/run/docker.sock")
  elif [[ -S /var/run/docker.sock ]]; then
    extra_args+=(-v "/var/run/docker.sock:/var/run/docker.sock")
  else
    echo "WARNING: No Docker/Podman socket found. Trivy image scanning will be unavailable." >&2
  fi

  # Ensure .local-review/ exists on host before mounting
  mkdir -p "${project_dir}/.local-review"

  # Claude Code auth for claude -p inside container.
  # Priority: ANTHROPIC_API_KEY env var > extract from ~/.claude/config.json
  local api_key="${ANTHROPIC_API_KEY:-}"
  if [[ -z "$api_key" ]]; then
    local claude_config="${HOME}/.claude/config.json"
    if [[ -f "$claude_config" ]]; then
      api_key=$(python3 -c "import json; print(json.load(open('$claude_config')).get('primaryApiKey',''))" 2>/dev/null) || api_key=""
    fi
  fi
  if [[ -n "$api_key" ]]; then
    extra_args+=(-e "ANTHROPIC_API_KEY=${api_key}")
  else
    echo "WARNING: No API key found. Set ANTHROPIC_API_KEY or configure ~/.claude/config.json." >&2
    echo "         claude -p agents inside the container will fail." >&2
  fi

  # Mount private registry configs (Maven, npm, pip, etc.) from user config.
  local registries_yml="${HOME}/.config/code-review/registries.yml"
  if [[ -f "$registries_yml" ]]; then
    # Parse mounts and env from YAML using python3 (already a dependency)
    local _parsed
    _parsed=$(python3 -c "
import yaml, os, sys
with open('$registries_yml') as f:
    cfg = yaml.safe_load(f) or {}
for m in cfg.get('mounts') or []:
    src = os.path.expanduser(m.get('source', ''))
    tgt = m.get('target', '')
    if src and tgt and os.path.exists(src):
        print(f'MOUNT:{src}:{tgt}')
for e in cfg.get('env') or []:
    if '=' in str(e):
        print(f'ENV:{e}')
" 2>/dev/null) || _parsed=""
    while IFS= read -r line; do
      case "$line" in
        MOUNT:*) extra_args+=(-v "${line#MOUNT:}:ro") ;;
        ENV:*)   extra_args+=(-e "${line#ENV:}") ;;
      esac
    done <<< "$_parsed"
  fi

  docker run -d \
    --name "$CONTAINER_NAME" \
    --cpus="$(nproc)" \
    --memory="$(awk '/MemTotal/{mem=$2/1048576; limit=int(mem*0.5); if(limit<4) limit=4; if(limit>8) limit=8; printf "%dg", limit}' /proc/meminfo)" \
    --memory-swap="$(awk '/MemTotal/{mem=$2/1048576; limit=int(mem*0.5); if(limit<4) limit=4; if(limit>8) limit=8; printf "%dg", limit*2}' /proc/meminfo)" \
    -v "${project_dir}:${SOURCE_MOUNT}:ro" \
    -v "${project_dir}/.local-review:${WORKSPACE}/.local-review" \
    "${extra_args[@]}" \
    --network host \
    "$IMAGE_NAME" >/dev/null

  # Wait for container to be ready
  local tries=0
  while ! docker exec "$CONTAINER_NAME" true 2>/dev/null; do
    tries=$((tries + 1))
    if [[ $tries -ge 10 ]]; then
      echo "ERROR: Container failed to start" >&2
      docker logs "$CONTAINER_NAME" 2>&1 | tail -5
      return 1
    fi
    sleep 0.5
  done

  # Copy source to a writable workspace so scanners don't pollute the host.
  # .local-review/ is excluded because it is already a separate writable bind
  # mount shared between host and container.
  # Large build-artifact and dependency directories are excluded to keep the
  # copy fast and avoid filling the overlay filesystem.
  docker exec "$CONTAINER_NAME" sh -c "
    cd ${SOURCE_MOUNT}
    find . -mindepth 1 -maxdepth 1 \
      ! -name .local-review \
      ! -name .git \
      ! -name node_modules \
      ! -name target \
      ! -name build \
      ! -name vendor \
      ! -name .gradle \
      ! -name dist \
      ! -name __pycache__ \
      -exec cp -a {} ${WORKSPACE}/ \;
  " >/dev/null

  # If no .gitignore in workspace, copy from repo root (monorepo support)
  docker exec "$CONTAINER_NAME" test -f /workspace/.gitignore 2>/dev/null || {
    local repo_root
    repo_root=$(git -C "$project_dir" rev-parse --show-toplevel 2>/dev/null) || repo_root=""
    if [[ -n "$repo_root" && -f "$repo_root/.gitignore" ]]; then
      docker cp "$repo_root/.gitignore" "$CONTAINER_NAME:/workspace/.gitignore" >/dev/null
    fi
  }

  # Create work directory for agent prompts and intermediate findings
  docker exec "$CONTAINER_NAME" mkdir -p /tmp/review-work/prompts /tmp/review-work/tickets

  echo "Container '$CONTAINER_NAME' running. Project mounted at $WORKSPACE"
}

cmd_stop() {
  local project_dir="${1:-.}"
  project_dir="$(cd "$project_dir" 2>/dev/null && pwd)" || project_dir="$1"
  CONTAINER_NAME="$(_container_name "$project_dir")"
  if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER_NAME}$"; then
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1
    echo "Container '$CONTAINER_NAME' stopped and removed."
  else
    echo "Container '$CONTAINER_NAME' is not running."
  fi
}

cmd_exec() {
  local project_dir="${1:-.}"
  project_dir="$(cd "$project_dir" 2>/dev/null && pwd)" || project_dir="$1"
  CONTAINER_NAME="$(_container_name "$project_dir")"
  shift
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER_NAME}$"; then
    echo "ERROR: Container '$CONTAINER_NAME' is not running. Start it first." >&2
    return 1
  fi
  docker exec -w "$WORKSPACE" "$CONTAINER_NAME" "$@"
}

cmd_status() {
  local project_dir="${1:-.}"
  project_dir="$(cd "$project_dir" 2>/dev/null && pwd)" || project_dir="$1"
  CONTAINER_NAME="$(_container_name "$project_dir")"
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER_NAME}$"; then
    local mount
    mount=$(docker inspect "$CONTAINER_NAME" --format '{{range .Mounts}}{{if eq .Destination "/workspace-src"}}{{.Source}}{{end}}{{end}}' 2>/dev/null) || mount="unknown"
    echo "RUNNING — project: $mount"
    return 0
  elif docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER_NAME}$"; then
    echo "STOPPED"
    return 1
  else
    echo "NOT FOUND"
    return 1
  fi
}

case "${1:-help}" in
  start)  shift; cmd_start "$@" ;;
  stop)   shift; cmd_stop "$@" ;;
  exec)   shift; cmd_exec "$@" ;;
  status) shift; cmd_status "$@" ;;
  *)
    echo "Usage: container.sh <command> <project_dir> [args...]"
    echo "  start <project_dir>   — start container with project mounted"
    echo "  stop <project_dir>    — stop and remove container"
    echo "  exec <project_dir> <cmd...> — run command in container"
    echo "  status <project_dir>  — check container state"
    exit 1
    ;;
esac
