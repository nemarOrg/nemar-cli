import numpy as np
import pytest

from ieeg_geometry import load_reference
from ieeg_geometry.bids import discover, read_electrode_set
from ieeg_geometry.surfaces import Surface
from ieeg_geometry.verify import (
    _DIRECTIONS,
    Fit,
    OffsetFit,
    _inside,
    fit,
    fit_with_offset,
    points_inside,
)

from .conftest import icosphere


def _cube() -> Surface:
    c = np.array([[x, y, z] for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)], dtype=float)
    quads = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    faces = []
    for a, b, d, e in quads:
        faces += [(a, b, d), (a, d, e)]
    return Surface(c, np.array(faces))


def test_points_inside_a_closed_mesh(sphere):
    pts = np.array([[0, 0, 0], [3, 2, -1], [9.0, 0, 0], [11.5, 0, 0], [0, -30, 0]])
    result = points_inside(pts, [sphere])
    assert result is not None
    inside, ambiguous = result
    assert inside.tolist() == [True, True, True, False, False]
    assert ambiguous == 0


def test_ray_through_a_vertex_does_not_double_count():
    cube = _cube()
    assert cube.is_closed
    d0 = _DIRECTIONS[0]
    inside_pt = np.array([1.0, 1.0, 1.0]) - 0.3 * d0
    outside_pt = np.array([1.0, 1.0, 1.0]) + 0.3 * d0
    pts = np.array([inside_pt, outside_pt])
    _, voters = _inside(pts, cube)
    assert voters.tolist() == [2, 3]  # inside: the first direction is ambiguous and abstains
    result = points_inside(pts, [cube])
    assert result is not None
    assert result[0].tolist() == [True, False]
    assert result[1] == 0


def test_ecog_rule_is_median_only_and_specific(sphere):
    on = fit(sphere.vertices[::5], sphere, "ecog")
    assert on.median_mm == 0.0 and on.grade == "specific" and on.passed
    assert on.inside_fraction is None
    off = fit(sphere.vertices[::5] * 1.4, sphere, "ecog")  # 4 mm off the 10 mm sphere
    assert off.median_mm == pytest.approx(4.0, abs=0.3)
    assert off.grade == "fail" and not off.passed


def test_seeg_is_plausible_when_near_enough_and_mostly_inside(sphere):
    rng = np.random.default_rng(0)
    deep = rng.normal(size=(40, 3))
    deep = deep / np.linalg.norm(deep, axis=1, keepdims=True) * 7.0  # 3 mm under the surface
    good = fit(deep, sphere, "seeg")
    assert good.grade == "plausible" and good.inside_fraction == 1.0 and good.inside_evaluated
    # 2 mm outside the surface: not inside, but within 5 mm, so still plausible
    near = fit(deep / 7.0 * 12.0, sphere, "seeg")
    assert near.inside_fraction == 0.0 and near.near_or_inside_fraction == 1.0
    assert near.grade == "plausible"
    # 8 mm outside: neither inside nor within 5 mm
    far = fit(deep / 7.0 * 18.0, sphere, "seeg")
    assert far.near_or_inside_fraction == 0.0 and far.grade == "fail"
    # inside but far from the surface (center of a big sphere): median fails
    big = icosphere(3, radius=30.0)
    assert fit(np.zeros((5, 3)), big, "seeg").grade == "fail"


def test_ninety_percent_threshold(sphere):
    inside = np.zeros((9, 3)) + [0.0, 0.0, 7.0]
    outside = np.array([[0.0, 0.0, 30.0]])
    assert fit(np.vstack([inside, outside]), sphere, "seeg").grade == "plausible"  # 90 percent
    assert fit(np.vstack([inside[:8], outside, outside]), sphere, "seeg").grade == "fail"


def test_contacts_on_template_vertices_are_specific_with_a_shift_control():
    fs = load_reference("fsaverage")
    on = fit(fs[0].vertices[::700], fs, "unknown")
    assert on.grade == "specific" and on.median_mm == 0.0
    shifted = fit(fs[0].vertices[::700] + [10.0, 0, 0], fs, "unknown")
    assert shifted.grade != "specific"


def test_unknown_and_dbs_use_the_seeg_rule(sphere):
    far = np.array([[18.0, 0, 0]] * 5)
    assert not fit(far, sphere, "unknown").passed
    assert not fit(far, sphere, "dbs").passed
    assert fit(np.array([[12.0, 0, 0]] * 5), sphere, "ecog").median_mm == pytest.approx(
        2.0, abs=0.2
    )


def test_other_open_surfaces_fail_closed(sphere):
    open_surface = Surface(sphere.vertices, sphere.faces[: len(sphere.faces) // 2])
    result = fit(np.array([[0.0, 0, 8.0]]), open_surface, "seeg")
    assert result.reason == "inside-unevaluable" and not result.passed
    assert not result.inside_evaluated
    # ECoG does not need an inside test, so an open surface is fine
    assert fit(open_surface.vertices[:5], open_surface, "ecog").passed


def test_mni_shell_uses_the_implicit_cap():
    mni = load_reference("MNI152NLin2009cAsym")
    assert all(s.midline_cut for s in mni)
    pts = np.array([[-35, -20, 20], [35, -20, 20], [-2, -20, 10], [-100, 0, 0], [0.5, 0, 150.0]])
    result = points_inside(pts, mni)
    assert result is not None
    assert result[0].tolist() == [True, True, True, False, False]
    assert result[1] == 0
    deep = fit(pts[:3], mni, "seeg")
    assert deep.inside_evaluated and deep.inside_fraction == 1.0


def test_missing_and_infinite_rows_are_dropped_and_counted(sphere):
    pts = np.array([[0.0, 0, 9], [np.nan, 0, 1], [0, 0, 8], [np.inf, 0, 0]])
    result = fit(pts, sphere, "seeg")
    assert (result.n_used, result.n_total) == (2, 4)
    empty = fit(np.full((2, 3), np.nan), sphere, "seeg")
    assert not empty.passed and empty.n_used == 0


def test_both_hemispheres_are_one_tree():
    left = icosphere(2, center=(-30, 0, 0))
    right = icosphere(2, center=(30, 0, 0))
    pts = np.array([[-22.0, 0, 0], [38.0, 0, 0]])
    both = fit(pts, [left, right], "seeg")
    assert both.grade == "plausible" and both.inside_fraction == 1.0


def test_one_hemisphere_surface_evaluates_only_its_side():
    right = icosphere(2, center=(30, 0, 0))
    right.hemisphere = "R"
    pts = np.array([[38.0, 0, 0], [-22.0, 0, 0], [30.0, 0, 7.0]])
    result = fit(pts, right, "seeg")
    assert (result.n_used, result.n_total, result.n_left_out) == (2, 3, 1)
    assert result.grade == "plausible"
    # the hemisphere column overrides the sign of x
    flagged = fit(pts, right, "seeg", hemispheres=["R", "R", "L"])
    assert (flagged.n_used, flagged.n_left_out) == (2, 1)


def _declared_in_scanner_frame(sphere_center=(0, 0, 0)):
    surf = icosphere(3, radius=20.0, center=sphere_center)
    surf.c_ras = (4.0, -10.0, 16.0)
    tkr_contacts = surf.vertices[::9] * 0.8  # inside the sphere, about 4 mm from the surface
    # scanner RAS = tkr RAS + c_ras, so a dataset declaring scanner RAS has tkr + c_ras
    return surf, tkr_contacts + np.array(surf.c_ras)


def test_c_ras_is_subtracted_not_added():
    surf, declared = _declared_in_scanner_frame()
    result = fit_with_offset(declared, surf, "seeg", surf.c_ras)
    assert result.with_c_ras is not None
    assert result.with_c_ras.offset_applied == (-4.0, 10.0, -16.0)
    assert result.with_c_ras.grade == "plausible"
    assert result.with_c_ras.median_mm < 6.0 < result.as_declared.median_mm or (
        not result.as_declared.passed
    )
    assert result.preferred == "c_ras"
    # the wrong sign (adding c_ras) lands twice as far away and fails
    wrong = fit(declared + np.array(surf.c_ras), surf, "seeg")
    assert not wrong.passed


def _f(median: float, grade: str) -> Fit:
    return Fit(median, median, median, 10, 10, "rule", grade)


@pytest.mark.parametrize(
    ("declared", "offset", "c_ras", "expected"),
    [
        (_f(3.0, "plausible"), _f(1.0, "plausible"), (4, 4, 4), "as_declared"),  # declared passes
        (_f(12.0, "fail"), _f(3.0, "plausible"), (4, 4, 4), "c_ras"),  # clear gain
        (
            _f(12.0, "fail"),
            _f(3.0, "plausible"),
            (1, 1, 1),
            None,
        ),  # offset under 3 mm cannot rescue a failed declared frame
        (_f(6.5, "fail"), _f(5.5, "plausible"), (4, 4, 4), "ambiguous"),  # gain under 1.5 mm
        (_f(7.5, "fail"), _f(5.9, "plausible"), (4, 4, 4), "ambiguous"),  # gain under 25 percent
        (_f(12.0, "fail"), _f(9.0, "fail"), (4, 4, 4), None),  # neither passes
    ],
)
def test_preferred_follows_ruling_four(declared, offset, c_ras, expected):
    assert OffsetFit(declared, offset, c_ras).preferred == expected
    assert OffsetFit(declared, None, None).preferred in {None, "as_declared"}


def test_native_electrodes_beat_acpc_on_the_cut_fixture(mini):
    from ieeg_geometry.surfaces import read_gifti

    surface = read_gifti(mini / "derivatives/freesurfer/sub-2/pial.R.surf.gii")
    sets = {d.space: read_electrode_set(d) for d in discover(mini) if d.subject == "2"}
    native = fit(sets[None].xyz_mm, surface, "ecog")
    acpc = fit(sets["ACPC"].xyz_mm, surface, "ecog")
    assert native.median_mm == pytest.approx(2.68, abs=0.1)
    assert acpc.median_mm == pytest.approx(9.89, abs=0.1)  # the census value on the full surface
    # the fixture surface is open, so depth contacts cannot be evaluated against it
    assert fit(sets[None].xyz_mm, surface, "seeg").reason == "inside-unevaluable"


def _offset_fit(declared, shifted, c_ras=(10.0, 0.0, 0.0), grades=("specific", "specific")):
    from ieeg_geometry.verify import Fit, OffsetFit

    def mk(median, grade):
        return Fit(median, median, median, 10, 10, "r", grade)

    return OffsetFit(mk(declared, grades[0]), mk(shifted, grades[1]), c_ras)


@pytest.mark.parametrize(
    ("declared", "shifted", "c_ras", "expected"),
    [
        (1.82, 1.11, (10.0, 0.0, 0.0), "c_ras"),  # on004194 sub-p01: 0.71 mm and 39 percent lower
        (1.11, 1.82, (10.0, 0.0, 0.0), "as_declared"),
        (1.82, 1.50, (10.0, 0.0, 0.0), "ambiguous"),  # under 0.5 mm and 25 percent
        (1.0, 0.6, (10.0, 0.0, 0.0), "ambiguous"),  # 40 percent but only 0.4 mm
        (1.82, 1.11, (2.0, 0.0, 0.0), "as_declared"),  # offset under 3 mm: immaterial
    ],
)
def test_two_specific_frames_ruling_13(declared, shifted, c_ras, expected):
    assert _offset_fit(declared, shifted, c_ras).preferred == expected


def test_failed_declared_frame_with_tiny_offset_is_not_a_pass():
    fit_ = _offset_fit(3.0, 1.0, (2.0, 0.0, 0.0), grades=("fail", "specific"))
    assert fit_.preferred is None
    assert _offset_fit(3.0, 1.0, (10.0, 0.0, 0.0), grades=("fail", "specific")).preferred == "c_ras"


def test_depth_inside_rule(sphere):
    from ieeg_geometry.verify import fit_depth_inside

    inside = np.array([[0.0, 0, 0]] * 20 + [[3.0, 0, 0]] * 20)
    assert fit_depth_inside(inside, sphere).grade == "plausible"
    mostly_out = np.vstack([inside, [[14.0, 0, 0]] * 5])  # 5 of 45 outside, 4 mm away
    assert fit_depth_inside(mostly_out, sphere).passed is False  # 89 percent inside
    far = np.vstack([inside] * 3 + [[[25.0, 0, 0]]])  # one contact 15 mm outside
    assert fit_depth_inside(far, sphere).passed is False
    assert fit_depth_inside(far, sphere).max_mm > 10.0
