"""Real-data checks against the full closed surfaces of public (CC0) NEMAR datasets.

Marked `network`: files are downloaded once into a cache outside the repository
(`$IEEG_GEOMETRY_CACHE`, default `~/.cache/ieeg_geometry_tests`); CI skips the marker.
Run with `uv run pytest -q -m network`.
"""

import os
import urllib.request
from pathlib import Path

import pytest

from ieeg_geometry.bids import Discovered, read_electrode_set
from ieeg_geometry.surfaces import read_surface
from ieeg_geometry.verify import fit, fit_with_offset

pytestmark = pytest.mark.network

CACHE = Path(os.environ.get("IEEG_GEOMETRY_CACHE", Path.home() / ".cache" / "ieeg_geometry_tests"))
RAW = "https://raw.githubusercontent.com/nemarDatasets"
DATA = "https://data.nemar.org"


def _fetch(dataset: str, name: str, url: str) -> Path:
    target = CACHE / dataset / name
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(url, timeout=120) as resp:  # noqa: S310 - fixed https URLs
            target.write_bytes(resp.read())
    return target


def _electrodes(dataset: str, stem: str, repo_dir: str, sub: str, ses: str | None, space=None):
    base = f"{RAW}/{dataset}/HEAD/{repo_dir}/{stem}"
    elec = _fetch(dataset, f"{stem}_electrodes.tsv", f"{base}_electrodes.tsv")
    coord = _fetch(dataset, f"{stem}_coordsystem.json", f"{base}_coordsystem.json")
    chans = ()
    if dataset == "on004457":
        chans = (
            _fetch(
                dataset,
                "sub-2_ses-ieeg01_task-ccep_run-01_channels.tsv",
                f"{RAW}/{dataset}/HEAD/{repo_dir}/sub-2_ses-ieeg01_task-ccep_run-01_channels.tsv",
            ),
        )
    return read_electrode_set(Discovered(elec, coord, chans, sub, ses, space))


def test_on003848_c_ras_is_subtracted():
    """Census: sub-RESP0699 is 33.3 mm as declared and about 1.4 mm in the surface frame."""
    tree = "derivatives/freesurfer/sub-RESP0699/ses-1/sub-RESP0699_ses-1_T1w/surf"
    surf = f"{DATA}/on003848/v1.0.0/{tree}"
    lh = read_surface(_fetch("on003848", "lh.pial", f"{surf}/lh.pial"))
    rh = read_surface(_fetch("on003848", "rh.pial", f"{surf}/rh.pial"))
    assert lh.is_closed and rh.is_closed and lh.c_ras is not None
    eset = _electrodes("on003848", "sub-RESP0699_ses-1", "sub-RESP0699/ses-1/ieeg", "RESP0699", "1")
    result = fit_with_offset(
        eset.xyz_mm, [lh, rh], "seeg", lh.c_ras, [c.hemisphere for c in eset.contacts]
    )
    assert result.as_declared.median_mm == pytest.approx(33.28, abs=0.05)
    assert result.with_c_ras is not None
    assert result.with_c_ras.median_mm == pytest.approx(1.37, abs=0.05)  # subtracted
    added = fit(eset.xyz_mm + lh.c_ras, [lh, rh], "seeg")
    assert added.median_mm > 60.0  # adding c_ras is the wrong direction
    assert result.preferred == "c_ras"


def test_on004473_sub1_full_surfaces():
    surf = f"{DATA}/on004473/v1.0.0/derivatives/freesurfer-7.3.2/sub-1/surf"
    lh = read_surface(_fetch("on004473", "lh.pial", f"{surf}/lh.pial"))
    rh = read_surface(_fetch("on004473", "rh.pial", f"{surf}/rh.pial"))
    assert lh.is_closed and rh.is_closed
    ieeg = "sub-1/ieeg"
    acpc = _electrodes("on004473", "sub-1_space-ACPC", ieeg, "1", None, "ACPC")
    scan = _electrodes("on004473", "sub-1_space-ScanRAS", ieeg, "1", None, "ScanRAS")
    a = fit_with_offset(acpc.xyz_mm, [lh, rh], "seeg", lh.c_ras)
    assert a.as_declared.grade == "plausible" and a.preferred == "as_declared"
    assert a.as_declared.median_mm == pytest.approx(3.14, abs=0.05)
    inside = a.as_declared.inside_fraction  # outer contacts sit outside the pial surface
    assert inside is not None and 0.80 <= inside <= 0.90
    s = fit_with_offset(scan.xyz_mm, [lh, rh], "seeg", lh.c_ras)
    assert s.as_declared.median_mm == pytest.approx(6.25, abs=0.05)
    assert s.with_c_ras is not None
    assert s.with_c_ras.median_mm == pytest.approx(5.60, abs=0.05)  # subtracted; added gives 10.98
    assert fit(scan.xyz_mm + lh.c_ras, [lh, rh], "seeg").median_mm == pytest.approx(10.98, abs=0.05)


def test_on004457_sub2_native_beats_acpc():
    gii = f"{DATA}/on004457/v1.0.0/derivatives/freesurfer/sub-2/pial.R.surf.gii"
    right = read_surface(_fetch("on004457", "pial.R.surf.gii", gii))
    assert right.is_closed and right.hemisphere == "R"
    ieeg = "sub-2/ses-ieeg01/ieeg"
    native = _electrodes("on004457", "sub-2_ses-ieeg01", ieeg, "2", "ieeg01")
    acpc = _electrodes("on004457", "sub-2_ses-ieeg01_space-ACPC", ieeg, "2", "ieeg01", "ACPC")
    fits = {}
    for label, eset in (("native", native), ("acpc", acpc)):
        pts, hemis = eset.xyz_mm, [c.hemisphere for c in eset.contacts]
        fits[label] = fit(pts, right, "seeg", hemis)
    assert fits["native"].grade == "plausible"
    assert fits["native"].median_mm == pytest.approx(2.67, abs=0.05)
    assert fits["acpc"].grade == "fail"
    assert fits["acpc"].median_mm > fits["native"].median_mm + 5.0
