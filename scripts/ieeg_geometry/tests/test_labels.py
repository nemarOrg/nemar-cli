"""Label inference: real excerpts of public CC0 datasets (see fixtures/labels/README.md)."""

import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from ieeg_geometry import labels, load_reference, read_ownership
from ieeg_geometry.bids import GeometryRefusal

FIX = Path(__file__).parent / "fixtures" / "labels"
HEADER = "name\tx\ty\tz\tsize\n"


@pytest.fixture
def no_sidecar(tmp_path) -> Path:
    """on006107 sub-01: ECoG contacts on fsaverage, no coordsystem, README silent."""
    shutil.copytree(FIX / "on006107", tmp_path / "ds")
    return tmp_path / "ds"


@pytest.fixture
def native_sidecar(tmp_path) -> Path:
    """on006910 sub-001: contacts on fsaverage, coordsystem says patient-native RAS."""
    shutil.copytree(FIX / "on006910", tmp_path / "ds")
    return tmp_path / "ds"


@pytest.fixture
def readme_only(tmp_path) -> Path:
    """on004551 sub-001: no coordsystem, README names MNI305."""
    shutil.copytree(FIX / "on004551", tmp_path / "ds")
    return tmp_path / "ds"


def _tree(root: Path) -> dict[str, bytes]:
    return {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()}


def _only(plan: labels.Plan) -> labels.Proposal:
    assert len(plan.proposals) == 1
    return plan.proposals[0]


def _shift(path: Path, delta: float) -> None:
    lines = path.read_text().splitlines()
    out = [lines[0]]
    for line in lines[1:]:
        c = line.split("\t")
        c[1:4] = [str(float(v) + delta) for v in c[1:4]]
        out.append("\t".join(c))
    path.write_text("\n".join(out) + "\n")


def _points_file(root: Path, points: np.ndarray, name="sub-1_electrodes.tsv") -> Path:
    path = root / "sub-1" / "ieeg" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = [f"C{i}\t{x:.8f}\t{y:.8f}\t{z:.8f}\t0" for i, (x, y, z) in enumerate(points)]
    path.write_text(HEADER + "\n".join(rows) + "\n")
    return path


def _sidecar(path: Path, frame: str, **extra) -> None:
    body = {"iEEGCoordinateSystem": frame, "iEEGCoordinateUnits": "mm", **extra}
    path.with_name(path.name.replace("_electrodes.tsv", "_coordsystem.json")).write_text(
        json.dumps(body)
    )


def _mni_points(scale=1.0, n=80) -> np.ndarray:
    verts = load_reference("MNI152NLin2009cAsym")[0].vertices
    idx = np.random.default_rng(0).choice(len(verts), n, replace=False)
    return verts[idx] * scale


# --- the acceptance cases ---------------------------------------------------------------------


def test_missing_coordsystem_gets_a_fsaverage_sidecar(no_sidecar):
    prop = _only(labels.plan_dataset(no_sidecar))
    assert prop.status == labels.ACCEPTED and prop.label == "fsaverage"
    assert prop.attempts[0].source == "blind trial" and prop.attempts[0].grade == "specific"
    (planned,) = prop.files
    assert planned.path == "sub-01/ses-01/ieeg/sub-01_ses-01_coordsystem.json"
    assert not (no_sidecar / planned.path).exists()  # a plan writes nothing
    written = labels.write(labels.plan_dataset(no_sidecar), no_sidecar)
    doc = json.loads(written[0].read_text())
    assert doc["iEEGCoordinateSystem"] == "fsaverage" and doc["iEEGCoordinateUnits"] == "mm"
    assert doc["iEEGCoordinateProcessingDescription"].startswith("Computed by NEMAR")
    assert (
        "sub-01/ses-01/ieeg/sub-01_ses-01_electrodes.tsv"
        in doc["iEEGCoordinateProcessingDescription"]
    )
    assert "median 0.73 mm" in doc["iEEGCoordinateProcessingDescription"]
    assert "Units assumed mm, confirmed by the fit." in doc["iEEGCoordinateProcessingDescription"]
    assert "geometric verification" in doc["iEEGCoordinateSystemDescription"]
    assert doc["iEEGCoordinateProcessingReference"] == "https://docs.nemar.org/data/ieeg-geometry/"
    owned = read_ownership(no_sidecar)
    assert owned is not None and [e.path for e in owned.entries] == [planned.path]
    assert owned.entries[0].verification is not None
    assert owned.entries[0].verification.reference == "fsaverage"
    assert owned.entries[0].inputs[0][0].endswith("_electrodes.tsv")


def test_native_coordsystem_is_untouched_and_a_space_pair_is_added(native_sidecar):
    before = _tree(native_sidecar)
    prop = _only(labels.plan_dataset(native_sidecar))
    assert prop.status == labels.ACCEPTED and prop.label == "fsaverage"
    assert prop.attempts[0].label == "MNI305" and prop.attempts[0].source == "README"
    labels.write(labels.plan_dataset(native_sidecar), native_sidecar)
    after = _tree(native_sidecar)
    ieeg = "sub-001/ses-1/ieeg/sub-001_ses-1"
    for name, content in before.items():
        assert after[name] == content  # the authors' files are byte-identical
    new = sorted(set(after) - set(before))
    assert new == [
        ".nemar/ieeg-geometry.json",
        f"{ieeg}_space-fsaverage_coordsystem.json",
        f"{ieeg}_space-fsaverage_electrodes.tsv",
    ]
    assert after[f"{ieeg}_space-fsaverage_electrodes.tsv"] == before[f"{ieeg}_electrodes.tsv"]
    doc = json.loads(after[f"{ieeg}_space-fsaverage_coordsystem.json"])
    assert doc["iEEGCoordinateSystem"] == "fsaverage" and doc["iEEGCoordinateUnits"] == "mm"
    assert "MNI-305" in doc["iEEGCoordinateProcessingDescription"]  # the authors' word is kept
    owned = read_ownership(native_sidecar)
    assert owned is not None and len(owned.entries) == 2


def test_readme_names_the_template_for_a_missing_sidecar(readme_only):
    prop = _only(labels.plan_dataset(readme_only))
    assert prop.status == labels.ACCEPTED and prop.attempts[0].source == "README"


@pytest.mark.parametrize("fixture", ["no_sidecar", "native_sidecar"])
def test_contacts_shifted_20_mm_are_rejected(fixture, request):
    ds = request.getfixturevalue(fixture)
    for tsv in ds.rglob("*_electrodes.tsv"):
        _shift(tsv, 20.0)
    prop = _only(labels.plan_dataset(ds))
    assert prop.status == labels.REJECTED and not prop.files
    assert labels.write(labels.plan_dataset(ds), ds) == []
    assert not (ds / ".nemar").exists()


def test_a_named_template_that_does_not_fit_is_rejected(native_sidecar):
    for tsv in native_sidecar.rglob("*_electrodes.tsv"):
        _shift(tsv, 20.0)
    prop = _only(labels.plan_dataset(native_sidecar))
    assert prop.attempts[0].label == "MNI305" and not prop.attempts[0].accepted
    assert prop.attempts[0].reason == "fit failed"


@pytest.mark.parametrize("frame", ["MNI", "MNI152", "mni space", "MNI152NLin2009c"])
def test_mni_without_variant_is_reported_and_not_written(no_sidecar, frame):
    elec = next(no_sidecar.rglob("*_electrodes.tsv"))
    _sidecar(elec, frame)
    prop = _only(labels.plan_dataset(no_sidecar))
    assert (
        prop.status == labels.NEEDS_HUMAN
        and prop.reason == "MNI variant unknown, needs a human label"
    )
    assert not prop.files and "MNI variant unknown" in "\n".join(prop.lines())
    assert labels.write(labels.plan_dataset(no_sidecar), no_sidecar) == []
    assert sorted(p.name for p in elec.parent.iterdir()) == sorted(
        [elec.name, elec.name.replace("electrodes.tsv", "coordsystem.json")]
        + [p.name for p in elec.parent.glob("*channels.tsv")]
    )


def test_unspecific_mni_in_the_readme_blocks_a_blind_write(no_sidecar):
    (no_sidecar / "README.md").write_text("Contacts are given in MNI space.\n")
    prop = _only(labels.plan_dataset(no_sidecar))
    assert prop.status == labels.NEEDS_HUMAN and not prop.files


def test_a_specific_name_beats_an_unspecific_mni(no_sidecar):
    (no_sidecar / "README.md").write_text("MNI space, precisely MNI305.\n")
    assert _only(labels.plan_dataset(no_sidecar)).status == labels.ACCEPTED


@pytest.mark.parametrize("frame", ["ACPC", "ScanRAS", "acpc"])
def test_acpc_and_scanras_are_never_relabeled(no_sidecar, frame):
    elec = next(no_sidecar.rglob("*_electrodes.tsv"))
    _sidecar(elec, frame)  # contacts really sit on fsaverage; the declaration still wins
    prop = _only(labels.plan_dataset(no_sidecar))
    assert prop.status == labels.SKIPPED and not prop.files and not prop.attempts


def test_intended_for_own_t1_is_never_relabeled(native_sidecar):
    coord = next(native_sidecar.rglob("*_coordsystem.json"))
    doc = json.loads(coord.read_text())
    doc["IntendedFor"] = "bids::sub-001/ses-1/anat/sub-001_ses-1_T1w.nii.gz"
    coord.write_text(json.dumps(doc))
    prop = _only(labels.plan_dataset(native_sidecar))
    assert prop.status == labels.SKIPPED and not prop.files


def test_space_entity_files_are_not_relabeled(no_sidecar):
    elec = next(no_sidecar.rglob("*_electrodes.tsv"))
    elec.rename(elec.with_name(elec.name.replace("_electrodes", "_space-ACPC_electrodes")))
    prop = _only(labels.plan_dataset(no_sidecar))
    assert prop.status == labels.SKIPPED


@pytest.mark.parametrize("fixture", ["no_sidecar", "native_sidecar"])
def test_second_run_writes_nothing_and_changes_no_byte(fixture, request):
    ds = request.getfixturevalue(fixture)
    assert labels.write(labels.plan_dataset(ds), ds)
    first = _tree(ds)
    second_plan = labels.plan_dataset(ds)
    assert not second_plan.files
    assert {p.status for p in second_plan.proposals} <= {labels.ALREADY, labels.SKIPPED}
    assert labels.write(second_plan, ds) == []
    assert _tree(ds) == first


def test_authors_template_file_means_nothing_is_written(native_sidecar):
    ieeg = native_sidecar / "sub-001" / "ses-1" / "ieeg"
    (ieeg / "sub-001_ses-1_space-fsaverage_electrodes.tsv").write_text(HEADER)
    props = labels.plan_dataset(native_sidecar).proposals
    (orig,) = [p for p in props if "space" not in Path(p.electrodes).name]
    assert orig.status == labels.ALREADY and not orig.files


def test_write_refuses_to_overwrite_a_different_file(no_sidecar):
    plan = labels.plan_dataset(no_sidecar)
    target = no_sidecar / plan.files[0].path
    target.write_text("{}")
    with pytest.raises(GeometryRefusal) as exc:
        labels.write(plan, no_sidecar)
    assert exc.value.reason == "write-conflict" and target.read_text() == "{}"


def test_ownership_keeps_entries_other_tracks_wrote(no_sidecar):
    from ieeg_geometry import OwnedPath, write_ownership

    other = OwnedPath("sub-01/foo.tsv", "electrodes", (("a", "b"),), "transform", None)
    write_ownership(no_sidecar, "0.1.0", [other])
    labels.write(labels.plan_dataset(no_sidecar), no_sidecar)
    owned = read_ownership(no_sidecar)
    assert owned is not None and {e.path for e in owned.entries} >= {"sub-01/foo.tsv"}
    assert len(owned.entries) == 2


# --- named candidates beyond fsaverage ----------------------------------------------------------


def test_sidecar_variant_spelling_maps_to_the_valid_label(tmp_path):
    elec = _points_file(tmp_path, _mni_points())
    _sidecar(elec, "MNI152NLin6Asym")  # not the exact BIDS spelling (ASym)
    prop = _only(labels.plan_dataset(tmp_path))
    assert prop.status == labels.ACCEPTED and prop.label == "MNI152NLin6ASym"
    assert prop.attempts[0].reference == "MNI152NLin2009cAsym"
    assert prop.attempts[0].source == "sidecar"
    assert [f.path.rsplit("/", 1)[1] for f in prop.files] == [
        "sub-1_space-MNI152NLin6ASym_electrodes.tsv",
        "sub-1_space-MNI152NLin6ASym_coordsystem.json",
    ]


def test_a_named_mni152_is_needs_human_when_contacts_sit_on_fsaverage(native_sidecar):
    for channels in native_sidecar.rglob("*_channels.tsv"):
        channels.unlink()  # no contact types: depth rule, which the MNI shell passes
    coord = next(native_sidecar.rglob("*_coordsystem.json"))
    doc = json.loads(coord.read_text())
    doc["iEEGCoordinateSystem"] = "MNI152NLin6Asym"
    coord.write_text(json.dumps(doc))
    prop = _only(labels.plan_dataset(native_sidecar))
    first = prop.attempts[0]
    assert first.label == "MNI152NLin6ASym" and not first.accepted
    assert "fsaverage vertices" in first.reason
    assert prop.status == labels.NEEDS_HUMAN and not prop.files


@pytest.mark.parametrize("keep_channels", [True, False])
def test_readme_naming_mni152_for_fsaverage_contacts_is_not_written(tmp_path, keep_channels):
    """on005007 sub-01: contacts on fsaverage, a README naming MNI152NLin6ASym (reviewer probe)."""
    ds = tmp_path / "ds"
    shutil.copytree(FIX / "on005007", ds)
    (ds / "README.md").write_text("Electrode coordinates are in MNI152NLin6ASym space.")
    if not keep_channels:
        for channels in ds.rglob("*_channels.tsv"):
            channels.unlink()
    prop = _only(labels.plan_dataset(ds))
    assert prop.status == labels.NEEDS_HUMAN and not prop.files
    assert labels.write(labels.plan_dataset(ds), ds) == []


def test_on005007_sub01_is_accepted_blind_with_a_slid_grid_control(tmp_path):
    ds = tmp_path / "ds"
    shutil.copytree(FIX / "on005007", ds)
    prop = _only(labels.plan_dataset(ds))
    assert prop.status == labels.ACCEPTED and prop.label == "fsaverage"
    assert prop.attempts[0].fit is not None and prop.attempts[0].fit.median_mm <= 1.0


def test_plausible_depth_contacts_pass_when_named_but_not_blind(tmp_path):
    inner = _mni_points(scale=0.9)  # inside the shell, 3 mm median: plausible, not specific
    elec = _points_file(tmp_path, inner)
    prop = _only(labels.plan_dataset(tmp_path))
    assert prop.status == labels.REJECTED and not prop.files
    assert all(a.grade == "fail" for a in prop.attempts)
    _sidecar(elec, "MNI152NLin2009cAsym ")  # trailing space: a recognizable non-standard value
    named = _only(labels.plan_dataset(tmp_path))
    assert named.status == labels.ACCEPTED and named.attempts[0].grade == "plausible"


def test_blind_trial_labels_mni152_when_contacts_sit_on_its_vertices(tmp_path):
    _points_file(tmp_path, _mni_points())
    prop = _only(labels.plan_dataset(tmp_path))
    assert prop.status == labels.ACCEPTED and prop.label == "MNI152NLin2009cAsym"
    assert prop.attempts[-1].source == "blind trial"


def test_units_in_meters_are_written_in_millimeters(tmp_path):
    pts = _mni_points()
    elec = _points_file(tmp_path, pts / 1000.0)
    _sidecar(
        elec,
        "Other",
        iEEGCoordinateUnits="m",
        iEEGCoordinateSystemDescription="MNI152NLin2009cAsym",
    )
    prop = _only(labels.plan_dataset(tmp_path))
    assert prop.status == labels.ACCEPTED
    elec_file = next(f for f in prop.files if f.path.endswith("_electrodes.tsv"))
    rows = [r.split("\t") for r in elec_file.content.decode().splitlines()[1:]]
    got = np.array([[float(v) for v in r[1:4]] for r in rows])
    assert np.allclose(got, pts, atol=0.01)
    coord = next(f for f in prop.files if f.path.endswith("_coordsystem.json"))
    assert json.loads(coord.content)["iEEGCoordinateUnits"] == "mm"


def test_talairach_is_never_written(no_sidecar):
    (no_sidecar / "README.md").write_text("Coordinates are in Talairach space.\n")
    prop = _only(labels.plan_dataset(no_sidecar))
    assert prop.status == labels.NEEDS_HUMAN and prop.reason == "Talairach is never written"


def test_too_few_contacts_are_skipped(tmp_path):
    _points_file(tmp_path, _mni_points(n=2))
    assert _only(labels.plan_dataset(tmp_path)).status == labels.SKIPPED


# --- recognizing names --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("coordinates are in MNI‑305 space", ["MNI305"]),  # non-breaking hyphen
        ("MNI 305 and mni_305", ["MNI305"]),
        ("surface fsaverage6 was used", ["fsaverage"]),
        ("the fsaverageSym surface", []),
        ("registered to MNI152NLin2009c Asym", ["MNI152NLin2009cAsym"]),
        ("MNI-152-NLin-6-ASym", ["MNI152NLin6ASym"]),
        ("MNI152Lin, then IXI549Space", ["MNI152Lin", "IXI549Space"]),
        ("see Talairach and fsaverage", ["Talairach", "fsaverage"]),
        ("no template here", []),
    ],
)
def test_scan_prose_names(text, expected):
    named, _ = labels.scan_prose(text)
    assert [n.label for n in named] == expected


@pytest.mark.parametrize(
    ("text", "generic"),
    [
        ("MNI coordinates", True),
        ("MNI152 space", True),
        ("MNI305 only", False),
        ("MNI152NLin6ASym only", False),
        ("Montreal", False),
    ],
)
def test_scan_prose_flags_unspecific_mni(text, generic):
    assert labels.scan_prose(text)[1] is generic


@pytest.mark.parametrize(
    ("value", "label"),
    [
        ("mni152nlin2009casym", "MNI152NLin2009cAsym"),
        ("MNI-305", "MNI305"),
        ("fsaverage6", "fsaverage"),
        ("FSAVERAGE", "fsaverage"),
    ],
)
def test_classify_frame_value(value, label):
    hit = labels.classify_frame_value(value)
    assert isinstance(hit, labels.Named) and hit.label == label


def test_classify_frame_value_unspecific_and_unknown():
    assert labels.classify_frame_value("MNI") == "mni-unknown"
    assert labels.classify_frame_value("MNI152") == "mni-unknown"
    assert labels.classify_frame_value("patient-native") is None


def test_reference_and_written_labels():
    assert labels.reference_for("MNI305") == "fsaverage"
    assert labels.reference_for("MNI152NLin6ASym") == "MNI152NLin2009cAsym"
    assert labels.reference_for("IXI549Space") == "MNI152NLin2009cAsym"
    assert labels.reference_for("MNIColin27") is None
    assert labels.written_label("MNI305") == "fsaverage"
    assert labels.written_label("MNI152Lin") == "MNI152Lin"


# --- the inspect command ------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("kind", "expected"),
    [
        (
            "on006107",
            ["label: accepted fsaverage", "blind trial", "every 10 mm shift fails", "would write"],
        ),
        (
            "on006910",
            ["label: accepted fsaverage (README 'MNI-305')", "space-fsaverage_coordsystem"],
        ),
    ],
)
def test_inspect_shows_the_proposal_evidence_and_verdict(kind, expected):
    out = subprocess.run(
        [sys.executable, "-m", "ieeg_geometry", "inspect", str(FIX / kind)],
        capture_output=True,
        text=True,
    ).stdout
    for text in expected:
        assert text in out


def test_blind_trial_needs_the_shift_control_on_every_axis(tmp_path):
    """Contacts on fsaverage vertices whose +y shift lands on cortex again are not specific."""
    from scipy.spatial import KDTree

    verts = np.vstack([s.vertices for s in load_reference("fsaverage")])
    tree = KDTree(verts)
    dx = tree.query(verts + [10, 0, 0])[0]  # the verifier's own control (x) still fails
    dy = tree.query(verts + [0, 10, 0])[0]
    chosen = np.where((dx >= 3) & (dy <= 0.5))[0]
    _points_file(tmp_path, verts[chosen[:: len(chosen) // 80]])
    prop = _only(labels.plan_dataset(tmp_path))
    assert prop.status == labels.REJECTED and not prop.files
    assert "a 10 mm shift still fits" in prop.attempts[0].reason


# --- review round: prose, negation, guards ------------------------------------------------------


def _fsaverage_points(scale=1.0, n=80) -> np.ndarray:
    verts = load_reference("fsaverage")[0].vertices
    idx = np.random.default_rng(1).choice(len(verts), n, replace=False)
    return verts[idx] * scale


def _blend_points(k=0.95, w=0.5, n=80) -> np.ndarray:
    """Halfway between fsaverage and its nearest MNI152 vertices: plausible for both."""
    from scipy.spatial import KDTree

    fs = load_reference("fsaverage")[0].vertices
    mni = load_reference("MNI152NLin2009cAsym")[0].vertices
    chosen = fs[np.random.default_rng(0).choice(len(fs), n, replace=False)]
    return k * (w * chosen + (1 - w) * mni[KDTree(mni).query(chosen)[1]])


def test_two_distinct_passing_labels_need_a_human(tmp_path):
    _points_file(tmp_path, _blend_points())  # plausible against both templates
    (tmp_path / "README.md").write_text(
        "Positions in MNI305 for some, MNI152NLin2009cAsym for others."
    )
    prop = _only(labels.plan_dataset(tmp_path))
    assert [a.grade for a in prop.attempts] == ["plausible", "plausible"]
    assert prop.status == labels.NEEDS_HUMAN and "two distinct" in prop.reason and not prop.files


def test_prose_with_only_plausible_evidence_needs_a_human(tmp_path):
    _points_file(tmp_path, _fsaverage_points(scale=0.9))
    (tmp_path / "README.md").write_text(
        "Electrodes are in native space. Figures show results on fsaverage."
    )
    prop = _only(labels.plan_dataset(tmp_path))
    assert prop.attempts[0].grade == "plausible"
    assert prop.status == labels.NEEDS_HUMAN and not prop.files


def test_a_sidecar_name_with_plausible_evidence_is_still_written(tmp_path):
    elec = _points_file(tmp_path, _fsaverage_points(scale=0.9))
    _sidecar(elec, "FSAVERAGE")
    prop = _only(labels.plan_dataset(tmp_path))
    assert prop.status == labels.ACCEPTED and prop.attempts[0].source == "sidecar"


@pytest.mark.parametrize(
    "text",
    [
        "Coordinates are not in MNI305 space.",
        "Positions are in native space, never in MNI305.",
        "Not MNI305: these are native positions.",
    ],
)
def test_negated_mentions_are_ignored(no_sidecar, text):
    (no_sidecar / "README.md").write_text(text)
    prop = _only(labels.plan_dataset(no_sidecar))
    assert prop.status == labels.ACCEPTED and prop.attempts[0].source == "blind trial"


@pytest.mark.parametrize(
    "frame",
    [
        "acpc",
        "ACPC",
        "ScanRAS",
        "scanner",
        "Scanner RAS",
        "ScannerRAS",
        "native",
        "Native-RAS",
        "ACPC-aligned T1",
        "Pixels",
    ],
)
def test_never_relabeled_frames_by_canonical_prefix(no_sidecar, frame):
    _sidecar(next(no_sidecar.rglob("*_electrodes.tsv")), frame)
    prop = _only(labels.plan_dataset(no_sidecar))
    assert prop.status == labels.SKIPPED and not prop.files and not prop.attempts


def test_authors_template_file_under_acq_or_another_name_blocks_a_pair(native_sidecar):
    ieeg = native_sidecar / "sub-001" / "ses-1" / "ieeg"
    base = ieeg / "sub-001_ses-1_electrodes.tsv"
    (ieeg / "sub-001_ses-1_acq-a_space-MNI305_electrodes.tsv").write_bytes(base.read_bytes())
    prop = next(
        p
        for p in labels.plan_dataset(native_sidecar).proposals
        if p.electrodes == "sub-001/ses-1/ieeg/sub-001_ses-1_electrodes.tsv"
    )
    assert prop.status == labels.ALREADY and not prop.files


def test_authors_sidecar_frame_on_another_acq_blocks_a_pair(native_sidecar):
    ieeg = native_sidecar / "sub-001" / "ses-1" / "ieeg"
    other = ieeg / "sub-001_ses-1_acq-b_electrodes.tsv"
    other.write_bytes((ieeg / "sub-001_ses-1_electrodes.tsv").read_bytes())
    _sidecar(other, "MNI305")
    prop = next(
        p for p in labels.plan_dataset(native_sidecar).proposals if "acq-b" not in p.electrodes
    )
    assert prop.status == labels.ALREADY and not prop.files


def test_pipeline_files_are_not_authors_files_on_rerun(native_sidecar):
    labels.write(labels.plan_dataset(native_sidecar), native_sidecar)
    before = _tree(native_sidecar)
    plan = labels.plan_dataset(native_sidecar)
    orig = next(p for p in plan.proposals if "space" not in p.electrodes)
    assert orig.status == labels.ALREADY and orig.reason == "pipeline output unchanged"
    # the same rerun, with the ownership record gone, now sees the files as the authors'
    (native_sidecar / ".nemar" / "ieeg-geometry.json").unlink()
    orig = next(
        p for p in labels.plan_dataset(native_sidecar).proposals if "space" not in p.electrodes
    )
    assert orig.status == labels.ALREADY and "authors'" in orig.reason
    assert {k: v for k, v in _tree(native_sidecar).items() if k != ".nemar/ieeg-geometry.json"} == {
        k: v for k, v in before.items() if k != ".nemar/ieeg-geometry.json"
    }


def test_an_untouched_owned_file_is_regenerated_when_the_evidence_changes(no_sidecar):
    labels.write(labels.plan_dataset(no_sidecar), no_sidecar)
    sidecar = next(no_sidecar.rglob("*_coordsystem.json"))
    assert "geometric verification" in sidecar.read_text()
    (no_sidecar / "README.md").write_text("Contacts are in MNI305 space.")  # now a named template
    plan = labels.plan_dataset(no_sidecar)
    assert plan.files and _only(plan).status == labels.ACCEPTED
    assert labels.write(plan, no_sidecar) == [sidecar]
    assert "Authors' term" in sidecar.read_text()
    owned = read_ownership(no_sidecar)
    assert owned is not None and len(owned.entries) == 1
    entry = owned.entries[0]
    assert entry.output_sha256 == hashlib.sha256(sidecar.read_bytes()).hexdigest()
    assert not labels.plan_dataset(no_sidecar).files


def test_a_hand_edited_owned_file_is_kept(no_sidecar):
    labels.write(labels.plan_dataset(no_sidecar), no_sidecar)
    sidecar = next(no_sidecar.rglob("*_coordsystem.json"))
    doc = json.loads(sidecar.read_text())
    doc["iEEGCoordinateSystemDescription"] = "Edited by the dataset owner."
    sidecar.write_text(json.dumps(doc))
    edited = _tree(no_sidecar)
    (no_sidecar / "README.md").write_text("Contacts are in MNI305 space.")  # would regenerate
    prop = _only(labels.plan_dataset(no_sidecar))
    assert prop.status == labels.KEPT and not prop.files
    assert labels.write(labels.plan_dataset(no_sidecar), no_sidecar) == []
    assert {k: v for k, v in _tree(no_sidecar).items() if k != "README.md"} == {
        k: v for k, v in edited.items() if k != "README.md"
    }


def test_a_stale_plan_never_overwrites_a_hand_edited_file(no_sidecar):
    plan = labels.plan_dataset(no_sidecar)
    labels.write(plan, no_sidecar)
    sidecar = next(no_sidecar.rglob("*_coordsystem.json"))
    sidecar.write_text("{}")  # edited after the pipeline wrote it
    with pytest.raises(GeometryRefusal) as exc:
        labels.write(plan, no_sidecar)  # the same, now stale, plan
    assert exc.value.reason == "write-conflict" and "hand-edited" in str(exc.value)
    assert sidecar.read_text() == "{}"


def test_a_rerun_with_a_new_pipeline_version_rewrites_nothing(native_sidecar):
    labels.write(labels.plan_dataset(native_sidecar, version="0.1.0"), native_sidecar)
    before = _tree(native_sidecar)
    plan = labels.plan_dataset(native_sidecar, version="0.2.0")
    assert not plan.files and plan.pipeline_version == "0.2.0"
    assert {p.status for p in plan.proposals} <= {labels.ALREADY, labels.SKIPPED}
    assert labels.write(plan, native_sidecar) == []
    assert _tree(native_sidecar) == before
    assert b"ieeg-geometry 0.1.0" in next(
        v for k, v in before.items() if k.endswith("_space-fsaverage_coordsystem.json")
    )


def test_a_new_version_with_changed_evidence_does_rewrite(no_sidecar):
    labels.write(labels.plan_dataset(no_sidecar, version="0.1.0"), no_sidecar)
    (no_sidecar / "README.md").write_text("Contacts are in MNI305 space.")
    plan = labels.plan_dataset(no_sidecar, version="0.2.0")
    assert labels.write(plan, no_sidecar)
    assert "ieeg-geometry 0.2.0" in next(no_sidecar.rglob("*_coordsystem.json")).read_text()


def test_identical_contact_positions_are_not_a_fit(tmp_path):
    """Twelve contacts at the origin touch a template vertex; that proves nothing."""
    _points_file(tmp_path, np.zeros((12, 3)))
    prop = _only(labels.plan_dataset(tmp_path))
    assert prop.status == labels.SKIPPED and "distinct contact positions" in prop.reason


def test_channels_bytes_that_are_not_utf8_surface_as_a_warning(no_sidecar):
    channels = next(no_sidecar.rglob("*_channels.tsv"))
    lines = channels.read_bytes().split(b"\n")
    lines[1] = lines[1].replace(b"A1", b"A\x83")  # a damaged name cell, as on006233's units
    channels.write_bytes(b"\n".join(lines))
    prop = _only(labels.plan_dataset(no_sidecar))
    assert prop.status == labels.ACCEPTED
    assert any("undecodable bytes" in w for w in prop.warnings)
    assert any("warning:" in line for line in prop.lines())
    assert "warning:" in _inspect(no_sidecar)


def test_ownership_is_recorded_before_the_files(no_sidecar):
    import os

    plan = labels.plan_dataset(no_sidecar)
    folder = next(no_sidecar.rglob("*_electrodes.tsv")).parent
    folder.chmod(0o555)
    try:
        if os.access(folder, os.W_OK):
            pytest.skip("directory permissions are not enforced here")
        with pytest.raises(PermissionError):
            labels.write(plan, no_sidecar)
    finally:
        folder.chmod(0o755)
    owned = read_ownership(no_sidecar)
    assert owned is not None and [e.path for e in owned.entries] == [plan.files[0].path]
    assert not (no_sidecar / plan.files[0].path).exists()


def test_a_dangling_annex_sidecar_is_refused_and_never_written_through(no_sidecar):
    import os

    elec = next(no_sidecar.rglob("*_electrodes.tsv"))
    link = elec.with_name(elec.name.replace("electrodes.tsv", "coordsystem.json"))
    os.symlink("../../../.git/annex/objects/XX/key.json", link)
    prop = _only(labels.plan_dataset(no_sidecar))
    assert prop.status == labels.SKIPPED and "link" in prop.reason and not prop.files


def test_write_refuses_a_symlink_target(no_sidecar):
    import os

    plan = labels.plan_dataset(no_sidecar)
    target = no_sidecar / plan.files[0].path
    os.symlink("nowhere.json", target)
    with pytest.raises(GeometryRefusal) as exc:
        labels.write(plan, no_sidecar)
    assert exc.value.reason == "write-conflict" and not (no_sidecar / "nowhere.json").exists()
    assert not (no_sidecar / ".nemar").exists()


def test_meters_file_with_trailing_blank_line(tmp_path):
    pts = _mni_points()
    elec = _points_file(tmp_path, pts / 1000.0)
    _sidecar(
        elec,
        "Other",
        iEEGCoordinateUnits="m",
        iEEGCoordinateSystemDescription="MNI152NLin2009cAsym",
    )
    elec.write_text(elec.read_text() + "\n\n")
    prop = _only(labels.plan_dataset(tmp_path))
    assert prop.status == labels.ACCEPTED
    content = next(f for f in prop.files if f.path.endswith(".tsv")).content.decode()
    assert "\n\n" not in content and len(content.splitlines()) == len(pts) + 1


def test_a_malformed_row_is_skipped_with_a_reason(tmp_path):
    elec = _points_file(tmp_path, _mni_points() / 1000.0)
    _sidecar(
        elec,
        "Other",
        iEEGCoordinateUnits="m",
        iEEGCoordinateSystemDescription="MNI152NLin2009cAsym",
    )
    elec.write_text(elec.read_text() + "C99\t1.0\n")  # a truncated row
    prop = _only(labels.plan_dataset(tmp_path))
    assert prop.status == labels.SKIPPED and "cannot copy positions" in prop.reason
    elec.write_text(elec.read_text().replace("C99\t1.0\n", "C99\tx\ty\tz\t0\n"))
    assert _only(labels.plan_dataset(tmp_path)).status == labels.SKIPPED


def test_a_sidecar_naming_a_template_without_a_reference_needs_a_human(tmp_path):
    elec = _points_file(tmp_path, _fsaverage_points())
    _sidecar(elec, "MNI-Colin27")  # contacts really are on fsaverage; no blind override
    prop = _only(labels.plan_dataset(tmp_path))
    assert prop.status == labels.NEEDS_HUMAN and not prop.files and not prop.attempts


def test_a_blind_trial_needs_ten_contacts(tmp_path):
    _points_file(tmp_path, _fsaverage_points(n=9))
    prop = _only(labels.plan_dataset(tmp_path))
    assert prop.status == labels.REJECTED and "fewer than 10" in prop.reason
    _points_file(tmp_path, _fsaverage_points(n=10))
    assert _only(labels.plan_dataset(tmp_path)).status == labels.ACCEPTED


def test_description_names_every_contact_type(tmp_path):
    pts = _fsaverage_points(n=40)
    path = tmp_path / "sub-1" / "ieeg" / "sub-1_electrodes.tsv"
    path.parent.mkdir(parents=True)
    rows = [
        f"C{i}\t{x:.6f}\t{y:.6f}\t{z:.6f}\t{'ECOG' if i < 20 else 'SEEG'}"
        for i, (x, y, z) in enumerate(pts)
    ]
    path.write_text("name\tx\ty\tz\ttype\n" + "\n".join(rows) + "\n")
    (tmp_path / "README.md").write_text("Contacts are in MNI305 space.")
    prop = _only(labels.plan_dataset(tmp_path))
    assert prop.status == labels.ACCEPTED
    text = json.loads(prop.files[0].content)["iEEGCoordinateProcessingDescription"]
    assert "ecog 20 contacts" in text and "seeg 20 contacts" in text


def test_the_authors_term_is_in_the_system_description(native_sidecar):
    labels.write(labels.plan_dataset(native_sidecar), native_sidecar)
    pair = next(native_sidecar.rglob("*_space-fsaverage_coordsystem.json"))
    doc = json.loads(pair.read_text())
    assert "Authors' term: README 'MNI-305'" in doc["iEEGCoordinateSystemDescription"]


def test_the_authors_term_is_in_a_new_sidecar(readme_only):
    labels.write(labels.plan_dataset(readme_only), readme_only)
    doc = json.loads(next(readme_only.rglob("*_coordsystem.json")).read_text())
    assert "Authors' term: README 'MNI305'" in doc["iEEGCoordinateSystemDescription"]


def test_pipeline_version_is_the_installed_package_version():
    from importlib import metadata

    assert labels.pipeline_version() == metadata.version("ieeg-geometry")


# BIDS specification, appendix "Coordinate Systems", "Standard template identifiers" first column,
# src/appendices/coordinate-systems.md on master, read 2026-11-19.
BIDS_APPENDIX_IDENTIFIERS = r"""
ICBM452AirSpace
ICBM452Warp5Space
IXI549Space
fsaverage
fsaverageSym
fsLR
MNIColin27
MNI152Lin
MNI152NLin2009\[a-c\]\[Sym\|Asym\]
MNI152NLin6Sym
MNI152NLin6ASym
MNI305
NIHPD
OASIS30AntsOASISAnts
OASIS30Atropos
Talairach
UNCInfant
"""


def test_the_template_list_is_the_pinned_bids_appendix():
    expected: set[str] = set()
    for line in BIDS_APPENDIX_IDENTIFIERS.split():
        if "[a-c]" in line.replace("\\", ""):
            expected |= {f"MNI152NLin2009{v}{s}" for v in "abc" for s in ("Sym", "Asym")}
        else:
            expected.add(line)
    assert labels.TEMPLATE_LABELS == expected
    assert "MNI152NLin2009bSym" in labels.TEMPLATE_LABELS


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("MNI­305 coordinates", ["MNI305"]),  # soft hyphen
        ("ＭＮＩ３０５ coordinates", ["MNI305"]),  # full-width
        ("the fsaverage-sym surface", []),
        ("the fsaverage sym surface", []),
        ("the fsaverage surface", ["fsaverage"]),
    ],
)
def test_prose_normalization(text, expected):
    assert [n.label for n in labels.scan_prose(text)[0]] == expected


def test_classify_frame_value_does_not_map_fsaverage_sym_to_fsaverage():
    hit = labels.classify_frame_value("fsaverage-sym")
    assert isinstance(hit, labels.Named) and hit.label == "fsaverageSym"


# --- inherited coordsystems ---------------------------------------------------------------------


def _shared(tmp_path, frame, **extra):
    """Two electrodes files (acq and run entities) under one subject-level coordsystem."""
    folder = tmp_path / "sub-1" / "ieeg"
    folder.mkdir(parents=True)
    pts = _fsaverage_points()
    for name in ("sub-1_acq-a_electrodes.tsv", "sub-1_run-1_electrodes.tsv"):
        rows = [f"C{i}\t{x:.6f}\t{y:.6f}\t{z:.6f}\t0" for i, (x, y, z) in enumerate(pts)]
        (folder / name).write_text(HEADER + "\n".join(rows) + "\n")
    body = {"iEEGCoordinateSystem": frame, "iEEGCoordinateUnits": "mm", **extra}
    (tmp_path / "sub-1" / "sub-1_coordsystem.json").write_text(json.dumps(body))
    return tmp_path


@pytest.mark.parametrize("frame", ["ACPC", "ScanRAS", "native"])
def test_a_protected_inherited_coordsystem_is_never_relabeled(tmp_path, frame):
    ds = _shared(tmp_path, frame)
    plan = labels.plan_dataset(ds)
    assert len(plan.proposals) == 2
    assert {p.status for p in plan.proposals} == {labels.SKIPPED} and not plan.files


def test_an_inherited_coordsystem_with_intended_for_is_protected(tmp_path):
    ds = _shared(tmp_path, "Other", IntendedFor="bids::sub-1/anat/sub-1_T1w.nii.gz")
    assert {p.status for p in labels.plan_dataset(ds).proposals} == {labels.SKIPPED}


def test_a_valid_inherited_label_is_left_alone(tmp_path):
    ds = _shared(tmp_path, "fsaverage")
    plan = labels.plan_dataset(ds)
    assert {p.status for p in plan.proposals} == {labels.ALREADY} and not plan.files


def test_a_wrong_inherited_coordsystem_gets_a_pair_never_a_missing_sidecar(tmp_path):
    ds = _shared(tmp_path, "Other", iEEGCoordinateSystemDescription="patient-native RAS")
    before = _tree(ds)
    plan = labels.plan_dataset(ds)
    assert {p.status for p in plan.proposals} == {labels.ACCEPTED}
    paths = sorted(f.path for f in plan.files)
    assert paths == [
        "sub-1/ieeg/sub-1_acq-a_space-fsaverage_coordsystem.json",
        "sub-1/ieeg/sub-1_acq-a_space-fsaverage_electrodes.tsv",
        "sub-1/ieeg/sub-1_run-1_space-fsaverage_coordsystem.json",
        "sub-1/ieeg/sub-1_run-1_space-fsaverage_electrodes.tsv",
    ]
    labels.write(plan, ds)
    after = _tree(ds)
    assert all(after[k] == v for k, v in before.items())  # the shared sidecar is untouched
    assert "sub-1/ieeg/sub-1_acq-a_coordsystem.json" not in after


def test_a_dangling_exact_link_is_not_replaced_by_an_inherited_sidecar(tmp_path):
    import os

    ds = _shared(tmp_path, "Other")
    os.symlink("../../.git/annex/x.json", ds / "sub-1" / "ieeg" / "sub-1_acq-a_coordsystem.json")
    statuses = {p.electrodes: p.status for p in labels.plan_dataset(ds).proposals}
    assert statuses["sub-1/ieeg/sub-1_acq-a_electrodes.tsv"] == labels.SKIPPED


def test_a_sidecar_name_variant_is_declared_in_the_description(tmp_path):
    elec = _points_file(tmp_path, _fsaverage_points())
    _sidecar(elec, "FSAVERAGE ")
    labels.write(labels.plan_dataset(tmp_path), tmp_path)
    pair = next(tmp_path.rglob("*_space-fsaverage_coordsystem.json"))
    text = json.loads(pair.read_text())["iEEGCoordinateSystemDescription"]
    assert "declared it as 'FSAVERAGE '" in text and "not a valid BIDS label as written" in text


# --- inspect ------------------------------------------------------------------------------------


def _inspect(path) -> str:
    import io

    from ieeg_geometry.__main__ import inspect

    out = io.StringIO()
    inspect(Path(path), out)
    return out.getvalue()


def test_inspect_lists_what_suppressed_blind_trials(tmp_path):
    shutil.copytree(FIX / "on006107", tmp_path / "ds")
    (tmp_path / "ds" / "README.md").write_text("Positions are given in MNI space.")
    out = _inspect(tmp_path / "ds")
    assert (
        "blind trials suppressed by MNI without a variant in README 'MNI' "
        "(1 file(s) need a human label)" in out
    )
    assert "  sub-01/ses-01/ieeg/sub-01_ses-01_electrodes.tsv" in out
    (tmp_path / "ds" / "README.md").write_text("Positions are in Talairach space.")
    assert "blind trials suppressed by Talairach in README 'Talairach'" in _inspect(tmp_path / "ds")


def test_inspect_reports_a_missing_package_version_once(tmp_path, monkeypatch):
    from importlib import metadata

    def missing(name):  # simulates an environment fault (no package metadata), not business logic
        raise metadata.PackageNotFoundError(name)

    monkeypatch.setattr(metadata, "version", missing)
    shutil.copytree(FIX / "on006107", tmp_path / "ds")
    out = _inspect(tmp_path / "ds")
    assert (
        out.count("label proposals unavailable") == 1 and "frame" not in out.split("unavailable")[0]
    )
    assert "contacts" in out or "refused" in out  # the rest of the report still runs
