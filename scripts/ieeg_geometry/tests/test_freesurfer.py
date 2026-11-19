import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from ieeg_geometry import freesurfer as fsm
from ieeg_geometry import labels
from ieeg_geometry.bids import GeometryRefusal
from ieeg_geometry.ownership import OwnedPath, read_ownership, write_ownership
from ieeg_geometry.reference import load_reference

FIX = Path(__file__).parent / "fixtures" / "fs_dataset"
LABELS_FIX = Path(__file__).parent / "fixtures" / "labels"
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
    assert out.frame_fit.grade == "specific"
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
    assert res.left_out == {fsm.LEFT_DEPTH: 30}  # no cortical contact left to name a reason for


def test_without_sphere_reg_nothing_is_placed(ds):
    for f in (ds / "derivatives/freesurfer/sub-p02/surf").glob("*.sphere.reg"):
        f.unlink()
    res = _by_sub(fsm.plan_dataset(ds), "p02")
    assert res.outputs == [] and res.n_surface == 0
    assert res.left_out == {fsm.LEFT_NO_SPHERE: 56}
    assert res.refusals[0].reason == "no-contacts-placed"


def test_write_outputs_merges_ownership_and_is_idempotent(ds):
    # a real entry written by the label track (C1) into the same dataset
    shutil.copytree(LABELS_FIX / "on006107", ds, dirs_exist_ok=True)
    assert labels.write(labels.plan_dataset(ds), ds)
    c1_owned = read_ownership(ds)
    assert c1_owned is not None
    c1_entries = {e.path: e for e in c1_owned.entries}
    assert c1_entries and all(e.method != fsm.METHOD for e in c1_entries.values())
    entries = fsm.write_outputs(ds, fsm.plan_dataset(ds))
    paths = {e.path for e in entries}
    assert any(p.endswith("_space-fsaverage_electrodes.tsv") for p in paths)
    owned = read_ownership(ds)
    assert owned is not None
    by_path = {e.path: e for e in owned.entries}
    assert {p: by_path[p] for p in c1_entries} == c1_entries  # C1's entries survive unchanged
    assert paths <= set(by_path)
    for e in entries:
        assert e.output_sha256 == hashlib.sha256((ds / e.path).read_bytes()).hexdigest()
    assert labels.write(labels.plan_dataset(ds), ds) == []  # and C1 still sees its files intact
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
    assert (
        "registration check" in meta.rule and "on fsaverage6 vertices by construction" in meta.rule
    )
    assert meta.reference == "subject pial surface" and meta.grade == "specific"
    assert "registration check" in text and "by construction" in text
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
    assert "on fsaverage6 vertices by construction" in out
    assert "registration check: " in out


def _write_sphere(path: Path, positions: np.ndarray) -> None:
    import nibabel as nib

    faces = nib.freesurfer.read_geometry(str(path))[1]
    nib.freesurfer.write_geometry(str(path), positions, faces)


def _sphere_path(ds: Path, hemi: str) -> Path:
    return ds / f"derivatives/freesurfer/sub-p03/surf/{hemi}.sphere.reg"


def test_registration_check_numbers_for_the_fixtures(ds):
    res = _by_sub(fsm.plan_dataset(ds), "p03")
    reg = res.outputs[0].registration
    assert reg.n_sampled >= 2000 and reg.side_fraction >= 0.95
    assert reg.centroid_mm <= 5.0 and reg.extent_error <= 0.10


@pytest.mark.parametrize("damage", ["scrambled", "mirrored"])
def test_a_damaged_sphere_reg_is_refused(ds, damage):
    import nibabel as nib

    for hemi in ("lh", "rh"):
        path = _sphere_path(ds, hemi)
        pos = nib.freesurfer.read_geometry(str(path))[0]
        if damage == "scrambled":
            pos = pos[np.random.default_rng(1).permutation(len(pos))]
        else:  # the other hemisphere's side of the sphere
            pos = pos * np.array([-1.0, 1.0, 1.0])
        _write_sphere(path, pos)
    res = _by_sub(fsm.plan_dataset(ds), "p03")
    assert res.outputs == []
    assert res.refusals[0].reason == "registration-check-failed"
    assert "centroid" in res.refusals[0].message
    assert res.left_out[fsm.LEFT_REGISTRATION] == 94


def test_a_sphere_reg_with_the_wrong_vertex_count_is_refused(ds):
    import shutil as sh

    sh.copy(_sphere_path(ds, "rh"), _sphere_path(ds, "lh"))  # hemisphere swapped
    res = _by_sub(fsm.plan_dataset(ds), "p03")
    assert res.outputs == [] and res.refusals[0].reason == "sphere-reg-mismatch"
    assert res.left_out[fsm.LEFT_SPHERE_UNREADABLE] == 94


def test_an_unreadable_sphere_reg_has_its_own_reason(ds):
    _sphere_path(ds, "lh").write_bytes(b"not a surface")
    res = _by_sub(fsm.plan_dataset(ds), "p03")
    assert res.refusals[0].reason == "sphere-reg-unreadable"
    assert res.left_out[fsm.LEFT_SPHERE_UNREADABLE] == 94
    assert fsm.LEFT_FAR not in res.left_out


def test_a_refused_frame_has_its_own_left_out_reason(ds):
    path = ds / f"{P03}_electrodes.tsv"
    header, rows = _read_tsv(path)
    for r in rows:
        r["x"] = f"{float(r['x']) + 40.0:.3f}"
    lines = ["\t".join(header)] + ["\t".join(r[h] for h in header) for r in rows]
    path.write_text("\n".join(lines) + "\n")
    res = _by_sub(fsm.plan_dataset(ds), "p03")
    assert res.left_out == {fsm.LEFT_DEPTH: 30, fsm.LEFT_FRAME: 94}
    assert fsm.LEFT_FAR not in res.left_out


def test_stale_owned_output_is_removed_with_its_entry(ds):
    first = fsm.write_outputs(ds, fsm.plan_dataset(ds))
    stale = {e.path for e in first if "sub-p03" in e.path}
    assert stale and all((ds / p).exists() for p in stale)
    other = OwnedPath("sub-x/o_space-IXI549Space_electrodes.tsv", "electrodes", (), "spm")
    owned = read_ownership(ds)
    assert owned is not None
    write_ownership(ds, "0.0.1", [*owned.entries, other])
    _sphere_path(ds, "lh").write_bytes(b"damaged")  # p03 now refuses; its owned outputs are stale
    results = fsm.plan_dataset(ds)  # the owned files do not hide the subject from the plan
    assert _by_sub(results, "p03").refusals[0].reason == "sphere-reg-unreadable"
    assert {e.path for e in fsm.stale_outputs(ds, results)} == stale
    fsm.write_outputs(ds, results)
    assert not any((ds / p).exists() for p in stale)
    after = read_ownership(ds)
    assert after is not None
    paths = {e.path for e in after.entries}
    assert not stale & paths and other.path in paths  # p02's and the other track's survive
    assert any("sub-p02" in p for p in paths)


def test_pipeline_version_is_the_installed_package_version():
    from importlib import metadata

    assert fsm.pipeline_version() == metadata.version("ieeg-geometry")


def _owned(ds: Path) -> dict:
    record = read_ownership(ds)
    assert record is not None
    return {e.path: e for e in record.entries}


def test_a_pair_with_one_hand_edited_file_is_kept_whole(ds):
    fsm.write_outputs(ds, fsm.plan_dataset(ds))
    tsv, sidecar = ds / P02_FS, ds / P02_FS_COORD
    tsv.write_text(tsv.read_text() + "# curator note\n")  # only the TSV is edited
    kept_tsv = tsv.read_bytes()
    sidecar.write_text(sidecar.read_text().replace("Computed by NEMAR", "Computed by NEMAR "))
    sidecar_edited = sidecar.read_bytes()
    sidecar.write_bytes(sidecar_edited.replace(b"Computed by NEMAR ", b"Computed by NEMAR"))
    kept_json = sidecar.read_bytes()  # the sidecar is back to the bytes the pipeline wrote
    owned_before = _owned(ds)
    results = fsm.plan_dataset(ds)
    assert fsm.hand_edited_outputs(ds, results) == sorted([P02_FS, P02_FS_COORD])
    fsm.write_outputs(ds, results)
    assert tsv.read_bytes() == kept_tsv and sidecar.read_bytes() == kept_json
    owned_after = _owned(ds)
    assert owned_after[P02_FS] == owned_before[P02_FS]
    assert owned_after[P02_FS_COORD] == owned_before[P02_FS_COORD]
    # the pair stays whole when its output stops being produced, too
    for f in (ds / "derivatives/freesurfer/sub-p02/surf").glob("*.sphere.reg"):
        f.write_bytes(b"damaged")
    results = fsm.plan_dataset(ds)
    assert not {P02_FS, P02_FS_COORD} & {e.path for e in fsm.stale_outputs(ds, results)}
    fsm.write_outputs(ds, results)
    assert tsv.read_bytes() == kept_tsv and sidecar.read_bytes() == kept_json


# ---- the registration conditions, one at a time ------------------------------------------------


def _registration_inputs(ds: Path):
    from ieeg_geometry.surfaces import read_freesurfer

    root = ds / "derivatives/freesurfer/sub-p03"
    subject = fsm.find_subject_dirs(ds, "p03", "nyuecog01")[0]
    surfaces = {
        h: read_freesurfer(root / "surf" / f"{s}.pial") for h, s in (("L", "lh"), ("R", "rh"))
    }
    return surfaces, fsm.load_spheres(subject, surfaces)


def _sample_index(surface, per=1000):
    return np.arange(0, len(surface.vertices), max(1, len(surface.vertices) // per))


def _retarget(spheres, surfaces, transform):
    """Spheres whose sampled vertices map to where `transform` moves their honest targets.

    `transform(hemi, positions)` returns new positions; each is snapped to the nearest
    fsaverage6 pial vertex of the hemisphere, so the mapping stays a real chain.
    """
    from scipy.spatial import KDTree

    fs6 = fsm.load_fsaverage6()
    out = {h: s.copy() for h, s in spheres.items()}
    for hemi, surf in surfaces.items():
        idx = _sample_index(surf)
        honest = fsm.to_fsaverage6(hemi, spheres[hemi][idx])
        _, vertex = KDTree(fs6.pial[hemi]).query(transform(hemi, honest))
        out[hemi][idx] = fs6.sphere[hemi][vertex]
    return out


def test_the_honest_registration_passes_every_condition(ds):
    surfaces, spheres = _registration_inputs(ds)
    check = fsm.measure_registration(surfaces, spheres)
    assert fsm.failed_conditions(check) == []


def test_only_the_side_condition_fails(ds):
    surfaces, spheres = _registration_inputs(ds)
    fs6 = fsm.load_fsaverage6()
    wrong_side = fs6.pial["L"][int(np.argmax(fs6.pial["L"][:, 0]))]  # a left vertex with x > 0
    assert wrong_side[0] > 0

    def move(hemi, pos):
        pos = pos.copy()
        if hemi == "L":
            pos[: int(0.1 * len(pos))] = wrong_side
        return pos

    check = fsm.measure_registration(surfaces, _retarget(spheres, surfaces, move))
    assert fsm.failed_conditions(check) == ["side"], check.describe()


def test_only_the_centroid_condition_fails(ds):
    """Everything moved 8 mm in y: an affine fit absorbs it, the centroid does not."""
    surfaces, spheres = _registration_inputs(ds)
    check = fsm.measure_registration(
        surfaces, _retarget(spheres, surfaces, lambda h, pos: pos + np.array([0.0, 8.0, 0.0]))
    )
    assert fsm.failed_conditions(check) == ["centroid"], check.describe()


def test_only_the_extent_condition_fails(ds):
    """Everything scaled to 70 percent about the mean: an affine fit absorbs it, the extent not."""
    surfaces, spheres = _registration_inputs(ds)
    center = np.vstack([fsm.load_fsaverage6().pial[h] for h in ("L", "R")]).mean(axis=0)
    check = fsm.measure_registration(
        surfaces, _retarget(spheres, surfaces, lambda h, pos: center + (pos - center) * 0.7)
    )
    assert fsm.failed_conditions(check) == ["extent"], check.describe()


def test_only_the_affine_condition_fails(ds):
    """The honest targets in a shuffled order: every marginal is intact, the geometry is not."""
    surfaces, spheres = _registration_inputs(ds)
    rng = np.random.default_rng(5)
    check = fsm.measure_registration(
        surfaces, _retarget(spheres, surfaces, lambda h, pos: rng.permutation(pos))
    )
    assert fsm.failed_conditions(check) == ["affine"], check.describe()


def test_an_equal_count_hemisphere_swap_is_refused(ds):
    """Left and right with the same vertex count, each given the other's sphere.reg."""
    from ieeg_geometry.surfaces import Surface

    surfaces, spheres = _registration_inputs(ds)
    left = surfaces["L"]
    mirrored = Surface(left.vertices * np.array([-1.0, 1.0, 1.0]), left.faces, "R")
    paired = {"L": left, "R": mirrored}
    honest = {"L": spheres["L"], "R": spheres["L"] * np.array([-1.0, 1.0, 1.0])}
    swapped = {"L": honest["R"], "R": honest["L"]}
    assert len(paired["L"].vertices) == len(paired["R"].vertices)
    with pytest.raises(GeometryRefusal) as exc:
        fsm.check_registration(paired, swapped)
    assert exc.value.reason == "registration-check-failed"
    assert fsm.failed_conditions(fsm.measure_registration(paired, swapped))
