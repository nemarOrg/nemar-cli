"""Subject cortical surfaces to `brain-mesh v1` files in the contacts' own frame, plus an index.

Per electrodes file, every surface set found for the subject (one folder and one variant such as
`?h.pial` or `?h.pial.T1`) is scored with `verify.fit_with_offset`; the set is usable when
`OffsetFit.preferred` is `as_declared` or `c_ras` and the chosen frame passes (grade `specific` for
electrocorticography (ECoG) contacts, `plausible` for depth contacts; a surface is display data, so
`plausible` is enough, and the grade is recorded). FreeSurfer surfaces are in tkr RAS and the
contacts were in scanner RAS, so when the offset frame is chosen the mesh gets `c_ras` ADDED to
its vertices and lands in the contacts' frame. Each hemisphere is decimated to at most 65,535
vertices by quadric edge collapse and written with the website's encoder; the written mesh is
judged by what decimation changed (median contact distance and surface deviation), not re-graded.

Layout under the output directory (the data plane path is not this module's concern):
`geometry/index.json` and `geometry/meshes/<sha256>.mesh.bin` (content-addressed: a mesh used by
several entries is stored once; only the hemispheres present are written).
`python -m ieeg_geometry.surfaces_out <dataset-dir> --out <dir>` prints one decision line per
electrodes file.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .bids import ECOG, Discovered, ElectrodeSet, GeometryRefusal, discover, read_electrode_set
from .meshwrite import (
    MAX_HEMISPHERE_BYTES,
    MAX_VERTICES,
    decimate,
    edge_stats,
    encode_brain_mesh,
    surface_deviation,
)
from .reference import read_brain_mesh
from .surfaces import Surface, read_surface
from .verify import SPECIFIC, Fit, OffsetFit, fit, fit_with_offset
from .version import pipeline_version

INDEX_SCHEMA = "nemar-ieeg-geometry-index"
INDEX_VERSION = 1
_FS_NAME = re.compile(r"^[lr]h\.pial(\.T1)?$", re.I)
_HEMI_TOKEN = re.compile(r"(^|[._\-])(lh|rh|left|right|l|r)(?=[._\-]|$)", re.I)
_SKIP_DIRS = {".git", ".datalad", ".nemar", "node_modules"}
_SIDE_PURITY = 0.95
MIN_ECOG_CONTACTS = 8
# ruling 15: what decimation may change, measured against the original surface
MAX_MEDIAN_SHIFT_MM = 0.5
MAX_P99_DEVIATION_MM = 1.0


def _is_surface_file(name: str) -> bool:
    low = name.lower()
    if _FS_NAME.match(low):
        return True
    if low.endswith(".gii"):
        return "pial" in low
    return low.endswith(".mat") and any(t in low for t in ("cortex", "pial", "surf"))


def _variant(name: str) -> str:
    """The file name with its hemisphere token blanked, so `lh.pial`/`rh.pial` share a key."""
    return _HEMI_TOKEN.sub(lambda m: m.group(1) + "?", name, count=1).lower()


def find_surface_sets(dataset: Path, subject: str) -> list[list[Path]]:
    """Surface files under a path with a `sub-<subject>` component, one list per (folder, variant).

    Walks the whole dataset (`sourcedata/` and `derivatives/` included) except version-control
    folders. Only the subject's own folders count; a dataset-wide surface is not guessed at.
    """
    token = f"sub-{subject}"
    groups: dict[tuple[Path, str], list[Path]] = {}
    for root, dirs, files in os.walk(dataset):
        dirs[:] = sorted(d for d in dirs if d not in _SKIP_DIRS)
        rel = Path(root).relative_to(dataset).parts
        if token not in rel:
            continue
        for name in sorted(files):
            path = Path(root) / name
            if _is_surface_file(name) and path.is_file():
                groups.setdefault((path.parent, _variant(name)), []).append(path)
    return [groups[k] for k in sorted(groups)]


def _assign_hemisphere(s: Surface) -> Surface:
    """A surface whose file name names no hemisphere is assigned the side holding at least 95
    percent of its vertices; anything straddling the midline is refused."""
    if s.hemisphere in ("L", "R"):
        return s
    left = float((s.vertices[:, 0] < 0).mean())
    if left >= _SIDE_PURITY:
        s.hemisphere = "L"
    elif left <= 1 - _SIDE_PURITY:
        s.hemisphere = "R"
    else:
        raise GeometryRefusal(
            "hemisphere-unknown", f"{Path(s.source).name} names no hemisphere and spans the midline"
        )
    return s


def _contacts_for_fit(eset: ElectrodeSet) -> tuple[str, np.ndarray, list[str | None]] | None:
    """ECoG contacts when the file has at least `MIN_ECOG_CONTACTS` of them (their rule is
    specific), else every contact under the depth rule. Contacts missing a coordinate are
    dropped by `fit`."""
    has = [c for c in eset.contacts if not c.missing_coordinates]
    ecog = [c for c in has if c.type == ECOG]
    chosen, kind = (ecog, "ecog") if len(ecog) >= MIN_ECOG_CONTACTS else (has, "seeg")
    if not chosen:
        return None
    xyz = np.array([[c.x, c.y, c.z] for c in chosen], dtype=float)
    return kind, xyz, [c.hemisphere for c in chosen]


@dataclass
class Candidate:
    paths: list[Path]
    surfaces: list[Surface]
    result: OffsetFit
    chosen: str  # "as_declared" or "c_ras"
    fit: Fit

    @property
    def own_rank(self) -> tuple:
        grade = 0 if self.fit.grade == SPECIFIC else 1
        pair = 0 if len(self.surfaces) == 2 else 1  # a full pair outranks one hemisphere
        return (0 if self.chosen == "as_declared" else 1, grade, pair, self.fit.median_mm)


def _describe_fit(label: str, f: Fit) -> str:
    text = f"{label} median {f.median_mm:.2f} mm, {f.grade}"
    if f.near_or_inside_fraction is not None:
        text += f", {f.near_or_inside_fraction:.0%} inside or near"
    if f.reason:
        text += f", {f.reason}"
    if f.n_left_out:
        text += f", {f.n_left_out} on the absent side"
    return text


def _describe(result: OffsetFit) -> str:
    text = _describe_fit("as declared", result.as_declared)
    if result.with_c_ras is not None:
        text += "; " + _describe_fit("with c_ras", result.with_c_ras)
    return text


def evaluate_candidate(
    paths: list[Path], kind: str, xyz: np.ndarray, hemis: list[str | None], label: str = ""
) -> tuple[Candidate | None, str]:
    """Score one surface set. Returns the candidate, or None and the reason it is unusable."""
    label = label or paths[0].parent.name
    try:
        surfaces = [_assign_hemisphere(read_surface(p)) for p in paths]
    except GeometryRefusal as exc:
        return None, f"{label}: refused {exc.reason}"
    sides = [s.hemisphere for s in surfaces]
    if len(set(sides)) != len(sides):
        return None, f"{label}: two files for one hemisphere"
    c_ras = next((s.c_ras for s in surfaces if s.c_ras is not None), None)
    result = fit_with_offset(xyz, surfaces, kind, c_ras, hemis)
    where = f"{label}/{_variant(paths[0].name)}"
    choice = result.preferred
    if choice is None:
        return None, f"{where}: no frame fits ({_describe(result)})"
    if choice == "ambiguous":
        return None, f"{where}: frame ambiguous ({_describe(result)})"
    chosen = result.as_declared if choice == "as_declared" else result.with_c_ras
    if chosen is None or not chosen.passed:
        return None, f"{where}: declared frame fails, offset immaterial ({_describe(result)})"
    return Candidate(paths, surfaces, result, choice, chosen), ""


def _round(value):
    if isinstance(value, float):
        return round(value, 3)
    return value


def _fit_record(f: Fit) -> dict:
    record = {k: _round(v) for k, v in f.as_dict().items() if k != "offset_applied"}
    return {k: (None if isinstance(v, float) and v != v else v) for k, v in record.items()}


def dataset_commit(dataset: Path) -> str:
    """HEAD of the dataset's own git checkout (the directory must be its top level)."""
    try:
        top = subprocess.run(
            ["git", "-C", str(dataset), "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        head = subprocess.run(
            ["git", "-C", str(dataset), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as exc:
        raise GeometryRefusal(
            "source-commit-missing", f"{dataset} is not a git checkout; pass --source-commit"
        ) from exc
    if Path(top).resolve() != Path(dataset).resolve():
        raise GeometryRefusal(
            "source-commit-missing",
            f"{dataset} is inside another repository; pass --source-commit",
        )
    return head


def build_geometry(
    dataset: Path,
    out_dir: Path,
    *,
    source_commit: str | None = None,
    max_vertices: int = MAX_VERTICES,
) -> tuple[dict, list[str]]:
    """Write `out_dir/geometry/`; returns the index and the per-file decision lines.

    `source_commit` defaults to the dataset checkout's `git rev-parse HEAD`; with neither, the
    index is refused (`source-commit-missing`).
    """
    dataset, out_dir = Path(dataset), Path(out_dir)
    source_commit = source_commit or dataset_commit(dataset)
    geometry = out_dir / "geometry"
    entries: list[dict] = []
    skipped: list[dict] = []
    lines: list[str] = []

    def skip(item: Discovered, reason: str) -> None:
        rel = item.electrodes_path.relative_to(dataset).as_posix()
        skipped.append(
            {"subject": item.subject, "session": item.session, "electrodes": rel, "reason": reason}
        )
        lines.append(f"sub-{item.subject}: {rel}: skipped, {reason}")

    for item in discover(dataset):
        try:
            eset = read_electrode_set(item)
        except GeometryRefusal as exc:
            skip(item, f"electrodes refused, {exc.reason}")
            continue
        picked = _contacts_for_fit(eset)
        if picked is None:
            skip(item, "no contact has all of x, y, z")
            continue
        kind, xyz, hemis = picked
        sets = find_surface_sets(dataset, item.subject)
        if not sets:
            skip(item, "no subject surface file found")
            continue
        candidates: list[Candidate] = []
        reasons: list[str] = []
        for paths in sets:
            label = paths[0].parent.relative_to(dataset).as_posix()
            cand, reason = evaluate_candidate(paths, kind, xyz, hemis, label)
            if cand is None:
                reasons.append(reason)
            else:
                candidates.append(cand)
        if not candidates:
            skip(item, "no surface fits; " + "; ".join(reasons))
            continue
        best = min(candidates, key=lambda c: (c.own_rank, [p.as_posix() for p in c.paths]))
        entry, problem = _write_entry(
            dataset, geometry, item, eset, kind, xyz, hemis, best, max_vertices
        )
        if entry is None:
            skip(item, problem)
            continue
        entries.append(entry)
        lines.append(
            f"sub-{item.subject}: {entry['electrodes']}: written "
            f"{'+'.join(entry['hemispheres'])}, {best.chosen}, {kind} {best.fit.grade} "
            f"median {best.fit.median_mm:.2f} mm, from "
            f"{best.paths[0].parent.relative_to(dataset).as_posix()}"
        )
    entries.sort(key=lambda e: (e["subject"], e["session"] or "", e["electrodes"]))
    skipped.sort(key=lambda e: (e["subject"], e["session"] or "", e["electrodes"]))
    index = {
        "schema": INDEX_SCHEMA,
        "version": INDEX_VERSION,
        "pipeline_version": pipeline_version(),
        "source_commit": source_commit,
        "entries": entries,
        "skipped": skipped,
    }
    geometry.mkdir(parents=True, exist_ok=True)
    (geometry / "index.json").write_text(
        json.dumps(index, indent=2, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8"
    )
    return index, lines


def _write_entry(
    dataset: Path,
    geometry: Path,
    item: Discovered,
    eset: ElectrodeSet,
    kind: str,
    xyz: np.ndarray,
    hemis: list[str | None],
    best: Candidate,
    max_vertices: int,
) -> tuple[dict | None, str]:
    c_ras = best.result.c_ras if best.chosen == "c_ras" else None
    # contacts were in scanner RAS: add c_ras to the surface to put the mesh in their frame
    shift = np.asarray(c_ras if c_ras is not None else (0.0, 0.0, 0.0), dtype=float)
    payload: dict[str, bytes] = {}
    stats: dict[str, dict] = {}
    decoded: list[Surface] = []
    decimated = False
    p99 = 0.0
    try:
        for s in sorted(best.surfaces, key=lambda s: s.hemisphere or ""):
            original = s.vertices + shift
            verts, faces = decimate(original, s.faces, max_vertices)
            data = encode_brain_mesh(verts, faces)
            if len(data) > MAX_HEMISPHERE_BYTES:
                raise GeometryRefusal("mesh-too-large", f"{len(data)} bytes, over the budget")
            hemi = str(s.hemisphere)
            payload[hemi] = data
            back = read_brain_mesh(data, hemisphere=hemi)
            decoded.append(back)
            boundary, non_manifold = edge_stats(faces)
            stats[hemi] = {
                "vertices": len(verts),
                "faces": len(faces),
                "boundary_edges": boundary,
                "non_manifold_edges": non_manifold,
            }
            if len(verts) != len(original):
                decimated = True
                dev = surface_deviation(back.vertices, original, s.faces)
                p99 = max(p99, float(np.percentile(dev, 99)))
    except GeometryRefusal as exc:
        return None, f"mesh not written, {exc.reason}: {exc.message}"
    # Ruling 15: the written mesh is judged by what decimation changed. The grade and the inside
    # flags come from the original closed surface; here only the distances are re-measured.
    after = fit(xyz, decoded, kind, hemis)
    shift_mm = after.median_mm - best.fit.median_mm
    if decimated and (abs(shift_mm) > MAX_MEDIAN_SHIFT_MM or p99 > MAX_P99_DEVIATION_MM):
        return None, (
            f"decimation changed the mesh too much (median moved {shift_mm:+.2f} mm, "
            f"99th percentile deviation {p99:.2f} mm; limits {MAX_MEDIAN_SHIFT_MM} and "
            f"{MAX_P99_DEVIATION_MM} mm)"
        )
    if kind == "ecog" and not after.passed:
        return None, f"written mesh no longer fits the contacts ({after.median_mm:.2f} mm)"
    meshes: dict[str, dict] = {}
    (geometry / "meshes").mkdir(parents=True, exist_ok=True)
    for hemi, data in sorted(payload.items()):
        digest = hashlib.sha256(data).hexdigest()
        rel = f"meshes/{digest}.mesh.bin"
        (geometry / rel).write_bytes(data)
        meshes[hemi] = {"path": rel, "sha256": digest, "bytes": len(data), **stats[hemi]}
    written = _fit_record(best.fit) | {
        k: v
        for k, v in _fit_record(after).items()
        if k in ("median_mm", "p90_mm", "max_mm", "n_used")
    }
    entry = {
        "subject": item.subject,
        "session": item.session,
        "electrodes": item.electrodes_path.relative_to(dataset).as_posix(),
        "frame": eset.frame,
        "contact_type": kind,
        "frame_choice": best.chosen,
        "vertex_offset_mm": None if c_ras is None else [float(v) for v in c_ras],
        "hemispheres": sorted(payload),
        "fit": written,
        "fit_before_decimation": _fit_record(best.fit),
        "decimation": {
            "applied": decimated,
            "median_shift_mm": _round(float(shift_mm)) if decimated else None,
            "p99_deviation_mm": _round(p99) if decimated else None,
        },
        "sources": sorted(p.relative_to(dataset).as_posix() for p in best.paths),
        "meshes": meshes,
    }
    return entry, ""


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="ieeg_geometry.surfaces_out", description="subject surfaces to brain-mesh v1"
    )
    parser.add_argument("dataset_dir", type=Path)
    parser.add_argument("--out", type=Path, required=True, help="output directory")
    parser.add_argument("--source-commit", default=None, help="dataset commit, recorded as is")
    args = parser.parse_args(argv)
    try:
        index, lines = build_geometry(args.dataset_dir, args.out, source_commit=args.source_commit)
    except GeometryRefusal as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 1
    print("\n".join(lines))
    print(f"{len(index['entries'])} written, {len(index['skipped'])} skipped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
