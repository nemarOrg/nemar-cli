"""Label inference: real excerpts of public CC0 datasets (see fixtures/PROVENANCE.md)."""

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
    assert "median distance" in doc["iEEGCoordinateProcessingDescription"]
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


def test_a_named_mni152_is_refused_when_contacts_sit_on_fsaverage(native_sidecar):
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
    assert prop.status == labels.ACCEPTED and prop.label == "fsaverage"  # the README's MNI305


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


def test_the_template_list_matches_the_pinned_bids_appendix():
    assert len(labels.TEMPLATE_LABELS) == 22
    assert {"MNI305", "fsaverage", "MNI152NLin2009bSym", "IXI549Space"} <= labels.TEMPLATE_LABELS
    assert not {"ACPC", "ScanRAS", "Other", "fsaverage6"} & labels.TEMPLATE_LABELS


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
