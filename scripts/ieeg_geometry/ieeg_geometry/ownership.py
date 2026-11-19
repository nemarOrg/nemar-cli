"""`.nemar/ieeg-geometry.json`: the paths the pipeline owns, with inputs and verification."""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass, field
from pathlib import Path

from .bids import GeometryRefusal
from .verify import Fit

SCHEMA = 1
OWNERSHIP_PATH = Path(".nemar") / "ieeg-geometry.json"


def blob_id(data: bytes | str | Path) -> str:
    """The git blob id of content (`sha1("blob <n>\\0" + content)`); a path is read first."""
    if isinstance(data, Path):
        data = data.read_bytes()
    elif isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()  # noqa: S324 - git format


@dataclass(frozen=True)
class Verification:
    """The `Fit` fields plus the name of the reference the contacts were checked against."""

    reference: str
    median_mm: float | None
    p90_mm: float | None
    max_mm: float | None
    n_used: int
    n_total: int
    passed: bool
    rule: str
    inside_fraction: float | None = None

    @classmethod
    def from_fit(cls, fit: Fit, reference: str) -> Verification:
        def num(v: float | None) -> float | None:
            return None if v is None or math.isnan(v) else round(v, 3)

        return cls(
            reference=reference,
            median_mm=num(fit.median_mm),
            p90_mm=num(fit.p90_mm),
            max_mm=num(fit.max_mm),
            n_used=fit.n_used,
            n_total=fit.n_total,
            passed=fit.passed,
            rule=fit.rule,
            inside_fraction=num(fit.inside_fraction),
        )


@dataclass(frozen=True)
class OwnedPath:
    path: str
    kind: str
    inputs: tuple[tuple[str, str], ...]  # (path, git blob id)
    method: str
    verification: Verification | None = None


@dataclass
class Ownership:
    pipeline_version: str
    entries: list[OwnedPath] = field(default_factory=list)


def _entry_json(e: OwnedPath) -> dict:
    return {
        "kind": e.kind,
        "inputs": [{"blob": blob, "path": path} for path, blob in sorted(e.inputs)],
        "method": e.method,
        "verification": None
        if e.verification is None
        else {k: v for k, v in sorted(e.verification.__dict__.items())},
    }


def write_ownership(
    dataset_dir: str | Path, pipeline_version: str, entries: list[OwnedPath]
) -> bytes:
    """Write `.nemar/ieeg-geometry.json` deterministically and return the bytes written.

    Keys are sorted and entries are ordered by path, so a rerun on unchanged inputs
    produces identical bytes. The file is only rewritten when the bytes differ.
    """
    paths = [e.path for e in entries]
    if len(set(paths)) != len(paths):
        raise GeometryRefusal("ownership-duplicate", "a path is listed twice")
    doc = {
        "schema": SCHEMA,
        "pipeline_version": pipeline_version,
        "paths": {e.path: _entry_json(e) for e in sorted(entries, key=lambda e: e.path)},
    }
    data = (json.dumps(doc, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")
    target = Path(dataset_dir) / OWNERSHIP_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists() or target.read_bytes() != data:
        target.write_bytes(data)
    return data


def read_ownership(dataset_dir: str | Path) -> Ownership | None:
    """The ownership record, or None when the dataset has none. Other schemas are refused."""
    target = Path(dataset_dir) / OWNERSHIP_PATH
    if not target.exists():
        return None
    doc = json.loads(target.read_text(encoding="utf-8"))
    if doc.get("schema") != SCHEMA:
        raise GeometryRefusal("ownership-schema", f"schema {doc.get('schema')!r} is not {SCHEMA}")
    entries = []
    for path, body in doc["paths"].items():
        v = body.get("verification")
        entries.append(
            OwnedPath(
                path=path,
                kind=body["kind"],
                inputs=tuple((i["path"], i["blob"]) for i in body["inputs"]),
                method=body["method"],
                verification=Verification(**v) if v else None,
            )
        )
    return Ownership(doc["pipeline_version"], entries)
