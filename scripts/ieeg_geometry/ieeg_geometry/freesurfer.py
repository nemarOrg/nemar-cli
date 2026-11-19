"""FreeSurfer subject directories to `space-fsaverage` electrode positions (cortical contacts).

For a subject that ships a FreeSurfer subject directory (`surf/?h.pial` and `surf/?h.sphere.reg`)
this module

1. decides the frame of the subject's electrodes with `fit_with_offset` against the subject's
   own pial surfaces, using the cortical (ECoG, grid, strip, surface) contacts, which give
   specific evidence (lead rulings 3, 4 and 13): the declared frame is tkr RAS, the offset frame
   is scanner RAS = tkr RAS + c_ras;
2. maps every cortical contact within 3.0 mm of the subject's pial surface through the surface
   registration to the nearest fsaverage6 vertex (nearest pial vertex, its `sphere.reg`
   position, nearest fsaverage6 sphere vertex, that vertex's fsaverage6 pial position);
3. verifies the set against fsaverage with L1's `fit` and refuses (never writes) a failing set.

Depth (sEEG, DBS) and unknown-type contacts are not written (lead ruling 20: an affine
`talairach.xfm` position has a typical error of 10 to 15 mm and is not worth committing as
data). Every contact left out is counted with its reason in `SubjectResult.left_out`, in the
report and in the written sidecar and ownership record.

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
from .verify import Fit, OffsetFit, fit, fit_with_offset

SURFACE_MAX_MM = 3.0
MIN_CONTACTS = 3
METHOD_REFERENCE = "https://docs.nemar.org/data/ieeg-geometry/"
LABEL = "fsaverage"
METHOD = "freesurfer-sphere-reg-fsaverage6"
_TEMPLATE_KEYS = {"fsaverage": "fsaverage", "mni305": "MNI305"}
_HEMIS = (("L", "lh"), ("R", "rh"))

LEFT_DEPTH = "depth-or-unknown-type"
LEFT_FAR = "cortical-beyond-3mm"
LEFT_NO_SPHERE = "no-sphere-reg"
LEFT_MISSING = "missing-coordinates"
_LEFT_TEXT = {
    LEFT_DEPTH: "depth or unknown-type contacts (affine template positions are too inaccurate "
    "to commit)",
    LEFT_FAR: f"cortical contacts more than {SURFACE_MAX_MM:.1f} mm from the pial surface",
    LEFT_NO_SPHERE: "cortical contacts on a hemisphere without sphere.reg",
    LEFT_MISSING: "contacts without x, y, z",
}


def pipeline_version() -> str:
    try:
        return metadata.version("ieeg-geometry")
    except metadata.PackageNotFoundError:  # running from a source checkout without install
        return "0+unknown"


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


def _present(path: Path) -> bool:
    return path.is_file()  # an annexed file whose content is absent is a dangling link


def _subject_dir_at(root: Path) -> SubjectDir | None:
    pial = {h: root / "surf" / f"{s}.pial" for h, s in _HEMIS}
    pial = {h: p for h, p in pial.items() if _present(p)}
    if not pial:
        return None
    sphere = {h: root / "surf" / f"{s}.sphere.reg" for h, s in _HEMIS if h in pial}
    return SubjectDir(root, pial, {h: p for h, p in sphere.items() if _present(p)})


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
    grade: str  # always "specific": cortical contacts decide
    c_ras: tuple[float, float, float]
    fit: OffsetFit

    def describe(self) -> str:
        chosen = self.fit.with_c_ras if self.choice == "c_ras" else self.fit.as_declared
        assert chosen is not None
        where = (
            "scanner RAS (c_ras subtracted)" if self.frame == "scanner" else "tkr RAS as declared"
        )
        return (
            f"{where}, {self.grade} evidence from cortical contacts, "
            f"median {chosen.median_mm:.2f} mm"
        )


def is_cortical(contact_type: str) -> bool:
    """L1 folds ECoG, grid, strip and surface types into `ecog` (rulings 11 and 20)."""
    return contact_type == "ecog"


def _fmt_offset(result: OffsetFit) -> str:
    a, b = result.as_declared, result.with_c_ras
    text = f"declared median {a.median_mm:.2f} mm ({a.grade})"
    if b is not None:
        text += f", c_ras subtracted {b.median_mm:.2f} mm ({b.grade})"
    return text + f", preferred {result.preferred}"


def decide_frame(
    eset: ElectrodeSet, surfaces: list[Surface], c_ras: tuple[float, float, float]
) -> FrameDecision:
    """Frame of the cortical contacts against the subject's own pial surfaces (rulings 4, 13).

    Raises `GeometryRefusal` carrying the distances when no frame is accepted.
    """
    idx = [
        i for i, c in enumerate(eset.contacts) if is_cortical(c.type) and not c.missing_coordinates
    ]
    if len(idx) < MIN_CONTACTS:
        raise GeometryRefusal(
            "too-few-cortical-contacts",
            f"{len(idx)} cortical contacts with x, y, z (need {MIN_CONTACTS})",
        )
    hemis = [eset.contacts[i].hemisphere for i in idx]
    result = fit_with_offset(eset.xyz_mm[idx], surfaces, "ecog", c_ras, hemis)
    detail = _fmt_offset(result)
    if result.preferred is None:
        raise GeometryRefusal(
            "frame-not-found", f"neither frame fits the subject surface: {detail}"
        )
    if result.preferred == "ambiguous":
        raise GeometryRefusal("frame-ambiguous", detail)
    chosen = result.with_c_ras if result.preferred == "c_ras" else result.as_declared
    assert chosen is not None and chosen.grade == "specific"
    return FrameDecision(
        frame="scanner" if result.preferred == "c_ras" else "tkr",
        choice=result.preferred,
        grade=chosen.grade,
        c_ras=c_ras,
        fit=result,
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
    pial_distance_median_mm: float
    pial_distance_max_mm: float
    left_out: dict[str, int] = field(default_factory=dict)


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
    # contacts of the source file that were not placed, by reason (see the LEFT_* names)
    left_out: dict[str, int] = field(default_factory=dict)
    outputs: list[OutputFile] = field(default_factory=list)
    refusals: list[Refusal] = field(default_factory=list)
    skipped: list[Refusal] = field(default_factory=list)


def _template_of(value: str | None) -> str | None:
    if not value:
        return None
    return _TEMPLATE_KEYS.get(value.strip().lower())


def _declared_template(item: Discovered) -> str | None:
    label = _template_of(item.space)
    if label or item.coordsystem_path is None:
        return label
    try:
        doc = json.loads(item.coordsystem_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    frame = doc.get("iEEGCoordinateSystem") if isinstance(doc, dict) else None
    return _template_of(frame) if isinstance(frame, str) else None


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


def map_to_fsaverage6(
    tkr: np.ndarray, subject: SubjectDir, surfaces: dict[str, Surface]
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Surface method for contacts in tkr RAS.

    Returns, per contact: whether it is mapped, the fsaverage6 position (NaN when not mapped),
    the distance to the subject's pial surface, and whether the contact is within 3.0 mm but its
    nearest hemisphere lacks `sphere.reg`. Path: nearest subject pial vertex, its `sphere.reg`
    position, the nearest fsaverage6 sphere vertex, that vertex's fsaverage6 pial position.
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
    no_sphere = np.zeros(n, dtype=bool)
    out = np.full((n, 3), np.nan)
    for hemi in surfaces:
        sel = (best_hemi == hemi) & (best <= SURFACE_MAX_MM)
        if not sel.any():
            continue
        path = subject.sphere_reg.get(hemi)
        if path is None:
            no_sphere[sel] = True
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
    return mapped, out, best, no_sphere


def _coordsystem(description: str) -> dict[str, str]:
    return {
        "iEEGCoordinateSystem": LABEL,
        "iEEGCoordinateUnits": "mm",
        "iEEGCoordinateSystemDescription": (
            "FreeSurfer fsaverage template (the fsaverage6 vertex set, pial surface)"
        ),
        "iEEGCoordinateProcessingDescription": description,
        "iEEGCoordinateProcessingReference": METHOD_REFERENCE,
    }


def left_out_text(left_out: dict[str, int]) -> str:
    parts = [f"{n} {_LEFT_TEXT[k]}" for k, n in left_out.items() if n]
    return "; ".join(parts) if parts else "none"


def _describe(
    source: Path,
    inputs: list[Path],
    dataset: Path,
    decision: FrameDecision,
    verification: Fit,
    n: int,
    pial: tuple[float, float],
    left_out: dict[str, int],
) -> str:
    rel = ", ".join(sorted(_rel(p, dataset) for p in inputs))
    frame = (
        "electrodes taken as scanner RAS (the surface c_ras offset removed)"
        if decision.frame == "scanner"
        else "electrodes taken as the subject's surface (tkr) RAS as declared"
    )
    return (
        f"Computed by NEMAR (ieeg_geometry {pipeline_version()}) from {_rel(source, dataset)}, "
        f"{n} cortical contacts, frame check: {frame}, {decision.grade} evidence from "
        f"cortical contacts; method: each contact within {SURFACE_MAX_MM:.1f} mm of the subject "
        f"pial surface (median {pial[0]:.2f} mm, maximum {pial[1]:.2f} mm) was moved to the "
        "fsaverage6 vertex that the subject's FreeSurfer sphere.reg registration assigns to its "
        "nearest pial vertex, so positions sit on fsaverage6 vertices and are surface-based; "
        f"inputs: {rel}; verified against fsaverage: median {verification.median_mm:.2f} mm, "
        f"90th percentile {verification.p90_mm:.2f} mm, {verification.grade} "
        f"({verification.rule}); contacts of the source file not placed: "
        f"{left_out_text(left_out)}."
    )


def _rel(path: Path, dataset: Path) -> str:
    try:
        return path.relative_to(dataset).as_posix()
    except ValueError:
        return path.as_posix()


def _count_left_out(eset: ElectrodeSet) -> dict[str, int]:
    """Counts for a refused file: nothing was placed, so every contact is left out."""
    missing = sum(c.missing_coordinates for c in eset.contacts)
    depth = sum(not c.missing_coordinates and not is_cortical(c.type) for c in eset.contacts)
    cortical = len(eset.contacts) - missing - depth
    counts = {LEFT_MISSING: missing, LEFT_DEPTH: depth, LEFT_FAR: cortical}
    return {k: v for k, v in counts.items() if v}


def compute_subject(dataset: Path, item: Discovered, *, existing_labels: set[str]) -> SubjectResult:
    """Everything B1 computes for one electrodes file; nothing is written.

    `existing_labels` are the template labels the authors already ship for this subject and
    session (their files win, plan item 4).
    """
    result = SubjectResult(item.subject, item.session, item.electrodes_path)
    if _declared_template(item) is not None:
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
    if LABEL in existing_labels:
        result.skipped.append(Refusal(LABEL, "authors-file", f"the authors ship space-{LABEL}"))
        return result
    try:
        surfaces = {h: read_freesurfer(p) for h, p in subject.pial.items()}
        c_ras = next((s.c_ras for s in surfaces.values() if s.c_ras is not None), None)
        if c_ras is None:
            raise GeometryRefusal("c-ras-missing", "the pial surface footer has no c_ras")
        decision = decide_frame(eset, list(surfaces.values()), c_ras)
    except GeometryRefusal as exc:
        result.refusals.append(Refusal("file", exc.reason, exc.message))
        result.left_out = _count_left_out(eset)
        return result
    result.frame = decision

    xyz = eset.xyz_mm
    finite = np.isfinite(xyz).all(axis=1)
    cortical = finite & np.array([is_cortical(c.type) for c in eset.contacts], dtype=bool)
    tkr = xyz if decision.frame == "tkr" else xyz - np.asarray(c_ras)
    left = {
        LEFT_MISSING: int((~finite).sum()),
        LEFT_DEPTH: int((finite & ~cortical).sum()),
        LEFT_FAR: 0,
        LEFT_NO_SPHERE: 0,
    }
    positions = np.full_like(xyz, np.nan)
    pial_dist = np.full(len(xyz), np.nan)
    mapped = np.zeros(len(xyz), dtype=bool)
    try:
        m, p, d, no_sphere = map_to_fsaverage6(tkr[cortical], subject, surfaces)
    except GeometryRefusal as exc:
        left[LEFT_FAR] = int(cortical.sum())
        result.left_out = {k: v for k, v in left.items() if v}
        result.refusals.append(Refusal(LABEL, exc.reason, exc.message))
        return result
    mapped[cortical], positions[cortical], pial_dist[cortical] = m, p, d
    left[LEFT_NO_SPHERE] = int(no_sphere.sum())
    left[LEFT_FAR] = int((~m & ~no_sphere).sum())
    result.left_out = {k: v for k, v in left.items() if v}
    result.n_surface = int(mapped.sum())
    idx = np.flatnonzero(mapped)
    if not len(idx):
        result.refusals.append(
            Refusal(LABEL, "no-contacts-placed", f"left out: {left_out_text(result.left_out)}")
        )
        return result
    verification = fit(positions[idx], load_reference("fsaverage"), "ecog")
    if not verification.passed:
        result.refusals.append(
            Refusal(
                LABEL,
                "verification-failed",
                f"{len(idx)} contacts, median {verification.median_mm:.2f} mm, {verification.rule}",
            )
        )
        return result
    header, raw = _read_raw(item.electrodes_path)
    inputs = [item.electrodes_path] + [p for p in (item.coordsystem_path,) if p is not None]
    inputs += list(subject.pial.values()) + list(subject.sphere_reg.values())
    pial = (float(np.median(pial_dist[idx])), float(np.max(pial_dist[idx])))
    prefix = _output_prefix(item.electrodes_path, LABEL)
    folder = item.electrodes_path.parent
    result.outputs.append(
        OutputFile(
            label=LABEL,
            method=METHOD,
            electrodes_path=folder / f"{prefix}_electrodes.tsv",
            coordsystem_path=folder / f"{prefix}_coordsystem.json",
            header=header,
            rows=[raw[i] for i in idx],
            xyz=positions[idx],
            verification=verification,
            description=_describe(
                item.electrodes_path,
                inputs,
                dataset,
                decision,
                verification,
                len(idx),
                pial,
                result.left_out,
            ),
            inputs=inputs,
            pial_distance_median_mm=pial[0],
            pial_distance_max_mm=pial[1],
            left_out=dict(result.left_out),
        )
    )
    return result


def plan_dataset(dataset_dir: str | Path) -> list[SubjectResult]:
    """B1's results for every electrodes file of a dataset checkout. Nothing is written."""
    dataset = Path(dataset_dir)
    items = discover(dataset)
    owned = set()
    ownership = read_ownership(dataset)
    if ownership is not None:
        owned = {e.path for e in ownership.entries}
    # the pipeline's own earlier output is regenerated, not taken as the authors' file
    items = [i for i in items if _rel(i.electrodes_path, dataset) not in owned]
    labels: dict[tuple[str, str | None], set[str]] = {}
    for item in items:
        label = _declared_template(item)
        if label:
            labels.setdefault((item.subject, item.session), set()).add(label)
    results = [
        compute_subject(
            dataset, item, existing_labels=labels.get((item.subject, item.session), set())
        )
        for item in items
    ]
    return _resolve_duplicates(results)


def _resolve_duplicates(results: list[SubjectResult]) -> list[SubjectResult]:
    """Two input files that map to the same output path: keep the one that verified best."""
    best: dict[Path, tuple[float, OutputFile]] = {}
    for res in results:
        for out in res.outputs:
            score = out.verification.median_mm
            if out.electrodes_path not in best or score < best[out.electrodes_path][0]:
                best[out.electrodes_path] = (score, out)
    for res in results:
        kept = []
        for out in res.outputs:
            if best[out.electrodes_path][1] is out:
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
    doc = _coordsystem(out.description)
    return (json.dumps(doc, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def write_outputs(dataset_dir: str | Path, results: list[SubjectResult]) -> list[OwnedPath]:
    """Write every verified output file and record it in `.nemar/ieeg-geometry.json`.

    The existing ownership file is read and merged: only entries for the paths written here
    are replaced, other tracks' entries survive. Output bytes are deterministic, so a rerun on
    unchanged inputs rewrites identical files. The ownership verification names the contacts
    left out and why. Returns the entries this call wrote.
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
            verification = replace(
                verification,
                rule=f"{verification.rule}; left out: {left_out_text(out.left_out)}",
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
        lines.append(f"{label}: {_rel(res.source, dataset)} [freesurfer surface registration]")
        for s in res.skipped:
            lines.append(f"  skipped ({s.scope}): {s.reason}, {s.message}")
        if res.subject_dir is not None:
            lines.append(f"  subject directory {_rel(res.subject_dir, dataset)}")
        if res.frame is not None:
            lines.append(f"  frame decision: {res.frame.describe()}")
            lines.append(f"    {_fmt_offset(res.frame.fit)}")
            lines.append(f"  placed by surface registration (fsaverage): {res.n_surface} contacts")
        if res.left_out:
            lines.append(f"  left out: {left_out_text(res.left_out)}")
        for out in res.outputs:
            v = out.verification
            lines.append(
                f"  output {out.electrodes_path.name}: {len(out.rows)} contacts, verified vs "
                f"fsaverage median {v.median_mm:.2f} mm p90 {v.p90_mm:.2f} -> {v.grade}, pial "
                f"distance median {out.pial_distance_median_mm:.2f} "
                f"max {out.pial_distance_max_mm:.2f} mm"
            )
        for r in res.refusals:
            lines.append(f"  refused ({r.scope}): {r.reason}, {r.message}")
    return lines


def inspect_dataset(dataset: Path, out=sys.stdout) -> int:
    """Print the read-only freesurfer report. Returns the number of electrodes files."""
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
