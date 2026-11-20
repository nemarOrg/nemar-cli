"""Recompute the R1 dry-run totals from the per-dataset report files.

Usage, from the repository root:
    uv run --project scripts/ieeg_geometry python \
        scripts/ieeg_geometry/tools/r1_summary.py <reports-dir> <census.csv> \
        [--failures failures.json]

`<reports-dir>` holds one `<dataset-id>.json` per dataset (the output of
`python -m ieeg_geometry run <id>`, without `--apply`); a `.tgz` archive of them is also accepted.
`failures.json` maps a dataset id to the error text of a run that could not proceed.
Prints Markdown: totals per track and status, evidence grades, refusal reasons, needs-human
counts, datasets that would gain files, and every threshold margin within 15 percent.
Read-only; it never contacts the network.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import tarfile
from collections import Counter, defaultdict
from pathlib import Path

TRACKS = ("labels", "freesurfer", "spm", "surfaces")
STATUSES = ("written", "unchanged", "kept", "needs-human", "refused", "skipped")
NEAR = 0.15

# (track, number key): (limit, kind). "max" values must stay at or below the limit, "min" at or
# above. The ECoG median rule is 2.0 mm, the depth plausibility median 6.0 mm (rulings 1, 2, 9).
LIMITS = {
    ("freesurfer", "frame_fit_median_mm"): (2.0, "max"),
    ("freesurfer", "registration_affine_residual_mm"): (15.0, "max"),
    ("spm", "field_check_median_mm"): (6.0, "max"),
    ("spm", "field_check_p10_mm"): (2.0, "max"),
    ("spm", "inside_fraction"): (0.95, "min"),
}
MEDIAN_LIMIT = {"specific": 2.0, "plausible": 6.0}
LABEL_MEDIAN_LIMIT = 1.0


MAX_REPORT_BYTES = 5_000_000


def _add(reports: dict[str, dict], name: str, raw: bytes) -> None:
    stem = Path(name).stem
    if stem in reports:
        raise ValueError(f"duplicate report for {stem} ({name})")
    reports[stem] = json.loads(raw)


def load_reports(path: Path) -> dict[str, dict]:
    """Read `<id>.json` reports from a directory or a `.tgz`; refuse duplicates and big files."""
    reports: dict[str, dict] = {}
    if path.is_file():
        with tarfile.open(path) as tar:
            for m in tar.getmembers():
                if not (m.isfile() and m.name.endswith(".json")):
                    continue
                if Path(m.name).name.startswith("."):
                    continue
                if m.size > MAX_REPORT_BYTES:
                    raise ValueError(f"{m.name} is {m.size} bytes, over {MAX_REPORT_BYTES}")
                member = tar.extractfile(m)
                if member is None:
                    raise ValueError(f"{m.name} is not a regular file")
                _add(reports, m.name, member.read(MAX_REPORT_BYTES + 1))
    else:
        for f in sorted(path.glob("*.json")):
            if f.stat().st_size > MAX_REPORT_BYTES:
                raise ValueError(f"{f.name} is over {MAX_REPORT_BYTES} bytes")
            _add(reports, f.name, f.read_bytes())
    return reports


def census_ids(path: Path) -> list[str]:
    with path.open() as fh:
        return [row["id"] for row in csv.DictReader(fh)]


def normalize(reason: str) -> str:
    """Collapse numbers and subject-specific names so equal reasons count together."""
    text = re.sub(r"sub-[A-Za-z0-9]+", "sub-X", reason)
    text = re.sub(r"ses-[A-Za-z0-9]+", "ses-Y", text)
    text = re.sub(r"[0-9]+(\.[0-9]+)?", "N", text)
    return text[:120]


def margin(value: float, limit: float, kind: str) -> float:
    """Slack as a fraction of the limit (of the available range for a fraction near 1)."""
    if kind == "max":
        return (limit - value) / limit
    return (value - limit) / (1.0 - limit)


def margins(report: dict) -> list[dict]:
    out = []
    for f in report["files"]:
        for track, dec in f["decisions"].items():
            if dec["status"] not in ("written", "unchanged"):
                continue
            nums = dec["numbers"]
            checks = []
            for (t, key), (limit, kind) in LIMITS.items():
                if t == track and nums.get(key) is not None:
                    checks.append((key, nums[key], limit, kind))
            if track == "labels" and nums.get("median_mm") is not None:
                # README and blind labels are both written on the on-vertex rule with the
                # shift control (rulings 16 and 17).
                checks.append(("median_mm", nums["median_mm"], LABEL_MEDIAN_LIMIT, "max"))
            if track == "surfaces" and nums.get("median_mm") is not None:
                limit = MEDIAN_LIMIT.get(dec["evidence"] or "")
                if limit is not None:
                    checks.append(("median_mm", nums["median_mm"], limit, "max"))
            for key, value, limit, kind in checks:
                out.append(
                    {
                        "dataset": report["dataset"],
                        "electrodes": f["electrodes"],
                        "track": track,
                        "key": key,
                        "value": value,
                        "limit": limit,
                        "margin": margin(value, limit, kind),
                    }
                )
    for e in report["surface_entries"]:
        fit = e["fit"]
        checks = []
        if fit["grade"] == "plausible" and fit.get("near_or_inside_fraction") is not None:
            checks.append(("near_or_inside_fraction", fit["near_or_inside_fraction"], 0.90, "min"))
        dec = e.get("decimation") or {}
        for key, limit in (("median_shift_mm", 0.5), ("p99_deviation_mm", 1.0)):
            if dec.get(key) is not None:
                checks.append((key, dec[key], limit, "max"))
        for key, value, limit, kind in checks:
            out.append(
                {
                    "dataset": report["dataset"],
                    "electrodes": e["electrodes"],
                    "track": "surfaces",
                    "key": key,
                    "value": value,
                    "limit": limit,
                    "margin": margin(value, limit, kind),
                }
            )
    return out


def table(headers: list[str], rows: list[list]) -> str:
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    lines += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("reports", type=Path)
    p.add_argument("census", type=Path)
    p.add_argument("--failures", type=Path, default=None)
    args = p.parse_args(argv)

    reports = load_reports(args.reports)
    ids = census_ids(args.census)
    failures = json.loads(args.failures.read_text()) if args.failures else {}
    extra = sorted(set(reports) - set(ids))
    missing = [i for i in ids if i not in reports]
    unexplained = [i for i in missing if i not in failures]

    print(f"Census ids: {len(ids)}; reports: {len(reports)}; failed to run: {len(missing)}")
    if extra:
        print(f"Reports for ids outside the census: {extra}")
    if unexplained:
        print(f"Missing with no recorded failure: {unexplained}")
    for i in missing:
        print(f"- {i}: {failures.get(i, 'no error recorded')}")

    by_track = {t: Counter() for t in TRACKS}
    reasons: dict[tuple[str, str], Counter] = defaultdict(Counter)
    grades: dict[str, Counter] = {t: Counter() for t in TRACKS}
    gain: dict[str, dict[str, Counter]] = defaultdict(lambda: defaultdict(Counter))
    subjects: dict[str, dict[str, set]] = defaultdict(lambda: defaultdict(set))
    needs: Counter = Counter()
    label_medians: dict[str, list[float]] = defaultdict(list)
    files = 0
    adds = 0
    surface_entries = 0
    surface_subjects: set[tuple[str, str]] = set()
    near: list[dict] = []
    all_margins: list[dict] = []
    for ds, rep in sorted(reports.items()):
        files += rep["counts"]["electrodes_files"]
        adds += len(rep["changes"]["add"])
        surface_entries += len(rep["surface_entries"])
        for e in rep["surface_entries"]:
            subject = e["electrodes"].split("/")[0]
            surface_subjects.add((ds, subject))
        for f in rep["files"]:
            for t, d in f["decisions"].items():
                by_track[t][d["status"]] += 1
                if d["status"] in ("refused", "needs-human"):
                    reasons[t, d["status"]][normalize(d["reason"])] += 1
                    if d["status"] == "needs-human":
                        needs[ds] += 1
                if d["status"] in ("written", "unchanged"):
                    grades[t][d["evidence"] or "none"] += 1
                    gain[ds][t]["files"] += 1
                    if t == "labels" and d["numbers"].get("median_mm") is not None:
                        label_medians[ds].append(d["numbers"]["median_mm"])
                    subjects[ds][t].add(f["subject"])
        for m in margins(rep):
            all_margins.append(m)
            if m["margin"] <= NEAR:
                near.append(m)

    print("\n## Totals per track (electrodes files)\n")
    print(table(["track", *STATUSES], [[t, *(by_track[t][s] for s in STATUSES)] for t in TRACKS]))
    print(f"\nElectrodes files: {files}. Paths an apply would add (all datasets): {adds}.")
    print(
        f"Subject-surface entries: {surface_entries} "
        f"(distinct dataset and subject: {len(surface_subjects)})."
    )

    print("\n## Evidence grades of written decisions\n")
    print(
        table(
            ["track", "specific", "plausible", "other"],
            [
                [
                    t,
                    grades[t]["specific"],
                    grades[t]["plausible"],
                    sum(v for k, v in grades[t].items() if k not in ("specific", "plausible")),
                ]
                for t in TRACKS
            ],
        )
    )

    print("\n## Datasets that would gain files (written or unchanged decisions)\n")
    rows = []
    for ds in sorted(gain):
        for t in TRACKS:
            if gain[ds][t]["files"]:
                rows.append([ds, t, len(subjects[ds][t]), gain[ds][t]["files"]])
    print(table(["dataset", "track", "subjects", "electrodes files"], rows))
    for t in TRACKS:
        n_ds = sum(1 for ds in gain if gain[ds][t]["files"])
        n_sub = sum(len(subjects[ds][t]) for ds in gain)
        print(f"- {t}: {n_ds} datasets, {n_sub} subjects")
    gaining = [
        ds for ds in gain if any(gain[ds][t]["files"] for t in ("labels", "freesurfer", "spm"))
    ]
    print(
        "- datasets gaining dataset files (labels, freesurfer or spm): "
        f"{len(gaining)}: {', '.join(sorted(gaining))}"
    )

    print("\n## Release path of the datasets gaining dataset files\n")
    print(
        "- mirrors (`on`, one N.0.1 each): "
        + (", ".join(sorted(d for d in gaining if d.startswith("on"))) or "none")
    )
    print(
        "- pushed to NEMAR (`nm`, a pull request each): "
        + (", ".join(sorted(d for d in gaining if d.startswith("nm"))) or "none")
    )

    print("\n## Label medians (judged against the 1.0 mm on-vertex rule)\n")
    rows = []
    for ds in sorted(label_medians):
        v = sorted(label_medians[ds])
        rows.append(
            [
                ds,
                len(v),
                f"{v[len(v) // 2]:.3f}",
                f"{v[-1]:.3f}",
                sum(x > 0.85 for x in v),
                sum(x > 1.0 for x in v),
            ]
        )
    print(
        table(
            [
                "dataset",
                "files",
                "median of medians (mm)",
                "largest (mm)",
                "above 0.85",
                "above 1.0",
            ],
            rows,
        )
    )

    print("\n## Needs-human files per dataset\n")
    print(table(["dataset", "files"], [[d, n] for d, n in sorted(needs.items())]))
    print(f"\nTotal needs-human files: {sum(needs.values())} in {len(needs)} datasets.")

    print("\n## Refusal and needs-human reasons (files, normalized)\n")
    for (t, s), c in sorted(reasons.items()):
        print(f"### {t}, {s}\n")
        print(table(["files", "reason"], [[n, r] for r, n in c.most_common()]))
        print()

    print("## Threshold margins\n")
    for key in sorted({(m["track"], m["key"]) for m in all_margins}):
        vals = [m for m in all_margins if (m["track"], m["key"]) == key]
        worst = min(vals, key=lambda m: m["margin"])
        print(
            f"- {key[0]} {key[1]}: {len(vals)} values, limit {worst['limit']}, "
            f"closest {worst['value']} ({worst['dataset']} {worst['electrodes']}, "
            f"margin {worst['margin']:.1%})"
        )
    print(f"\nWritten values within {NEAR:.0%} of a threshold: {len(near)}\n")
    near.sort(key=lambda m: m["margin"])
    print(
        table(
            ["dataset", "file", "track", "number", "value", "limit", "margin"],
            [
                [
                    m["dataset"],
                    m["electrodes"],
                    m["track"],
                    m["key"],
                    m["value"],
                    m["limit"],
                    f"{m['margin']:.1%}",
                ]
                for m in near
            ],
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
