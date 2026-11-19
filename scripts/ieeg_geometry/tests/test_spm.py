"""SPM deformation inversion, pairing, verification and writing (card B2)."""

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
    assert plan.inversion is not None and plan.inversion.median_residual < 0.05


def test_sub2_verification_against_the_template_shell_is_recorded_and_refused():
    """Measured on the real field: the contacts sit inside the MNI shell (97 percent) but deep
    contacts are 7.7 mm from its vertices, over L1's 6.0 mm sEEG median. L1's grade rules, so the
    subject is refused and nothing is written until the lead rules on the shell reference."""
    (plan,) = spm.plan_dataset(FIXTURE)
    head = plan.template_fit["seeg"]
    assert head.inside_evaluated and head.inside_fraction is not None
    assert head.inside_fraction > 0.95
    assert head.median_mm == pytest.approx(7.68, abs=0.05)
    assert plan.verdict == "refused" and "verification" in plan.reason
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
    assert "verification vs MNI152NLin2009cAsym" in out


# ---- the write path on a synthetic subject whose contacts lie on the template -------------


@pytest.fixture
def synthetic_dataset(tmp_path, synthetic_field) -> Path:
    """A subject with 40 ECoG contacts on the MNI shell, in a native frame the field maps."""
    ref = load_reference("MNI152NLin2009cAsym")
    rng = np.random.default_rng(3)
    verts = ref[1].vertices  # right hemisphere
    template = verts[rng.choice(len(verts), 40, replace=False)]
    template = template * 0.995  # nudge inside the shell, well under 2 mm
    native = _native(template)
    ieeg = tmp_path / "sub-9" / "ieeg"
    ieeg.mkdir(parents=True)
    rows = ["name\tx\ty\tz\tsize\ttype\themisphere"]
    for i, p in enumerate(native):
        rows.append(f"G{i + 1}\t{p[0]:.4f}\t{p[1]:.4f}\t{p[2]:.4f}\t4\tECoG\tR")
    rows.append("G41\tn/a\tn/a\tn/a\t4\tECoG\tR")
    (ieeg / "sub-9_electrodes.tsv").write_text("\n".join(rows) + "\n")
    (ieeg / "sub-9_coordsystem.json").write_text(
        json.dumps({"iEEGCoordinateSystem": "Other", "iEEGCoordinateUnits": "mm"})
    )
    fdir = tmp_path / "derivatives" / "freesurfer" / "sub-9"
    fdir.mkdir(parents=True)
    _write_field(fdir / "y_sub-9_T1w.nii")
    return tmp_path


def test_verified_subject_is_written_with_provenance_and_ownership(synthetic_dataset):
    (plan,) = spm.plan_dataset(synthetic_dataset)
    assert plan.verdict == "write", plan.reason
    assert plan.template_fit["ecog"].grade == "specific"
    written = spm.write([plan], synthetic_dataset)
    tsv = synthetic_dataset / "sub-9" / "ieeg" / "sub-9_space-IXI549Space_electrodes.tsv"
    sidecar = synthetic_dataset / "sub-9" / "ieeg" / "sub-9_space-IXI549Space_coordsystem.json"
    assert {Path(w).name for w in written} == {tsv.name, sidecar.name}
    doc = json.loads(sidecar.read_text())
    assert doc["iEEGCoordinateSystem"] == "IXI549Space" and doc["iEEGCoordinateUnits"] == "mm"
    desc = doc["iEEGCoordinateProcessingDescription"]
    assert desc.startswith("Computed by NEMAR")
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
        "y_sub-9_T1w.nii",
    }


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


def test_a_shifted_subject_is_refused_and_nothing_is_written(synthetic_dataset):
    tsv = synthetic_dataset / "sub-9" / "ieeg" / "sub-9_electrodes.tsv"
    rows = tsv.read_text().splitlines()
    shifted = [rows[0]]
    for r in rows[1:-1]:
        f = r.split("\t")
        f[1] = f"{float(f[1]) + 25.0:.4f}"  # 25 mm: still invertible, no longer on the shell
        shifted.append("\t".join(f))
    shifted.append(rows[-1])
    tsv.write_text("\n".join(shifted) + "\n")
    (plan,) = spm.plan_dataset(synthetic_dataset)
    assert plan.verdict == "refused" and "verification" in plan.reason
    assert spm.write([plan], synthetic_dataset) == []
    assert not list(synthetic_dataset.rglob("*IXI549Space*"))
    assert not (synthetic_dataset / ".nemar").exists()


def _add_native_surface(dataset: Path) -> None:
    """The right-hemisphere shell mapped into the subject's native frame, as a GIfTI surface."""
    shell = load_reference("MNI152NLin2009cAsym")[1]
    verts = _native(shell.vertices * 0.995).astype(np.float32)
    faces = shell.faces.astype(np.int32)
    img = nib.gifti.GiftiImage(
        darrays=[
            nib.gifti.GiftiDataArray(verts, intent="NIFTI_INTENT_POINTSET"),
            nib.gifti.GiftiDataArray(faces, intent="NIFTI_INTENT_TRIANGLE"),
        ]
    )
    nib.save(img, dataset / "derivatives" / "freesurfer" / "sub-9" / "pial.R.surf.gii")


def test_surface_evidence_alone_refuses_a_lone_file_that_does_not_fit(synthetic_dataset):
    """Both files invert fully; only the subject surface separates a match from a wrong file."""
    _add_native_surface(synthetic_dataset)
    (good,) = spm.plan_dataset(synthetic_dataset)
    assert good.chosen is not None and good.chosen.surface_fit is not None
    assert good.chosen.surface_fit["ecog"].median_mm < 2.0 and good.verdict == "write"
    tsv = synthetic_dataset / "sub-9" / "ieeg" / "sub-9_electrodes.tsv"
    rows = tsv.read_text().splitlines()
    moved = [rows[0]]
    for r in rows[1:-1]:
        f = r.split("\t")
        f[1] = f"{float(f[1]) - 12.0:.4f}"
        moved.append("\t".join(f))
    moved.append(rows[-1])
    tsv.write_text("\n".join(moved) + "\n")
    (bad,) = spm.plan_dataset(synthetic_dataset)
    (cand,) = bad.candidates
    assert cand.n_invertible == cand.n_contacts  # the field alone cannot reject it
    assert not cand.eligible and bad.verdict == "refused"
    assert "no electrodes file matches the field" in bad.reason


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
