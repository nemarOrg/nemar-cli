"""Every electrodes.tsv the pipeline writes is valid BIDS, whatever the source looked like.

The last test runs the real pinned BIDS validator (the invocation the central workflow uses)
and is marked `network`: it needs deno and downloads the validator once.
"""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from ieeg_geometry.bids import GeometryRefusal, check_source_table
from ieeg_geometry.bids_clean import electrodes_tsv, sidecar_columns
from ieeg_geometry.labels import _tsv_in_mm as _labels_table

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


def _tsv_in_mm(path: Path, scale: float, output: Path) -> bytes:
    return _labels_table(path, scale, output).data


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
    table = electrodes_tsv(
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
    assert _table(table.data)[1] == ["A", "1", "n/a", "n/a", "n/a", "5", "n/a"]
    assert table.cleaning.coerced_cells == {"y": 1, "z": 1, "size": 1, "hemisphere": 1}


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


def test_cleaning_names_every_change(tmp_path):
    root, source = _dataset(tmp_path)
    out = source.with_name("sub-01_space-ACPC_electrodes.tsv")
    cleaning = _labels_table(source, 1.0, out).cleaning
    assert cleaning.dropped_columns == EXTRA
    assert cleaning.coerced_cells == {"z": 1, "size": 3}
    assert cleaning.hemisphere_rewritten == 1  # `r` -> `R`
    assert cleaning.as_json("p")["path"] == "p"


def test_hemisphere_words_are_mapped_before_anything_is_blanked(tmp_path):
    root, source = _dataset(tmp_path)
    rows = [
        {"name": n, "x": "1", "y": "2", "z": "3", "hemisphere": h}
        for n, h in (("A", "lh"), ("B", "Right"), ("C", "RH"), ("D", "middle"))
    ]
    table = electrodes_tsv(["name", "x", "y", "z", "hemisphere"], rows, source)
    assert [r[5] for r in _table(table.data)[1:]] == ["L", "R", "R", "n/a"]
    assert table.cleaning.hemisphere_rewritten == 3
    assert table.cleaning.coerced_cells == {"hemisphere": 1}


def _sidecar(folder: Path, name: str, doc: dict) -> None:
    (folder / name).write_text(json.dumps(doc))


def test_inheritance_takes_one_sidecar_per_folder_and_the_deepest_wins(tmp_path):
    root, source = _dataset(tmp_path)
    folder = source.parent
    out = folder / "sub-01_task-a_space-ACPC_electrodes.tsv"
    _sidecar(root, "electrodes.json", {"a": {}, "b": {"Description": "root"}})
    _sidecar(folder, "sub-01_electrodes.json", {"b": {"Description": "folder"}, "c": {}})
    assert sidecar_columns(out) == {"a", "b", "c"}
    # two candidates in one folder and none exact: the validator (walkBack throws
    # MULTIPLE_INHERITABLE_FILES, loadSidecar merges nothing) uses no sidecar at all, not even
    # the root one
    _sidecar(folder, "sub-01_task-a_electrodes.json", {"d": {}})
    assert sidecar_columns(out) == set()
    # an exact match among several wins
    _sidecar(folder, "sub-01_task-a_space-ACPC_electrodes.json", {"e": {}})
    assert sidecar_columns(out) == {"a", "b", "e"}


def test_an_ambiguous_folder_does_not_keep_a_column_the_root_defines(tmp_path):
    root, source = _dataset(tmp_path)
    out = source.parent / "sub-01_space-ACPC_electrodes.tsv"
    _sidecar(root, "electrodes.json", {"seizure_zone": {"Description": "z"}})
    _sidecar(source.parent, "sub-01_electrodes.json", {})
    _sidecar(source.parent, "space-ACPC_electrodes.json", {})
    header = ["name", "x", "y", "z", "seizure_zone"]
    table = electrodes_tsv(header, [{"name": "A", "seizure_zone": "yes"}], out)
    assert "seizure_zone" not in _table(table.data)[0]
    assert table.cleaning.dropped_columns == ("seizure_zone",)


@pytest.mark.parametrize(
    ("definition", "cell", "kept"),
    [
        ({"Format": "index"}, "3", True),
        ({"Format": "index"}, "-1", False),
        ({"Format": "integer"}, "-3", True),
        ({"Format": "integer"}, "1.5", False),
        ({"Format": "string"}, "a b", True),
        ({}, "a b", True),
        ({"Format": "label"}, "a b", False),
        ({"Format": "boolean"}, "yes", False),
        ({"Format": "date"}, "x", False),
        ({"Format": "float"}, "1.5", False),
    ],
)
def test_a_format_that_is_not_checked_drops_the_column(tmp_path, definition, cell, kept):
    root, source = _dataset(tmp_path)
    _sidecar(root, "electrodes.json", {"extra": {"Description": "d", **definition}})
    out = source.parent / "sub-01_space-ACPC_electrodes.tsv"
    table = electrodes_tsv(["name", "x", "y", "z", "extra"], [{"name": "A", "extra": cell}], out)
    assert ("extra" in _table(table.data)[0]) is kept


def test_a_unicode_digit_in_a_numeric_column_becomes_na(tmp_path):
    _, source = _dataset(tmp_path)
    rows = [{"name": "A", "x": "\u0661", "y": "2", "z": "3", "size": "\u0663.5"}]
    table = electrodes_tsv(["name", "x", "y", "z", "size"], rows, source)
    assert _table(table.data)[1] == ["A", "n/a", "2", "3", "n/a"]


def test_a_defined_column_is_kept_only_when_every_value_passes_its_definition(tmp_path):
    root, source = _dataset(tmp_path)
    _sidecar(
        root,
        "electrodes.json",
        {
            "zone": {"Levels": {"yes": "x", "no": "y"}},
            "depth": {"Units": "mm", "Minimum": 0},
            "label": {"Description": "free text"},
        },
    )
    header = ["name", "x", "y", "z", "size", "zone", "depth", "label"]
    good = [
        {"name": "A", "zone": "yes", "depth": "3.5", "label": "q"},
        {"name": "B", "zone": "NaN", "depth": "", "label": "r"},
    ]
    out = source.with_name("sub-01_space-ACPC_electrodes.tsv")
    table = electrodes_tsv(header, good, out)
    assert _table(table.data)[0][5:] == ["zone", "depth", "label"]
    assert _table(table.data)[2][5:] == ["n/a", "n/a", "r"]
    bad = [{"name": "A", "zone": "maybe", "depth": "-1", "label": "q"}]
    table = electrodes_tsv(header, bad, out)
    assert _table(table.data)[0][5:] == ["label"]
    assert table.cleaning.dropped_columns == ("zone", "depth")
    assert "zone" not in table.cleaning.coerced_cells


@pytest.mark.parametrize(
    ("table", "reason"),
    [
        ("name\tx\ty\tz\nA\t1\t2\t3\nA\t1\t2\t3\n", "electrodes-names"),
        ("name\tx\ty\tz\n\t1\t2\t3\n", "electrodes-names"),
        ("name\tx\ty\tz\nA\t1\t2\n", "electrodes-rows"),
        ("name\tx\ty\tz\nA\t1\t2\t3\t4\n", "electrodes-rows"),
        ("name\tx\tx\tz\nA\t1\t2\t3\n", "electrodes-columns"),
    ],
)
def test_a_table_the_writers_could_not_copy_is_refused(tmp_path, table, reason):
    root, source = _dataset(tmp_path, table)
    with pytest.raises(GeometryRefusal) as exc:
        check_source_table(source)
    assert exc.value.reason == reason


def test_the_surfaces_reader_is_not_refused_by_a_repeated_name(tmp_path):
    from ieeg_geometry.bids import discover, read_electrode_set

    root, source = _dataset(tmp_path, "name\tx\ty\tz\nA\t1\t2\t3\nA\t4\t5\t6\n")
    (source.parent / "sub-01_coordsystem.json").write_text(
        json.dumps({"iEEGCoordinateSystem": "Other", "iEEGCoordinateUnits": "mm"})
    )
    (item,) = discover(root)
    assert len(read_electrode_set(item).contacts) == 2  # the table writers refuse this file
    with pytest.raises(GeometryRefusal, match="electrodes-names"):
        check_source_table(source)


def test_the_report_schema_accepts_a_cleaning_entry(tmp_path):
    from jsonschema import Draft202012Validator

    schema = json.loads(
        (REPO_ROOT / "scripts/ieeg_geometry/schema/geometry-report.v1.json").read_text()
    )
    root, source = _dataset(tmp_path)
    entry = _labels_table(source, 1.0, source.with_name("sub-01_space-ACPC_electrodes.tsv"))
    sub = schema["properties"]["electrodes_cleaning"]
    sub = {**sub, "$defs": schema.get("$defs", {})}
    assert not list(Draft202012Validator(sub).iter_errors([entry.cleaning.as_json("p")]))


def test_the_writer_refuses_repeated_names_itself(tmp_path):
    root, source = _dataset(tmp_path)
    rows = [{"name": "A", "x": "1", "y": "2", "z": "3"}] * 2
    with pytest.raises(GeometryRefusal, match="electrodes-names"):
        electrodes_tsv(["name", "x", "y", "z"], rows, source)


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
    # the dataset defines `seizure_zone`: kept in the output, and the validator accepts it
    (root / "electrodes.json").write_text(
        json.dumps({"seizure_zone": {"Description": "authors", "Levels": {"yes": "y", "n/a": "-"}}})
    )

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
    assert "seizure_zone" in clean.read_text().splitlines()[0]
    assert "Destrieux_label" not in clean.read_text().splitlines()[0]
