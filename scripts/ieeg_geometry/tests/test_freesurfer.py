import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from ieeg_geometry import freesurfer as fsm
from ieeg_geometry.ownership import OwnedPath, read_ownership, write_ownership
from ieeg_geometry.reference import load_reference

FIX = Path(__file__).parent / "fixtures" / "fs_dataset"
P02 = "sub-p02/ses-umcuiemu01/ieeg/sub-p02_ses-umcuiemu01_acq-clinical"
P03 = "sub-p03/ses-nyuecog01/ieeg/sub-p03_ses-nyuecog01_acq-clinical"
P02_FS_COORD = P02 + "_space-fsaverage_coordsystem.json"
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


def test_fsaverage6_sphere_is_vendored_and_aligned():
    fs6 = fsm.load_fsaverage6()
    for hemi in ("L", "R"):
        assert fs6.sphere[hemi].shape == (40962, 3) == fs6.pial[hemi].shape
        assert np.linalg.norm(fs6.sphere[hemi], axis=1).mean() == pytest.approx(100.0, abs=0.1)


def test_scanner_ras_subject_is_detected(ds):
    """sub-p02 is only in its surface frame after c_ras is subtracted."""
    res = _by_sub(fsm.plan_dataset(ds), "p02")
    assert res.frame is not None and res.frame.frame == "scanner"
    assert res.frame.fit.as_declared.grade == "fail"
    assert res.frame.fit.with_c_ras.grade == "specific"
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
    assert out.method == fsm.METHOD
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


def test_depth_contacts_are_left_out_and_counted(ds):
    res = _by_sub(fsm.plan_dataset(ds), "p03")
    assert res.n_surface == 90
    assert res.left_out == {fsm.LEFT_DEPTH: 30, fsm.LEFT_FAR: 4}
    out = res.outputs[0]
    placed = {r["name"] for r in out.rows}
    depth = {r["name"] for r in _read_tsv(ds / f"{P03}_electrodes.tsv")[1] if r["type"] == "depth"}
    assert not depth & placed  # ruling 11 and 20: a depth contact is never snapped
    assert [o.label for o in res.outputs] == ["fsaverage"]  # no MNI305 output


def test_subject_without_cortical_contacts_places_nothing(ds):
    path = ds / f"{P03}_electrodes.tsv"
    header, rows = _read_tsv(path)
    keep = [r for r in rows if r["type"] == "depth"]
    lines = ["\t".join(header)] + ["\t".join(r[h] for h in header) for r in keep]
    path.write_text("\n".join(lines) + "\n")
    res = _by_sub(fsm.plan_dataset(ds), "p03")
    assert res.outputs == []
    assert res.refusals[0].reason == "too-few-cortical-contacts"
    assert res.left_out == {fsm.LEFT_DEPTH: 30}


def test_without_sphere_reg_nothing_is_placed(ds):
    for f in (ds / "derivatives/freesurfer/sub-p02/surf").glob("*.sphere.reg"):
        f.unlink()
    res = _by_sub(fsm.plan_dataset(ds), "p02")
    assert res.outputs == [] and res.n_surface == 0
    assert res.left_out == {fsm.LEFT_NO_SPHERE: 56}
    assert res.refusals[0].reason == "no-contacts-placed"


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
    assert not [p for p in paths if "MNI305" in p]  # ruling 20: no affine output
    text = sidecar["iEEGCoordinateProcessingDescription"]
    assert "not placed" in text
    meta = by_path[f"{P03}_space-fsaverage_electrodes.tsv"].verification
    assert meta is not None and "left out: 30 depth or unknown-type contacts" in meta.rule
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
    assert "placed by surface registration (fsaverage): 90 contacts" in out
    assert "left out: 30 depth or unknown-type contacts" in out
    assert "4 cortical contacts more than 3.0 mm from the pial surface" in out
    assert "verified vs fsaverage" in out
