"""Discover and read BIDS iEEG electrode files and their coordinate-system sidecars."""

from __future__ import annotations

import csv
import json
import math
import os
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .names import join_channels

_MISSING = {"", "n/a", "na", "nan"}
_UNIT_TO_MM = {"m": 1000.0, "cm": 10.0, "mm": 1.0}

ContactType = str
SEEG: ContactType = "seeg"
ECOG: ContactType = "ecog"
DBS: ContactType = "dbs"
UNKNOWN: ContactType = "unknown"
# BIDS `type` values seen in electrodes.tsv and channels.tsv, folded to three contact kinds.
_TYPES = {
    "seeg": SEEG,
    "depth": SEEG,
    "ecog": ECOG,
    "grid": ECOG,
    "strip": ECOG,
    "surface": ECOG,
    "dbs": DBS,
}


class GeometryRefusal(Exception):
    """A file is refused for a named reason; `reason` is a short stable code."""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(f"{reason}: {message}")
        self.reason = reason
        self.message = message


@dataclass
class Contact:
    name: str
    x: float
    y: float
    z: float
    type: ContactType = UNKNOWN
    hemisphere: str | None = None  # "L" or "R" from the electrodes `hemisphere` column

    @property
    def missing_coordinates(self) -> bool:
        return any(math.isnan(v) for v in (self.x, self.y, self.z))


@dataclass
class ElectrodeSet:
    """One electrodes.tsv with its coordsystem.json; positions are in millimeters."""

    electrodes_path: Path
    coordsystem_path: Path | None
    subject: str
    session: str | None
    space: str | None
    frame: str | None
    declared_units: str
    scale_to_mm: float
    contacts: list[Contact] = field(default_factory=list)
    units_assumed: bool = False
    warnings: tuple[str, ...] = ()

    @property
    def xyz_mm(self) -> np.ndarray:
        """N x 3 positions in millimeters; NaN rows are the flagged contacts."""
        return np.array([[c.x, c.y, c.z] for c in self.contacts], dtype=float).reshape(-1, 3)

    @property
    def n_missing(self) -> int:
        return sum(c.missing_coordinates for c in self.contacts)

    def type_counts(self) -> dict[ContactType, int]:
        counts: dict[ContactType, int] = {}
        for c in self.contacts:
            counts[c.type] = counts.get(c.type, 0) + 1
        return dict(sorted(counts.items()))

    def xyz_for(self, contact_type: ContactType) -> np.ndarray:
        rows = [[c.x, c.y, c.z] for c in self.contacts if c.type == contact_type]
        return np.array(rows, dtype=float).reshape(-1, 3)

    def hemispheres_for(self, contact_type: ContactType) -> list[str | None]:
        return [c.hemisphere for c in self.contacts if c.type == contact_type]


@dataclass(frozen=True)
class Discovered:
    """An electrodes file and the sidecars that go with it, found but not yet read."""

    electrodes_path: Path
    coordsystem_path: Path | None
    channels_paths: tuple[Path, ...]
    subject: str
    session: str | None
    space: str | None
    coordsystem_inherited: bool = False  # the sidecar sits at a higher level (BIDS inheritance)


def _entities(prefix: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for part in prefix.split("_"):
        if "-" in part:
            key, _, value = part.partition("-")
            out[key] = value
    return out


def _inherited_coordsystem(root: Path, electrodes: Path, entities: dict[str, str]) -> Path | None:
    """The coordsystem that applies to an electrodes file by the BIDS inheritance principle.

    Looked for in the file's folder, then each parent up to the dataset root; a candidate's
    entities must be a subset of the electrodes file's (same keys and values). In the nearest
    folder that has candidates, the one with the most entities wins (ties: name order).
    """
    folder = electrodes.parent
    while True:
        best: tuple[int, str, Path] | None = None
        for cand in folder.glob("*coordsystem.json"):
            if cand.name != "coordsystem.json" and not cand.name.endswith("_coordsystem.json"):
                continue
            prefix = (
                cand.name[: -len("_coordsystem.json")] if cand.name != "coordsystem.json" else ""
            )
            cand_entities = _entities(prefix)
            if all(entities.get(k) == v for k, v in cand_entities.items()):
                key = (-len(cand_entities), cand.name)
                if best is None or key < (best[0], best[1]):
                    best = (key[0], key[1], cand)
        if best is not None:
            return best[2]
        if folder == root or folder.parent == folder:
            return None
        folder = folder.parent


def discover(dataset_dir: str | Path) -> list[Discovered]:
    """Every electrodes.tsv under a top-level `sub-*` directory, paired with its sidecars.

    The pair is keyed on the file prefix (`sub-X[_ses-Y][_acq-..][_space-Z]`), so each
    subject, session and `space-` entity gets its own electrodes and coordsystem file.
    Derivatives are not searched.
    """
    root = Path(dataset_dir)
    found: list[Discovered] = []
    for sub_dir in sorted(p for p in root.glob("sub-*") if p.is_dir()):
        for tsv in sorted(sub_dir.rglob("*_electrodes.tsv")):
            prefix = tsv.name[: -len("_electrodes.tsv")]
            ents = _entities(prefix)
            coord = tsv.with_name(prefix + "_coordsystem.json")
            inherited = False
            if not os.path.lexists(coord):  # a dangling link is not an absent file
                higher = _inherited_coordsystem(root, tsv, ents)
                if higher is not None:
                    coord, inherited = higher, True
            channels = tuple(sorted(tsv.parent.glob(f"{_channel_stem(ents)}*_channels.tsv")))
            found.append(
                Discovered(
                    electrodes_path=tsv,
                    coordsystem_path=coord if inherited or coord.exists() else None,
                    coordsystem_inherited=inherited,
                    channels_paths=channels,
                    subject=ents.get("sub", sub_dir.name.removeprefix("sub-")),
                    session=ents.get("ses"),
                    space=ents.get("space"),
                )
            )
    return found


def _channel_stem(ents: dict[str, str]) -> str:
    stem = f"sub-{ents.get('sub', '')}"
    if "ses" in ents:
        stem += f"_ses-{ents['ses']}"
    return stem


def _to_float(token: str, *, where: str = "") -> float:
    """A coordinate; `n/a`, `NaN` and empty are missing, anything unparsable is refused."""
    token = token.strip()
    if token.lower() in _MISSING:
        return math.nan
    try:
        value = float(token)
    except ValueError:
        value = math.nan
    if not math.isfinite(value):
        raise GeometryRefusal("electrodes-value", f"{where}unparsable coordinate {token!r}")
    return value


def _read_tsv(path: Path, errors: str = "strict") -> tuple[list[str], list[dict[str, str]]]:
    with path.open(newline="", encoding="utf-8-sig", errors=errors) as fh:
        reader = csv.DictReader(fh, delimiter="\t")
        rows = list(reader)
        return list(reader.fieldnames or []), rows


def _normalize_type(token: str | None) -> ContactType | None:
    if token is None:
        return None
    return _TYPES.get(token.strip().lower())


def _channel_types(
    paths: tuple[Path, ...], contact_names: Sequence[str] = ()
) -> tuple[dict[str, ContactType], tuple[str, ...]]:
    """Contact types from channels files, and a warning per file whose name or type cells
    contained undecodable bytes (replaced by U+FFFD; those cells may not match).

    A channel named as the recording header names it (`POL A1-AV`, `EEG G_03-REF`) gives its type
    to the contact `names.join_channels` pairs it with, so a channels file may be renamed while
    electrodes.tsv keeps the contact names; a bipolar channel gives it to both contacts.

    Every non-empty channel name of a file takes part in the join (a channel of another type, such
    as `A1` typed MISC, still keeps its contact against a renamed `POL A1`); only channels whose
    type is seeg, ecog or dbs give a type. Exact names from every file are applied first and are
    the file's own word; a contact reached only by renamed channels takes their type. Where the
    types that reach one contact disagree, the contact stays untyped and a warning says so."""
    warnings: list[str] = []
    exact: dict[str, list[ContactType]] = {}
    mapped: dict[str, list[ContactType]] = {}
    own_contacts = set(contact_names)
    for path in paths:
        # A non-UTF-8 byte in another column (on006233's units) is not fatal.
        _, rows = _read_tsv(path, errors="replace")
        damaged = 0
        named: list[tuple[str, ContactType | None]] = []
        for row in rows:
            name = (row.get("name") or "").strip()
            kind_text = row.get("type")
            if "\ufffd" in name or "\ufffd" in (kind_text or ""):
                damaged += 1
            if name:
                named.append((name, _normalize_type(kind_text)))
        for name, kind in named:
            if kind and (not contact_names or name in own_contacts):
                exact.setdefault(name, []).append(kind)
        if contact_names:
            joined = join_channels([name for name, _ in named], contact_names)
            for name, kind in named:
                contacts = joined.get(name, ())
                if kind and contacts and contacts != (name,):
                    for contact in contacts:
                        mapped.setdefault(contact, []).append(kind)
        if damaged:
            warnings.append(
                f"{path.name}: {damaged} name or type cell(s) had undecodable bytes "
                "(replaced); contact types may be incomplete"
            )
    types: dict[str, ContactType] = {}
    conflicted: set[str] = set()
    for source in (exact, mapped):
        for contact, kinds in source.items():
            if contact in types or contact in conflicted:
                continue
            if len(set(kinds)) > 1:
                conflicted.add(contact)
                warnings.append(
                    f"contact {contact}: channels files give it more than one type "
                    f"({', '.join(sorted(set(kinds)))}); left untyped"
                )
            else:
                types[contact] = kinds[0]
    return types, tuple(warnings)


def read_electrode_set(item: Discovered, assume_units: str | None = None) -> ElectrodeSet:
    """Read one discovered pair. Raises `GeometryRefusal` when units cannot be trusted.

    With `assume_units` (`m`, `cm` or `mm`), a missing coordsystem, or one without
    `iEEGCoordinateUnits`, is read with those units and `units_assumed` is set; the caller must
    confirm them some other way (the geometric fit does). Units that are declared but
    unsupported are still refused.
    """
    sidecar: dict = {}
    if item.coordsystem_path is None:
        if assume_units is None:
            raise GeometryRefusal(
                "coordsystem-missing", f"no coordsystem.json beside {item.electrodes_path.name}"
            )
    else:
        try:
            sidecar = json.loads(item.coordsystem_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise GeometryRefusal(
                "coordsystem-unreadable", f"{item.coordsystem_path.name}: {exc}"
            ) from exc
        if not isinstance(sidecar, dict):
            raise GeometryRefusal(
                "coordsystem-unreadable", f"{item.coordsystem_path.name} is not a JSON object"
            )
    raw_units = sidecar.get("iEEGCoordinateUnits")
    assumed = False
    if not isinstance(raw_units, str) or not raw_units.strip():
        if assume_units is None:
            raise GeometryRefusal(
                "units-missing", f"{item.coordsystem_path} has no iEEGCoordinateUnits"
            )
        raw_units, assumed = assume_units, True
    units = raw_units.strip().lower()
    if units not in _UNIT_TO_MM:
        raise GeometryRefusal(
            "units-unsupported",
            f"iEEGCoordinateUnits {raw_units!r} is not one of m, cm, mm",
        )
    scale = _UNIT_TO_MM[units]
    header, rows = _read_tsv(item.electrodes_path)
    for column in ("name", "x", "y", "z"):
        if column not in header:
            raise GeometryRefusal(
                "electrodes-columns", f"{item.electrodes_path.name} has no {column!r} column"
            )
    from_channels, warnings = _channel_types(
        item.channels_paths, [(row.get("name") or "").strip() for row in rows]
    )
    contacts: list[Contact] = []
    for row in rows:
        name = (row.get("name") or "").strip()
        kind = _normalize_type(row.get("type")) or from_channels.get(name) or UNKNOWN
        where = f"{item.electrodes_path.name}, contact {name!r}: "
        xyz = [_to_float(row.get(axis) or "", where=where) * scale for axis in ("x", "y", "z")]
        hemi = (row.get("hemisphere") or "").strip().upper()
        contacts.append(
            Contact(name, xyz[0], xyz[1], xyz[2], kind, hemi if hemi in ("L", "R") else None)
        )
    frame = sidecar.get("iEEGCoordinateSystem")
    return ElectrodeSet(
        electrodes_path=item.electrodes_path,
        coordsystem_path=item.coordsystem_path,
        subject=item.subject,
        session=item.session,
        space=item.space,
        frame=frame if isinstance(frame, str) else None,
        declared_units=units,
        scale_to_mm=scale,
        contacts=contacts,
        units_assumed=assumed,
        warnings=warnings,
    )
