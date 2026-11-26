"""Build the vendored fsaverage6 pial surfaces from an fsaverage pial surface pair.

Usage, from the repository root:
    uv run --project scripts/ieeg_geometry python \
        scripts/ieeg_geometry/tools/build_fsaverage6.py <lh.pial> <rh.pial> <out-dir>

FreeSurfer's fsaverage6 vertices are the first 40962 vertices of fsaverage (the lower
icosahedral order is a prefix of the higher), so the coordinates are copied unchanged and
the fsaverage6 triangles are recovered from the fsaverage triangles (`_ico.coarsen_faces`).
The output is therefore a modified (decimated) version of FreeSurfer's data and is marked so
in the license file. The input pair used for the committed files came from a public NEMAR
dataset that ships FreeSurfer's fsaverage pial surfaces (created by FreeSurfer, 2013).
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import nibabel as nib
import numpy as np

from ieeg_geometry._ico import coarsen_faces

N_FS6 = 40962
N_FS = 163842


def main(lh: str, rh: str, out: str) -> None:
    out_dir = Path(out)
    out_dir.mkdir(parents=True, exist_ok=True)
    for hemi, src in (("lh", lh), ("rh", rh)):
        verts, faces = nib.freesurfer.read_geometry(src)
        if len(verts) != N_FS:
            raise SystemExit(f"{src}: expected fsaverage ({N_FS} vertices), got {len(verts)}")
        coarse = coarsen_faces(faces, N_FS6)
        assert len(coarse) == 81920, len(coarse)
        np.savez_compressed(
            out_dir / f"{hemi}.pial.npz",
            vertices=verts[:N_FS6].astype(np.float32),
            faces=coarse.astype(np.uint32),
        )
    lines = [
        f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}"
        for p in sorted(out_dir.glob("*.npz"))
    ]
    (out_dir / "SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main(*sys.argv[1:4])
