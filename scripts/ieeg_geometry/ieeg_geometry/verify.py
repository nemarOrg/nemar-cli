"""Measure how well contacts fit a reference surface, and grade the evidence.

Grades (lead rulings of 2026-11-19, plan.md):
- `specific`: surface-projected electrocorticography (ECoG) contacts with a median
  nearest-vertex distance of at most 2.0 mm, or other contacts sitting on template vertices
  (median at most 1.0 mm) where the same contacts shifted 10 mm in x fail that bound.
- `plausible`: stereo-electroencephalography (sEEG), deep brain stimulation (DBS) and unknown
  contacts with a median of at most 6.0 mm and at least 90 percent of contacts inside the
  reference surface or within 5.0 mm of it. Depth contacts in the right frame measure only
  82 to 89 percent strictly inside, so this is a plausibility check, not a frame proof.
  The caller can pass `depth_rule=INSIDE_RULE` (ruling 8, for a template shell without sulci):
  at least 95 percent inside and no contact more than 10.0 mm outside (nearest-vertex
  distance, an upper bound); the median is then reported, not judged. The rule is chosen by
  the caller, never by the reference, so adding a reference changes no other caller's verdict.
- `fail`: neither.

Inside test: ray parity along three fixed, irrational directions. A hit within 1e-7 of a
triangle edge is ambiguous for that direction and the direction does not vote; the contact
is inside when most voting directions find an odd number of crossings. A contact with no
voting direction counts as outside and is reported in `n_ambiguous`.
- A closed surface (every edge shared by two faces) uses plain parity.
- A template shell made of two halves cut exactly at x = 0 (`Surface.midline_cut`, the MNI
  shell) uses the implicit cap: each point is tested against the half on its side of x = 0
  with rays pointing away from the midline, so no ray crosses the missing cap. It is not
  gated on `is_closed` because some of its edges are non-manifold.
- Any other open surface cannot be evaluated: sEEG-type contacts fail closed with the reason
  `inside-unevaluable`.
A surface set holding one hemisphere evaluates only the contacts on that side (the
`hemispheres` argument, else the sign of x in the surface's frame) and reports the number
left out in `n_left_out`.

FreeSurfer surfaces are in tkr (surface) RAS and scanner RAS = tkr RAS + c_ras, so contacts
declared in scanner RAS are brought into the surface's frame by subtracting c_ras
(`fit_with_offset`). Checked on on003848 sub-RESP0699: 33.3 mm as declared, 1.37 mm with
c_ras subtracted, 72.3 mm with it added.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from typing import Any

import numpy as np
from scipy.spatial import KDTree  # the cKDTree implementation since scipy 1.6

from .surfaces import Surface

ECOG_MEDIAN_MM = 2.0
SEEG_MEDIAN_MM = 6.0
SEEG_NEAR_MM = 5.0
SEEG_PLAUSIBLE_FRACTION = 0.90
TEMPLATE_VERTEX_MM = 1.0
SHIFT_CONTROL_MM = 10.0
INSIDE_MIN_FRACTION = 0.95
INSIDE_MAX_OUTSIDE_MM = 10.0
MEDIAN_RULE = "median"
INSIDE_RULE = "inside"
OFFSET_MIN_GAIN_MM = 1.5
OFFSET_MIN_GAIN_FRACTION = 0.25
OFFSET_IMMATERIAL_MM = 3.0
SPECIFIC_MIN_GAIN_MM = 0.5
_EDGE_EPS = 1e-7
_DIRECTIONS = np.array(
    [[0.5773, 0.3123, 0.7541], [-0.2719, 0.8341, -0.4823], [0.1693, -0.4417, 0.8812]]
)
_DIRECTIONS = _DIRECTIONS / np.linalg.norm(_DIRECTIONS, axis=1, keepdims=True)

SPECIFIC = "specific"
PLAUSIBLE = "plausible"
FAIL = "fail"


@dataclass(frozen=True)
class Fit:
    median_mm: float
    p90_mm: float
    max_mm: float
    n_used: int
    n_total: int
    rule: str
    grade: str
    inside_fraction: float | None = None
    near_or_inside_fraction: float | None = None
    inside_evaluated: bool = False
    n_ambiguous: int = 0
    n_left_out: int = 0
    reason: str | None = None
    offset_applied: tuple[float, float, float] | None = None
    max_outside_mm: float | None = None

    @property
    def passed(self) -> bool:
        return self.grade != FAIL

    def as_dict(self) -> dict:
        """The frozen v1 field set (geometry-index schema); `max_outside_mm` is left out of it."""
        out = asdict(self) | {"passed": self.passed}
        out.pop("max_outside_mm")
        return out


@dataclass(frozen=True)
class OffsetFit:
    """The fit as declared and with the surface's c_ras subtracted from the contacts."""

    as_declared: Fit
    with_c_ras: Fit | None
    c_ras: tuple[float, float, float] | None

    @property
    def preferred(self) -> str | None:
        """The frame to use, by lead ruling 4.

        Two specific frames with an offset of at least 3 mm (ruling 13): the one whose median
        is at least 0.5 mm and 25 percent lower, else `"ambiguous"`. Otherwise `"as_declared"`
        when the declared frame passes; `"c_ras"` when the declared frame fails and the offset
        frame passes with a median at least 1.5 mm and 25 percent lower; `"ambiguous"` when the
        offset passes but by less than that; None when neither frame passes, including a
        failed declared frame with an offset under 3 mm (too small to rescue it).
        """
        a, b = self.as_declared, self.with_c_ras
        if (
            a.grade == SPECIFIC
            and b is not None
            and b.grade == SPECIFIC
            and self.c_ras is not None
            and float(np.linalg.norm(self.c_ras)) >= OFFSET_IMMATERIAL_MM
        ):  # ruling 13: two specific frames and a material offset
            if _clearly_lower(b.median_mm, a.median_mm, SPECIFIC_MIN_GAIN_MM):
                return "c_ras"
            if _clearly_lower(a.median_mm, b.median_mm, SPECIFIC_MIN_GAIN_MM):
                return "as_declared"
            return "ambiguous"
        if a.passed:
            return "as_declared"
        if b is None or not b.passed:
            return None
        if self.c_ras is not None and float(np.linalg.norm(self.c_ras)) < OFFSET_IMMATERIAL_MM:
            return None  # the declared frame failed and an offset under 3 mm cannot rescue it
        gain = a.median_mm - b.median_mm
        if gain >= OFFSET_MIN_GAIN_MM and gain >= OFFSET_MIN_GAIN_FRACTION * a.median_mm:
            return "c_ras"
        return "ambiguous"


def _clearly_lower(low: float, high: float, min_gain_mm: float) -> bool:
    gain = high - low
    return gain >= min_gain_mm and gain >= OFFSET_MIN_GAIN_FRACTION * high


def _as_list(surface: Surface | Sequence[Surface]) -> list[Surface]:
    return [surface] if isinstance(surface, Surface) else list(surface)


def _inside(
    points: np.ndarray, surface: Surface, away_from_midline: bool = False
) -> tuple[np.ndarray, np.ndarray]:
    """Per point: count of odd-crossing directions and count of voting directions.

    With `away_from_midline`, each direction is flipped to point away from x = 0 on the side
    of the point (the implicit cap), so the plane is never crossed.
    """
    tri = surface.vertices[surface.faces]
    v0, e1, e2 = tri[:, 0], tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]
    odd = np.zeros(len(points), dtype=int)
    voters = np.zeros(len(points), dtype=int)
    for d0 in _DIRECTIONS:
        for sign in (-1.0, 1.0) if away_from_midline else (None,):
            if sign is None:
                d, sel = d0, np.ones(len(points), dtype=bool)
            else:
                # points left of the midline (x < 0) need d.x < 0; the others need d.x > 0
                sel = (points[:, 0] < 0) == (sign < 0)
                d = d0 if np.sign(d0[0]) == sign else -d0
            if not sel.any():
                continue
            _accumulate(points, sel, d, tri, v0, e1, e2, odd, voters)
    return odd, voters


def _accumulate(points, sel, d, tri, v0, e1, e2, odd, voters) -> None:
    helper = np.array([1.0, 0.0, 0.0]) if abs(d[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
    ea = np.cross(d, helper)
    ea /= np.linalg.norm(ea)
    eb = np.cross(d, ea)
    proj = np.stack([tri @ ea, tri @ eb], axis=-1)  # faces x 3 x 2
    lo, hi = proj.min(axis=1), proj.max(axis=1)
    h = np.cross(d, e2)
    det = np.einsum("ij,ij->i", e1, h)
    ok = np.abs(det) > 1e-12
    inv = np.where(ok, 1.0 / np.where(ok, det, 1.0), 0.0)
    for i in np.flatnonzero(sel):
        p = points[i]
        q2 = np.array([p @ ea, p @ eb])
        cand = np.flatnonzero(
            (lo[:, 0] <= q2[0])
            & (hi[:, 0] >= q2[0])
            & (lo[:, 1] <= q2[1])
            & (hi[:, 1] >= q2[1])
            & ok
        )
        if not len(cand):
            voters[i] += 1
            continue
        s = p - v0[cand]
        u = inv[cand] * np.einsum("ij,ij->i", s, h[cand])
        qv = np.cross(s, e1[cand])
        v = inv[cand] * (qv @ d)
        t = inv[cand] * np.einsum("ij,ij->i", e2[cand], qv)
        w = 1.0 - u - v
        hit = (u >= -_EDGE_EPS) & (v >= -_EDGE_EPS) & (w >= -_EDGE_EPS) & (t > 0)
        near_edge = hit & ((u < _EDGE_EPS) | (v < _EDGE_EPS) | (w < _EDGE_EPS))
        if near_edge.any():
            continue  # ambiguous: this direction does not vote
        voters[i] += 1
        odd[i] += int(hit.sum() % 2 == 1)


def points_inside(points: np.ndarray, surfaces: Sequence[Surface]) -> tuple[np.ndarray, int] | None:
    """Inside flags and the ambiguous count, or None when a surface cannot be evaluated.

    Closed surfaces use plain parity; `midline_cut` shells use the implicit cap (only the
    points on the surface's side of x = 0 are tested against it).
    """
    inside = np.zeros(len(points), dtype=bool)
    voted_any = np.zeros(len(points), dtype=bool)
    for surface in surfaces:
        if surface.midline_cut and surface.hemisphere in ("L", "R"):
            side = points[:, 0] < 0 if surface.hemisphere == "L" else points[:, 0] >= 0
            if not side.any():
                continue
            odd, voters = _inside(points[side], surface, away_from_midline=True)
            idx = np.flatnonzero(side)
        elif surface.is_closed:
            odd, voters = _inside(points, surface)
            idx = np.arange(len(points))
        else:
            return None
        voted = voters > 0
        voted_any[idx] |= voted
        inside[idx] |= voted & (odd * 2 > voters)
    return inside, int((~voted_any).sum())


def _side_filter(
    pts: np.ndarray, hemispheres: Sequence[str | None] | None, hemi: str
) -> np.ndarray:
    keep = np.zeros(len(pts), dtype=bool)
    for i, p in enumerate(pts):
        h = hemispheres[i] if hemispheres is not None else None
        side = h if h in ("L", "R") else ("L" if p[0] < 0 else "R")
        keep[i] = side == hemi
    return keep


def fit(
    contacts_mm: np.ndarray,
    surface: Surface | Sequence[Surface],
    contact_type: str,
    hemispheres: Sequence[str | None] | None = None,
    *,
    offset_applied: tuple[float, float, float] | None = None,
    depth_rule: str = MEDIAN_RULE,
) -> Fit:
    """Nearest-vertex fit of contacts (N x 3, millimeters) to one or both hemispheres.

    `depth_rule` applies to non-ECoG contacts: `MEDIAN_RULE` (default) or `INSIDE_RULE`.
    """
    if depth_rule not in (MEDIAN_RULE, INSIDE_RULE):
        raise ValueError(f"unknown depth rule {depth_rule!r}")
    surfaces = _as_list(surface)
    pts_all = np.asarray(contacts_mm, dtype=float).reshape(-1, 3)
    n_total = len(pts_all)
    finite = np.isfinite(pts_all).all(axis=1)
    hemis = (
        None if hemispheres is None else [h for h, f in zip(hemispheres, finite, strict=True) if f]
    )
    pts = pts_all[finite]
    seeg_rule = contact_type != "ecog"
    if not seeg_rule:
        rule = f"median <= {ECOG_MEDIAN_MM} mm"
    elif depth_rule == INSIDE_RULE:
        rule = (
            f">= {INSIDE_MIN_FRACTION:.0%} inside and none more than "
            f"{INSIDE_MAX_OUTSIDE_MM} mm outside (median reported, not judged)"
        )
    else:
        rule = (
            f"median <= {SEEG_MEDIAN_MM} mm and >= {SEEG_PLAUSIBLE_FRACTION:.0%} inside "
            f"or within {SEEG_NEAR_MM} mm"
        )
    n_left_out = 0
    sides = {s.hemisphere for s in surfaces}
    only = next(iter(sides)) if len(sides) == 1 else None
    if only is not None and only in ("L", "R") and len(pts):
        keep = _side_filter(pts, hemis, only)
        n_left_out = int((~keep).sum())
        pts = pts[keep]
    base: dict[str, Any] = dict(
        n_total=n_total, rule=rule, n_left_out=n_left_out, offset_applied=offset_applied
    )
    if not len(pts) or not surfaces:
        return Fit(math.nan, math.nan, math.nan, len(pts), grade=FAIL, **base)
    tree = KDTree(np.vstack([s.vertices for s in surfaces]))
    dist, _ = tree.query(pts)
    median = float(np.median(dist))
    stats: dict[str, Any] = dict(
        median_mm=median,
        p90_mm=float(np.percentile(dist, 90)),
        max_mm=float(dist.max()),
        n_used=len(pts),
    )
    if not seeg_rule:
        return Fit(grade=SPECIFIC if median <= ECOG_MEDIAN_MM else FAIL, **stats, **base)
    if median <= TEMPLATE_VERTEX_MM:
        shifted, _ = tree.query(pts + np.array([SHIFT_CONTROL_MM, 0.0, 0.0]))
        if float(np.median(shifted)) > TEMPLATE_VERTEX_MM:
            return Fit(grade=SPECIFIC, **stats, **base)
    result = points_inside(pts, surfaces)
    if result is None:
        return Fit(grade=FAIL, reason="inside-unevaluable", **stats, **base)
    inside, n_amb = result
    near = inside | (dist <= SEEG_NEAR_MM)
    inside_fraction = float(inside.mean())
    near_fraction = float(near.mean())
    outside = ~inside
    farthest = float(dist[outside].max()) if outside.any() else 0.0
    if depth_rule == INSIDE_RULE:
        ok = inside_fraction >= INSIDE_MIN_FRACTION and farthest <= INSIDE_MAX_OUTSIDE_MM
    else:
        ok = median <= SEEG_MEDIAN_MM and near_fraction >= SEEG_PLAUSIBLE_FRACTION
    return Fit(
        grade=PLAUSIBLE if ok else FAIL,
        inside_fraction=inside_fraction,
        near_or_inside_fraction=near_fraction,
        inside_evaluated=True,
        max_outside_mm=farthest,
        n_ambiguous=n_amb,
        **stats,
        **base,
    )


def fit_with_offset(
    contacts_mm: np.ndarray,
    surface: Surface | Sequence[Surface],
    contact_type: str,
    c_ras: Sequence[float] | None,
    hemispheres: Sequence[str | None] | None = None,
) -> OffsetFit:
    """Fit as declared and with `c_ras` subtracted from the contacts.

    FreeSurfer surfaces are in tkr RAS and scanner RAS = tkr RAS + c_ras, so contacts
    declared in scanner RAS are `contacts - c_ras` in the surface's frame.
    """
    pts = np.asarray(contacts_mm, dtype=float).reshape(-1, 3)
    declared = fit(pts, surface, contact_type, hemispheres)
    if c_ras is None:
        return OffsetFit(declared, None, None)
    c = (float(c_ras[0]), float(c_ras[1]), float(c_ras[2]))
    shift = -np.asarray(c)
    shifted = fit(
        pts + shift,
        surface,
        contact_type,
        hemispheres,
        offset_applied=(float(shift[0]), float(shift[1]), float(shift[2])),
    )
    return OffsetFit(declared, shifted, c)
