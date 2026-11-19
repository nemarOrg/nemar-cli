import numpy as np
import pytest

from ieeg_geometry.surfaces import Surface, read_freesurfer
from ieeg_geometry.verify import fit, fit_with_offset, points_inside

from .conftest import icosphere


def test_points_inside_a_closed_mesh(sphere):
    pts = np.array([[0, 0, 0], [3, 2, -1], [9.0, 0, 0], [11.5, 0, 0], [0, -30, 0]])
    inside, ambiguous = points_inside(pts, [sphere])
    assert inside.tolist() == [True, True, True, False, False]
    assert ambiguous == 0


def test_ray_through_a_vertex_does_not_double_count():
    # a cube; the first ray direction leaves the point exactly through the corner (1, 1, 1)
    c = np.array([[x, y, z] for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)], dtype=float)
    quads = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    faces = []
    for a, b, d, e in quads:
        faces += [(a, b, d), (a, d, e)]
    cube = Surface(c, np.array(faces))
    assert cube.is_closed
    from ieeg_geometry.verify import _DIRECTIONS

    d0 = _DIRECTIONS[0]
    inside_pt = np.array([1.0, 1.0, 1.0]) - 0.3 * d0
    outside_pt = np.array([1.0, 1.0, 1.0]) + 0.3 * d0
    from ieeg_geometry.verify import _inside

    _, voters = _inside(np.array([inside_pt, outside_pt]), cube)
    assert voters.tolist() == [2, 3]  # inside: first direction is ambiguous and abstains
    flags, ambiguous = points_inside(np.array([inside_pt, outside_pt]), [cube])
    assert flags.tolist() == [True, False]
    assert ambiguous == 0


def test_ecog_rule_is_median_only(sphere):
    on = fit(sphere.vertices[::5], sphere, "ecog")
    assert on.median_mm == 0.0
    assert on.passed
    assert on.inside_fraction is None
    off = fit(sphere.vertices[::5] * 1.4, sphere, "ecog")  # 4 mm off the 10 mm sphere
    assert off.median_mm == pytest.approx(4.0, abs=0.3)
    assert not off.passed


def test_seeg_needs_distance_and_inside(sphere):
    rng = np.random.default_rng(0)
    deep = rng.normal(size=(40, 3))
    deep = deep / np.linalg.norm(deep, axis=1, keepdims=True) * 7.0  # 3 mm under the surface
    good = fit(deep, sphere, "seeg")
    assert good.passed and good.inside_fraction == 1.0 and good.inside_evaluated
    # close to the surface but outside it: distance passes, inside fails
    outside = deep / 7.0 * 12.0
    bad = fit(outside, sphere, "seeg")
    assert bad.median_mm < 6.0
    assert bad.inside_fraction == 0.0
    assert not bad.passed
    # inside but far from the surface (center of a big sphere): median fails
    big = icosphere(3, radius=30.0)
    assert not fit(np.zeros((5, 3)), big, "seeg").passed


def test_unknown_and_dbs_use_the_seeg_rule(sphere):
    outside = np.array([[12.0, 0, 0]] * 5)
    assert not fit(outside, sphere, "unknown").passed
    assert not fit(outside, sphere, "dbs").passed
    assert fit(outside, sphere, "ecog").median_mm == pytest.approx(2.0, abs=0.2)


def test_open_surface_cannot_evaluate_inside(sphere):
    open_surface = Surface(sphere.vertices, sphere.faces[: len(sphere.faces) // 2])
    result = fit(np.array([[0.0, 0, 8.0]]), open_surface, "seeg")
    assert result.inside_fraction is None and not result.inside_evaluated


def test_missing_rows_are_dropped_and_counted(sphere):
    pts = np.array([[0.0, 0, 9], [np.nan, 0, 1], [0, 0, 8]])
    result = fit(pts, sphere, "seeg")
    assert (result.n_used, result.n_total) == (2, 3)
    empty = fit(np.full((2, 3), np.nan), sphere, "seeg")
    assert not empty.passed and empty.n_used == 0


def test_both_hemispheres_are_one_tree():
    left = icosphere(2, center=(-30, 0, 0))
    right = icosphere(2, center=(30, 0, 0))
    pts = np.array([[-22.0, 0, 0], [38.0, 0, 0]])
    both = fit(pts, [left, right], "seeg")
    assert both.passed and both.inside_fraction == 1.0
    assert fit(pts, [left], "seeg").inside_fraction == 0.5


def test_offset_fit_picks_the_c_ras_frame(mini):
    lh = read_freesurfer(mini / "derivatives/freesurfer-7.3.2/sub-1/surf/lh.pial")
    rh = read_freesurfer(mini / "derivatives/freesurfer-7.3.2/sub-1/surf/rh.pial")
    from ieeg_geometry.bids import discover, read_electrode_set

    item = next(d for d in discover(mini) if d.subject == "1" and d.space == "ACPC")
    in_surface_frame = read_electrode_set(item).xyz_mm
    c_ras = np.array(lh.c_ras)
    # contacts as a dataset would declare them when its frame is the surface frame shifted by c_ras
    declared = in_surface_frame - c_ras
    result = fit_with_offset(declared, [lh, rh], "seeg", lh.c_ras)
    assert not result.as_declared.passed
    assert result.with_c_ras is not None and result.with_c_ras.passed
    assert result.preferred == "c_ras"
    assert result.with_c_ras.median_mm < result.as_declared.median_mm
    # the real on004473 sub-1 file needs no offset
    real = fit_with_offset(in_surface_frame, [lh, rh], "seeg", lh.c_ras)
    assert real.preferred == "as_declared"
    assert fit_with_offset(declared, [lh, rh], "seeg", None).preferred is None


def test_on004457_native_fits_its_surface_better_than_acpc(mini):
    from ieeg_geometry.bids import discover, read_electrode_set
    from ieeg_geometry.surfaces import read_gifti

    surface = read_gifti(mini / "derivatives/freesurfer/sub-2/pial.R.surf.gii")
    sets = {d.space: read_electrode_set(d) for d in discover(mini) if d.subject == "2"}
    native = fit(sets[None].xyz_mm, surface, "seeg")
    acpc = fit(sets["ACPC"].xyz_mm, surface, "seeg")
    assert native.median_mm == pytest.approx(2.68, abs=0.05)
    assert acpc.median_mm == pytest.approx(9.89, abs=0.05)  # the census value for the full surface
    assert native.passed and not acpc.passed
