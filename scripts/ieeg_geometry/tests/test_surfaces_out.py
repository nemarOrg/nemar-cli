import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

import nibabel as nib
import numpy as np
import pytest
from jsonschema import Draft202012Validator
from nibabel.gifti import GiftiDataArray, GiftiImage

from ieeg_geometry.meshwrite import decimate, encode_brain_mesh, signed_volume
from ieeg_geometry.reference import load_reference, read_brain_mesh
from ieeg_geometry.surfaces import Surface, read_surface
from ieeg_geometry.surfaces_out import build_geometry
from ieeg_geometry.verify import fit

from .conftest import icosphere

SCHEMA = json.loads(
    (Path(__file__).parents[1] / "schema" / "geometry-index.v1.json").read_text(encoding="utf-8")
)
FS_SURF = "derivatives/freesurfer-7.3.2/sub-1/surf"
GII = "derivatives/freesurfer/sub-2/pial.R.surf.gii"

# The website's TypeScript `encodeBrainMesh` output for the format's known-answer example
# (five vertices not exactly representable in float32, four triangles), taken by running it.
KNOWN_ANSWER_HEX = (
    "4e4d424d01001000050000000c00000008ce9d3a5325be3a36c19a3accccc4c0285c5d410080fb410cecdde6"
    "01802b55018098ccf413ff7fb88f018048bf5c18ff7f0ffbff7f000001000200010003000200000002000400"
    "020003000400"
)
KNOWN_POSITIONS = [
    [-12.3, 4.5, -7.25],
    [20.1, -33.7, 15.9],
    [0.0, 61.37, -2.5],
    [-45.6, -10.2, 38.8],
    [33.3, 12.0, 70.125],
]
KNOWN_INDICES = [[0, 1, 2], [1, 3, 2], [0, 2, 4], [2, 3, 4]]


def _write_gifti(path: Path, vertices: np.ndarray, faces: np.ndarray) -> None:
    img = GiftiImage(
        darrays=[
            GiftiDataArray(
                vertices.astype(np.float32), intent="NIFTI_INTENT_POINTSET", datatype="float32"
            ),
            GiftiDataArray(
                faces.astype(np.int32), intent="NIFTI_INTENT_TRIANGLE", datatype="int32"
            ),
        ]
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    nib.save(img, str(path))


def _write_electrodes(
    folder: Path, stem: str, xyz: np.ndarray, hemis: list[str], kind: str = "ECOG", frame="ScanRAS"
) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    rows = ["name\tx\ty\tz\ttype\themisphere"]
    for i, (p, h) in enumerate(zip(xyz, hemis, strict=True)):
        rows.append(f"E{i}\t{p[0]:.4f}\t{p[1]:.4f}\t{p[2]:.4f}\t{kind}\t{h}")
    (folder / f"{stem}_electrodes.tsv").write_text("\n".join(rows) + "\n", encoding="utf-8")
    (folder / f"{stem}_coordsystem.json").write_text(
        json.dumps({"iEEGCoordinateSystem": frame, "iEEGCoordinateUnits": "mm"}), encoding="utf-8"
    )


def _sample(surface: Surface, n: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return surface.vertices[rng.choice(len(surface.vertices), n, replace=False)]


@pytest.fixture(scope="module")
def dataset(tmp_path_factory, mini) -> dict:
    """A dataset built from the real fixture surfaces, with ECoG contacts cut from them.

    sub-1: FreeSurfer lh/rh.pial (tkr RAS with c_ras); contacts in scanner RAS (vertex + c_ras).
    sub-2: column-major GIfTI right hemisphere only; contacts as declared, plus left ones.
    sub-3: the same surface as sub-1 but contacts 40 mm away, which fits nothing.
    sub-4: two surface sets: FreeSurfer files needing c_ras, and a GIfTI already in scanner RAS.
    """
    root = tmp_path_factory.mktemp("ds")
    (root / "dataset_description.json").write_text('{"Name": "t", "BIDSVersion": "1.9.0"}')
    lh = read_surface(mini / FS_SURF / "lh.pial")
    rh = read_surface(mini / FS_SURF / "rh.pial")
    cras = np.asarray(lh.c_ras)
    for sub in ("sub-1", "sub-3", "sub-4"):
        dest = root / "derivatives" / "freesurfer" / sub / "surf"
        dest.mkdir(parents=True)
        for name in ("lh.pial", "rh.pial"):
            shutil.copy(mini / FS_SURF / name, dest / name)
    scanner = np.vstack([_sample(lh, 30, 1), _sample(rh, 30, 2)]) + cras
    hemis = ["L"] * 30 + ["R"] * 30
    _write_electrodes(root / "sub-1" / "ieeg", "sub-1", scanner, hemis)
    _write_electrodes(root / "sub-3" / "ieeg", "sub-3", scanner + [40.0, 0.0, 0.0], hemis)
    _write_electrodes(root / "sub-4" / "ieeg", "sub-4", scanner, hemis)
    _write_gifti(root / "sourcedata" / "sub-4" / "pial.L.surf.gii", lh.vertices + cras, lh.faces)
    _write_gifti(root / "sourcedata" / "sub-4" / "pial.R.surf.gii", rh.vertices + cras, rh.faces)
    gii_src = mini / GII
    gii_dest = root / "derivatives" / "freesurfer" / "sub-2" / "pial.R.surf.gii"
    gii_dest.parent.mkdir(parents=True)
    shutil.copy(gii_src, gii_dest)
    right = read_surface(gii_src)
    xyz = np.vstack([_sample(right, 20, 3), [[-30.0, 20.0, 30.0], [-40.0, 0.0, 10.0]]])
    _write_electrodes(root / "sub-2" / "ieeg", "sub-2", xyz, ["R"] * 20 + ["L", "L"])
    return {"root": root, "cras": cras, "scanner": scanner, "right": right, "lh": lh, "rh": rh}


@pytest.fixture(scope="module")
def built(dataset, tmp_path_factory):
    out = tmp_path_factory.mktemp("out")
    index, lines = build_geometry(dataset["root"], out, source_commit="abc123")
    return {"out": out, "index": index, "lines": lines, **dataset}


def _entry(index: dict, subject: str) -> dict:
    return next(e for e in index["entries"] if e["subject"] == subject)


def _decode(built, entry: dict, hemi: str) -> Surface:
    data = (built["out"] / "geometry" / entry["meshes"][hemi]["path"]).read_bytes()
    return read_brain_mesh(data, hemisphere=hemi)


def test_encoder_matches_the_websites_known_answer():
    data = encode_brain_mesh(np.array(KNOWN_POSITIONS, dtype=np.float32), np.array(KNOWN_INDICES))
    assert data.hex() == KNOWN_ANSWER_HEX


def test_encoder_round_trips_through_the_reader():
    sphere = icosphere(3, radius=60.0, center=(5.0, -8.0, 12.0))
    back = read_brain_mesh(encode_brain_mesh(sphere.vertices, sphere.faces))
    np.testing.assert_array_equal(back.faces, sphere.faces)
    assert np.abs(back.vertices - sphere.vertices).max() < 60.0 / 32767 + 1e-3


def test_encoder_refuses_more_than_65535_vertices():
    with pytest.raises(Exception, match="16-bit"):
        encode_brain_mesh(np.zeros((65_536, 3)), np.zeros((0, 3)))


def test_decimation_caps_vertices_and_keeps_outward_winding():
    sphere = icosphere(7, radius=70.0)  # 163,842 vertices
    assert len(sphere.vertices) > 65_535
    assert signed_volume(sphere.vertices, sphere.faces) > 0
    verts, faces = decimate(sphere.vertices, sphere.faces)
    assert len(verts) <= 65_535
    assert len(verts) > 30_000  # the cell size search does not over-shrink
    assert faces.min() >= 0 and faces.max() < len(verts)
    assert (faces[:, 0] != faces[:, 1]).all() and (faces[:, 1] != faces[:, 2]).all()
    assert (faces[:, 0] != faces[:, 2]).all()
    vol_before = signed_volume(sphere.vertices, sphere.faces)
    vol_after = signed_volume(verts, faces)
    assert vol_after > 0
    assert abs(vol_after - vol_before) / vol_before < 0.01
    # the control: the same mesh with reversed winding has a negative signed volume
    assert signed_volume(verts, faces[:, ::-1]) < 0
    data = encode_brain_mesh(verts, faces)
    assert len(data) < 1_500_000


def test_small_mesh_is_not_decimated():
    sphere = icosphere(2)
    verts, faces = decimate(sphere.vertices, sphere.faces)
    np.testing.assert_array_equal(verts, sphere.vertices)
    np.testing.assert_array_equal(faces, sphere.faces)


def test_freesurfer_surface_needing_c_ras_lands_in_the_contacts_frame(built):
    entry = _entry(built["index"], "1")
    assert entry["frame_choice"] == "c_ras"
    np.testing.assert_allclose(entry["offset_applied"], built["cras"])
    assert entry["hemispheres"] == ["L", "R"]
    assert entry["fit"]["grade"] == "specific"
    meshes = [_decode(built, entry, h) for h in ("L", "R")]
    ecog = built["scanner"]
    median = fit(ecog, meshes, "ecog").median_mm
    assert median <= 2.0
    # the control: the unshifted surface (tkr RAS) is far from the scanner RAS contacts
    raw = [built["lh"], built["rh"]]
    unshifted = fit(ecog, raw, "ecog")
    assert unshifted.median_mm > 2.0 and not unshifted.passed
    # the written vertices are the file's vertices plus c_ras, within quantization
    expected = built["lh"].vertices + built["cras"]
    assert np.abs(meshes[0].vertices.min(axis=0) - expected.min(axis=0)).max() < 0.1
    assert np.abs(meshes[0].vertices.max(axis=0) - expected.max(axis=0)).max() < 0.1


def test_one_hemisphere_gifti_writes_only_that_hemisphere(built):
    entry = _entry(built["index"], "2")
    assert entry["hemispheres"] == ["R"]
    assert list(entry["meshes"]) == ["R"]
    folder = built["out"] / "geometry" / "sub-2" / "sub-2_electrodes"
    assert (folder / "rh.mesh.bin").exists()
    assert not (folder / "lh.mesh.bin").exists()
    assert entry["frame_choice"] == "as_declared"
    assert entry["offset_applied"] is None
    assert entry["fit"]["n_left_out"] == 2  # the two left contacts are not evaluated
    # the column-major file was read right: the written mesh keeps the right hemisphere's extent
    mesh = _decode(built, entry, "R")
    np.testing.assert_allclose(
        np.ptp(mesh.vertices, axis=0), np.ptp(built["right"].vertices, axis=0), atol=0.1
    )


def test_a_subject_whose_surface_does_not_fit_is_skipped_and_listed(built):
    assert all(e["subject"] != "3" for e in built["index"]["entries"])
    skipped = next(s for s in built["index"]["skipped"] if s["subject"] == "3")
    assert skipped["electrodes"] == "sub-3/ieeg/sub-3_electrodes.tsv"
    assert "no frame fits" in skipped["reason"]
    assert not (built["out"] / "geometry" / "sub-3").exists()
    assert any(line.startswith("sub-3:") and "skipped" in line for line in built["lines"])


def test_declared_frame_is_preferred_over_c_ras_when_both_surfaces_fit(built):
    entry = _entry(built["index"], "4")
    assert entry["frame_choice"] == "as_declared"
    assert entry["offset_applied"] is None
    assert entry["sources"] == [
        "sourcedata/sub-4/pial.L.surf.gii",
        "sourcedata/sub-4/pial.R.surf.gii",
    ]
    meshes = [_decode(built, entry, h) for h in ("L", "R")]
    assert fit(built["scanner"], meshes, "ecog").median_mm <= 2.0


def test_index_validates_and_meshes_match_their_checksums(built):
    index = json.loads((built["out"] / "geometry" / "index.json").read_text(encoding="utf-8"))
    assert index == built["index"]
    Draft202012Validator.check_schema(SCHEMA)
    Draft202012Validator(SCHEMA).validate(index)
    assert index["source_commit"] == "abc123"
    assert [e["subject"] for e in index["entries"]] == ["1", "2", "4"]
    for entry in index["entries"]:
        for hemi, mesh in entry["meshes"].items():
            data = (built["out"] / "geometry" / mesh["path"]).read_bytes()
            assert hashlib.sha256(data).hexdigest() == mesh["sha256"]
            assert len(data) == mesh["bytes"] <= 1_500_000
            assert read_brain_mesh(data).vertices.shape[0] == mesh["vertices"] <= 65_535
            assert hemi in entry["hemispheres"]


def test_schema_rejects_a_broken_index(built):
    bad = json.loads(json.dumps(built["index"]))
    bad["entries"][0]["meshes"]["L"]["sha256"] = "nope"
    assert list(Draft202012Validator(SCHEMA).iter_errors(bad))
    bad = json.loads(json.dumps(built["index"]))
    del bad["entries"][0]["offset_applied"]
    assert list(Draft202012Validator(SCHEMA).iter_errors(bad))


def test_rerun_is_byte_identical(built, tmp_path):
    build_geometry(built["root"], tmp_path, source_commit="abc123")
    first = built["out"] / "geometry"
    second = tmp_path / "geometry"
    files = sorted(p.relative_to(first) for p in first.rglob("*") if p.is_file())
    assert files == sorted(p.relative_to(second) for p in second.rglob("*") if p.is_file())
    assert any(f.name == "index.json" for f in files)
    for rel in files:
        assert (first / rel).read_bytes() == (second / rel).read_bytes(), rel


def test_decimation_that_breaks_the_fit_skips_the_subject(dataset, tmp_path):
    index, _ = build_geometry(dataset["root"], tmp_path, max_vertices=150)
    skipped = {s["subject"]: s["reason"] for s in index["skipped"]}
    assert "decimation broke the fit" in skipped["1"]
    assert not (tmp_path / "geometry" / "sub-1").exists()


def test_forced_decimation_still_fits_when_the_cap_is_generous(dataset, tmp_path):
    index, _ = build_geometry(dataset["root"], tmp_path, max_vertices=6000)
    entry = _entry(index, "1")
    assert all(m["vertices"] <= 6000 for m in entry["meshes"].values())
    assert entry["fit"]["median_mm"] <= 2.0


def test_depth_contacts_on_an_open_surface_are_skipped(mini, tmp_path):
    index, _ = build_geometry(mini, tmp_path)
    assert index["entries"] == []
    reasons = " ".join(s["reason"] for s in index["skipped"])
    assert "no frame fits" in reasons or "no subject surface" in reasons


def test_the_command_line_prints_one_decision_per_electrodes_file(dataset, tmp_path):
    proc = subprocess.run(
        [
            sys.executable,
            "-m",
            "ieeg_geometry.surfaces_out",
            str(dataset["root"]),
            "--out",
            str(tmp_path),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    lines = proc.stdout.splitlines()
    assert any("sub-1:" in ln and "written L+R, c_ras, ecog specific" in ln for ln in lines)
    assert any("sub-2:" in ln and "written R" in ln for ln in lines)
    assert any("sub-3:" in ln and "skipped" in ln for ln in lines)
    assert lines[-1] == "3 written, 1 skipped"


def test_vendored_reference_still_reads(tmp_path):
    # the reader the writer is tested against loads the vendored template meshes
    assert len(load_reference("MNI152NLin2009cAsym")) == 2
