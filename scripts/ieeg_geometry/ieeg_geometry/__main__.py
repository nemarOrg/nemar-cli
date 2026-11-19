"""Command line: `python -m ieeg_geometry inspect <dataset-dir>` (read-only)."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .bids import UNKNOWN, ElectrodeSet, GeometryRefusal, discover, read_electrode_set
from .reference import REFERENCE_NAMES, load_reference
from .surfaces import Surface, read_surface
from .verify import Fit, fit, fit_with_offset


def _fmt(f: Fit) -> str:
    extra = ""
    if f.near_or_inside_fraction is not None:
        extra += f", inside-or-near {f.near_or_inside_fraction:.0%}"
    if f.n_left_out:
        extra += f", {f.n_left_out} on the other side left out"
    if f.reason:
        extra += f", {f.reason}"
    return (
        f"median {f.median_mm:.2f} mm, p90 {f.p90_mm:.2f}, max {f.max_mm:.2f}, "
        f"n={f.n_used}/{f.n_total}{extra} -> {f.grade}"
    )


def find_subject_surfaces(dataset: Path, subject: str) -> list[list[Path]]:
    """Pial surface files under a path that has a `sub-<subject>` directory, grouped by folder."""
    groups: dict[Path, list[Path]] = {}
    token = f"sub-{subject}"
    for path in sorted(dataset.rglob("*")):
        if not path.is_file() or token not in path.relative_to(dataset).parts:
            continue
        name = path.name.lower()
        if name in ("lh.pial", "rh.pial") or (name.endswith(".gii") and "pial" in name):
            groups.setdefault(path.parent, []).append(path)
    return list(groups.values())


def _types(eset: ElectrodeSet) -> list[str]:
    counts = eset.type_counts()
    return [
        t
        for t in counts
        if counts[t] and any(not c.missing_coordinates for c in eset.contacts if c.type == t)
    ]


def inspect(dataset: Path, out=sys.stdout) -> int:
    write = lambda s="": print(s, file=out)  # noqa: E731
    refs = {name: load_reference(name) for name in REFERENCE_NAMES}
    items = discover(dataset)
    if not items:
        write(f"no electrodes.tsv found under sub-* in {dataset}")
        return 1
    for item in items:
        label = f"sub-{item.subject}" + (f" ses-{item.session}" if item.session else "")
        label += f" space-{item.space}" if item.space else " (no space entity)"
        write(f"{label}: {item.electrodes_path.relative_to(dataset)}")
        try:
            eset = read_electrode_set(item)
        except GeometryRefusal as exc:
            write(f"  refused: {exc.reason} ({exc.message})")
            continue
        counts = ", ".join(f"{t}={n}" for t, n in eset.type_counts().items())
        write(f"  frame {eset.frame}, units {eset.declared_units} (x{eset.scale_to_mm:g} to mm)")
        write(f"  contacts {len(eset.contacts)} ({counts}), missing coordinates {eset.n_missing}")
        for ctype in _types(eset):
            pts = eset.xyz_for(ctype)
            for name, surfaces in refs.items():
                hemis = eset.hemispheres_for(ctype)
                write(f"  [{ctype}] vs {name}: {_fmt(fit(pts, surfaces, ctype, hemis))}")
            for group in find_subject_surfaces(dataset, item.subject):
                try:
                    surfs: list[Surface] = [read_surface(p) for p in group]
                except GeometryRefusal as exc:
                    write(f"  [{ctype}] surface {group[0].parent.name}: refused {exc.reason}")
                    continue
                c_ras = next((s.c_ras for s in surfs if s.c_ras is not None), None)
                result = fit_with_offset(pts, surfs, ctype, c_ras, eset.hemispheres_for(ctype))
                where = "+".join(sorted(p.name for p in group))
                write(f"  [{ctype}] vs subject surface {where}:")
                write(f"      as declared: {_fmt(result.as_declared)}")
                if result.with_c_ras is not None and result.c_ras is not None:
                    c = ", ".join(f"{v:.2f}" for v in result.c_ras)
                    write(f"      with c_ras ({c}) subtracted: {_fmt(result.with_c_ras)}")
                write(f"      preferred: {result.preferred}")
        if not _types(eset) and eset.contacts:
            write(f"  no contact has all of x, y, z ({UNKNOWN} types included)")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ieeg_geometry")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("inspect", help="report frame, units, contacts and surface fits (read-only)")
    p.add_argument("dataset_dir", type=Path)
    args = parser.parse_args(argv)
    return inspect(args.dataset_dir)


if __name__ == "__main__":
    raise SystemExit(main())
