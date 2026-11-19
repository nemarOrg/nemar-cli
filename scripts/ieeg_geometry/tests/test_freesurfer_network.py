"""Real-data checks of the FreeSurfer-transform path on full public surfaces (CC0 datasets).

Marked `network`: files are downloaded once into `$IEEG_GEOMETRY_CACHE/b1/<dataset>/`, laid out
as a dataset checkout. Run with `uv run pytest -q -m network`.
"""

import os
import urllib.request
from pathlib import Path

import pytest

from ieeg_geometry import freesurfer as fsm

pytestmark = pytest.mark.network

CACHE = Path(os.environ.get("IEEG_GEOMETRY_CACHE", Path.home() / ".cache" / "ieeg_geometry_tests"))
RAW = "https://raw.githubusercontent.com/nemarDatasets"
DATA = "https://data.nemar.org"


def _get(dataset: str, rel: str, raw: bool) -> None:
    base = f"{RAW}/{dataset}/HEAD" if raw else f"{DATA}/{dataset}/v1.0.0"
    target = CACHE / "b1" / dataset / rel
    if target.exists() and target.stat().st_size:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(f"{base}/{rel}", timeout=300) as resp:  # noqa: S310
        target.write_bytes(resp.read())


def _checkout(dataset: str, small: list[str], fs_dir: str) -> Path:
    for rel in small:
        _get(dataset, rel, True)
    for hemi in ("lh", "rh"):
        for kind in ("pial", "sphere.reg"):
            _get(dataset, f"{fs_dir}/surf/{hemi}.{kind}", False)
    _get(dataset, f"{fs_dir}/mri/transforms/talairach.xfm", False)
    return CACHE / "b1" / dataset


def _one(results, sub, space=None):
    return next(
        r
        for r in results
        if r.subject == sub and (space is None or f"space-{space}" in r.source.name)
    )


def test_on003848_resp0699_needs_c_ras():
    ieeg = "sub-RESP0699/ses-1/ieeg/sub-RESP0699_ses-1"
    ds = _checkout(
        "on003848",
        [f"{ieeg}_electrodes.tsv", f"{ieeg}_coordsystem.json"],
        "derivatives/freesurfer/sub-RESP0699/ses-1/sub-RESP0699_ses-1_T1w",
    )
    res = _one(fsm.plan_dataset(ds), "RESP0699")
    assert res.frame is not None and res.frame.frame == "scanner"
    fit = res.frame.fits["seeg"]
    assert fit.as_declared.median_mm == pytest.approx(33.28, abs=0.05)
    assert fit.with_c_ras is not None and fit.with_c_ras.median_mm == pytest.approx(1.37, abs=0.05)
    assert res.frame.independent == "shipped talairach.xfm"
    assert res.n_surface + res.n_affine == 64
    surface = [o for o in res.outputs if o.label == "fsaverage"]
    assert surface and surface[0].verification.grade == "specific"


def test_on004473_sub1_acpc_written_and_scanras_refused():
    ieeg = "sub-1/ieeg/sub-1"
    ds = _checkout(
        "on004473",
        [
            f"{ieeg}_space-ACPC_electrodes.tsv",
            f"{ieeg}_space-ACPC_coordsystem.json",
            f"{ieeg}_space-ScanRAS_electrodes.tsv",
            f"{ieeg}_space-ScanRAS_coordsystem.json",
            f"{ieeg}_task-SlowFast_channels.tsv",
        ],
        "derivatives/freesurfer-7.3.2/sub-1",
    )
    results = fsm.plan_dataset(ds)
    acpc = _one(results, "1", "ACPC")
    assert acpc.frame is not None and acpc.frame.grade == "plausible"
    assert acpc.frame.fits["seeg"].as_declared.median_mm == pytest.approx(3.14, abs=0.05)
    assert any(o.label == "fsaverage" for o in acpc.outputs)  # units were meters
    scan = _one(results, "1", "ScanRAS")
    assert scan.outputs == [] and scan.refusals[0].reason == "frame-not-found"


def test_on005415_sub72_meters():
    ieeg = "sub-72/ieeg/sub-72"
    ds = _checkout(
        "on005415",
        [
            f"{ieeg}_space-ACPC_electrodes.tsv",
            f"{ieeg}_space-ACPC_coordsystem.json",
            f"{ieeg}_task-numbers_run-1_channels.tsv",
        ],
        "derivatives/freesurfer/sub-72",
    )
    res = _one(fsm.plan_dataset(ds), "72")
    assert res.frame is not None
    assert res.n_surface + res.n_affine == 174
    assert all(abs(float(v)) < 200 for o in res.outputs for row in o.xyz for v in row)  # mm


def test_on004194_nyu_declared_and_umcu_c_ras():
    files = []
    for sub, ses in (("p02", "umcuiemu01"), ("p03", "nyuecog01")):
        stem = f"sub-{sub}/ses-{ses}/ieeg/sub-{sub}_ses-{ses}_acq-clinical"
        files += [f"{stem}_electrodes.tsv", f"{stem}_coordsystem.json"]
    for rel in files:
        _get("on004194", rel, True)
    for sub in ("p02", "p03"):
        _checkout("on004194", [], f"derivatives/freesurfer/sub-{sub}")
    results = fsm.plan_dataset(CACHE / "b1" / "on004194")
    p02, p03 = _one(results, "p02"), _one(results, "p03")
    assert p02.frame is not None and p02.frame.frame == "scanner"
    assert p03.frame is not None and p03.frame.frame == "tkr"
    assert p02.n_surface == 56 and p03.n_surface == 111
    for res in (p02, p03):
        surface = next(o for o in res.outputs if o.label == "fsaverage")
        assert surface.verification.grade == "specific"
