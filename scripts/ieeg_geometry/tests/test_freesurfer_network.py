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
    return CACHE / "b1" / dataset


def _one(results, sub, space=None):
    return next(
        r
        for r in results
        if r.subject == sub and (space is None or f"space-{space}" in r.source.name)
    )


def test_on003848_depth_only_subject_places_nothing():
    """RESP0699 has only depth contacts (it needs c_ras, which L1 tests);
    ruling 20 leaves all out."""
    ieeg = "sub-RESP0699/ses-1/ieeg/sub-RESP0699_ses-1"
    ds = _checkout(
        "on003848",
        [f"{ieeg}_electrodes.tsv", f"{ieeg}_coordsystem.json"],
        "derivatives/freesurfer/sub-RESP0699/ses-1/sub-RESP0699_ses-1_T1w",
    )
    res = _one(fsm.plan_dataset(ds), "RESP0699")
    assert res.outputs == [] and res.refusals[0].reason == "too-few-cortical-contacts"
    assert res.left_out == {fsm.LEFT_MISSING: 69, fsm.LEFT_DEPTH: 64}


def test_on004473_and_on005415_depth_datasets_place_nothing():
    ieeg = "sub-1/ieeg/sub-1"
    ds = _checkout(
        "on004473",
        [f"{ieeg}_space-ACPC_electrodes.tsv", f"{ieeg}_space-ACPC_coordsystem.json"]
        + [f"{ieeg}_space-ScanRAS_electrodes.tsv", f"{ieeg}_space-ScanRAS_coordsystem.json"]
        + [f"{ieeg}_task-SlowFast_channels.tsv"],
        "derivatives/freesurfer-7.3.2/sub-1",
    )
    for res in fsm.plan_dataset(ds):  # meters are converted before anything is judged
        assert res.outputs == [] and res.left_out == {fsm.LEFT_DEPTH: 119}
    ieeg = "sub-72/ieeg/sub-72"
    ds = _checkout(
        "on005415",
        [f"{ieeg}_space-ACPC_electrodes.tsv", f"{ieeg}_space-ACPC_coordsystem.json"]
        + [f"{ieeg}_task-numbers_run-1_channels.tsv"],
        "derivatives/freesurfer/sub-72",
    )
    res = _one(fsm.plan_dataset(ds), "72")
    assert res.outputs == [] and res.left_out == {fsm.LEFT_DEPTH: 174}


def test_on004194_cortical_subjects():
    files = []
    for sub, ses in (("p01", "umcuiemu01"), ("p02", "umcuiemu01"), ("p03", "nyuecog01")):
        stem = f"sub-{sub}/ses-{ses}/ieeg/sub-{sub}_ses-{ses}_acq-clinical"
        files += [f"{stem}_electrodes.tsv", f"{stem}_coordsystem.json"]
    for rel in files:
        _get("on004194", rel, True)
    _get(
        "on004194",
        "sub-p01/ses-umcuiemu01/ieeg/sub-p01_ses-umcuiemu01_task-prf_acq-clinical_run-01_channels.tsv",
        True,
    )
    for sub in ("p01", "p02", "p03"):
        _checkout("on004194", [], f"derivatives/freesurfer/sub-{sub}")
    results = fsm.plan_dataset(CACHE / "b1" / "on004194")
    p01, p02, p03 = _one(results, "p01"), _one(results, "p02"), _one(results, "p03")
    assert p01.frame is not None and p01.frame.frame == "scanner"  # ruling 13: 1.11 against 1.82
    assert p02.frame is not None and p02.frame.frame == "scanner"
    assert p03.frame is not None and p03.frame.frame == "tkr"
    assert (p01.n_surface, p02.n_surface, p03.n_surface) == (56, 56, 90)
    assert p01.left_out[fsm.LEFT_DEPTH] == 8 and p03.left_out[fsm.LEFT_DEPTH] == 30
    for res in (p01, p02, p03):
        assert [o.frame_fit.grade for o in res.outputs] == ["specific"]
        reg = res.outputs[0].registration  # on full surfaces
        assert reg.n_sampled >= 2000 and reg.centroid_mm <= 5.0 and reg.extent_error <= 0.10
