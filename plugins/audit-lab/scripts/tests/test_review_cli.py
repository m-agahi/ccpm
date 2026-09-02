"""Test suite for the audit-lab orchestrator (`review-cli.py`).

Focus: the agent-launch path. review-cli launches every agent with
`subprocess.Popen` and only reads its streams after the process exits. With
pipes that deadlocks as soon as either stream passes one pipe buffer
(64 KiB) — the container-side writer finishes and vanishes while the
host-side client stays blocked in `write(2)` forever.

The regression fixtures below emit 200 KB, well past the 65536-byte
threshold. A 50 KB fixture passes even with the bug present, so it proves
nothing.

Run: `pytest plugins/audit-lab/scripts/tests/` from anywhere.
"""

import importlib.util
import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parent.parent
REVIEW_CLI_PATH = SCRIPTS / "review-cli.py"
CONTAINER_SH_PATH = SCRIPTS / "container.sh"

# Every launch must return well inside this. With the deadlock present the
# child never returns at all, so the bound must be enforced by the test
# itself — pytest-timeout is not a dependency of this repo.
DEADLOCK_BUDGET_S = 15.0

# Comfortably past the 65536-byte pipe buffer.
BIG_BYTES = 200_000


def _load_review_cli():
    """Import review-cli.py under a legal module name (the file has a hyphen)."""
    spec = importlib.util.spec_from_file_location("review_cli", REVIEW_CLI_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules["review_cli"] = module
    spec.loader.exec_module(module)
    return module


rc = _load_review_cli()


def _emit_cmd(stream, nbytes=BIG_BYTES):
    """A local command that dumps nbytes of text on the named stream."""
    if stream == "stdout":
        body = f"sys.stdout.write('x' * {nbytes})"
    else:
        body = f"sys.stderr.write('x' * {nbytes})"
    return [sys.executable, "-c", f"import sys; {body}"]


def _wait_bounded(proc, budget=DEADLOCK_BUDGET_S):
    """Wait for proc, failing the test rather than hanging the suite."""
    started = time.time()
    while proc.poll() is None:
        if time.time() - started > budget:
            proc.kill()
            proc.wait()
            pytest.fail(
                f"agent launch did not return within {budget}s — "
                f"undrained-pipe deadlock has regressed"
            )
        time.sleep(0.05)
    return time.time() - started


# --------------------------------------------------------------------------- #
# BUG 1a — the launch seam must never deadlock on large output
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("stream", ["stdout", "stderr"])
def test_launch_logged_survives_large_output(tmp_path, stream):
    proc, out_path, err_path = rc._launch_logged(_emit_cmd(stream), tmp_path, "big")
    elapsed = _wait_bounded(proc)

    assert proc.returncode == 0
    written = out_path if stream == "stdout" else err_path
    assert len(rc._read_log(written)) == BIG_BYTES
    assert elapsed < DEADLOCK_BUDGET_S


def test_launch_logged_survives_large_output_on_both_streams(tmp_path):
    cmd = [
        sys.executable,
        "-c",
        f"import sys; sys.stdout.write('o' * {BIG_BYTES}); "
        f"sys.stderr.write('e' * {BIG_BYTES})",
    ]
    proc, out_path, err_path = rc._launch_logged(cmd, tmp_path, "both")
    _wait_bounded(proc)

    assert proc.returncode == 0
    assert len(rc._read_log(out_path)) == BIG_BYTES
    assert len(rc._read_log(err_path)) == BIG_BYTES


def test_launch_logged_does_not_leak_parent_fds(tmp_path):
    """The parent must close its own copies; the child keeps its dup."""
    before = len(list(Path("/proc/self/fd").iterdir()))
    for i in range(20):
        proc, _, _ = rc._launch_logged([sys.executable, "-c", "pass"], tmp_path, f"fd{i}")
        _wait_bounded(proc)
    after = len(list(Path("/proc/self/fd").iterdir()))
    assert after - before < 5


def test_no_communicate_on_redirected_processes():
    """`communicate()` on a file-redirected Popen returns (None, None).

    A leftover call silently yields `_parse_claude_output(None) -> None`
    and a cost of 0 — the failure mode that still passes a smoke test.
    """
    source = REVIEW_CLI_PATH.read_text(encoding="utf-8")
    assert ".communicate(" not in source


# --------------------------------------------------------------------------- #
# BUG 1a — the real collection path, not just the seam
# --------------------------------------------------------------------------- #
def test_collect_finished_handles_large_script_output(tmp_path):
    item = {"name": "big-script", "type": "script"}
    proc, out_path, err_path = rc._launch_logged(_emit_cmd("stdout"), tmp_path, "big-script")

    processes = {"big-script": (proc, item, time.time())}
    logs = {"big-script": (out_path, err_path)}
    results = {}
    active = {"big-script"}

    started = time.time()
    while active:
        if time.time() - started > DEADLOCK_BUDGET_S:
            proc.kill()
            proc.wait()
            pytest.fail("_collect_finished never drained the process — deadlock regressed")
        rc._collect_finished(processes, logs, results, active)
        time.sleep(0.05)

    assert results["big-script"]["status"] == "ok"
    assert results["big-script"]["stdout_log"] == str(out_path)
    assert len(rc._read_log(out_path)) == BIG_BYTES


def test_collect_finished_records_error_output_from_logs(tmp_path):
    item = {"name": "boom", "type": "agent"}
    cmd = [sys.executable, "-c", "import sys; sys.stderr.write('kaboom'); sys.exit(3)"]
    proc, out_path, err_path = rc._launch_logged(cmd, tmp_path, "boom")

    processes = {"boom": (proc, item, time.time())}
    logs = {"boom": (out_path, err_path)}
    results = {}
    active = {"boom"}
    started = time.time()
    while active and time.time() - started < DEADLOCK_BUDGET_S:
        rc._collect_finished(processes, logs, results, active)
        time.sleep(0.05)

    assert results["boom"]["status"] == "failed"
    assert "kaboom" in results["boom"]["error_output"]


# --------------------------------------------------------------------------- #
# BUG 1b — timeouts must reach the container-side process
# --------------------------------------------------------------------------- #
def test_collect_finished_timeout_kills_container_side(tmp_path, monkeypatch):
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(rc, "run", fake_run)
    monkeypatch.setattr(rc, "PARALLEL_TIMEOUT", 0)

    item = {"name": "slow", "type": "agent", "prompt_file": "prompt-slow.txt"}
    cmd = [sys.executable, "-c", "import time; time.sleep(30)"]
    proc, out_path, err_path = rc._launch_logged(cmd, tmp_path, "slow")

    processes = {"slow": (proc, item, time.time() - 10)}
    logs = {"slow": (out_path, err_path)}
    results = {}
    active = {"slow"}
    rc._collect_finished(processes, logs, results, active, cname="review-x")

    assert results["slow"]["status"] == "timeout"
    assert results["slow"]["stdout_log"] == str(out_path)

    flat = [" ".join(c) for c in calls]
    # The prompt pattern must travel in the environment, never in the command
    # line — a killer matched by its own pgrep kills itself.
    assert any("CR_KILL_PAT=prompt-slow.txt" in c for c in flat), flat
    assert any("CR_KILL_SIG=TERM" in c for c in flat), flat
    assert any("CR_KILL_SIG=KILL" in c for c in flat), flat
    for call in calls:
        assert "prompt-slow.txt" not in call[-1], "pattern leaked into the killer's argv"


def test_collect_finished_timeout_skips_pkill_for_scripts(tmp_path, monkeypatch):
    """Script items carry no prompt_file — never pkill on an empty pattern."""
    calls = []
    monkeypatch.setattr(
        rc, "run", lambda cmd, **kw: (calls.append(cmd), subprocess.CompletedProcess(cmd, 0, "", ""))[1]
    )
    monkeypatch.setattr(rc, "PARALLEL_TIMEOUT", 0)

    item = {"name": "slowscript", "type": "script", "container_cmd": "sleep 30"}
    proc, out_path, err_path = rc._launch_logged(
        [sys.executable, "-c", "import time; time.sleep(30)"], tmp_path, "slowscript"
    )
    processes = {"slowscript": (proc, item, time.time() - 10)}
    logs = {"slowscript": (out_path, err_path)}
    active = {"slowscript"}
    rc._collect_finished(processes, logs, {}, active, cname="review-x")

    assert not any("CR_KILL_PAT" in " ".join(c) for c in calls)


# --------------------------------------------------------------------------- #
# BUG 1c — the container needs a real init to reap orphans
# --------------------------------------------------------------------------- #
def test_container_run_passes_init():
    source = CONTAINER_SH_PATH.read_text(encoding="utf-8")
    run_block = source.split("docker run -d", 1)[1].split('"$IMAGE_NAME"', 1)[0]
    assert "--init" in run_block


# --------------------------------------------------------------------------- #
# BUG 1d — allowedTools must match what the prompts instruct
# --------------------------------------------------------------------------- #
def test_claude_cmd_allows_write_and_edit():
    cmd = rc._build_claude_cmd("review-x", {"prompt_file": "p.txt", "model": "sonnet"})
    inner = cmd[-1]
    assert "'Write(*)'" in inner
    assert "'Edit(*)'" in inner


# --------------------------------------------------------------------------- #
# BUG 1e — status must be persisted and cross-checked
# --------------------------------------------------------------------------- #
def _plan():
    return {
        "parallel": [{"name": "fuzz-tester", "type": "agent", "model": "sonnet"}],
        "sequential": [{"name": "test-case-suggester", "type": "agent", "model": "haiku"}],
    }


USAGE = {
    "input_tokens": 42,
    "cache_creation_input_tokens": 66481,
    "cache_read_input_tokens": 1951430,
    "output_tokens": 17976,
    "service_tier": "standard",
}


def test_cost_manifest_persists_status_and_tokens(tmp_path):
    results = {
        "fuzz-tester": {
            "status": "timeout",
            "cost": 0,
            "duration": 2908.9,
            "output": None,
        },
        "test-case-suggester": {
            "status": "skipped",
            "cost": 0,
            "duration": 0,
            "output": {"total_cost_usd": 0, "usage": USAGE},
            "error_output": "no coverage findings in findings.json",
        },
    }
    rc._write_cost_manifest(tmp_path, results, _plan())
    manifest = json.loads((tmp_path / "cost-manifest.json").read_text())
    by_name = {a["name"]: a for a in manifest["agents"]}

    # BUG 1e's diagnostic signature depends on total_cost_usd staying put.
    assert by_name["fuzz-tester"]["total_cost_usd"] == 0
    assert by_name["fuzz-tester"]["status"] == "timeout"

    suggester = by_name["test-case-suggester"]
    assert suggester["status"] == "skipped"
    assert suggester["skip_reason"] == "no coverage findings in findings.json"
    assert suggester["usage"] == USAGE
    assert suggester["tokens"] == {
        "input": 42,
        "output": 17976,
        "cache_read": 1951430,
        "cache_creation": 66481,
    }


def test_check_findings_flags_status_disagreement(monkeypatch, capsys):
    """A hung agent whose findings reached disk must not read as passed."""
    monkeypatch.setattr(
        rc, "run", lambda cmd, **kw: subprocess.CompletedProcess(cmd, 0, "6505\n", "")
    )
    plan = {"parallel": [{"name": "fuzz-tester", "type": "agent"}]}
    results = {"fuzz-tester": {"status": "timeout", "cost": 0, "duration": 2908.9}}
    rc._check_findings("review-x", plan, results)

    out = capsys.readouterr().out
    assert "fuzz-tester" in out
    assert "timeout" in out


def test_check_findings_without_results_still_works(monkeypatch, capsys):
    monkeypatch.setattr(
        rc, "run", lambda cmd, **kw: subprocess.CompletedProcess(cmd, 0, "6505\n", "")
    )
    rc._check_findings("review-x", {"parallel": [{"name": "linter", "type": "agent"}]})
    assert "linter" in capsys.readouterr().out


# --------------------------------------------------------------------------- #
# Token reporting — categories and models stay separate
# --------------------------------------------------------------------------- #
def test_extract_tokens_uses_real_usage_keys():
    assert rc._extract_tokens(USAGE) == {
        "input": 42,
        "output": 17976,
        "cache_read": 1951430,
        "cache_creation": 66481,
    }
    assert rc._extract_tokens(None) is None
    assert rc._extract_tokens({}) is None
    assert rc._extract_tokens({"service_tier": "standard"}) is None


def test_summarize_tokens_groups_by_model():
    plan = {
        "parallel": [
            {"name": "a", "type": "agent", "model": "opus"},
            {"name": "b", "type": "agent", "model": "opus"},
            {"name": "c", "type": "agent", "model": "haiku"},
        ],
        "sequential": [],
    }
    results = {
        "a": {"output": {"usage": USAGE}},
        "b": {"output": {"usage": USAGE}},
        "c": {"output": {"usage": USAGE}},
        "noise": {"output": None},
    }
    summary = rc._summarize_tokens(results, plan)
    assert set(summary) == {"opus", "haiku"}
    assert summary["opus"]["output"] == 2 * 17976
    assert summary["haiku"]["cache_read"] == 1951430


def test_fmt_tokens_is_readable():
    assert rc._fmt_tokens(42) == "42"
    assert rc._fmt_tokens(17976) == "18.0k"
    assert rc._fmt_tokens(1951430) == "1.95M"


def _render_token_summary(results, plan):
    from rich.console import Console

    console = Console(file=__import__("io").StringIO(), width=100, force_terminal=False)
    rc._print_token_summary(results, plan, console)
    return console.file.getvalue()


def test_print_token_summary_reports_tokens_not_dollars():
    plan = {
        "parallel": [{"name": "a", "type": "agent", "model": "opus"}],
        "sequential": [{"name": "b", "type": "agent", "model": "haiku"}],
    }
    results = {
        "a": {"output": {"usage": USAGE}, "status": "ok"},
        "b": {"output": {"usage": USAGE}, "status": "ok"},
    }
    out = _render_token_summary(results, plan)
    assert "$" not in out
    assert "opus" in out and "haiku" in out and "total" in out
    # Categories stay separate — a single summed number would be meaningless.
    assert "cache-read" in out and "cache-create" in out
    assert "1.95M" in out


def test_print_token_summary_handles_no_usage():
    out = _render_token_summary({"a": {"output": None}}, _plan())
    assert "none reported" in out


# --- pre-rename config fallback (v6.0.0 rename from code-review to audit-lab) ---


def _registry_paths(tmp_path, monkeypatch):
    """Point every registries path at tmp_path and return (new, legacy, pre_rename)."""
    mod = _load_review_cli()
    new = tmp_path / "audit-lab" / "registries.yaml"
    legacy = tmp_path / "audit-lab" / "registries.yml"
    pre = tmp_path / "code-review" / "registries.yaml"
    monkeypatch.setattr(mod, "REGISTRIES_PATH", new)
    monkeypatch.setattr(mod, "REGISTRIES_LEGACY_PATH", legacy)
    monkeypatch.setattr(
        mod, "REGISTRIES_PRE_RENAME_PATHS", (pre, tmp_path / "code-review" / "registries.yml")
    )
    for p in (new, legacy, pre):
        p.parent.mkdir(parents=True, exist_ok=True)
    return mod, new, legacy, pre


def test_pre_rename_config_is_read_when_new_path_absent(tmp_path, monkeypatch, capsys):
    mod, _new, _legacy, pre = _registry_paths(tmp_path, monkeypatch)
    pre.write_text("mounts: []\n")

    active, is_legacy = mod._active_registries_path()

    assert active == pre
    assert is_legacy is True
    assert "renamed from code-review to audit-lab" in capsys.readouterr().err


def test_new_config_path_wins_over_pre_rename(tmp_path, monkeypatch):
    mod, new, _legacy, pre = _registry_paths(tmp_path, monkeypatch)
    new.write_text("mounts: []\n")
    pre.write_text("mounts: []\n")

    active, is_legacy = mod._active_registries_path()

    assert active == new
    assert is_legacy is False


def test_example_config_not_copied_over_existing_pre_rename_config(tmp_path, monkeypatch):
    mod, new, _legacy, pre = _registry_paths(tmp_path, monkeypatch)
    pre.write_text("mounts: []\n")

    assert mod._ensure_registries_config() is False
    assert not new.exists()
