"""Cut the committed test fixtures down from real public NEMAR dataset files.

Usage, from the repository root:
    uv run --project scripts/ieeg_geometry python \
        scripts/ieeg_geometry/tools/make_fixtures.py <downloads-dir> <fixture-dir>

`<downloads-dir>` holds files fetched as described in tests/fixtures/PROVENANCE.md:
  r473/  on004473 sub-1 electrodes and coordsystem files, lh.pial, rh.pial
  r457/  on004457 sub-2 electrodes, coordsystem, channels, pial.R.surf.gii
Surfaces are cut to the vertices within (nearest-vertex distance + MARGIN_MM) of any contact,
and to the faces made only of kept vertices, so the fixtures stay small while keeping the real
coordinates and footers.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

import nibabel as nib
import numpy as np
from nibabel.gifti import GiftiDataArray, GiftiImage
from scipy.spatial import KDTree

MARGIN_MM = 2.0


def read_xyz(path: Path, scale: float) -> np.ndarray:
    rows = [r.split("\t") for r in path.read_text().splitlines()[1:]]
    return np.array([[float(v) for v in r[1:4]] for r in rows]) * scale


def cut(verts: np.ndarray, faces: np.ndarray, points: np.ndarray, margin: float):
    """Keep every vertex within (nearest-vertex distance + margin) of any contact.

    The true nearest vertex of each contact is always kept, so a nearest-vertex fit of
    these contacts to the cut surface equals the fit to the full surface.
    """
    tree = KDTree(verts)
    nearest, _ = tree.query(points)
    near = np.zeros(len(verts), dtype=bool)
    for p, d in zip(points, nearest, strict=True):
        near[tree.query_ball_point(p, d + margin)] = True
    keep = np.flatnonzero(near)
    remap = -np.ones(len(verts), dtype=np.int64)
    remap[keep] = np.arange(len(keep))
    kept_faces = faces[near[faces].all(axis=1)]
    return verts[keep], remap[kept_faces]


def main(downloads: str, fixture_dir: str) -> None:
    src, dst = Path(downloads), Path(fixture_dir) / "mini_dataset"
    if dst.exists():
        shutil.rmtree(dst)
    (dst / "sub-1" / "ieeg").mkdir(parents=True)
    ieeg2 = dst / "sub-2" / "ses-ieeg01" / "ieeg"
    ieeg2.mkdir(parents=True)
    (dst / "dataset_description.json").write_text(
        '{"Name": "ieeg_geometry mini dataset (cut from on004473 and on004457)", '
        '"BIDSVersion": "1.9.0", "DatasetType": "raw"}\n'
    )

    for name in ("space-ACPC", "space-ScanRAS"):
        for kind in ("electrodes.tsv", "coordsystem.json"):
            shutil.copy(src / "r473" / f"sub-1_{name}_{kind}", dst / "sub-1" / "ieeg")
    acpc = np.vstack(
        [
            read_xyz(src / "r473" / f"sub-1_space-{s}_electrodes.tsv", 1000.0)
            for s in ("ACPC", "ScanRAS")
        ]
    )
    surf_dir = dst / "derivatives" / "freesurfer-7.3.2" / "sub-1" / "surf"
    surf_dir.mkdir(parents=True)
    for hemi in ("lh", "rh"):
        verts, faces, meta = nib.freesurfer.read_geometry(
            str(src / "r473" / f"{hemi}.pial"), read_metadata=True
        )
        v, f = cut(verts, faces, acpc, MARGIN_MM)
        nib.freesurfer.write_geometry(
            str(surf_dir / f"{hemi}.pial"),
            v,
            f,
            create_stamp="cut from on004473 sub-1",
            volume_info=meta,
        )

    stem = "sub-2_ses-ieeg01"
    for tail in (
        "electrodes.tsv",
        "coordsystem.json",
        "space-ACPC_electrodes.tsv",
        "space-ACPC_coordsystem.json",
        "task-ccep_run-01_channels.tsv",
    ):
        shutil.copy(src / "r457" / f"{stem}_{tail}", ieeg2)
    native = np.vstack(
        [read_xyz(src / "r457" / f"{stem}_{t}electrodes.tsv", 1.0) for t in ("", "space-ACPC_")]
    )
    g = GiftiImage.from_filename(str(src / "r457" / "pial.R.surf.gii"))
    faces_arr = next(d for d in g.darrays if d.data.dtype.kind == "i").data
    verts_arr = next(d for d in g.darrays if d.data.dtype.kind == "f").data
    v, f = cut(verts_arr, faces_arr, native, MARGIN_MM)
    gifti_out = GiftiImage(
        darrays=[
            GiftiDataArray(
                f.astype(np.int32),
                intent="NIFTI_INTENT_TRIANGLE",
                datatype="int32",
                encoding="B64BIN",
                ordering="F",
            ),
            GiftiDataArray(
                v.astype(np.float32),
                intent="NIFTI_INTENT_POINTSET",
                datatype="float32",
                encoding="B64BIN",
                ordering="F",
            ),
        ]
    )
    gdir = dst / "derivatives" / "freesurfer" / "sub-2"
    gdir.mkdir(parents=True)
    gifti_out.to_filename(str(gdir / "pial.R.surf.gii"))


if __name__ == "__main__":
    main(*sys.argv[1:3])
