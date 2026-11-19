import math
from pathlib import Path

import pytest

from ieeg_geometry.bids import GeometryRefusal, discover, read_electrode_set


def _dataset(tmp_path: Path, electrodes: str, coordsystem: dict | str | None, channels=None):
    ieeg = tmp_path / "sub-01" / "ieeg"
    ieeg.mkdir(parents=True)
    (ieeg / "sub-01_electrodes.tsv").write_text(electrodes)
    if coordsystem is not None:
        text = (
            coordsystem if isinstance(coordsystem, str) else __import__("json").dumps(coordsystem)
        )
        (ieeg / "sub-01_coordsystem.json").write_text(text)
    if channels:
        (ieeg / "sub-01_task-x_channels.tsv").write_text(channels)
    return tmp_path


def _read(root: Path):
    (item,) = discover(root)
    return read_electrode_set(item)


def test_discovers_each_subject_session_and_space(mini):
    found = {(d.subject, d.session, d.space) for d in discover(mini)}
    assert found == {
        ("1", None, "ACPC"),
        ("1", None, "ScanRAS"),
        ("2", "ieeg01", None),
        ("2", "ieeg01", "ACPC"),
    }
    assert all(d.coordsystem_path is not None for d in discover(mini))


def test_meters_become_millimeters(mini):
    item = next(d for d in discover(mini) if d.subject == "1" and d.space == "ACPC")
    eset = read_electrode_set(item)
    assert eset.declared_units == "m"
    assert eset.scale_to_mm == 1000.0
    # on004473 sub-1 LENT1 is x = -0.0204716844459397 m in the file
    assert eset.contacts[0].x == pytest.approx(-20.4716844459397)
    assert eset.frame == "ACPC"


def test_centimeters(tmp_path):
    root = _dataset(tmp_path, "name\tx\ty\tz\nA\t1.5\t2\t-3\n", {"iEEGCoordinateUnits": "cm"})
    c = _read(root).contacts[0]
    assert (c.x, c.y, c.z) == (15.0, 20.0, -30.0)


@pytest.mark.parametrize("units", ["um", "voxel", "inch"])
def test_unsupported_units_are_refused_with_a_reason(tmp_path, units):
    root = _dataset(tmp_path, "name\tx\ty\tz\nA\t1\t2\t3\n", {"iEEGCoordinateUnits": units})
    with pytest.raises(GeometryRefusal) as exc:
        _read(root)
    assert exc.value.reason == "units-unsupported"


def test_missing_units_and_missing_coordsystem_are_refused(tmp_path):
    root = _dataset(tmp_path / "a", "name\tx\ty\tz\nA\t1\t2\t3\n", {"iEEGCoordinateSystem": "ACPC"})
    with pytest.raises(GeometryRefusal) as exc:
        _read(root)
    assert exc.value.reason == "units-missing"
    root = _dataset(tmp_path / "b", "name\tx\ty\tz\nA\t1\t2\t3\n", None)
    with pytest.raises(GeometryRefusal) as exc:
        _read(root)
    assert exc.value.reason == "coordsystem-missing"


def test_na_and_nan_rows_are_kept_and_flagged(tmp_path):
    tsv = "name\tx\ty\tz\nA\tn/a\t1\t2\nB\t1\tNaN\t2\nC\t1\t2\t3\nD\t\t\t\n"
    eset = _read(_dataset(tmp_path, tsv, {"iEEGCoordinateUnits": "mm"}))
    assert [c.name for c in eset.contacts] == ["A", "B", "C", "D"]
    assert [c.missing_coordinates for c in eset.contacts] == [True, True, False, True]
    assert eset.n_missing == 3
    assert math.isnan(eset.xyz_mm[0, 0])


def test_type_from_column_then_channels_then_unknown(tmp_path):
    tsv = "name\tx\ty\tz\ttype\nA\t1\t1\t1\tECoG\nB\t1\t1\t1\tn/a\nC\t1\t1\t1\tn/a\n"
    channels = "name\ttype\nA\tSEEG\nB\tDBS\nZ\tEEG\n"
    eset = _read(_dataset(tmp_path, tsv, {"iEEGCoordinateUnits": "mm"}, channels))
    assert [c.type for c in eset.contacts] == ["ecog", "dbs", "unknown"]


def test_type_from_channels_alone_on_real_fixture(mini):
    item = next(d for d in discover(mini) if d.subject == "2" and d.space is None)
    assert read_electrode_set(item).type_counts() == {"seeg": 149, "unknown": 16}


@pytest.mark.parametrize("token", ["abc", "inf", "-Infinity", "1,5"])
def test_unparsable_coordinates_are_refused(tmp_path, token):
    root = _dataset(tmp_path, f"name\tx\ty\tz\nA\t{token}\t1\t2\n", {"iEEGCoordinateUnits": "mm"})
    with pytest.raises(GeometryRefusal) as exc:
        _read(root)
    assert exc.value.reason == "electrodes-value"
    assert "'A'" in exc.value.message


def test_type_column_synonyms_and_hemisphere(tmp_path):
    tsv = (
        "name\tx\ty\tz\ttype\themisphere\n"
        "A\t1\t1\t1\tdepth\tL\nB\t1\t1\t1\tgrid\tR\nC\t1\t1\t1\tstrip\tn/a\n"
        "D\t1\t1\t1\tsurface\tr\nE\t1\t1\t1\tSEEG\tX\n"
    )
    eset = _read(_dataset(tmp_path, tsv, {"iEEGCoordinateUnits": "mm"}))
    assert [c.type for c in eset.contacts] == ["seeg", "ecog", "ecog", "ecog", "seeg"]
    assert [c.hemisphere for c in eset.contacts] == ["L", "R", None, "R", None]


def test_assume_units_covers_a_missing_coordsystem_and_missing_units(tmp_path):
    root = _dataset(tmp_path, "name\tx\ty\tz\nA1\t1\t2\t3\n", None)
    (item,) = discover(root)
    eset = read_electrode_set(item, assume_units="mm")
    assert eset.units_assumed and eset.scale_to_mm == 1.0 and eset.xyz_mm.tolist() == [[1, 2, 3]]
    with pytest.raises(GeometryRefusal) as exc:
        read_electrode_set(item)
    assert exc.value.reason == "coordsystem-missing"
    other = tmp_path / "other"
    root = _dataset(other, "name\tx\ty\tz\nA1\t1\t2\t3\n", {"iEEGCoordinateSystem": "Other"})
    (item,) = discover(root)
    assert read_electrode_set(item, assume_units="m").scale_to_mm == 1000.0
    with pytest.raises(GeometryRefusal) as exc:
        read_electrode_set(item)
    assert exc.value.reason == "units-missing"


def test_assume_units_never_overrides_declared_units(tmp_path):
    root = _dataset(tmp_path, "name\tx\ty\tz\nA1\t1\t2\t3\n", {"iEEGCoordinateUnits": "cm"})
    (item,) = discover(root)
    eset = read_electrode_set(item, assume_units="mm")
    assert not eset.units_assumed and eset.scale_to_mm == 10.0
    bad = tmp_path / "bad"
    root = _dataset(bad, "name\tx\ty\tz\nA1\t1\t2\t3\n", {"iEEGCoordinateUnits": "pixels"})
    (item,) = discover(root)
    with pytest.raises(GeometryRefusal) as exc:
        read_electrode_set(item, assume_units="mm")
    assert exc.value.reason == "units-unsupported"


def test_a_coordsystem_that_is_not_an_object_is_refused(tmp_path):
    root = _dataset(tmp_path, "name\tx\ty\tz\nA1\t1\t2\t3\n", "[1, 2]")
    (item,) = discover(root)
    with pytest.raises(GeometryRefusal) as exc:
        read_electrode_set(item, assume_units="mm")
    assert exc.value.reason == "coordsystem-unreadable"


def _write(path: Path, text: str = "") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


def test_coordsystem_inheritance_nearest_level_and_entity_subset(tmp_path):
    elec = "name\tx\ty\tz\nA1\t1\t2\t3\n"
    _write(tmp_path / "sub-1" / "ses-1" / "ieeg" / "sub-1_ses-1_acq-a_electrodes.tsv", elec)
    subject_level = _write(tmp_path / "sub-1" / "sub-1_coordsystem.json", "{}")
    (item,) = discover(tmp_path)
    assert item.coordsystem_path == subject_level and item.coordsystem_inherited
    session_level = _write(tmp_path / "sub-1" / "ses-1" / "sub-1_ses-1_coordsystem.json", "{}")
    (item,) = discover(tmp_path)
    assert item.coordsystem_path == session_level  # the nearer level wins
    exact = _write(
        tmp_path / "sub-1" / "ses-1" / "ieeg" / "sub-1_ses-1_acq-a_coordsystem.json", "{}"
    )
    (item,) = discover(tmp_path)
    assert item.coordsystem_path == exact and not item.coordsystem_inherited


def test_inheritance_ignores_files_whose_entities_do_not_match(tmp_path):
    elec = "name\tx\ty\tz\nA1\t1\t2\t3\n"
    _write(tmp_path / "sub-1" / "ieeg" / "sub-1_acq-a_electrodes.tsv", elec)
    _write(tmp_path / "sub-1" / "sub-1_acq-b_coordsystem.json", "{}")
    _write(tmp_path / "sub-1" / "sub-2_coordsystem.json", "{}")
    (item,) = discover(tmp_path)
    assert item.coordsystem_path is None and not item.coordsystem_inherited
    top = _write(tmp_path / "coordsystem.json", "{}")
    (item,) = discover(tmp_path)
    assert item.coordsystem_path == top and item.coordsystem_inherited


def test_channels_file_with_a_non_utf8_byte_still_gives_types(tmp_path):
    ieeg = tmp_path / "sub-01" / "ieeg"
    ieeg.mkdir(parents=True)
    (ieeg / "sub-01_electrodes.tsv").write_text("name\tx\ty\tz\nA1\t1\t2\t3\n")
    (ieeg / "sub-01_coordsystem.json").write_text('{"iEEGCoordinateUnits": "mm"}')
    (ieeg / "sub-01_task-x_channels.tsv").write_bytes(
        b"name\ttype\tunits\nA1\tECOG\t\x83V\n"  # a Latin or Shift-JIS micro sign, as in on006233
    )
    assert _read(tmp_path).contacts[0].type == "ecog"
