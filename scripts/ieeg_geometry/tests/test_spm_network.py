"""Real on004457 SPM fields (sub-1 to sub-4), downloaded into the test cache; run with -m network.

Everything comes from one pinned dataset version (`v1.0.0`: electrodes, coordsystems, surfaces
and fields). Measured 2026-11-19 with the B2 review fixes:

- Every field inverts every contact (residual median at most 0.005 mm, maximum at most 0.042 mm).
- Pairing basis: sub-1, sub-3 and sub-4 by `IntendedFor` naming the field's T1; sub-2 by template
  verification (its native `IntendedFor` names a file that does not exist and its `space-ACPC`
  file names a different T1, so it is the only candidate left).
- Each chosen file passes the shell inside rule (96.6 to 98.8 percent inside).
- Rulings 19 and 25 (shape and position, shell cut to z >= -40 mm, centroid limit 10 mm): every
  subject passes (centroid 5.0 to 8.7 mm, worst extent difference 4 to 9 percent) and is written.
  Against the whole shell (cerebellum and brainstem included) the extent was 19 to 22 percent off.
"""

import os
from pathlib import Path

import numpy as np
import pytest

from ieeg_geometry import spm

from .test_network import _fetch

pytestmark = pytest.mark.network
D = "on004457"
VERSION = "v1.0.0"
CACHE_KEY = f"{D}-{VERSION}"  # keeps the cache from mixing versions
RAW = f"https://raw.githubusercontent.com/nemarDatasets/{D}/{VERSION}"
DATA = f"https://data.nemar.org/{D}/{VERSION}"
FIELDS = {
    1: "y_sub-1_ses-mri01_T1w_acpc.nii",
    2: "y_sub-2_ses-mri01_T1w.nii",
    3: "y_sub-3_ses-mri01_T1w.nii",
    4: "y_sub-4_ses-mri01_T1w.nii",
}
SURFACES = {1: "pial.L.surf.gii", 2: "pial.R.surf.gii", 3: "pial.L.surf.gii", 4: "pial.R.surf.gii"}
# T1 images that exist in the dataset (only their presence matters to `IntendedFor`)
T1_FILES = [
    "derivatives/freesurfer/sub-1/sub-1_ses-mri01_T1w_acpc_deFaced.nii",
    "derivatives/acpc/sub-2/sub-2_ses-mri01_T1w_acpc_deFaced.nii",
    "derivatives/freesurfer/sub-2/sub-2_ses-mri01_T1w_deFaced.nii",
    "derivatives/acpc/sub-3/sub-3_ses-mri01_T1w_acpc_deFaced.nii",
    "derivatives/freesurfer/sub-3/sub-3_ses-mri01_T1w_deFaced.nii",
    "derivatives/acpc/sub-4/sub-4_ses-mri01_T1w_acpc_deFaced.nii",
    "derivatives/freesurfer/sub-4/sub-4_ses-mri01_T1w_deFaced.nii",
]


@pytest.fixture(scope="module")
def dataset(tmp_path_factory) -> Path:
    root = tmp_path_factory.mktemp(D)
    for s in (1, 2, 3, 4):
        ieeg = root / f"sub-{s}" / "ses-ieeg01" / "ieeg"
        ieeg.mkdir(parents=True)
        spaces = [""] if s == 1 else ["", "_space-ACPC"]
        names = [
            f"sub-{s}_ses-ieeg01{sp}_{kind}"
            for sp in spaces
            for kind in ("electrodes.tsv", "coordsystem.json")
        ]
        if s == 2:
            names.append("sub-2_ses-ieeg01_task-ccep_run-01_channels.tsv")
        for name in names:
            url = f"{RAW}/sub-{s}/ses-ieeg01/ieeg/{name}"
            os.symlink(_fetch(CACHE_KEY, name, url), ieeg / name)
        fs = root / "derivatives" / "freesurfer" / f"sub-{s}"
        fs.mkdir(parents=True)
        base = f"{DATA}/derivatives/freesurfer/sub-{s}"
        field_file = _fetch(CACHE_KEY, f"y_sub-{s}.nii", f"{base}/{FIELDS[s]}")
        os.symlink(field_file, fs / FIELDS[s])
        gii = SURFACES[s]
        os.symlink(_fetch(CACHE_KEY, f"sub-{s}_{gii}", f"{base}/{gii}"), fs / gii)
    for rel in T1_FILES:
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_bytes(b"")
    return root


@pytest.fixture(scope="module")
def plans(dataset):
    return {p.subject: p for p in spm.plan_dataset(dataset)}


def test_every_field_inverts_and_pairing_follows_the_basis(plans):
    assert set(plans) == {"1", "2", "3", "4"}
    basis = {s: plans[s].basis for s in plans}
    assert basis["1"] == basis["3"] == basis["4"] == "IntendedFor names the field's T1"
    assert basis["2"].startswith("template verification")
    for s, plan in plans.items():
        assert plan.chosen is not None and plan.chosen.space is None, (s, plan.reason)
        inv = plan.inversion
        assert inv is not None and inv.ok.all()
        assert inv.median_residual < 0.01 and inv.max_residual < 0.05
    acpc2 = next(c for c in plans["2"].candidates if c.space == "ACPC")
    assert acpc2.intended == spm.INTENDED_OTHER  # names the acpc T1, a different image
    assert plans["2"].chosen.intended == spm.INTENDED_UNKNOWN  # type: ignore[union-attr]
    for s in ("3", "4"):
        acpc = next(c for c in plans[s].candidates if c.space == "ACPC")
        assert acpc.intended == spm.INTENDED_OTHER
    native2 = plans["2"].chosen
    assert native2 is not None and native2.surface_fit is not None
    assert native2.surface_fit["seeg"].median_mm == pytest.approx(2.68, abs=0.05)


def test_chosen_files_pass_the_shell_inside_rule(plans):
    inside = {"1": 0.966, "2": 0.976, "3": 0.980, "4": 0.988}
    for s, expected in inside.items():
        head = plans[s].chosen.template_fit["seeg"]  # type: ignore[union-attr]
        assert head.grade == "plausible"
        assert head.inside_fraction == pytest.approx(expected, abs=0.005)
        assert head.max_outside_mm is not None and head.max_outside_mm <= 10.0


def test_field_checks_pass_and_every_subject_is_written(plans):
    """Rulings 9, 19 and 25: the shell cut to z >= -40 mm for extent and centroid."""
    expected = {  # (centroid mm, worst extent difference)
        "1": (6.5, 0.04),
        "2": (5.0, 0.08),
        "3": (8.7, 0.09),
        "4": (5.4, 0.07),
    }
    for s, (centroid, extent) in expected.items():
        check = plans[s].field_check
        assert check is not None and check.n_inverted == 4000
        assert check.median_mm <= 6.0 and check.p10_mm <= 2.0
        assert check.centroid_mm == pytest.approx(centroid, abs=0.1)
        assert check.extent_deviation == pytest.approx(extent, abs=0.01)
        assert check.passed and plans[s].verdict == "write", (s, plans[s].reason)
        assert len(plans[s].files) == 2 and all(o.output_sha256 for o in plans[s].owned)


def test_pinned_template_coordinates_of_real_contacts(dataset):
    """A few real contacts mapped to template millimeters (guards the inversion itself)."""
    pins = {
        2: {"RX1": (0.94, 33.2, 10.19), "RQ9": (31.79, -48.29, 45.08)},
        3: {"LD1": (-23.14, -31.33, -11.99), "LP14": (-15.5, 25.75, 62.59)},
    }
    from ieeg_geometry.bids import discover, read_electrode_set

    for s, wanted in pins.items():
        field = spm.load_field(dataset / "derivatives/freesurfer" / f"sub-{s}" / FIELDS[s])
        item = next(i for i in discover(dataset) if i.subject == str(s) and i.space is None)
        eset = read_electrode_set(item)
        inv = spm.invert_points(field, eset.xyz_mm)
        for i, c in enumerate(eset.contacts):
            if c.name in wanted:
                assert inv.template_mm[i] == pytest.approx(wanted[c.name], abs=0.02)
    assert np.isfinite(inv.template_mm).all()
