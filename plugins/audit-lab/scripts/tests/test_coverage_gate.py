"""Tests for the test-case-suggester coverage gate in review-cli.py.

Regression cover for the bug where `test-case-suggester` was skipped as a
routine no-op while findings.json held the exact finding the agent exists to
act on (`category: "quality"`, `subcategory: "missing-tests"`).
"""

import importlib.util
import json
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "review-cli.py"


def _load_review_cli():
    """Import review-cli.py under a module name (the filename is not importable)."""
    spec = importlib.util.spec_from_file_location("review_cli_for_coverage_gate", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


review_cli = _load_review_cli()


# The finding observed in run 20260902-063840. The gate must run on this.
H3_FINDING = {
    "id": "H-3",
    "category": "quality",
    "subcategory": "missing-tests",
    "severity": "high",
    "risk": "info",
    "title": (
        "No tests for any TaskService RPC handler — service.rs "
        "(421 lines, 6 handlers, passthrough) entirely uncovered"
    ),
}


def _doc(*findings):
    return {
        "schema_version": "1.1",
        "run_id": "20260902-063840",
        "generated_at": "2026-09-02T06:38:40Z",
        "findings": list(findings),
    }


# ─── normalisation ────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("missing-tests", "missingtests"),
        ("missing_tests", "missingtests"),
        ("Missing Tests", "missingtests"),
        ("MISSING-TESTS", "missingtests"),
        (None, ""),
        ("", ""),
    ],
)
def test_normalise_folds_case_and_separators(raw, expected):
    assert review_cli._normalise_schema_token(raw) == expected


# ─── the gate runs on coverage-shaped findings ────────────────────────────────


def test_h3_spec_finding_runs_the_agent():
    gate = review_cli.evaluate_coverage_gate(_doc(H3_FINDING))
    assert gate["should_run"] is True
    assert gate["matched_ids"] == ["H-3"]


@pytest.mark.parametrize(
    "subcategory",
    ["missing-tests", "missing_tests", "missing-test", "untested-module", "no-tests"],
)
def test_subcategory_variants_run_the_agent(subcategory):
    finding = dict(H3_FINDING, subcategory=subcategory)
    gate = review_cli.evaluate_coverage_gate(_doc(finding))
    assert gate["should_run"] is True, f"{subcategory} must trigger the gate"


def test_category_coverage_runs_the_agent_without_drift():
    finding = dict(H3_FINDING, category="coverage", subcategory="untested-module")
    gate = review_cli.evaluate_coverage_gate(_doc(finding))
    assert gate["should_run"] is True
    assert gate["schema_drift"] is False
    assert gate["strict_ids"] == ["H-3"]


def test_test_coverage_subcategory_runs_the_agent():
    finding = dict(H3_FINDING, subcategory="test-coverage")
    assert review_cli.evaluate_coverage_gate(_doc(finding))["should_run"] is True


# ─── schema drift is surfaced, not swallowed ──────────────────────────────────


def test_h3_is_reported_as_schema_drift():
    gate = review_cli.evaluate_coverage_gate(_doc(H3_FINDING))
    assert gate["schema_drift"] is True
    assert gate["strict_ids"] == []
    assert "coverage" in gate["reason"]
    assert gate["error"] is False


# ─── the gate still skips when nothing is test-shaped ─────────────────────────


def test_unrelated_findings_skip_the_agent():
    doc = _doc(
        {"id": "C-1", "category": "security", "subcategory": "xss-stored"},
        {"id": "M-2", "category": "dependencies", "subcategory": "outdated-package"},
        {"id": "L-3", "category": "lint", "subcategory": "unused-import"},
    )
    gate = review_cli.evaluate_coverage_gate(doc)
    assert gate["should_run"] is False
    assert gate["schema_drift"] is False
    assert gate["error"] is False
    assert gate["reason"] == "no coverage findings in findings.json"


def test_title_alone_does_not_trigger_the_gate():
    """Prose matching produces false positives; only category/subcategory count."""
    finding = {
        "id": "M-9",
        "category": "security",
        "subcategory": "xss-stored",
        "title": "No tests were needed to confirm this untested theory",
    }
    assert review_cli.evaluate_coverage_gate(_doc(finding))["should_run"] is False


def test_empty_findings_skip_the_agent():
    gate = review_cli.evaluate_coverage_gate(_doc())
    assert gate["should_run"] is False
    assert gate["error"] is False


# ─── malformed input is an error, not a routine skip ──────────────────────────


@pytest.mark.parametrize("payload", [None, [], "nope", {"schema_version": "1.1"}, {"findings": {}}])
def test_malformed_findings_json_is_flagged_as_error(payload):
    gate = review_cli.evaluate_coverage_gate(payload)
    assert gate["should_run"] is False
    assert gate["error"] is True
    assert gate["reason"] != "no coverage findings in findings.json"


# ─── category enum validation ─────────────────────────────────────────────────


def _write_findings(rd, findings, summary_by_category=None):
    (rd / "findings.json").write_text(json.dumps(_doc(*findings)))
    summary = {
        "schema_version": "1.1",
        "run_id": "20260902-063840",
        "counts": {"critical": 0, "high": 1, "medium": 0, "low": 0, "info": 0},
        "by_impact_axis": {},
        "by_category": summary_by_category if summary_by_category is not None else {},
    }
    (rd / "summary.json").write_text(json.dumps(summary))


def test_out_of_enum_category_fails_validation(tmp_path, capsys):
    _write_findings(tmp_path, [dict(H3_FINDING, category="testing")])
    assert review_cli._validate_json_outputs(tmp_path) is False
    out = capsys.readouterr().out
    assert "testing" in out
    assert "category" in out


def test_in_enum_category_is_not_reported(tmp_path, capsys):
    _write_findings(tmp_path, [dict(H3_FINDING, category="coverage", subcategory="untested-module")])
    review_cli._validate_json_outputs(tmp_path)
    assert "outside the schema enum" not in capsys.readouterr().out


def test_validation_warns_on_miscategorised_coverage_finding(tmp_path, capsys):
    _write_findings(tmp_path, [H3_FINDING])
    review_cli._validate_json_outputs(tmp_path)
    out = capsys.readouterr().out
    assert "H-3" in out
    assert "schema drift" in out.lower()


# ─── summary.json by_category is derived, not model-authored ──────────────────


def test_by_category_is_recomputed_from_findings(tmp_path, capsys):
    _write_findings(tmp_path, [H3_FINDING], summary_by_category={"coverage": 1})
    review_cli._reconcile_summary_categories(tmp_path)
    summary = json.loads((tmp_path / "summary.json").read_text())
    assert summary["by_category"] == {"quality": 1}
    assert "by_category" in capsys.readouterr().out


def test_consistent_by_category_is_left_alone(tmp_path, capsys):
    _write_findings(tmp_path, [H3_FINDING], summary_by_category={"quality": 1})
    review_cli._reconcile_summary_categories(tmp_path)
    summary = json.loads((tmp_path / "summary.json").read_text())
    assert summary["by_category"] == {"quality": 1}
    assert capsys.readouterr().out == ""


def test_reconcile_tolerates_missing_files(tmp_path):
    review_cli._reconcile_summary_categories(tmp_path)  # must not raise


# ─── reading findings.json from the host run directory ────────────────────────


def test_read_findings_json_prefers_the_host_copy(tmp_path):
    (tmp_path / "findings.json").write_text(json.dumps(_doc(H3_FINDING)))
    # cname is unused on the host branch — passing None proves docker is not called.
    data, error = review_cli._read_findings_json(None, tmp_path)
    assert error is None
    assert data["findings"][0]["id"] == "H-3"


def test_read_findings_json_reports_unparseable_content(tmp_path):
    (tmp_path / "findings.json").write_text("{not json")
    data, error = review_cli._read_findings_json(None, tmp_path)
    assert data is None
    assert "not valid JSON" in error
