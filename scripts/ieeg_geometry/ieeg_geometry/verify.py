"""Measure how well contacts fit a reference surface, under the plan's thresholds.

Rules (settled in the plan, step L1):
- Surface-projected electrocorticography (ECoG): median nearest-vertex distance at most 2.0 mm.
- Stereo-electroencephalography (sEEG), deep brain stimulation (DBS) and unknown contacts:
  median at most 6.0 mm and at least 95 percent of contacts inside the closed pial surfaces.
  When no supplied surface is closed (a template tissue shell cut at the midline, a patch),
  the inside criterion cannot be evaluated: `inside_fraction` is None, `inside_evaluated`
  is False, and `passed` rests on the median alone.

Point-in-mesh uses ray parity along three fixed, irrational directions. A hit whose
barycentric coordinates fall within 1e-7 of a triangle edge is ambiguous for that
direction and the direction does not vote; the contact is inside when most voting
directions find an odd number of crossings. A contact with no voting direction is
counted outside and reported in `n_ambiguous`.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import asdict, dataclass

import numpy as np
from scipy.spatial import KDTree  # the cKDTree implementation since scipy 1.6

from .surfaces import Surface

ECOG_MEDIAN_MM = 2.0
SEEG_MEDIAN_MM = 6.0
SEEG_INSIDE_FRACTION = 0.95
_EDGE_EPS = 1e-7
_DIRECTIONS = np.array(
    [[0.5773, 0.3123, 0.7541], [-0.2719, 0.8341, -0.4823], [0.1693, -0.4417, 0.8812]]
)
_DIRECTIONS = _DIRECTIONS / np.linalg.norm(_DIRECTIONS, axis=1, keepdims=True)


@dataclass(frozen=True)
class Fit:
    median_mm: float
    p90_mm: float
    max_mm: float
    n_used: int
    n_total: int
    rule: str
    passed: bool
    inside_fraction: float | None = None
    inside_evaluated: bool = False
    n_ambiguous: int = 0

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class OffsetFit:
    """The fit as declared and with the surface's c_ras added to the contacts."""

    as_declared: Fit
    with_c_ras: Fit | None
    c_ras: tuple[float, float, float] | None

    @property
    def preferred(self) -> str | None:
        """`"as_declared"`, `"c_ras"`, or None when neither passes (lower median wins a tie)."""
        a = self.as_declared
        b = self.with_c_ras
        if b is None or (a.passed and not b.passed):
            return "as_declared" if a.passed else None
        if b.passed and not a.passed:
            return "c_ras"
        if not a.passed:
            return None
        return "as_declared" if a.median_mm <= b.median_mm else "c_ras"


def _as_list(surface: Surface | Sequence[Surface]) -> list[Surface]:
    return [surface] if isinstance(surface, Surface) else list(surface)


def _inside(points: np.ndarray, surface: Surface) -> tuple[np.ndarray, np.ndarray]:
    """Per point: votes of odd-crossing directions and count of voting directions."""
    tri = surface.vertices[surface.faces]
    v0, e1, e2 = tri[:, 0], tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]
    odd = np.zeros(len(points), dtype=int)
    voters = np.zeros(len(points), dtype=int)
    for d in _DIRECTIONS:
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
        for i, p in enumerate(points):
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
    return odd, voters


def points_inside(points: np.ndarray, surfaces: Sequence[Surface]) -> tuple[np.ndarray, int]:
    """Boolean inside flags for points against the closed surfaces, and the ambiguous count."""
    inside = np.zeros(len(points), dtype=bool)
    ambiguous = np.ones(len(points), dtype=bool)
    for surface in surfaces:
        if not surface.is_closed:
            continue
        odd, voters = _inside(points, surface)
        voted = voters > 0
        ambiguous &= ~voted
        inside |= voted & (odd * 2 > voters)
    return inside, int(ambiguous.sum())


def fit(contacts_mm: np.ndarray, surface: Surface | Sequence[Surface], contact_type: str) -> Fit:
    """Nearest-vertex fit of contacts (N x 3, millimeters) to one or both hemispheres."""
    surfaces = _as_list(surface)
    pts_all = np.asarray(contacts_mm, dtype=float).reshape(-1, 3)
    pts = pts_all[~np.isnan(pts_all).any(axis=1)]
    seeg_rule = contact_type != "ecog"
    rule = (
        f"median <= {SEEG_MEDIAN_MM} mm and >= {SEEG_INSIDE_FRACTION:.0%} inside"
        if seeg_rule
        else f"median <= {ECOG_MEDIAN_MM} mm"
    )
    if not len(pts) or not surfaces:
        return Fit(math.nan, math.nan, math.nan, len(pts), len(pts_all), rule, False)
    tree = KDTree(np.vstack([s.vertices for s in surfaces]))
    dist, _ = tree.query(pts)
    median = float(np.median(dist))
    inside_fraction: float | None = None
    evaluated = False
    n_amb = 0
    if seeg_rule and any(s.is_closed for s in surfaces):
        flags, n_amb = points_inside(pts, surfaces)
        inside_fraction = float(flags.mean())
        evaluated = True
    if seeg_rule:
        passed = median <= SEEG_MEDIAN_MM and (
            not evaluated or (inside_fraction or 0.0) >= SEEG_INSIDE_FRACTION
        )
    else:
        passed = median <= ECOG_MEDIAN_MM
    return Fit(
        median_mm=median,
        p90_mm=float(np.percentile(dist, 90)),
        max_mm=float(dist.max()),
        n_used=len(pts),
        n_total=len(pts_all),
        rule=rule,
        passed=bool(passed),
        inside_fraction=inside_fraction,
        inside_evaluated=evaluated,
        n_ambiguous=n_amb,
    )


def fit_with_offset(
    contacts_mm: np.ndarray,
    surface: Surface | Sequence[Surface],
    contact_type: str,
    c_ras: Sequence[float] | None,
) -> OffsetFit:
    """Fit as declared and with `c_ras` added to the contacts (FreeSurfer tkr to scanner RAS)."""
    pts = np.asarray(contacts_mm, dtype=float).reshape(-1, 3)
    declared = fit(pts, surface, contact_type)
    if c_ras is None:
        return OffsetFit(declared, None, None)
    offset = (float(c_ras[0]), float(c_ras[1]), float(c_ras[2]))
    return OffsetFit(declared, fit(pts + np.asarray(offset), surface, contact_type), offset)
