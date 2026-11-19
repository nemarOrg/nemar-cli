"""Propose a template label for electrodes files whose frame is missing, wrong or non-standard.

A proposal is accepted only when the L1 verifier agrees; nothing is written until
`write(plan, dataset_dir)` is called. Plan: `.context/plans/ieeg-geometry/plan.md`
(settled design 7 and the lead rulings, especially 16 to 18).

Candidates, in order of evidence:

1. a non-standard but recognizable `iEEGCoordinateSystem` value (spelling or case variants,
   `fsaverage6`), mapped to the valid label it names;
2. a template named in `iEEGCoordinateSystemDescription`, then in the dataset README
   (negated mentions such as "not in MNI305 space" are ignored);
3. blind trials of `fsaverage` and `MNI152NLin2009cAsym` (at least 10 contacts).

Acceptance:

- A candidate is verified against its reference surface (`MNI305`, `fsaverage` against
  fsaverage; every `MNI152*` and `IXI549Space` against MNI152NLin2009cAsym).
  A sidecar name passes on `specific` or `plausible` evidence; a name found in prose passes
  on `specific` evidence only, and `plausible` evidence from prose is "needs a human" (ruling 17).
- A named template that is not `specific` while the contacts sit on fsaverage vertices (median
  at most 1.0 mm, shift control failing) is "needs a human", for any contact type, as are two
  distinct passing labels.
- A blind candidate needs the template-vertex test: median at most 1.0 mm and every 10 mm
  shift (both directions on each axis) above 1.0 mm and at least 1.5 times the unshifted median
  (ruling 16).
- An `MNI` name with no variant, `Talairach`, and a sidecar naming a template with no reference
  surface are "needs a human"; nothing is written and no blind trial runs.
- Frames declared ACPC, ScanRAS, scanner, native or Pixels (case and separator insensitive, by
  prefix), files with a `space-` entity, and sidecars with an `IntendedFor` are never relabeled.
- A subject and session that already has an authors' template file for the same written label
  gets nothing. Files listed in `.nemar/ieeg-geometry.json` are the pipeline's, not the authors',
  so a rerun regenerates them (identical bytes, nothing rewritten).
- Candidates whose reference is fsaverage are written as `fsaverage`; the authors' own term is
  kept in `iEEGCoordinateSystemDescription` (ruling 18).

Files written: a missing sidecar is added as `<stem>_coordsystem.json`; for a sidecar that is
wrong, the original is left untouched and a `space-<label>` electrodes and coordsystem pair is
added (positions in millimeters). When no units are declared they are assumed to be millimeters
(the iEEG specification gives no default) and the processing description says the fit confirms
it. Every written path is recorded in `.nemar/ieeg-geometry.json`.
"""

from __future__ import annotations

import csv
import io
import json
import os
import re
import unicodedata
from dataclasses import dataclass, replace
from functools import cache
from importlib import metadata
from pathlib import Path

import numpy as np
from scipy.spatial import KDTree

from .bids import (
    UNKNOWN,
    Discovered,
    ElectrodeSet,
    GeometryRefusal,
    discover,
    read_electrode_set,
)
from .ownership import OwnedPath, Verification, blob_id, read_ownership, write_ownership
from .reference import load_reference
from .surfaces import Surface
from .verify import FAIL, PLAUSIBLE, SPECIFIC, TEMPLATE_VERTEX_MM, Fit, fit

METHOD_URL = "https://docs.nemar.org/data/ieeg-geometry/"
# Valid `iEEGCoordinateSystem` template labels: BIDS specification, appendix "Coordinate
# Systems", "Standard template identifiers" (src/appendices/coordinate-systems.md, master,
# read 2026-11-19, https://bids-specification.readthedocs.io/en/stable/appendices/coordinate-systems.html).
TEMPLATE_LABELS = frozenset(
    {
        "ICBM452AirSpace",
        "ICBM452Warp5Space",
        "IXI549Space",
        "fsaverage",
        "fsaverageSym",
        "fsLR",
        "MNIColin27",
        "MNI152Lin",
        *(f"MNI152NLin2009{v}{s}" for v in "abc" for s in ("Sym", "Asym")),
        "MNI152NLin6Sym",
        "MNI152NLin6ASym",
        "MNI305",
        "NIHPD",
        "OASIS30AntsOASISAnts",
        "OASIS30Atropos",
        "Talairach",
        "UNCInfant",
    }
)
# Deprecated spellings the same appendix maps to a recommended label.
DEPRECATED_LABELS = {f"fsaverage{n}": "fsaverage" for n in "3456"}
# Canonical (lowercase alphanumeric) prefixes of frames that name the subject's own space or an
# image plane: never relabeled.
NEVER_RELABEL_PREFIXES = ("acpc", "scanras", "scanner", "native", "pixels")
MNI_UNKNOWN = "MNI variant unknown, needs a human label"
MIN_CONTACTS = 3
MIN_BLIND_CONTACTS = 10
SHIFT_MM = 10.0
SHIFT_RATIO = 1.5

ACCEPTED = "accepted"
REJECTED = "rejected"
NEEDS_HUMAN = "needs-human"
SKIPPED = "skipped"
ALREADY = "already-labeled"

_GRADE_ORDER = {SPECIFIC: 0, PLAUSIBLE: 1, FAIL: 2}


def pipeline_version() -> str:
    """The installed package version (raises when the package is not installed)."""
    return metadata.version("ieeg-geometry")


@cache
def _reference(name: str) -> tuple[Surface, ...]:
    return tuple(load_reference(name))


@cache
def _tree(name: str) -> KDTree:
    return KDTree(np.vstack([s.vertices for s in _reference(name)]))


def reference_for(label: str) -> str | None:
    """The vendored surface a template label is verified against, or None when there is none."""
    if label in ("MNI305", "fsaverage"):
        return "fsaverage"
    if label.startswith("MNI152") or label == "IXI549Space":
        return "MNI152NLin2009cAsym"
    return None


def written_label(label: str) -> str:
    """The label written for a verified candidate: fsaverage-reference names become fsaverage."""
    return "fsaverage" if reference_for(label) == "fsaverage" else label


# --- recognizing template names -------------------------------------------------------------

_DASHES = dict.fromkeys(map(ord, "‐‑‒–—―−"), "-")


def _normalize(text: str) -> str:
    """NFKC (full-width forms), no soft hyphens, every dash a plain hyphen."""
    return unicodedata.normalize("NFKC", text).replace("­", "").translate(_DASHES)


def _canon(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", _normalize(text).lower())


_CANON_LABELS = {_canon(label): label for label in TEMPLATE_LABELS} | {
    _canon(old): new for old, new in DEPRECATED_LABELS.items()
}
_S = r"[\s_\-]*"
_NAMED = [
    (re.compile(rf"\bMNI{_S}305\b", re.I), lambda m: "MNI305"),
    (
        re.compile(rf"\bfsaverage[3-6]?(?![A-Za-z0-9_]|{_S}sym)", re.I),
        lambda m: "fsaverage",
    ),
    (
        re.compile(rf"\bMNI{_S}152{_S}NLin{_S}2009{_S}([abc]){_S}(A?Sym)\b", re.I),
        lambda m: f"MNI152NLin2009{m[1].lower()}{m[2].capitalize()}",
    ),
    (
        re.compile(rf"\bMNI{_S}152{_S}NLin{_S}6{_S}(A?Sym)\b", re.I),
        lambda m: "MNI152NLin6ASym" if m[1].lower() == "asym" else "MNI152NLin6Sym",
    ),
    (re.compile(rf"\bMNI{_S}152{_S}Lin\b", re.I), lambda m: "MNI152Lin"),
    (re.compile(r"\bIXI[\s_\-]*549(?:[\s_\-]*Space)?\b", re.I), lambda m: "IXI549Space"),
    (re.compile(rf"\bMNI{_S}Colin{_S}27\b", re.I), lambda m: "MNIColin27"),
    (re.compile(r"\bTalairach\b", re.I), lambda m: "Talairach"),
]
_GENERIC_MNI = re.compile(rf"\b(?:MNI(?:{_S}152)?|ICBM(?:{_S}152)?)\b", re.I)
_NEGATION = re.compile(
    r"\b(?:not|never|no|without|neither|nor|instead of|rather than|other than)\b|n't\b", re.I
)


@dataclass(frozen=True)
class Named:
    """A template name found in text: `label` is a valid template label; `text` the words."""

    label: str
    text: str


def classify_frame_value(value: str) -> Named | str | None:
    """A sidecar `iEEGCoordinateSystem` value as a `Named` label, `"mni-unknown"`, or None."""
    canon = _canon(value)
    if canon in _CANON_LABELS:
        return Named(_CANON_LABELS[canon], value)
    if canon.startswith(("mni", "icbm")):
        return "mni-unknown"
    return None


def _negated(text: str, start: int) -> bool:
    """Whether the sentence before `start` negates the mention."""
    before = text[max(0, start - 80) : start]
    sentence = re.split(r"[.!?;\n]", before)[-1]
    return bool(_NEGATION.search(sentence))


def scan_prose(text: str) -> tuple[list[Named], bool]:
    """Template names in prose, in order of appearance, and whether an unspecific `MNI` appears.

    Mentions in a negated clause ("not in MNI305 space") are ignored. Non-breaking and soft
    hyphens and full-width forms are normalized first.
    """
    text = _normalize(text)
    found: list[tuple[int, Named]] = []
    blanked = text
    for pattern, to_label in _NAMED:
        for m in pattern.finditer(text):
            blanked = blanked[: m.start()] + " " * (m.end() - m.start()) + blanked[m.end() :]
            if not _negated(text, m.start()):
                found.append((m.start(), Named(to_label(m), m.group(0))))
    named: list[Named] = []
    for _, item in sorted(found, key=lambda p: p[0]):
        if all(item.label != n.label for n in named):
            named.append(item)
    generic = any(not _negated(blanked, m.start()) for m in _GENERIC_MNI.finditer(blanked))
    return named, generic


# --- verification ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Attempt:
    label: str
    source: str  # "sidecar", "description", "README" or "blind trial"
    evidence: str
    reference: str | None
    grade: str
    accepted: bool
    reason: str
    fit: Fit | None = None
    by_type: str = ""

    def line(self) -> str:
        measured = ""
        if self.fit is not None and self.fit.n_used:
            f = self.fit
            measured = f" (median {f.median_mm:.2f} mm, p90 {f.p90_mm:.2f}, n={f.n_used})"
        verdict = "accepted" if self.accepted else "rejected"
        where = f"{self.label} from {self.evidence} vs {self.reference}"
        return f"{verdict} {where}{measured}: {self.reason}"


def _fits_by_type(eset: ElectrodeSet, surfaces: tuple[Surface, ...]) -> list[tuple[str, Fit]]:
    fits = []
    for ctype in sorted({c.type for c in eset.contacts}):
        pts = eset.xyz_for(ctype)
        if np.isfinite(pts).all(axis=1).any():
            fits.append((ctype, fit(pts, list(surfaces), ctype, eset.hemispheres_for(ctype))))
    return fits


def _summarize(fits: list[tuple[str, Fit]]) -> tuple[Fit, str]:
    """The weakest type's Fit (recorded) and a per-type description (written)."""
    worst = max(fits, key=lambda t: (_GRADE_ORDER[t[1].grade], t[1].median_mm, t[1].n_used))[1]
    parts = [
        f"{t} {f.n_used} contacts (median {f.median_mm:.2f} mm, 90th percentile "
        f"{f.p90_mm:.2f} mm, {f.grade})"
        for t, f in fits
    ]
    return worst, "; ".join(parts)


def _finite_pts(eset: ElectrodeSet) -> np.ndarray:
    pts = eset.xyz_mm
    return pts[np.isfinite(pts).all(axis=1)]


def _blind_evidence(eset: ElectrodeSet, name: str) -> tuple[Fit, bool, str, str]:
    """Template-vertex test with the shift control: (fit, specific?, reason, by-type text)."""
    pts = _finite_pts(eset)
    base = fit(pts, list(_reference(name)), UNKNOWN)
    summary = (
        f"all {base.n_used} contacts pooled (median {base.median_mm:.2f} mm, "
        f"90th percentile {base.p90_mm:.2f} mm)"
    )
    if base.median_mm > TEMPLATE_VERTEX_MM or base.grade != SPECIFIC:
        return base, False, f"median {base.median_mm:.2f} mm is not on template vertices", summary
    tree = _tree(name)
    medians = []
    for axis in range(3):
        for sign in (-1.0, 1.0):
            delta = np.zeros(3)
            delta[axis] = sign * SHIFT_MM
            medians.append(float(np.median(tree.query(pts + delta)[0])))
    if any(m <= TEMPLATE_VERTEX_MM or m < SHIFT_RATIO * base.median_mm for m in medians):
        return (
            base,
            False,
            f"a 10 mm shift still fits (shifted medians down to {min(medians):.2f} mm)",
            summary,
        )
    reason = (
        f"median {base.median_mm:.2f} mm; every 10 mm shift fails (nearest {min(medians):.1f} mm)"
    )
    return base, True, reason, summary


# --- plan objects ----------------------------------------------------------------------------


@dataclass(frozen=True)
class PlannedFile:
    path: str  # relative to the dataset
    content: bytes
    kind: str
    inputs: tuple[tuple[str, str], ...]
    method: str
    verification: Verification

    @property
    def entry(self) -> OwnedPath:
        return OwnedPath(self.path, self.kind, self.inputs, self.method, self.verification)


@dataclass(frozen=True)
class Proposal:
    electrodes: str  # relative to the dataset
    subject: str
    session: str | None
    declared_frame: str | None
    status: str
    reason: str
    label: str | None = None
    attempts: tuple[Attempt, ...] = ()
    files: tuple[PlannedFile, ...] = ()

    def lines(self) -> list[str]:
        head = f"label: {self.status}"
        if self.label:
            head += f" {self.label}"
        out = [f"{head} ({self.reason})"]
        out += [f"    {a.line()}" for a in self.attempts]
        out += [f"    would write {f.path}" for f in self.files]
        return out


@dataclass(frozen=True)
class Plan:
    dataset: str
    pipeline_version: str
    proposals: tuple[Proposal, ...]

    @property
    def files(self) -> list[PlannedFile]:
        return sorted((f for p in self.proposals for f in p.files), key=lambda f: f.path)


def read_readme(dataset: Path) -> str:
    """The dataset README text (empty when there is none or its content is not present)."""
    for name in ("README.md", "README", "README.txt", "README.rst"):
        path = dataset / name
        try:
            if path.is_file():
                return path.read_text(encoding="utf-8", errors="replace")[:200_000]
        except OSError:
            continue
    return ""


def _sidecar(path: Path | None) -> dict:
    if path is None:
        return {}
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return doc if isinstance(doc, dict) else {}


def _prefix(path: Path) -> str:
    return path.name[: -len("_electrodes.tsv")]


def _tsv_in_mm(path: Path, scale: float) -> bytes:
    raw = path.read_bytes()
    if scale == 1.0:
        return raw
    rows = [r for r in csv.reader(io.StringIO(raw.decode("utf-8-sig")), delimiter="\t") if r]
    idx = [rows[0].index(a) for a in ("x", "y", "z")]
    for row in rows[1:]:
        for i in idx:
            if row[i].strip().lower() not in ("", "n/a", "na", "nan"):
                row[i] = f"{float(row[i]) * scale:.6f}".rstrip("0").rstrip(".")
    out = io.StringIO()
    csv.writer(out, delimiter="\t", lineterminator="\n").writerows(rows)
    return out.getvalue().encode("utf-8")


def _coordsystem_bytes(label: str, system_description: str, description: str) -> bytes:
    doc = {
        "iEEGCoordinateSystem": label,
        "iEEGCoordinateSystemDescription": system_description,
        "iEEGCoordinateUnits": "mm",
        "iEEGCoordinateProcessingDescription": description,
        "iEEGCoordinateProcessingReference": METHOD_URL,
    }
    return (json.dumps(doc, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def _texts(
    attempt: Attempt, src: str, version: str, copied: bool, assumed: bool
) -> tuple[str, str]:
    f = attempt.fit
    assert f is not None
    label = written_label(attempt.label)
    if attempt.source == "blind trial":
        system = (
            f"{label} template space. The authors named no template; the frame was found by "
            "geometric verification."
        )
    else:
        system = f"{label} template space. Authors' term: {attempt.evidence}."
    action = (
        f"positions copied from {src} in millimeters and labeled"
        if copied
        else f"coordinate frame of {src} labeled"
    )
    desc = (
        f"Computed by NEMAR (ieeg-geometry {version}): {action} {label}; evidence: "
        f"{attempt.evidence}; contacts: {attempt.by_type}; reference surface: "
        f"{attempt.reference}; grade {attempt.grade}; source file {src}."
    )
    if assumed:
        desc += " Units assumed mm, confirmed by the fit."
    return system, desc


def _build_files(
    dataset: Path, item: Discovered, eset: ElectrodeSet, attempt: Attempt, version: str
) -> tuple[PlannedFile, ...]:
    assert attempt.fit is not None and attempt.reference is not None
    label = written_label(attempt.label)

    def rel(p: Path) -> str:
        return p.relative_to(dataset).as_posix()

    src = rel(item.electrodes_path)
    verification = Verification.from_fit(attempt.fit, attempt.reference)
    method = f"label-inference:{attempt.source}"
    elec_in = ((src, blob_id(item.electrodes_path)),)
    prefix = _prefix(item.electrodes_path)
    folder = item.electrodes_path.parent
    if item.coordsystem_path is None:
        system, desc = _texts(attempt, src, version, copied=False, assumed=eset.units_assumed)
        target = folder / f"{prefix}_coordsystem.json"
        data = _coordsystem_bytes(label, system, desc)
        return (PlannedFile(rel(target), data, "coordsystem", elec_in, method, verification),)
    system, desc = _texts(attempt, src, version, copied=True, assumed=eset.units_assumed)
    elec_target = folder / f"{prefix}_space-{label}_electrodes.tsv"
    coord_target = folder / f"{prefix}_space-{label}_coordsystem.json"
    coord_in = tuple(
        sorted(elec_in + ((rel(item.coordsystem_path), blob_id(item.coordsystem_path)),))
    )
    return (
        PlannedFile(
            rel(elec_target),
            _tsv_in_mm(item.electrodes_path, eset.scale_to_mm),
            "electrodes",
            elec_in,
            method,
            verification,
        ),
        PlannedFile(
            rel(coord_target),
            _coordsystem_bytes(label, system, desc),
            "coordsystem",
            coord_in,
            method,
            verification,
        ),
    )


# --- the decision ----------------------------------------------------------------------------


def _template_label_of(sibling: Discovered) -> str | None:
    """The written template label an authors' file is in, from its space entity or sidecar."""
    value = sibling.space
    if value is None:
        frame = _sidecar(sibling.coordsystem_path).get("iEEGCoordinateSystem")
        value = frame if isinstance(frame, str) else None
    if value is None:
        return None
    hit = classify_frame_value(value)
    return written_label(hit.label) if isinstance(hit, Named) else None


def _unchanged(f: PlannedFile, dataset: Path, owned: dict[str, OwnedPath]) -> bool:
    target = dataset / f.path
    return (
        target.is_file()
        and not target.is_symlink()
        and owned.get(f.path) == f.entry
        and target.read_bytes() == f.content
    )


def propose(
    dataset_dir: str | Path,
    item: Discovered,
    readme: str | None = None,
    *,
    siblings: tuple[Discovered, ...] = (),
    owned: dict[str, OwnedPath] | None = None,
) -> Proposal:
    """The proposal for one electrodes file. Reads only; writes nothing.

    `siblings` are every discovered electrodes file of the dataset (authors' files that already
    sit in a template space block a duplicate); `owned` maps the pipeline-owned paths to their
    entries (these are not the authors' files, and are regenerated).
    """
    dataset = Path(dataset_dir)
    own: dict[str, OwnedPath] = owned or {}

    def rel(p: Path) -> str:
        return p.relative_to(dataset).as_posix()

    relpath = rel(item.electrodes_path)
    prefix = _prefix(item.electrodes_path)
    folder = item.electrodes_path.parent
    coord_target = folder / f"{prefix}_coordsystem.json"
    if item.coordsystem_path is not None and rel(item.coordsystem_path) in own:
        item = replace(item, coordsystem_path=None)  # the pipeline's own sidecar: regenerate
    sidecar = _sidecar(item.coordsystem_path)
    frame = sidecar.get("iEEGCoordinateSystem")
    frame = frame if isinstance(frame, str) else None

    def done(status: str, reason: str, **kw) -> Proposal:
        return Proposal(relpath, item.subject, item.session, frame, status, reason, **kw)

    if item.space is not None:
        return done(SKIPPED, f"the file names its frame in space-{item.space}")
    if (
        item.coordsystem_path is None
        and os.path.lexists(coord_target)
        and rel(coord_target) not in own
    ):
        return done(SKIPPED, "the coordsystem is a link whose content is not present")
    if sidecar.get("IntendedFor"):
        return done(SKIPPED, "the coordsystem has an IntendedFor naming the subject's own image")
    if frame is not None and _canon(frame).startswith(NEVER_RELABEL_PREFIXES):
        return done(SKIPPED, f"declared {frame!r}, never relabeled")
    if frame in TEMPLATE_LABELS:
        return done(ALREADY, f"declared {frame}, a valid template label")

    try:
        eset = read_electrode_set(item, assume_units="mm")
    except GeometryRefusal as exc:
        return done(SKIPPED, f"unreadable: {exc.reason}")
    except (OSError, UnicodeDecodeError, csv.Error, ValueError, KeyError) as exc:
        return done(SKIPPED, f"unreadable: {type(exc).__name__}: {exc}")
    n_finite = len(_finite_pts(eset))
    if n_finite < MIN_CONTACTS:
        return done(SKIPPED, f"fewer than {MIN_CONTACTS} contacts with coordinates")

    candidates: list[tuple[Named, str, str]] = []  # (name, source, where)
    unknown_mni = talairach = False
    no_reference_in_sidecar: str | None = None

    def add(named: Named, source: str, where: str) -> None:
        nonlocal talairach
        if named.label == "Talairach":
            talairach = True
        elif all(named.label != c[0].label for c in candidates):
            candidates.append((named, source, where))

    if frame:
        hit = classify_frame_value(frame)
        if isinstance(hit, Named):
            if hit.label == "Talairach":
                talairach = True
            elif reference_for(hit.label) is None:
                no_reference_in_sidecar = hit.label
            else:
                add(hit, "sidecar", "iEEGCoordinateSystem")
        elif hit == "mni-unknown":
            unknown_mni = True
    for source, where, text in (
        (
            "description",
            "iEEGCoordinateSystemDescription",
            str(sidecar.get("iEEGCoordinateSystemDescription") or ""),
        ),
        ("README", "README", read_readme(dataset) if readme is None else readme),
    ):
        names, generic = scan_prose(text)
        unknown_mni = unknown_mni or generic
        for n in names:
            add(n, source, where)

    if no_reference_in_sidecar:
        return done(
            NEEDS_HUMAN,
            f"the sidecar names {no_reference_in_sidecar}, which cannot be verified here",
        )

    attempts: list[Attempt] = []
    version = pipeline_version()
    fs_blind: tuple[Fit, bool, str, str] | None = None

    def fsaverage_blind() -> tuple[Fit, bool, str, str]:
        nonlocal fs_blind
        fs_blind = fs_blind or _blind_evidence(eset, "fsaverage")
        return fs_blind

    def authors_have(label: str) -> bool:
        """An authors' file for this subject and session already sits in `label`'s space."""
        target = folder / f"{prefix}_space-{label}_electrodes.tsv"
        if os.path.lexists(target) and rel(target) not in own:
            return True
        return any(
            sib.electrodes_path != item.electrodes_path
            and sib.subject == item.subject
            and sib.session == item.session
            and rel(sib.electrodes_path) not in own
            and _template_label_of(sib) == label
            for sib in siblings
        )

    passing: list[Attempt] = []
    for named, source, where in candidates:
        ref = reference_for(named.label)
        evidence = f"{where} {named.text!r}"
        if ref is None:  # only prose gets here: the sidecar case returned above
            attempts.append(
                Attempt(
                    named.label,
                    source,
                    evidence,
                    None,
                    FAIL,
                    False,
                    "no reference surface to verify against",
                )
            )
            continue
        f, by_type = _summarize(_fits_by_type(eset, _reference(ref)))
        grade = f.grade
        if (
            ref != "fsaverage"
            and grade != SPECIFIC
            and n_finite >= MIN_BLIND_CONTACTS
            and fsaverage_blind()[1]
        ):
            attempts.append(
                Attempt(
                    named.label,
                    source,
                    evidence,
                    ref,
                    grade,
                    False,
                    "contacts sit on fsaverage vertices, not on this template",
                    f,
                    by_type,
                )
            )
            return done(
                NEEDS_HUMAN,
                f"{named.label} is named but the contacts sit on fsaverage vertices",
                attempts=tuple(attempts),
            )
        ok = grade != FAIL
        reason = f"{grade} evidence" if ok else "fit failed"
        attempt = Attempt(named.label, source, evidence, ref, grade, ok, reason, f, by_type)
        attempts.append(attempt)
        if ok:
            passing.append(attempt)

    if len({written_label(a.label) for a in passing}) > 1:
        return done(
            NEEDS_HUMAN,
            "two distinct template labels are named and pass: "
            + ", ".join(sorted({written_label(a.label) for a in passing})),
            attempts=tuple(attempts),
        )
    if passing:
        best = min(passing, key=lambda a: (_GRADE_ORDER[a.grade], a.source != "sidecar"))
        if best.source != "sidecar" and best.grade != SPECIFIC:
            return done(
                NEEDS_HUMAN,
                "a template named only in prose has plausible evidence, not specific",
                attempts=tuple(attempts),
            )
        label = written_label(best.label)
        if authors_have(label):
            return done(
                ALREADY,
                f"an authors' {label} file exists for this subject and session",
                label=label,
                attempts=tuple(attempts),
            )
        return _accept(done, dataset, item, eset, best, attempts, version, own)

    if unknown_mni or talairach:
        reason = MNI_UNKNOWN if unknown_mni else "Talairach is never written"
        return done(NEEDS_HUMAN, reason, attempts=tuple(attempts))
    if n_finite < MIN_BLIND_CONTACTS:
        return done(
            REJECTED,
            f"no template named and fewer than {MIN_BLIND_CONTACTS} contacts for a blind trial",
            attempts=tuple(attempts),
        )

    for ref_name in ("fsaverage", "MNI152NLin2009cAsym"):
        f, specific, why, by_type = (
            fsaverage_blind() if ref_name == "fsaverage" else _blind_evidence(eset, ref_name)
        )
        attempt = Attempt(
            ref_name, "blind trial", "blind trial", ref_name,
            SPECIFIC if specific else FAIL, specific, why, f, by_type,
        )  # fmt: skip
        attempts.append(attempt)
        if specific:
            label = written_label(ref_name)
            if authors_have(label):
                return done(
                    ALREADY,
                    f"an authors' {label} file exists for this subject and session",
                    label=label,
                    attempts=tuple(attempts),
                )
            return _accept(done, dataset, item, eset, attempt, attempts, version, own)
    return done(REJECTED, "no candidate verified", attempts=tuple(attempts))


def _accept(done, dataset, item, eset, attempt, attempts, version, owned) -> Proposal:
    label = written_label(attempt.label)
    try:
        files = _build_files(dataset, item, eset, attempt, version)
    except (OSError, UnicodeDecodeError, csv.Error, ValueError, IndexError) as exc:
        return done(SKIPPED, f"cannot copy positions: {type(exc).__name__}: {exc}")
    if all(_unchanged(f, dataset, owned) for f in files):
        return done(ALREADY, "pipeline output unchanged", label=label, attempts=tuple(attempts))
    return done(ACCEPTED, attempt.evidence, label=label, attempts=tuple(attempts), files=files)


def plan_dataset(dataset_dir: str | Path) -> Plan:
    """Proposals for every electrodes file of a dataset checkout. Reads only."""
    dataset = Path(dataset_dir)
    readme = read_readme(dataset)
    items = tuple(discover(dataset))
    ownership = read_ownership(dataset)
    owned = {e.path: e for e in ownership.entries} if ownership else {}
    proposals = tuple(propose(dataset, item, readme, siblings=items, owned=owned) for item in items)
    return Plan(str(dataset), pipeline_version(), proposals)


def write(plan: Plan, dataset_dir: str | Path) -> list[Path]:
    """Write the plan's files and record them in `.nemar/ieeg-geometry.json`.

    Conflicts are checked before anything is written: a path that exists with different bytes
    and is not in the ownership record, or that is a symbolic link (an annexed file), refuses the
    whole write. Ownership is written before the files, so a partial write never leaves a file
    unrecorded. Entries for rewritten paths are replaced. A plan whose files all exist unchanged
    and recorded touches nothing, so a second run on its own output changes no byte.
    """
    dataset = Path(dataset_dir)
    existing = read_ownership(dataset)
    entries = {e.path: e for e in existing.entries} if existing else {}
    to_write: list[PlannedFile] = []
    to_record: list[PlannedFile] = []
    for f in plan.files:
        target = dataset / f.path
        if os.path.lexists(target):
            if target.is_symlink():
                raise GeometryRefusal(
                    "write-conflict", f"{f.path} is a link; never written through"
                )
            same = target.read_bytes() == f.content
            if not same and f.path not in entries:
                raise GeometryRefusal("write-conflict", f"{f.path} exists with different content")
            if not same:
                to_write.append(f)
            if entries.get(f.path) != f.entry:
                to_record.append(f)
            continue
        to_write.append(f)
        to_record.append(f)
    if not to_write and not to_record:
        return []
    for f in to_record:
        entries[f.path] = f.entry
    write_ownership(dataset, plan.pipeline_version, list(entries.values()))
    written = []
    for f in to_write:
        target = dataset / f.path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(f.content)
        written.append(target)
    return written
