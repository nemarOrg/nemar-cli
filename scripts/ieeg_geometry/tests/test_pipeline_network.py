"""The dry run end to end on public datasets, one per track and one with nothing to do.

Marked `network`: each run fetches exactly the files the tracks read into a work tree under the
cache outside the repository (`$IEEG_GEOMETRY_CACHE`, default `~/.cache/ieeg_geometry_tests`);
CI skips the marker. Run with `uv run pytest -q -m network tests/test_pipeline_network.py -s`;
the counts each run reports are printed. The dataset versions are those of 2026-11-19.
"""

import json
import os
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from ieeg_geometry import pipeline

pytestmark = pytest.mark.network

CACHE = Path(os.environ.get("IEEG_GEOMETRY_CACHE", Path.home() / ".cache" / "ieeg_geometry_tests"))
SCHEMA = json.loads(
    (Path(__file__).parents[1] / "schema" / "geometry-report.v1.json").read_text(encoding="utf-8")
)


def _dry_run(dataset_id: str) -> dict:
    analysis, written = pipeline.run_dataset(dataset_id, CACHE / "pipeline")
    assert written == []
    report = analysis.report
    assert not list(Draft202012Validator(SCHEMA).iter_errors(report))
    counts = report["counts"]
    print(
        f"\n{dataset_id} {report['dataset_version']} {report['source_commit'][:8]}: "
        f"{counts['electrodes_files']} electrodes files; "
        + "; ".join(
            f"{t} " + ", ".join(f"{s} {n}" for s, n in c.items() if n)
            for t, c in counts["by_track"].items()
        )
        + f"; would add {counts['changes']['add']}, change {counts['changes']['change']}, "
        f"remove {counts['changes']['remove']}"
    )
    return report


def _by_track(report: dict) -> dict:
    return report["counts"]["by_track"]


def test_on006107_labels():
    """Contacts on fsaverage vertices and no sidecar: one sidecar per electrodes file."""
    report = _dry_run("on006107")
    labels = _by_track(report)["labels"]
    assert labels["written"] >= 150 and labels["refused"] <= 5
    assert report["counts"]["changes"]["add"] > labels["written"]  # plus the ownership record
    assert report["counts"]["changes"]["change"] == report["counts"]["changes"]["remove"] == 0


def test_on004194_freesurfer():
    """FreeSurfer subjects with sphere.reg: cortical contacts written on fsaverage."""
    report = _dry_run("on004194")
    fs = _by_track(report)["freesurfer"]
    assert fs["written"] >= 10
    assert _by_track(report)["surfaces"]["written"] >= 10
    assert _by_track(report)["labels"]["written"] == 0


def test_on004457_spm_and_surfaces():
    """Five patients with SPM `y_` fields, one hemisphere each."""
    report = _dry_run("on004457")
    assert _by_track(report)["spm"]["written"] == 4
    assert _by_track(report)["surfaces"]["written"] == 6
    assert _by_track(report)["freesurfer"]["written"] == 0
    assert report["warnings"] == []


def test_a_dataset_with_nothing_to_do_changes_nothing():
    report = _dry_run("on004859")
    by_track = _by_track(report)
    assert all(by_track[t]["written"] == 0 for t in by_track)
    assert report["changes"] == {"add": [], "change": [], "remove": [], "kept": []}
    assert report["warnings"] == []
