"""Real on004457 SPM fields (sub-1 to sub-4), downloaded into the test cache; run with -m network.

Measured 2026-11-19 with the card B2 build: every field inverts (residual median at most
0.005 mm, maximum at most 0.042 mm, 25 MB per field), pairing picks the right file for
sub-1, sub-2 and sub-4, and sub-3 is a genuine tie (its native and ACPC files both fit the
surface at 2.6 mm although they differ by 15 mm; IntendedFor breaks the tie, ruling 10). Rulings
8 and 9 (smooth shell rule, field check on the subject's own pial vertices) decide the rest.
"""

import os
from pathlib import Path

import pytest

from ieeg_geometry import spm

from .test_network import DATA, RAW, _fetch

pytestmark = pytest.mark.network
D = "on004457"
FIELDS = {
    1: "y_sub-1_ses-mri01_T1w_acpc.nii",
    2: "y_sub-2_ses-mri01_T1w.nii",
    3: "y_sub-3_ses-mri01_T1w.nii",
    4: "y_sub-4_ses-mri01_T1w.nii",
}
SURFACES = {1: "pial.L.surf.gii", 2: "pial.R.surf.gii", 3: "pial.L.surf.gii", 4: "pial.R.surf.gii"}


@pytest.fixture(scope="module")
def dataset(tmp_path_factory) -> Path:
    root = tmp_path_factory.mktemp("on004457")
    for s in (1, 2, 3, 4):
        ieeg = root / f"sub-{s}" / "ses-ieeg01" / "ieeg"
        ieeg.mkdir(parents=True)
        spaces = [""] if s == 1 else ["", "_space-ACPC"]
        names = [
            f"sub-{s}_ses-ieeg01{sp}_{kind}"
            for sp in spaces
            for kind in ("electrodes.tsv", "coordsystem.json")
        ]
        for name in names:
            url = f"{RAW}/{D}/HEAD/sub-{s}/ses-ieeg01/ieeg/{name}"
            os.symlink(_fetch(D, name, url), ieeg / name)
        if s == 2:
            chan = "sub-2_ses-ieeg01_task-ccep_run-01_channels.tsv"
            url = f"{RAW}/{D}/HEAD/sub-2/ses-ieeg01/ieeg/{chan}"
            os.symlink(_fetch(D, chan, url), ieeg / chan)
        fs = root / "derivatives" / "freesurfer" / f"sub-{s}"
        fs.mkdir(parents=True)
        base = f"{DATA}/{D}/v1.0.0/derivatives/freesurfer/sub-{s}"
        os.symlink(_fetch(D, f"y_sub-{s}.nii", f"{base}/{FIELDS[s]}"), fs / FIELDS[s])
        gii = SURFACES[s]
        os.symlink(_fetch(D, f"sub-{s}_{gii}", f"{base}/{gii}"), fs / gii)
    return root


def test_every_field_inverts_and_pairing_follows_the_evidence(dataset):
    plans = {p.subject: p for p in spm.plan_dataset(dataset)}
    assert set(plans) == {"1", "2", "3", "4"}
    for s in ("1", "2", "3", "4"):
        chosen = plans[s].chosen
        assert chosen is not None, plans[s].reason
        inv = plans[s].inversion
        assert inv is not None and inv.ok.all()
        assert inv.median_residual < 0.01 and inv.max_residual < 0.05
    # sub-1: its only file; sub-2 and sub-4: the native file; sub-3: tie broken by IntendedFor
    spaces = [c.space for s in ("1", "2", "3", "4") if (c := plans[s].chosen) is not None]
    assert spaces == [None] * 4
    native = plans["2"].chosen
    acpc = next(c for c in plans["2"].candidates if c.space == "ACPC")
    assert native is not None and native.surface_fit is not None and acpc.surface_fit is not None
    assert native.surface_fit["seeg"].median_mm == pytest.approx(2.68, abs=0.05)
    assert not acpc.eligible and acpc.surface_fit["seeg"].median_mm == pytest.approx(9.89, abs=0.05)
    assert all(c.eligible for c in plans["3"].candidates)  # both fit the surface: a real tie


def test_field_checks_and_verification_decide_every_subject(dataset):
    plans = {p.subject: p for p in spm.plan_dataset(dataset)}
    for s in ("1", "2", "3", "4"):
        plan = plans[s]
        check = plan.field_check
        assert check is not None and check.passed, (s, check)
        assert check.n_inverted >= 2000
        assert check.median_mm <= 6.0 and check.p10_mm <= 2.0
        head = plan.template_fit["seeg"]
        assert head.grade == "plausible" and (head.inside_fraction or 0) >= 0.95
        assert plan.verdict == "write", (s, plan.reason)
        assert len(plan.files) == 2
