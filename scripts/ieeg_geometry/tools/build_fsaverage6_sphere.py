"""Add the fsaverage6 `sphere.reg` vertices to the vendored fsaverage6 data.

Usage, from the repository root:
    uv run --project scripts/ieeg_geometry python \
        scripts/ieeg_geometry/tools/build_fsaverage6_sphere.py \
        <lh.sphere.reg> <rh.sphere.reg> <out-dir>

`<out-dir>` is `scripts/ieeg_geometry/ieeg_geometry/data/fsaverage`. FreeSurfer's fsaverage6
vertices are the first 40962 vertices of fsaverage (the lower icosahedral order is a prefix
of the higher), and every subject's `sphere.reg` registers its vertices to the fsaverage
sphere, so the fsaverage6 sphere is the first 40962 vertices of fsaverage's `sphere.reg`
(identical to its `sphere`). Coordinates are copied unchanged; the files are modified
(truncated, re-encoded) versions of FreeSurfer data and are marked so in the LICENSE notice.
The committed inputs came from fsaverage's `surf/{lh,rh}.sphere.reg` as shipped by public
dataset on004194 v1.0.0 (`derivatives/freesurfer/fsaverage/surf/`). SHA256SUMS is rewritten
to list every `.npz` in the directory.
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import nibabel as nib
import numpy as np

N_FS6 = 40962
N_FS = 163842


def main(lh: str, rh: str, out: str) -> None:
    out_dir = Path(out)
    out_dir.mkdir(parents=True, exist_ok=True)
    for hemi, src in (("lh", lh), ("rh", rh)):
        verts, _ = nib.freesurfer.read_geometry(src)
        if len(verts) != N_FS:
            raise SystemExit(f"{src}: expected fsaverage ({N_FS} vertices), got {len(verts)}")
        np.savez_compressed(
            out_dir / f"{hemi}.sphere.reg.npz", vertices=verts[:N_FS6].astype(np.float32)
        )
    lines = [
        f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}"
        for p in sorted(out_dir.glob("*.npz"))
    ]
    (out_dir / "SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main(*sys.argv[1:4])
