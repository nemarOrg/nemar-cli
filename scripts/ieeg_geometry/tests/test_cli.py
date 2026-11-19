import subprocess
import sys

from ieeg_geometry.__main__ import main


def _run(*args):
    return subprocess.run(
        [sys.executable, "-m", "ieeg_geometry", *args], capture_output=True, text=True
    )


def test_inspect_reports_frame_units_types_and_fits(mini):
    result = _run("inspect", str(mini))
    assert result.returncode == 0, result.stderr
    out = result.stdout
    assert "frame ACPC, units m (x1000 to mm)" in out
    assert "contacts 165 (seeg=149, unknown=16)" in out
    assert "vs fsaverage:" in out and "vs MNI152NLin2009cAsym:" in out
    assert "vs subject surface lh.pial+rh.pial" in out
    assert "with c_ras (3.10, -10.25, 16.30) subtracted" in out
    assert "inside-unevaluable" in out  # the cut fixture surfaces are open
    assert "median 2.67 mm" in out  # sub-2 native sEEG against its own surface


def test_inspect_is_read_only(mini):
    before = sorted(p.stat().st_mtime_ns for p in mini.rglob("*") if p.is_file())
    assert main(["inspect", str(mini)]) == 0
    assert sorted(p.stat().st_mtime_ns for p in mini.rglob("*") if p.is_file()) == before


def test_inspect_with_no_electrodes_exits_nonzero(tmp_path):
    assert _run("inspect", str(tmp_path)).returncode == 1
