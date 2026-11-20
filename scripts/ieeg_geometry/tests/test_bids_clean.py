"""Every electrodes.tsv the pipeline writes is valid BIDS, whatever the source looked like.

The last test runs the real pinned BIDS validator (the invocation the central workflow uses)
and is marked `network`: it needs deno and downloads the validator once.
"""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from ieeg_geometry.bids_clean import electrodes_tsv, sidecar_columns
from ieeg_geometry.labels import _tsv_in_mm

REPO_ROOT = Path(__file__).resolve().parents[3]
SOURCE = (
    "name\tx\ty\tz\tsize\themisphere\tseizure_zone\tDestrieux_label\tDestrieux_label_text\n"
    "LX1\t-2.664\t33.204\t4.375\tNaN\tL\tn/a\t11106\tlh_G&S_cingul-Ant\n"
    "LX2\t-6.335\t34.148\t6.285\tNaN\tL\tn/a\t11106\tlh_G&S_cingul-Ant\n"
    "RX1\t5.1\t30.2\t\tnan\tr\tyes\t\t\n"
)
EXTRA = ("seizure_zone", "Destrieux_label", "Destrieux_label_text")


def _dataset(tmp_path: Path, tsv: str = SOURCE) -> tuple[Path, Path]:
    root = tmp_path / "ds"
    folder = root / "sub-01" / "ieeg"
    folder.mkdir(parents=True)
    (root / "dataset_description.json").write_text(
        json.dumps({"Name": "t", "BIDSVersion": "1.9.0", "DatasetType": "raw"})
    )
    source = folder / "sub-01_electrodes.tsv"
    source.write_text(tsv)
    return root, source


def _table(data: bytes) -> list[list[str]]:
    return [line.split("\t") for line in data.decode().splitlines()]


def test_nan_sizes_and_undefined_columns_are_cleaned(tmp_path):
    root, source = _dataset(tmp_path)
    data = _tsv_in_mm(source, 1.0, source.with_name("sub-01_space-ACPC_electrodes.tsv"))
    text = data.decode()
    assert "nan" not in text.lower()
    header, *rows = _table(data)
    assert header == ["name", "x", "y", "z", "size", "hemisphere"]
    assert [r[4] for r in rows] == ["n/a", "n/a", "n/a"]
    assert rows[2] == ["RX1", "5.1", "30.2", "n/a", "n/a", "R"]
    assert not set(EXTRA) & set(header)


def test_a_column_the_dataset_defines_is_kept_by_inheritance(tmp_path):
    root, source = _dataset(tmp_path)
    (root / "electrodes.json").write_text(json.dumps({"seizure_zone": {"Description": "x"}}))
    # a sidecar for another subject does not apply
    (root / "sub-01" / "ieeg" / "sub-02_electrodes.json").write_text(
        json.dumps({"Destrieux_label": {"Description": "x"}})
    )
    out = source.with_name("sub-01_space-ACPC_electrodes.tsv")
    assert sidecar_columns(out) == {"seizure_zone"}
    header, *rows = _table(_tsv_in_mm(source, 1.0, out))
    assert header == ["name", "x", "y", "z", "size", "hemisphere", "seizure_zone"]
    assert rows[2][-1] == "yes"


def test_a_sidecar_with_a_space_entity_applies_only_to_that_space(tmp_path):
    root, source = _dataset(tmp_path)
    (root / "sub-01" / "ieeg" / "sub-01_space-ACPC_electrodes.json").write_text(
        json.dumps({"seizure_zone": {}})
    )
    other = source.with_name("sub-01_space-MNI_electrodes.tsv")
    assert sidecar_columns(other) == set()
    assert sidecar_columns(source.with_name("sub-01_space-ACPC_electrodes.tsv")) == {"seizure_zone"}


def test_required_columns_come_first_and_size_is_added(tmp_path):
    root, source = _dataset(tmp_path, "type\tz\ty\tx\tname\nseeg\t3\t2\t1\tA1\n")
    data = _tsv_in_mm(source, 1.0, source.with_name("sub-01_space-ACPC_electrodes.tsv"))
    header, row = _table(data)
    assert header == ["name", "x", "y", "z", "size", "type"]
    assert row == ["A1", "1", "2", "3", "n/a", "seeg"]


def test_non_numeric_numbers_and_bad_hemispheres_become_na(tmp_path):
    root, source = _dataset(tmp_path)
    data = electrodes_tsv(
        ["name", "x", "y", "z", "size", "impedance", "hemisphere"],
        [
            {
                "name": "A",
                "x": "1",
                "y": "inf",
                "z": "",
                "size": "big",
                "impedance": "5",
                "hemisphere": "x",
            }
        ],
        source.with_name("sub-01_space-ACPC_electrodes.tsv"),
    )
    assert _table(data)[1] == ["A", "1", "n/a", "n/a", "n/a", "5", "n/a"]


def test_scaled_coordinates_keep_missing_as_na(tmp_path):
    root, source = _dataset(tmp_path)
    data = _tsv_in_mm(source, 10.0, source.with_name("sub-01_space-ACPC_electrodes.tsv"))
    rows = _table(data)[1:]
    assert rows[0][1:4] == ["-26.64", "332.04", "43.75"]
    assert rows[2][3] == "n/a"


def test_output_is_deterministic(tmp_path):
    root, source = _dataset(tmp_path)
    out = source.with_name("sub-01_space-ACPC_electrodes.tsv")
    assert _tsv_in_mm(source, 1.0, out) == _tsv_in_mm(source, 1.0, out)


@pytest.mark.network
@pytest.mark.skipif(shutil.which("deno") is None, reason="deno is not installed")
def test_the_pinned_validator_finds_no_error_in_the_written_file(tmp_path):
    pin = json.loads((REPO_ROOT / "validator-version.json").read_text())["version"]
    root, source = _dataset(tmp_path)
    folder = source.parent
    (folder / "sub-01_space-ACPC_coordsystem.json").write_text(
        json.dumps(
            {
                "iEEGCoordinateSystem": "ACPC",
                "iEEGCoordinateUnits": "mm",
                "iEEGCoordinateSystemDescription": "x",
            }
        )
    )
    written = folder / "sub-01_space-ACPC_electrodes.tsv"

    def errors(tsv: Path) -> list[str]:
        shutil.copy(tsv, written)
        run = subprocess.run(
            [
                "deno",
                "run",
                "-A",
                f"jsr:@bids/validator@{pin}",
                str(root),
                "--json",
                "--ignoreWarnings",
            ],
            cwd=tmp_path,
            capture_output=True,
            text=True,
            check=False,
        )
        issues = json.loads(run.stdout)["issues"]["issues"]
        return [
            i["code"]
            for i in issues
            if i["location"].endswith(written.name) and i["severity"] == "error"
        ]

    before = errors(source)  # the source copied verbatim, as the pipeline used to do
    clean = tmp_path / "clean.tsv"
    clean.write_bytes(_tsv_in_mm(source, 1.0, written))
    after = errors(clean)
    assert "TSV_VALUE_INCORRECT_TYPE" in before
    assert "TSV_ADDITIONAL_COLUMNS_MUST_DEFINE" in before
    assert after == []
