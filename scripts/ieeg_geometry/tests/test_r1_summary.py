"""The R1 summary tool over a tiny directory of reports (no network)."""

from __future__ import annotations

import importlib.util
import io
import json
import tarfile
from contextlib import redirect_stdout
from pathlib import Path

import pytest

TOOL = Path(__file__).resolve().parents[1] / "tools" / "r1_summary.py"
spec = importlib.util.spec_from_file_location("r1_summary", TOOL)
assert spec is not None and spec.loader is not None
r1 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r1)


def decision(status="skipped", reason="", evidence=None, numbers=None):
    return {
        "status": status,
        "reason": reason,
        "evidence": evidence,
        "numbers": numbers or {},
        "outputs": [],
    }


def report(dataset: str, labels: dict) -> dict:
    skip = decision("skipped", "n/a")
    track = {"freesurfer": skip, "spm": skip, "surfaces": skip, "labels": labels}
    counts = {s: 0 for s in r1.STATUSES}
    return {
        "dataset": dataset,
        "files": [
            {
                "electrodes": f"sub-1/ieeg/sub-1_{dataset}_electrodes.tsv",
                "subject": "1",
                "session": None,
                "space": None,
                "decisions": track,
            }
        ],
        "counts": {"electrodes_files": 1, "by_track": {}, "changes": counts},
        "changes": {"add": ["a", "b"], "change": [], "remove": [], "kept": []},
        "surface_entries": [],
    }


@pytest.fixture
def reports_dir(tmp_path: Path) -> Path:
    d = tmp_path / "reports"
    d.mkdir()
    written = decision(
        "written", "README 'MNI305'", "specific", {"label": "fsaverage", "median_mm": 0.95}
    )
    needs = decision("needs-human", "MNI variant unknown")
    (d / "on000001.json").write_text(json.dumps(report("on000001", written)))
    (d / "nm000002.json").write_text(json.dumps(report("nm000002", needs)))
    return d


@pytest.fixture
def census(tmp_path: Path) -> Path:
    c = tmp_path / "census.csv"
    c.write_text("id\non000001\nnm000002\non000003\n")
    return c


def run(reports: Path, census: Path) -> str:
    buf = io.StringIO()
    with redirect_stdout(buf):
        assert r1.main([str(reports), str(census)]) == 0
    return buf.getvalue()


def test_totals_and_missing(reports_dir: Path, census: Path) -> None:
    out = run(reports_dir, census)
    assert "Census ids: 3; reports: 2; failed to run: 1" in out
    assert "Missing with no recorded failure: ['on000003']" in out
    assert "| labels | 1 | 0 | 0 | 1 | 0 | 0 |" in out
    assert "- datasets gaining dataset files (labels, freesurfer or spm): 1: on000001" in out
    assert "| nm000002 | 1 |" in out


def test_label_margin_uses_the_on_vertex_rule(reports_dir: Path, census: Path) -> None:
    out = run(reports_dir, census)
    # 0.95 mm against 1.0 mm is a 5 percent margin; against 2.0 mm it would be 52.5 percent.
    assert "| labels | median_mm | 0.95 | 1.0 | 5.0% |" in out


def test_archive_matches_directory_and_refuses_duplicates(
    reports_dir: Path, census: Path, tmp_path: Path
) -> None:
    tgz = tmp_path / "r.tgz"
    with tarfile.open(tgz, "w:gz") as tar:
        for f in sorted(reports_dir.glob("*.json")):
            tar.add(f, arcname=f.name)
    assert run(tgz, census) == run(reports_dir, census)
    dup = tmp_path / "dup.tgz"
    with tarfile.open(dup, "w:gz") as tar:
        tar.add(reports_dir / "on000001.json", arcname="a/on000001.json")
        tar.add(reports_dir / "on000001.json", arcname="b/on000001.json")
    with pytest.raises(ValueError, match="duplicate report"):
        r1.load_reports(dup)


def test_oversized_member_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(r1, "MAX_REPORT_BYTES", 10)
    tgz = tmp_path / "big.tgz"
    f = tmp_path / "on000001.json"
    f.write_text(json.dumps({"x": "y" * 50}))
    with tarfile.open(tgz, "w:gz") as tar:
        tar.add(f, arcname=f.name)
    with pytest.raises(ValueError, match="over"):
        r1.load_reports(tgz)


def test_new_report_numbers_are_judged_and_rules_listed(tmp_path: Path, census: Path) -> None:
    d = tmp_path / "reports"
    d.mkdir()
    spm_numbers = {"field_check_centroid_mm": 8.7, "field_check_extent_deviation": 0.087}
    rep = report(
        "on000001",
        decision(
            "written",
            "x",
            "specific",
            {"label": "fsaverage", "median_mm": 0.5, "label_rule": "on-vertex-1.0mm"},
        ),
    )
    rep["files"][0]["decisions"]["spm"] = decision("written", "p", "plausible", spm_numbers)
    (d / "on000001.json").write_text(json.dumps(rep))
    out = run(d, census)
    assert "| spm | field_check_centroid_mm | 8.7 | 10.0 | 13.0% |" in out
    assert "| spm | field_check_extent_deviation | 0.087 | 0.1 | 13.0% |" in out
    assert "| labels label_rule | on-vertex-1.0mm | 1 |" in out
