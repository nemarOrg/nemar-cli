"""Make every electrodes.tsv the pipeline writes valid BIDS, whatever the source looked like.

The tracks start from the authors' electrodes file and replace the coordinates, so the output
used to repeat the source's own validator errors. `electrodes_tsv` is the one place that writes
the bytes, for all three tracks:

- every missing value, in every column, is `n/a` (never `NaN`, `nan`, `NA` or an empty cell);
- a numeric column (`x`, `y`, `z`, `size`, `impedance`) holds a number or `n/a`;
- the required columns `name`, `x`, `y`, `z`, `size` come first, in that order (`size` is added
  as `n/a` when the source has none);
- a column the BIDS electrodes table does not define is kept only when the dataset already
  defines it in an applicable `*_electrodes.json` sidecar (BIDS inheritance); otherwise it is
  dropped. The pipeline writes no electrodes sidecar of its own: such a column would need one,
  a third owned file beside the electrodes and coordinate-system pair, and a source-space label
  copied next to remapped positions is not trustworthy anyway. The authors' file keeps it.
"""

from __future__ import annotations

import csv
import io
import json
import re
from pathlib import Path

# Columns the BIDS iEEG electrodes table defines (schema 1.2.7, `iEEGElectrodes`).
INITIAL_COLUMNS = ("name", "x", "y", "z", "size")
SCHEMA_COLUMNS = frozenset(
    {*INITIAL_COLUMNS, "material", "manufacturer", "group", "hemisphere", "type"}
    | {"impedance", "dimension"}
)
NUMERIC_COLUMNS = frozenset({"x", "y", "z", "size", "impedance"})
NA = "n/a"
_MISSING = frozenset({"", "n/a", "na", "nan", "null", "none"})
_NUMBER = re.compile(r"[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?")
_HEMISPHERE = {"l": "L", "left": "L", "r": "R", "right": "R"}


def is_missing(value: str | None) -> bool:
    return value is None or value.strip().lower() in _MISSING


def _clean_cell(column: str, value: str | None) -> str:
    if is_missing(value):
        return NA
    text = (value or "").strip()
    if column in NUMERIC_COLUMNS:
        return text if _NUMBER.fullmatch(text) else NA
    if column == "hemisphere":
        return _HEMISPHERE.get(text.lower(), NA)
    return text


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


def sidecar_columns(output: Path, root: Path | None = None) -> set[str]:
    """The column names the dataset defines for an electrodes file, by BIDS inheritance.

    Every `*_electrodes.json` in the file's folder and each parent up to the dataset root whose
    entities are all in the file's name applies; their top-level keys are the defined columns.
    An unreadable or non-object sidecar defines nothing.
    """
    root = dataset_root(output) if root is None else root
    stem = output.name[: -len("_electrodes.tsv")]
    wanted = _entities(stem)
    defined: set[str] = set()
    folder = output.parent
    while True:
        for cand in sorted(folder.glob("*electrodes.json")):
            if cand.name != "electrodes.json" and not cand.name.endswith("_electrodes.json"):
                continue
            prefix = cand.name[: -len("_electrodes.json")]
            if all(wanted.get(k) == v for k, v in _entities(prefix).items()):
                try:
                    doc = json.loads(cand.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    continue
                if isinstance(doc, dict):
                    defined.update(doc)
        if folder == root or folder.parent == folder:
            return defined
        folder = folder.parent


def electrodes_tsv(
    header: list[str], rows: list[dict[str, str | None]], output: Path, root: Path | None = None
) -> bytes:
    """The bytes of a valid electrodes.tsv for `output`, from a source header and rows."""
    defined = sidecar_columns(output, root)
    extra = [
        c
        for c in header
        if c and c not in SCHEMA_COLUMNS and c in defined and c not in INITIAL_COLUMNS
    ]
    schema = [c for c in header if c in SCHEMA_COLUMNS and c not in INITIAL_COLUMNS]
    columns = [*INITIAL_COLUMNS, *dict.fromkeys(schema), *dict.fromkeys(extra)]
    buf = io.StringIO(newline="")
    writer = csv.writer(buf, delimiter="\t", lineterminator="\n")
    writer.writerow(columns)
    for row in rows:
        writer.writerow([_clean_cell(c, row.get(c)) for c in columns])
    return buf.getvalue().encode("utf-8")
