"""Subject cortical surfaces to `brain-mesh v1` files in the contacts' own frame, plus an index.

Per electrodes file, every surface set found for the subject (one folder and one variant such as
`?h.pial` or `?h.pial.T1`) is scored with `verify.fit_with_offset`; the set is usable when
`OffsetFit.preferred` is `as_declared` or `c_ras` and the chosen frame passes (grade `specific` for
electrocorticography (ECoG) contacts, `plausible` for depth contacts; a surface is display data, so
`plausible` is enough, and the grade is recorded). FreeSurfer surfaces are in tkr RAS and the
contacts were in scanner RAS, so when the offset frame is chosen the mesh gets `c_ras` ADDED to
its vertices and lands in the contacts' frame. Each hemisphere is decimated to at most 65,535
vertices, re-checked against the contacts, and written with the website's encoder.

Layout under the output directory (the data plane path is not this module's concern):
`geometry/index.json` and `geometry/sub-<subject>/<electrodes file stem>/{lh,rh}.mesh.bin`
(only the hemispheres present). `python -m ieeg_geometry.surfaces_out <dataset-dir> --out <dir>`
prints one decision line per electrodes file.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass
from importlib import metadata
from pathlib import Path

import numpy as np

from .bids import ECOG, Discovered, ElectrodeSet, GeometryRefusal, discover, read_electrode_set
from .meshwrite import MAX_HEMISPHERE_BYTES, MAX_VERTICES, decimate, encode_brain_mesh
from .reference import read_brain_mesh
from .surfaces import Surface, read_surface
from .verify import SPECIFIC, Fit, OffsetFit, fit, fit_with_offset

INDEX_SCHEMA = "nemar-ieeg-geometry-index"
INDEX_VERSION = 1
_HEMI_FILE = {"L": "lh", "R": "rh"}
_FS_NAME = re.compile(r"^[lr]h\.pial(\.T1)?$", re.I)
_HEMI_TOKEN = re.compile(r"(^|[._\-])(lh|rh|left|right|l|r)(?=[._\-]|$)", re.I)
_SKIP_DIRS = {".git", ".datalad", ".nemar", "node_modules"}
_SIDE_PURITY = 0.95


def pipeline_version() -> str:
    try:
        return metadata.version("ieeg-geometry")
    except metadata.PackageNotFoundError:
        return "unknown"


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
    """ECoG contacts when the file has any (their rule is specific), else every other contact
    under the depth rule. Contacts missing a coordinate are dropped by `fit`."""
    has = [c for c in eset.contacts if not c.missing_coordinates]
    ecog = [c for c in has if c.type == ECOG]
    chosen, kind = (ecog, "ecog") if ecog else (has, "seeg")
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
        return (0 if self.chosen == "as_declared" else 1, grade, self.fit.median_mm)


def _describe(result: OffsetFit) -> str:
    a = result.as_declared
    text = f"as declared {a.median_mm:.2f} mm ({a.grade})"
    if result.with_c_ras is not None:
        text += f", with c_ras {result.with_c_ras.median_mm:.2f} mm ({result.with_c_ras.grade})"
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


def _written_hemisphere(
    surface: Surface, shift: np.ndarray, max_vertices: int
) -> tuple[np.ndarray, np.ndarray, bytes]:
    verts, faces = decimate(surface.vertices + shift, surface.faces, max_vertices)
    data = encode_brain_mesh(verts, faces)
    if len(data) > MAX_HEMISPHERE_BYTES:
        raise GeometryRefusal("mesh-too-large", f"{len(data)} bytes exceeds the hemisphere budget")
    return verts, faces, data


def _round(value):
    if isinstance(value, float):
        return round(value, 3)
    return value


def _fit_record(f: Fit) -> dict:
    record = {k: _round(v) for k, v in f.as_dict().items() if k != "offset_applied"}
    return {k: (None if isinstance(v, float) and v != v else v) for k, v in record.items()}


def build_geometry(
    dataset: Path,
    out_dir: Path,
    *,
    source_commit: str | None = None,
    max_vertices: int = MAX_VERTICES,
) -> tuple[dict, list[str]]:
    """Write `out_dir/geometry/`; returns the index and the per-file decision lines."""
    dataset, out_dir = Path(dataset), Path(out_dir)
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
    stem = item.electrodes_path.stem
    folder = geometry / f"sub-{item.subject}" / stem
    written: list[Surface] = []
    payload: dict[str, tuple[bytes, int, int]] = {}
    try:
        for s in sorted(best.surfaces, key=lambda s: s.hemisphere or ""):
            verts, faces, data = _written_hemisphere(s, shift, max_vertices)
            written.append(Surface(verts, faces, s.hemisphere))
            payload[str(s.hemisphere)] = (data, len(verts), len(faces))
    except GeometryRefusal as exc:
        return None, f"mesh not written, {exc.reason}"
    # the decimated, quantized mesh must still fit the contacts in their own frame
    check = [
        read_brain_mesh(payload[str(s.hemisphere)][0], hemisphere=s.hemisphere) for s in written
    ]
    after = fit(xyz, check, kind, hemis)
    if not after.passed:
        return None, f"decimation broke the fit ({after.median_mm:.2f} mm, {after.grade})"
    folder.mkdir(parents=True, exist_ok=True)
    meshes: dict[str, dict] = {}
    for hemi, (data, nv, nf) in sorted(payload.items()):
        name = f"{_HEMI_FILE[hemi]}.mesh.bin"
        (folder / name).write_bytes(data)
        meshes[hemi] = {
            "path": (folder / name).relative_to(geometry).as_posix(),
            "sha256": hashlib.sha256(data).hexdigest(),
            "bytes": len(data),
            "vertices": nv,
            "faces": nf,
        }
    entry = {
        "subject": item.subject,
        "session": item.session,
        "electrodes": item.electrodes_path.relative_to(dataset).as_posix(),
        "frame": eset.frame,
        "contact_type": kind,
        "frame_choice": best.chosen,
        "offset_applied": None if c_ras is None else [float(v) for v in c_ras],
        "hemispheres": sorted(payload),
        "fit": _fit_record(after),
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
    index, lines = build_geometry(args.dataset_dir, args.out, source_commit=args.source_commit)
    print("\n".join(lines))
    print(f"{len(index['entries'])} written, {len(index['skipped'])} skipped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
