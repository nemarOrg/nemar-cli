"""Make every electrodes.tsv the pipeline writes valid BIDS, whatever the source looked like.

The tracks start from the authors' electrodes file and replace the coordinates, so the output
used to repeat the source's own validator errors. `electrodes_tsv` is the one place that writes
the bytes, for all three tracks:

- every missing value, in every column, is `n/a` (never `NaN`, `nan`, `NA` or an empty cell);
- a numeric column (`x`, `y`, `z`, `size`, `impedance`) holds a number or `n/a`, and
  `hemisphere` is `L`, `R` or `n/a` (`lh`, `rh`, `left`, `right` in any case are mapped first);
- the required columns `name`, `x`, `y`, `z`, `size` come first, in that order (`size` is added
  as `n/a` when the source has none);
- a column the BIDS electrodes table does not define is kept only when the dataset defines it in
  the `*_electrodes.json` that applies by BIDS inheritance and every value is `n/a` or passes
  that definition (`Levels`, `Units`, `Format`, `Minimum`, `Maximum`); otherwise it is dropped.
  The pipeline writes no electrodes sidecar of its own: such a column would need one, a third
  owned file beside the electrodes and coordinate-system pair, and a source-space label copied
  next to remapped positions is not trustworthy anyway. The authors' file keeps it.

Nothing changes silently: `electrodes_tsv` returns a `Cleaning` that names the dropped and
added columns and counts the cells it rewrote, and the report carries it per output file.
Source tables the writers could not copy faithfully are refused earlier, in
`bids.check_table`, which each table writer calls when it plans (not the surfaces track).
"""

from __future__ import annotations

import csv
import io
import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

from .bids import GeometryRefusal

# Columns the BIDS iEEG electrodes table defines (schema 1.2.7, `iEEGElectrodes`).
INITIAL_COLUMNS = ("name", "x", "y", "z", "size")
SCHEMA_COLUMNS = frozenset(
    {*INITIAL_COLUMNS, "material", "manufacturer", "group", "hemisphere", "type"}
    | {"impedance", "dimension"}
)
NUMERIC_COLUMNS = frozenset({"x", "y", "z", "size", "impedance"})
NA = "n/a"
_MISSING = frozenset({"", "n/a", "na", "nan"})
_NUMBER = re.compile(r"[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?", re.ASCII)
_INDEX = re.compile(r"[0-9]+", re.ASCII)
_HEMISPHERE = {"l": "L", "lh": "L", "left": "L", "r": "R", "rh": "R", "right": "R"}


@dataclass(frozen=True)
class Cleaning:
    """What `electrodes_tsv` changed beyond rewriting the coordinates."""

    dropped_columns: tuple[str, ...] = ()
    added_columns: tuple[str, ...] = ()
    coerced_cells: dict[str, int] = field(default_factory=dict)  # column -> cells rewritten
    hemisphere_rewritten: int = 0  # cells mapped to L or R (`lh`, `right`, `l`, ...)

    @property
    def changed(self) -> bool:
        return bool(
            self.dropped_columns
            or self.added_columns
            or self.coerced_cells
            or self.hemisphere_rewritten
        )

    def as_json(self, path: str) -> dict:
        return {
            "path": path,
            "dropped_columns": list(self.dropped_columns),
            "added_columns": list(self.added_columns),
            "coerced_cells": dict(sorted(self.coerced_cells.items())),
            "hemisphere_rewritten": self.hemisphere_rewritten,
        }


@dataclass(frozen=True)
class Table:
    data: bytes
    cleaning: Cleaning


def is_missing(value: str | None) -> bool:
    return value is None or value.strip().lower() in _MISSING


def dataset_root(path: Path) -> Path:
    """The dataset a BIDS file sits in: the nearest folder with a `dataset_description.json`,
    else the parent of its top-level `sub-*` folder."""
    for parent in path.parents:
        if (parent / "dataset_description.json").exists():
            return parent
    subs = [i for i, p in enumerate(path.parts) if p.startswith("sub-")]
    return Path(*path.parts[: subs[0]]) if subs else path.parent


def _entities(stem: str) -> dict[str, str]:
    return {k: v for k, _, v in (p.partition("-") for p in stem.split("_") if "-" in p)}


class _Ambiguous(Exception):
    """A folder holds several applicable sidecars and none is the exact match."""


def _folder_candidate(folder: Path, stem: str) -> Path | None:
    """The one `*_electrodes.json` of a folder that applies to a file, as the BIDS validator
    (3.0.2, `walkBack`) picks it: the only candidate, or the exact name match among several.
    With several and no exact match the validator throws `MULTIPLE_INHERITABLE_FILES` and
    `loadSidecar` merges nothing at all, so this raises `_Ambiguous` and the caller drops every
    sidecar, not only that folder's."""
    wanted = _entities(stem)
    found: list[Path] = []
    for cand in sorted(folder.glob("*electrodes.json")):
        if cand.name != "electrodes.json" and not cand.name.endswith("_electrodes.json"):
            continue
        prefix = cand.name[: -len("_electrodes.json")] if cand.name != "electrodes.json" else ""
        if all(wanted.get(k) == v for k, v in _entities(prefix).items()):
            found.append(cand)
    if len(found) == 1:
        return found[0]
    exact = [c for c in found if c.name == f"{stem}_electrodes.json"]
    if exact:
        return exact[0]
    if found:
        raise _Ambiguous
    return None


def sidecar_definitions(output: Path, root: Path | None = None) -> dict[str, object]:
    """Column name -> definition the dataset gives an electrodes file by BIDS inheritance.

    One sidecar per folder from the file's folder up to the dataset root (see
    `_folder_candidate`); a definition in a deeper folder overrides the same key above it.
    An unreadable or non-object sidecar defines nothing. When any folder of the chain is
    ambiguous the validator uses no sidecar for the file, so the result is empty.
    """
    root = dataset_root(output) if root is None else root
    stem = output.name[: -len("_electrodes.tsv")]
    chain: list[Path] = []
    folder = output.parent
    while True:
        try:
            cand = _folder_candidate(folder, stem)
        except _Ambiguous:
            return {}
        if cand is not None:
            chain.append(cand)
        if folder == root or folder.parent == folder:
            break
        folder = folder.parent
    defined: dict[str, object] = {}
    for cand in reversed(chain):  # root first, deepest last: deeper wins
        try:
            doc = json.loads(cand.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(doc, dict):
            defined.update(doc)
    return defined


def sidecar_columns(output: Path, root: Path | None = None) -> set[str]:
    return set(sidecar_definitions(output, root))


def _passes(definition: object, cells: list[str]) -> bool:
    """Every cell is `n/a` or satisfies the definition's `Levels`, `Units`, `Format`, `Minimum`
    and `Maximum`. A definition that is not an object states nothing to check."""
    if not isinstance(definition, dict):
        return True
    levels = definition.get("Levels")
    fmt = definition.get("Format")
    low, high = definition.get("Minimum"), definition.get("Maximum")
    bounded = isinstance(low, int | float) or isinstance(high, int | float)
    numeric = "Units" in definition or fmt == "number" or bounded
    if fmt not in (None, "string", "number", "index"):
        return False  # label, boolean, date, time, rrid, unknown: not checked here, so dropped
    for cell in cells:
        if cell == NA:
            continue
        if isinstance(levels, dict) and cell not in levels:
            return False
        if fmt == "index" and not _INDEX.fullmatch(cell):
            return False
        if numeric:
            if not _NUMBER.fullmatch(cell):
                return False
            value = float(cell)
            if isinstance(low, int | float) and value < low:
                return False
            if isinstance(high, int | float) and value > high:
                return False
    return True


def _clean_cell(column: str, value: str | None) -> tuple[str, bool]:
    """The cleaned cell, and whether it is a hemisphere word mapped to `L` or `R`."""
    text = (value or "").strip()
    if column == "name":  # an electrode may be called "NA"; an empty name is refused
        return text or NA, False
    if text.lower() in _MISSING:
        return NA, False
    if column == "hemisphere":
        mapped = _HEMISPHERE.get(text.lower())
        return (mapped, mapped != text) if mapped is not None else (NA, False)
    if column in NUMERIC_COLUMNS:
        return (text, False) if _NUMBER.fullmatch(text) else (NA, False)
    return text, False


def electrodes_tsv(
    header: list[str],
    rows: Sequence[Mapping[str, str | None]],
    output: Path,
    root: Path | None = None,
) -> Table:
    """A valid electrodes.tsv for `output`, from a source header and rows, and what was changed.

    Raises `GeometryRefusal` (`electrodes-names`) when the written rows would have an empty or
    repeated electrode name.
    """
    defined = sidecar_definitions(output, root)
    schema = [c for c in header if c in SCHEMA_COLUMNS and c not in INITIAL_COLUMNS]
    extras = [c for c in header if c and c not in SCHEMA_COLUMNS and c in defined]
    columns = [*INITIAL_COLUMNS, *dict.fromkeys(schema), *dict.fromkeys(extras)]
    hemispheres = 0
    coerced: dict[str, int] = {}
    body: list[list[str]] = []
    for row in rows:
        out = []
        for c in columns:
            cell, remapped = _clean_cell(c, row.get(c))
            hemispheres += remapped
            if c in header and not remapped and cell != (row.get(c) or "").strip():
                coerced[c] = coerced.get(c, 0) + 1
            out.append(cell)
        body.append(out)
    # a defined extra column whose values break its own definition is dropped, not rewritten
    failing = [c for c in extras if not _passes(defined[c], [r[columns.index(c)] for r in body])]
    if failing:
        keep = [i for i, c in enumerate(columns) if c not in failing]
        columns = [columns[i] for i in keep]
        body = [[r[i] for i in keep] for r in body]
        for c in failing:
            coerced.pop(c, None)
    names = [r[0] for r in body]
    if NA in names or len(set(names)) != len(names):
        raise GeometryRefusal(
            "electrodes-names", f"{output.name} would have an empty or repeated electrode name"
        )
    buf = io.StringIO(newline="")
    writer = csv.writer(buf, delimiter="\t", lineterminator="\n")
    writer.writerow(columns)
    writer.writerows(body)
    dropped = tuple(dict.fromkeys(c for c in header if c and c not in columns))
    added = tuple(c for c in columns if c not in header)
    return Table(buf.getvalue().encode("utf-8"), Cleaning(dropped, added, coerced, hemispheres))
