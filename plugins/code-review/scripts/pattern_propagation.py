#!/usr/bin/env python3
"""
Pattern propagation for code-review v4.0.0.

For each finding with a non-null grep_pattern, runs ripgrep across the project
to find additional occurrences of the same antipattern, then uses sonnet to
triage each hit (same_issue / unrelated / unsure).

Usage:
    python3 pattern_propagation.py /path/to/.local-review/runs/<run_id>/

project_root is derived as run_dir.parent.parent.parent
(.local-review/runs/<run_id>/ → .local-review/runs/ → .local-review/ → project_root)
"""

import json
import subprocess
import sys
from pathlib import Path


MAX_HITS = 100          # drop pattern if rg returns more than this many hits
MAX_MATCHES = 20        # cap same_issue matches per finding
SNIPPET_MAX = 200       # max chars per snippet
CLAUDE_TIMEOUT = 180    # seconds for claude -p call


def _parse_rg_output(stdout: str) -> list[dict]:
    """Parse ripgrep --no-heading -n output into hit records."""
    hits = []
    for raw_line in stdout.splitlines():
        raw_line = raw_line.rstrip()
        if not raw_line:
            continue
        # Format: filepath:linenum:content  (rg with -n --no-heading --color=never)
        # File paths may contain colons on weird systems, but line numbers are numeric.
        # Split on first colon, then second colon.
        parts = raw_line.split(":", 2)
        if len(parts) < 3:
            continue
        file_path, lineno_str, snippet = parts[0], parts[1], parts[2]
        if not lineno_str.isdigit():
            continue
        hits.append(
            {
                "file": file_path,
                "line": int(lineno_str),
                "snippet": snippet[:SNIPPET_MAX],
            }
        )
    return hits


def _triage_hits(finding: dict, hits: list[dict]) -> list[dict]:
    """Call sonnet to classify hits as same_issue / unrelated / unsure.

    Returns hits classified as same_issue only.
    """
    title = finding.get("title", "")
    category = finding.get("category", "")
    description = finding.get("description", "")
    grep_pattern = finding.get("grep_pattern", "")
    hits_json = json.dumps(hits, indent=2)

    # Build prompt without .format() to avoid KeyError from {} in JSON
    prompt = (
        "Below is a code-review finding and a list of additional code locations"
        " matching the same regex pattern.\n"
        "For each location, classify whether it represents the same issue as the"
        " original finding.\n\n"
        "ORIGINAL FINDING:\n"
        "Title: " + title + "\n"
        "Category: " + category + "\n"
        "Description: " + description + "\n"
        "Pattern: " + grep_pattern + "\n\n"
        "LOCATIONS TO CLASSIFY:\n"
        + hits_json + "\n\n"
        "Return ONLY a JSON array of objects:"
        ' [{"index": 0, "classification": "same_issue" | "unrelated" | "unsure"}, ...]\n'
        "No prose, no markdown, just the JSON array."
    )

    try:
        result = subprocess.run(
            ["claude", "-p", "--model", "sonnet", prompt],
            capture_output=True,
            text=True,
            timeout=CLAUDE_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        print(
            f"WARNING: claude triage timed out for finding '{title}'",
            file=sys.stderr,
        )
        return []
    except FileNotFoundError:
        print(
            "WARNING: 'claude' not found on PATH — skipping triage",
            file=sys.stderr,
        )
        return []

    if result.returncode != 0:
        print(
            f"WARNING: claude returned non-zero ({result.returncode}) for"
            f" finding '{title}': {result.stderr[:200]}",
            file=sys.stderr,
        )
        return []

    stdout = result.stdout.strip()
    # Robustly extract the JSON array: find first '[' and last ']'
    start = stdout.find("[")
    end = stdout.rfind("]")
    if start == -1 or end == -1 or end <= start:
        print(
            f"WARNING: claude returned malformed output for finding '{title}':"
            f" {stdout[:200]}",
            file=sys.stderr,
        )
        return []

    json_str = stdout[start : end + 1]
    try:
        classifications = json.loads(json_str)
    except json.JSONDecodeError as exc:
        print(
            f"WARNING: JSON parse error in triage output for finding '{title}':"
            f" {exc}",
            file=sys.stderr,
        )
        return []

    same_issue_hits = []
    for item in classifications:
        if not isinstance(item, dict):
            continue
        idx = item.get("index")
        classification = item.get("classification", "")
        if classification == "same_issue" and isinstance(idx, int) and 0 <= idx < len(hits):
            same_issue_hits.append(hits[idx])

    return same_issue_hits


def _existing_locations(finding: dict) -> set[str]:
    """Return a set of 'file:line' strings from the finding's locations list."""
    locations = finding.get("locations") or []
    result = set()
    for loc in locations:
        if isinstance(loc, dict):
            f = loc.get("file", "")
            ln = loc.get("line", "")
            if f and ln != "":
                result.add(f"{f}:{ln}")
    return result


def run_pattern_propagation(run_dir: Path) -> None:
    """Main entry point: propagate patterns for all findings in run_dir."""
    findings_path = run_dir / "findings.json"
    if not findings_path.exists():
        print(
            f"ERROR: findings.json not found at {findings_path}",
            file=sys.stderr,
        )
        sys.exit(1)

    try:
        data = json.loads(findings_path.read_text())
    except (json.JSONDecodeError, OSError) as exc:
        print(f"ERROR: Cannot parse findings.json: {exc}", file=sys.stderr)
        sys.exit(1)

    findings = data.get("findings", [])
    if not isinstance(findings, list):
        print("ERROR: findings.json has no 'findings' list", file=sys.stderr)
        sys.exit(1)

    # project_root = runs/<id>/ → runs/ → .local-review/ → project/
    project_root = run_dir.parent.parent.parent

    review_md_path = run_dir / "review.md"

    total_with_pattern = 0
    total_with_matches = 0
    total_locations = 0
    propagation_results: list[dict] = []  # for appending to review.md

    for finding in findings:
        if not isinstance(finding, dict):
            continue
        grep_pattern = finding.get("grep_pattern")
        if not grep_pattern:
            continue

        total_with_pattern += 1
        finding_id = finding.get("id", "?")
        title = finding.get("title", "?")

        try:
            rg_result = subprocess.run(
                [
                    "rg",
                    "--pcre2",
                    "-n",
                    "--no-heading",
                    "--color=never",
                    grep_pattern,
                    str(project_root),
                ],
                capture_output=True,
                text=True,
                timeout=30,
            )
        except subprocess.TimeoutExpired:
            print(
                f"WARNING: rg timed out for finding '{title}' (pattern: {grep_pattern!r})",
                file=sys.stderr,
            )
            continue
        except FileNotFoundError:
            print("WARNING: 'rg' not found on PATH — skipping pattern propagation", file=sys.stderr)
            return
        except Exception as exc:  # noqa: BLE001
            print(
                f"WARNING: rg failed for finding '{title}': {exc}",
                file=sys.stderr,
            )
            continue

        # rg exit code 1 = no matches (not an error), 2 = real error
        if rg_result.returncode == 2:
            print(
                f"WARNING: rg reported an error for finding '{title}'"
                f" (pattern: {grep_pattern!r}): {rg_result.stderr[:200]}",
                file=sys.stderr,
            )
            continue

        hits = _parse_rg_output(rg_result.stdout)

        if len(hits) > MAX_HITS:
            print(
                f"WARNING: pattern for finding '{title}' yielded {len(hits)} hits"
                f" (>{MAX_HITS}) — dropping as too broad",
                file=sys.stderr,
            )
            finding["grep_pattern_dropped"] = True
            continue

        if not hits:
            continue

        # Filter out hits that duplicate an existing location on this finding
        existing = _existing_locations(finding)
        hits = [h for h in hits if f"{h['file']}:{h['line']}" not in existing]

        if not hits:
            continue

        # Triage via sonnet
        same_issue_hits = _triage_hits(finding, hits)

        if not same_issue_hits:
            continue

        # Sort by file + line, cap at MAX_MATCHES
        same_issue_hits.sort(key=lambda h: (h["file"], h["line"]))
        same_issue_hits = same_issue_hits[:MAX_MATCHES]

        # Inherit confidence from parent finding, downgraded one tier
        parent_confidence = finding.get("confidence", "heuristic")
        _CONFIDENCE_TIERS = ["speculative", "heuristic", "confirmed"]
        try:
            tier_idx = _CONFIDENCE_TIERS.index(parent_confidence)
        except ValueError:
            tier_idx = 1  # default: heuristic
        match_confidence = _CONFIDENCE_TIERS[max(0, tier_idx - 1)]

        for hit in same_issue_hits:
            hit["confidence"] = match_confidence
            hit["verification_steps"] = [f"compare to parent finding {finding_id}"]

        finding["pattern_matches"] = same_issue_hits
        total_with_matches += 1
        total_locations += len(same_issue_hits)

        propagation_results.append(
            {
                "id": finding_id,
                "title": title,
                "matches": same_issue_hits,
            }
        )

    # Rewrite findings.json in place
    findings_path.write_text(json.dumps(data, indent=2) + "\n")

    # Append propagation section to review.md
    if propagation_results and review_md_path.exists():
        lines = ["\n\n## Pattern Propagation Results (v4)\n"]
        for entry in propagation_results:
            fid = entry["id"]
            ftitle = entry["title"]
            matches = entry["matches"]
            locations_str = ", ".join(f"{m['file']}:{m['line']}" for m in matches)
            lines.append(f"\n**{fid} — {ftitle}**\n")
            lines.append(f"Also at: {locations_str}\n")
        with review_md_path.open("a") as fh:
            fh.writelines(lines)

    print(
        f"Pattern propagation: {total_with_pattern} findings had patterns,"
        f" {total_with_matches} had triaged matches,"
        f" {total_locations} total additional locations appended."
    )


def main() -> None:
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <run_dir>", file=sys.stderr)
        sys.exit(1)

    run_dir = Path(sys.argv[1]).resolve()
    if not run_dir.is_dir():
        print(f"ERROR: run_dir does not exist or is not a directory: {run_dir}", file=sys.stderr)
        sys.exit(1)

    run_pattern_propagation(run_dir)


if __name__ == "__main__":
    main()
