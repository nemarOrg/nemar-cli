import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from ieeg_geometry import freesurfer as fsm
from ieeg_geometry.bids import Contact, ElectrodeSet, GeometryRefusal
from ieeg_geometry.ownership import OwnedPath, read_ownership, write_ownership
from ieeg_geometry.reference import load_reference

FIX = Path(__file__).parent / "fixtures" / "fs_dataset"
P02 = "sub-p02/ses-umcuiemu01/ieeg/sub-p02_ses-umcuiemu01_acq-clinical"
P03 = "sub-p03/ses-nyuecog01/ieeg/sub-p03_ses-nyuecog01_acq-clinical"
P02_FS_COORD = P02 + "_space-fsaverage_coordsystem.json"
P03_MNI_COORD = P03 + "_space-MNI305_coordsystem.json"
P02_FS = P02 + "_space-fsaverage_electrodes.tsv"


@pytest.fixture
def ds(tmp_path: Path) -> Path:
    target = tmp_path / "ds"
    shutil.copytree(FIX, target)
    return target


def _by_sub(results, sub):
    return next(r for r in results if r.subject == sub)


def _read_tsv(path: Path):
    lines = path.read_text().splitlines()
    header = lines[0].split("\t")
    return header, [dict(zip(header, ln.split("\t"), strict=True)) for ln in lines[1:]]


def _xyz(rows):
    return np.array([[float(r["x"]), float(r["y"]), float(r["z"])] for r in rows])


def _independent_matrix(path: Path) -> np.ndarray:
    found = re.search(r"Linear_Transform\s*=([^;]*);", path.read_text())
    assert found is not None
    nums = found.group(1).split()
    m = np.eye(4)
    m[:3, :] = np.array([float(v) for v in nums]).reshape(3, 4)
    return m


def test_talairach_parser_matches_independent_read():
    xfm = FIX / "derivatives/freesurfer/sub-p03/mri/transforms/talairach.xfm"
    got = fsm.parse_talairach_xfm(xfm)
    assert got[0, 0] == pytest.approx(1.114478)
    assert np.allclose(got, _independent_matrix(xfm))


@pytest.mark.parametrize(
    "text",
    [
        "MNI Transform File\nTransform_Type = Thin_plate_spline;\n",
        "MNI Transform File\nTransform_Type = Linear;\nLinear_Transform =\n1 0 0 0\n0 1 0 0;\n",
        "MNI Transform File\nTransform_Type = Linear;\nLinear_Transform = 1 0 0 0 0 1 0 0 0 0 x 0;",
    ],
)
def test_talairach_parser_refuses_other_formats(tmp_path, text):
    path = tmp_path / "talairach.xfm"
    path.write_text(text)
    with pytest.raises(GeometryRefusal) as exc:
        fsm.parse_talairach_xfm(path)
    assert exc.value.reason == "xfm-format"


def test_fsaverage6_sphere_is_vendored_and_aligned():
    fs6 = fsm.load_fsaverage6()
    for hemi in ("L", "R"):
        assert fs6.sphere[hemi].shape == (40962, 3) == fs6.pial[hemi].shape
        assert np.linalg.norm(fs6.sphere[hemi], axis=1).mean() == pytest.approx(100.0, abs=0.1)


def test_scanner_ras_subject_is_detected(ds):
    """sub-p02 is only in its surface frame after c_ras is subtracted."""
    res = _by_sub(fsm.plan_dataset(ds), "p02")
    assert res.frame is not None and res.frame.frame == "scanner"
    assert res.frame.fits["ecog"].as_declared.grade == "fail"
    assert res.frame.fits["ecog"].with_c_ras.grade == "specific"
    assert [o.label for o in res.outputs] == ["fsaverage"]


def test_declared_frame_subject_keeps_declared(ds):
    res = _by_sub(fsm.plan_dataset(ds), "p03")
    assert res.frame is not None and res.frame.frame == "tkr" and res.frame.grade == "specific"


def test_surface_method_lands_on_fsaverage6_vertices(ds):
    res = _by_sub(fsm.plan_dataset(ds), "p03")
    out = next(o for o in res.outputs if o.label == "fsaverage")
    fs6 = np.vstack([fsm.load_fsaverage6().pial["L"], fsm.load_fsaverage6().pial["R"]])
    for p in out.xyz:
        assert np.abs(fs6 - p).sum(axis=1).min() < 1e-3  # float32 round trip
    assert out.verification.grade == "specific"
    assert out.method == fsm.METHOD_SURFACE
    assert out.pial_distance_max_mm <= fsm.SURFACE_MAX_MM


def test_surface_method_matches_independent_registration(ds):
    """One contact followed by hand: nearest pial vertex, its sphere.reg, nearest fs6 sphere."""
    import nibabel as nib

    res = _by_sub(fsm.plan_dataset(ds), "p03")
    out = next(o for o in res.outputs if o.label == "fsaverage")
    name = out.rows[0]["name"]
    row = next(r for r in _read_tsv(ds / f"{P03}_electrodes.tsv")[1] if r["name"] == name)
    point = np.array([float(row[a]) for a in "xyz"])  # tkr: declared frame
    root = ds / "derivatives/freesurfer/sub-p03/surf"
    best = None
    for hemi, stem in (("L", "lh"), ("R", "rh")):
        v = nib.freesurfer.read_geometry(str(root / f"{stem}.pial"))[0]
        d = np.linalg.norm(v - point, axis=1)
        if best is None or d.min() < best[0]:
            best = (d.min(), hemi, stem, int(d.argmin()))
    _, hemi, stem, i = best
    sph = nib.freesurfer.read_geometry(str(root / f"{stem}.sphere.reg"))[0][i]
    fs6 = fsm.load_fsaverage6()
    unit = fs6.sphere[hemi] / np.linalg.norm(fs6.sphere[hemi], axis=1, keepdims=True)
    j = int(np.argmax(unit @ (sph / np.linalg.norm(sph))))
    assert np.allclose(out.xyz[0], fs6.pial[hemi][j], atol=1e-3)


def test_affine_contact_matches_numpy_from_the_matrix(ds):
    res = _by_sub(fsm.plan_dataset(ds), "p03")
    out = next(o for o in res.outputs if o.label == "MNI305")
    assert out.method == fsm.METHOD_AFFINE
    matrix = _independent_matrix(ds / "derivatives/freesurfer/sub-p03/mri/transforms/talairach.xfm")
    c_ras = np.asarray(res.frame.c_ras)
    declared = {r["name"]: r for r in _read_tsv(ds / f"{P03}_electrodes.tsv")[1]}
    for row, got in zip(out.rows, out.xyz, strict=True):
        tkr = np.array([float(declared[row["name"]][a]) for a in "xyz"])
        scanner_h = np.append(tkr + c_ras, 1.0)  # tkr RAS + c_ras = scanner RAS
        assert np.allclose(got, (matrix @ scanner_h)[:3], atol=1e-9)
    assert out.verification.passed


def test_neither_frame_is_refused_with_distances(ds):
    path = ds / f"{P03}_electrodes.tsv"
    header, rows = _read_tsv(path)
    for r in rows:
        r["x"] = f"{float(r['x']) + 40.0:.3f}"
    path.write_text(
        "\n".join(
            "\t".join(r[h] for h in header) for r in [dict(zip(header, header, strict=True))] + rows
        )
        + "\n"
    )
    res = _by_sub(fsm.plan_dataset(ds), "p03")
    assert res.outputs == []
    assert res.refusals[0].reason == "frame-not-found"
    assert "median" in res.refusals[0].message


def test_meters_are_converted(ds):
    base = _by_sub(fsm.plan_dataset(ds), "p03")
    path = ds / f"{P03}_electrodes.tsv"
    header, rows = _read_tsv(path)
    for r in rows:
        for a in "xyz":
            r[a] = repr(float(r[a]) / 1000.0)
    lines = ["\t".join(header)] + ["\t".join(r[h] for h in header) for r in rows]
    path.write_text("\n".join(lines) + "\n")
    coord = ds / f"{P03}_coordsystem.json"
    doc = json.loads(coord.read_text())
    doc["iEEGCoordinateUnits"] = "m"
    coord.write_text(json.dumps(doc))
    res = _by_sub(fsm.plan_dataset(ds), "p03")
    assert [o.label for o in res.outputs] == [o.label for o in base.outputs]
    for a, b in zip(res.outputs, base.outputs, strict=True):
        assert np.allclose(a.xyz, b.xyz, atol=1e-3)


def test_authors_template_file_wins(ds):
    folder = ds / "sub-p03/ses-nyuecog01/ieeg"
    stem = "sub-p03_ses-nyuecog01_acq-clinical"
    shutil.copy(
        folder / f"{stem}_electrodes.tsv", folder / f"{stem}_space-fsaverage_electrodes.tsv"
    )
    shutil.copy(
        folder / f"{stem}_coordsystem.json", folder / f"{stem}_space-fsaverage_coordsystem.json"
    )
    results = fsm.plan_dataset(ds)
    own = next(r for r in results if r.source.name == f"{stem}_electrodes.tsv")
    assert all(o.label != "fsaverage" for o in own.outputs)
    assert any(s.reason == "authors-file" and s.scope == "fsaverage" for s in own.skipped)
    assert any(s.reason == "already-template" for r in results for s in r.skipped)


def test_without_sphere_reg_everything_is_affine(ds):
    for f in (ds / "derivatives/freesurfer/sub-p02/surf").glob("*.sphere.reg"):
        f.unlink()
    res = _by_sub(fsm.plan_dataset(ds), "p02")
    assert res.n_surface == 0 and res.n_affine == 56
    assert all(o.label != "fsaverage" for o in res.outputs)


def _depth_set(sphere, c_ras, n=60, radius=58.0):
    rng = np.random.default_rng(3)
    d = rng.normal(size=(n, 3))
    tkr = d / np.linalg.norm(d, axis=1, keepdims=True) * radius
    contacts = [Contact(f"D{i}", *(tkr[i] + c_ras), type="seeg") for i in range(n)]
    return ElectrodeSet(Path("e.tsv"), None, "s", None, None, None, "mm", 1.0, contacts)


def test_depth_contacts_need_the_shipped_transform_to_decide_a_frame(sphere):
    from ieeg_geometry.surfaces import Surface

    big = Surface(sphere.vertices * 6.0, sphere.faces)
    c_ras = (10.0, -5.0, 4.0)
    eset = _depth_set(big, np.asarray(c_ras))
    decision = fsm.decide_frame(eset, [big], c_ras, has_xfm=True)
    assert decision.frame == "scanner" and decision.grade == "plausible"
    assert decision.independent == "shipped talairach.xfm"
    with pytest.raises(GeometryRefusal) as exc:
        fsm.decide_frame(eset, [big], c_ras, has_xfm=False)
    assert exc.value.reason == "frame-evidence-insufficient"


def test_write_outputs_merges_ownership_and_is_idempotent(ds):
    other = OwnedPath(
        "sub-x/other_space-IXI549Space_electrodes.tsv",
        "electrodes",
        (("a", "b"),),
        "spm-deformation",
    )
    write_ownership(ds, "0.0.1", [other])
    entries = fsm.write_outputs(ds, fsm.plan_dataset(ds))
    paths = {e.path for e in entries}
    assert any(p.endswith("_space-fsaverage_electrodes.tsv") for p in paths)
    assert any(p.endswith("_space-MNI305_coordsystem.json") for p in paths)
    owned = read_ownership(ds)
    assert owned is not None
    by_path = {e.path: e for e in owned.entries}
    assert other.path in by_path and by_path[other.path].method == "spm-deformation"
    assert paths <= set(by_path)
    for e in entries:
        assert (ds / e.path).exists()
    sidecar = json.loads((ds / P02_FS_COORD).read_text())
    assert sidecar["iEEGCoordinateSystem"] == "fsaverage"
    assert sidecar["iEEGCoordinateUnits"] == "mm"
    assert sidecar["iEEGCoordinateProcessingDescription"].startswith("Computed by NEMAR")
    assert sidecar["iEEGCoordinateProcessingReference"] == fsm.METHOD_REFERENCE
    affine = json.loads((ds / P03_MNI_COORD).read_text())
    assert "approximate" in affine["iEEGCoordinateProcessingDescription"]
    before = {p: (ds / p).read_bytes() for p in paths}
    ownership_before = (ds / ".nemar/ieeg-geometry.json").read_bytes()
    # second run: our outputs are owned, so they are regenerated, not taken as the authors'
    entries2 = fsm.write_outputs(ds, fsm.plan_dataset(ds))
    assert {e.path for e in entries2} == paths
    assert {p: (ds / p).read_bytes() for p in paths} == before
    assert (ds / ".nemar/ieeg-geometry.json").read_bytes() == ownership_before


def test_written_files_verify_against_fsaverage(ds):
    fsm.write_outputs(ds, fsm.plan_dataset(ds))
    _, rows = _read_tsv(ds / P02_FS)
    from ieeg_geometry.verify import fit

    assert fit(_xyz(rows), load_reference("fsaverage"), "ecog").grade == "specific"
    assert set(rows[0]) >= {"name", "x", "y", "z", "hemisphere"}


def test_report_shows_decision_methods_and_verification(ds):
    result = subprocess.run(
        [sys.executable, "-m", "ieeg_geometry", "inspect", str(ds)], capture_output=True, text=True
    )
    assert result.returncode == 0, result.stderr
    out = result.stdout
    assert "frame decision: scanner RAS (c_ras subtracted)" in out
    assert "methods: 111 contacts by surface registration (fsaverage), 13 by talairach.xfm" in out
    assert "verified vs fsaverage" in out
