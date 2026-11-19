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
