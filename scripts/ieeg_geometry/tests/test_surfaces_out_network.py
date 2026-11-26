"""Real full pial surfaces through `build_geometry` (marked `network`, run by the manager).

Each test assembles a minimal BIDS tree in a temporary directory from the same cached public
(CC0) files `test_network.py` downloads, then checks the per-subject outcome and the written
mesh against the original surface (ruling 15).
"""

import shutil
from pathlib import Path

import pytest

from ieeg_geometry.meshwrite import edge_stats
from ieeg_geometry.reference import read_brain_mesh
from ieeg_geometry.surfaces import read_surface
from ieeg_geometry.surfaces_out import build_geometry

from .test_network import DATA, RAW, _fetch

pytestmark = pytest.mark.network


def _copy(src: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(src, dest)


def _run(root: Path, tmp_path: Path) -> tuple[dict, dict]:
    index, _ = build_geometry(root, tmp_path / "out", source_commit="network-test")
    return index, {s["electrodes"]: s["reason"] for s in index["skipped"]}


def _assert_decimation_preserved(entry: dict, tmp_path: Path) -> None:
    dec = entry["decimation"]
    assert dec["applied"] is True
    assert abs(dec["median_shift_mm"]) <= 0.5
    assert dec["p99_deviation_mm"] <= 1.0
    for mesh in entry["meshes"].values():
        assert mesh["vertices"] <= 65_535 and mesh["bytes"] <= 1_500_000
        assert mesh["boundary_edges"] == 0
        assert mesh["non_manifold_edges"] < 0.002 * (3 * mesh["faces"] / 2)
        data = (tmp_path / "out" / "geometry" / mesh["path"]).read_bytes()
        assert read_brain_mesh(data).faces.shape[0] == mesh["faces"]


def test_on004457_sub2_native_is_written_right_hemisphere_only(tmp_path):
    ieeg = "sub-2/ses-ieeg01/ieeg"
    stem = "sub-2_ses-ieeg01"
    root = tmp_path / "on004457"
    base = f"{RAW}/on004457/HEAD/{ieeg}"
    for suffix in ("_electrodes.tsv", "_coordsystem.json"):
        _copy(
            _fetch("on004457", f"{stem}{suffix}", f"{base}/{stem}{suffix}"),
            root / ieeg / f"{stem}{suffix}",
        )
    chan = f"{stem}_task-ccep_run-01_channels.tsv"
    _copy(_fetch("on004457", chan, f"{base}/{chan}"), root / ieeg / chan)
    gii = _fetch(
        "on004457",
        "pial.R.surf.gii",
        f"{DATA}/on004457/v1.0.0/derivatives/freesurfer/sub-2/pial.R.surf.gii",
    )
    _copy(gii, root / "derivatives/freesurfer/sub-2/pial.R.surf.gii")
    index, _ = _run(root, tmp_path)
    (entry,) = index["entries"]
    assert entry["hemispheres"] == ["R"] and entry["vertex_offset_mm"] is None
    assert entry["fit"]["grade"] == "plausible"
    assert entry["fit_before_decimation"]["median_mm"] == pytest.approx(2.7, abs=0.2)
    _assert_decimation_preserved(entry, tmp_path)


def test_on004473_sub1_acpc_is_written_with_both_hemispheres(tmp_path):
    ieeg = "sub-1/ieeg"
    stem = "sub-1_space-ACPC"
    root = tmp_path / "on004473"
    base = f"{RAW}/on004473/HEAD/{ieeg}"
    for suffix in ("_electrodes.tsv", "_coordsystem.json"):
        _copy(
            _fetch("on004473", f"{stem}{suffix}", f"{base}/{stem}{suffix}"),
            root / ieeg / f"{stem}{suffix}",
        )
    surf = f"{DATA}/on004473/v1.0.0/derivatives/freesurfer-7.3.2/sub-1/surf"
    for name in ("lh.pial", "rh.pial"):
        _copy(
            _fetch("on004473", name, f"{surf}/{name}"),
            root / "derivatives/freesurfer-7.3.2/sub-1/surf" / name,
        )
    index, _ = _run(root, tmp_path)
    (entry,) = index["entries"]
    assert entry["hemispheres"] == ["L", "R"]
    assert entry["frame_choice"] == "as_declared"
    assert entry["fit"]["grade"] == "plausible"
    assert entry["fit_before_decimation"]["median_mm"] == pytest.approx(3.1, abs=0.2)
    _assert_decimation_preserved(entry, tmp_path)


def test_on003848_resp0699_is_written_with_c_ras_and_specific(tmp_path):
    ieeg = "sub-RESP0699/ses-1/ieeg"
    stem = "sub-RESP0699_ses-1"
    root = tmp_path / "on003848"
    base = f"{RAW}/on003848/HEAD/{ieeg}"
    for suffix in ("_electrodes.tsv", "_coordsystem.json"):
        _copy(
            _fetch("on003848", f"{stem}{suffix}", f"{base}/{stem}{suffix}"),
            root / ieeg / f"{stem}{suffix}",
        )
    chan = f"{stem}_task-SPESclin_run-031717_channels.tsv"
    _copy(_fetch("on003848", chan, f"{base}/{chan}"), root / ieeg / chan)
    tree = "derivatives/freesurfer/sub-RESP0699/ses-1/sub-RESP0699_ses-1_T1w/surf"
    for name in ("lh.pial", "rh.pial"):
        _copy(_fetch("on003848", name, f"{DATA}/on003848/v1.0.0/{tree}/{name}"), root / tree / name)
    index, _ = _run(root, tmp_path)
    (entry,) = index["entries"]
    assert entry["frame_choice"] == "c_ras" and entry["vertex_offset_mm"] is not None
    assert entry["fit"]["grade"] == "specific" and entry["contact_type"] == "ecog"
    assert entry["fit"]["median_mm"] < 2.0
    _assert_decimation_preserved(entry, tmp_path)


def test_real_decimation_residual_manifold_counts(tmp_path):
    """The residual non-manifold edges of a real pial surface after quadric collapse."""
    from ieeg_geometry.meshwrite import decimate

    lh = read_surface(
        _fetch(
            "on003848",
            "lh.pial",
            f"{DATA}/on003848/v1.0.0/derivatives/freesurfer/sub-RESP0699/ses-1/sub-RESP0699_ses-1_T1w/surf/lh.pial",
        )
    )
    verts, faces = decimate(lh.vertices, lh.faces)
    boundary, non_manifold = edge_stats(faces)
    assert len(verts) <= 65_535 and boundary == 0
    assert non_manifold < 0.002 * (3 * len(faces) / 2)
