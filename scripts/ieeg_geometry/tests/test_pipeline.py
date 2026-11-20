"""The pipeline over a dataset: fetch, four tracks, the cross-track rule, the report, apply.

The dataset is composed from the committed track fixtures (labels `on006107` sub-01, FreeSurfer
`sub-p02` and `sub-p03`, SPM and subject surfaces `sub-2`, scanner-frame `sub-1`) and served from
a local git repository and data tree, so the real fetch code runs without a network.
"""

import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from ieeg_geometry import fetch, freesurfer, labels, pipeline, spm, surfaces_out
from ieeg_geometry.__main__ import main
from ieeg_geometry.ownership import OwnedPath, read_ownership, write_ownership
from ieeg_geometry.version import pipeline_version

from .remote import DATASET_ID, VERSION, Remote, _git, build_remote
from .test_spm import _add_native_surface, _inside_points, _native, _write_field

FIXTURES = Path(__file__).parent / "fixtures"
SCHEMA = json.loads(
    (Path(__file__).parents[1] / "schema" / "geometry-report.v1.json").read_text(encoding="utf-8")
)
SUB01 = "sub-01/ses-01/ieeg/sub-01_ses-01_electrodes.tsv"
P02 = "sub-p02/ses-umcuiemu01/ieeg/sub-p02_ses-umcuiemu01_acq-clinical_electrodes.tsv"
P03 = "sub-p03/ses-nyuecog01/ieeg/sub-p03_ses-nyuecog01_acq-clinical_electrodes.tsv"
SUB2 = "sub-2/ses-ieeg01/ieeg/sub-2_ses-ieeg01_electrodes.tsv"  # SPM field cropped: refused
SUB9 = "sub-9/ieeg/sub-9_electrodes.tsv"  # a full synthetic SPM field: verified and written


@pytest.fixture(scope="session")
def source(tmp_path_factory) -> Path:
    """One dataset exercising all four tracks (copies of the committed fixtures)."""
    out = tmp_path_factory.mktemp("combined") / "src"
    out.mkdir()
    for name in ("fs_dataset", "spm_dataset", "mini_dataset"):
        shutil.copytree(FIXTURES / name, out, dirs_exist_ok=True)
    shutil.copytree(FIXTURES / "labels" / "on006107", out, dirs_exist_ok=True)
    _add_spm_subject(out)
    return out


def _add_spm_subject(out: Path) -> None:
    """sub-9: 40 sEEG contacts, a full SPM12-grid field and the subject's own surface."""
    native = _native(_inside_points(40))
    ieeg = out / "sub-9" / "ieeg"
    ieeg.mkdir(parents=True)
    rows = ["name\tx\ty\tz\tsize\ttype\themisphere"]
    rows += [
        f"G{i + 1}\t{p[0]:.4f}\t{p[1]:.4f}\t{p[2]:.4f}\t4\tsEEG\tR" for i, p in enumerate(native)
    ]
    (ieeg / "sub-9_electrodes.tsv").write_text("\n".join(rows) + "\n")
    (ieeg / "sub-9_coordsystem.json").write_text(
        json.dumps({"iEEGCoordinateSystem": "Other", "iEEGCoordinateUnits": "mm"})
    )
    fdir = out / "derivatives" / "freesurfer" / "sub-9"
    fdir.mkdir(parents=True)
    _write_field(fdir / "y_sub-9_T1w.nii")
    _add_native_surface(out)


@pytest.fixture
def remote(source, tmp_path) -> Remote:
    return build_remote(source, tmp_path / "remote")


def _snapshot(root: Path) -> dict[str, str]:
    """Relative path -> content hash (a link by its target), `.git` left out."""
    out = {}
    for p in sorted(root.rglob("*")):
        rel = p.relative_to(root)
        if ".git" in rel.parts or p.is_dir():
            continue
        data = p.readlink().as_posix().encode() if p.is_symlink() else p.read_bytes()
        out[rel.as_posix()] = hashlib.sha256(data).hexdigest()
    return out


def _run(remote, workdir, *, apply=False, surfaces_out=None):
    return pipeline.run_dataset(
        DATASET_ID,
        workdir,
        version=VERSION,
        do_apply=apply,
        surfaces_out=surfaces_out,
        **remote.urls(),
    )


def _status(report, electrodes, track):
    row = next(r for r in report["files"] if r["electrodes"] == electrodes)
    return row["decisions"][track]["status"]


# ---- selection ---------------------------------------------------------------------------------


def test_select_paths_takes_what_the_tracks_read_and_never_recordings():
    paths = [
        "README.md",
        "dataset_description.json",
        ".nemar/ieeg-geometry.json",
        "participants.tsv",
        "sub-1/ieeg/sub-1_electrodes.tsv",
        "sub-1/ieeg/sub-1_coordsystem.json",
        "sub-1/ieeg/sub-1_electrodes.json",
        "electrodes.json",
        "sub-1/ieeg/sub-1_task-x_channels.tsv",
        "sub-1/ieeg/sub-1_task-x_ieeg.edf",
        "sub-1/ieeg/sub-1_task-x_events.tsv",
        "task-x_coordsystem.json",
        "derivatives/freesurfer/sub-1/surf/lh.pial",
        "derivatives/freesurfer/sub-1/surf/rh.sphere.reg",
        "derivatives/freesurfer/sub-1/mri/T1.mgz",
        "derivatives/freesurfer/sub-1/y_sub-1_T1w.nii",
        "derivatives/freesurfer/sub-1/pial.L.surf.gii",
        "derivatives/freesurfer/sub-1/sulc.L.shape.gii.json",
        "derivatives/freesurfer/fsaverage/surf/lh.pial",
        "derivatives/MNI_cortex_left.mat",
        "derivatives/sub-1/cortex_sub-1.mat",
    ]
    got = fetch.select_paths([fetch.TreeEntry(p, "100644") for p in paths])
    assert "sub-1/ieeg/sub-1_task-x_ieeg.edf" not in got and "participants.tsv" not in got
    assert "derivatives/freesurfer/sub-1/mri/T1.mgz" not in got
    assert "derivatives/freesurfer/fsaverage/surf/lh.pial" not in got  # no subject in the path
    assert "derivatives/MNI_cortex_left.mat" not in got
    assert "derivatives/freesurfer/sub-1/sulc.L.shape.gii.json" not in got
    assert {
        "README.md",
        "dataset_description.json",
        ".nemar/ieeg-geometry.json",
        "task-x_coordsystem.json",
        "electrodes.json",
        "sub-1/ieeg/sub-1_electrodes.json",
        "sub-1/ieeg/sub-1_task-x_channels.tsv",
        "derivatives/freesurfer/sub-1/surf/lh.pial",
        "derivatives/freesurfer/sub-1/surf/rh.sphere.reg",
        "derivatives/freesurfer/sub-1/y_sub-1_T1w.nii",
        "derivatives/freesurfer/sub-1/pial.L.surf.gii",
        "derivatives/sub-1/cortex_sub-1.mat",
    } <= set(got)


def test_fetch_downloads_only_the_selected_annexed_content(remote, tmp_path):
    got = fetch.fetch_files(DATASET_ID, tmp_path / "w", version=VERSION, **remote.urls())
    assert got.commit == remote.commit and got.version == VERSION and not got.failed
    clone = got.clone
    link = clone / "derivatives/freesurfer/sub-p02/surf/lh.pial"
    assert link.is_symlink() and link.exists()  # the annex object is in place
    assert not (clone / "sub-p02" / "ses-umcuiemu01" / "ieeg" / "x_ieeg.edf").exists()


def test_fetch_checks_out_electrodes_sidecars_at_every_level(tmp_path):
    src = tmp_path / "src"
    (src / "sub-1" / "ieeg").mkdir(parents=True)
    for rel in (
        "README.md",
        "dataset_description.json",
        "electrodes.json",
        "sub-1/ieeg/sub-1_electrodes.tsv",
        "sub-1/ieeg/sub-1_electrodes.json",
    ):
        (src / rel).write_text("{}\n" if rel.endswith(".json") else "x\n")
    remote = build_remote(src, tmp_path / "remote")
    got = fetch.fetch_files(
        DATASET_ID,
        tmp_path / "w",
        version=VERSION,
        repo_url=remote.repo_url,
        data_url=remote.data_url,
        api_url=remote.api_url,
    )
    assert not got.failed
    assert (got.clone / "electrodes.json").is_file()
    assert (got.clone / "sub-1/ieeg/sub-1_electrodes.json").is_file()


def test_fetch_resolves_the_version_from_the_api(remote, tmp_path):
    got = fetch.fetch_files(DATASET_ID, tmp_path / "w", **remote.urls())
    assert got.version == VERSION


# ---- the run -----------------------------------------------------------------------------------


@pytest.fixture
def dry(remote, tmp_path):
    analysis, written = _run(remote, tmp_path / "w")
    assert written == []
    return analysis.report, tmp_path / "w" / DATASET_ID


def test_one_run_exercises_all_four_tracks(dry):
    report, _ = dry
    assert _status(report, SUB01, "labels") == "written"
    assert _status(report, P02, "freesurfer") == "written"
    assert _status(report, P03, "freesurfer") == "written"
    assert _status(report, SUB9, "spm") == "written"
    assert _status(report, SUB2, "spm") == "refused"
    assert _status(report, "sub-1/ieeg/sub-1_space-ACPC_electrodes.tsv", "surfaces") in (
        "written",
        "skipped",
    )
    by_track = report["counts"]["by_track"]
    assert by_track["labels"]["written"] == 1
    assert by_track["freesurfer"]["written"] == 2
    assert by_track["spm"]["written"] == 1 and by_track["spm"]["refused"] == 2
    assert by_track["surfaces"]["written"] >= 1
    assert report["counts"]["electrodes_files"] == len(report["files"])


def test_the_report_matches_its_schema_and_names_version_commit_and_pipeline(dry, remote):
    report, _ = dry
    errors = list(Draft202012Validator(SCHEMA).iter_errors(report))
    assert not errors, errors[:3]
    assert report["schema"] == "nemar-ieeg-geometry-report" and report["version"] == 1
    assert report["dataset"] == DATASET_ID and report["dataset_version"] == VERSION
    assert report["source_commit"] == remote.commit
    assert report["pipeline_version"] == pipeline_version()
    assert report["mode"] == "dry-run"


def test_decisions_carry_reason_evidence_and_numbers(dry):
    report, _ = dry
    row = next(r for r in report["files"] if r["electrodes"] == P02)
    fs = row["decisions"]["freesurfer"]
    assert fs["evidence"] == "specific" and fs["numbers"]["n_placed"] == 56
    assert fs["outputs"] and all("space-fsaverage" in o for o in fs["outputs"])
    lab = next(r for r in report["files"] if r["electrodes"] == SUB01)["decisions"]["labels"]
    assert lab["evidence"] == "specific" and lab["numbers"]["label"] == "fsaverage"
    spm_decision = next(r for r in report["files"] if r["electrodes"] == SUB9)["decisions"]["spm"]
    assert spm_decision["outputs"] and "IXI549Space" in spm_decision["outputs"][0]
    assert spm_decision["reason"].startswith("paired by")


def test_decisions_carry_every_number_a_summary_needs(dry):
    report, _ = dry

    def nums(electrodes, track):
        row = next(r for r in report["files"] if r["electrodes"] == electrodes)
        return row["decisions"][track]["numbers"]

    lab = nums(SUB01, "labels")
    assert lab["label_rule"] in ("on-vertex-1.0mm", "ecog-2.0mm", "depth-plausible")
    fs = nums(P02, "freesurfer")
    assert fs["fit_rule"] == "ecog-2.0mm"
    for key in (
        "registration_side_fraction",
        "registration_centroid_mm",
        "registration_extent_error",
        "registration_affine_residual_mm",
    ):
        assert isinstance(fs[key], float), key
    sp = nums(SUB9, "spm")
    for key in (
        "field_check_median_mm",
        "field_check_p10_mm",
        "field_check_centroid_mm",
        "field_check_extent_deviation",
        "depth_contact_median_mm",
    ):
        assert isinstance(sp[key], float), key
    entries = report["surface_entries"]
    assert entries and all(e["fit_rule"] in ("ecog-2.0mm", "depth") for e in entries)


def test_the_dry_run_lists_every_file_an_apply_would_add(dry):
    report, clone = dry
    add = report["changes"]["add"]
    assert ".nemar/ieeg-geometry.json" in add
    assert any("sub-p02" in p and p.endswith("space-fsaverage_electrodes.tsv") for p in add)
    assert any("sub-01" in p and p.endswith("coordsystem.json") for p in add)
    assert report["changes"]["change"] == [] and report["changes"]["remove"] == []
    assert report["counts"]["changes"]["add"] == len(add)


def test_a_dry_run_writes_nothing(remote, tmp_path):
    work = tmp_path / "w"
    fetch.fetch_files(DATASET_ID, work, version=VERSION, **remote.urls())
    before = _snapshot(work / DATASET_ID)
    _run(remote, work)
    assert _snapshot(work / DATASET_ID) == before
    assert not list(work.glob(".surfaces-*"))


def test_the_report_is_deterministic(remote, tmp_path):
    a, _ = _run(remote, tmp_path / "w1")
    b, _ = _run(remote, tmp_path / "w2")
    assert pipeline.report_json(a.report) == pipeline.report_json(b.report)
    c, _ = _run(remote, tmp_path / "w1")  # the same work tree again
    assert pipeline.report_json(c.report) == pipeline.report_json(a.report)


# ---- apply -------------------------------------------------------------------------------------


def test_apply_writes_only_into_the_work_tree_and_the_surfaces_directory(remote, tmp_path):
    work, surfaces = tmp_path / "w", tmp_path / "surf"
    fetch.fetch_files(DATASET_ID, work, version=VERSION, **remote.urls())
    clone = work / DATASET_ID
    before = _snapshot(clone)
    served_before = _snapshot(remote.data_root)
    analysis, written = _run(remote, work, apply=True, surfaces_out=surfaces)
    after = _snapshot(clone)
    changed = {p for p in after if before.get(p) != after[p]} | (set(before) - set(after))
    planned = set(analysis.report["changes"]["add"]) | set(analysis.report["changes"]["change"])
    assert changed == planned  # exactly what the dry run said, nothing else
    assert set(written) <= planned
    assert _snapshot(remote.data_root) == served_before  # nothing is uploaded
    assert (surfaces / "geometry" / "index.json").exists()
    assert sorted(p.name for p in work.iterdir()) == [DATASET_ID]
    assert analysis.report["mode"] == "apply"
    index = json.loads((surfaces / "geometry" / "index.json").read_text())
    assert index["pipeline_version"] == pipeline_version()
    assert index["source_commit"] == remote.commit
    assert [e["electrodes"] for e in index["entries"]] == [
        e["electrodes"] for e in analysis.report["surface_entries"]
    ]


def test_apply_never_commits(remote, tmp_path):
    work = tmp_path / "w"
    _run(remote, work, apply=True)
    clone = work / DATASET_ID
    log = subprocess.run(
        ["git", "-C", str(clone), "log", "--oneline"], capture_output=True, text=True, check=True
    ).stdout.splitlines()
    assert len(log) == 1  # the clone's one upstream commit


def test_a_rerun_of_an_applied_tree_changes_nothing(remote, tmp_path):
    work = tmp_path / "w"
    _run(remote, work, apply=True)
    clone = work / DATASET_ID
    after_first = _snapshot(clone)
    second, _ = _run(remote, work, apply=True)
    assert _snapshot(clone) == after_first
    assert second.report["changes"] == {"add": [], "change": [], "remove": [], "kept": []}
    by_track = second.report["counts"]["by_track"]
    assert by_track["freesurfer"]["unchanged"] == 2 and by_track["freesurfer"]["written"] == 0
    assert by_track["spm"]["unchanged"] == 1 and by_track["labels"]["unchanged"] == 1


def test_a_hand_edited_owned_file_is_kept_and_reported(remote, tmp_path):
    work = tmp_path / "w"
    _run(remote, work, apply=True)
    clone = work / DATASET_ID
    edited = clone / P02.replace("_electrodes.tsv", "_space-fsaverage_electrodes.tsv")
    edited.write_text(edited.read_text() + "# edited\n")
    second, _ = _run(remote, work)
    assert _status(second.report, P02, "freesurfer") == "kept"
    assert str(edited.relative_to(clone)) in second.report["changes"]["kept"]


# ---- cross-track rule --------------------------------------------------------------------------


def test_the_label_plan_covers_what_it_writes(remote, tmp_path):
    clone = fetch.fetch_files(DATASET_ID, tmp_path / "w", version=VERSION, **remote.urls()).clone
    plan = labels.plan_dataset(clone)
    assert pipeline.label_coverage(plan, clone) == {("01", "01"): {"fsaverage"}}


def test_freesurfer_never_writes_a_space_an_earlier_track_covers(remote, tmp_path):
    clone = fetch.fetch_files(DATASET_ID, tmp_path / "w", version=VERSION, **remote.urls()).clone
    results = freesurfer.plan_dataset(clone)
    p02 = next(r for r in results if r.subject == "p02")
    assert [o.label for o in p02.outputs] == ["fsaverage"]
    covered: pipeline.Coverage = {("p02", "umcuiemu01"): {"fsaverage"}}
    pipeline.guard_freesurfer(results, covered)
    assert p02.outputs == []
    assert p02.skipped[-1].reason == pipeline.EARLIER_TRACK
    p03 = next(r for r in results if r.subject == "p03")
    assert [o.label for o in p03.outputs] == ["fsaverage"]  # another subject is untouched
    assert covered[("p03", "nyuecog01")] == {"fsaverage"}  # a kept output becomes cover


def test_spm_never_writes_a_space_an_earlier_track_covers(remote, tmp_path):
    clone = fetch.fetch_files(DATASET_ID, tmp_path / "w", version=VERSION, **remote.urls()).clone
    plans = spm.plan_dataset(clone)
    plan = next(p for p in plans if p.subject == "9")
    assert plan.verdict == "write"
    notes = pipeline.guard_spm(plans, {("9", None): {"ixi549space"}})
    assert plan.verdict == "refused" and plan.files == {} and notes
    assert "earlier track" in plan.reason


def test_an_owned_path_of_an_earlier_run_covers_the_same_space(remote, tmp_path):
    """A rerun: the label track owns space-fsaverage for p02, so FreeSurfer must not write it."""
    work = tmp_path / "w"
    clone = fetch.fetch_files(DATASET_ID, work, version=VERSION, **remote.urls()).clone
    path = P02.replace("_electrodes.tsv", "_space-fsaverage_electrodes.tsv")
    write_ownership(
        clone, pipeline_version(), [OwnedPath(path, "electrodes", (), "label-inference:sidecar")]
    )
    analysis, _ = _run(remote, work)
    decision = next(r for r in analysis.report["files"] if r["electrodes"] == P02)["decisions"]
    assert decision["freesurfer"]["status"] == "skipped"
    assert pipeline.EARLIER_TRACK in decision["freesurfer"]["reason"]
    assert not any(path in p for p in analysis.report["changes"]["add"])


def test_the_authors_files_win_over_every_track(remote, tmp_path):
    work = tmp_path / "w"
    clone = fetch.fetch_files(DATASET_ID, work, version=VERSION, **remote.urls()).clone
    folder = clone / Path(P03).parent
    for suffix in ("electrodes.tsv", "coordsystem.json"):
        src = folder / f"sub-p03_ses-nyuecog01_acq-clinical_{suffix}"
        (folder / f"sub-p03_ses-nyuecog01_acq-clinical_space-fsaverage_{suffix}").write_bytes(
            src.read_bytes()
        )
    analysis, _ = _run(remote, work)
    assert not any(
        "sub-p03" in p and "space-fsaverage" in p for p in analysis.report["changes"]["add"]
    )


# ---- refusals and failures ---------------------------------------------------------------------


@pytest.mark.parametrize(
    "dataset_id",
    ["nm000103", "nm000104", "nm000105", "nm000106", "nm000107", "nm099998"],
)
def test_live_and_standing_datasets_are_refused_outright(dataset_id, tmp_path, capsys):
    work = tmp_path / "w"
    assert main(["run", dataset_id, "--workdir", str(work)]) == 1
    assert "refuses it" in capsys.readouterr().err
    assert not work.exists()  # not even cloned


@pytest.mark.parametrize(
    "dataset_id",
    ["../etc", "nm000103\n", "nm000103 ", "nm\u0660\u0660\u0660\u0661\u0660\u0663", "NM000103"],
)
def test_a_malformed_id_is_refused(dataset_id, tmp_path, capsys):
    assert main(["run", dataset_id, "--workdir", str(tmp_path / "w")]) == 1
    assert "not a dataset id" in capsys.readouterr().err
    assert not (tmp_path / "w").exists()


def test_a_tree_failure_fails_the_run_with_a_clear_message(remote, tmp_path, capsys, monkeypatch):
    rc = main(
        ["run", DATASET_ID, "--workdir", str(tmp_path / "w"), "--version", VERSION],
        urls=dict(remote.urls(), repo_url=f"file://{tmp_path}/nowhere/{{id}}"),
    )
    assert rc == 1 and "git clone failed" in capsys.readouterr().err


def test_a_version_failure_fails_the_run_with_a_clear_message(
    remote, tmp_path, capsys, monkeypatch
):
    rc = main(
        ["run", DATASET_ID, "--workdir", str(tmp_path / "w")],
        urls=dict(remote.urls(), api_url=f"file://{tmp_path}/missing/{{id}}.json"),
    )
    err = capsys.readouterr().err
    assert rc == 1 and "cannot read the version" in err


def test_the_cli_prints_one_json_report(remote, tmp_path, capsys, monkeypatch):
    assert main(["run", DATASET_ID, "--workdir", str(tmp_path / "w")], urls=remote.urls()) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["dataset_version"] == VERSION and report["mode"] == "dry-run"
    assert not list(Draft202012Validator(SCHEMA).iter_errors(report))


def test_apply_without_surfaces_out_says_the_surfaces_were_not_written(
    remote, tmp_path, capsys, monkeypatch
):
    assert (
        main(["run", DATASET_ID, "--workdir", str(tmp_path / "w"), "--apply"], urls=remote.urls())
        == 0
    )
    report = json.loads(capsys.readouterr().out)
    assert "surfaces not written: no --surfaces-out" in report["warnings"]


def test_a_file_that_cannot_be_fetched_is_skipped_with_its_reason(source, tmp_path):
    remote = build_remote(
        source, tmp_path / "remote", extra_annexed=(SUB01,), missing_data=(SUB01,)
    )
    analysis, _ = _run(remote, tmp_path / "w")
    row = next(r for r in analysis.report["files"] if r["electrodes"] == SUB01)
    for track in ("labels", "freesurfer", "spm", "surfaces"):
        d = row["decisions"][track]
        assert d["status"] == "skipped" and d["reason"].startswith("fetch failed")
    assert any(w.startswith("not fetched: " + SUB01) for w in analysis.report["warnings"])
    assert not any("sub-01" in p for p in analysis.report["changes"]["add"])
    assert _status(analysis.report, P02, "freesurfer") == "written"  # the rest of the run goes on


def test_downloaded_content_must_match_its_annex_key(source, tmp_path):
    bad = "derivatives/freesurfer/sub-p02/surf/lh.pial"
    remote = build_remote(source, tmp_path / "remote", corrupt_data=(bad,))
    got = fetch.fetch_files(
        DATASET_ID,
        tmp_path / "w",
        version=VERSION,
        repo_url=remote.repo_url,
        data_url=remote.data_url,
        api_url=remote.api_url,
    )
    assert "do not match the annex key" in got.failed[bad]
    assert not (got.clone / bad).exists()


def test_a_dataset_level_file_that_cannot_be_fetched_fails_the_run(source, tmp_path):
    remote = build_remote(
        source,
        tmp_path / "remote",
        extra_annexed=("dataset_description.json",),
        missing_data=("dataset_description.json",),
    )
    with pytest.raises(fetch.FetchError, match="dataset_description.json"):
        _run(remote, tmp_path / "w")


def test_a_fetch_over_the_limit_stops_the_run(remote, tmp_path):
    with pytest.raises(fetch.FetchError, match="over the"):
        fetch.fetch_files(
            DATASET_ID, tmp_path / "w", version=VERSION, max_bytes=1000, **remote.urls()
        )


# ---- one pipeline version ----------------------------------------------------------------------


def test_every_module_uses_the_one_strict_pipeline_version():
    assert labels.pipeline_version is pipeline_version
    assert freesurfer.pipeline_version is pipeline_version
    assert spm.pipeline_version is pipeline_version
    assert surfaces_out.pipeline_version is pipeline_version


def test_a_missing_package_fails_the_run_instead_of_naming_unknown(
    remote, tmp_path, capsys, monkeypatch
):
    from importlib import metadata

    def absent(name):
        raise metadata.PackageNotFoundError(name)

    monkeypatch.setattr(metadata, "version", absent)
    rc = main(
        ["run", DATASET_ID, "--workdir", str(tmp_path / "w"), "--version", VERSION],
        urls=remote.urls(),
    )
    assert rc == 1 and "not installed" in capsys.readouterr().err
    assert not (tmp_path / "w").exists()  # failed before any network use
    with pytest.raises(metadata.PackageNotFoundError):
        surfaces_out.build_geometry(tmp_path, tmp_path / "out", source_commit="abc")


def test_ownership_written_by_every_track_names_the_same_version(remote, tmp_path):
    work = tmp_path / "w"
    _run(remote, work, apply=True)
    ownership = read_ownership(work / DATASET_ID)
    assert ownership is not None and ownership.pipeline_version == pipeline_version()
    methods = {e.method.split(":")[0] for e in ownership.entries}
    assert {"label-inference", "freesurfer-sphere-reg-fsaverage6", "spm-deformation-inversion"} <= (
        methods
    )


def test_a_file_the_pipeline_wrote_that_no_longer_verifies_is_listed_for_removal(remote, tmp_path):
    work = tmp_path / "w"
    _run(remote, work, apply=True)
    clone = work / DATASET_ID
    electrodes = clone / SUB9
    lines = electrodes.read_text().splitlines()
    moved = [lines[0]] + [
        "\t".join([c[0], f"{float(c[1]) + 60:.3f}", *c[2:]])
        for c in (ln.split("\t") for ln in lines[1:])
    ]
    electrodes.write_text("\n".join(moved) + "\n")
    second, _ = _run(remote, work)
    owned = [p for p in second.report["changes"]["remove"] if "sub-9" in p]
    assert len(owned) == 2 and all("space-IXI549Space" in p for p in owned)
    assert _status(second.report, SUB9, "spm") in ("refused", "needs-human")
    third, _ = _run(remote, work, apply=True)  # the apply does what the dry run said
    assert not any((clone / p).exists() for p in owned)
    ownership = read_ownership(clone)
    assert ownership is not None
    assert not any("sub-9" in e.path for e in ownership.entries)
    assert third.report["changes"]["remove"] == second.report["changes"]["remove"]


# ---- review round 1 ----------------------------------------------------------------------------


def _fetch(remote, tmp_path, **kw):
    return fetch.fetch_files(
        DATASET_ID,
        tmp_path / "w",
        version=VERSION,
        repo_url=remote.repo_url,
        data_url=remote.data_url,
        api_url=remote.api_url,
        **kw,
    )


def _plant_link(source, tmp_path, link_target: str) -> tuple[Remote, str]:
    """A repository whose `lh.pial` link has an attacker-chosen target."""
    remote = build_remote(source, tmp_path / "remote")
    rel = "derivatives/freesurfer/sub-p02/surf/lh.pial"
    repo = tmp_path / "remote" / "repos" / DATASET_ID
    key = Path(os.readlink(repo / rel)).name
    (repo / rel).unlink()
    (repo / rel).symlink_to(link_target.replace("KEY", key))
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "evil link")
    return remote, rel


def test_a_relative_link_that_leaves_the_clone_is_not_followed(source, tmp_path):
    outside = tmp_path / "escape"
    remote, rel = _plant_link(
        source, tmp_path, "../../../../../../escape/.git/annex/objects/ab/cd/KEY/KEY"
    )
    got = _fetch(remote, tmp_path)
    assert "outside the clone" in got.failed[rel]
    assert not outside.exists()


def test_an_absolute_link_target_is_refused(source, tmp_path):
    outside = tmp_path / "abs"
    remote, rel = _plant_link(source, tmp_path, f"{outside}/.git/annex/objects/ab/cd/KEY/KEY")
    got = _fetch(remote, tmp_path)
    assert "not a relative git-annex key" in got.failed[rel]
    assert not outside.exists()


def test_an_existing_object_outside_the_clone_is_not_reported_as_fetched(source, tmp_path):
    remote, rel = _plant_link(
        source, tmp_path, "../../../../../../escape/.git/annex/objects/ab/cd/KEY/KEY"
    )
    repo = tmp_path / "remote" / "repos" / DATASET_ID
    key = Path(os.readlink(repo / rel)).name
    planted = tmp_path / "escape" / ".git" / "annex" / "objects" / "ab" / "cd" / key / key
    planted.parent.mkdir(parents=True)
    planted.write_bytes(b"outside")
    got = _fetch(remote, tmp_path)
    assert "outside the clone" in got.failed[rel] and rel not in got.fetched
    assert planted.read_bytes() == b"outside"


def test_a_body_larger_than_its_key_is_rejected_without_buffering_it(source, tmp_path):
    bad = "derivatives/freesurfer/sub-p02/surf/lh.pial"
    remote = build_remote(source, tmp_path / "remote")
    served = remote.data_root / DATASET_ID / VERSION / bad
    served.write_bytes(served.read_bytes() + b"X" * 5000)
    got = _fetch(remote, tmp_path)
    assert "larger than" in got.failed[bad]


def test_a_truncated_body_is_rejected(source, tmp_path):
    bad = "derivatives/freesurfer/sub-p02/surf/lh.pial"
    remote = build_remote(source, tmp_path / "remote")
    served = remote.data_root / DATASET_ID / VERSION / bad
    served.write_bytes(served.read_bytes()[:-10])
    got = _fetch(remote, tmp_path)
    assert "do not match the annex key" in got.failed[bad]


def test_a_path_with_a_space_or_a_hash_is_quoted_in_the_url(source, tmp_path):
    odd = "derivatives/freesurfer/sub-p02/surf/lh.pial"
    renamed = "derivatives/freesurfer/sub-p02 x#y/surf/lh.pial"
    src = tmp_path / "src2"
    shutil.copytree(source, src)
    (src / renamed).parent.mkdir(parents=True)
    shutil.copy(src / odd, src / renamed)
    remote = build_remote(src, tmp_path / "remote")
    served = remote.data_root / DATASET_ID / VERSION / renamed
    assert served.exists()
    got = _fetch(remote, tmp_path)
    assert renamed not in got.failed and renamed in got.fetched


def test_the_backoff_doubles_between_attempts(monkeypatch):
    naps: list[float] = []
    monkeypatch.setattr(fetch.time, "sleep", naps.append)
    with pytest.raises(OSError):
        fetch._get("http://127.0.0.1:9/x", 10)  # refused connection, retried
    assert naps == [fetch._BACKOFF_S, fetch._BACKOFF_S * 2]


def test_apply_fails_closed_when_a_track_errored(remote, tmp_path, monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError("boom")

    monkeypatch.setattr(spm, "plan_dataset", boom)
    work, surfaces = tmp_path / "w", tmp_path / "surf"
    fetch.fetch_files(DATASET_ID, work, version=VERSION, **remote.urls())
    before = _snapshot(work / DATASET_ID)
    analysis, written = _run(remote, work, apply=True, surfaces_out=surfaces)
    assert written == [] and "spm" in analysis.errors
    assert _snapshot(work / DATASET_ID) == before and not surfaces.exists()
    assert "apply skipped: a track failed" in analysis.report["warnings"]


def test_the_cli_exits_2_and_prints_the_report_when_a_track_errored(
    remote, tmp_path, capsys, monkeypatch
):
    def boom(*_a, **_k):
        raise RuntimeError("boom")

    monkeypatch.setattr(freesurfer, "plan_dataset", boom)
    rc = main(["run", DATASET_ID, "--workdir", str(tmp_path / "w"), "--apply"], urls=remote.urls())
    report = json.loads(capsys.readouterr().out)
    assert rc == 2 and any("freesurfer track failed" in w for w in report["warnings"])


def test_a_failed_label_plan_still_guards_the_later_tracks(remote, tmp_path, monkeypatch):
    work = tmp_path / "w"
    clone = fetch.fetch_files(DATASET_ID, work, version=VERSION, **remote.urls()).clone
    path = P02.replace("_electrodes.tsv", "_space-fsaverage_electrodes.tsv")
    write_ownership(
        clone, pipeline_version(), [OwnedPath(path, "electrodes", (), "label-inference:sidecar")]
    )

    def boom(*_a, **_k):
        raise RuntimeError("boom")

    monkeypatch.setattr(labels, "plan_dataset", boom)
    analysis, _ = _run(remote, work)
    fs = next(r for r in analysis.report["files"] if r["electrodes"] == P02)["decisions"]
    assert "labels" in analysis.errors
    assert pipeline.EARLIER_TRACK in fs["freesurfer"]["reason"]


def test_surfaces_out_mirrors_exactly_the_new_index(remote, tmp_path):
    work, surfaces = tmp_path / "w", tmp_path / "surf"
    _run(remote, work, apply=True, surfaces_out=surfaces)
    meshes = surfaces / "geometry" / "meshes"
    stale = meshes / ("0" * 64 + ".mesh.bin")
    stale.write_bytes(b"old")
    (surfaces / "keep.txt").write_text("outside geometry/")
    _run(remote, work, apply=True, surfaces_out=surfaces)
    index = json.loads((surfaces / "geometry" / "index.json").read_text())
    named = {m["path"] for e in index["entries"] for m in e["meshes"].values()}
    on_disk = {p.relative_to(surfaces / "geometry").as_posix() for p in meshes.iterdir()}
    assert named == on_disk and not stale.exists()
    assert (surfaces / "keep.txt").exists()


def test_a_nested_failed_sidecar_excludes_its_subjects_electrodes(source, tmp_path):
    nested = "sourcedata/sub-01/ieeg/sub-01_ses-01_coordsystem.json"
    src = tmp_path / "src3"
    shutil.copytree(source, src)
    (src / nested).parent.mkdir(parents=True)
    (src / nested).write_text("{}")
    remote = build_remote(src, tmp_path / "remote", extra_annexed=(nested,), missing_data=(nested,))
    got = _fetch(remote, tmp_path)
    assert nested in got.failed
    assert SUB01 in got.excluded and not (got.clone / SUB01).exists()
    assert P02 not in got.excluded


def test_a_crash_between_the_swap_renames_is_recovered_at_the_next_run(remote, tmp_path):
    work, surfaces = tmp_path / "w", tmp_path / "surf"
    _run(remote, work, apply=True, surfaces_out=surfaces)
    _run(remote, work, apply=True, surfaces_out=surfaces)  # a rerun sees the applied files
    expected = (surfaces / "geometry" / "index.json").read_bytes()
    # the crash state: geometry/ already moved aside, the new one not yet in place
    (surfaces / "geometry").rename(surfaces / ".geometry.old")
    (surfaces / ".geometry.new").mkdir()
    (surfaces / ".geometry.new" / "partial").write_text("x")
    _run(remote, work, surfaces_out=surfaces)  # even a dry run restores first
    assert (surfaces / "geometry" / "index.json").read_bytes() == expected
    assert not (surfaces / ".geometry.old").exists()
    # and an apply after a crash ends with exactly the new tree and no leftovers
    (surfaces / "geometry").rename(surfaces / ".geometry.old")
    _run(remote, work, apply=True, surfaces_out=surfaces)
    assert (surfaces / "geometry" / "index.json").read_bytes() == expected
    assert sorted(p.name for p in surfaces.iterdir()) == ["geometry"]


def test_a_symlinked_parent_directory_leading_outside_the_clone_is_refused(source, tmp_path):
    remote = build_remote(source, tmp_path / "remote")
    first = _fetch(remote, tmp_path)
    clone = first.clone
    surf = clone / "derivatives/freesurfer/sub-p02/surf"
    outside = tmp_path / "outside"
    outside.mkdir()
    rel = "derivatives/freesurfer/sub-p02/surf/lh.pial"
    shutil.move(str(surf), str(outside / "surf"))
    surf.symlink_to(outside / "surf")
    # a reused clone: the link now sits beneath a symlinked directory
    (outside / "surf" / "lh.pial").unlink()
    key = "MD5E-s5--" + hashlib.md5(b"hello").hexdigest() + ".pial"  # noqa: S324
    (outside / "surf" / "lh.pial").symlink_to(f"../../../../.git/annex/objects/ab/cd/{key}/{key}")
    before = _snapshot(outside)
    got = _fetch(remote, tmp_path)
    assert "outside the clone" in got.failed[rel] and rel not in got.fetched
    assert _snapshot(outside) == before
    assert not (tmp_path / ".git").exists() and not list(outside.rglob(".git"))


def test_a_rerun_on_an_applied_tree_gives_a_byte_identical_surface_index(remote, tmp_path):
    work, first, second = tmp_path / "w", tmp_path / "s1", tmp_path / "s2"
    a, _ = _run(remote, work, apply=True, surfaces_out=first)
    applied = a.report["changes"]["add"]
    assert any("space-fsaverage" in p for p in applied) and any(
        "space-IXI549Space" in p for p in applied
    )
    b, _ = _run(remote, work, apply=True, surfaces_out=second)
    assert (first / "geometry" / "index.json").read_bytes() == (
        second / "geometry" / "index.json"
    ).read_bytes()
    listed = json.dumps(b.report["surface_entries"]) + json.dumps(
        [r["decisions"]["surfaces"] for r in b.report["files"]]
    )
    assert "space-fsaverage" not in listed and "space-IXI549Space" not in listed
    assert sorted(p.name for p in (first / "geometry" / "meshes").iterdir()) == sorted(
        p.name for p in (second / "geometry" / "meshes").iterdir()
    )


def test_a_registration_refusal_record_carries_the_measurement():
    reg = freesurfer.RegistrationCheck(
        n_sampled=2000,
        side_fraction=0.9,
        centroid_mm=6.25,
        extent_error=0.2,
        affine_residual_mm=20.0,
    )
    assert pipeline._registration_numbers(reg) == {
        "registration_side_fraction": 0.9,
        "registration_centroid_mm": 6.25,
        "registration_extent_error": 0.2,
        "registration_affine_residual_mm": 20.0,
    }
    assert pipeline._registration_numbers(None) == {}
