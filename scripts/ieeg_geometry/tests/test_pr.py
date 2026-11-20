"""`pr`: one reviewable pull request with exactly the pipeline's outputs.

The dataset repository is a local bare git remote (the real clone, fetch, git and push code
runs), `gh` is a local executable that records its arguments, and nothing reaches GitHub.
"""

import dataclasses
import json
import os
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


EXTRAS = {  # files the fetch never checks out: they must survive in the commit's tree
    "participants.tsv": "participant_id\nsub-1\n",
    "sub-1/ieeg/sub-1_task-rest_ieeg.edf": "not a recording\n",
    "derivatives/other/result.bin": "bytes\n",
}


def remote_repo(remote: Remote) -> Path:
    return Path(remote.repo_url.format(id=DATASET_ID).removeprefix("file://"))


def _advance(
    bare: Path,
    tmp: Path,
    files: dict[str, str],
    name: str = "advance",
    *,
    rename: dict[str, str] | None = None,
    remove: tuple[str, ...] = (),
) -> None:
    """A commit on the hosted main after the release tag."""
    work = tmp / name
    _git(tmp, "clone", "-q", str(bare), str(work))
    for old, new in (rename or {}).items():
        _git(work, "mv", old, new)
    for gone in remove:
        _git(work, "rm", "-q", gone)
    for rel, text in files.items():
        (work / rel).parent.mkdir(parents=True, exist_ok=True)
        (work / rel).write_text(text)
    _git(work, "add", "--", *files)  # not -A: a new attribute must not renormalize old files
    _git(work, "commit", "-q", "-m", "after the release")
    _git(work, "push", "-q", "origin", "main")


def _advance_annexed(bare: Path, tmp: Path, rel: str) -> None:
    """After the release, main points `rel` at annexed bytes the release does not hold."""
    work = tmp / "advance-annexed"
    _git(tmp, "clone", "-q", str(bare), str(work))
    link = work / rel
    old = Path(os.readlink(link))
    link.unlink()
    key = "MD5E-s5--" + "0" * 32 + Path(rel).suffix
    os.symlink(old.parent.parent / key / key, link)
    _git(work, "add", "-A")
    _git(work, "commit", "-q", "-m", "annexed input changed after the release")
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


def _give_a_version(root: Path) -> None:
    """A mirror's pull request carries a bumped Version, so the dataset must have one."""
    description = root / "dataset_description.json"
    meta = json.loads(description.read_text())
    meta.setdefault("Version", "1.0.0")
    description.write_text(json.dumps(meta, indent=2) + "\n")


@pytest.fixture
def env(source, tmp_path, monkeypatch):  # noqa: F811
    with_extras = tmp_path / "src"
    shutil.copytree(source, with_extras)
    for rel, text in EXTRAS.items():
        (with_extras / rel).parent.mkdir(parents=True, exist_ok=True)
        (with_extras / rel).write_text(text)
    _give_a_version(with_extras)
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
    return sorted({*c["add"], *c["change"], *c["remove"], "dataset_description.json"})


def test_the_report_lists_cleaning_only_for_files_it_writes(env, tmp_path):
    served, _bare_repo, _log, _work = env
    analysis, _ = _run(served, tmp_path / "rep")
    report = analysis.report
    written = {*report["changes"]["add"], *report["changes"]["change"]}
    assert {e["path"] for e in report["electrodes_cleaning"]} <= written


def _pr(served, work, *extra, dry=False, bump=True):
    """A mirror's pull request needs `--bump-version`; `bump=False` leaves it off."""
    flag = ["--bump-version"] if bump else []
    argv = ["pr", DATASET_ID, "--workdir", str(work), "--version", VERSION, *flag, *extra]
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
    paths = [
        p for p in expected if p not in (".nemar/ieeg-geometry.json", "dataset_description.json")
    ]
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
    assert f"{len(paths) + 1} added, 0 changed, 0 removed" in body  # and the record
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


def _cleaning_report(
    entries: list[dict], n_files: int = 2, *, unwritten: tuple[str, ...] = ()
) -> dict:
    return {
        "dataset": "on1",
        "dataset_version": "v1",
        "source_commit": "abc",
        "pipeline_version": "1",
        "electrodes_cleaning": entries,
        "changes": {
            "add": [f"sub-{i}/f{i}.tsv" for i in range(n_files)]
            + [e["path"] for e in entries if e["path"] not in unwritten],
            "change": [],
            "remove": [],
        },
    }


def _entry(path: str, **kw) -> dict:
    base = {
        "path": path,
        "dropped_columns": [],
        "added_columns": [],
        "coerced_cells": {},
        "hemisphere_rewritten": 0,
    }
    return base | kw


def test_the_body_lists_the_table_cleaning_per_file():
    entry = _entry(
        "sub-01/ieeg/sub-01_electrodes.tsv",
        dropped_columns=["Notes", "Grid"],
        added_columns=["size"],
        coerced_cells={"x": 3, "impedance": 12},
        hemisphere_rewritten=5,
    )
    body = pr.build_body(_cleaning_report([entry]), {}, n_surface_sets=0)
    assert "## Table cleaning (1)" in body
    line = next(ln for ln in body.splitlines() if ln.startswith("- `sub-01/ieeg/"))
    assert "dropped columns: `Notes`, `Grid`" in line
    assert "added column: `size`" in line
    assert "`impedance` (12)" in line and "`x` (3)" in line
    assert "hemisphere values rewritten: 5" in line


def test_a_cleaning_entry_for_a_path_the_pull_request_does_not_write_is_not_listed():
    report = _cleaning_report(
        [
            _entry("sub-0/f0.tsv", dropped_columns=["A"]),
            _entry("sub-9/other.tsv", dropped_columns=["B"]),
        ],
        unwritten=("sub-9/other.tsv",),
    )
    body = pr.build_body(report, {}, n_surface_sets=0)
    assert "## Table cleaning (1)" in body and "sub-0/f0.tsv`: dropped" in body
    assert "other.tsv`: dropped" not in body
    only_foreign = _cleaning_report(
        [_entry("sub-9/other.tsv", dropped_columns=["B"])], unwritten=("sub-9/other.tsv",)
    )
    assert "Table cleaning" not in pr.build_body(only_foreign, {}, n_surface_sets=0)


def test_a_very_long_cleaning_line_is_clipped_and_the_section_comes_before_the_file_lists():
    entry = _entry("sub-0/f0.tsv", dropped_columns=[f"column_name_{i:03d}" for i in range(100)])
    body = pr.build_body(_cleaning_report([entry]), {}, n_surface_sets=0)
    line = next(ln for ln in body.splitlines() if ln.startswith("- `sub-0/f0.tsv`"))
    assert len(line) <= pr.MAX_CLEANING_LINE + 3 and line.endswith("...")
    assert body.index("## Table cleaning") < body.index("## Added")
    assert "differ from the source tables" in body and "unchanged and keep" in body


def test_no_table_cleaning_section_without_entries():
    for report in (_cleaning_report([]), _cleaning_report([_entry("a.tsv")])):
        assert "Table cleaning" not in pr.build_body(report, {}, n_surface_sets=0)
    bare = _cleaning_report([])
    del bare["electrodes_cleaning"]
    assert "Table cleaning" not in pr.build_body(bare, {}, n_surface_sets=0)


def test_a_long_table_cleaning_list_is_truncated_within_budget():
    entries = [
        _entry(f"sub-{i:03d}/ieeg/sub-{i:03d}_electrodes.tsv", dropped_columns=["Notes"] * 20)
        for i in range(300)
    ]
    body = pr.build_body(_cleaning_report(entries), {}, n_surface_sets=0)
    assert "## Table cleaning (300)" in body
    section = body[body.index("## Table cleaning") : body.index("## Added")]
    shown = section.count("\n- `sub-")
    assert 0 < shown < 300
    assert f"\n- and {300 - shown} more\n" in section
    assert "sub-299_electrodes.tsv`: dropped" not in body
    assert len(body) < pr.BODY_LIMIT
    pr.check_body_size(body)


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


def test_a_main_ahead_of_the_release_in_dataset_files_proceeds_and_lists_the_paths(env, tmp_path):
    served, bare, log, work = env
    _advance(
        bare,
        tmp_path,
        {
            "sub-1/ieeg/sub-1_new_electrodes.tsv": "name\tx\ty\tz\n",
            ".bidsignore": "x\n",
            "sub-\u00e9/notes.txt": "x\n",
        },
        rename={"participants.tsv": "participants-renamed.tsv"},
        remove=("derivatives/other/result.bin",),
    )
    assert _pr(served, work) == 0
    body = _calls(log)[0]["body"]
    assert "is ahead of release" in body
    # every path, with no rename detection (both sides of a move) and no quoting of non-ASCII
    for path in (
        ".bidsignore",
        "sub-1/ieeg/sub-1_new_electrodes.tsv",
        "participants.tsv",
        "participants-renamed.tsv",
        "derivatives/other/result.bin",
        "sub-\u00e9/notes.txt",
    ):
        assert f"  - `{path}`" in body, path
    assert body.index("`.bidsignore`") < body.index("`sub-1/ieeg/")  # sorted
    # the sentence stays on the Source bullet, before the list
    source_line = next(ln for ln in body.splitlines() if ln.startswith("- Source:"))
    assert "were computed from `main`, which the patch release will publish" in source_line
    assert "refuses" not in body


def test_more_than_fifty_changed_paths_are_listed_as_fifty_and_a_count(env, tmp_path):
    served, bare, log, work = env
    _advance(bare, tmp_path, {f"extra/f{i:03d}.txt": "x\n" for i in range(60)})
    assert _pr(served, work) == 0
    body = _calls(log)[0]["body"]
    assert body.count("- `extra/f") == 50 and "and 10 more" in body
    assert "`extra/f049.txt`" in body and "`extra/f050.txt`" not in body
    assert len(body) <= pr.GITHUB_BODY_MAX


def test_the_path_list_stays_inside_the_character_budget():
    long = [f"d/{i:03d}/" + "n" * 400 for i in range(50)]
    text = pr._path_list(long)
    assert len(text) < pr.MAX_LISTED_CHARS + 200 and "more" in text.splitlines()[-1]


def test_an_annexed_input_changed_after_the_release_is_refused_for_a_real_run(
    env, tmp_path, capsys
):
    served, bare, log, work = env
    rel = next(p for p in served.annexed if p.endswith("pial"))
    _advance_annexed(bare, tmp_path, rel)
    assert _pr(served, work) == 1
    err = capsys.readouterr().err
    assert f"changed after release {VERSION}" in err and f"`{rel}`" in err
    assert not _calls(log) and _refs(bare) == ["refs/heads/main"]
    # a dry run goes on, with a warning
    assert _pr(served, tmp_path / "w2", dry=True) == 0
    assert "(a real run refuses)" in capsys.readouterr().out


def test_an_input_that_could_not_be_fetched_is_listed_in_the_body(
    tmp_path,
    source,  # noqa: F811
    monkeypatch,
    capsys,
):
    _give_a_version(source)
    probe = build_remote(source, tmp_path / "probe")
    rel = next(p for p in probe.annexed if p.endswith("lh.sphere.reg"))
    remote = build_remote(source, tmp_path / "remote", missing_data=(rel,))
    served, _bare_repo = _bare(remote, tmp_path / "hosting")
    standins.activate(monkeypatch, tmp_path / "standins")
    assert _pr(served, tmp_path / "w", dry=True) == 0
    out = capsys.readouterr().out
    assert "- Not fetched: 1 input file(s)" in out and f"  - `{rel}`: " in out


def test_crlf_blobs_under_an_lf_attribute_are_not_changes_and_stay_byte_identical(env, tmp_path):
    served, bare, log, work = env
    # the authors committed CRLF bytes, and only later a `text eol=lf` rule
    _advance(bare, tmp_path, {"README.md": "line one\r\nline two\r\n"}, name="adv-crlf")
    _advance(bare, tmp_path, {".gitattributes": "* text eol=lf\n"}, name="adv-attr")
    crlf = "line one\r\nline two\r\n"
    assert int(_git(bare, "cat-file", "-s", "main:README.md")) == len(crlf)  # CR bytes kept
    assert _pr(served, work) == 0
    names = _git(bare, "diff", "--name-only", "main", BRANCH).split()
    assert "README.md" not in names and ".gitattributes" not in names
    assert sorted(names) == _expected_changes(served, tmp_path)
    assert _git(bare, "rev-parse", f"{BRANCH}:README.md") == _git(
        bare, "rev-parse", "main:README.md"
    )


ODD_DESCRIPTION = (
    '{\r\n  "Name": "x",\r\n  "GeneratedBy": [{"Name": "a", "Version": "9.9"}],\r\n'
    '    "Version" :   "1.0.0",\r\n  "Z": 1\r\n}'
)  # CRLF, odd spacing, an inner Version, no trailing newline


def _blob(bare: Path, ref: str) -> bytes:
    return subprocess.run(
        ["git", "-C", str(bare), "cat-file", "blob", ref], check=True, capture_output=True
    ).stdout


def test_bump_version_edits_only_the_version_and_tells_the_reviewer(env, tmp_path):
    served, bare, log, work = env
    adv = tmp_path / "adv2"
    _git(tmp_path, "clone", "-q", str(bare), str(adv))
    (adv / "dataset_description.json").write_bytes(ODD_DESCRIPTION.encode())
    _git(adv, "add", "dataset_description.json")
    _git(adv, "commit", "-q", "-m", "crlf description")
    _git(adv, "push", "-q", "origin", "main")
    assert _pr(served, work, "--bump-version") == 0
    new = _blob(bare, f"{BRANCH}:dataset_description.json")
    assert new == ODD_DESCRIPTION.replace('"1.0.0"', '"1.0.1"').encode()
    names = _git(bare, "diff", "--name-only", "main", BRANCH).split()
    assert sorted(names) == _expected_changes(served, tmp_path)
    body = _calls(log)[0]["body"]
    assert "from `1.0.0` to `1.0.1`" in body and "tags `v1.0.1`" in body
    assert "do not also run `nemar dataset release`" in body
    assert "cut the patch" not in body


def test_a_mirror_without_the_bump_flag_is_refused_pointing_to_the_integration_flow(env, capsys):
    served, bare, log, work = env
    assert _pr(served, work, bump=False) != 0
    err = capsys.readouterr().err
    assert "--from-ref <branch> --bump-version" in err
    assert not _calls(log) and not (work / DATASET_ID).exists()


def test_a_non_mirror_needs_no_bump_flag_and_has_no_release_step(tmp_path):
    report = {**REPORT, "dataset": "nm000352"}
    body = pr.build_body(report, {}, n_surface_sets=0)
    assert "nemar dataset release" not in body and "cut the patch" not in body
    try:  # the refusal is for `on` ids only: an nm id gets past it (and fails later, no remote)
        pr.open_pr("nm000352", tmp_path / "w", dry_run=True)
    except Exception as exc:  # noqa: BLE001
        assert "is a mirror" not in str(exc)
    assert not pr._is_mirror("nm000352") and pr._is_mirror("on000001")


def _integration_branch(bare: Path, tmp: Path, name: str, files: dict[str, str]) -> str:
    """A collaborator's branch on the remote: one foreign commit on top of main; returns its tip."""
    work = tmp / f"integ-{name}"
    _git(tmp, "clone", "-q", str(bare), str(work))
    _git(work, "checkout", "-q", "-b", name)
    for rel, text in files.items():
        (work / rel).parent.mkdir(parents=True, exist_ok=True)
        (work / rel).write_text(text)
    _git(work, "add", "--", *files)
    _git(
        work, "commit", "-q", "--author", "Collab Person <collab@example.org>", "-m", "Fix a thing"
    )
    _git(work, "push", "-q", "origin", name)
    return _git(work, "rev-parse", "HEAD").strip()


def _create_call(log: Path) -> dict:
    return next(c for c in _calls(log) if c["args"][:2] == ["pr", "create"])


def test_from_ref_keeps_a_collaborators_version_and_puts_the_geometry_on_top(env, tmp_path):
    served, bare, log, work = env
    foreign = _integration_branch(
        bare,
        tmp_path,
        "integ",
        {"dataset_description.json": '{"Name": "x", "Version": "1.0.4"}\n', "CHANGES": "1.0.3\n"},
    )
    assert _pr(served, work, "--from-ref", "integ", "--bump-version") == 0
    # one geometry commit on top of the foreign tip, pushed to the same branch; nothing else pushed
    assert _git(bare, "rev-parse", "integ~1").strip() == foreign
    assert _git(bare, "rev-list", "--count", f"{foreign}..integ").strip() == "1"
    assert _refs(bare) == ["refs/heads/integ", "refs/heads/main"]
    assert _git(bare, "rev-parse", "main").strip() == served.commit
    names = _git(bare, "diff", "--name-only", foreign, "integ").split()
    expected = [p for p in _expected_changes(served, tmp_path) if p != "dataset_description.json"]
    assert sorted(names) == expected  # no description change
    assert _blob(bare, "integ:dataset_description.json") == _blob(
        bare, f"{foreign}:dataset_description.json"
    )
    # the pull request is opened from the branch into main, and the body explains
    call = _create_call(log)
    assert call["args"][call["args"].index("--head") + 1] == "integ"
    assert call["args"][call["args"].index("--base") + 1] == "main"
    body = call["body"]
    assert "Integration branch `integ`: 1 commit(s) not on `main`" in body
    assert f"`{foreign[:7]}` `Collab Person: Fix a thing`" in body
    assert "is already `1.0.4`" in body and "tags `v1.0.4`" in body
    assert "CHANGES lists" not in body  # 1.0.3 is not ahead of 1.0.4


def test_from_ref_updates_an_open_pull_request_instead_of_opening_another(
    env, tmp_path, monkeypatch
):
    served, bare, log, work = env
    _integration_branch(bare, tmp_path, "integ", {"CHANGES": "1.0.0\n"})
    monkeypatch.setenv(
        "STANDIN_OPEN_PRS",
        '[{"number": 5, "url": "https://example.org/pull/5", '
        '"headRepositoryOwner": {"login": "nemarDatasets"}, "baseRefName": "main"}]',
    )
    assert _pr(served, work, "--from-ref", "integ") == 0
    verbs = [c["args"][:2] for c in _calls(log)]
    assert ["pr", "edit"] in verbs and ["pr", "create"] not in verbs
    edit = next(c for c in _calls(log) if c["args"][:2] == ["pr", "edit"])
    assert edit["args"][2] == "5" and "Integration branch `integ`" in edit["body"]


def test_from_ref_refuses_when_the_branch_moved_during_the_run(env, tmp_path, monkeypatch, capsys):
    served, bare, log, work = env
    foreign = _integration_branch(bare, tmp_path, "integ", {"CHANGES": "1.0.0\n"})
    real = pipeline.run_dataset

    def run_then_someone_pushes(*args, **kwargs):
        got = real(*args, **kwargs)
        _integration_branch_more(bare, tmp_path)
        return got

    monkeypatch.setattr(pipeline, "run_dataset", run_then_someone_pushes)
    assert _pr(served, work, "--from-ref", "integ") == 1
    assert "moved on the remote" in capsys.readouterr().err
    assert _git(bare, "rev-list", "--count", f"{foreign}..integ").strip() == "1"  # theirs only
    assert not _calls(log)


@pytest.mark.parametrize(
    "name", ["main", "refs/heads/main", "-f", "--delete", "a..b", "x.lock", "/x"]
)
def test_from_ref_refuses_main_and_anything_but_a_plain_branch_name(env, capsys, name):
    served, bare, log, work = env
    assert _pr(served, work, f"--from-ref={name}") == 1
    assert "plain branch name" in capsys.readouterr().err
    assert _git(bare, "rev-parse", "main").strip() == served.commit and not _calls(log)


_MINE = {"headRepositoryOwner": {"login": "nemarDatasets"}, "baseRefName": "main"}


def test_from_ref_ignores_a_fork_pull_request_with_the_same_branch_name(env, tmp_path, monkeypatch):
    served, bare, log, work = env
    _integration_branch(bare, tmp_path, "integ", {"CHANGES": "1.0.0\n"})
    fork = {"number": 8, "url": "u8", "headRepositoryOwner": {"login": "x"}, "baseRefName": "main"}
    monkeypatch.setenv("STANDIN_OPEN_PRS", json.dumps([fork]))
    assert _pr(served, work, "--from-ref", "integ") == 0
    verbs = [c["args"][:2] for c in _calls(log)]
    assert ["pr", "create"] in verbs and ["pr", "edit"] not in verbs


def test_from_ref_refuses_when_more_than_one_pull_request_remains(
    env, tmp_path, monkeypatch, capsys
):
    served, bare, log, work = env
    _integration_branch(bare, tmp_path, "integ", {"CHANGES": "1.0.0\n"})
    rows = [{"number": 5, "url": "u5", **_MINE}, {"number": 6, "url": "u6", **_MINE}]
    monkeypatch.setenv("STANDIN_OPEN_PRS", json.dumps(rows))
    assert _pr(served, work, "--from-ref", "integ") == 1
    assert "2 open pull requests" in capsys.readouterr().err
    assert not [c for c in _calls(log) if c["args"][:2] in (["pr", "edit"], ["pr", "create"])]


@pytest.mark.parametrize("how", ["rewound", "deleted"])
def test_from_ref_push_is_atomic_against_a_branch_rewound_or_deleted_at_the_last_moment(
    env, tmp_path, monkeypatch, capsys, how
):
    served, bare, log, work = env
    _integration_branch(bare, tmp_path, "integ", {"CHANGES": "1.0.0\n"})
    real = pr._git

    def git(clone, *a, **k):
        if a and a[0] == "push":  # after the ls-remote check, before the push
            if how == "rewound":
                _git(bare, "update-ref", "refs/heads/integ", served.commit)
            else:
                _git(bare, "update-ref", "-d", "refs/heads/integ")
        return real(clone, *a, **k)

    monkeypatch.setattr(pr, "_git", git)
    assert _pr(served, work, "--from-ref", "integ") == 1
    assert "git push failed" in capsys.readouterr().err
    left = _git(bare, "rev-parse", "--verify", "-q", "integ").strip() if how == "rewound" else ""
    assert left in ("", served.commit) and not _calls(log)


def _integration_branch_more(bare: Path, tmp: Path) -> None:
    work = tmp / "integ-more"
    _git(tmp, "clone", "-q", "--branch", "integ", str(bare), str(work))
    (work / "CHANGES").write_text("1.0.0\nmore\n")
    _git(work, "add", "CHANGES")
    _git(work, "commit", "-q", "-m", "a later push")
    _git(work, "push", "-q", "origin", "integ")


def test_from_ref_bumps_a_version_equal_to_mains(env, tmp_path):
    served, bare, log, work = env
    _advance(bare, tmp_path, {"dataset_description.json": '{"Name": "x", "Version": "1.0.0"}\n'})
    _integration_branch(bare, tmp_path, "integ", {"CHANGES": "2.0.0 upstream\n"})
    assert _pr(served, work, "--from-ref", "integ", "--bump-version") == 0
    assert b'"1.0.1"' in _blob(bare, "integ:dataset_description.json")
    body = _create_call(log)["body"]
    assert "goes from `1.0.0` to `1.0.1`" in body and "CHANGES lists 2.0.0" in body


def test_bump_version_chooses_above_main_when_main_is_ahead_of_the_tags(env, tmp_path):
    served, bare, log, work = env
    _advance(bare, tmp_path, {"dataset_description.json": '{"Name": "x", "Version": "1.0.2"}\n'})
    assert _pr(served, work, "--bump-version") == 0
    assert b'"1.0.3"' in _blob(bare, f"{BRANCH}:dataset_description.json")


def test_bump_version_refuses_a_malformed_version(env, tmp_path, capsys):
    served, bare, log, work = env
    _advance(bare, tmp_path, {"dataset_description.json": '{"Version": "1.0"}\n'})
    assert _pr(served, work, "--bump-version") == 1
    assert "not of the form" in capsys.readouterr().err
    assert not _calls(log)


def test_a_missing_release_tag_is_refused_for_a_real_run(env, capsys):
    served, bare, log, work = env
    _git(bare, "tag", "-d", VERSION)
    assert _pr(served, work) == 1
    assert f"no tag {VERSION} exists" in capsys.readouterr().err
    assert _refs(bare) == ["refs/heads/main"]


def test_a_real_run_refuses_a_remote_that_is_not_the_datasets_own(env):
    served, bare, log, work = env
    with pytest.raises(pr.PrRefusal, match="pushes only to the dataset's own repository"):
        pr.open_pr(DATASET_ID, work, version=VERSION, bump_version=True, urls=served.urls())
    assert not work.exists() and _refs(bare) == ["refs/heads/main"]
    # a dry run may read any remote
    pr.open_pr(
        DATASET_ID,
        work,
        version=VERSION,
        bump_version=True,
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


def test_a_gitattributes_lookalike_counts_as_a_dataset_file_and_is_listed(env, tmp_path):
    served, bare, log, work = env
    _advance(bare, tmp_path, {".gitattributesX": "x\n", ".nemar/metadata.json": "{}\n"})
    assert _pr(served, work) == 0
    body = _calls(log)[0]["body"]
    assert "- `.gitattributesX`" in body and "1 path(s) outside" in body


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


def test_an_nm_body_has_no_patch_release_step():
    body = pr.build_body({**REPORT, "dataset": "nm000352"}, {}, n_surface_sets=0)
    assert "nemar dataset release" not in body
