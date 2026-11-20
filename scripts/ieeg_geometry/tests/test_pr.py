"""`pr`: one reviewable pull request with exactly the pipeline's outputs.

The dataset repository is a local bare git remote (the real clone, fetch, git and push code
runs), `gh` is a local executable that records its arguments, and nothing reaches GitHub.
"""

import dataclasses
import json
import shutil
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


EXTRAS = {  # files the fetch never checks out: they must survive in the commit's tree
    "participants.tsv": "participant_id\nsub-1\n",
    "sub-1/ieeg/sub-1_task-rest_ieeg.edf": "not a recording\n",
    "derivatives/other/result.bin": "bytes\n",
}


def remote_repo(remote: Remote) -> Path:
    return Path(remote.repo_url.format(id=DATASET_ID).removeprefix("file://"))


def _advance(bare: Path, tmp: Path, files: dict[str, str]) -> None:
    """A commit on the hosted main after the release tag."""
    work = tmp / "advance"
    _git(tmp, "clone", "-q", str(bare), str(work))
    for rel, text in files.items():
        (work / rel).parent.mkdir(parents=True, exist_ok=True)
        (work / rel).write_text(text)
    _git(work, "add", "-A")
    _git(work, "commit", "-q", "-m", "after the release")
    _git(work, "push", "-q", "origin", "main")


def _bare(remote: Remote, root: Path) -> tuple[Remote, Path]:
    """Serve the dataset from a bare repository, as a hosting remote would."""
    bare = root / "bare" / DATASET_ID
    bare.parent.mkdir(parents=True)
    _git(remote_repo(remote), "tag", VERSION)  # the release the data plane serves
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
    with_extras = tmp_path / "src"
    shutil.copytree(source, with_extras)
    for rel, text in EXTRAS.items():
        (with_extras / rel).parent.mkdir(parents=True, exist_ok=True)
        (with_extras / rel).write_text(text)
    remote = build_remote(with_extras, tmp_path / "remote")
    served, bare = _bare(remote, tmp_path / "hosting")
    log, _ = standins.activate(monkeypatch, tmp_path / "standins")
    return served, bare, log, tmp_path / "w"


def _calls(log: Path) -> list[dict]:
    return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []


def _refs(bare: Path) -> list[str]:
    out = _git(bare, "for-each-ref", "--format=%(refname)", "refs/heads")
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
    # files the fetch never checked out are still in the commit's tree
    tree = set(_git(bare, "ls-tree", "-r", "--name-only", BRANCH).split("\n"))
    assert set(EXTRAS) <= tree
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
    # the message says how to proceed: by hand with the saved body, or delete the branch
    body_file = work / f"{DATASET_ID}.pr-body.md"
    assert body_file.read_text().startswith("This pull request adds")
    assert f"gh pr create --repo nemarDatasets/{DATASET_ID} --base main --head {BRANCH}" in err
    assert str(body_file) in err
    assert f"push origin --delete {BRANCH}" in err


def test_the_branch_is_named_for_the_pipeline_version():
    assert pr.branch_name("1.2.3") == "nemar/ieeg-geometry-1.2.3"
    assert pr.title("1.2.3") == "Add NEMAR-computed iEEG geometry (pipeline 1.2.3)"


# ---- review round 1 ---------------------------------------------------------------------------


def _annex_like_filter(monkeypatch, tmp_path):
    """The owner's machine: a global filter that turns file content into a pointer."""
    tmp_path.mkdir(parents=True, exist_ok=True)
    attributes = tmp_path / "attributes"
    attributes.write_text("* filter=annex\n")
    for i, (key, value) in enumerate(
        [
            ("filter.annex.smudge", "cat"),
            ("filter.annex.clean", "sed 's|^|/annex/objects/POINTER |'"),
            ("filter.annex.required", "true"),  # what `git annex init` sets
            ("core.attributesFile", str(attributes)),
        ]
    ):
        monkeypatch.setenv(f"GIT_CONFIG_KEY_{i}", key)
        monkeypatch.setenv(f"GIT_CONFIG_VALUE_{i}", value)
    monkeypatch.setenv("GIT_CONFIG_COUNT", "4")


def test_an_annex_filter_never_turns_a_sidecar_into_a_pointer(env, tmp_path, monkeypatch):
    served, bare, log, work = env
    _advance(bare, tmp_path, {".gitattributes": "* filter=annex\n"})
    _git(bare, "tag", "-f", VERSION, "main")  # the attributes belong to the release
    _annex_like_filter(monkeypatch, tmp_path / "owner")
    assert _pr(served, work) == 0
    clone = work / DATASET_ID
    changed = _git(bare, "diff", "--name-only", "main", BRANCH).split()
    assert changed
    for rel in changed:
        committed = _git(bare, "show", f"{BRANCH}:{rel}")
        assert committed == (clone / rel).read_text(), rel
        assert not committed.startswith("/annex/objects/")


def test_check_staged_names_missing_and_extra_paths():
    pr.check_staged({"a", "b"}, {"a", "b"})
    with pytest.raises(pr.PrRefusal, match=r"missing \['b'\]"):
        pr.check_staged({"a"}, {"a", "b"})
    with pytest.raises(pr.PrRefusal, match=r"extra \['z'\]"):
        pr.check_staged({"a", "b", "z"}, {"a", "b"})


def test_a_staged_symlink_or_pointer_is_refused(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    (repo / "target").write_text("x")
    (repo / "link").symlink_to("target")
    (repo / "pointer.json").write_text("/annex/objects/SHA256E-s1--abc\n")
    (repo / "ok.json").write_text("{}\n")
    _git(repo, "add", "-A")
    pr.verify_staged_bytes(repo, {"ok.json"})
    with pytest.raises(pr.PrRefusal, match="mode 120000"):
        pr.verify_staged_bytes(repo, {"link"})
    with pytest.raises(pr.PrRefusal, match="annex pointer"):
        pr.verify_staged_bytes(repo, {"pointer.json"})
    (repo / "ok.json").write_text("changed after staging\n")
    with pytest.raises(pr.PrRefusal, match="not the file in the work tree"):
        pr.verify_staged_bytes(repo, {"ok.json"})
    with pytest.raises(pr.PrRefusal, match="not staged"):
        pr.verify_staged_bytes(repo, {"nothing.json"})


REPORT = {
    "dataset": "on1",
    "dataset_version": "v1",
    "source_commit": "abc",
    "pipeline_version": "1",
    "changes": {
        "add": [f"sub-{i}/f{i}.tsv" for i in range(300)],
        "change": [],
        "remove": ["sub-old/gone_electrodes.tsv", "sub-old/gone_coordsystem.json"],
    },
}


def test_removed_paths_are_always_listed_in_short_form():
    for limit in (10**6, 3000, 100):
        body = pr.build_body(REPORT, {}, n_surface_sets=0, limit=limit)
        assert "## Removed (2): no longer produced by the pipeline" in body
        assert "- `sub-old/gone_electrodes.tsv`" in body
        assert "- `sub-old/gone_coordsystem.json`" in body
    counts_only = pr.build_body(REPORT, {}, n_surface_sets=0, limit=100)
    added, _, removed = counts_only.partition("## Removed")
    assert "listed in `.nemar/ieeg-geometry.json`" in added
    assert "ownership" not in removed
    assert "No longer" not in added and "sub-old" not in added


def test_a_body_over_githubs_limit_is_refused_before_anything_is_pushed():
    huge = dict(
        REPORT,
        changes={"add": [], "change": [], "remove": [f"p/{i:06d}" + "x" * 60 for i in range(2000)]},
    )
    body = pr.build_body(huge, {}, n_surface_sets=0)
    assert len(body) > pr.GITHUB_BODY_MAX
    with pytest.raises(pr.PrRefusal, match="GitHub accepts"):
        pr.check_body_size(body)
    pr.check_body_size("fits")


def test_a_main_ahead_of_the_release_only_under_nemar_is_recorded_in_the_body(env, tmp_path):
    served, bare, log, work = env
    _advance(
        bare,
        tmp_path,
        {
            ".nemar/metadata.json": "{}\n",
            ".github/workflows/x.yml": "x\n",
            ".gitattributes": "* annex.backend=SHA256E\n",
        },
    )
    assert _pr(served, work) == 0
    body = _calls(log)[0]["body"]
    assert (
        "is ahead of release" in body
        and "only under `.nemar/`, `.github/` and `.gitattributes`" in body
    )


def test_a_main_ahead_of_the_release_in_dataset_files_is_refused_for_a_real_run(
    env, tmp_path, capsys
):
    served, bare, log, work = env
    _advance(bare, tmp_path, {"sub-1/ieeg/sub-1_new_electrodes.tsv": "name\tx\ty\tz\n"})
    assert _pr(served, work) == 1
    err = capsys.readouterr().err
    assert "ahead of release" in err and "outside `.nemar/`, `.github/` and `.gitattributes`" in err
    assert not _calls(log) and _refs(bare) == ["refs/heads/main"]
    # a dry run goes on, with a warning and the note in the printed body
    assert _pr(served, tmp_path / "w2", dry=True) == 0
    out = capsys.readouterr().out
    assert "warning: `main`" in out and "(a real run refuses)" in out
    assert "- Source: `main`" in out


def test_a_missing_release_tag_is_refused_for_a_real_run(env, capsys):
    served, bare, log, work = env
    _git(bare, "tag", "-d", VERSION)
    assert _pr(served, work) == 1
    assert f"no tag {VERSION} exists" in capsys.readouterr().err
    assert _refs(bare) == ["refs/heads/main"]


def test_a_real_run_refuses_a_remote_that_is_not_the_datasets_own(env):
    served, bare, log, work = env
    with pytest.raises(pr.PrRefusal, match="pushes only to the dataset's own repository"):
        pr.open_pr(DATASET_ID, work, version=VERSION, urls=served.urls())
    assert not work.exists() and _refs(bare) == ["refs/heads/main"]
    # a dry run may read any remote
    pr.open_pr(
        DATASET_ID,
        work,
        version=VERSION,
        urls=served.urls(),
        dry_run=True,
        out=open("/dev/null", "w"),
    )


def test_a_clone_that_is_not_on_main_is_refused(env, tmp_path, capsys):
    served, bare, log, work = env
    _git(bare, "branch", "other", "main")
    _git(bare, "symbolic-ref", "HEAD", "refs/heads/other")
    assert _pr(served, work) == 1
    assert "not on main" in capsys.readouterr().err
    assert not _calls(log)


def test_an_oversized_body_is_refused_before_any_branch_commit_or_push(env, monkeypatch, capsys):
    served, bare, log, work = env
    monkeypatch.setattr(pr, "GITHUB_BODY_MAX", 10)
    assert _pr(served, work) == 1
    assert "GitHub accepts 10" in capsys.readouterr().err
    clone = work / DATASET_ID
    assert _git(clone, "branch", "--list", BRANCH).strip() == ""
    assert _git(clone, "rev-list", "--count", "main..HEAD").strip() == "0"
    assert _refs(bare) == ["refs/heads/main"]
    assert not _calls(log)


def test_a_gitattributes_lookalike_is_not_allowed_to_move_after_the_release(env, tmp_path, capsys):
    served, bare, log, work = env
    _advance(bare, tmp_path, {".gitattributesX": "x\n", ".nemar/metadata.json": "{}\n"})
    assert _pr(served, work) == 1
    assert "`.gitattributesX`" in capsys.readouterr().err
    assert not _calls(log) and _refs(bare) == ["refs/heads/main"]


def _missing_annex_machine(monkeypatch):
    """The owner's machine: git-annex is configured globally, `required`, and not installed."""
    for i, (key, value) in enumerate(
        [
            ("filter.annex.process", "/nonexistent/git-annex filter-process"),
            ("filter.annex.required", "true"),
            ("filter.annex.smudge", "/nonexistent/git-annex smudge -- %f"),
            ("filter.annex.clean", "/nonexistent/git-annex smudge --clean -- %f"),
        ]
    ):
        monkeypatch.setenv(f"GIT_CONFIG_KEY_{i}", key)
        monkeypatch.setenv(f"GIT_CONFIG_VALUE_{i}", value)
    monkeypatch.setenv("GIT_CONFIG_COUNT", "4")


def test_a_configured_but_missing_annex_filter_does_not_stop_a_dry_or_real_run(
    env, tmp_path, monkeypatch
):
    served, bare, log, work = env
    _advance(bare, tmp_path, {".gitattributes": "* filter=annex\n"})
    _git(bare, "tag", "-f", VERSION, "main")
    _missing_annex_machine(monkeypatch)
    assert _pr(served, tmp_path / "dry", dry=True) == 0
    assert _pr(served, work) == 0
    clone = work / DATASET_ID
    changed = _git(bare, "diff", "--name-only", "main", BRANCH).split()
    assert changed
    for rel in changed:
        assert _git(bare, "show", f"{BRANCH}:{rel}") == (clone / rel).read_text(), rel
