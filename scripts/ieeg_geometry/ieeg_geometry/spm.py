"""SPM deformation fields to IXI549Space: invert, pair, verify, write.

SPM12's normalization writes `y_<name>.nii`, a deformation field on the template's grid: every
template voxel holds the native-space millimeter position it maps to (template to native). A
native contact therefore needs the inverse, found per contact by a nearest-value lookup for a
starting voxel and Newton iterations on the trilinearly interpolated field (residual below
0.05 mm in at most 20 iterations). A contact that does not converge, or whose solution leaves
the grid, is refused. Output is in millimeters of the field's template grid, labeled
`IXI549Space` (SPM12's default template space in BIDS), which differs from
`MNI152NLin2009cAsym` by a few millimeters.

Pairing: a dataset can ship several electrodes files per subject (native, `space-ACPC`) and the
field belongs to only one of them. The choice is made by evidence, never by file name: the
fraction of contacts the field can invert, and the L1 fit of the candidate's contacts to the
subject surface the field's image belongs to. Two candidates that both pass without a clear
gap (lead ruling 4's margin) are refused as ambiguous.

Verification: the inverted contacts are fit to `MNI152NLin2009cAsym` (L1 `fit`, per contact
kind). A `fail` is refused and reported, never written. A `plausible` grade is accepted because
a deformation field shipped by the dataset is independent frame evidence (lead ruling 3).
"""

from __future__ import annotations

import csv
import io
import json
import math
from dataclasses import dataclass, field, replace
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

import nibabel as nib
import numpy as np
from scipy.spatial import KDTree

from .bids import ElectrodeSet, GeometryRefusal, discover, read_electrode_set
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
    ECOG_MEDIAN_MM,
    FAIL,
    OFFSET_MIN_GAIN_FRACTION,
    OFFSET_MIN_GAIN_MM,
    SEEG_MEDIAN_MM,
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


def pipeline_version() -> str:
    try:
        return version("ieeg-geometry")
    except PackageNotFoundError:  # pragma: no cover - running from a bare checkout
        return "0+unknown"


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
    tree = KDTree(values.reshape(-1, 3))
    _, flat = tree.query(pts[active])
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


# ---- field check (ruling 9) ----------------------------------------------------------------

FIELD_CHECK_SAMPLES = 4000
FIELD_CHECK_MIN_INVERTED = 2000
FIELD_CHECK_MEDIAN_MM = 6.0
FIELD_CHECK_P10_MM = 2.0


@dataclass(frozen=True)
class FieldCheck:
    """Pial vertices of the subject inverted through the field, measured against the shell."""

    n_sampled: int
    n_inverted: int
    median_mm: float
    p10_mm: float
    passed: bool
    reason: str


def check_field(
    field_: DeformationField, pial: list[Surface], reference: list[Surface]
) -> FieldCheck:
    """Ruling 9: invert at least 2,000 sampled pial vertices and measure them against the shell.

    A median at most 6.0 mm and a 10th percentile at most 2.0 mm from the template shell's
    vertices verify the field's direction and its pairing with the subject.
    """
    if not pial:
        return FieldCheck(0, 0, math.nan, math.nan, False, "no subject pial surface to check")
    vertices = np.vstack([s.vertices for s in pial])
    n = min(len(vertices), FIELD_CHECK_SAMPLES)
    idx = np.random.default_rng(0).choice(len(vertices), n, replace=False)
    inv = invert_points(field_, vertices[idx])
    ok = inv.ok
    n_ok = int(ok.sum())
    if n_ok < FIELD_CHECK_MIN_INVERTED or n_ok < 0.9 * n:
        return FieldCheck(
            n, n_ok, math.nan, math.nan, False, f"only {n_ok} of {n} sampled vertices invert"
        )
    dist, _ = KDTree(np.vstack([s.vertices for s in reference])).query(inv.template_mm[ok])
    median, p10 = float(np.median(dist)), float(np.percentile(dist, 10))
    passed = median <= FIELD_CHECK_MEDIAN_MM and p10 <= FIELD_CHECK_P10_MM
    reason = (
        ""
        if passed
        else (
            f"pial vertices land median {median:.2f} mm (limit {FIELD_CHECK_MEDIAN_MM}) and 10th "
            f"percentile {p10:.2f} mm (limit {FIELD_CHECK_P10_MM}) from the shell"
        )
    )
    return FieldCheck(n, n_ok, median, p10, passed, reason)


# ---- pairing -------------------------------------------------------------------------------


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
) -> dict[str, Fit]:
    """L1 `fit` per contact kind for the contacts at `xyz_mm` (N x 3, same order as `eset`)."""
    out: dict[str, Fit] = {}
    for kind, idx in _groups(eset).items():
        hemis = [eset.contacts[i].hemisphere for i in idx]
        out[kind] = fit(xyz_mm[idx], surfaces, kind, hemis)
    return out


def _headline(fits: dict[str, Fit]) -> Fit | None:
    """The fit of the kind holding the most contacts, for ranking and reports."""
    if not fits:
        return None
    return max(fits.values(), key=lambda f: f.n_total)


def _all_pass(fits: dict[str, Fit]) -> bool:
    return bool(fits) and all(f.grade != FAIL for f in fits.values())


def _median_fits(fits: dict[str, Fit]) -> bool:
    """Pairing test: each kind's nearest-vertex median is within L1's bound for that kind.

    Subject surfaces can be cut (open) meshes whose inside test is unevaluable, so pairing uses
    the distance only; writing still needs L1's full grade against the template.
    """
    return bool(fits) and all(
        f.median_mm <= (ECOG_MEDIAN_MM if kind == "ecog" else SEEG_MEDIAN_MM)
        for kind, f in fits.items()
    )


@dataclass
class Candidate:
    """One electrodes file tried against one field."""

    electrodes_path: Path
    field_path: Path
    space: str | None
    frame: str | None
    n_contacts: int
    n_invertible: int
    median_residual_mm: float
    max_residual_mm: float
    surface_fit: dict[str, Fit] | None
    surface_name: str | None
    eligible: bool
    note: str
    intended_for: str | None = None

    @property
    def invertible_fraction(self) -> float:
        return self.n_invertible / self.n_contacts if self.n_contacts else 0.0

    @property
    def score(self) -> float:
        """Surface median distance of the largest contact kind; lower is better."""
        head = _headline(self.surface_fit or {})
        return head.median_mm if head is not None else float("inf")


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


def _intended_for(eset: ElectrodeSet) -> str | None:
    if eset.coordsystem_path is None:
        return None
    try:
        value = json.loads(eset.coordsystem_path.read_text(encoding="utf-8")).get("IntendedFor")
    except (OSError, ValueError):
        return None
    return value if isinstance(value, str) else None


def evaluate_candidate(
    eset: ElectrodeSet,
    field_: DeformationField,
    surfaces: list[Surface],
    surface_name: str | None,
    inversion: Inversion | None = None,
) -> Candidate:
    inv = inversion or invert_points(field_, eset.xyz_mm)
    present = [i for i, c in enumerate(eset.contacts) if not c.missing_coordinates]
    n_inv = int(inv.ok[present].sum()) if present else 0
    surface_fit = fit_groups(eset, eset.xyz_mm, surfaces) if surfaces and present else None
    frac = n_inv / len(present) if present else 0.0
    notes = []
    eligible = True
    if frac < MIN_INVERTIBLE_FRACTION:
        eligible = False
        notes.append(f"only {n_inv}/{len(present)} contacts invert inside the field's grid")
    if surface_fit is not None and not _median_fits(surface_fit):
        eligible = False
        notes.append("contacts do not fit the subject surface")
    if surface_fit is None:
        notes.append("no subject surface, evidence is the invertible fraction only")
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
        surface_name=surface_name,
        eligible=eligible,
        note="; ".join(notes),
        intended_for=_intended_for(eset),
    )


def names_field_t1(intended_for: str | None, field_path: Path) -> bool:
    """True when `IntendedFor` names the image the field was computed from.

    The image is the field's name without its `y_` prefix; the comparison ignores directories,
    the NIfTI extension and a trailing `_deFaced`.
    """
    if not intended_for:
        return False
    name = Path(intended_for.strip()).name
    for ext in (".nii.gz", ".nii"):
        name = name.removesuffix(ext)
    name = name.removesuffix("_deFaced").removesuffix("_defaced")
    stem = field_path.name
    for ext in (".nii.gz", ".nii"):
        stem = stem.removesuffix(ext)
    return name == stem.removeprefix("y_")


def choose(candidates: list[Candidate]) -> tuple[Candidate | None, str]:
    """The paired candidate, or None with the reason (a tie goes to IntendedFor, ruling 10)."""
    ok = [c for c in candidates if c.eligible]
    if not ok:
        return None, "no electrodes file matches the field: " + "; ".join(
            f"{c.electrodes_path.name}: {c.note}" for c in candidates
        )
    ok.sort(key=lambda c: (c.score, -c.invertible_fraction))
    best = ok[0]
    if len(ok) > 1:
        runner = ok[1]
        gain = runner.score - best.score
        separated = np.isfinite(gain) and (
            gain >= OFFSET_MIN_GAIN_MM and gain >= OFFSET_MIN_GAIN_FRACTION * runner.score
        )
        if not separated:
            matching = [c for c in ok if names_field_t1(c.intended_for, c.field_path)]
            if len(matching) == 1:  # ruling 10: IntendedFor names the T1 the field came from
                return matching[0], ""
            return None, (
                f"pairing ambiguous: {best.electrodes_path.name} ({best.score:.2f} mm) and "
                f"{runner.electrodes_path.name} ({runner.score:.2f} mm) both fit and "
                f"IntendedFor does not single out the field's T1"
            )
    return best, ""


# ---- plan and write ------------------------------------------------------------------------


@dataclass
class SubjectPlan:
    subject: str
    session: str | None
    verdict: str  # "write" | "skip" | "refused"
    reason: str = ""
    candidates: list[Candidate] = field(default_factory=list)
    chosen: Candidate | None = None
    inversion: Inversion | None = None
    template_fit: dict[str, Fit] = field(default_factory=dict)
    field_check: FieldCheck | None = None
    # dataset-relative path -> file bytes
    files: dict[str, bytes] = field(default_factory=dict)
    owned: list[OwnedPath] = field(default_factory=list)


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
) -> bytes:
    head = _headline(fits)
    assert head is not None
    grades = ", ".join(f"{k} {f.grade}" for k, f in sorted(fits.items()))
    refused = (
        f" {n_refused} contacts that could not be inverted are written as n/a." if n_refused else ""
    )
    description = (
        f"Computed by NEMAR (ieeg-geometry {pipeline_version()}). Source: {rel_source}, "
        f"mapped to the SPM template space by inverting the dataset's SPM deformation field "
        f"{rel_field} (inversion residual median {inv.median_residual:.3f} mm, maximum "
        f"{inv.max_residual:.3f} mm). Field check on the subject's own pial surface "
        f"({check.n_inverted} sampled vertices inverted): median {check.median_mm:.2f} mm, 10th "
        f"percentile {check.p10_mm:.2f} mm from the template shell. "
        f"Verified against the {REFERENCE} brain surface ({grades}; median distance "
        f"{head.median_mm:.2f} mm, 90th percentile {head.p90_mm:.2f} mm). "
        f"SPM template spaces differ from {REFERENCE} by a few "
        f"millimeters.{refused}"
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
        surface_sets = _subject_surface_sets(dataset, subject)
        loaded: list[tuple[str, list[Surface]]] = []
        for group in surface_sets:
            try:
                loaded.append(
                    ("+".join(sorted(p.name for p in group)), [read_surface(p) for p in group])
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
                Candidate(
                    item.electrodes_path, fields[0], item.space, None, 0, 0, float("nan"),
                    float("nan"), None, None, False, f"refused {exc.reason}",
                )
            )  # fmt: skip
    best: tuple[Candidate, ElectrodeSet, Inversion, DeformationField] | None = None
    verdicts: list[str] = []
    for field_path in fields:
        try:
            field_ = load_field(field_path)
        except GeometryRefusal as exc:
            verdicts.append(f"{field_path.name}: {exc.reason}")
            continue
        cands: list[tuple[Candidate, ElectrodeSet, Inversion]] = []
        for eset in sets:
            inv = invert_points(field_, eset.xyz_mm)
            surf_name, surfs = _best_surface_set(eset, loaded)
            cand = evaluate_candidate(eset, field_, surfs, surf_name, inv)
            plan.candidates.append(cand)
            cands.append((cand, eset, inv))
        chosen, why = choose([c for c, _, _ in cands])
        if chosen is None:
            verdicts.append(f"{field_path.name}: {why}")
            continue
        for cand, eset, inv in cands:
            if cand is chosen:
                if best is None or cand.score < best[0].score:
                    best = (cand, eset, inv, field_)
    if best is None:
        plan.reason = " | ".join(verdicts) or "no readable electrodes file"
        return plan
    cand, eset, inv, field_ = best
    plan.chosen, plan.inversion = cand, inv
    _, pial = _best_surface_set(eset, loaded)
    plan.field_check = check = check_field(field_, pial, reference)
    if not check.passed:
        plan.reason = f"the field failed its check on the subject's own surface: {check.reason}"
        return plan
    fits = fit_groups(eset, np.where(inv.ok[:, None], inv.template_mm, np.nan), reference)
    plan.template_fit = fits
    if not _all_pass(fits):
        detail = ", ".join(
            f"{k}: median {f.median_mm:.2f} mm {f.reason or f.rule}"
            for k, f in sorted(fits.items())
            if f.grade == FAIL
        )
        plan.reason = f"verification against {REFERENCE} failed ({detail})"
        return plan
    rel_src = _rel(cand.electrodes_path, dataset)
    rel_field = _rel(field_.path, dataset)
    stem = _output_stem(cand.electrodes_path, subject, session)
    parent = cand.electrodes_path.parent
    tsv_rel = _rel(parent / f"{stem}_electrodes.tsv", dataset)
    json_rel = _rel(parent / f"{stem}_coordsystem.json", dataset)
    n_refused = int((~inv.ok).sum()) - sum(c.missing_coordinates for c in eset.contacts)
    plan.files = {
        tsv_rel: _electrodes_bytes(cand.electrodes_path, inv.template_mm, inv.ok),
        json_rel: _coordsystem_bytes(rel_src, rel_field, inv, fits, n_refused, check),
    }
    head = _headline(fits)
    assert head is not None
    verification = replace(
        Verification.from_fit(head, REFERENCE),
        field_check_median_mm=round(check.median_mm, 3),
        field_check_p10_mm=round(check.p10_mm, 3),
    )
    inputs = (
        (rel_src, blob_id(cand.electrodes_path)),
        (rel_field, blob_id(field_.path)),
    )
    plan.owned = [
        OwnedPath(tsv_rel, "electrodes", inputs, METHOD, verification),
        OwnedPath(json_rel, "coordsystem", inputs, METHOD, verification),
    ]
    plan.verdict = "write"
    return plan


def _best_surface_set(eset: ElectrodeSet, loaded: list[tuple[str, list[Surface]]]):
    """The subject surface set the contacts fit best (by headline median), with its name."""
    best: tuple[float, str, list[Surface]] | None = None
    for name, surfs in loaded:
        head = _headline(fit_groups(eset, eset.xyz_mm, surfs))
        if head is not None and (best is None or head.median_mm < best[0]):
            best = (head.median_mm, name, surfs)
    return (best[1], best[2]) if best else (None, [])


def write(plans: list[SubjectPlan], dataset_dir: str | Path) -> list[str]:
    """Write the files of every `write` plan and merge them into `.nemar/ieeg-geometry.json`.

    Other owners' entries are kept; a path this pipeline owns is replaced. Reruns on unchanged
    inputs produce byte-identical files.
    """
    dataset = Path(dataset_dir)
    written: list[str] = []
    new_owned: list[OwnedPath] = []
    for plan in plans:
        if plan.verdict != "write":
            continue
        for rel, data in plan.files.items():
            target = dataset / rel
            if not target.exists() or target.read_bytes() != data:
                target.write_bytes(data)
            written.append(rel)
        new_owned.extend(plan.owned)
    if not new_owned:
        return written
    existing = read_ownership(dataset)
    kept = [
        e
        for e in (existing.entries if existing else [])
        if e.path not in {o.path for o in new_owned}
    ]
    write_ownership(
        dataset, existing.pipeline_version if existing else pipeline_version(), kept + new_owned
    )
    return written


# ---- report --------------------------------------------------------------------------------


def _fits_line(fits: dict[str, Fit]) -> str:
    return "; ".join(
        f"{k}: median {f.median_mm:.2f} mm, p90 {f.p90_mm:.2f}, n={f.n_used}/{f.n_total} "
        f"-> {f.grade}" + (f" ({f.reason})" if f.reason else "")
        for k, f in sorted(fits.items())
    )


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
            surface = (
                f"; subject surface {c.surface_name}: {_fits_line(c.surface_fit)}"
                if c.surface_fit
                else ""
            )
            verdict = "; eligible" if c.eligible else f"; not eligible ({c.note})"
            lines.append(
                f"  pairing evidence, {_rel(c.electrodes_path, dataset)} vs "
                f"{_rel(c.field_path, dataset)}: {c.n_invertible}/{c.n_contacts} contacts invert"
                f"{surface}{verdict}"
            )
        if plan.chosen and plan.inversion:
            inv = plan.inversion
            lines.append(
                f"  chosen {_rel(plan.chosen.electrodes_path, dataset)}; inversion residual "
                f"median {inv.median_residual:.4f} mm, max {inv.max_residual:.4f} mm"
            )
            if plan.field_check:
                fc = plan.field_check
                lines.append(
                    f"  field check on the subject's pial vertices: {fc.n_inverted}/{fc.n_sampled} "
                    f"invert, median {fc.median_mm:.2f} mm, 10th percentile {fc.p10_mm:.2f} mm "
                    f"from the shell -> {'pass' if fc.passed else 'FAIL'}"
                )
            lines.append(f"  verification vs {REFERENCE}: {_fits_line(plan.template_fit)}")
        for rel in plan.files:
            lines.append(f"  would write {rel}")
    return lines
