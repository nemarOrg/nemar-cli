"""SPM deformation fields to IXI549Space: invert, pair, verify, write.

SPM12's normalization writes `y_<name>.nii`, a deformation field on the template's grid: every
template voxel holds the native-space millimeter position it maps to (template to native). A
native contact therefore needs the inverse, found per contact by a nearest-value lookup for a
starting voxel and Newton iterations on the trilinearly interpolated field (residual below
0.05 mm in at most 20 iterations). A contact that does not converge, or whose solution leaves
the grid, is refused. Output is in millimeters of the field's template grid, labeled
`IXI549Space` (SPM12's default template space in BIDS), which differs from
`MNI152NLin2009cAsym` by a few millimeters. Only a field on SPM12's template grid (121 x 145 x
121 voxels of 1.5 mm, or a crop of it) is written; any other grid is `needs-human` (ruling 23).

Field check (rulings 9 and 19): at least 2,000 sampled vertices of the subject's own pial
surface are inverted through the field and must land with a median of at most 6.0 mm and a
10th percentile of at most 2.0 mm from the template shell, their centroid within 10.0 mm of the
shell's, and each axis's 2nd-to-98th-percentile extent within 10 percent of the shell's, the
shell taken on the pial's hemisphere and cut to z of at least -40 mm (the cerebellum and
brainstem have no pial counterpart; ruling 25). This excludes a reversed or grossly wrong field
(errors of roughly 10 mm or more); it does not prove position beyond that (a 5 mm or 10 mm
shift in y passes, a 10 mm shift in z or an 8 mm shift in x fails). It does not prove which subject
or electrodes file the field belongs to: sub-1's field passes against sub-3's surface.

Pairing (ruling 21): a file is paired with a field when its coordsystem `IntendedFor` resolves
to an existing file that is the T1 the field was computed from (the field's name without
`y_`, same directory, a list is searched). A file whose `IntendedFor` resolves to a different
existing T1 is never paired. Otherwise (absent, or naming a file that does not exist) every
candidate is verified against the `MNI152NLin2009cAsym` shell with the inside rule (ruling 8)
and there must be a clear winner: it passes, and every other candidate's inside fraction is at
least 0.05 lower.

Only depth contacts (sEEG, DBS, unknown) are written: a file with cortical (ECoG) contacts is
refused with its own reason, because the surface method (FreeSurfer track) places those.

Verification: the inverted contacts are fit to the shell with `INSIDE_RULE` (at least 95
percent inside, none more than 10.0 mm outside; the median is reported, not judged, because a
sulcus-free shell is not a distance reference). A `fail` is refused and reported, never
written. A `plausible` grade is accepted because the field, checked on the subject's own
surface, is independent frame evidence (lead ruling 3).
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import os
from dataclasses import dataclass, field, replace
from functools import cached_property
from pathlib import Path

import nibabel as nib
import numpy as np
from scipy.spatial import KDTree

from .bids import ElectrodeSet, GeometryRefusal, discover, read_electrode_set
from .labels import pipeline_version
from .ownership import (
    OwnedPath,
    Ownership,
    Verification,
    blob_id,
    read_ownership,
    write_ownership,
)
from .reference import load_reference
from .surfaces import Surface, read_surface
from .verify import (
    FAIL,
    INSIDE_RULE,
    MEDIAN_RULE,
    Fit,
    fit,
)

LABEL = "IXI549Space"
REFERENCE = "MNI152NLin2009cAsym"
METHOD_URL = "https://docs.nemar.org/data/ieeg-geometry/"
METHOD = "spm-deformation-inversion"
RESIDUAL_TOL_MM = 0.05
MAX_ITERATIONS = 20
MIN_INVERTIBLE_FRACTION = 0.90
_MAX_STEP_VOXELS = 4.0
_GRID_EPS = 1e-6


@dataclass
class DeformationField:
    """An SPM `y_` field: `values[i, j, k]` is the native-space position (mm) of template voxel."""

    values: np.ndarray  # nx x ny x nz x 3, float64
    affine: np.ndarray  # template voxel index -> template millimeters
    path: Path

    @property
    def shape(self) -> tuple[int, int, int]:
        nx, ny, nz = self.values.shape[:3]
        return nx, ny, nz

    @cached_property
    def tree(self) -> KDTree:
        """Nearest-value index over the field, built once per field."""
        return KDTree(self.values.reshape(-1, 3))


def load_field(path: str | Path) -> DeformationField:
    """Read an SPM deformation field (`nx x ny x nz x 1 x 3` or `nx x ny x nz x 3`)."""
    path = Path(path)
    try:
        img = nib.Nifti1Image.from_filename(str(path))
    except Exception as exc:  # nibabel raises several types for unreadable files
        raise GeometryRefusal("field-unreadable", f"{path.name}: {exc}") from exc
    shape = tuple(img.shape)
    if len(shape) == 5 and shape[3] == 1 and shape[4] == 3:
        pass
    elif not (len(shape) == 4 and shape[3] == 3):
        raise GeometryRefusal(
            "field-shape", f"{path.name} has shape {shape}, not a 3-vector field on a 3D grid"
        )
    values = np.asarray(img.dataobj, dtype=np.float64).reshape(*shape[:3], 3)
    if not np.isfinite(values).all():
        raise GeometryRefusal("field-nonfinite", f"{path.name} holds NaN or infinite values")
    if min(shape[:3]) < 2:
        raise GeometryRefusal("field-shape", f"{path.name} has a grid dimension below 2")
    return DeformationField(values, np.asarray(img.affine, dtype=np.float64), path)


@dataclass(frozen=True)
class Inversion:
    """Per contact: the template position (mm), the residual (native mm) or a refusal reason."""

    template_mm: np.ndarray  # N x 3, NaN where refused
    residual_mm: np.ndarray  # N, NaN where refused
    reasons: tuple[str | None, ...]

    @property
    def ok(self) -> np.ndarray:
        return np.array([r is None for r in self.reasons], dtype=bool)

    @property
    def median_residual(self) -> float:
        r = self.residual_mm[self.ok]
        return float(np.median(r)) if len(r) else float("nan")

    @property
    def max_residual(self) -> float:
        r = self.residual_mm[self.ok]
        return float(r.max()) if len(r) else float("nan")


def _interp(values: np.ndarray, u: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Trilinear field value (N x 3) and Jacobian d value / d voxel (N x 3 x 3) at voxels `u`."""
    shape = np.array(values.shape[:3])
    base = np.clip(np.floor(u).astype(int), 0, shape - 2)
    f = u - base
    i, j, k = base[:, 0], base[:, 1], base[:, 2]
    c = {(a, b, d): values[i + a, j + b, k + d] for a in (0, 1) for b in (0, 1) for d in (0, 1)}
    fx, fy, fz = f[:, 0:1], f[:, 1:2], f[:, 2:3]

    def lerp(a, b, t):
        return a + (b - a) * t

    c00 = lerp(c[0, 0, 0], c[1, 0, 0], fx)
    c10 = lerp(c[0, 1, 0], c[1, 1, 0], fx)
    c01 = lerp(c[0, 0, 1], c[1, 0, 1], fx)
    c11 = lerp(c[0, 1, 1], c[1, 1, 1], fx)
    c0 = lerp(c00, c10, fy)
    c1 = lerp(c01, c11, fy)
    val = lerp(c0, c1, fz)
    dz = c1 - c0
    dy = lerp(c10 - c00, c11 - c01, fz)
    dx = lerp(
        lerp(c[1, 0, 0] - c[0, 0, 0], c[1, 1, 0] - c[0, 1, 0], fy),
        lerp(c[1, 0, 1] - c[0, 0, 1], c[1, 1, 1] - c[0, 1, 1], fy),
        fz,
    )
    jac = np.stack([dx, dy, dz], axis=-1)  # N x 3 (component) x 3 (voxel axis)
    return val, jac


def invert_points(
    field_: DeformationField,
    native_mm: np.ndarray,
    *,
    tolerance_mm: float = RESIDUAL_TOL_MM,
    max_iterations: int = MAX_ITERATIONS,
) -> Inversion:
    """Template positions whose field value equals each native contact.

    Contacts with a missing coordinate are refused as `missing-coordinates`.
    """
    pts = np.asarray(native_mm, dtype=float).reshape(-1, 3)
    n = len(pts)
    template = np.full((n, 3), np.nan)
    residual = np.full(n, np.nan)
    reasons: list[str | None] = ["unresolved"] * n
    finite = np.isfinite(pts).all(axis=1)
    for i in np.flatnonzero(~finite):
        reasons[i] = "missing-coordinates"
    active = np.flatnonzero(finite)
    if not len(active):
        return Inversion(template, residual, tuple(reasons))
    values = field_.values
    shape = np.array(values.shape[:3])
    _, flat = field_.tree.query(pts[active])
    u = np.stack(np.unravel_index(flat, tuple(shape)), axis=1).astype(float)
    target = pts[active]
    done = np.zeros(len(active), dtype=bool)
    dead = np.zeros(len(active), dtype=bool)
    why: dict[int, str] = {}
    for _ in range(max_iterations + 1):
        live = np.flatnonzero(~done & ~dead)
        if not len(live):
            break
        val, jac = _interp(values, u[live])
        res = val - target[live]
        norm = np.linalg.norm(res, axis=1)
        converged = norm < tolerance_mm
        for loc in live[converged]:
            done[loc] = True
        todo = ~converged
        if not todo.any():
            break
        step = np.zeros((len(live), 3))
        det = np.linalg.det(jac)
        singular = np.abs(det) < 1e-9
        for loc in live[todo & singular]:
            dead[loc] = True
            why[loc] = "field-singular"
        solve = todo & ~singular
        if solve.any():
            step[solve] = -np.linalg.solve(jac[solve], res[solve][..., None])[..., 0]
            length = np.linalg.norm(step, axis=1, keepdims=True)
            scale = np.where(
                length > _MAX_STEP_VOXELS, _MAX_STEP_VOXELS / np.maximum(length, 1e-300), 1.0
            )
            step = step * scale
        u[live] = u[live] + step
        out = ((u[live] < -_GRID_EPS) | (u[live] > shape - 1 + _GRID_EPS)).any(axis=1) & solve
        for loc in live[out]:
            dead[loc] = True
            why[loc] = "outside-grid"
    for loc, idx in enumerate(active):
        if done[loc]:
            val, _ = _interp(values, u[loc : loc + 1])
            reasons[idx] = None
            residual[idx] = float(np.linalg.norm(val[0] - target[loc]))
            template[idx] = (field_.affine @ np.append(u[loc], 1.0))[:3]
        else:
            reasons[idx] = why.get(loc, "no-convergence")
    return Inversion(template, residual, tuple(reasons))


# ---- the template grid (ruling 23) ---------------------------------------------------------

SPM12_SHAPE = (121, 145, 121)
SPM12_AFFINE = np.array(
    [[-1.5, 0.0, 0.0, 90.0], [0.0, 1.5, 0.0, -126.0], [0.0, 0.0, 1.5, -72.0], [0.0, 0.0, 0.0, 1.0]]
)


def on_spm12_grid(field_: DeformationField) -> bool:
    """True for a field on SPM12's template grid, or a crop of it.

    A crop is accepted when its voxels are SPM12's 1.5 mm voxels on the same lattice (same
    linear part, origin an integer number of voxels from the template's) and it lies inside the
    121 x 145 x 121 grid; this is ruling 23's intent (only SPM12's template space is labeled
    `IXI549Space`) and also admits the committed test crop.
    """
    if not np.allclose(field_.affine[:3, :3], SPM12_AFFINE[:3, :3], atol=1e-3):
        return False
    origin = np.linalg.solve(SPM12_AFFINE[:3, :3], field_.affine[:3, 3] - SPM12_AFFINE[:3, 3])
    if not np.allclose(origin, np.round(origin), atol=1e-3):
        return False
    start = np.round(origin).astype(int)
    stop = start + np.array(field_.shape)
    return bool((start >= 0).all() and (stop <= np.array(SPM12_SHAPE)).all())


# ---- field check (rulings 9 and 19) ---------------------------------------------------------

FIELD_CHECK_SAMPLES = 4000
FIELD_CHECK_MIN_INVERTED = 2000
FIELD_CHECK_MEDIAN_MM = 6.0
FIELD_CHECK_P10_MM = 2.0
FIELD_CHECK_CENTROID_MM = 10.0
FIELD_CHECK_SHELL_MIN_Z = -40.0  # ruling 25: cerebrum against cerebrum
FIELD_CHECK_EXTENT_FRACTION = 0.10


@dataclass(frozen=True)
class FieldCheck:
    """Pial vertices of the subject inverted through the field, measured against the shell."""

    n_sampled: int
    n_inverted: int
    median_mm: float
    p10_mm: float
    centroid_mm: float
    extent_deviation: float  # largest per-axis relative difference of the 2nd-98th extent
    passed: bool
    reason: str


def _failed_check(n: int, n_ok: int, reason: str) -> FieldCheck:
    nan = math.nan
    return FieldCheck(n, n_ok, nan, nan, nan, nan, False, reason)


def check_field(
    field_: DeformationField, pial: list[Surface], reference: list[Surface]
) -> FieldCheck:
    """Rulings 9 and 19: where the subject's own pial vertices land, and the shape they take.

    At least 2,000 sampled vertices invert; median at most 6.0 mm and 10th percentile at most
    2.0 mm from the shell; centroid within 10.0 mm and each axis's 2nd-to-98th-percentile
    extent within 10 percent of the shell's, the shell taken on the pial's hemisphere.
    """
    if not pial:
        return _failed_check(0, 0, "no subject pial surface to check")
    vertices = np.vstack([s.vertices for s in pial])
    n = min(len(vertices), FIELD_CHECK_SAMPLES)
    idx = np.random.default_rng(0).choice(len(vertices), n, replace=False)
    inv = invert_points(field_, vertices[idx])
    n_ok = int(inv.ok.sum())
    if n_ok < FIELD_CHECK_MIN_INVERTED or n_ok < 0.9 * n:
        return _failed_check(n, n_ok, f"only {n_ok} of {n} sampled vertices invert")
    mapped = inv.template_mm[inv.ok]
    hemis = {s.hemisphere for s in pial} - {None}
    if len(hemis) == 0:
        hemis = {"L" if float(np.median(mapped[:, 0])) < 0 else "R"}
    want = hemis
    shell = [s for s in reference if s.hemisphere in want] or list(reference)
    all_pts = np.vstack([s.vertices for s in shell])
    dist, _ = KDTree(all_pts).query(mapped)
    ref_pts = all_pts[all_pts[:, 2] >= FIELD_CHECK_SHELL_MIN_Z]  # no cerebellum or brainstem
    median, p10 = float(np.median(dist)), float(np.percentile(dist, 10))
    centroid = float(np.linalg.norm(mapped.mean(axis=0) - ref_pts.mean(axis=0)))
    ext = np.percentile(mapped, 98, axis=0) - np.percentile(mapped, 2, axis=0)
    ref_ext = np.percentile(ref_pts, 98, axis=0) - np.percentile(ref_pts, 2, axis=0)
    deviation = float(np.max(np.abs(ext / ref_ext - 1.0)))
    problems = []
    if median > FIELD_CHECK_MEDIAN_MM or p10 > FIELD_CHECK_P10_MM:
        problems.append(
            f"pial vertices land median {median:.2f} mm (limit {FIELD_CHECK_MEDIAN_MM}) and "
            f"10th percentile {p10:.2f} mm (limit {FIELD_CHECK_P10_MM}) from the shell"
        )
    if centroid > FIELD_CHECK_CENTROID_MM:
        problems.append(
            f"centroid is {centroid:.1f} mm from the shell's (limit {FIELD_CHECK_CENTROID_MM})"
        )
    if deviation > FIELD_CHECK_EXTENT_FRACTION:
        problems.append(
            f"an axis extent differs from the shell's by {deviation:.0%} "
            f"(limit {FIELD_CHECK_EXTENT_FRACTION:.0%})"
        )
    return FieldCheck(n, n_ok, median, p10, centroid, deviation, not problems, "; ".join(problems))


# ---- pairing (ruling 21) --------------------------------------------------------------------


def _groups(eset: ElectrodeSet) -> dict[str, list[int]]:
    """Contact indexes by evidence rule: surface-projected ECoG, and everything else (depth)."""
    out: dict[str, list[int]] = {}
    for i, c in enumerate(eset.contacts):
        if c.missing_coordinates:
            continue
        out.setdefault("ecog" if c.type == "ecog" else "seeg", []).append(i)
    return out


def fit_groups(
    eset: ElectrodeSet,
    xyz_mm: np.ndarray,
    surfaces: list[Surface],
    depth_rule: str = MEDIAN_RULE,
) -> dict[str, Fit]:
    """L1 `fit` per contact kind for the contacts at `xyz_mm` (N x 3, same order as `eset`)."""
    out: dict[str, Fit] = {}
    for kind, idx in _groups(eset).items():
        hemis = [eset.contacts[i].hemisphere for i in idx]
        out[kind] = fit(xyz_mm[idx], surfaces, kind, hemis, depth_rule=depth_rule)
    return out


def _headline(fits: dict[str, Fit]) -> Fit | None:
    """The fit of the kind holding the most contacts, for ranking and reports."""
    if not fits:
        return None
    return max(fits.values(), key=lambda f: f.n_total)


def _all_pass(fits: dict[str, Fit]) -> bool:
    return bool(fits) and all(f.grade != FAIL for f in fits.values())


def _inside_fraction(fits: dict[str, Fit] | None) -> float:
    """The smallest inside fraction over the contact kinds (ECoG kinds have none: counted 1)."""
    if not fits:
        return 0.0
    return min(f.inside_fraction if f.inside_fraction is not None else 1.0 for f in fits.values())


CORTICAL_MIXED = (
    "mixed contact types: the SPM path writes depth-only files; the cortical contacts "
    "belong to the FreeSurfer surface method"
)
CORTICAL_ONLY = (
    "cortical contacts only: the SPM path writes depth-only files; the cortical contacts "
    "belong to the FreeSurfer surface method"
)
INTENDED_MATCH = "match"
INTENDED_OTHER = "other"
INTENDED_UNKNOWN = "unknown"
MIN_WINNER_GAP = 0.05


def _t1_stem(name: str) -> str:
    for ext in (".nii.gz", ".nii"):
        name = name.removesuffix(ext)
    for tail in ("_deFaced", "_defaced"):
        name = name.removesuffix(tail)
    return name


def _inside_dataset(dataset: Path, path: Path) -> str | None:
    """`path` relative to the dataset after normalizing `..`, or None when it leaves the dataset."""
    rel = os.path.normpath(path.relative_to(dataset) if path.is_relative_to(dataset) else path)
    if os.path.isabs(rel) or rel == ".." or rel.startswith("../"):
        return None
    return Path(rel).as_posix()


def intended_for_status(
    intended_for: str | list[str] | None,
    field_path: Path,
    dataset: Path,
    subject_dir: Path | None = None,
) -> str:
    """How a coordsystem `IntendedFor` relates to the field's T1 (ruling 21).

    Each entry is read dataset-relative (BIDS, with or without a leading slash or `bids::`)
    and, when `subject_dir` is given, subject-relative (the legacy `ses-1/anat/x.nii` form).
    `match`: an entry has an existing reading and every existing reading is the T1 the field
    was computed from (the field's name without `y_`, in the field's directory when the entry
    gives a directory); a list is searched. `other`: entries name existing files and none is
    clean (a value naming a different existing T1 by either reading is never paired).
    `unknown`: absent, or no entry names an existing file.
    """
    if intended_for is None:
        return INTENDED_UNKNOWN
    entries = [intended_for] if isinstance(intended_for, str) else list(intended_for)
    want = _t1_stem(field_path.name).removeprefix("y_")
    field_dir = field_path.parent.relative_to(dataset).as_posix()
    anywhere = False
    for raw in entries:
        if not isinstance(raw, str) or not raw.strip():
            continue
        rel = raw.strip().removeprefix("bids::").lstrip("/")
        readings = [_inside_dataset(dataset, dataset / rel)]
        if subject_dir is not None:
            readings.append(_inside_dataset(dataset, subject_dir / rel))
        readings = [r for r in readings if r is not None]
        existing = [r for r in dict.fromkeys(readings) if os.path.lexists(dataset / r)]
        if not existing:
            continue
        anywhere = True
        clean = all(
            _t1_stem(Path(r).name) == want
            and (Path(r).parent.as_posix() in ("", ".") or Path(r).parent.as_posix() == field_dir)
            for r in existing
        )
        if clean:
            return INTENDED_MATCH
    return INTENDED_OTHER if anywhere else INTENDED_UNKNOWN


@dataclass
class Candidate:
    """One electrodes file tried against one field (`field_path` None: the file was unreadable)."""

    electrodes_path: Path
    field_path: Path | None
    space: str | None
    frame: str | None
    n_contacts: int
    n_invertible: int
    median_residual_mm: float
    max_residual_mm: float
    surface_fit: dict[str, Fit] | None  # reported only; the pairing evidence is below
    surface_name: str | None
    intended: str
    template_fit: dict[str, Fit] | None
    eligible: bool
    note: str

    @property
    def inside_fraction(self) -> float:
        return _inside_fraction(self.template_fit)

    @property
    def verified(self) -> bool:
        return self.template_fit is not None and _all_pass(self.template_fit)


def _refused_candidate(path: Path, space: str | None, note: str) -> Candidate:
    nan = math.nan
    return Candidate(
        path, None, space, None, 0, 0, nan, nan, None, None, INTENDED_UNKNOWN, None, False, note
    )


def _subject_surface_sets(dataset: Path, subject: str) -> list[list[Path]]:
    groups: dict[Path, list[Path]] = {}
    token = f"sub-{subject}"
    for p in sorted(dataset.rglob("*")):
        if not p.is_file() or token not in p.relative_to(dataset).parts:
            continue
        name = p.name.lower()
        if name in ("lh.pial", "rh.pial") or (name.endswith(".gii") and "pial" in name):
            groups.setdefault(p.parent, []).append(p)
    return list(groups.values())


def find_fields(dataset: Path, subject: str) -> list[Path]:
    """SPM `y_*.nii[.gz]` files under a path that has a `sub-<subject>` directory."""
    token = f"sub-{subject}"
    found = []
    for p in sorted(dataset.rglob("y_*.nii*")):
        if p.is_file() or p.is_symlink():
            if token in p.relative_to(dataset).parts and p.name.endswith((".nii", ".nii.gz")):
                found.append(p)
    return found


def _intended_for(eset: ElectrodeSet) -> str | list[str] | None:
    if eset.coordsystem_path is None:
        return None
    try:
        value = json.loads(eset.coordsystem_path.read_text(encoding="utf-8")).get("IntendedFor")
    except (OSError, ValueError):
        return None
    return value if isinstance(value, (str, list)) else None


@dataclass
class SurfaceSet:
    name: str
    paths: list[Path]
    surfaces: list[Surface]


def evaluate_candidate(
    eset: ElectrodeSet,
    field_: DeformationField,
    surface_sets: list[SurfaceSet],
    reference: list[Surface],
    dataset: Path,
    inversion: Inversion | None = None,
) -> Candidate:
    inv = inversion or invert_points(field_, eset.xyz_mm)
    present = [i for i, c in enumerate(eset.contacts) if not c.missing_coordinates]
    n_inv = int(inv.ok[present].sum()) if present else 0
    eligible = bool(present) and n_inv / len(present) >= MIN_INVERTIBLE_FRACTION
    notes = []
    cortical = [i for i in present if eset.contacts[i].type == "ecog"]
    if cortical:
        eligible = False
        notes.append(CORTICAL_MIXED if len(cortical) < len(present) else CORTICAL_ONLY)
    elif not eligible:
        notes.append(f"only {n_inv}/{len(present)} contacts invert inside the field's grid")
    surf = _best_surface_set(eset, surface_sets)
    surface_fit = fit_groups(eset, eset.xyz_mm, surf.surfaces) if surf else None
    template_fit = None
    if eligible:
        mapped = np.where(inv.ok[:, None], inv.template_mm, np.nan)
        template_fit = fit_groups(eset, mapped, reference, INSIDE_RULE)
    return Candidate(
        electrodes_path=eset.electrodes_path,
        field_path=field_.path,
        space=eset.space,
        frame=eset.frame,
        n_contacts=len(present),
        n_invertible=n_inv,
        median_residual_mm=inv.median_residual,
        max_residual_mm=inv.max_residual,
        surface_fit=surface_fit,
        surface_name=surf.name if surf else None,
        intended=intended_for_status(
            _intended_for(eset), field_.path, dataset, dataset / f"sub-{eset.subject}"
        ),
        template_fit=template_fit,
        eligible=eligible,
        note="; ".join(notes),
    )


def choose(candidates: list[Candidate]) -> tuple[Candidate | None, str, str]:
    """(paired candidate or None, basis, reason) by ruling 21.

    A file whose `IntendedFor` names a different existing T1 is never paired. A single `match`
    is paired on that basis; otherwise the candidates are compared by template verification
    and one must win clearly (passes, every other inside fraction at least 0.05 lower).
    """
    pool = [c for c in candidates if c.eligible and c.intended != INTENDED_OTHER]
    if not pool:
        return (
            None,
            "",
            "no electrodes file can be paired with the field: "
            + "; ".join(
                f"{c.electrodes_path.name}: "
                + (
                    "its IntendedFor names a different T1"
                    if c.intended == INTENDED_OTHER
                    else c.note
                )
                for c in candidates
            ),
        )
    matches = [c for c in pool if c.intended == INTENDED_MATCH]
    if len(matches) == 1:
        return matches[0], "IntendedFor names the field's T1", ""
    group = matches or pool
    ranked = sorted(group, key=lambda c: -c.inside_fraction)
    best = ranked[0]
    if not best.verified:
        return (
            None,
            "",
            (
                f"no candidate passes template verification (best {best.electrodes_path.name}, "
                f"inside {best.inside_fraction:.0%})"
            ),
        )
    runner = ranked[1] if len(ranked) > 1 else None
    if runner is not None and best.inside_fraction - runner.inside_fraction < MIN_WINNER_GAP:
        return (
            None,
            "",
            (
                f"pairing ambiguous: {best.electrodes_path.name} "
                f"(inside {best.inside_fraction:.1%}) "
                f"and {runner.electrodes_path.name} ({runner.inside_fraction:.1%}) do not differ "
                f"by {MIN_WINNER_GAP:.2f} and no IntendedFor singles one out"
            ),
        )
    basis = "template verification"
    if runner is not None:
        basis += (
            f" (inside {best.inside_fraction:.1%} against {runner.inside_fraction:.1%} "
            f"for {runner.electrodes_path.name})"
        )
    else:
        basis += " (the only candidate left)"
    return best, basis, ""


def _best_surface_set(eset: ElectrodeSet, sets: list[SurfaceSet]) -> SurfaceSet | None:
    """The subject surface set the contacts fit best (by headline median), or None."""
    best: tuple[float, SurfaceSet] | None = None
    for s in sets:
        head = _headline(fit_groups(eset, eset.xyz_mm, s.surfaces))
        if head is not None and (best is None or head.median_mm < best[0]):
            best = (head.median_mm, s)
    return best[1] if best else None


# ---- plan and write ------------------------------------------------------------------------


@dataclass
class SubjectPlan:
    subject: str
    session: str | None
    verdict: str  # "write" | "skip" | "refused" | "needs-human"
    reason: str = ""
    basis: str = ""
    candidates: list[Candidate] = field(default_factory=list)
    chosen: Candidate | None = None
    inversion: Inversion | None = None
    template_fit: dict[str, Fit] = field(default_factory=dict)
    field_check: FieldCheck | None = None
    # dataset-relative path -> file bytes
    files: dict[str, bytes] = field(default_factory=dict)
    owned: list[OwnedPath] = field(default_factory=list)
    kept: dict[str, str] = field(default_factory=dict)  # path -> why `write` left it alone


def _output_stem(electrodes_path: Path, subject: str, session: str | None) -> str:
    stem = f"sub-{subject}" + (f"_ses-{session}" if session else "")
    # keep entities such as acq-/run- of the source, drop its own space entity
    parts = [
        p
        for p in electrodes_path.name[: -len("_electrodes.tsv")].split("_")
        if not p.startswith(("space-", "sub-", "ses-"))
    ]
    return "_".join([stem, *parts, f"space-{LABEL}"])


def _fmt(v: float) -> str:
    return "n/a" if not np.isfinite(v) else f"{v:.3f}"


def _electrodes_bytes(source: Path, template_mm: np.ndarray, ok: np.ndarray) -> bytes:
    with source.open(newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh, delimiter="\t")
        header = list(reader.fieldnames or [])
        rows = list(reader)
    buf = io.StringIO(newline="")
    writer = csv.writer(buf, delimiter="\t", lineterminator="\n")
    writer.writerow(header)
    for i, row in enumerate(rows):
        for axis, col in enumerate(("x", "y", "z")):
            row[col] = _fmt(template_mm[i, axis]) if ok[i] else "n/a"
        writer.writerow([row.get(h, "n/a") for h in header])
    return buf.getvalue().encode("utf-8")


def _coordsystem_bytes(
    rel_source: str,
    rel_field: str,
    inv: Inversion,
    fits: dict[str, Fit],
    n_refused: int,
    check: FieldCheck,
    basis: str,
) -> bytes:
    head = _headline(fits)
    assert head is not None
    grades = ", ".join(f"{k} {f.grade}" for k, f in sorted(fits.items()))
    inside = "n/a" if head.inside_fraction is None else f"{head.inside_fraction:.1%}"
    farthest = "n/a" if head.max_outside_mm is None else f"{head.max_outside_mm:.1f} mm"
    refused = (
        f" {n_refused} contacts that could not be inverted are written as n/a." if n_refused else ""
    )
    description = (
        f"Computed by NEMAR (ieeg_geometry {pipeline_version()}). Source: {rel_source}, "
        f"mapped to the SPM template space by inverting the dataset's SPM deformation field "
        f"{rel_field} (inversion residual median {inv.median_residual:.3f} mm, maximum "
        f"{inv.max_residual:.3f} mm). The file was paired with the field by: {basis}. "
        f"Field check on the subject's own pial surface ({check.n_inverted} sampled vertices "
        f"inverted): median {check.median_mm:.2f} mm and 10th percentile "
        f"{check.p10_mm:.2f} mm from the {REFERENCE} shell, centroid {check.centroid_mm:.1f} mm "
        f"from the shell's, largest axis-extent difference {check.extent_deviation:.0%}. "
        f"Plausibility against the {REFERENCE} shell ({grades}): {inside} of the contacts inside "
        f"it, farthest outside {farthest}. This is a plausibility check, not an error estimate: "
        f"the shell has no sulci, so the median distance of depth contacts to it "
        f"({head.median_mm:.1f} mm) says nothing about accuracy. "
        f"SPM template spaces differ from {REFERENCE} by a few millimeters.{refused}"
    )
    doc = {
        "iEEGCoordinateSystem": LABEL,
        "iEEGCoordinateUnits": "mm",
        "iEEGCoordinateSystemDescription": (
            "SPM12 default template space (IXI549Space), reached through the dataset's own "
            "SPM deformation field."
        ),
        "iEEGCoordinateProcessingDescription": description,
        "iEEGCoordinateProcessingReference": METHOD_URL,
    }
    return (json.dumps(doc, indent=4, ensure_ascii=False) + "\n").encode("utf-8")


def _rel(path: Path, dataset: Path) -> str:
    return path.relative_to(dataset).as_posix()


def plan_dataset(dataset_dir: str | Path) -> list[SubjectPlan]:
    """Plan every subject that ships an SPM field. Reads only; nothing is written."""
    dataset = Path(dataset_dir)
    owned_paths = {e.path for e in (read_ownership(dataset) or Ownership("", [])).entries}
    reference = load_reference(REFERENCE)
    items = discover(dataset)
    plans: list[SubjectPlan] = []
    for subject in sorted({i.subject for i in items}):
        fields = find_fields(dataset, subject)
        if not fields:
            continue
        loaded: list[SurfaceSet] = []
        for group in _subject_surface_sets(dataset, subject):
            try:
                loaded.append(
                    SurfaceSet(
                        "+".join(sorted(p.name for p in group)),
                        group,
                        [read_surface(p) for p in group],
                    )
                )
            except GeometryRefusal:
                continue
        subject_items = [i for i in items if i.subject == subject]
        for session in sorted({i.session or "" for i in subject_items}):
            sess = session or None
            sub = [i for i in subject_items if (i.session or "") == session]
            existing = [i for i in sub if i.space == LABEL]
            if any(_rel(i.electrodes_path, dataset) not in owned_paths for i in existing):
                plans.append(
                    SubjectPlan(
                        subject, sess, "skip", "the authors already ship a space-IXI549Space file"
                    )
                )
                continue
            plans.append(_plan_session(dataset, subject, sess, sub, fields, loaded, reference))
    return plans


def _plan_session(dataset, subject, session, items, fields, loaded, reference) -> SubjectPlan:
    plan = SubjectPlan(subject, session, "refused")
    sets: list[ElectrodeSet] = []
    for item in items:
        if item.space == LABEL:
            continue
        try:
            sets.append(read_electrode_set(item))
        except GeometryRefusal as exc:
            plan.candidates.append(
                _refused_candidate(item.electrodes_path, item.space, f"refused {exc.reason}")
            )
    winners: list[tuple[Candidate, str, ElectrodeSet, Inversion, DeformationField]] = []
    verdicts: list[str] = []
    off_grid: list[str] = []
    for field_path in fields:
        try:
            field_ = load_field(field_path)
        except GeometryRefusal as exc:
            verdicts.append(f"{field_path.name}: {exc.reason}")
            continue
        if not on_spm12_grid(field_):
            off_grid.append(
                f"{field_path.name} is on a {field_.shape} grid, not SPM12's template grid "
                f"{SPM12_SHAPE} of 1.5 mm voxels"
            )
            continue
        cands: list[tuple[Candidate, ElectrodeSet, Inversion]] = []
        for eset in sets:
            inv = invert_points(field_, eset.xyz_mm)
            cand = evaluate_candidate(eset, field_, loaded, reference, dataset, inv)
            plan.candidates.append(cand)
            cands.append((cand, eset, inv))
        chosen, basis, why = choose([c for c, _, _ in cands])
        if chosen is None:
            verdicts.append(f"{field_path.name}: {why}")
            continue
        cand, eset, inv = next(t for t in cands if t[0] is chosen)
        winners.append((cand, basis, eset, inv, field_))
    if not winners:
        if off_grid and not verdicts:
            plan.verdict = "needs-human"
            plan.reason = "; ".join(off_grid)
        else:
            plan.reason = " | ".join(verdicts + off_grid) or "no readable electrodes file"
        return plan
    if len(winners) > 1:
        named = [w for w in winners if w[1].startswith("IntendedFor")]
        if len(named) != 1:
            plan.reason = "pairing ambiguous across fields: " + ", ".join(
                f"{w[4].path.name} with {w[0].electrodes_path.name}" for w in winners
            )
            return plan
        winners = named
    cand, basis, eset, inv, field_ = winners[0]
    plan.chosen, plan.inversion, plan.basis = cand, inv, basis
    surf = _best_surface_set(eset, loaded)
    plan.field_check = check = check_field(field_, surf.surfaces if surf else [], reference)
    if not check.passed:
        plan.reason = f"the field failed its check on the subject's own surface: {check.reason}"
        return plan
    fits = cand.template_fit or {}
    plan.template_fit = fits
    if not _all_pass(fits):
        detail = ", ".join(
            f"{k}: inside {f.inside_fraction if f.inside_fraction is not None else 0:.1%}, "
            f"farthest outside {f.max_outside_mm if f.max_outside_mm is not None else math.nan:.1f}"
            f" mm ({f.reason or f.rule})"
            for k, f in sorted(fits.items())
            if f.grade == FAIL
        )
        plan.reason = f"verification against {REFERENCE} failed ({detail})"
        return plan
    assert surf is not None
    rel_src = _rel(cand.electrodes_path, dataset)
    rel_field = _rel(field_.path, dataset)
    stem = _output_stem(cand.electrodes_path, subject, session)
    parent = cand.electrodes_path.parent
    tsv_rel = _rel(parent / f"{stem}_electrodes.tsv", dataset)
    json_rel = _rel(parent / f"{stem}_coordsystem.json", dataset)
    n_refused = int((~inv.ok).sum()) - sum(c.missing_coordinates for c in eset.contacts)
    plan.files = {
        tsv_rel: _electrodes_bytes(cand.electrodes_path, inv.template_mm, inv.ok),
        json_rel: _coordsystem_bytes(rel_src, rel_field, inv, fits, n_refused, check, basis),
    }
    head = _headline(fits)
    assert head is not None
    verification = replace(
        Verification.from_fit(head, REFERENCE),
        field_check_median_mm=round(check.median_mm, 3),
        field_check_p10_mm=round(check.p10_mm, 3),
    )
    inputs = [
        (rel_src, blob_id(cand.electrodes_path)),
        (rel_field, blob_id(field_.path)),
    ]
    if eset.coordsystem_path is not None:
        inputs.append((_rel(eset.coordsystem_path, dataset), blob_id(eset.coordsystem_path)))
    inputs += [(_rel(p, dataset), blob_id(p)) for p in surf.paths]
    plan.owned = [
        OwnedPath(
            tsv_rel, "electrodes", tuple(inputs), METHOD, verification, _sha(plan.files[tsv_rel])
        ),
        OwnedPath(
            json_rel, "coordsystem", tuple(inputs), METHOD, verification, _sha(plan.files[json_rel])
        ),
    ]
    plan.verdict = "write"
    return plan


def _owned_by(entry: OwnedPath, plan: SubjectPlan) -> bool:
    """A previously written output of this pipeline for the plan's subject and session."""
    if entry.method != METHOD:
        return False
    name = Path(entry.path).name
    prefix = f"sub-{plan.subject}" + (f"_ses-{plan.session}" if plan.session else "") + "_"
    return (
        name.startswith(prefix)
        and (plan.session is not None or not name.startswith(f"sub-{plan.subject}_ses-"))
        and f"_space-{LABEL}_" in name
        and Path(entry.path).parts[0] == f"sub-{plan.subject}"
    )


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _unit_key(path: str) -> str:
    """The electrodes file and its coordsystem file are one unit: they share this key."""
    for suffix in ("_electrodes.tsv", "_coordsystem.json"):
        if path.endswith(suffix):
            return path[: -len(suffix)]
    return path


def _untouched(dataset: Path, entry: OwnedPath) -> bool:
    target = dataset / entry.path
    return (
        not target.is_symlink()
        and entry.output_sha256 is not None
        and _sha(target.read_bytes()) == entry.output_sha256
    )


def _drop_stale(
    dataset: Path, entries: dict[str, OwnedPath], plan: SubjectPlan, keep: set[str]
) -> bool:
    """Remove this plan's previously owned outputs that are no longer wanted (in `keep`).

    A unit (electrodes file plus coordsystem file) goes only when every existing file of it is
    untouched since our write; if either was hand-edited both stay, with their entries.
    """
    units: dict[str, list[OwnedPath]] = {}
    for e in entries.values():
        if _owned_by(e, plan) and e.path not in keep:
            units.setdefault(_unit_key(e.path), []).append(e)
    changed = False
    for members in units.values():
        present = [e for e in members if os.path.lexists(dataset / e.path)]
        if all(_untouched(dataset, e) for e in present):
            for e in present:
                (dataset / e.path).unlink()
            for e in members:
                del entries[e.path]
            changed = True
        else:
            for e in present:
                plan.kept[e.path] = "hand-edited, kept"
    return changed


def write(plans: list[SubjectPlan], dataset_dir: str | Path) -> list[str]:
    """Write the files of every `write` plan and merge them into `.nemar/ieeg-geometry.json`.

    Other owners' entries are kept. A pipeline-owned file is regenerated only while its bytes
    still match the recorded `output_sha256`. The electrodes file and its coordsystem file are
    one unit: if either is hand-edited, owned by the authors, or a symbolic link, both are kept
    as they are and listed in `plan.kept` (as C1 and B1 do). Outputs of a different earlier
    pairing, and the outputs of a subject that is now refused or needs a human, are removed
    when untouched. Reruns on unchanged inputs produce byte-identical files. The record carries
    the current pipeline version.
    """
    dataset = Path(dataset_dir)
    existing = read_ownership(dataset)
    entries = {e.path: e for e in (existing.entries if existing else [])}
    written: list[str] = []
    changed = False
    for plan in plans:
        plan.kept = {}
        if plan.verdict in ("refused", "needs-human"):
            changed |= _drop_stale(dataset, entries, plan, set())
        elif plan.verdict == "write":
            changed |= _drop_stale(dataset, entries, plan, set(plan.files))
            owned = {o.path: o for o in plan.owned}
            blocked: dict[str, str] = {}
            for rel, data in plan.files.items():
                target = dataset / rel
                entry = entries.get(rel)
                if not os.path.lexists(target):
                    continue
                if target.is_symlink():
                    blocked[rel] = "symbolic link, kept"
                elif target.read_bytes() != data and not (
                    entry is not None and entry.output_sha256 == _sha(target.read_bytes())
                ):
                    blocked[rel] = "hand-edited, kept" if entry is not None else "not ours, kept"
            if blocked:
                plan.kept = {rel: blocked.get(rel, "kept with its pair") for rel in plan.files}
                continue
            for rel, data in plan.files.items():
                target = dataset / rel
                if not target.exists() or target.read_bytes() != data:
                    target.write_bytes(data)
                written.append(rel)
                if entries.get(rel) != owned[rel]:
                    entries[rel] = owned[rel]
                    changed = True
    if changed:
        write_ownership(dataset, pipeline_version(), list(entries.values()))
    return written


# ---- report --------------------------------------------------------------------------------


def _fits_line(fits: dict[str, Fit]) -> str:
    parts = []
    for k, f in sorted(fits.items()):
        extra = ""
        if f.inside_fraction is not None:
            outside = "n/a" if f.max_outside_mm is None else f"{f.max_outside_mm:.1f} mm"
            extra = f", inside {f.inside_fraction:.1%}, farthest outside {outside}"
        parts.append(
            f"{k}: median {f.median_mm:.2f} mm, p90 {f.p90_mm:.2f}, n={f.n_used}/{f.n_total}"
            f"{extra} -> {f.grade}" + (f" ({f.reason})" if f.reason else "")
        )
    return "; ".join(parts)


def report(plans: list[SubjectPlan], dataset_dir: str | Path) -> list[str]:
    """Human-readable lines for `inspect`: pairing evidence, residuals and verification."""
    dataset = Path(dataset_dir)
    lines: list[str] = []
    for plan in plans:
        tag = f"sub-{plan.subject}" + (f" ses-{plan.session}" if plan.session else "")
        lines.append(f"{tag}: SPM deformation field -> {LABEL}: {plan.verdict}")
        if plan.reason:
            lines.append(f"  reason: {plan.reason}")
        for c in plan.candidates:
            if c.field_path is None:
                lines.append(f"  {_rel(c.electrodes_path, dataset)}: {c.note}")
                continue
            surface = (
                f"; subject surface {c.surface_name} (reported only): {_fits_line(c.surface_fit)}"
                if c.surface_fit
                else ""
            )
            template = f"; vs shell: {_fits_line(c.template_fit)}" if c.template_fit else ""
            lines.append(
                f"  pairing evidence, {_rel(c.electrodes_path, dataset)} vs "
                f"{_rel(c.field_path, dataset)}: {c.n_invertible}/{c.n_contacts} contacts invert; "
                f"IntendedFor {c.intended}{surface}{template}"
                + ("" if c.eligible else f"; not eligible ({c.note})")
            )
        if plan.chosen and plan.inversion:
            inv = plan.inversion
            lines.append(
                f"  chosen {_rel(plan.chosen.electrodes_path, dataset)} by {plan.basis}; "
                f"inversion residual median {inv.median_residual:.4f} mm, "
                f"max {inv.max_residual:.4f} mm"
            )
            if plan.field_check:
                fc = plan.field_check
                lines.append(
                    f"  field check on the subject's pial vertices: {fc.n_inverted}/{fc.n_sampled} "
                    f"invert, median {fc.median_mm:.2f} mm, 10th percentile {fc.p10_mm:.2f} mm, "
                    f"centroid {fc.centroid_mm:.1f} mm, extent difference "
                    f"{fc.extent_deviation:.0%} -> {'pass' if fc.passed else 'FAIL'}"
                )
            if plan.template_fit:
                lines.append(f"  verification vs {REFERENCE}: {_fits_line(plan.template_fit)}")
        for rel in plan.files:
            lines.append(f"  would write {rel}")
    return lines
