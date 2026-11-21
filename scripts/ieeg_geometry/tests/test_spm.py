"""SPM deformation inversion, pairing, verification and writing (card B2)."""

import functools
import hashlib
import json
import subprocess
import sys
from pathlib import Path

import nibabel as nib
import numpy as np
import pytest

from ieeg_geometry import spm
from ieeg_geometry.bids import GeometryRefusal, discover, read_electrode_set
from ieeg_geometry.ownership import read_ownership
from ieeg_geometry.reference import load_reference
from ieeg_geometry.surfaces import Surface
from ieeg_geometry.verify import points_inside

FIXTURE = Path(__file__).parent / "fixtures" / "spm_dataset"
TEMPLATE_AFFINE = np.array(
    [[-1.5, 0, 0, 90.0], [0, 1.5, 0, -126.0], [0, 0, 1.5, -72.0], [0, 0, 0, 1.0]]
)  # SPM12's template grid, 121 x 145 x 121
SHAPE = (121, 145, 121)
NATIVE_A = np.array(
    [[0.98, 0.05, -0.02, 4.0], [-0.04, 0.97, 0.06, -7.0], [0.03, -0.05, 1.02, 11.0]]
)


def _native(template_mm: np.ndarray) -> np.ndarray:
    """A known affine plus a smooth warp (amplitude 3 mm, wavelength about 100 mm)."""
    t = np.asarray(template_mm, dtype=float)
    warp = 3.0 * np.stack(
        [
            np.sin(t[..., 1] / 16.0),
            np.sin(t[..., 2] / 16.0 + 1.0),
            np.sin(t[..., 0] / 16.0 + 2.0),
        ],
        axis=-1,
    )
    return t @ NATIVE_A[:, :3].T + NATIVE_A[:, 3] + warp


def _write_field(path: Path) -> Path:
    ijk = np.stack(np.meshgrid(*(np.arange(n) for n in SHAPE), indexing="ij"), axis=-1)
    template = ijk @ TEMPLATE_AFFINE[:3, :3].T + TEMPLATE_AFFINE[:3, 3]
    data = _native(template).astype(np.float32).reshape(*SHAPE, 1, 3)
    img = nib.Nifti1Image(data, TEMPLATE_AFFINE)
    nib.save(img, path)
    return path


@pytest.fixture(scope="module")
def synthetic_field(tmp_path_factory) -> spm.DeformationField:
    path = _write_field(tmp_path_factory.mktemp("field") / "y_sub-9_T1w.nii")
    return spm.load_field(path)


def test_known_warp_is_inverted_within_a_tenth_of_a_millimeter(synthetic_field):
    rng = np.random.default_rng(7)
    low, high = np.array([-70, -90, -50.0]), np.array([70, 60, 70.0])
    truth = rng.uniform(low, high, size=(50, 3))
    inv = spm.invert_points(synthetic_field, _native(truth))
    assert inv.ok.all()
    assert np.abs(inv.template_mm - truth).max() < 0.1
    assert inv.max_residual < spm.RESIDUAL_TOL_MM


def test_point_outside_the_grid_is_refused(synthetic_field):
    inside = _native(np.array([[10.0, -20.0, 30.0]]))
    far = _native(np.array([[10.0, -20.0, 300.0]]))  # 300 mm above the template grid
    nan = np.array([[np.nan, 1.0, 2.0]])
    inv = spm.invert_points(synthetic_field, np.vstack([inside, far, nan]))
    assert inv.reasons[0] is None
    assert inv.reasons[1] == "outside-grid"
    assert inv.reasons[2] == "missing-coordinates"
    assert np.isnan(inv.template_mm[1:]).all()


def test_iteration_cap_is_enforced(synthetic_field):
    truth = np.array([[10.0, -20.0, 30.0]])
    inv = spm.invert_points(synthetic_field, _native(truth), max_iterations=0)
    assert inv.reasons[0] == "no-convergence"


def test_odd_field_shapes_are_refused(tmp_path):
    bad = tmp_path / "y_bad.nii"
    nib.save(nib.Nifti1Image(np.zeros((4, 4, 4, 1, 2), np.float32), np.eye(4)), bad)
    with pytest.raises(GeometryRefusal) as exc:
        spm.load_field(bad)
    assert exc.value.reason == "field-shape"
    nan = tmp_path / "y_nan.nii"
    arr = np.zeros((4, 4, 4, 1, 3), np.float32)
    arr[0, 0, 0, 0, 0] = np.nan
    nib.save(nib.Nifti1Image(arr, np.eye(4)), nan)
    with pytest.raises(GeometryRefusal) as exc2:
        spm.load_field(nan)
    assert exc2.value.reason == "field-nonfinite"


# ---- the on004457 sub-2 fixture: pairing by evidence ---------------------------------------


def test_fixture_contacts_invert_to_residual_under_threshold():
    field = spm.load_field(FIXTURE / "derivatives/freesurfer/sub-2/y_sub-2_ses-mri01_T1w.nii.gz")
    item = next(i for i in discover(FIXTURE) if i.space is None)
    inv = spm.invert_points(field, read_electrode_set(item).xyz_mm)
    assert inv.ok.all()
    assert inv.median_residual < 0.05
    assert inv.max_residual < 0.05


def test_pairing_picks_the_native_file_for_sub2():
    (plan,) = spm.plan_dataset(FIXTURE)
    names = {c.electrodes_path.name: c for c in plan.candidates}
    native = names["sub-2_ses-ieeg01_electrodes.tsv"]
    acpc = names["sub-2_ses-ieeg01_space-ACPC_electrodes.tsv"]
    assert native.eligible and not acpc.eligible
    assert native.surface_fit is not None and native.surface_fit["seeg"].median_mm < 3.0
    assert acpc.surface_fit is not None and acpc.surface_fit["seeg"].median_mm > 9.0
    assert plan.chosen is native
    assert plan.basis.startswith("template verification")  # IntendedFor names absent files
    assert plan.inversion is not None and plan.inversion.median_residual < 0.05


def test_cropped_fixture_cannot_run_the_field_check_and_is_refused():
    """The committed crop covers only the contacts' box, so too few pial vertices invert for
    ruling 9's check; the full-field result is pinned by the network tests."""
    (plan,) = spm.plan_dataset(FIXTURE)
    assert plan.chosen is not None and plan.chosen.space is None
    assert plan.field_check is not None and not plan.field_check.passed
    assert plan.verdict == "refused" and "failed its check" in plan.reason
    assert plan.files == {}


def test_inspect_shows_pairing_evidence_residuals_and_verification():
    result = subprocess.run(
        [sys.executable, "-m", "ieeg_geometry", "inspect", str(FIXTURE)],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    out = result.stdout
    assert "SPM deformation field -> IXI549Space: refused" in out
    assert "165/165 contacts invert" in out
    assert (
        "not eligible" in out
        and "chosen sub-2/ses-ieeg01/ieeg/sub-2_ses-ieeg01_electrodes.tsv" in out
    )
    assert "inversion residual median 0.00" in out
    assert "field check on the subject's pial vertices" in out and "FAIL" in out


# ---- the write path on a synthetic subject whose contacts lie on the template -------------


def _cerebrum(surface: Surface, min_z: float = -40.0) -> Surface:
    """The part of a shell at or above `min_z`: what a pial surface has (no cerebellum)."""
    keep = surface.vertices[:, 2] >= min_z
    remap = np.cumsum(keep) - 1
    faces = surface.faces[keep[surface.faces].all(axis=1)]
    return Surface(surface.vertices[keep], remap[faces], surface.hemisphere)


def _add_native_surface(dataset: Path) -> None:
    """The right cerebrum of the shell mapped into the subject's native frame, as GIfTI."""
    shell = _cerebrum(load_reference("MNI152NLin2009cAsym")[1])
    verts = _native(shell.vertices * 0.995).astype(np.float32)
    faces = shell.faces.astype(np.int32)
    img = nib.gifti.GiftiImage(
        darrays=[
            nib.gifti.GiftiDataArray(verts, intent="NIFTI_INTENT_POINTSET"),
            nib.gifti.GiftiDataArray(faces, intent="NIFTI_INTENT_TRIANGLE"),
        ]
    )
    nib.save(img, dataset / "derivatives" / "freesurfer" / "sub-9" / "pial.R.surf.gii")


@pytest.fixture
def synthetic_dataset(tmp_path, synthetic_field) -> Path:
    """A subject with 40 sEEG contacts inside the right MNI shell, in a native frame."""
    native = _native(_inside_points(40))
    ieeg = tmp_path / "sub-9" / "ieeg"
    ieeg.mkdir(parents=True)
    rows = ["name\tx\ty\tz\tsize\ttype\themisphere"]
    for i, p in enumerate(native):
        rows.append(f"G{i + 1}\t{p[0]:.4f}\t{p[1]:.4f}\t{p[2]:.4f}\t4\tsEEG\tR")
    rows.append("G41\tn/a\tn/a\tn/a\t4\tsEEG\tR")
    (ieeg / "sub-9_electrodes.tsv").write_text("\n".join(rows) + "\n")
    (ieeg / "sub-9_coordsystem.json").write_text(
        json.dumps({"iEEGCoordinateSystem": "Other", "iEEGCoordinateUnits": "mm"})
    )
    fdir = tmp_path / "derivatives" / "freesurfer" / "sub-9"
    fdir.mkdir(parents=True)
    _write_field(fdir / "y_sub-9_T1w.nii")
    _add_native_surface(tmp_path)
    return tmp_path


def test_verified_subject_is_written_with_provenance_and_ownership(synthetic_dataset):
    (plan,) = spm.plan_dataset(synthetic_dataset)
    assert plan.verdict == "write", plan.reason
    assert plan.template_fit["seeg"].grade == "plausible"
    written = spm.write([plan], synthetic_dataset)
    tsv = synthetic_dataset / "sub-9" / "ieeg" / "sub-9_space-IXI549Space_electrodes.tsv"
    sidecar = synthetic_dataset / "sub-9" / "ieeg" / "sub-9_space-IXI549Space_coordsystem.json"
    assert {Path(w).name for w in written} == {tsv.name, sidecar.name}
    doc = json.loads(sidecar.read_text())
    assert doc["iEEGCoordinateSystem"] == "IXI549Space" and doc["iEEGCoordinateUnits"] == "mm"
    desc = doc["iEEGCoordinateProcessingDescription"]
    assert desc.startswith("Computed by NEMAR (ieeg_geometry ")
    assert "paired with the field by: template verification" in desc
    assert "not an error estimate" in desc and "centroid" in desc
    assert "y_sub-9_T1w.nii" in desc and "residual median" in desc and "maximum" in desc
    assert "differ from MNI152NLin2009cAsym by a few millimeters" in desc
    assert doc["iEEGCoordinateProcessingReference"] == spm.METHOD_URL
    lines = tsv.read_text().splitlines()
    assert lines[0].split("\t") == ["name", "x", "y", "z", "size", "type", "hemisphere"]
    assert lines[-1].split("\t")[1:4] == ["n/a", "n/a", "n/a"]
    out = read_electrode_set(
        next(i for i in discover(synthetic_dataset) if i.space == "IXI549Space")
    )
    assert out.frame == "IXI549Space" and len(out.contacts) == 41
    owned = read_ownership(synthetic_dataset)
    assert owned is not None
    assert {e.path for e in owned.entries} == set(written)
    entry = owned.entries[0]
    assert entry.method == spm.METHOD and entry.verification is not None
    assert entry.verification.reference == "MNI152NLin2009cAsym" and entry.verification.passed
    assert {Path(p).name for p, _ in entry.inputs} == {
        "sub-9_electrodes.tsv",
        "sub-9_coordsystem.json",
        "y_sub-9_T1w.nii",
        "pial.R.surf.gii",
    }
    assert owned.pipeline_version == spm.pipeline_version()


def test_second_run_regenerates_identical_bytes_and_authors_files_win(synthetic_dataset):
    spm.write(spm.plan_dataset(synthetic_dataset), synthetic_dataset)
    files = sorted(p for p in synthetic_dataset.rglob("*") if p.is_file())
    before = {p: p.read_bytes() for p in files}
    plans = spm.plan_dataset(synthetic_dataset)
    assert [p.verdict for p in plans] == ["write"]  # owned output is regenerated, not skipped
    spm.write(plans, synthetic_dataset)
    assert sorted(p for p in synthetic_dataset.rglob("*") if p.is_file()) == files
    assert {p: p.read_bytes() for p in files} == before
    # a space-IXI549Space file the pipeline does not own is the authors': nothing is computed
    (synthetic_dataset / ".nemar" / "ieeg-geometry.json").unlink()
    (skip,) = spm.plan_dataset(synthetic_dataset)
    assert skip.verdict == "skip" and "authors" in skip.reason


def _seeg_file(dataset: Path, template: np.ndarray, name: str = "sub-9_electrodes.tsv") -> None:
    rows = ["name\tx\ty\tz\ttype\themisphere"]
    for i, p in enumerate(_native(template)):
        rows.append(f"D{i}\t{p[0]:.4f}\t{p[1]:.4f}\t{p[2]:.4f}\tsEEG\tR")
    (dataset / "sub-9" / "ieeg" / name).write_text("\n".join(rows) + "\n")


def _shell_points(n: int, seed: int, min_x: float = -1e9) -> np.ndarray:
    shell = load_reference("MNI152NLin2009cAsym")[1]
    pool = shell.vertices[shell.vertices[:, 0] >= min_x]
    rng = np.random.default_rng(seed)
    return pool[rng.choice(len(pool), n, replace=False)]


def _is_inside(points: np.ndarray) -> np.ndarray:
    result = points_inside(points, load_reference("MNI152NLin2009cAsym"))
    assert result is not None
    return result[0]


@functools.cache
def _inside_pool() -> np.ndarray:
    shell = load_reference("MNI152NLin2009cAsym")[1]
    pool = shell.vertices[shell.vertices[:, 0] >= 20.0] * 0.9
    return pool[_is_inside(pool)]


def _inside_points(n: int, seed: int = 0) -> np.ndarray:
    """`n` right-hemisphere points that the ray-parity test puts inside the shell, any seed."""
    pool = _inside_pool()
    assert len(pool) >= n
    return pool[np.random.default_rng(seed).choice(len(pool), n, replace=False)]


def _outside_points(n: int, mm: float = 5.5, seed: int = 0) -> np.ndarray:
    """`n` points `mm` outside the shell that the inside test puts outside, any seed."""
    pool = _outside(_shell_points(400, seed), mm)
    pool = pool[~_is_inside(pool)]
    assert len(pool) >= n
    return pool[:n]


def _outside(points: np.ndarray, mm: float) -> np.ndarray:
    return points * (1 + mm / np.linalg.norm(points, axis=1, keepdims=True))


def test_contacts_just_outside_the_shell_fail_verification_and_nothing_is_written(
    synthetic_dataset,
):
    """sEEG contacts 5.5 mm outside the shell invert fine but are mostly outside the template."""
    _seeg_file(synthetic_dataset, _outside_points(40))
    (plan,) = spm.plan_dataset(synthetic_dataset)
    assert plan.chosen is None and plan.verdict == "refused"
    assert "template verification" in plan.reason
    assert spm.write([plan], synthetic_dataset) == []
    assert not list(synthetic_dataset.rglob("*IXI549Space*"))
    assert not (synthetic_dataset / ".nemar").exists()


def test_intended_for_match_pairs_then_verification_still_refuses_a_bad_file(synthetic_dataset):
    t1 = synthetic_dataset / "derivatives" / "freesurfer" / "sub-9" / "sub-9_T1w.nii"
    t1.write_bytes(b"")
    side = synthetic_dataset / "sub-9" / "ieeg" / "sub-9_coordsystem.json"
    doc = json.loads(side.read_text())
    doc["IntendedFor"] = "/derivatives/freesurfer/sub-9/sub-9_T1w.nii"
    side.write_text(json.dumps(doc))
    _seeg_file(synthetic_dataset, _outside_points(40))
    (plan,) = spm.plan_dataset(synthetic_dataset)
    assert plan.chosen is not None and plan.basis == "IntendedFor names the field's T1"
    assert plan.verdict == "refused" and "verification against" in plan.reason
    inside = plan.template_fit["seeg"].inside_fraction
    assert inside is not None and inside < 0.95


def test_field_check_fails_when_the_surface_does_not_belong_to_the_field(synthetic_field):
    shell = load_reference("MNI152NLin2009cAsym")
    right = _cerebrum(shell[1])
    own = Surface(_native(right.vertices * 0.995), right.faces, "R")
    good = spm.check_field(synthetic_field, [own], shell)
    assert good.passed and good.n_inverted >= 2000
    assert good.median_mm < 1.0 and good.p10_mm < 1.0
    assert good.centroid_mm < 2.0 and good.extent_deviation < 0.02
    wrong = Surface(own.vertices + np.array([30.0, 0, 0]), right.faces, "R")
    bad = spm.check_field(synthetic_field, [wrong], shell)
    assert not bad.passed and bad.median_mm > spm.FIELD_CHECK_MEDIAN_MM
    assert "limit" in bad.reason


def test_a_40_mm_translation_and_a_15_percent_scale_error_both_fail(synthetic_field):
    """Ruling 19: the shape and position checks, not only the nearest-vertex distances."""
    shell = load_reference("MNI152NLin2009cAsym")
    right = _cerebrum(shell[1])
    template = right.vertices * 0.995
    moved = spm.check_field(
        synthetic_field, [Surface(_native(template + [0.0, 40.0, 0.0]), right.faces, "R")], shell
    )
    assert not moved.passed and "centroid" in moved.reason
    assert moved.centroid_mm > spm.FIELD_CHECK_CENTROID_MM
    scaled = spm.check_field(
        synthetic_field, [Surface(_native(template * 1.15), right.faces, "R")], shell
    )
    assert not scaled.passed and "axis extent" in scaled.reason
    assert scaled.extent_deviation > spm.FIELD_CHECK_EXTENT_FRACTION


def test_field_check_records_numbers_in_provenance_and_ownership(synthetic_dataset):
    (plan,) = spm.plan_dataset(synthetic_dataset)
    check = plan.field_check
    assert check is not None and check.passed and check.n_inverted >= 2000
    spm.write([plan], synthetic_dataset)
    owned = read_ownership(synthetic_dataset)
    assert owned is not None
    for entry in owned.entries:
        assert entry.verification is not None
        assert entry.verification.field_check_median_mm == pytest.approx(check.median_mm, abs=1e-3)
        assert entry.verification.field_check_p10_mm == pytest.approx(check.p10_mm, abs=1e-3)
    sidecar = synthetic_dataset / "sub-9/ieeg/sub-9_space-IXI549Space_coordsystem.json"
    desc = json.loads(sidecar.read_text())["iEEGCoordinateProcessingDescription"]
    assert "Field check on the subject's own pial surface" in desc and "10th percentile" in desc


def test_no_subject_surface_means_the_field_cannot_be_trusted(synthetic_dataset):
    (synthetic_dataset / "derivatives/freesurfer/sub-9/pial.R.surf.gii").unlink()
    (plan,) = spm.plan_dataset(synthetic_dataset)
    assert plan.verdict == "refused" and "no subject pial surface" in plan.reason


def test_intended_for_status_resolves_existing_t1_files(tmp_path):
    fs = tmp_path / "derivatives" / "freesurfer" / "sub-3"
    fs.mkdir(parents=True)
    field_path = fs / "y_sub-3_ses-mri01_T1w.nii"
    (fs / "sub-3_ses-mri01_T1w_deFaced.nii").write_bytes(b"")
    acpc = tmp_path / "derivatives" / "acpc" / "sub-3"
    acpc.mkdir(parents=True)
    (acpc / "sub-3_ses-mri01_T1w_acpc_deFaced.nii").write_bytes(b"")
    status = spm.intended_for_status
    own = "/derivatives/freesurfer/sub-3/sub-3_ses-mri01_T1w_deFaced.nii"
    assert status(own, field_path, tmp_path) == spm.INTENDED_MATCH
    assert status("bids::" + own.lstrip("/"), field_path, tmp_path) == spm.INTENDED_MATCH
    assert status([acpc.as_posix(), own], field_path, tmp_path) == spm.INTENDED_MATCH  # list
    other = "/derivatives/acpc/sub-3/sub-3_ses-mri01_T1w_acpc_deFaced.nii"
    assert status(other, field_path, tmp_path) == spm.INTENDED_OTHER
    # the same name in another directory is not the field's T1
    (acpc / "sub-3_ses-mri01_T1w_deFaced.nii").write_bytes(b"")
    wrong_dir = "/derivatives/acpc/sub-3/sub-3_ses-mri01_T1w_deFaced.nii"
    assert status(wrong_dir, field_path, tmp_path) == spm.INTENDED_OTHER
    # a name that does not exist (on004457 sub-2) or no entry at all decides nothing
    assert status("/derivatives/freesurfer/sub-3/sub-3_T1w_deFaced.nii", field_path, tmp_path) == (
        spm.INTENDED_UNKNOWN
    )
    assert status(None, field_path, tmp_path) == spm.INTENDED_UNKNOWN
    assert status("", field_path, tmp_path) == spm.INTENDED_UNKNOWN


def _second_file(dataset: Path, intended_for: str | None) -> None:
    ieeg = dataset / "sub-9" / "ieeg"
    for suffix in ("electrodes.tsv", "coordsystem.json"):
        (ieeg / f"sub-9_space-ACPC_{suffix}").write_bytes((ieeg / f"sub-9_{suffix}").read_bytes())
    if intended_for is not None:
        acpc = ieeg / "sub-9_space-ACPC_coordsystem.json"
        doc = json.loads(acpc.read_text())
        doc["IntendedFor"] = intended_for
        acpc.write_text(json.dumps(doc))


def test_identical_candidates_without_intended_for_are_ambiguous(synthetic_dataset):
    _second_file(synthetic_dataset, None)
    (plan,) = spm.plan_dataset(synthetic_dataset)
    assert plan.chosen is None and "pairing ambiguous" in plan.reason


def test_intended_for_names_the_t1_and_a_different_t1_is_never_paired(synthetic_dataset):
    fs = synthetic_dataset / "derivatives" / "freesurfer" / "sub-9"
    (fs / "sub-9_T1w.nii").write_bytes(b"")
    (fs / "sub-9_T1w_acpc.nii").write_bytes(b"")
    side = synthetic_dataset / "sub-9" / "ieeg" / "sub-9_coordsystem.json"
    doc = json.loads(side.read_text())
    doc["IntendedFor"] = "/derivatives/freesurfer/sub-9/sub-9_T1w.nii"
    side.write_text(json.dumps(doc))
    _second_file(synthetic_dataset, "/derivatives/freesurfer/sub-9/sub-9_T1w_acpc.nii")
    (plan,) = spm.plan_dataset(synthetic_dataset)
    assert plan.chosen is not None and plan.chosen.space is None
    assert plan.basis == "IntendedFor names the field's T1" and plan.verdict == "write"
    # the file naming the other T1 is excluded; the file without IntendedFor remains
    doc["IntendedFor"] = "/derivatives/freesurfer/sub-9/sub-9_T1w_acpc.nii"
    side.write_text(json.dumps(doc))
    acpc = synthetic_dataset / "sub-9" / "ieeg" / "sub-9_space-ACPC_coordsystem.json"
    plain = json.loads(acpc.read_text())
    plain.pop("IntendedFor")
    acpc.write_text(json.dumps(plain))
    (swapped,) = spm.plan_dataset(synthetic_dataset)
    excluded = [c for c in swapped.candidates if c.intended == spm.INTENDED_OTHER]
    assert [c.space for c in excluded] == [None]
    assert swapped.chosen is not None and swapped.chosen.space == "ACPC"
    assert swapped.basis.startswith("template verification")
    # both naming other T1s: nothing can be paired
    plain["IntendedFor"] = "/derivatives/freesurfer/sub-9/sub-9_T1w_acpc.nii"
    acpc.write_text(json.dumps(plain))
    (none,) = spm.plan_dataset(synthetic_dataset)
    assert none.chosen is None and "different T1" in none.reason


def test_a_clear_template_verification_winner_pairs_without_intended_for(synthetic_dataset):
    """Two sEEG files invert fully; one lies inside the shell, the other 5.5 mm outside it."""
    _seeg_file(synthetic_dataset, _inside_points(40))
    _seeg_file(synthetic_dataset, _outside_points(40, seed=6), "sub-9_space-ACPC_electrodes.tsv")
    ieeg = synthetic_dataset / "sub-9" / "ieeg"
    (ieeg / "sub-9_space-ACPC_coordsystem.json").write_bytes(
        (ieeg / "sub-9_coordsystem.json").read_bytes()
    )
    (plan,) = spm.plan_dataset(synthetic_dataset)
    assert plan.chosen is not None and plan.chosen.space is None, plan.reason
    assert plan.basis.startswith("template verification (inside ")
    assert plan.verdict == "write"
    inside = plan.template_fit["seeg"].inside_fraction
    assert inside is not None and inside >= 0.95
    desc = spm.write([plan], synthetic_dataset)
    sidecar = synthetic_dataset / next(p for p in desc if p.endswith("coordsystem.json"))
    text = json.loads(sidecar.read_text())["iEEGCoordinateProcessingDescription"]
    assert "of the contacts inside it, farthest outside" in text and "%" in text


def test_write_merges_into_existing_ownership_and_keeps_other_tracks(synthetic_dataset):
    from ieeg_geometry.ownership import OwnedPath, write_ownership

    other = OwnedPath(
        "sub-9/ieeg/sub-9_space-fsaverage_electrodes.tsv",
        "electrodes",
        (("sub-9/ieeg/sub-9_electrodes.tsv", "0" * 40),),
        "freesurfer-talairach",
        None,
    )
    write_ownership(synthetic_dataset, "0.0.1", [other])
    written = spm.write(spm.plan_dataset(synthetic_dataset), synthetic_dataset)
    owned = read_ownership(synthetic_dataset)
    assert owned is not None
    assert {e.path for e in owned.entries} == {other.path, *written}
    assert next(e for e in owned.entries if e.path == other.path).method == "freesurfer-talairach"
    spm.write(spm.plan_dataset(synthetic_dataset), synthetic_dataset)  # rerun keeps it too
    again = read_ownership(synthetic_dataset)
    assert again is not None and other.path in {e.path for e in again.entries}


def _field_on(affine: np.ndarray, shape=(5, 5, 5)) -> spm.DeformationField:
    return spm.DeformationField(np.zeros((*shape, 3)), affine, Path("y_x.nii"))


def test_only_spm12s_template_grid_or_a_crop_of_it_is_accepted():
    full = _field_on(spm.SPM12_AFFINE, spm.SPM12_SHAPE)
    assert spm.on_spm12_grid(full)
    shift = spm.SPM12_AFFINE.copy()
    shift[:3, 3] = spm.SPM12_AFFINE[:3, :3] @ [10, 20, 30] + spm.SPM12_AFFINE[:3, 3]
    assert spm.on_spm12_grid(_field_on(shift, (20, 30, 40)))  # a crop
    assert not spm.on_spm12_grid(_field_on(shift, (120, 30, 40)))  # crop runs past the grid
    two_mm = spm.SPM12_AFFINE.copy()
    two_mm[:3, :3] *= 2 / 1.5
    assert not spm.on_spm12_grid(_field_on(two_mm, spm.SPM12_SHAPE))  # 2 mm voxels
    off = spm.SPM12_AFFINE.copy()
    off[:3, 3] += [0.7, 0, 0]
    assert not spm.on_spm12_grid(_field_on(off, (20, 30, 40)))  # off the lattice
    mni = np.array([[-2.0, 0, 0, 90], [0, 2, 0, -126], [0, 0, 2, -72], [0, 0, 0, 1.0]])
    assert not spm.on_spm12_grid(_field_on(mni, (91, 109, 91)))  # the 2 mm MNI box


def test_a_field_on_another_grid_needs_a_human_and_nothing_is_written(synthetic_dataset):
    fs = synthetic_dataset / "derivatives" / "freesurfer" / "sub-9"
    img = nib.Nifti1Image.from_filename(str(fs / "y_sub-9_T1w.nii"), mmap=False)
    data = img.get_fdata(dtype=np.float32)  # in memory: never save over a mapped path
    wide = np.diag([-2.0, 2.0, 2.0, 1.0])
    wide[:3, 3] = [90, -126, -72]
    nib.save(nib.Nifti1Image(data, wide), fs / "y_sub-9_T1w_2mm.nii")
    (fs / "y_sub-9_T1w.nii").unlink()  # the 2 mm field replaces it, written to a fresh path
    (plan,) = spm.plan_dataset(synthetic_dataset)
    assert plan.verdict == "needs-human" and "SPM12's template grid" in plan.reason
    assert spm.write([plan], synthetic_dataset) == []


def test_four_dimensional_field_layout_loads(tmp_path):
    values = np.arange(4 * 5 * 6 * 3, dtype=np.float32).reshape(4, 5, 6, 3)
    path = tmp_path / "y_four.nii"
    nib.save(nib.Nifti1Image(values, np.eye(4)), path)
    loaded = spm.load_field(path)
    assert loaded.shape == (4, 5, 6) and np.array_equal(loaded.values, values)


def test_a_refused_rerun_removes_previous_outputs_and_keeps_other_tracks(synthetic_dataset):
    from ieeg_geometry.ownership import OwnedPath, write_ownership

    other = OwnedPath("sub-9/ieeg/other.tsv", "electrodes", (), "freesurfer-talairach", None)
    write_ownership(synthetic_dataset, "0.0.1", [other])
    written = spm.write(spm.plan_dataset(synthetic_dataset), synthetic_dataset)
    assert all((synthetic_dataset / w).exists() for w in written)
    (synthetic_dataset / "derivatives/freesurfer/sub-9/pial.R.surf.gii").unlink()  # now refused
    (plan,) = spm.plan_dataset(synthetic_dataset)
    assert plan.verdict == "refused"
    assert spm.write([plan], synthetic_dataset) == []
    assert not any((synthetic_dataset / w).exists() for w in written)
    owned = read_ownership(synthetic_dataset)
    assert owned is not None and [e.path for e in owned.entries] == [other.path]
    assert owned.pipeline_version == spm.pipeline_version()


def _write_once(dataset: Path):
    plans = spm.plan_dataset(dataset)
    written = spm.write(plans, dataset)
    rels = {Path(w).name.split("_space-")[-1]: dataset / w for w in written}
    return written, rels["IXI549Space_electrodes.tsv"], rels["IXI549Space_coordsystem.json"]


def test_owned_files_record_their_hash(synthetic_dataset):
    _write_once(synthetic_dataset)
    owned = read_ownership(synthetic_dataset)
    assert owned is not None and len(owned.entries) == 2
    for entry in owned.entries:
        data = (synthetic_dataset / entry.path).read_bytes()
        assert entry.output_sha256 == hashlib.sha256(data).hexdigest()


@pytest.mark.parametrize("which", ["sidecar", "tsv"])
def test_a_hand_edit_of_either_file_keeps_both_files(synthetic_dataset, which):
    """The electrodes file and its coordsystem file are one unit (as in B1)."""
    written, tsv, sidecar = _write_once(synthetic_dataset)
    # a changed input makes the regenerated content differ, so a kept file is visible
    side = synthetic_dataset / "sub-9" / "ieeg" / "sub-9_coordsystem.json"
    side.write_text(
        json.dumps({"iEEGCoordinateSystem": "Other", "iEEGCoordinateUnits": "mm", "x": 1})
    )
    edited = tsv if which == "tsv" else sidecar
    edited.write_text(
        edited.read_text() + "\n"
        if which == "tsv"
        else edited.read_text().replace("NEMAR", "NEMAR (edited)")
    )
    before = {p: p.read_bytes() for p in (tsv, sidecar)}
    (plan,) = spm.plan_dataset(synthetic_dataset)
    assert plan.verdict == "write"
    again = spm.write([plan], synthetic_dataset)
    assert again == [] and {p: p.read_bytes() for p in (tsv, sidecar)} == before
    rel = {p: p.relative_to(synthetic_dataset).as_posix() for p in (tsv, sidecar)}
    assert plan.kept[rel[edited]] == "hand-edited, kept"
    other = sidecar if edited is tsv else tsv
    assert plan.kept[rel[other]] == "kept with its pair"


def _tsv_entry(dataset: Path):
    owned = read_ownership(dataset)
    assert owned is not None
    return next(e for e in owned.entries if e.path.endswith("electrodes.tsv"))


def test_untouched_pair_is_regenerated_when_its_content_changes(synthetic_dataset):
    _, tsv, sidecar = _write_once(synthetic_dataset)
    old_bytes = tsv.read_bytes()
    old_entry = _tsv_entry(synthetic_dataset)
    source = synthetic_dataset / "sub-9" / "ieeg" / "sub-9_electrodes.tsv"
    rows = source.read_text().splitlines()
    first = rows[1].split("\t")
    first[1] = f"{float(first[1]) + 0.2:.4f}"  # a changed input
    rows[1] = "\t".join(first)
    source.write_text("\n".join(rows) + "\n")
    (plan,) = spm.plan_dataset(synthetic_dataset)
    again = spm.write([plan], synthetic_dataset)
    assert not plan.kept and len(again) == 2
    assert tsv.read_bytes() != old_bytes  # regenerated with the new input
    new_entry = _tsv_entry(synthetic_dataset)
    assert new_entry.output_sha256 != old_entry.output_sha256
    assert new_entry.output_sha256 == hashlib.sha256(tsv.read_bytes()).hexdigest()


def test_a_refused_rerun_leaves_a_hand_edited_file_in_place(synthetic_dataset):
    _, tsv, sidecar = _write_once(synthetic_dataset)
    tsv.write_text(tsv.read_text() + "\n")
    (synthetic_dataset / "derivatives/freesurfer/sub-9/pial.R.surf.gii").unlink()
    (plan,) = spm.plan_dataset(synthetic_dataset)
    assert plan.verdict == "refused"
    spm.write([plan], synthetic_dataset)
    assert tsv.exists() and sidecar.exists()  # neither deleted: the unit has a hand edit
    owned = read_ownership(synthetic_dataset)
    assert owned is not None and {e.path for e in owned.entries} == {
        p.relative_to(synthetic_dataset).as_posix() for p in (tsv, sidecar)
    }
    assert set(plan.kept) == {p.relative_to(synthetic_dataset).as_posix() for p in (tsv, sidecar)}


def test_a_changed_pairing_removes_the_other_files_untouched_outputs(synthetic_dataset):
    """The output name keeps the source's other entities, so a different file means new paths."""
    _, old_tsv, old_sidecar = _write_once(synthetic_dataset)
    ieeg = synthetic_dataset / "sub-9" / "ieeg"
    for suffix in ("electrodes.tsv", "coordsystem.json"):
        (ieeg / f"sub-9_{suffix}").rename(ieeg / f"sub-9_acq-b_{suffix}")
    (plan,) = spm.plan_dataset(synthetic_dataset)
    assert plan.chosen is not None and "acq-b" in plan.chosen.electrodes_path.name
    written = spm.write([plan], synthetic_dataset)
    assert all("sub-9_acq-b_space-IXI549Space" in w for w in written) and len(written) == 2
    assert not old_tsv.exists() and not old_sidecar.exists()
    owned = read_ownership(synthetic_dataset)
    assert owned is not None and {e.path for e in owned.entries} == set(written)


def test_subject_relative_intended_for_is_read_both_ways(tmp_path):
    fs = tmp_path / "derivatives" / "freesurfer" / "sub-3"
    fs.mkdir(parents=True)
    field_path = fs / "y_sub-3_ses-mri01_T1w.nii"
    anat = tmp_path / "sub-3" / "ses-1" / "anat"
    anat.mkdir(parents=True)
    (anat / "sub-3_ses-1_T1w.nii").write_bytes(b"")
    status, subject = spm.intended_for_status, tmp_path / "sub-3"
    legacy = "ses-1/anat/sub-3_ses-1_T1w.nii"
    # read as subject-relative it names a different existing T1: never paired
    assert status(legacy, field_path, tmp_path, subject) == spm.INTENDED_OTHER
    # read dataset-relative only, the same value names nothing that exists
    assert status(legacy, field_path, tmp_path) == spm.INTENDED_UNKNOWN
    # a dataset-relative value that is the field's T1 pairs
    (fs / "sub-3_ses-mri01_T1w.nii").write_bytes(b"")
    own = "derivatives/freesurfer/sub-3/sub-3_ses-mri01_T1w.nii"
    assert status(own, field_path, tmp_path, subject) == spm.INTENDED_MATCH


def test_an_intended_for_that_leaves_the_dataset_is_unknown(tmp_path):
    root = tmp_path / "ds"
    fs = root / "derivatives" / "freesurfer" / "sub-3"
    fs.mkdir(parents=True)
    field_path = fs / "y_sub-3_T1w.nii"
    (tmp_path / "sub-3_T1w.nii").write_bytes(b"")  # exists, but outside the dataset
    (fs / "sub-3_T1w.nii").write_bytes(b"")
    status = spm.intended_for_status
    assert status("../sub-3_T1w.nii", field_path, root, root / "sub-3") == spm.INTENDED_UNKNOWN
    assert status("sub-3/../../sub-3_T1w.nii", field_path, root, root / "sub-3") == (
        spm.INTENDED_UNKNOWN
    )
    inside = "derivatives/freesurfer/x/../sub-3/sub-3_T1w.nii"  # `..` that stays inside
    assert status(inside, field_path, root, root / "sub-3") == spm.INTENDED_MATCH


def _subject_relative_dataset(dataset: Path, value: str, *, field_in_subject: bool) -> None:
    anat = dataset / "sub-9" / "anat"
    anat.mkdir(parents=True)
    (anat / "sub-9_T1w.nii").write_bytes(b"")
    (anat / "sub-9_T1w_other.nii").write_bytes(b"")
    if field_in_subject:  # the field lives beside the subject's own T1
        (dataset / "derivatives/freesurfer/sub-9/y_sub-9_T1w.nii").rename(anat / "y_sub-9_T1w.nii")
    side = dataset / "sub-9" / "ieeg" / "sub-9_coordsystem.json"
    doc = json.loads(side.read_text())
    doc["IntendedFor"] = value
    side.write_text(json.dumps(doc))


def test_legacy_subject_relative_intended_for_naming_another_t1_is_never_paired(synthetic_dataset):
    _subject_relative_dataset(synthetic_dataset, "anat/sub-9_T1w_other.nii", field_in_subject=False)
    (plan,) = spm.plan_dataset(synthetic_dataset)
    assert plan.chosen is None and plan.verdict == "refused"
    assert "different T1" in plan.reason
    # the file would otherwise pair by template verification (it is the only candidate)
    assert plan.candidates[0].intended == spm.INTENDED_OTHER and plan.candidates[0].eligible


def test_legacy_subject_relative_intended_for_naming_the_fields_t1_pairs(synthetic_dataset):
    _subject_relative_dataset(synthetic_dataset, "anat/sub-9_T1w.nii", field_in_subject=True)
    (plan,) = spm.plan_dataset(synthetic_dataset)
    assert plan.chosen is not None, plan.reason
    assert plan.basis == "IntendedFor names the field's T1" and plan.verdict == "write"


def test_a_session_plans_outputs_survive_a_no_session_plans_refusal_and_repairing(
    synthetic_dataset,
):
    """`_owned_by` must not claim `sub-9_ses-1_...` outputs for the no-session plan."""
    from ieeg_geometry.ownership import OwnedPath, write_ownership

    ses = synthetic_dataset / "sub-9" / "ses-1" / "ieeg"
    ses.mkdir(parents=True)
    entries = []
    for kind, name in (("electrodes", "electrodes.tsv"), ("coordsystem", "coordsystem.json")):
        path = ses / f"sub-9_ses-1_space-IXI549Space_{name}"
        data = f"{kind}\n".encode()
        path.write_bytes(data)
        entries.append(
            OwnedPath(
                path.relative_to(synthetic_dataset).as_posix(),
                kind,
                (),
                spm.METHOD,
                None,
                hashlib.sha256(data).hexdigest(),
            )
        )
    write_ownership(synthetic_dataset, "0.0.1", entries)

    def survives() -> bool:
        owned = read_ownership(synthetic_dataset)
        assert owned is not None
        return all((synthetic_dataset / e.path).exists() for e in entries) and {
            e.path for e in entries
        } <= {e.path for e in owned.entries}

    no_session = [p for p in spm.plan_dataset(synthetic_dataset) if p.session is None]
    assert [p.verdict for p in no_session] == ["write"]
    spm.write(no_session, synthetic_dataset)  # a change of pairing for the no-session plan
    assert survives()
    (synthetic_dataset / "derivatives/freesurfer/sub-9/pial.R.surf.gii").unlink()
    refused = [p for p in spm.plan_dataset(synthetic_dataset) if p.session is None]
    assert [p.verdict for p in refused] == ["refused"]
    spm.write(refused, synthetic_dataset)
    assert survives()


@pytest.mark.parametrize("mixed", [True, False])
def test_files_with_cortical_contacts_are_refused_with_their_own_reason(synthetic_dataset, mixed):
    tsv = synthetic_dataset / "sub-9" / "ieeg" / "sub-9_electrodes.tsv"
    rows = tsv.read_text().splitlines()
    rows = [r.replace("sEEG", "ECoG") if (not mixed or i % 2) else r for i, r in enumerate(rows)]
    tsv.write_text("\n".join(rows) + "\n")
    (plan,) = spm.plan_dataset(synthetic_dataset)
    assert plan.verdict == "refused" and plan.chosen is None
    assert "the SPM path writes depth-only files" in plan.reason
    assert "FreeSurfer surface method" in plan.reason
    assert ("mixed contact types" in plan.reason) is mixed
    assert spm.write([plan], synthetic_dataset) == []


def test_a_dirty_source_gives_a_valid_table(synthetic_dataset):
    src = synthetic_dataset / "sub-9" / "ieeg" / "sub-9_electrodes.tsv"
    lines = src.read_text().splitlines()
    dirty = ["name\tx\ty\tz\tsize\ttype\themisphere\tzone\tnote"]
    for line in lines[1:]:
        cells = line.split("\t")
        cells[4], cells[6] = "NaN", "right"
        dirty.append("\t".join([*cells, "yes", ""]))
    src.write_text("\n".join(dirty) + "\n")
    (synthetic_dataset / "electrodes.json").write_text(
        json.dumps({"zone": {"Levels": {"yes": "y", "no": "n"}}})
    )
    (plan,) = spm.plan_dataset(synthetic_dataset)
    assert plan.verdict == "write", plan.reason
    spm.write([plan], synthetic_dataset)
    tsv = synthetic_dataset / "sub-9" / "ieeg" / "sub-9_space-IXI549Space_electrodes.tsv"
    rows = [ln.split("\t") for ln in tsv.read_text().splitlines()]
    assert rows[0] == ["name", "x", "y", "z", "size", "type", "hemisphere", "zone"]
    assert {r[4] for r in rows[1:]} == {"n/a"} and {r[6] for r in rows[1:]} == {"R"}
    assert "nan" not in tsv.read_text().lower()
    (cleaning,) = plan.cleaning.values()
    assert cleaning.dropped_columns == ("note",) and cleaning.coerced_cells["size"] == 41


def test_a_repeated_electrode_name_is_refused_by_the_spm_track(synthetic_dataset):
    src = synthetic_dataset / "sub-9" / "ieeg" / "sub-9_electrodes.tsv"
    lines = src.read_text().splitlines()
    lines[2] = "\t".join([lines[1].split("\t")[0], *lines[2].split("\t")[1:]])
    src.write_text("\n".join(lines) + "\n")
    (plan,) = spm.plan_dataset(synthetic_dataset)
    assert plan.verdict != "write"
    assert any("electrodes-names" in c.note for c in plan.candidates)
