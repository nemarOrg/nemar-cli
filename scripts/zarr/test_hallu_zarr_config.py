#!/usr/bin/env python3
"""Tests for hallu-zarr.sh's --test / --print-config config resolution
(nemarOrg/nemar-cli#1180, epic #1181 phase 3).

Real execution of the actual script via `bash hallu-zarr.sh ...` in a
subprocess, no mocks: every assertion here is against the script's real
stdout/stderr/exit code, run against a temp HOME/ZARR_BASE so nothing touches
a real Hallu deployment or the repo's own working tree. Covers:

- `--test` resolves every documented default (API_BASE, TEST_API_URL,
  S3_BUCKET, ZARR_AWS_PROFILE, ZARR_STATE_DIR, ZARR_WORK_DIR, ZARR_DRIVER_REF,
  ZARR_JOBS) only when the variable is otherwise unset. TEST_API_URL steers
  the separate `nemar` CLI binary that convert_dataset() shells out to for
  the metadata clone -- it has its own API-base resolution independent of
  API_BASE (src/lib/api/client.ts getApiUrl()), missed by issue #1180's
  env-var inventory and found live against xx099905 during this phase's
  verification (see hallu-zarr.sh's pre-pass comment).
- Plain (non-`--test`) `--print-config` still resolves the production
  defaults -- `--test` must not leak into the untested path.
- The test-mode guard rails: each of six prod values (S3_BUCKET, API_BASE,
  TEST_API_URL, AWS_PROFILE via ZARR_AWS_PROFILE, STATE_DIR via
  ZARR_STATE_DIR, WORK_DIR via ZARR_WORK_DIR) exported alongside `--test` is
  refused with a non-zero exit and a message naming the offending value, and
  produces no stdout config dump. The STATE_DIR/WORK_DIR checks are
  normalized (trailing slash, doubled slash) and the API_BASE/TEST_API_URL
  checks are case-insensitive and host-based (scheme, port, path, and a
  trailing DNS root dot do not matter; `api-test.nemar.org` is never
  mistaken for prod) -- each covered by a dedicated variant below, not just
  the bare-string case.
- The guard rails key off the raw pre-pass scan of argv (TEST_PREPASS_SEEN),
  not the arg parser's derived TEST_MODE, so a value-taking flag that used to
  swallow `--test` as its own value (`--dataset --test`, `--limit --test`)
  cannot silently suppress them. Both flags now also refuse a value starting
  with `--` outright, the same way `--requeue` already does.
- A plain prod run (no `--test`) explicitly unsets an ambient `TEST_API_URL`
  left over from an earlier `--test` session, so the `nemar` CLI can never
  depend on stale shell state during a real prod conversion.
- Every resolved config value `--print-config` prints, including the
  operation flags (ONLY_DATASET, LIMIT, REQUEUE, BACKFILL_DIR_FORMATS,
  PREVIEW_ENGINE_BUMP, EXECUTE) alongside the environment-derived ones, and
  in every documented flag order/combination.
- The eight `--test`-defaulted variables really are `export`ed (visible to a
  child process, e.g. the `nemar` CLI binary), not merely shell-local.
- A `.zarr-secrets.env` placed under the TEST state dir (not the prod one)
  flips `NEMAR_WEBHOOK_TOKEN` to `present` in `--print-config`.
- An explicit override (ZARR_JOBS=2) still wins over the `--test` default.
- `--print-config` (with or without `--test`) creates no files under
  ZARR_BASE -- it must exit before `mkdir -p "$WORK_DIR" "$STATE_DIR"`.
- The script refuses to run under bash < 4 (asserted right after
  `set -uo pipefail`): the host guards' `${var,,}` lowercasing is a bash
  4.0+ expansion, and under bash 3.2 (macOS's stock /bin/bash) it is a "bad
  substitution" that makes `_is_prod_api_host` return non-zero -- silently
  turning every host guard into an "allow" rather than a "refuse". Skipped
  unless /bin/bash itself reports major version 3.

Run:
    cd scripts/zarr && uv run --with pytest pytest test_hallu_zarr_config.py
    uv run --with pytest pytest scripts/zarr/test_hallu_zarr_config.py
"""

from __future__ import annotations

import os
import shlex
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


def _bin_bash_major_version() -> int | None:
    """The major version of /bin/bash, or None if it can't be determined
    (missing, or output that doesn't parse as an integer). Used to gate the
    bash-3.2 compatibility test below: it should actually run where
    /bin/bash is old (stock macOS) and skip everywhere else, rather than
    hardcoding a path-dependent assumption about what /bin/bash is.
    """
    bash_path = "/bin/bash"
    if not Path(bash_path).exists():
        return None
    try:
        proc = subprocess.run(
            [bash_path, "-c", 'echo "${BASH_VERSINFO[0]}"'],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except OSError:
        return None
    value = proc.stdout.strip()
    return int(value) if value.isdigit() else None


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
    # The `nemar` CLI (shelled out to for the metadata clone) resolves its own
    # API base independently of API_BASE -- see the pre-pass comment in
    # hallu-zarr.sh. TEST_API_URL is that CLI's hook, and --test must set it.
    assert cfg["TEST_API_URL"] == "https://api-test.nemar.org"
    assert cfg["CALLBACK_URL"] == "https://api-test.nemar.org/webhooks/zarr-ready"
    # The base the test instance's index.json advertises as `contract_base` and
    # each store's `nemar.contract_url` (#1059/#1064). It is a SEPARATE default
    # from S3_BUCKET on purpose -- the contract URL is the one clients may
    # hardcode, so it must not be derivable from wherever the bytes happen to
    # sit -- which also means --test has to steer it explicitly or a test index
    # would publish the production host.
    assert cfg["CONTRACT_BASE"] == "https://zarr-test.nemar.org"
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
    # The operation flags print-config also reports, at their untouched
    # defaults for a bare `--test --print-config`.
    assert cfg["ONLY_DATASET"] == ""
    assert cfg["LIMIT"] == "0"
    assert cfg["REQUEUE"] == ""
    assert cfg["BACKFILL_DIR_FORMATS"] == "0"
    assert cfg["PREVIEW_ENGINE_BUMP"] == "0"
    assert cfg["EXECUTE"] == "0"


def test_print_config_without_test_uses_prod_defaults(dirs: tuple[Path, Path]) -> None:
    zarr_base, home = dirs
    proc = run_script(["--print-config"], zarr_base, home)

    assert proc.returncode == 0, proc.stderr
    cfg = parse_config(proc.stdout)

    assert cfg["TEST_MODE"] == "0"
    assert cfg["API_BASE"] == "https://api.nemar.org"
    assert cfg["TEST_API_URL"] == ""
    assert cfg["CALLBACK_URL"] == "https://api.nemar.org/webhooks/zarr-ready"
    assert cfg["CONTRACT_BASE"] == "https://zarr.nemar.org"
    assert cfg["S3_BUCKET"] == "nemar"
    assert cfg["AWS_PROFILE"] == "nemar-zarr"
    assert cfg["STATE_DIR"] == f"{zarr_base}/zarr-state"
    assert cfg["WORK_DIR"] == f"{zarr_base}/zarr-scratch"
    assert cfg["DRIVER_REF"] == "main"
    # JOBS falls back to `nproc`, which varies by runner; just confirm it
    # resolved to a positive integer rather than being empty/non-numeric.
    assert cfg["JOBS"].isdigit() and int(cfg["JOBS"]) > 0
    assert cfg["ONLY_DATASET"] == ""
    assert cfg["LIMIT"] == "0"
    assert cfg["REQUEUE"] == ""
    assert cfg["BACKFILL_DIR_FORMATS"] == "0"
    assert cfg["PREVIEW_ENGINE_BUMP"] == "0"
    assert cfg["EXECUTE"] == "0"


@pytest.mark.parametrize(
    ("extra_env", "needle"),
    [
        ({"S3_BUCKET": "nemar"}, "S3_BUCKET=nemar"),
        ({"API_BASE": "https://api.nemar.org"}, "API_BASE=https://api.nemar.org"),
        # Case-insensitive, host-based match: scheme/case/trailing-slash/port
        # must not let a prod host slip past the guard.
        ({"API_BASE": "https://API.NEMAR.ORG"}, "API_BASE=https://API.NEMAR.ORG"),
        (
            {"API_BASE": "http://api.nemar.org/"},
            "API_BASE=http://api.nemar.org/",
        ),
        (
            {"API_BASE": "https://api.nemar.org:8443"},
            "API_BASE=https://api.nemar.org:8443",
        ),
        # Trailing DNS root dot: "api.nemar.org." is DNS-identical to
        # "api.nemar.org" (an absolute FQDN), so a naive string comparison
        # that doesn't strip it would let this slip past as a "different"
        # host while it resolves to production.
        (
            {"API_BASE": "https://api.nemar.org./"},
            "API_BASE=https://api.nemar.org./",
        ),
        (
            {"TEST_API_URL": "https://api.nemar.org"},
            "TEST_API_URL=https://api.nemar.org",
        ),
        (
            {"TEST_API_URL": "https://API.NEMAR.ORG/"},
            "TEST_API_URL=https://API.NEMAR.ORG/",
        ),
        (
            {"TEST_API_URL": "https://API.NEMAR.ORG.:443/"},
            "TEST_API_URL=https://API.NEMAR.ORG.:443/",
        ),
        ({"ZARR_AWS_PROFILE": "nemar-zarr"}, "AWS_PROFILE=nemar-zarr"),
        (
            {"ZARR_STATE_DIR": "/mnt/local/zarr-state"},
            "STATE_DIR=/mnt/local/zarr-state",
        ),
        # Normalized: a trailing slash or a doubled slash must not let the
        # prod state dir slip past a bare string-equality check.
        (
            {"ZARR_STATE_DIR": "/mnt/local/zarr-state/"},
            "STATE_DIR=/mnt/local/zarr-state/",
        ),
        (
            {"ZARR_STATE_DIR": "/mnt/local//zarr-state"},
            "STATE_DIR=/mnt/local//zarr-state",
        ),
        # WORK_DIR was not guarded at all before this round -- same
        # normalization applies to it as to STATE_DIR.
        (
            {"ZARR_WORK_DIR": "/mnt/local/zarr-scratch"},
            "WORK_DIR=/mnt/local/zarr-scratch",
        ),
        (
            {"ZARR_WORK_DIR": "/mnt/local/zarr-scratch/"},
            "WORK_DIR=/mnt/local/zarr-scratch/",
        ),
    ],
    ids=[
        "s3-bucket",
        "api-base",
        "api-base-uppercase",
        "api-base-http-trailing-slash",
        "api-base-port",
        "api-base-dns-root-dot",
        "test-api-url",
        "test-api-url-uppercase-trailing-slash",
        "test-api-url-uppercase-dns-root-dot-port",
        "aws-profile",
        "state-dir",
        "state-dir-trailing-slash",
        "state-dir-double-slash",
        "work-dir",
        "work-dir-trailing-slash",
    ],
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


@pytest.mark.parametrize(
    "flag",
    ["--dataset", "--limit"],
    ids=["dataset", "limit"],
)
def test_value_flag_refuses_test_as_its_value(
    dirs: tuple[Path, Path], flag: str
) -> None:
    """`--dataset --test` / `--limit --test` (value missing) must not swallow
    the --test token as the flag's value -- that used to leave TEST_MODE
    unset and no guard running, while the pre-pass had already applied test
    defaults on top of an ambient prod S3_BUCKET. Refused outright now, the
    same way --requeue already refuses a `--`-prefixed value.
    """
    zarr_base, home = dirs
    proc = run_script(
        [flag, "--test", "--print-config"],
        zarr_base,
        home,
        extra_env={"S3_BUCKET": "nemar"},
    )

    assert proc.returncode != 0
    assert "requires a value" in proc.stderr
    assert proc.stdout == ""


def test_test_api_url_unset_on_plain_prod_run(dirs: tuple[Path, Path]) -> None:
    """A TEST_API_URL left exported from an earlier --test session must not
    leak into a later plain (prod) run -- the `nemar` CLI would otherwise
    keep pointing at api-test.nemar.org during a supposed prod conversion.
    """
    zarr_base, home = dirs
    proc = run_script(
        ["--print-config"],
        zarr_base,
        home,
        extra_env={"TEST_API_URL": "https://api-test.nemar.org"},
    )

    assert proc.returncode == 0, proc.stderr
    cfg = parse_config(proc.stdout)
    assert cfg["TEST_API_URL"] == ""
    assert "unsetting stale TEST_API_URL" in proc.stderr


def test_explicit_zarr_jobs_wins_over_test_default(dirs: tuple[Path, Path]) -> None:
    zarr_base, home = dirs
    proc = run_script(
        ["--test", "--print-config"], zarr_base, home, extra_env={"ZARR_JOBS": "2"}
    )

    assert proc.returncode == 0, proc.stderr
    cfg = parse_config(proc.stdout)
    assert cfg["JOBS"] == "2"


def test_test_mode_env_vars_are_exported(dirs: tuple[Path, Path]) -> None:
    """A regression that drops `export` from one of the pre-pass's defaults
    must fail this test: `source`s the script in a `bash -c` wrapper and
    dumps the CHILD shell's own environment (via a trap on EXIT, fired when
    --print-config's `exit 0` unwinds the sourcing shell) rather than
    hallu-zarr.sh's stdout, so this is checking real export visibility to a
    child process (the `nemar` CLI, in the real run path), not just that the
    variable has a value in the current shell.
    """
    zarr_base, home = dirs
    env = base_env(zarr_base, home)
    wrapper = (
        f'trap "env" EXIT; source {shlex.quote(str(SCRIPT))} --test --print-config '
        ">/dev/null 2>/dev/null"
    )
    proc = subprocess.run(
        ["bash", "-c", wrapper],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )

    dumped: dict[str, str] = {}
    for line in proc.stdout.splitlines():
        if "=" in line:
            key, _, value = line.partition("=")
            dumped[key] = value

    for name in (
        "TEST_API_URL",
        "API_BASE",
        "S3_BUCKET",
        "ZARR_AWS_PROFILE",
        "ZARR_STATE_DIR",
        "ZARR_WORK_DIR",
        "ZARR_DRIVER_REF",
        "ZARR_JOBS",
        "ZARR_CONTRACT_BASE",
    ):
        assert name in dumped, f"{name} missing from child env -- not exported?"

    assert dumped["TEST_API_URL"] == "https://api-test.nemar.org"
    assert dumped["API_BASE"] == "https://api-test.nemar.org"
    assert dumped["S3_BUCKET"] == "nemar-dev"
    assert dumped["ZARR_AWS_PROFILE"] == "nemar-zarr-dev"
    assert dumped["ZARR_STATE_DIR"] == f"{zarr_base}/zarr-state-test"
    assert dumped["ZARR_WORK_DIR"] == f"{zarr_base}/zarr-scratch-test"
    assert dumped["ZARR_DRIVER_REF"] == "dev"
    assert dumped["ZARR_JOBS"] == "4"


def test_secrets_present_in_test_state_dir_flips_token(
    dirs: tuple[Path, Path],
) -> None:
    zarr_base, home = dirs
    test_state_dir = zarr_base / "zarr-state-test"
    test_state_dir.mkdir(parents=True)
    (test_state_dir / ".zarr-secrets.env").write_text("NEMAR_WEBHOOK_TOKEN=abc123\n")

    proc = run_script(["--test", "--print-config"], zarr_base, home)

    assert proc.returncode == 0, proc.stderr
    cfg = parse_config(proc.stdout)
    assert cfg["NEMAR_WEBHOOK_TOKEN"] == "present"


def test_secrets_at_prod_path_not_used_in_test_mode(
    dirs: tuple[Path, Path],
) -> None:
    """A secrets file sitting at the PROD state dir must not be read by a
    --test run -- each instance reads only its own state dir's secrets file.
    """
    zarr_base, home = dirs
    prod_state_dir = zarr_base / "zarr-state"
    prod_state_dir.mkdir(parents=True)
    (prod_state_dir / ".zarr-secrets.env").write_text("NEMAR_WEBHOOK_TOKEN=prodtoken\n")

    proc = run_script(["--test", "--print-config"], zarr_base, home)

    assert proc.returncode == 0, proc.stderr
    cfg = parse_config(proc.stdout)
    assert cfg["NEMAR_WEBHOOK_TOKEN"] == "absent"


@pytest.mark.parametrize(
    "args",
    [
        ["--print-config", "--test"],
        ["--test", "--dataset", "xx099905", "--print-config"],
        ["--requeue", "all", "--test", "--print-config"],
        ["--backfill-dir-formats", "--test", "--print-config"],
        ["--preview-engine-bump", "--test", "--print-config"],
    ],
    ids=[
        "print-config-before-test",
        "test-dataset-print-config",
        "requeue-all-test-print-config",
        "backfill-dir-formats-test-print-config",
        "preview-engine-bump-test-print-config",
    ],
)
def test_flag_order_and_combinations_resolve_test_defaults(
    dirs: tuple[Path, Path], args: list[str]
) -> None:
    zarr_base, home = dirs
    proc = run_script(args, zarr_base, home)

    assert proc.returncode == 0, proc.stderr
    cfg = parse_config(proc.stdout)
    assert cfg["TEST_MODE"] == "1"
    assert cfg["S3_BUCKET"] == "nemar-dev"
    assert cfg["API_BASE"] == "https://api-test.nemar.org"
    assert cfg["TEST_API_URL"] == "https://api-test.nemar.org"

    if "--dataset" in args:
        assert cfg["ONLY_DATASET"] == "xx099905"
    if "--requeue" in args:
        assert cfg["REQUEUE"] == "all"
    if "--backfill-dir-formats" in args:
        assert cfg["BACKFILL_DIR_FORMATS"] == "1"
    if "--preview-engine-bump" in args:
        assert cfg["PREVIEW_ENGINE_BUMP"] == "1"


@pytest.mark.skipif(
    _bin_bash_major_version() != 3,
    reason="/bin/bash is not bash 3.x on this machine",
)
def test_fails_loud_under_bash_3(dirs: tuple[Path, Path]) -> None:
    """The --test host guards (_is_prod_api_host) use ${var,,} lowercasing,
    a bash 4.0+ expansion. Under bash 3.2 (macOS's stock /bin/bash) that is
    a "bad substitution": the function errors and returns non-zero, so its
    `if _is_prod_api_host ...` caller reads that as "not prod" and every
    host guard would silently PASS -- the failure this whole PR exists to
    close, just moved to a different layer. The version assertion right
    after `set -uo pipefail` has to catch this before anything else runs,
    invoked here via the real /bin/bash rather than whatever `bash` PATH
    resolves to for the other tests in this file.
    """
    zarr_base, home = dirs
    env = base_env(zarr_base, home)
    proc = subprocess.run(
        ["/bin/bash", str(SCRIPT), "--print-config"],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )

    assert proc.returncode != 0
    assert "requires bash 4+" in proc.stderr


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
