import json
import subprocess
from pathlib import Path

import pytest

from ieeg_geometry.bids import GeometryRefusal
from ieeg_geometry.ownership import (
    OwnedPath,
    Verification,
    blob_id,
    read_ownership,
    write_ownership,
)
from ieeg_geometry.verify import Fit


def _entries(tmp_path: Path):
    fit = Fit(
        1.23456,
        2.0,
        3.5,
        40,
        42,
        "rule",
        "plausible",
        0.875,
        0.975,
        True,
        1,
        2,
        None,
        (-3.1, 10.2, -16.3),
    )
    v = Verification.from_fit(fit, "fsaverage")
    return [
        OwnedPath(
            "sub-1/ieeg/sub-1_space-fsaverage_electrodes.tsv",
            "electrodes",
            (("sub-1/ieeg/sub-1_electrodes.tsv", "b" * 40), ("a/surf", "a" * 40)),
            "label-verified",
            v,
        ),
        OwnedPath(
            "sub-1/ieeg/sub-1_space-fsaverage_coordsystem.json",
            "coordsystem",
            (),
            "label-verified",
            None,
        ),
    ]


def test_round_trip_is_byte_identical_on_rerun(tmp_path):
    first = write_ownership(tmp_path, "0.1.0", _entries(tmp_path))
    path = tmp_path / ".nemar" / "ieeg-geometry.json"
    stamp = path.stat().st_mtime_ns
    second = write_ownership(tmp_path, "0.1.0", list(reversed(_entries(tmp_path))))
    assert first == second == path.read_bytes()
    assert path.stat().st_mtime_ns == stamp  # unchanged bytes are not rewritten
    doc = json.loads(first)
    assert doc["schema"] == 1 and doc["pipeline_version"] == "0.1.0"
    assert list(doc["paths"]) == sorted(doc["paths"])
    assert (
        doc["paths"]["sub-1/ieeg/sub-1_space-fsaverage_electrodes.tsv"]["verification"]["median_mm"]
        == 1.235
    )


def test_read_returns_what_was_written(tmp_path):
    entries = _entries(tmp_path)
    write_ownership(tmp_path, "0.1.0", entries)
    got = read_ownership(tmp_path)
    assert got is not None and got.pipeline_version == "0.1.0"
    by_path = {e.path: e for e in got.entries}
    first = by_path[entries[0].path]
    assert first.inputs == (("a/surf", "a" * 40), ("sub-1/ieeg/sub-1_electrodes.tsv", "b" * 40))
    v = first.verification
    assert v is not None and v.passed and v.grade == "plausible"
    assert (v.inside_evaluated, v.n_ambiguous, v.n_left_out) == (True, 1, 2)
    assert v.near_or_inside_fraction == 0.975 and v.offset_applied == (-3.1, 10.2, -16.3)
    assert read_ownership(tmp_path / "nothing") is None


def test_changed_input_changes_the_bytes(tmp_path):
    a = write_ownership(tmp_path, "0.1.0", _entries(tmp_path))
    changed = _entries(tmp_path)
    changed[0] = OwnedPath(changed[0].path, "electrodes", (("x", "c" * 40),), "m", None)
    assert write_ownership(tmp_path, "0.1.0", changed) != a


def test_duplicate_path_and_foreign_schema_are_refused(tmp_path):
    entries = _entries(tmp_path)
    with pytest.raises(GeometryRefusal):
        write_ownership(tmp_path, "0.1.0", entries + entries[:1])
    write_ownership(tmp_path, "0.1.0", entries)
    path = tmp_path / ".nemar" / "ieeg-geometry.json"
    doc = json.loads(path.read_text())
    doc["schema"] = 2
    path.write_text(json.dumps(doc))
    with pytest.raises(GeometryRefusal) as exc:
        read_ownership(tmp_path)
    assert exc.value.reason == "ownership-schema"


def test_blob_id_matches_git(tmp_path):
    f = tmp_path / "x.txt"
    f.write_bytes(b"hello\nworld\n")
    expected = (
        subprocess.run(
            ["git", "hash-object", "--no-filters", "--stdin"],
            input=f.read_bytes(),
            capture_output=True,
            check=True,
            cwd=tmp_path,
        )
        .stdout.decode()
        .strip()
    )
    assert blob_id(f) == blob_id(b"hello\nworld\n") == expected


def test_unreadable_json_is_a_refusal(tmp_path):
    (tmp_path / ".nemar").mkdir()
    (tmp_path / ".nemar" / "ieeg-geometry.json").write_text("{not json")
    with pytest.raises(GeometryRefusal) as exc:
        read_ownership(tmp_path)
    assert exc.value.reason == "ownership-unreadable"


def test_blob_id_of_a_symlink_is_its_target_text(tmp_path):
    target = ".git/annex/objects/XX/YY/SHA256E-s10--abc.eeg/SHA256E-s10--abc.eeg"
    link = tmp_path / "sub-1_ieeg.edf"
    link.symlink_to(target)  # dangling: the annexed content is not present
    # what git stores for a symlink: the blob id git itself assigns when the link is added
    subprocess.run(["git", "init", "-q"], check=True, cwd=tmp_path)
    subprocess.run(["git", "add", link.name], check=True, cwd=tmp_path)
    staged = subprocess.run(
        ["git", "ls-files", "-s", link.name], capture_output=True, check=True, cwd=tmp_path
    ).stdout.decode()
    assert staged.startswith("120000 ")
    expected = staged.split()[1]
    assert blob_id(link) == blob_id(target) == expected
