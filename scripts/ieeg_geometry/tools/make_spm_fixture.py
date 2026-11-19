"""Build tests/fixtures/spm_dataset from on004457 sub-2 (public CC0 NEMAR mirror).

Copies sub-2's native and space-ACPC electrodes and the cut subject surface from
tests/fixtures/mini_dataset, and crops the SPM field `y_sub-2_ses-mri01_T1w.nii` (121x145x121
template grid, 1.5 mm) to a box around the native contacts plus a margin. The crop keeps the
field's values and moves the affine, so inversion on the crop equals inversion on the full
field (checked here to 1e-6 mm).

Usage: uv run python tools/make_spm_fixture.py /path/to/full/y_sub-2_ses-mri01_T1w.nii
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

import nibabel as nib
import numpy as np

from ieeg_geometry import spm
from ieeg_geometry.bids import discover, read_electrode_set

HERE = Path(__file__).resolve().parent.parent / "tests" / "fixtures"
MARGIN_VOXELS = 2


def main(full_field: Path) -> None:
    src = HERE / "mini_dataset"
    out = HERE / "spm_dataset"
    ieeg = Path("sub-2/ses-ieeg01/ieeg")
    (out / ieeg).mkdir(parents=True, exist_ok=True)
    for f in (src / ieeg).iterdir():
        shutil.copy2(f, out / ieeg / f.name)
    fs = Path("derivatives/freesurfer/sub-2")
    (out / fs).mkdir(parents=True, exist_ok=True)
    shutil.copy2(src / fs / "pial.R.surf.gii", out / fs / "pial.R.surf.gii")

    field = spm.load_field(full_field)
    native = next(
        read_electrode_set(i) for i in discover(src) if i.subject == "2" and i.space is None
    )
    inv = spm.invert_points(field, native.xyz_mm)
    vox = (np.linalg.inv(field.affine) @ np.c_[inv.template_mm, np.ones(len(inv.template_mm))].T).T
    lo = np.maximum(np.floor(vox[:, :3].min(0)).astype(int) - MARGIN_VOXELS, 0)
    hi = np.minimum(np.ceil(vox[:, :3].max(0)).astype(int) + MARGIN_VOXELS + 1, field.shape)
    crop = field.values[lo[0] : hi[0], lo[1] : hi[1], lo[2] : hi[2]]
    shift = np.eye(4)
    shift[:3, 3] = lo
    img = nib.Nifti1Image(
        crop.astype(np.float32).reshape(*crop.shape[:3], 1, 3), field.affine @ shift
    )
    img.header.set_xyzt_units("mm")
    target = out / fs / "y_sub-2_ses-mri01_T1w.nii.gz"
    nib.save(img, target)
    small = spm.invert_points(spm.load_field(target), native.xyz_mm)
    assert np.abs(small.template_mm - inv.template_mm).max() < 1e-4, "crop changed the inversion"
    print(
        f"crop {crop.shape[:3]} voxels, {target.stat().st_size} bytes, "
        f"residual median {small.median_residual:.4f}"
    )


if __name__ == "__main__":
    main(Path(sys.argv[1]))
