"""One pipeline over a dataset: labels, FreeSurfer, SPM, then the subject surfaces.

`analyze` plans every track against one snapshot of the work tree and builds the report;
nothing is written. `apply` writes the plans into the work tree (and the surfaces into a
directory) after the same snapshot, never committing, pushing, opening a pull request or
uploading. The decision logic of each track stays in its own module; this module orders the
tracks, applies the cross-track rule (lead ruling 4 across tracks: a later track never writes
a subject-and-space that the authors or an earlier track already cover in this run), and
describes the outcome.

Order: labels, then FreeSurfer, then SPM, then the subject surfaces for the display index.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from . import freesurfer, labels, spm, surfaces_out
from .bids import Discovered, GeometryRefusal, discover
from .ownership import OwnedPath, read_ownership
from .version import pipeline_version

REPORT_SCHEMA = "nemar-ieeg-geometry-report"
REPORT_VERSION = 1
TRACKS = ("labels", "freesurfer", "spm", "surfaces")
STATUSES = ("written", "unchanged", "kept", "needs-human", "refused", "skipped")
# live or standing datasets that no run may touch (AGENTS.md: live datasets, standing fixtures)
PROTECTED_IDS = frozenset({"nm000103", "nm000104", "nm000105", "nm000106", "nm000107", "nm099998"})
_ID = re.compile(r"[a-z]{2}[0-9]{6}")
OWNERSHIP_REL = ".nemar/ieeg-geometry.json"
EARLIER_TRACK = "covered-by-earlier-track"


class RefusedDataset(Exception):
    """The dataset id may not be processed."""


def check_dataset_id(dataset_id: str) -> str:
    if not _ID.fullmatch(dataset_id):
        raise RefusedDataset(f"{dataset_id!r} is not a dataset id such as on004457")
    if dataset_id in PROTECTED_IDS:
        raise RefusedDataset(f"{dataset_id} is a live or standing dataset; the run refuses it")
    return dataset_id


# ---- small helpers ----------------------------------------------------------------------------


def _num(v: float | None, digits: int = 3) -> float | None:
    if v is None or isinstance(v, bool):
        return v
    return None if math.isnan(v) or math.isinf(v) else round(float(v), digits)


def _rel(path: Path, dataset: Path) -> str:
    return path.relative_to(dataset).as_posix()


def _space_of(path: str) -> str | None:
    m = re.search(r"_space-([A-Za-z0-9]+)", Path(path).name)
    return m.group(1) if m else None


def _entity(path: str, key: str) -> str | None:
    m = re.search(rf"(?:^|_){key}-([A-Za-z0-9]+)", Path(path).name)
    return m.group(1) if m else None


def _decision(
    status: str,
    reason: str = "",
    *,
    evidence: str | None = None,
    numbers: dict | None = None,
    outputs: list[str] | None = None,
) -> dict:
    assert status in STATUSES, status
    return {
        "status": status,
        "reason": reason,
        "evidence": evidence,
        "numbers": {k: v for k, v in sorted((numbers or {}).items())},
        "outputs": sorted(outputs or []),
    }


def _file_changes(dataset: Path, files: dict[str, bytes], owned: dict[str, OwnedPath]) -> dict:
    """How a set of bytes stands against the disk: add, change, same, blocked (kept)."""
    out: dict[str, list[str]] = {"add": [], "change": [], "same": [], "blocked": []}
    unit_blocked = False
    for rel, data in sorted(files.items()):
        target = dataset / rel
        if not os.path.lexists(target):
            out["add"].append(rel)
        elif target.is_symlink():
            unit_blocked = True
        else:
            disk = target.read_bytes()
            entry = owned.get(rel)
            if disk == data:
                out["same"].append(rel)
            elif (
                entry is not None
                and entry.output_sha256 is not None
                and (_sha(disk) == entry.output_sha256)
            ):
                out["change"].append(rel)
            else:
                unit_blocked = True
    if unit_blocked:  # an electrodes file and its coordsystem are one unit
        out = {"add": [], "change": [], "same": [], "blocked": sorted(files)}
    return out


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _unit_status(changes: dict) -> str:
    if changes["blocked"]:
        return "kept"
    if changes["add"] or changes["change"]:
        return "written"
    return "unchanged"


# ---- cross-track coverage ---------------------------------------------------------------------


Coverage = dict[tuple[str, str | None], set[str]]


def _cover(covered: Coverage, subject: str, session: str | None, space: str) -> None:
    covered.setdefault((subject, session), set()).add(space.lower())


def label_coverage(plan: labels.Plan | None, dataset: Path) -> Coverage:
    """Subject-and-space pairs the label track writes in this run or owns from an earlier one.

    Only files that the track plans to write, and paths it already owns, count: a template file
    that another track owns is not the label track's cover.
    """
    covered: Coverage = {}
    for proposal in plan.proposals if plan else ():
        if proposal.files and proposal.label:
            # a sidecar for an unlabeled file declares that file's own frame: also cover
            _cover(covered, proposal.subject, proposal.session, proposal.label)
        for f in proposal.files:
            space = _space_of(f.path)
            if space:
                _cover(covered, proposal.subject, proposal.session, space)
    ownership = read_ownership(dataset)
    for entry in ownership.entries if ownership else []:
        space = _space_of(entry.path)
        sub = _entity(entry.path, "sub")
        if entry.method.startswith("label-inference") and space and sub:
            _cover(covered, sub, _entity(entry.path, "ses"), space)
    return covered


def guard_freesurfer(results: list[freesurfer.SubjectResult], covered: Coverage) -> None:
    """Move FreeSurfer outputs for a subject-and-space an earlier track covers to `skipped`."""
    for res in results:
        kept = []
        for out in res.outputs:
            if out.label.lower() in covered.get((res.subject, res.session), set()):
                res.skipped.append(
                    freesurfer.Refusal(
                        out.label,
                        EARLIER_TRACK,
                        f"the label track already covers space-{out.label} for this subject",
                    )
                )
            else:
                kept.append(out)
                _cover(covered, res.subject, res.session, out.label)
        res.outputs = kept


def guard_spm(plans: list[spm.SubjectPlan], covered: Coverage) -> dict[tuple[str, str | None], str]:
    """Turn SPM plans for a space an earlier track covers into refusals (stale files go)."""
    notes: dict[tuple[str, str | None], str] = {}
    for plan in plans:
        if plan.verdict != "write":
            continue
        if spm.LABEL.lower() in covered.get((plan.subject, plan.session), set()):
            notes[(plan.subject, plan.session)] = (
                f"an earlier track already covers space-{spm.LABEL} for this subject"
            )
            plan.verdict = "refused"
            plan.reason = notes[(plan.subject, plan.session)]
            plan.files, plan.owned = {}, []
    return notes


# ---- analysis ---------------------------------------------------------------------------------


@dataclass
class Analysis:
    dataset: Path
    dataset_id: str
    version: str
    source_commit: str
    pipeline_version: str
    label_plan: labels.Plan | None = None
    fs_results: list[freesurfer.SubjectResult] = field(default_factory=list)
    spm_plans: list[spm.SubjectPlan] = field(default_factory=list)
    surface_dir: Path | None = None
    surface_index: dict = field(default_factory=dict)
    errors: dict[str, str] = field(default_factory=dict)  # track -> unexpected error
    excluded: dict[str, str] = field(default_factory=dict)  # electrodes path -> fetch reason
    fetch_failed: dict[str, str] = field(default_factory=dict)
    electrodes_in_tree: list[str] = field(default_factory=list)
    spm_notes: dict[tuple[str, str | None], str] = field(default_factory=dict)
    report: dict = field(default_factory=dict)


def analyze(
    dataset: Path,
    *,
    dataset_id: str,
    version: str,
    source_commit: str,
    surface_dir: Path,
    excluded: dict[str, str] | None = None,
    fetch_failed: dict[str, str] | None = None,
    electrodes_in_tree: list[str] | None = None,
) -> Analysis:
    """Plan every track against the current snapshot and build the report. Writes nothing
    but the surface meshes into `surface_dir` (a scratch directory the caller owns)."""
    dataset = Path(dataset)
    check_dataset_id(dataset_id)
    a = Analysis(
        dataset,
        dataset_id,
        version,
        source_commit,
        pipeline_version(),
        excluded=dict(excluded or {}),
        fetch_failed=dict(fetch_failed or {}),
        electrodes_in_tree=list(electrodes_in_tree or []),
    )
    covered: Coverage = {}
    try:
        a.label_plan = labels.plan_dataset(dataset, a.pipeline_version)
    except Exception as exc:  # noqa: BLE001 - a track failure is reported, not fatal
        a.errors["labels"] = f"{type(exc).__name__}: {exc}"
    try:
        # also without a label plan: what the label track owns still guards the later tracks
        covered = label_coverage(a.label_plan, dataset)
    except Exception as exc:  # noqa: BLE001
        a.errors["labels"] = a.errors.get("labels", f"{type(exc).__name__}: {exc}")
    try:
        a.fs_results = freesurfer.plan_dataset(dataset)
        guard_freesurfer(a.fs_results, covered)
    except Exception as exc:  # noqa: BLE001
        a.errors["freesurfer"] = f"{type(exc).__name__}: {exc}"
    try:
        a.spm_plans = spm.plan_dataset(dataset)
        a.spm_notes = guard_spm(a.spm_plans, covered)
    except Exception as exc:  # noqa: BLE001
        a.errors["spm"] = f"{type(exc).__name__}: {exc}"
    try:
        a.surface_index, _lines = surfaces_out.build_geometry(
            dataset, surface_dir, source_commit=source_commit
        )
        a.surface_dir = surface_dir
    except Exception as exc:  # noqa: BLE001
        a.errors["surfaces"] = f"{type(exc).__name__}: {exc}"
    a.report = build_report(a)
    return a


# ---- per-track decisions ----------------------------------------------------------------------


def _labels_decisions(a: Analysis, owned: dict[str, OwnedPath]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    if a.label_plan is None:
        return out
    for p in a.label_plan.proposals:
        numbers: dict = {}
        evidence = None
        outputs = [f.path for f in p.files]
        if p.label:
            numbers["label"] = p.label
        if p.files:
            v = p.files[0].verification
            evidence = v.grade
            numbers |= {"median_mm": v.median_mm, "p90_mm": v.p90_mm, "n_used": v.n_used}
            if p.rule is not None:
                numbers["label_rule"] = p.rule
            if p.shift_control_min_mm is not None:
                numbers["shift_control_min_median_mm"] = p.shift_control_min_mm
        status = {
            labels.ACCEPTED: "written",
            labels.REJECTED: "refused",
            labels.NEEDS_HUMAN: "needs-human",
            labels.SKIPPED: "skipped",
            labels.KEPT: "kept",
            labels.ALREADY: "skipped",
        }[p.status]
        if p.status == labels.ALREADY and p.reason == "pipeline output unchanged":
            status = "unchanged"
        if p.status == labels.ACCEPTED:
            states = [labels._file_state(f, a.dataset, owned) for f in p.files]
            if all(s == "unchanged" for s in states):
                status = "unchanged"
        out[p.electrodes] = _decision(
            status, p.reason, evidence=evidence, numbers=numbers, outputs=outputs
        )
    return out


def _fs_decisions(a: Analysis, owned: dict[str, OwnedPath]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for res in a.fs_results:
        rel = _rel(res.source, a.dataset)
        outputs = [
            (_rel(o.electrodes_path, a.dataset), _rel(o.coordsystem_path, a.dataset))
            for o in res.outputs
        ]
        if res.outputs:
            status, reasons = "unchanged", []
            for o in res.outputs:
                files = {
                    _rel(o.electrodes_path, a.dataset): freesurfer._tsv_bytes(o),
                    _rel(o.coordsystem_path, a.dataset): freesurfer._json_bytes(o),
                }
                s = _unit_status(_file_changes(a.dataset, files, owned))
                status = _worst_written(status, s)
            f = res.outputs[0].frame_fit
            reg = res.outputs[0].registration
            numbers = {
                "frame_fit_median_mm": _num(f.median_mm),
                "n_placed": res.n_surface,
                "left_out": dict(sorted(res.left_out.items())),
                "pial_distance_median_mm": _num(res.outputs[0].pial_distance_median_mm),
                "fit_rule": "ecog-2.0mm",
                "registration_side_fraction": _num(reg.side_fraction),
                "registration_centroid_mm": _num(reg.centroid_mm),
                "registration_extent_error": _num(reg.extent_error),
                "registration_affine_residual_mm": _num(reg.affine_residual_mm),
            }
            reasons = [f"{o.label}: {o.method}" for o in res.outputs]
            out[rel] = _decision(
                status,
                "; ".join(reasons),
                evidence=f.grade,
                numbers=numbers,
                outputs=[p for pair in outputs for p in pair],
            )
        elif res.refusals:
            r = res.refusals[0]
            out[rel] = _decision(
                "refused",
                f"{r.reason}: {r.message}",
                numbers={"left_out": dict(sorted(res.left_out.items()))},
            )
        elif res.skipped:
            r = res.skipped[0]
            out[rel] = _decision("skipped", f"{r.reason}: {r.message}")
        else:
            out[rel] = _decision("skipped", "nothing to place")
    return out


def _worst_written(a: str, b: str) -> str:
    order = {"unchanged": 0, "written": 1, "kept": 2}
    return a if order[a] >= order[b] else b


def _spm_decisions(a: Analysis, owned: dict[str, OwnedPath]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    plans = {(p.subject, p.session): p for p in a.spm_plans}
    for item in discover(a.dataset):
        rel = _rel(item.electrodes_path, a.dataset)
        plan = plans.get((item.subject, item.session))
        if plan is None:
            out[rel] = _decision("skipped", "no SPM deformation field for this subject")
            continue
        if plan.verdict == "write" and plan.chosen is not None:
            if plan.chosen.electrodes_path != item.electrodes_path:
                out[rel] = _decision(
                    "skipped", f"paired file is {_rel(plan.chosen.electrodes_path, a.dataset)}"
                )
                continue
            changes = _file_changes(a.dataset, plan.files, owned)
            inv, check = plan.inversion, plan.field_check
            head = spm._headline(plan.template_fit) if plan.template_fit else None
            numbers = {
                "inversion_residual_median_mm": _num(inv.median_residual) if inv else None,
                "field_check_median_mm": _num(check.median_mm) if check else None,
                "field_check_p10_mm": _num(check.p10_mm) if check else None,
                "field_check_centroid_mm": _num(check.centroid_mm) if check else None,
                "field_check_extent_deviation": _num(check.extent_deviation) if check else None,
                "inside_fraction": _num(head.inside_fraction) if head else None,
                # reported, not judged: the shell has no sulci (ruling 8)
                "depth_contact_median_mm": _num(head.median_mm) if head else None,
            }
            out[rel] = _decision(
                _unit_status(changes),
                f"paired by {plan.basis}",
                evidence=head.grade if head else None,
                numbers=numbers,
                outputs=list(plan.files),
            )
            continue
        status = {"skip": "skipped", "refused": "refused", "needs-human": "needs-human"}.get(
            plan.verdict, "skipped"
        )
        if (plan.subject, plan.session) in a.spm_notes:
            status = "skipped"
        check = plan.field_check
        numbers = (
            {
                "field_check_median_mm": _num(check.median_mm),
                "field_check_p10_mm": _num(check.p10_mm),
                "field_check_centroid_mm": _num(check.centroid_mm),
                "field_check_extent_deviation": _num(check.extent_deviation),
            }
            if check is not None
            else {}
        )
        out[rel] = _decision(status, plan.reason, numbers=numbers)
    return out


def _surface_decisions(a: Analysis) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for e in a.surface_index.get("entries", []):
        fit = e["fit"]
        out[e["electrodes"]] = _decision(
            "written",
            f"{'+'.join(e['hemispheres'])} from {e['sources'][0]}",
            evidence=fit["grade"],
            numbers={
                "median_mm": fit["median_mm"],
                "frame_choice": e["frame_choice"],
                "contact_type": e["contact_type"],
                "fit_rule": e["fit_rule"],
            },
            outputs=[m["path"] for m in e["meshes"].values()],
        )
    for e in a.surface_index.get("skipped", []):
        out[e["electrodes"]] = _decision("skipped", e["reason"])
    return out


# ---- changes ----------------------------------------------------------------------------------


def _changes(a: Analysis, owned: dict[str, OwnedPath]) -> dict[str, list[str]]:
    add: set[str] = set()
    change: set[str] = set()
    remove: set[str] = set()
    kept: set[str] = set()
    ownership_touched = False
    if a.label_plan is not None:
        for f in a.label_plan.files:
            state = labels._file_state(f, a.dataset, owned)
            if state == "new":
                add.add(f.path)
            elif state == "regenerate":
                change.add(f.path)
            ownership_touched |= state in ("new", "regenerate", "record")
        for p in a.label_plan.proposals:
            if p.status == labels.KEPT:
                kept.update(f.path for f in p.files)
    for res in a.fs_results:
        for o in res.outputs:
            files = {
                _rel(o.electrodes_path, a.dataset): freesurfer._tsv_bytes(o),
                _rel(o.coordsystem_path, a.dataset): freesurfer._json_bytes(o),
            }
            c = _file_changes(a.dataset, files, owned)
            add.update(c["add"])
            change.update(c["change"])
            kept.update(c["blocked"])
    if a.fs_results:
        remove.update(e.path for e in freesurfer.stale_outputs(a.dataset, a.fs_results))
        kept.update(freesurfer.hand_edited_outputs(a.dataset, a.fs_results))
    ownership = read_ownership(a.dataset)
    entries = {e.path: e for e in ownership.entries} if ownership else {}
    for plan in a.spm_plans:
        if plan.verdict == "write":
            c = _file_changes(a.dataset, plan.files, owned)
            add.update(c["add"])
            change.update(c["change"])
            kept.update(c["blocked"])
            keep = set(plan.files)
        elif plan.verdict in ("refused", "needs-human"):
            keep = set()
        else:
            continue
        removable, hand_edited = spm.stale_units(a.dataset, entries, plan, keep)
        for members in removable:
            remove.update(e.path for e in members if os.path.lexists(a.dataset / e.path))
        kept.update(e.path for e in hand_edited)
    if ownership_touched or add or change or remove:
        (change if os.path.lexists(a.dataset / OWNERSHIP_REL) else add).add(OWNERSHIP_REL)
    return {
        "add": sorted(add),
        "change": sorted(change - add),
        "remove": sorted(remove),
        "kept": sorted(kept),
    }


# ---- report -----------------------------------------------------------------------------------


def _skipped_everywhere(reason: str) -> dict[str, dict]:
    return {t: _decision("skipped", reason) for t in TRACKS}


def build_report(a: Analysis) -> dict:
    dataset = a.dataset
    ownership = read_ownership(dataset)
    owned = {e.path: e for e in ownership.entries} if ownership else {}
    per_track = {
        "labels": _labels_decisions(a, owned),
        "freesurfer": _fs_decisions(a, owned) if "freesurfer" not in a.errors else {},
        "spm": _spm_decisions(a, owned) if "spm" not in a.errors else {},
        "surfaces": _surface_decisions(a) if "surfaces" not in a.errors else {},
    }
    items: list[Discovered] = discover(dataset)
    rows: list[dict] = []
    for item in items:
        rel = _rel(item.electrodes_path, dataset)
        decisions = {}
        for track in TRACKS:
            if track in a.errors:
                decisions[track] = _decision("skipped", f"track failed: {a.errors[track]}")
            else:
                decisions[track] = per_track[track].get(
                    rel, _decision("skipped", "not reported by the track")
                )
        rows.append(
            {
                "electrodes": rel,
                "subject": item.subject,
                "session": item.session,
                "space": item.space,
                "decisions": decisions,
            }
        )
    seen = {r["electrodes"] for r in rows}
    for rel, reason in sorted(a.excluded.items()):
        if rel not in seen:
            rows.append(
                {
                    "electrodes": rel,
                    "subject": _entity(rel, "sub"),
                    "session": _entity(rel, "ses"),
                    "space": _space_of(rel),
                    "decisions": _skipped_everywhere(f"fetch failed: {reason}"),
                }
            )
    rows.sort(key=lambda r: r["electrodes"])
    warnings = sorted(
        {f"not fetched: {p}: {r}" for p, r in a.fetch_failed.items()}
        | {f"{t} track failed: {m}" for t, m in a.errors.items()}
        | {
            f"{p.electrodes}: {w}"
            for p in (a.label_plan.proposals if a.label_plan else ())
            for w in p.warnings
        }
    )
    suppressions: dict[str, list[str]] = {}
    for p in a.label_plan.proposals if a.label_plan else ():
        for reason in p.suppressed:
            suppressions.setdefault(reason, []).append(p.electrodes)
    counts: dict = {
        "electrodes_files": len(rows),
        "by_track": {
            t: {s: sum(r["decisions"][t]["status"] == s for r in rows) for s in STATUSES}
            for t in TRACKS
        },
    }
    changes = _changes(a, owned)
    counts["changes"] = {k: len(v) for k, v in changes.items()}
    return {
        "schema": REPORT_SCHEMA,
        "version": REPORT_VERSION,
        "dataset": a.dataset_id,
        "dataset_version": a.version,
        "source_commit": a.source_commit,
        "pipeline_version": a.pipeline_version,
        "files": rows,
        "suppressions": [
            {"reason": r, "files": sorted(f)} for r, f in sorted(suppressions.items())
        ],
        "warnings": warnings,
        "counts": counts,
        "changes": changes,
        "surface_entries": a.surface_index.get("entries", []),
    }


def report_json(report: dict) -> str:
    return json.dumps(report, indent=2, sort_keys=True, allow_nan=False) + "\n"


# ---- apply ------------------------------------------------------------------------------------


def recover_surfaces(surfaces_dir: Path | None) -> bool:
    """Restore `geometry/` from `.geometry.old` after a crash between the two renames."""
    if surfaces_dir is None:
        return False
    target, old = Path(surfaces_dir) / "geometry", Path(surfaces_dir) / ".geometry.old"
    if not target.exists() and old.is_dir():
        os.replace(old, target)
        return True
    return False


def apply(a: Analysis, surfaces_dir: Path | None) -> list[str]:
    """Write the analyzed plans into the work tree and the surfaces into `surfaces_dir`.

    Never commits, pushes, opens a pull request or uploads. Returns the work-tree paths
    written, relative to the dataset. Plans are written in track order against the same
    snapshot they were made from. Fails closed: when any track errored, nothing is written.
    """
    if a.errors:
        return []
    written: list[str] = []
    if a.label_plan is not None:
        written += [_rel(p, a.dataset) for p in labels.write(a.label_plan, a.dataset)]
    if a.fs_results:
        entries = freesurfer.write_outputs(a.dataset, a.fs_results)
        written += [e.path for e in entries]
    if a.spm_plans:
        written += spm.write(a.spm_plans, a.dataset)
    built = a.surface_dir / "geometry" if a.surface_dir is not None else None
    if surfaces_dir is not None and built is not None and built.is_dir():
        # `surfaces_dir/geometry` ends up exactly the new index and its meshes
        target = Path(surfaces_dir) / "geometry"
        staging = Path(surfaces_dir) / ".geometry.new"
        old = Path(surfaces_dir) / ".geometry.old"
        recover_surfaces(surfaces_dir)
        Path(surfaces_dir).mkdir(parents=True, exist_ok=True)
        shutil.rmtree(staging, ignore_errors=True)
        shutil.copytree(built, staging)
        # crash-safe swap: at every instant `geometry/` or `.geometry.old` holds a full copy
        if target.exists():
            os.replace(target, old)
        os.replace(staging, target)
        shutil.rmtree(old, ignore_errors=True)
    return sorted(set(written))


# ---- run --------------------------------------------------------------------------------------


def run_dataset(
    dataset_id: str,
    workdir: Path,
    *,
    version: str | None = None,
    do_apply: bool = False,
    surfaces_out: Path | None = None,
    repo_url: str | None = None,
    data_url: str | None = None,
    api_url: str | None = None,
) -> tuple[Analysis, list[str]]:
    """Fetch, analyze and (with `do_apply`) write. Returns the analysis and the written paths."""
    from . import fetch

    check_dataset_id(dataset_id)
    recover_surfaces(surfaces_out)  # before anything else, even a dry run
    pipeline_version()  # strict: a missing package fails here, before any network use
    workdir = Path(workdir)
    got = fetch.fetch_files(
        dataset_id,
        workdir,
        version=version,
        repo_url=repo_url or fetch.REPO_URL,
        data_url=data_url or fetch.DATA_URL,
        api_url=api_url or fetch.API_URL,
    )
    workdir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=workdir, prefix=".surfaces-") as tmp:
        a = analyze(
            got.clone,
            dataset_id=dataset_id,
            version=got.version,
            source_commit=got.commit,
            surface_dir=Path(tmp),
            excluded=got.excluded,
            fetch_failed=got.failed,
            electrodes_in_tree=got.electrodes_in_tree,
        )
        a.report["mode"] = "apply" if do_apply else "dry-run"
        if do_apply and a.errors:
            a.report["warnings"] = sorted([*a.report["warnings"], "apply skipped: a track failed"])
        written = apply(a, surfaces_out) if do_apply else []
    return a, written


__all__ = [
    "PROTECTED_IDS",
    "REPORT_SCHEMA",
    "REPORT_VERSION",
    "Analysis",
    "GeometryRefusal",
    "RefusedDataset",
    "analyze",
    "apply",
    "build_report",
    "check_dataset_id",
    "report_json",
    "run_dataset",
]
