"""Propose a template label for electrodes files whose frame is missing, wrong or non-standard.

A proposal is accepted only when the L1 verifier (`verify.fit`) agrees; nothing is written
until `write(plan, dataset_dir)` is called. Plan: `.context/plans/ieeg-geometry/plan.md`.

Candidates, in order of evidence:

1. a non-standard but recognizable `iEEGCoordinateSystem` value (`MNI305`-like spellings,
   `fsaverage6`, case or separator variants), mapped to the valid label it names;
2. a template named in `iEEGCoordinateSystemDescription`, then in the dataset README;
3. blind trials of `fsaverage` and `MNI152NLin2009cAsym`.

Acceptance (lead rulings of 2026-11-19):

- Named candidates (1, 2) are accepted on `specific` or `plausible` evidence against the
  candidate's reference surface (`MNI305` and `fsaverage` against fsaverage; every `MNI152*`
  and `IXI549Space` against MNI152NLin2009cAsym), because the name is independent evidence.
  An `MNI152*` name is refused when the contacts sit on fsaverage vertices instead.
- A blind candidate (3) needs `specific` evidence: median at most 1.0 mm against the vendored
  fsaverage6 (contacts on full-resolution fsaverage vertices measure about 0.7 mm) and the
  same contacts shifted 10 mm along each axis, in both directions, all failing the ECoG rule.
- An `MNI` name with no variant is never written ("MNI variant unknown, needs a human
  label"); `Talairach` is never written; frames declared `ACPC`, `ScanRAS` or `Pixels`, files
  with a `space-` entity, and sidecars with an `IntendedFor` are never relabeled.
- Candidates whose reference is fsaverage (`MNI305`, `fsaverage`, `fsaverage3` to `6`) are
  written as `fsaverage`, the surface the contacts were measured against; the authors' name is
  kept in the evidence text.
- A subject whose `space-<label>` electrodes file exists already gets nothing.

Files written: a missing sidecar is added as `<stem>_coordsystem.json`; for a sidecar that is
wrong, the original is left untouched and a `space-<label>` electrodes and coordsystem pair is
added (positions in millimeters). Units of a file without a coordsystem are taken as millimeters
(the BIDS default); the geometric fit would fail otherwise. Every written path is recorded in
`.nemar/ieeg-geometry.json`.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import cache
from importlib import metadata
from pathlib import Path

import numpy as np

from .bids import (
    UNKNOWN,
    Contact,
    Discovered,
    ElectrodeSet,
    GeometryRefusal,
    _channel_types,
    _normalize_type,
    _read_tsv,
    _to_float,
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
# Frames that name the subject's own space (or an image plane): never relabeled.
NEVER_RELABEL = {"acpc": "ACPC", "scanras": "ScanRAS", "pixels": "Pixels"}
MNI_UNKNOWN = "MNI variant unknown, needs a human label"

ACCEPTED = "accepted"
REJECTED = "rejected"
NEEDS_HUMAN = "needs-human"
SKIPPED = "skipped"
ALREADY = "already-labeled"

_GRADE_ORDER = {SPECIFIC: 0, PLAUSIBLE: 1, FAIL: 2}
_SHIFT_MM = 10.0
_MIN_CONTACTS = 3


def pipeline_version() -> str:
    try:
        return metadata.version("ieeg-geometry")
    except metadata.PackageNotFoundError:  # not installed, e.g. run from a checkout
        return "0.1.0"


@cache
def _reference(name: str) -> tuple[Surface, ...]:
    return tuple(load_reference(name))


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

_CANON = re.compile(r"[^a-z0-9]+")
_CANON_LABELS = {_CANON.sub("", label.lower()): label for label in TEMPLATE_LABELS} | {
    _CANON.sub("", old): new for old, new in DEPRECATED_LABELS.items()
}
_DASHES = dict.fromkeys(map(ord, "‐‑‒–—―−"), "-")
_S = r"[\s_\-]*"
_NAMED = [
    (re.compile(rf"\bMNI{_S}305\b", re.I), lambda m: "MNI305"),
    (re.compile(r"\bfsaverage[3-6]?(?![A-Za-z0-9_])", re.I), lambda m: "fsaverage"),
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


@dataclass(frozen=True)
class Named:
    """A template name found in text: `label` is a valid template label; `text` the words."""

    label: str
    text: str


def classify_frame_value(value: str) -> Named | str | None:
    """A sidecar `iEEGCoordinateSystem` value as a `Named` label, `"mni-unknown"`, or None."""
    canon = _CANON.sub("", value.lower())
    if canon in _CANON_LABELS:
        return Named(_CANON_LABELS[canon], value)
    if canon.startswith(("mni", "icbm")):
        return "mni-unknown"
    return None


def scan_prose(text: str) -> tuple[list[Named], bool]:
    """Template names in prose, in order of appearance, and whether an unspecific `MNI` appears.

    Non-breaking hyphens (as in "MNI-305" typed with U+2011) count as hyphens.
    """
    text = text.translate(_DASHES)
    found: list[tuple[int, Named]] = []
    blanked = text
    for pattern, to_label in _NAMED:
        for m in pattern.finditer(text):
            found.append((m.start(), Named(to_label(m), m.group(0))))
            blanked = blanked[: m.start()] + " " * (m.end() - m.start()) + blanked[m.end() :]
    named: list[Named] = []
    for _, item in sorted(found, key=lambda p: p[0]):
        if all(item.label != n.label for n in named):
            named.append(item)
    return named, bool(_GENERIC_MNI.search(blanked))


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

    def line(self) -> str:
        measured = ""
        if self.fit is not None and self.fit.n_used:
            f = self.fit
            measured = f" (median {f.median_mm:.2f} mm, p90 {f.p90_mm:.2f}, n={f.n_used})"
        verdict = "accepted" if self.accepted else "rejected"
        where = f"{self.label} from {self.evidence} vs {self.reference}"
        return f"{verdict} {where}{measured}: {self.reason}"


def _fits_by_type(eset: ElectrodeSet, surfaces: tuple[Surface, ...]) -> list[Fit]:
    fits = []
    for ctype in sorted({c.type for c in eset.contacts}):
        pts = eset.xyz_for(ctype)
        if np.isfinite(pts).all(axis=1).any():
            fits.append(fit(pts, list(surfaces), ctype, eset.hemispheres_for(ctype)))
    return fits


def _weakest(fits: list[Fit]) -> Fit:
    return max(fits, key=lambda f: (_GRADE_ORDER[f.grade], f.median_mm, f.n_used))


def _finite_pts(eset: ElectrodeSet) -> np.ndarray:
    pts = eset.xyz_mm
    return pts[np.isfinite(pts).all(axis=1)]


def _blind_evidence(eset: ElectrodeSet, surfaces: tuple[Surface, ...]) -> tuple[Fit, bool, str]:
    """Template-vertex test with the shift control: (fit, specific?, reason)."""
    pts = _finite_pts(eset)
    base = fit(pts, list(surfaces), UNKNOWN)
    if base.grade != SPECIFIC or base.median_mm > TEMPLATE_VERTEX_MM:
        return (
            base,
            False,
            f"median {base.median_mm:.2f} mm is not on template vertices (<= 1.0 mm)",
        )
    shifted = []
    for axis in range(3):
        for sign in (-1.0, 1.0):
            delta = np.zeros(3)
            delta[axis] = sign * _SHIFT_MM
            shifted.append(fit(pts + delta, list(surfaces), "ecog"))
    if any(s.passed for s in shifted):
        return base, False, "a 10 mm shift still fits, so the fit is not specific"
    least = min(s.median_mm for s in shifted)
    return (
        base,
        True,
        f"median {base.median_mm:.2f} mm; every 10 mm shift fails (nearest {least:.1f} mm)",
    )


# --- reading ---------------------------------------------------------------------------------


def _sidecar(path: Path | None) -> dict:
    if path is None:
        return {}
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return doc if isinstance(doc, dict) else {}


def _read_assuming_mm(item: Discovered) -> ElectrodeSet:
    """Read an electrodes file with no usable units declaration; BIDS says to assume millimeters."""
    header, rows = _read_tsv(item.electrodes_path)
    for column in ("name", "x", "y", "z"):
        if column not in header:
            raise GeometryRefusal(
                "electrodes-columns", f"{item.electrodes_path.name} has no {column!r} column"
            )
    from_channels = _channel_types(item.channels_paths)
    contacts = []
    for row in rows:
        name = (row.get("name") or "").strip()
        kind = _normalize_type(row.get("type")) or from_channels.get(name) or UNKNOWN
        where = f"{item.electrodes_path.name}, contact {name!r}: "
        xyz = [_to_float(row.get(a) or "", where=where) for a in ("x", "y", "z")]
        hemi = (row.get("hemisphere") or "").strip().upper()
        contacts.append(
            Contact(name, xyz[0], xyz[1], xyz[2], kind, hemi if hemi in ("L", "R") else None)
        )
    return ElectrodeSet(
        item.electrodes_path,
        item.coordsystem_path,
        item.subject,
        item.session,
        item.space,
        None,
        "mm (assumed)",
        1.0,
        contacts,
    )


def _load(item: Discovered) -> ElectrodeSet:
    if item.coordsystem_path is not None:
        try:
            return read_electrode_set(item)
        except GeometryRefusal as exc:
            if exc.reason != "units-missing":
                raise
    return _read_assuming_mm(item)


def _readme(dataset: Path) -> str:
    for name in ("README.md", "README", "README.txt", "README.rst"):
        path = dataset / name
        try:
            if path.is_file():
                return path.read_text(encoding="utf-8", errors="replace")[:200_000]
        except OSError:
            continue
    return ""


# --- plan objects ----------------------------------------------------------------------------


@dataclass(frozen=True)
class PlannedFile:
    path: str  # relative to the dataset
    content: bytes
    kind: str
    inputs: tuple[tuple[str, str], ...]
    method: str
    verification: Verification


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


def _prefix(path: Path) -> str:
    return path.name[: -len("_electrodes.tsv")]


def _tsv_in_mm(path: Path, scale: float) -> bytes:
    raw = path.read_bytes()
    if scale == 1.0:
        return raw
    text = raw.decode("utf-8-sig")
    lines = text.splitlines()
    cols = lines[0].split("\t")
    idx = [cols.index(a) for a in ("x", "y", "z")]
    out = [lines[0]]
    for line in lines[1:]:
        cells = line.split("\t")
        for i in idx:
            if cells[i].strip().lower() not in ("", "n/a", "na", "nan"):
                cells[i] = f"{float(cells[i]) * scale:.6f}".rstrip("0").rstrip(".")
        out.append("\t".join(cells))
    return ("\n".join(out) + "\n").encode("utf-8")


def _coordsystem_bytes(label: str, description: str) -> bytes:
    doc = {
        "iEEGCoordinateSystem": label,
        "iEEGCoordinateUnits": "mm",
        "iEEGCoordinateProcessingDescription": description,
        "iEEGCoordinateProcessingReference": METHOD_URL,
    }
    return (json.dumps(doc, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def _description(attempt: Attempt, src: str, version: str, copied: bool) -> str:
    f = attempt.fit
    assert f is not None
    head = "Computed by NEMAR"
    action = (
        f"positions copied from {src} in millimeters and labeled"
        if copied
        else (f"coordinate frame of {src} labeled")
    )
    return (
        f"{head} (ieeg-geometry {version}): {action} {written_label(attempt.label)}; "
        f"evidence: {attempt.evidence}; median distance {f.median_mm:.2f} mm and 90th "
        f"percentile {f.p90_mm:.2f} mm to the {attempt.reference} reference surface over "
        f"{f.n_used} contacts (grade {attempt.grade}); source file {src}."
    )


def _build_files(
    dataset: Path, item: Discovered, eset: ElectrodeSet, attempt: Attempt, version: str
) -> tuple[PlannedFile, ...]:
    assert attempt.fit is not None and attempt.reference is not None
    label = written_label(attempt.label)
    rel = lambda p: p.relative_to(dataset).as_posix()  # noqa: E731
    src = rel(item.electrodes_path)
    verification = Verification.from_fit(attempt.fit, attempt.reference)
    method = f"label-inference:{attempt.source}"
    elec_in = ((src, blob_id(item.electrodes_path)),)
    prefix = _prefix(item.electrodes_path)
    folder = item.electrodes_path.parent
    if item.coordsystem_path is None:
        target = folder / f"{prefix}_coordsystem.json"
        text = _coordsystem_bytes(label, _description(attempt, src, version, copied=False))
        return (PlannedFile(rel(target), text, "coordsystem", elec_in, method, verification),)
    elec_target = folder / f"{prefix}_space-{label}_electrodes.tsv"
    coord_target = folder / f"{prefix}_space-{label}_coordsystem.json"
    coord_in = elec_in + ((rel(item.coordsystem_path), blob_id(item.coordsystem_path)),)
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
            _coordsystem_bytes(label, _description(attempt, src, version, copied=True)),
            "coordsystem",
            coord_in,
            method,
            verification,
        ),
    )


# --- the decision ----------------------------------------------------------------------------


def _verdict_from_fits(fits: list[Fit]) -> tuple[Fit, str]:
    worst = _weakest(fits)
    return worst, worst.grade


def propose(dataset_dir: str | Path, item: Discovered, readme: str | None = None) -> Proposal:
    """The proposal for one electrodes file. Reads only; writes nothing."""
    dataset = Path(dataset_dir)
    rel = item.electrodes_path.relative_to(dataset).as_posix()
    sidecar = _sidecar(item.coordsystem_path)
    frame = sidecar.get("iEEGCoordinateSystem")
    frame = frame if isinstance(frame, str) else None

    def done(status: str, reason: str, **kw) -> Proposal:
        return Proposal(rel, item.subject, item.session, frame, status, reason, **kw)

    if item.space is not None:
        return done(SKIPPED, f"the file names its frame in space-{item.space}")
    if sidecar.get("IntendedFor"):
        return done(SKIPPED, "the coordsystem has an IntendedFor naming the subject's own image")
    if frame is not None and _CANON.sub("", frame.lower()) in NEVER_RELABEL:
        return done(
            SKIPPED, f"declared {NEVER_RELABEL[_CANON.sub('', frame.lower())]}, never relabeled"
        )
    if frame in TEMPLATE_LABELS:
        return done(ALREADY, f"declared {frame}, a valid template label")

    prefix = _prefix(item.electrodes_path)
    folder = item.electrodes_path.parent
    try:
        eset = _load(item)
    except GeometryRefusal as exc:
        return done(SKIPPED, f"unreadable: {exc.reason}")
    except OSError as exc:
        return done(SKIPPED, f"unreadable: {exc.strerror or exc}")
    if len(_finite_pts(eset)) < _MIN_CONTACTS:
        return done(SKIPPED, f"fewer than {_MIN_CONTACTS} contacts with coordinates")

    candidates: list[tuple[Named, str, str]] = []  # (name, source, evidence)
    unknown_mni = False
    talairach = False

    def add(named: Named, source: str, where: str) -> None:
        nonlocal talairach
        if named.label == "Talairach":
            talairach = True
        elif all(named.label != c[0].label for c in candidates):
            candidates.append((named, source, f"{where} {named.text!r}"))

    if frame:
        hit = classify_frame_value(frame)
        if isinstance(hit, Named):
            add(hit, "sidecar", "iEEGCoordinateSystem")
        elif hit == "mni-unknown":
            unknown_mni = True
    for source, where, text in (
        (
            "description",
            "iEEGCoordinateSystemDescription",
            str(sidecar.get("iEEGCoordinateSystemDescription") or ""),
        ),
        ("README", "README", _readme(dataset) if readme is None else readme),
    ):
        names, generic = scan_prose(text)
        unknown_mni = unknown_mni or generic
        for n in names:
            add(n, source, where)

    attempts: list[Attempt] = []
    version = pipeline_version()
    pooled_fsaverage: tuple[Fit, bool, str] | None = None

    def blind(label: str) -> tuple[Fit, bool, str]:
        return _blind_evidence(eset, _reference(label))

    def accept(attempt: Attempt) -> Proposal:
        label = written_label(attempt.label)
        target = folder / f"{prefix}_space-{label}_electrodes.tsv"
        if target.exists():
            return done(
                ALREADY,
                f"{target.name} already exists; the authors' files win",
                label=label,
                attempts=tuple(attempts),
            )
        files = _build_files(dataset, item, eset, attempt, version)
        return done(ACCEPTED, attempt.evidence, label=label, attempts=tuple(attempts), files=files)

    for named, source, evidence in candidates:
        ref = reference_for(named.label)
        if ref is None:
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
        f, grade = _verdict_from_fits(_fits_by_type(eset, _reference(ref)))
        if grade == FAIL:
            attempts.append(
                Attempt(named.label, source, evidence, ref, grade, False, "fit failed", f)
            )
            continue
        if ref != "fsaverage":
            pooled_fsaverage = pooled_fsaverage or blind("fsaverage")
            if pooled_fsaverage[1]:
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
                    )
                )
                continue
        attempt = Attempt(
            named.label,
            source,
            evidence,
            ref,
            grade,
            True,
            f"{grade} evidence, named by the data",
            f,
        )
        attempts.append(attempt)
        return accept(attempt)

    if unknown_mni or talairach:
        reason = MNI_UNKNOWN if unknown_mni else "Talairach is never written"
        return done(NEEDS_HUMAN, reason, attempts=tuple(attempts))

    for ref_name in ("fsaverage", "MNI152NLin2009cAsym"):
        f, specific, why = (
            pooled_fsaverage if (ref_name == "fsaverage" and pooled_fsaverage) else blind(ref_name)
        )
        attempt = Attempt(
            ref_name,
            "blind trial",
            "blind trial",
            ref_name,
            SPECIFIC if specific else FAIL,
            specific,
            why,
            f,
        )
        attempts.append(attempt)
        if specific:
            return accept(attempt)
    return done(REJECTED, "no candidate verified", attempts=tuple(attempts))


def plan_dataset(dataset_dir: str | Path) -> Plan:
    """Proposals for every electrodes file of a dataset checkout. Reads only."""
    dataset = Path(dataset_dir)
    readme = _readme(dataset)
    proposals = tuple(propose(dataset, item, readme) for item in discover(dataset))
    return Plan(str(dataset), pipeline_version(), proposals)


def write(plan: Plan, dataset_dir: str | Path) -> list[Path]:
    """Write the plan's files and record them in `.nemar/ieeg-geometry.json`.

    Existing files are never overwritten: a file already holding the same bytes is skipped, one
    holding different bytes refuses the whole write before anything is written. An empty plan
    touches nothing, so a second run on its own output leaves every byte as it was.
    """
    dataset = Path(dataset_dir)
    files = plan.files
    pending = []
    for f in files:
        target = dataset / f.path
        if target.exists():
            if target.read_bytes() != f.content:
                raise GeometryRefusal("write-conflict", f"{f.path} exists with different content")
            continue
        pending.append(f)
    if not pending:
        return []
    written = []
    for f in pending:
        target = dataset / f.path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(f.content)
        written.append(target)
    existing = read_ownership(dataset)
    entries = list(existing.entries) if existing else []
    owned = {e.path for e in entries}
    entries += [
        OwnedPath(f.path, f.kind, f.inputs, f.method, f.verification)
        for f in pending
        if f.path not in owned
    ]
    write_ownership(dataset, plan.pipeline_version, entries)
    return written
