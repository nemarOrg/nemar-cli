import shutil
import struct

import numpy as np
import pytest

from ieeg_geometry import reference
from ieeg_geometry._ico import coarsen_faces
from ieeg_geometry.bids import GeometryRefusal
from ieeg_geometry.reference import load_reference, read_brain_mesh
from ieeg_geometry.verify import fit

from .conftest import icosphere


def test_fsaverage6_is_two_closed_outward_hemispheres():
    left, right = load_reference("fsaverage")
    for surf, hemi in ((left, "L"), (right, "R")):
        assert surf.hemisphere == hemi
        assert len(surf.vertices) == 40962
        assert len(surf.faces) == 81920
        assert surf.is_closed
        v, f = surf.vertices, surf.faces
        assert np.einsum("ij,ij->i", v[f[:, 0]], np.cross(v[f[:, 1]], v[f[:, 2]])).sum() > 0
    assert left.vertices[:, 0].mean() < 0 < right.vertices[:, 0].mean()


def test_mni_surface_counts_match_the_website_provenance():
    left, right = load_reference("MNI152NLin2009cAsym")
    assert (len(left.vertices), len(left.faces)) == (14955, 29400)
    assert (len(right.vertices), len(right.faces)) == (14942, 29400)
    assert left.vertices[:, 0].max() <= 0.5 and right.vertices[:, 0].min() >= -0.5


def test_unknown_reference_is_refused():
    with pytest.raises(GeometryRefusal) as exc:
        load_reference("fsaverage5")
    assert exc.value.reason == "reference-unknown"


def test_corrupt_reference_is_refused(tmp_path, monkeypatch):
    shutil.copytree(reference.DATA_DIR, tmp_path / "data")
    victim = tmp_path / "data" / "fsaverage" / "lh.pial.npz"
    victim.write_bytes(victim.read_bytes()[:-5] + b"xxxxx")
    monkeypatch.setattr(reference, "DATA_DIR", tmp_path / "data")
    with pytest.raises(GeometryRefusal) as exc:
        load_reference("fsaverage")
    assert exc.value.reason == "reference-corrupt"


def test_contacts_on_fsaverage_vertices_pass_fsaverage_only():
    fs = load_reference("fsaverage")
    mni = load_reference("MNI152NLin2009cAsym")
    contacts = fs[0].vertices[::700]
    on = fit(contacts, fs, "ecog")
    assert on.median_mm == 0.0
    assert on.passed
    assert not fit(contacts, mni, "ecog").passed
    shifted = fit(contacts + np.array([20.0, 0.0, 0.0]), fs, "ecog")
    assert not shifted.passed
    assert shifted.median_mm > 2.0


def _brain_mesh(positions, indices, width=16):
    pos = np.asarray(positions, dtype=np.float32)
    lo, hi = pos.min(0), pos.max(0)
    offset = ((lo + hi) / 2).astype(np.float32)
    scale = ((hi - lo) / (2 * 32767)).astype(np.float32)
    q = np.round((pos - offset) / scale).astype("<i2")
    head = b"NMBM" + struct.pack("<HHII", 1, width, len(pos), indices.size)
    head += struct.pack("<3f", *scale) + struct.pack("<3f", *offset)
    idx = indices.astype("<u2" if width == 16 else "<u4")
    return head + q.tobytes() + idx.tobytes()


@pytest.mark.parametrize("width", [16, 32])
def test_brain_mesh_round_trip(sphere, width):
    blob = _brain_mesh(sphere.vertices, sphere.faces.ravel(), width)
    surf = read_brain_mesh(blob, hemisphere="L")
    np.testing.assert_allclose(surf.vertices, sphere.vertices, atol=0.001)
    np.testing.assert_array_equal(surf.faces, sphere.faces)


@pytest.mark.parametrize(
    ("mutate", "why"),
    [
        (lambda b: b"XXXX" + b[4:], "bad magic"),
        (lambda b: b[:-1], "file size"),
        (lambda b: b[:20], "shorter"),
        (lambda b: b[:4] + struct.pack("<H", 2) + b[6:], "version"),
    ],
)
def test_brain_mesh_is_strict(sphere, mutate, why):
    blob = _brain_mesh(sphere.vertices, sphere.faces.ravel())
    with pytest.raises(GeometryRefusal) as exc:
        read_brain_mesh(mutate(blob))
    assert why in exc.value.message


def test_coarsen_faces_recovers_the_lower_icosphere():
    fine, coarse = icosphere(3), icosphere(2)
    got = coarsen_faces(fine.faces, len(coarse.vertices))
    key = lambda faces: {tuple(sorted(f)) for f in faces.tolist()}  # noqa: E731
    assert key(got) == key(coarse.faces)
    # winding is preserved: same cyclic order as the true coarse faces
    cyc = lambda f: min(tuple(f[i:] + f[:i]) for i in range(3))  # noqa: E731
    assert {cyc(f) for f in got.tolist()} == {cyc(f) for f in coarse.faces.tolist()}
