#!/usr/bin/env bash
# fetch_pr_detail.sh — per-PR detail + review-comment dumps (SKILL.md §5).
#
# For every PR in <tmp>/gh_merged.json (output of merge_gh.py), in parallel:
#   <tmp>/pr_detail/<owner>__<repo>__<n>.json
#       gh pr view <n> --repo <owner/repo> --json mergeCommit,mergedAt,additions,deletions,changedFiles
#   <tmp>/pr_reviews/<owner>__<repo>__<n>.json
#       gh api repos/<owner/repo>/pulls/<n>/comments --jq '[.[]|{user,body,created_at}]'
# Then fold the detail in with merge_pr_detail.py; build_chunks.py reads pr_reviews/.
#
# Usage:
#   fetch_pr_detail.sh [--tmp DIR] [-P N]      (default /tmp/ledger-sync, 8 jobs)
#
# GH_BIN overrides the gh command and may be several words. When GH_TOKEN is
# set but invalid (gh prefers it over the working keyring login), run:
#   GH_BIN="env -u GH_TOKEN gh" fetch_pr_detail.sh ...
#
# Prints a JSON summary; exits non-zero if any fetch failed or wrote nothing.
# Failed/empty outputs are deleted, so a re-run only needs the failed PRs.
set -uo pipefail

GH_BIN="${GH_BIN:-gh}"

if [ "${1:-}" = "--one" ]; then
  # worker: --one <tmp> <owner/repo> <number>
  tmp=$2 repo=$3 n=$4
  base="${repo//\//__}__${n}"
  rc=0
  fetch() { # kind outfile cmd...
    local kind=$1 out=$2
    shift 2
    # GH_BIN word-splitting is intentional (see header: "env -u GH_TOKEN gh").
    # shellcheck disable=SC2086
    if $GH_BIN "$@" >"$out.part" 2>"$out.err" && [ -s "$out.part" ]; then
      mv "$out.part" "$out"
      rm -f "$out.err"
      echo "OK $kind $repo#$n"
    else
      echo "FAIL $kind $repo#$n: $(head -c 200 "$out.err" | tr '\n' ' ')"
      rm -f "$out.part" "$out.err" "$out"
      rc=1
    fi
  }
  fetch detail "$tmp/pr_detail/$base.json" \
    pr view "$n" --repo "$repo" --json mergeCommit,mergedAt,additions,deletions,changedFiles
  fetch reviews "$tmp/pr_reviews/$base.json" \
    api "repos/$repo/pulls/$n/comments" \
    --jq '[.[]|{user:.user.login,body:.body,created_at:.created_at}]'
  exit $rc
fi

tmp=/tmp/ledger-sync
jobs=8
while [ $# -gt 0 ]; do
  case "$1" in
    --tmp) tmp=$2; shift 2 ;;
    -P) jobs=$2; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

merged="$tmp/gh_merged.json"
[ -f "$merged" ] || { echo "missing $merged (run merge_gh.py first)" >&2; exit 2; }
mkdir -p "$tmp/pr_detail" "$tmp/pr_reviews"

worklist=$(python3 -c '
import json, sys
for p in json.load(open(sys.argv[1])):
    r = (p.get("repository") or {}).get("nameWithOwner")
    if r and p.get("number") is not None:
        print(r, p["number"])
' "$merged") || exit 2

log=$(printf '%s\n' "$worklist" | grep -v '^$' \
  | xargs -r -P "$jobs" -L1 bash "$0" --one "$tmp")

printf '%s\n' "$log" | python3 -c '
import json, sys
lines = [l.rstrip("\n") for l in sys.stdin if l.strip()]
ok = [l.split(" ", 2) for l in lines if l.startswith("OK ")]
failed = sorted(l[5:] for l in lines if l.startswith("FAIL "))
prs = int(sys.argv[1])
print(json.dumps({
    "prs": prs,
    "detail_written": sum(1 for o in ok if o[1] == "detail"),
    "reviews_written": sum(1 for o in ok if o[1] == "reviews"),
    "failed": failed,
}, indent=1))
sys.exit(1 if failed else 0)
' "$(printf '%s\n' "$worklist" | grep -c .)"
