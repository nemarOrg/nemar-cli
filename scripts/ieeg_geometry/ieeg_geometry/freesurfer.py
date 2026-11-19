"""FreeSurfer subject directories to template-space electrode positions.

For a subject that ships a FreeSurfer subject directory (`surf/?h.pial`, optionally
`surf/?h.sphere.reg`, and `mri/transforms/talairach.xfm`) this module

1. decides the frame of the subject's electrodes with `fit_with_offset` against the subject's
   own pial surfaces (lead ruling 4: the declared frame is tkr RAS, the offset frame is scanner
   RAS = tkr RAS + c_ras; a frame needs specific evidence, or plausible evidence plus the
   independent evidence of a dataset-shipped `talairach.xfm`, lead ruling 3);
2. maps every contact within 3.0 mm of the subject's pial surface (when `sphere.reg` exists)
   through the surface registration to the nearest fsaverage6 vertex (label `fsaverage`);
3. maps every other contact through `talairach.xfm` (scanner RAS to MNI305, label `MNI305`);
4. verifies each output set against fsaverage with L1's `fit` and refuses (never writes) a set
   that fails.

`talairach.xfm` is the MNI `.xfm` text format. Accepted: `Transform_Type = Linear;` and a
`Linear_Transform =` block of 12 numbers (three rows of four) ending in `;`; `%` comment lines
and blank lines are ignored; any other transform type, or a block that is not 12 finite numbers,
is refused. FreeSurfer's `talairach.xfm` maps the subject's scanner RAS to MNI305.

Run `python -m ieeg_geometry.freesurfer <dataset-dir>` for a read-only report.
"""

from __future__ import annotations

import csv
import json
import re
import sys
from dataclasses import dataclass, field, replace
from importlib import metadata
from pathlib import Path

import nibabel as nib
import numpy as np
from scipy.spatial import KDTree

from .bids import Discovered, ElectrodeSet, GeometryRefusal, discover, read_electrode_set
from .ownership import OwnedPath, Verification, blob_id, read_ownership, write_ownership
from .reference import DATA_DIR, _check_sums, load_reference
from .surfaces import Surface, read_freesurfer
from .verify import Fit, OffsetFit, fit, fit_depth_inside, fit_with_offset

SURFACE_MAX_MM = 3.0
MIN_CONTACTS = 3
TRANSFORM_SAMPLES = 2000
TRANSFORM_MEDIAN_MM = 6.0
TRANSFORM_P10_MM = 2.0
METHOD_REFERENCE = "https://docs.nemar.org/data/ieeg-geometry/"
LABEL_SURFACE = "fsaverage"
LABEL_AFFINE = "MNI305"
METHOD_SURFACE = "freesurfer-sphere-reg-fsaverage6"
METHOD_AFFINE = "freesurfer-talairach-affine"
_TEMPLATE_KEYS = {"fsaverage": LABEL_SURFACE, "mni305": LABEL_AFFINE}
_HEMIS = (("L", "lh"), ("R", "rh"))


def pipeline_version() -> str:
    try:
        return metadata.version("ieeg-geometry")
    except metadata.PackageNotFoundError:  # running from a source checkout without install
        return "0+unknown"


# ---- talairach.xfm ---------------------------------------------------------------------------


def parse_talairach_xfm(path: str | Path) -> np.ndarray:
    """The 4 x 4 matrix of an MNI linear `.xfm` file (see the module docstring for the format)."""
    path = Path(path)
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise GeometryRefusal("xfm-unreadable", f"{path.name}: {exc}") from exc
    lines = [ln.split("%", 1)[0].strip() for ln in text.splitlines()]
    body = " ".join(ln for ln in lines if ln)
    kind = re.search(r"Transform_Type\s*=\s*(\w+)\s*;", body)
    if kind is None or kind.group(1).lower() != "linear":
        raise GeometryRefusal("xfm-format", f"{path.name} is not a Linear transform")
    block = re.search(r"Linear_Transform\s*=([^;]*);", body)
    if block is None:
        raise GeometryRefusal("xfm-format", f"{path.name} has no Linear_Transform block")
    try:
        values = [float(tok) for tok in block.group(1).split()]
    except ValueError as exc:
        raise GeometryRefusal("xfm-format", f"{path.name}: {exc}") from exc
    if len(values) != 12 or not np.isfinite(values).all():
        raise GeometryRefusal(
            "xfm-format", f"{path.name} has {len(values)} numbers in the matrix, not 12"
        )
    matrix = np.eye(4)
    matrix[:3, :] = np.array(values).reshape(3, 4)
    return matrix


def apply_affine(matrix: np.ndarray, points: np.ndarray) -> np.ndarray:
    pts = np.asarray(points, dtype=float).reshape(-1, 3)
    return pts @ matrix[:3, :3].T + matrix[:3, 3]


# ---- vendored fsaverage6 sphere ---------------------------------------------------------------


@dataclass(eq=False)
class Fsaverage6:
    """Per hemisphere (`L`, `R`): sphere.reg vertices, their KD-tree and the pial surface."""

    sphere: dict[str, np.ndarray]
    pial: dict[str, np.ndarray]
    trees: dict[str, KDTree]


_FS6: Fsaverage6 | None = None


def load_fsaverage6() -> Fsaverage6:
    """The vendored fsaverage6 `sphere.reg` and pial vertices (checked against SHA256SUMS)."""
    global _FS6
    if _FS6 is None:
        directory = DATA_DIR / "fsaverage"
        _check_sums(directory)
        sphere: dict[str, np.ndarray] = {}
        pial: dict[str, np.ndarray] = {}
        for hemi, stem in _HEMIS:
            with np.load(directory / f"{stem}.sphere.reg.npz") as npz:
                sphere[hemi] = np.asarray(npz["vertices"], dtype=float)
            with np.load(directory / f"{stem}.pial.npz") as npz:
                pial[hemi] = np.asarray(npz["vertices"], dtype=float)
            if len(sphere[hemi]) != len(pial[hemi]):
                raise GeometryRefusal("reference-corrupt", f"{stem} sphere and pial differ")
        trees = {h: KDTree(_unit(sphere[h])) for h in sphere}
        _FS6 = Fsaverage6(sphere, pial, trees)
    return _FS6


def _unit(points: np.ndarray) -> np.ndarray:
    return points / np.linalg.norm(points, axis=1, keepdims=True)


# ---- subject directories ----------------------------------------------------------------------


@dataclass(frozen=True)
class SubjectDir:
    path: Path
    pial: dict[str, Path]
    sphere_reg: dict[str, Path]
    talairach: Path | None


def _present(path: Path) -> bool:
    return path.is_file()  # an annexed file whose content is absent is a dangling link


def _subject_dir_at(root: Path) -> SubjectDir | None:
    pial = {h: root / "surf" / f"{s}.pial" for h, s in _HEMIS}
    pial = {h: p for h, p in pial.items() if _present(p)}
    if not pial:
        return None
    sphere = {h: root / "surf" / f"{s}.sphere.reg" for h, s in _HEMIS if h in pial}
    xfm = root / "mri" / "transforms" / "talairach.xfm"
    return SubjectDir(
        root, pial, {h: p for h, p in sphere.items() if _present(p)}, xfm if _present(xfm) else None
    )


def _names_subject(parts: tuple[str, ...], subject: str) -> bool:
    token = f"sub-{subject}"
    return any(p == token or p.startswith(token + "_") for p in parts)


def _names_session(parts: tuple[str, ...], session: str) -> bool:
    token = f"ses-{session}"
    return any(p == token or f"_{token}" in p or p.startswith(token + "_") for p in parts)


def find_subject_dirs(dataset: Path, subject: str, session: str | None = None) -> list[SubjectDir]:
    """FreeSurfer subject directories under the dataset whose path names `sub-<subject>`.

    A directory counts when it holds `surf/lh.pial` or `surf/rh.pial`. When several match and
    the electrodes file has a session, the ones whose path names that session are preferred.
    """
    roots: dict[Path, SubjectDir] = {}
    for pial in sorted(dataset.rglob("*.pial")):
        if pial.name not in ("lh.pial", "rh.pial") or pial.parent.name != "surf":
            continue
        root = pial.parent.parent
        rel = root.relative_to(dataset)
        if "fsaverage" in rel.parts or not _names_subject(rel.parts, subject):
            continue
        found = _subject_dir_at(root)
        if found is not None:
            roots[root] = found
    dirs = list(roots.values())
    if len(dirs) > 1 and session is not None:
        by_session = [d for d in dirs if _names_session(d.path.relative_to(dataset).parts, session)]
        dirs = by_session or dirs
    return dirs


# ---- frame decision ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FrameDecision:
    """Which frame the electrodes are in, with the evidence."""

    frame: str  # "tkr" (the surface's own RAS) or "scanner" (tkr RAS + c_ras)
    choice: str  # OffsetFit.preferred: "as_declared" or "c_ras"
    grade: str  # "specific" or "plausible"
    basis: str  # contact kind the decision rests on: "ecog" or "seeg"
    c_ras: tuple[float, float, float]
    fits: dict[str, OffsetFit]
    independent: str  # what made a plausible grade sufficient, or "" when specific

    def describe(self) -> str:
        fit_ = self.fits[self.basis]
        chosen = fit_.with_c_ras if self.choice == "c_ras" else fit_.as_declared
        assert chosen is not None
        where = (
            "scanner RAS (c_ras subtracted)" if self.frame == "scanner" else "tkr RAS as declared"
        )
        return (
            f"{where}, {self.grade} evidence from {self.basis} contacts, "
            f"median {chosen.median_mm:.2f} mm"
        )


def _kind(contact_type: str) -> str:
    return "ecog" if contact_type == "ecog" else "seeg"


def _fmt_offset(label: str, result: OffsetFit) -> str:
    a, b = result.as_declared, result.with_c_ras
    text = f"{label}: declared median {a.median_mm:.2f} mm ({a.grade})"
    if b is not None:
        text += f", c_ras subtracted {b.median_mm:.2f} mm ({b.grade})"
    return text + f", preferred {result.preferred}"


def decide_frame(
    eset: ElectrodeSet, surfaces: list[Surface], c_ras: tuple[float, float, float], has_xfm: bool
) -> FrameDecision:
    """Frame of the contacts against the subject's own pial surfaces (lead rulings 3 and 4).

    ECoG contacts decide when present (specific evidence); otherwise depth contacts decide and
    need the independent evidence of a shipped `talairach.xfm`. Raises `GeometryRefusal`
    carrying the distances when no frame is accepted.
    """
    kinds: dict[str, list[int]] = {}
    for i, c in enumerate(eset.contacts):
        if not c.missing_coordinates:
            kinds.setdefault(_kind(c.type), []).append(i)
    if sum(len(v) for v in kinds.values()) < MIN_CONTACTS:
        raise GeometryRefusal(
            "too-few-contacts", f"fewer than {MIN_CONTACTS} contacts with x, y, z"
        )
    xyz = eset.xyz_mm
    fits: dict[str, OffsetFit] = {}
    for kind, idx in kinds.items():
        hemis = [eset.contacts[i].hemisphere for i in idx]
        fits[kind] = fit_with_offset(xyz[idx], surfaces, kind, c_ras, hemis)
    basis = "ecog" if "ecog" in fits else "seeg"
    chosen = fits[basis]
    detail = "; ".join(_fmt_offset(k, v) for k, v in fits.items())
    if chosen.preferred is None:
        raise GeometryRefusal(
            "frame-not-found", f"neither frame fits the subject surface: {detail}"
        )
    if chosen.preferred == "ambiguous":
        raise GeometryRefusal("frame-ambiguous", detail)
    fit_ = chosen.with_c_ras if chosen.preferred == "c_ras" else chosen.as_declared
    assert fit_ is not None
    independent = ""
    if fit_.grade != "specific":
        if not has_xfm:
            raise GeometryRefusal(
                "frame-evidence-insufficient",
                f"plausible evidence only and no talairach.xfm to corroborate it: {detail}",
            )
        independent = "shipped talairach.xfm"
    return FrameDecision(
        frame="scanner" if chosen.preferred == "c_ras" else "tkr",
        choice=chosen.preferred,
        grade=fit_.grade,
        basis=basis,
        c_ras=c_ras,
        fits=fits,
        independent=independent,
    )


# ---- computing positions ----------------------------------------------------------------------


@dataclass
class OutputFile:
    label: str
    method: str
    electrodes_path: Path
    coordsystem_path: Path
    header: list[str]
    rows: list[dict[str, str]]
    xyz: np.ndarray
    verification: Fit
    description: str
    inputs: list[Path]
    pial_distance_median_mm: float | None = None
    pial_distance_max_mm: float | None = None
    transform_check: tuple[float, float, int] | None = None
    affine_vs_surface_mm: tuple[float, float] | None = None


@dataclass
class Refusal:
    scope: str
    reason: str
    message: str


@dataclass
class SubjectResult:
    subject: str
    session: str | None
    source: Path
    subject_dir: Path | None = None
    frame: FrameDecision | None = None
    n_surface: int = 0
    n_affine: int = 0
    # median and 90th percentile distance between the affine and surface-based positions of
    # the surface-mapped contacts: a direct measure of the affine error, not a gate
    affine_vs_surface_mm: tuple[float, float] | None = None
    transform_check: tuple[float, float, int] | None = None
    outputs: list[OutputFile] = field(default_factory=list)
    refusals: list[Refusal] = field(default_factory=list)
    skipped: list[Refusal] = field(default_factory=list)


def _label_of(value: str | None) -> str | None:
    if not value:
        return None
    return _TEMPLATE_KEYS.get(value.strip().lower())


def _declared_label(item: Discovered) -> str | None:
    label = _label_of(item.space)
    if label or item.coordsystem_path is None:
        return label
    try:
        doc = json.loads(item.coordsystem_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    frame = doc.get("iEEGCoordinateSystem") if isinstance(doc, dict) else None
    return _label_of(frame) if isinstance(frame, str) else None


def _prefix(path: Path) -> str:
    return path.name[: -len("_electrodes.tsv")]


def _output_prefix(source: Path, label: str) -> str:
    base = re.sub(r"_space-[^_]+", "", _prefix(source))
    return f"{base}_space-{label}"


def _read_raw(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with path.open(newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh, delimiter="\t")
        rows = list(reader)
        return list(reader.fieldnames or []), rows


def check_transform(
    xfm: np.ndarray, surfaces: dict[str, Surface], c_ras: tuple[float, float, float]
) -> tuple[float, float, int]:
    """Lead ruling 12: the subject's own pial vertices through `talairach.xfm` against fsaverage.

    At least 2,000 pial vertices (evenly spaced over both hemispheres, tkr RAS plus c_ras gives
    scanner RAS) are mapped and measured to the nearest fsaverage6 pial vertex. Returns the
    median, the 10th percentile and the number sampled; raises `GeometryRefusal` when the
    median exceeds 6.0 mm or the 10th percentile exceeds 2.0 mm.
    """
    verts = np.vstack([s.vertices for s in surfaces.values()])
    step = max(1, len(verts) // TRANSFORM_SAMPLES)
    sample = verts[::step]
    fs6 = load_fsaverage6()
    tree = KDTree(np.vstack([fs6.pial["L"], fs6.pial["R"]]))
    dist, _ = tree.query(apply_affine(xfm, sample + np.asarray(c_ras)))
    median, p10 = float(np.median(dist)), float(np.percentile(dist, 10))
    if len(sample) < TRANSFORM_SAMPLES or median > TRANSFORM_MEDIAN_MM or p10 > TRANSFORM_P10_MM:
        raise GeometryRefusal(
            "transform-check-failed",
            f"{len(sample)} subject pial vertices through talairach.xfm: median {median:.2f} mm "
            f"(at most {TRANSFORM_MEDIAN_MM}), 10th percentile {p10:.2f} mm "
            f"(at most {TRANSFORM_P10_MM})",
        )
    return median, p10, len(sample)


def map_to_fsaverage6(
    tkr: np.ndarray, subject: SubjectDir, surfaces: dict[str, Surface]
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Surface method for contacts in tkr RAS.

    Returns, per contact: whether it is mapped (nearest pial vertex within 3.0 mm and that
    hemisphere has a usable `sphere.reg`), the fsaverage6 position (NaN when not mapped) and
    the distance to the subject's pial surface. Path: nearest subject pial vertex, its
    `sphere.reg` position, the nearest fsaverage6 sphere vertex, that vertex's fsaverage6 pial
    position.
    """
    fs6 = load_fsaverage6()
    n = len(tkr)
    best = np.full(n, np.inf)
    best_hemi = np.full(n, "", dtype="<U1")
    best_idx = np.zeros(n, dtype=np.int64)
    for hemi, surf in surfaces.items():
        dist, idx = KDTree(surf.vertices).query(tkr)
        better = dist < best
        best[better], best_idx[better], best_hemi[better] = dist[better], idx[better], hemi
    mapped = np.zeros(n, dtype=bool)
    out = np.full((n, 3), np.nan)
    for hemi in surfaces:
        path = subject.sphere_reg.get(hemi)
        if path is None:
            continue
        sel = (best_hemi == hemi) & (best <= SURFACE_MAX_MM)
        if not sel.any():
            continue
        try:
            sphere = nib.freesurfer.read_geometry(str(path))[0]
        except Exception as exc:  # nibabel raises several types for a malformed file
            raise GeometryRefusal("sphere-reg-unreadable", f"{path.name}: {exc}") from exc
        if len(sphere) != len(surfaces[hemi].vertices):
            raise GeometryRefusal(
                "sphere-reg-mismatch",
                f"{path.name} has {len(sphere)} vertices, pial has {len(surfaces[hemi].vertices)}",
            )
        pos = _unit(np.asarray(sphere, dtype=float)[best_idx[sel]])
        _, j = fs6.trees[hemi].query(pos)
        out[sel] = fs6.pial[hemi][j]
        mapped[sel] = True
    return mapped, out, best


def _coordsystem(result_label: str, description: str, units: str = "mm") -> dict[str, str]:
    system_text = {
        LABEL_SURFACE: "FreeSurfer fsaverage template (the fsaverage6 vertex set, pial surface)",
        LABEL_AFFINE: "MNI305 (the FreeSurfer Talairach target, close to fsaverage space)",
    }[result_label]
    return {
        "iEEGCoordinateSystem": result_label,
        "iEEGCoordinateUnits": units,
        "iEEGCoordinateSystemDescription": system_text,
        "iEEGCoordinateProcessingDescription": description,
        "iEEGCoordinateProcessingReference": METHOD_REFERENCE,
    }


def _describe(
    method: str,
    source: Path,
    inputs: list[Path],
    dataset: Path,
    decision: FrameDecision,
    verification: Fit,
    n: int,
    pial: tuple[float, float] | None,
    agreement: tuple[float, float] | None = None,
    transform: tuple[float, float, int] | None = None,
) -> str:
    rel = ", ".join(sorted(_rel(p, dataset) for p in inputs))
    frame = (
        "electrodes taken as scanner RAS (the surface c_ras offset removed)"
        if decision.frame == "scanner"
        else "electrodes taken as the subject's surface (tkr) RAS as declared"
    )
    head = (
        f"Computed by NEMAR (ieeg_geometry {pipeline_version()}) from {_rel(source, dataset)}, "
        f"{n} contacts, frame check: {frame}, {decision.grade} evidence "
        f"from {decision.basis} contacts"
    )
    if method == METHOD_SURFACE and pial is not None:
        how = (
            f"; method: each contact within {SURFACE_MAX_MM:.1f} mm of the subject pial surface "
            f"(median {pial[0]:.2f} mm, maximum {pial[1]:.2f} mm) was moved to the fsaverage6 "
            "vertex that the subject's FreeSurfer sphere.reg registration assigns to its nearest "
            "pial vertex, so positions sit on fsaverage6 vertices and are surface-based"
        )
    else:
        how = (
            "; method: scanner RAS positions were multiplied by the dataset's FreeSurfer "
            "talairach.xfm; this affine method is approximate and does not follow individual "
            "cortical folding"
        )
        how += (
            "; typical error of an affine template position is 5 to 15 mm, so use these "
            "positions for approximate localization only"
        )
        if transform is not None:
            how += (
                f"; transform check: {transform[2]} of the subject's pial vertices through "
                f"the transform land a median {transform[0]:.2f} mm (10th percentile "
                f"{transform[1]:.2f} mm) from the fsaverage pial surface"
            )
        if agreement is not None:
            how += (
                "; for this subject's contacts that the surface method placed, the affine and "
                f"surface-based positions differ by a median of {agreement[0]:.2f} mm "
                f"(90th percentile {agreement[1]:.2f} mm)"
            )
    check = (
        f"; verified against fsaverage: median {verification.median_mm:.2f} mm, "
        f"90th percentile {verification.p90_mm:.2f} mm, {verification.grade} ({verification.rule})"
    )
    return f"{head}{how}; inputs: {rel}{check}."


def _pct(v: float | None) -> str:
    return "n/a" if v is None else f"{v:.0%}"


def _rel(path: Path, dataset: Path) -> str:
    try:
        return path.relative_to(dataset).as_posix()
    except ValueError:
        return path.as_posix()


def compute_subject(
    dataset: Path,
    item: Discovered,
    *,
    existing_labels: set[str],
) -> SubjectResult:
    """Everything B1 computes for one electrodes file; nothing is written.

    `existing_labels` are the labels the authors already ship for this subject and session
    (their files win, lead plan item 4).
    """
    result = SubjectResult(item.subject, item.session, item.electrodes_path)
    if _declared_label(item) is not None:
        result.skipped.append(
            Refusal("file", "already-template", "the file is already in a template")
        )
        return result
    try:
        eset = read_electrode_set(item)
    except GeometryRefusal as exc:
        result.refusals.append(Refusal("file", exc.reason, exc.message))
        return result
    dirs = find_subject_dirs(dataset, item.subject, item.session)
    if not dirs:
        result.skipped.append(
            Refusal("file", "no-freesurfer-dir", "no FreeSurfer subject directory")
        )
        return result
    if len(dirs) > 1:
        names = ", ".join(sorted(_rel(d.path, dataset) for d in dirs))
        result.refusals.append(Refusal("file", "subject-dir-ambiguous", names))
        return result
    subject = dirs[0]
    result.subject_dir = subject.path
    wanted = {LABEL_SURFACE, LABEL_AFFINE} - existing_labels
    for label in sorted({LABEL_SURFACE, LABEL_AFFINE} & existing_labels):
        result.skipped.append(Refusal(label, "authors-file", f"the authors ship space-{label}"))
    if not wanted:
        return result
    try:
        surfaces = {h: read_freesurfer(p) for h, p in subject.pial.items()}
        c_ras = next((s.c_ras for s in surfaces.values() if s.c_ras is not None), None)
        if c_ras is None:
            raise GeometryRefusal("c-ras-missing", "the pial surface footer has no c_ras")
        xfm = parse_talairach_xfm(subject.talairach) if subject.talairach else None
        decision = decide_frame(eset, list(surfaces.values()), c_ras, xfm is not None)
    except GeometryRefusal as exc:
        result.refusals.append(Refusal("file", exc.reason, exc.message))
        return result
    result.frame = decision

    xyz = eset.xyz_mm
    finite = np.isfinite(xyz).all(axis=1)
    offset = np.asarray(c_ras)
    tkr = xyz if decision.frame == "tkr" else xyz - offset
    scanner = xyz + offset if decision.frame == "tkr" else xyz
    mapped = np.zeros(len(xyz), dtype=bool)
    fs6_pos = np.full_like(xyz, np.nan)
    pial_dist = np.full(len(xyz), np.nan)
    cortical = finite & np.array([c.type == "ecog" for c in eset.contacts], dtype=bool)
    if LABEL_SURFACE in wanted and cortical.any():  # ruling 11: depth contacts never snap
        try:
            m, p, d = map_to_fsaverage6(tkr[cortical], subject, surfaces)
        except GeometryRefusal as exc:
            result.refusals.append(Refusal(LABEL_SURFACE, exc.reason, exc.message))
        else:
            mapped[cortical], fs6_pos[cortical], pial_dist[cortical] = m, p, d
    affine_sel = finite & ~mapped if LABEL_SURFACE in wanted else finite.copy()
    result.n_surface = int(mapped.sum())
    if mapped.any() and xfm is not None:
        gap = np.linalg.norm(apply_affine(xfm, scanner[mapped]) - fs6_pos[mapped], axis=1)
        result.affine_vs_surface_mm = (float(np.median(gap)), float(np.percentile(gap, 90)))
    header, raw = _read_raw(item.electrodes_path)
    fsaverage = load_reference("fsaverage")

    def emit(label: str, method: str, sel: np.ndarray, pos: np.ndarray, rule_type: str) -> None:
        idx = np.flatnonzero(sel)
        if not len(idx):
            return
        hemis = [eset.contacts[i].hemisphere for i in idx]
        if rule_type == "depth":
            verification = fit_depth_inside(pos[idx], fsaverage)
        else:
            verification = fit(pos[idx], fsaverage, rule_type, hemis)
        inputs = [item.electrodes_path] + [p for p in (item.coordsystem_path,) if p is not None]
        inputs += list(subject.pial.values())
        if method == METHOD_SURFACE:
            inputs += list(subject.sphere_reg.values())
        elif subject.talairach is not None:
            inputs.append(subject.talairach)
        if not verification.passed:
            result.refusals.append(
                Refusal(
                    label,
                    "verification-failed",
                    f"{len(idx)} contacts, median {verification.median_mm:.2f} mm, "
                    f"inside {_pct(verification.inside_fraction)}, "
                    f"farthest {verification.max_mm:.1f} mm, {verification.rule}"
                    + (f", {verification.reason}" if verification.reason else ""),
                )
            )
            return
        pial = None
        if method == METHOD_SURFACE:
            pial = (float(np.median(pial_dist[idx])), float(np.max(pial_dist[idx])))
        prefix = _output_prefix(item.electrodes_path, label)
        folder = item.electrodes_path.parent
        result.outputs.append(
            OutputFile(
                label=label,
                method=method,
                electrodes_path=folder / f"{prefix}_electrodes.tsv",
                coordsystem_path=folder / f"{prefix}_coordsystem.json",
                header=header,
                rows=[raw[i] for i in idx],
                xyz=pos[idx],
                verification=verification,
                description=_describe(
                    method,
                    item.electrodes_path,
                    inputs,
                    dataset,
                    decision,
                    verification,
                    len(idx),
                    pial,
                    result.affine_vs_surface_mm,
                    result.transform_check if method == METHOD_AFFINE else None,
                ),
                inputs=inputs,
                pial_distance_median_mm=None if pial is None else pial[0],
                pial_distance_max_mm=None if pial is None else pial[1],
                transform_check=result.transform_check if method == METHOD_AFFINE else None,
                affine_vs_surface_mm=(
                    result.affine_vs_surface_mm if method == METHOD_AFFINE else None
                ),
            )
        )

    if mapped.any():
        emit(LABEL_SURFACE, METHOD_SURFACE, mapped, fs6_pos, "ecog")
    if LABEL_AFFINE in wanted and affine_sel.any():
        result.n_affine = int(affine_sel.sum())
        if xfm is None:
            result.refusals.append(
                Refusal(LABEL_AFFINE, "xfm-missing", "no talairach.xfm for the affine method")
            )
        else:
            try:
                result.transform_check = check_transform(xfm, surfaces, c_ras)
            except GeometryRefusal as exc:
                result.refusals.append(Refusal(LABEL_AFFINE, exc.reason, exc.message))
            else:
                pos = np.full_like(xyz, np.nan)
                pos[affine_sel] = apply_affine(xfm, scanner[affine_sel])
                emit(LABEL_AFFINE, METHOD_AFFINE, affine_sel, pos, "depth")
    return result


def plan_dataset(dataset_dir: str | Path) -> list[SubjectResult]:
    """B1's results for every electrodes file of a dataset checkout. Nothing is written."""
    dataset = Path(dataset_dir)
    items = discover(dataset)
    owned = set()
    ownership = read_ownership(dataset)
    if ownership is not None:
        owned = {e.path for e in ownership.entries}
    labels: dict[tuple[str, str | None], set[str]] = {}
    for item in items:
        if _rel(item.electrodes_path, dataset) in owned:
            continue  # the pipeline's own earlier output is regenerated, not the authors'
        label = _declared_label(item)
        if label:
            labels.setdefault((item.subject, item.session), set()).add(label)
    results = [
        compute_subject(
            dataset, item, existing_labels=labels.get((item.subject, item.session), set())
        )
        for item in items
        if _rel(item.electrodes_path, dataset) not in owned
    ]
    return _resolve_duplicates(results)


def _resolve_duplicates(results: list[SubjectResult]) -> list[SubjectResult]:
    """Two input files that map to the same output path: keep the one that verified best."""
    best: dict[Path, tuple[float, SubjectResult, OutputFile]] = {}
    for res in results:
        for out in res.outputs:
            key = out.electrodes_path
            score = out.verification.median_mm
            if key not in best or score < best[key][0]:
                best[key] = (score, res, out)
    for res in results:
        kept = []
        for out in res.outputs:
            if best[out.electrodes_path][2] is out:
                kept.append(out)
            else:
                res.skipped.append(
                    Refusal(
                        out.label,
                        "duplicate-output",
                        f"another input of this subject gives {out.electrodes_path.name} "
                        "with a better fit",
                    )
                )
        res.outputs = kept
    return results


# ---- writing ----------------------------------------------------------------------------------


def _tsv_bytes(out: OutputFile) -> bytes:
    lines = ["\t".join(out.header)]
    for row, (x, y, z) in zip(out.rows, out.xyz, strict=True):
        cells = dict(row)
        cells.update({"x": f"{x:.3f}", "y": f"{y:.3f}", "z": f"{z:.3f}"})
        lines.append("\t".join(cells.get(col, "n/a") or "n/a" for col in out.header))
    return ("\n".join(lines) + "\n").encode("utf-8")


def _json_bytes(out: OutputFile) -> bytes:
    doc = _coordsystem(out.label, out.description)
    return (json.dumps(doc, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def write_outputs(dataset_dir: str | Path, results: list[SubjectResult]) -> list[OwnedPath]:
    """Write every verified output file and record it in `.nemar/ieeg-geometry.json`.

    The existing ownership file is read and merged: only entries for the paths written here
    are replaced, other tracks' entries survive. Output bytes are deterministic, so a rerun on
    unchanged inputs rewrites identical files. Returns the entries this call wrote.
    """
    dataset = Path(dataset_dir)
    entries: list[OwnedPath] = []
    for res in results:
        for out in res.outputs:
            inputs = tuple(
                sorted(
                    (_rel(p, dataset), blob_id(p))
                    for p in out.inputs
                    if p.exists() or p.is_symlink()
                )
            )
            verification = Verification.from_fit(out.verification, "fsaverage")
            notes = []
            if out.transform_check is not None:
                t = out.transform_check
                notes.append(
                    f"transform check {t[2]} pial vertices median {t[0]:.2f} mm p10 {t[1]:.2f} mm"
                )
            if out.affine_vs_surface_mm is not None:
                a = out.affine_vs_surface_mm
                notes.append(f"affine vs surface median {a[0]:.2f} mm p90 {a[1]:.2f} mm")
            if notes:
                verification = replace(
                    verification, rule=verification.rule + "; " + "; ".join(notes)
                )
            for path, data, kind in (
                (out.electrodes_path, _tsv_bytes(out), "electrodes"),
                (out.coordsystem_path, _json_bytes(out), "coordsystem"),
            ):
                path.write_bytes(data)
                entries.append(
                    OwnedPath(_rel(path, dataset), kind, inputs, out.method, verification)
                )
    if entries:
        existing = read_ownership(dataset)
        mine = {e.path for e in entries}
        kept = [e for e in (existing.entries if existing else []) if e.path not in mine]
        write_ownership(dataset, pipeline_version(), kept + entries)
    return entries


# ---- report -----------------------------------------------------------------------------------


def report_lines(dataset: Path, results: list[SubjectResult]) -> list[str]:
    lines: list[str] = []
    for res in results:
        label = f"sub-{res.subject}" + (f" ses-{res.session}" if res.session else "")
        lines.append(f"{label}: {_rel(res.source, dataset)} [freesurfer transforms]")
        for s in res.skipped:
            lines.append(f"  skipped ({s.scope}): {s.reason}, {s.message}")
        if res.subject_dir is not None:
            lines.append(f"  subject directory {_rel(res.subject_dir, dataset)}")
        if res.frame is not None:
            lines.append(f"  frame decision: {res.frame.describe()}")
            for kind, f in res.frame.fits.items():
                lines.append(f"    {_fmt_offset(kind, f)}")
            if res.frame.independent:
                lines.append(f"    plausible evidence accepted with {res.frame.independent}")
            lines.append(
                f"  methods: {res.n_surface} contacts by surface registration (fsaverage), "
                f"{res.n_affine} by talairach.xfm (MNI305)"
            )
            if res.transform_check is not None:
                t = res.transform_check
                lines.append(
                    f"  transform check: {t[2]} subject pial vertices through talairach.xfm, "
                    f"median {t[0]:.2f} mm, p10 {t[1]:.2f} mm from fsaverage6 pial"
                )
            if res.affine_vs_surface_mm is not None:
                lines.append(
                    "  affine vs surface positions of the surface-mapped contacts: median "
                    f"{res.affine_vs_surface_mm[0]:.2f} mm, "
                    f"p90 {res.affine_vs_surface_mm[1]:.2f} mm"
                )
        for out in res.outputs:
            v = out.verification
            extra = ""
            if out.pial_distance_median_mm is not None:
                extra = (
                    f", pial distance median {out.pial_distance_median_mm:.2f} "
                    f"max {out.pial_distance_max_mm:.2f} mm"
                )
            lines.append(
                f"  output {out.electrodes_path.name}: {len(out.rows)} contacts, verified vs "
                f"fsaverage median {v.median_mm:.2f} mm p90 {v.p90_mm:.2f} -> {v.grade}{extra}"
            )
        for r in res.refusals:
            lines.append(f"  refused ({r.scope}): {r.reason}, {r.message}")
    return lines


def inspect_dataset(dataset: Path, out=sys.stdout) -> int:
    """Print the read-only freesurfer-transforms report. Returns the number of subject files."""
    results = plan_dataset(dataset)
    for line in report_lines(dataset, results):
        print(line, file=out)
    return len(results)


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1:
        print("usage: python -m ieeg_geometry.freesurfer <dataset-dir>", file=sys.stderr)
        return 2
    return 0 if inspect_dataset(Path(args[0])) else 1


if __name__ == "__main__":
    raise SystemExit(main())
