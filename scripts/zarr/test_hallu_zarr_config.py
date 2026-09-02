#!/usr/bin/env python3
"""Tests for hallu-zarr.sh's --test / --print-config config resolution
(nemarOrg/nemar-cli#1180, epic #1181 phase 3).

Real execution of the actual script via `bash hallu-zarr.sh ...` in a
subprocess, no mocks: every assertion here is against the script's real
stdout/stderr/exit code, run against a temp HOME/ZARR_BASE so nothing touches
a real Hallu deployment or the repo's own working tree. Covers:

- `--test` resolves every documented default (API_BASE, S3_BUCKET,
  ZARR_AWS_PROFILE, ZARR_STATE_DIR, ZARR_WORK_DIR, ZARR_DRIVER_REF, ZARR_JOBS)
  only when the variable is otherwise unset.
- Plain (non-`--test`) `--print-config` still resolves the production
  defaults -- `--test` must not leak into the untested path.
- The test-mode guard rails: each of the four prod values (S3_BUCKET,
  API_BASE, AWS_PROFILE via ZARR_AWS_PROFILE, STATE_DIR via ZARR_STATE_DIR)
  exported alongside `--test` is refused with a non-zero exit and a message
  naming the offending value, and produces no stdout config dump.
- An explicit override (ZARR_JOBS=2) still wins over the `--test` default.
- `--print-config` (with or without `--test`) creates no files under
  ZARR_BASE -- it must exit before `mkdir -p "$WORK_DIR" "$STATE_DIR"`.

Run:
    cd scripts/zarr && uv run --with pytest pytest test_hallu_zarr_config.py
    uv run --with pytest pytest scripts/zarr/test_hallu_zarr_config.py
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent / "hallu-zarr.sh"


def base_env(zarr_base: Path, home: Path) -> dict[str, str]:
    """A minimal, isolated environment: only what bash/date/etc need to run,
    plus HOME/ZARR_BASE pointed at the test's temp dirs. Built from scratch
    rather than inheriting os.environ, so a developer's real shell (a
    lingering API_BASE, an already-sourced .zarr-secrets.env) can never leak
    into what is supposed to be an isolated run.
    """
    return {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": str(home),
        "ZARR_BASE": str(zarr_base),
    }


def run_script(
    args: list[str],
    zarr_base: Path,
    home: Path,
    extra_env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    env = base_env(zarr_base, home)
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        ["bash", str(SCRIPT), *args],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )


def parse_config(stdout: str) -> dict[str, str]:
    """--print-config prints one KEY=value per line."""
    out: dict[str, str] = {}
    for line in stdout.splitlines():
        if not line or "=" not in line:
            continue
        key, _, value = line.partition("=")
        out[key] = value
    return out


def tree_entries(root: Path) -> list[Path]:
    """Everything under root, recursively -- used to assert --print-config
    left no trace. root itself (created by the tmp_path fixture, not the
    script) does not count.
    """
    if not root.exists():
        return []
    return list(root.rglob("*"))


@pytest.fixture
def dirs(tmp_path: Path) -> tuple[Path, Path]:
    zarr_base = tmp_path / "zarr-base"
    home = tmp_path / "home"
    zarr_base.mkdir()
    home.mkdir()
    return zarr_base, home


def test_test_mode_print_config_defaults(dirs: tuple[Path, Path]) -> None:
    zarr_base, home = dirs
    proc = run_script(["--test", "--print-config"], zarr_base, home)

    assert proc.returncode == 0, proc.stderr
    cfg = parse_config(proc.stdout)

    state_dir = f"{zarr_base}/zarr-state-test"
    work_dir = f"{zarr_base}/zarr-scratch-test"

    assert cfg["TEST_MODE"] == "1"
    assert cfg["API_BASE"] == "https://api-test.nemar.org"
    assert cfg["CALLBACK_URL"] == "https://api-test.nemar.org/webhooks/zarr-ready"
    assert cfg["S3_BUCKET"] == "nemar-dev"
    assert cfg["AWS_PROFILE"] == "nemar-zarr-dev"
    assert cfg["STATE_DIR"] == state_dir
    assert cfg["WORK_DIR"] == work_dir
    assert cfg["DRIVER_REF"] == "dev"
    assert cfg["JOBS"] == "4"
    assert cfg["DRIVER_REPO"] == f"{state_dir}/nemar-cli"
    assert cfg["VENV_DIR"] == f"{state_dir}/.zarr-venv"
    assert cfg["QUEUE_DB"] == f"{state_dir}/zarr-queue.db"
    assert cfg["LOG_FILE"] == f"{state_dir}/.nm-zarr.log"
    assert cfg["LOCK_FILE"] == f"{state_dir}/.nm-zarr.lock"
    assert cfg["ENGINE_ACK_FILE"] == f"{state_dir}/.zarr-engine-bump-ack"
    assert cfg["ENGINE_REQUEUE_LIMIT"] == "25"
    assert cfg["AWS_REGION"] == "us-east-2"
    # No secrets file exists under the temp HOME/ZARR_BASE, so the token must
    # report absent -- and never its value, since none was ever provided.
    assert cfg["NEMAR_WEBHOOK_TOKEN"] == "absent"


def test_print_config_without_test_uses_prod_defaults(dirs: tuple[Path, Path]) -> None:
    zarr_base, home = dirs
    proc = run_script(["--print-config"], zarr_base, home)

    assert proc.returncode == 0, proc.stderr
    cfg = parse_config(proc.stdout)

    assert cfg["TEST_MODE"] == "0"
    assert cfg["API_BASE"] == "https://api.nemar.org"
    assert cfg["CALLBACK_URL"] == "https://api.nemar.org/webhooks/zarr-ready"
    assert cfg["S3_BUCKET"] == "nemar"
    assert cfg["AWS_PROFILE"] == "nemar-zarr"
    assert cfg["STATE_DIR"] == f"{zarr_base}/zarr-state"
    assert cfg["WORK_DIR"] == f"{zarr_base}/zarr-scratch"
    assert cfg["DRIVER_REF"] == "main"
    # JOBS falls back to `nproc`, which varies by runner; just confirm it
    # resolved to a positive integer rather than being empty/non-numeric.
    assert cfg["JOBS"].isdigit() and int(cfg["JOBS"]) > 0


@pytest.mark.parametrize(
    ("extra_env", "needle"),
    [
        ({"S3_BUCKET": "nemar"}, "S3_BUCKET=nemar"),
        ({"API_BASE": "https://api.nemar.org"}, "API_BASE=https://api.nemar.org"),
        ({"ZARR_AWS_PROFILE": "nemar-zarr"}, "AWS_PROFILE=nemar-zarr"),
        (
            {"ZARR_STATE_DIR": "/mnt/local/zarr-state"},
            "STATE_DIR=/mnt/local/zarr-state",
        ),
    ],
    ids=["s3-bucket", "api-base", "aws-profile", "state-dir"],
)
def test_guard_rail_refuses_prod_value_with_test(
    dirs: tuple[Path, Path], extra_env: dict[str, str], needle: str
) -> None:
    zarr_base, home = dirs
    proc = run_script(
        ["--test", "--print-config"], zarr_base, home, extra_env=extra_env
    )

    assert proc.returncode != 0
    assert needle in proc.stderr
    assert "--test is a safety boundary" in proc.stderr
    # The guard fires before the config dump: a prod value must be stopped,
    # not printed and then stopped.
    assert proc.stdout == ""


def test_explicit_zarr_jobs_wins_over_test_default(dirs: tuple[Path, Path]) -> None:
    zarr_base, home = dirs
    proc = run_script(
        ["--test", "--print-config"], zarr_base, home, extra_env={"ZARR_JOBS": "2"}
    )

    assert proc.returncode == 0, proc.stderr
    cfg = parse_config(proc.stdout)
    assert cfg["JOBS"] == "2"


def test_print_config_creates_no_files_in_test_mode(dirs: tuple[Path, Path]) -> None:
    zarr_base, home = dirs
    proc = run_script(["--test", "--print-config"], zarr_base, home)

    assert proc.returncode == 0, proc.stderr
    assert tree_entries(zarr_base) == []


def test_print_config_creates_no_files_in_prod_mode(dirs: tuple[Path, Path]) -> None:
    zarr_base, home = dirs
    proc = run_script(["--print-config"], zarr_base, home)

    assert proc.returncode == 0, proc.stderr
    assert tree_entries(zarr_base) == []


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
