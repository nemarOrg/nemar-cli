"""`pr`: one reviewable pull request with exactly the pipeline's outputs.

The dataset repository is a local bare git remote (the real clone, fetch, git and push code
runs), `gh` is a local executable that records its arguments, and nothing reaches GitHub.
"""

import dataclasses
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from ieeg_geometry import pipeline, pr
from ieeg_geometry.__main__ import main
from ieeg_geometry.ownership import read_ownership
from ieeg_geometry.version import pipeline_version

from . import standins
from .remote import DATASET_ID, VERSION, Remote, _git, build_remote
from .test_pipeline import _run, source  # noqa: F401 - `source` is a fixture

BRANCH = f"nemar/ieeg-geometry-{pipeline_version()}"
TITLE = f"Add NEMAR-computed iEEG geometry (pipeline {pipeline_version()})"


def _bare(remote: Remote, root: Path) -> tuple[Remote, Path]:
    """Serve the dataset from a bare repository, as a hosting remote would."""
    bare = root / "bare" / DATASET_ID
    bare.parent.mkdir(parents=True)
    _git(
        root,
        "clone",
        "-q",
        "--bare",
        remote.repo_url.format(id=DATASET_ID).removeprefix("file://"),
        str(bare),
    )
    _git(bare, "config", "uploadpack.allowFilter", "true")
    _git(bare, "config", "uploadpack.allowAnySHA1InWant", "true")
    return dataclasses.replace(remote, repo_url=f"file://{root / 'bare'}/{{id}}"), bare


@pytest.fixture(autouse=True)
def owner_identity(monkeypatch):
    for kind in ("AUTHOR", "COMMITTER"):
        monkeypatch.setenv(f"GIT_{kind}_NAME", "Owner Example")
        monkeypatch.setenv(f"GIT_{kind}_EMAIL", "owner@example.org")


@pytest.fixture
def env(source, tmp_path, monkeypatch):  # noqa: F811
    remote = build_remote(source, tmp_path / "remote")
    served, bare = _bare(remote, tmp_path / "hosting")
    log, _ = standins.activate(monkeypatch, tmp_path / "standins")
    return served, bare, log, tmp_path / "w"


def _calls(log: Path) -> list[dict]:
    return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []


def _refs(bare: Path) -> list[str]:
    out = _git(bare, "for-each-ref", "--format=%(refname)")
    return sorted(out.split())


def _expected_changes(remote: Remote, tmp_path: Path) -> list[str]:
    analysis, _ = _run(remote, tmp_path / "expect")
    c = analysis.report["changes"]
    return sorted({*c["add"], *c["change"], *c["remove"]})


def _pr(served, work, *extra, dry=False):
    argv = ["pr", DATASET_ID, "--workdir", str(work), "--version", VERSION, *extra]
    return main(argv + (["--dry-run"] if dry else []), urls=served.urls())


def test_the_pull_request_has_one_commit_with_exactly_the_reported_paths(env, tmp_path, capsys):
    served, bare, log, work = env
    expected = _expected_changes(served, tmp_path)
    assert expected and ".nemar/ieeg-geometry.json" in expected
    assert _pr(served, work) == 0
    out = capsys.readouterr().out
    assert out.strip().endswith("https://github.com/nemarDatasets/standin/pull/7")
    # one commit on top of main, with the fixed message and the owner's identity
    assert _git(bare, "rev-list", "--count", f"main..{BRANCH}").strip() == "1"
    assert _git(bare, "log", "-1", "--format=%s%n%an <%ae>", BRANCH).splitlines() == [
        TITLE,
        "Owner Example <owner@example.org>",
    ]
    # exactly the reported paths differ, and main is untouched
    names = _git(bare, "diff", "--name-only", "main", BRANCH).split()
    assert sorted(names) == expected
    assert _git(bare, "rev-parse", "main").strip() == served.commit
    # only the one branch was pushed
    assert _refs(bare) == ["refs/heads/main", f"refs/heads/{BRANCH}"]


def test_gh_is_asked_for_a_pull_request_against_main_with_the_body(env):
    served, _bare_repo, log, work = env
    assert _pr(served, work) == 0
    (call,) = _calls(log)
    args = call["args"]
    assert args[:2] == ["pr", "create"]
    pairs = dict(zip(args[2::2], args[3::2], strict=True))
    assert pairs["--repo"] == f"nemarDatasets/{DATASET_ID}"
    assert pairs["--base"] == "main" and pairs["--head"] == BRANCH
    assert pairs["--title"] == TITLE
    assert "merge" not in " ".join(args)
    assert call["body"].startswith("This pull request adds electrode positions")


def test_the_body_lists_every_added_file_with_its_method_and_grade(env, tmp_path):
    served, _bare_repo, log, work = env
    expected = _expected_changes(served, tmp_path)
    assert _pr(served, work) == 0
    body = _calls(log)[0]["body"]
    ownership = read_ownership(work / DATASET_ID)
    assert ownership is not None
    owned = {e.path: e for e in ownership.entries}
    paths = [p for p in expected if p != ".nemar/ieeg-geometry.json"]
    assert paths
    for path in paths:
        assert f"`{path}`" in body, path
        entry = owned[path]
        v = entry.verification
        assert v is not None
        assert f"### {entry.method}, evidence {v.grade}" in body
        assert v.reference in body
    assert "https://docs.nemar.org/data/ieeg-geometry/" in body
    assert f"`{pipeline_version()}`" in body and served.commit in body
    assert f"{len(expected)} added, 0 changed, 0 removed" in body
    assert "Subject surface sets for the website's Brain panel: " in body
    assert "ownership record" in body  # the record itself is described, not graded


def test_the_body_is_shortened_in_steps_to_fit_the_size_limit():
    report = {
        "dataset": "on1",
        "dataset_version": "v1",
        "source_commit": "abc",
        "pipeline_version": "1",
        "changes": {"add": [f"sub-{i}/f{i}.tsv" for i in range(400)], "change": [], "remove": []},
    }
    full = pr.build_body(report, {}, n_surface_sets=0, limit=10**6)
    assert all(f"`sub-{i}/f{i}.tsv`" in full for i in range(400))
    paths_only = pr.build_body(report, {}, n_surface_sets=0, limit=len(full) - 3000)
    assert len(paths_only) <= len(full) - 3000 and "`sub-399/f399.tsv`" in paths_only
    assert ": not graded" not in paths_only
    counts_only = pr.build_body(report, {}, n_surface_sets=0, limit=2000)
    assert len(counts_only) < 2000 and "sub-399" not in counts_only
    assert "listed in `.nemar/ieeg-geometry.json`" in counts_only


def test_a_dry_run_commits_locally_but_pushes_and_opens_nothing(env, capsys):
    served, bare, log, work = env
    assert _pr(served, work, dry=True) == 0
    out = capsys.readouterr().out
    assert f"title: {TITLE}" in out and "## Added" in out
    assert not _calls(log)  # gh never ran
    assert _refs(bare) == ["refs/heads/main"]
    assert _git(work / DATASET_ID, "rev-list", "--count", f"main..{BRANCH}").strip() == "1"


def test_an_existing_remote_branch_is_refused_and_nothing_is_pushed(env, tmp_path, capsys):
    served, bare, log, work = env
    _git(bare, "branch", BRANCH, "main")
    assert _pr(served, work) == 1
    assert "already exists on the remote" in capsys.readouterr().err
    assert not _calls(log)
    assert _refs(bare) == ["refs/heads/main", f"refs/heads/{BRANCH}"]
    assert _git(bare, "rev-parse", BRANCH).strip() == served.commit  # untouched


def test_an_errored_track_is_refused(env, monkeypatch, capsys):
    served, bare, log, work = env

    def broken(_dataset):
        raise RuntimeError("injected")

    monkeypatch.setattr("ieeg_geometry.freesurfer.plan_dataset", broken)
    assert _pr(served, work) == 1
    err = capsys.readouterr().err
    assert "a track errored" in err and "freesurfer" in err and "injected" in err
    assert not _calls(log) and _refs(bare) == ["refs/heads/main"]


def test_an_apply_with_no_changes_is_refused(env, tmp_path, capsys, monkeypatch):
    served, bare, log, work = env
    _run(served, tmp_path / "first", apply=True)  # the dataset as it stands after a PR
    applied = tmp_path / "applied"
    shutil.copytree(tmp_path / "first" / DATASET_ID, applied, ignore=shutil.ignore_patterns(".git"))
    done = build_remote(applied, tmp_path / "done")
    served2, bare2 = _bare(done, tmp_path / "hosting2")
    assert _pr(served2, tmp_path / "w2") == 1
    assert "no changes" in capsys.readouterr().err
    assert not _calls(log) and _refs(bare2) == ["refs/heads/main"]


def test_a_difference_outside_the_reported_changes_is_refused(env, monkeypatch, capsys):
    served, bare, log, work = env
    real_apply = pipeline.apply

    def apply_and_stray(a, surfaces_dir):
        written = real_apply(a, surfaces_dir)
        (a.dataset / "stray.txt").write_text("not from the pipeline\n")
        (a.dataset / "dataset_description.json").write_text("{}\n")
        return written

    monkeypatch.setattr(pipeline, "apply", apply_and_stray)
    assert _pr(served, work) == 1
    err = capsys.readouterr().err
    assert "outside the reported changes" in err
    assert "stray.txt" in err and "dataset_description.json" in err
    assert not _calls(log) and _refs(bare) == ["refs/heads/main"]


@pytest.mark.parametrize(
    "dataset_id", ["nm000103", "nm000105", "nm000107", "nm099998", "not-an-id"]
)
def test_protected_and_malformed_ids_are_refused_before_anything_runs(
    dataset_id, tmp_path, capsys, monkeypatch
):
    log, _ = standins.activate(monkeypatch, tmp_path / "standins")
    work = tmp_path / "w"
    assert main(["pr", dataset_id, "--workdir", str(work)]) == 1
    assert "refused" in capsys.readouterr().err
    assert not work.exists() and not _calls(log)


def test_an_existing_work_directory_is_refused(env, capsys):
    served, bare, log, work = env
    (work / DATASET_ID).mkdir(parents=True)
    assert _pr(served, work) == 1
    assert "fresh clone" in capsys.readouterr().err
    assert _refs(bare) == ["refs/heads/main"]


def test_a_missing_git_identity_is_refused(env, monkeypatch, capsys, tmp_path):
    served, bare, log, work = env
    for kind in ("AUTHOR", "COMMITTER"):
        monkeypatch.delenv(f"GIT_{kind}_NAME")
        monkeypatch.delenv(f"GIT_{kind}_EMAIL")
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", "/dev/null")
    monkeypatch.setenv("GIT_CONFIG_SYSTEM", "/dev/null")
    monkeypatch.setenv("GIT_CONFIG_COUNT", "1")
    monkeypatch.setenv("GIT_CONFIG_KEY_0", "user.useConfigOnly")
    monkeypatch.setenv("GIT_CONFIG_VALUE_0", "true")
    assert _pr(served, work) == 1
    assert "no git identity" in capsys.readouterr().err
    assert _refs(bare) == ["refs/heads/main"]


def test_a_gh_failure_is_reported_with_the_pushed_branch(env, monkeypatch, capsys):
    served, bare, log, work = env
    monkeypatch.setenv("GH_STANDIN_FAIL", "1")
    assert _pr(served, work) == 1
    err = capsys.readouterr().err
    assert "gh pr create failed" in err and "HTTP 403" in err
    assert f"refs/heads/{BRANCH}" in _refs(bare)  # the push happened before gh ran


def test_the_branch_is_named_for_the_pipeline_version():
    assert pr.branch_name("1.2.3") == "nemar/ieeg-geometry-1.2.3"
    assert pr.title("1.2.3") == "Add NEMAR-computed iEEG geometry (pipeline 1.2.3)"


def test_git_runs_with_the_standins_only_on_path(env):
    # the stand-in gh is what the code finds, never a real GitHub client
    assert "standins" in (shutil.which("gh") or "")
    assert subprocess.run(["git", "--version"], capture_output=True).returncode == 0
