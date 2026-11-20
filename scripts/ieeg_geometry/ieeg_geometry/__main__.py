"""Command line.

`python -m ieeg_geometry inspect <dataset-dir>` reports one checkout (read-only).
`python -m ieeg_geometry run <dataset-id> --workdir DIR [--version V] [--apply]
[--surfaces-out DIR]` fetches what a dataset's geometry needs, runs every track and prints one
JSON report; it writes into the work tree only with `--apply`.
`python -m ieeg_geometry pr <dataset-id> --workdir DIR [--version V] [--bump-version]
[--surfaces-out DIR]
[--dry-run]` opens the dataset pull request (see `pr.py`); `python -m ieeg_geometry
upload-surfaces <dataset-id> --surfaces DIR [--bucket B] [--profile P] [--dry-run]` puts the
subject surfaces on the data plane (see `upload.py`).
"""

from __future__ import annotations

import argparse
import sys
from importlib import metadata
from pathlib import Path

from . import fetch, freesurfer, labels, pipeline, pr, spm, upload
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
    try:
        proposals = {p.electrodes: p for p in labels.plan_dataset(dataset).proposals}
    except metadata.PackageNotFoundError as exc:
        proposals = {}
        write(f"label proposals unavailable: the ieeg-geometry package version is unknown ({exc})")
    if not items:
        write(f"no electrodes.tsv found under sub-* in {dataset}")
        return 1
    for item in items:
        label = f"sub-{item.subject}" + (f" ses-{item.session}" if item.session else "")
        label += f" space-{item.space}" if item.space else " (no space entity)"
        write(f"{label}: {item.electrodes_path.relative_to(dataset)}")
        proposal = proposals.get(item.electrodes_path.relative_to(dataset).as_posix())
        for line in proposal.lines() if proposal else []:
            write(f"  {line}")
        try:
            eset = read_electrode_set(item)
        except GeometryRefusal as exc:
            write(f"  refused: {exc.reason} ({exc.message})")
            continue
        for warning in eset.warnings:
            write(f"  warning: {warning}")
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
    _write_suppressed(proposals, write)
    freesurfer.inspect_dataset(dataset, out)
    spm_lines = spm.report(spm.plan_dataset(dataset), dataset)
    if spm_lines:
        write()
        for line in spm_lines:
            write(line)
    return 0


def _write_suppressed(proposals: dict, write) -> None:
    """Dataset-level reasons that stopped blind trials, with the files they affect."""
    by_reason: dict[str, list[str]] = {}
    for proposal in proposals.values():
        for reason in proposal.suppressed:
            by_reason.setdefault(reason, []).append(proposal.electrodes)
    for reason, files in sorted(by_reason.items()):
        write()
        write(f"blind trials suppressed by {reason} ({len(files)} file(s) need a human label):")
        for name in files[:20]:
            write(f"  {name}")
        if len(files) > 20:
            write(f"  and {len(files) - 20} more")


def run(args: argparse.Namespace, out=None, urls: dict[str, str] | None = None) -> int:
    """The `run` subcommand: exit 0 on a report, 1 when the run cannot proceed, 2 when a track
    failed unexpectedly (the report is still printed)."""
    try:
        analysis, written = pipeline.run_dataset(
            args.dataset_id,
            args.workdir,
            version=args.version,
            do_apply=args.apply,
            surfaces_out=args.surfaces_out,
            repo_url=(urls or {}).get("repo_url"),
            data_url=(urls or {}).get("data_url"),
            api_url=(urls or {}).get("api_url"),
        )
    except (pipeline.RefusedDataset, fetch.FetchError, GeometryRefusal) as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 1
    except metadata.PackageNotFoundError as exc:
        print(
            f"the ieeg-geometry package is not installed, so no version is known: {exc}",
            file=sys.stderr,
        )
        return 1
    report = analysis.report
    if args.apply and args.surfaces_out is None:
        report["warnings"] = sorted(
            [*report["warnings"], "surfaces not written: no --surfaces-out"]
        )
    (out or sys.stdout).write(pipeline.report_json(report))
    return 2 if analysis.errors else 0


def open_pr(args: argparse.Namespace, urls: dict[str, str] | None = None) -> int:
    """The `pr` subcommand: exit 0 with the URL (or the dry-run body), 1 on a refusal."""
    try:
        pr.open_pr(
            args.dataset_id,
            args.workdir,
            version=args.version,
            bump_version=args.bump_version,
            dry_run=args.dry_run,
            surfaces_out=args.surfaces_out,
            urls=urls,
            expect_remote=(urls or {}).get("repo_url"),  # only tests pass urls
        )
    except (pr.PrRefusal, pipeline.RefusedDataset, fetch.FetchError, GeometryRefusal) as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 1
    except metadata.PackageNotFoundError as exc:
        print(f"the ieeg-geometry package is not installed: {exc}", file=sys.stderr)
        return 1
    return 0


def upload_surfaces(args: argparse.Namespace) -> int:
    """The `upload-surfaces` subcommand: exit 0 when done, 1 on a refusal or an aws failure."""
    try:
        upload.upload(
            args.dataset_id,
            args.surfaces,
            bucket=args.bucket,
            profile=args.profile,
            dry_run=args.dry_run,
        )
    except (upload.UploadRefusal, pipeline.RefusedDataset) as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 1
    return 0


def main(argv: list[str] | None = None, urls: dict[str, str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ieeg_geometry")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("inspect", help="report frame, units, contacts and surface fits (read-only)")
    p.add_argument("dataset_dir", type=Path)
    r = sub.add_parser("run", help="one pipeline over a dataset; JSON report on standard output")
    r.add_argument("dataset_id", help="for example on004457")
    r.add_argument("--version", default=None, help="dataset version (default: the latest release)")
    r.add_argument("--workdir", type=Path, required=True, help="where the git work tree lives")
    r.add_argument("--apply", action="store_true", help="write into the work tree (never commits)")
    r.add_argument("--surfaces-out", type=Path, default=None, help="where --apply puts geometry/")
    o = sub.add_parser("pr", help="open the dataset pull request with the pipeline's outputs")
    o.add_argument("dataset_id", help="for example on004457")
    o.add_argument("--version", default=None, help="dataset version (default: the latest release)")
    o.add_argument("--workdir", type=Path, required=True, help="a directory for the fresh clone")
    o.add_argument("--surfaces-out", type=Path, default=None, help="where geometry/ is written")
    o.add_argument(
        "--bump-version",
        action="store_true",
        help="also set Version in dataset_description.json to the next patch (merging tags it)",
    )
    o.add_argument("--dry-run", action="store_true", help="everything but the push and the PR")
    u = sub.add_parser("upload-surfaces", help="put the subject surfaces on the data plane")
    u.add_argument("dataset_id", help="for example on004457")
    u.add_argument("--surfaces", type=Path, required=True, help="the directory holding geometry/")
    u.add_argument("--bucket", default=upload.BUCKET, help="default: %(default)s")
    u.add_argument("--profile", default=None, help="the AWS profile to use")
    u.add_argument("--dry-run", action="store_true", help="list the plan, write nothing")
    args = parser.parse_args(argv)
    if args.command == "run":
        return run(args, urls=urls)
    if args.command == "pr":
        return open_pr(args, urls=urls)
    if args.command == "upload-surfaces":
        return upload_surfaces(args)
    return inspect(args.dataset_dir)


if __name__ == "__main__":
    raise SystemExit(main())
