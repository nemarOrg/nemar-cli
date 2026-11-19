"""Cut the FreeSurfer-transform test fixtures down from real public NEMAR dataset files.

Usage, from the repository root:
    uv run --project scripts/ieeg_geometry python \
        scripts/ieeg_geometry/tools/make_fs_fixtures.py <dataset-checkout-dir> <fixture-dir>

`<dataset-checkout-dir>` mirrors on004194 v1.0.0 (see tests/fixtures/PROVENANCE.md): the
`sub-p02` and `sub-p03` electrodes, coordsystem and channels files, and under
`derivatives/freesurfer/sub-p0N/` the
`surf/{lh,rh}.{pial,sphere.reg}` files. Each pial surface is cut to the vertices within
(the nearest vertex; MARGIN_MM is rounding slack) of any contact, in the declared frame and
in the frame with c_ras subtracted, and to the faces made only of kept vertices. The matching `sphere.reg`
is cut to the same vertices, so vertex indices stay aligned between the two. About
10,000 evenly spaced vertices per hemisphere are kept as well, so the registration check
(an even sample of the pial vertices) sees the whole brain.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

import nibabel as nib
import numpy as np
from scipy.spatial import KDTree

MARGIN_MM = 1e-6  # keeps exactly the nearest vertex of each contact
SPREAD_PER_HEMI = 10000
SUBJECTS = {"p02": "umcuiemu01", "p03": "nyuecog01"}


def read_xyz(path: Path) -> np.ndarray:
    rows = [r.split("\t") for r in path.read_text().splitlines()[1:]]
    return np.array([[float(v) for v in r[1:4]] for r in rows])


def keep_mask(verts: np.ndarray, points: np.ndarray, margin: float) -> np.ndarray:
    tree = KDTree(verts)
    nearest, _ = tree.query(points)
    near = np.zeros(len(verts), dtype=bool)
    for p, d in zip(points, nearest, strict=True):
        near[tree.query_ball_point(p, d + margin)] = True
    return near


def cut(arr: np.ndarray, faces: np.ndarray, keep: np.ndarray):
    remap = -np.ones(len(arr), dtype=np.int64)
    remap[np.flatnonzero(keep)] = np.arange(int(keep.sum()))
    return arr[keep], remap[faces[keep[faces].all(axis=1)]]


def main(source: str, fixture_dir: str) -> None:
    src, dst = Path(source), Path(fixture_dir) / "fs_dataset"
    if dst.exists():
        shutil.rmtree(dst)
    dst.mkdir(parents=True)
    (dst / "dataset_description.json").write_text(
        '{"Name": "ieeg_geometry FreeSurfer fixtures (cut from on004194)", '
        '"BIDSVersion": "1.9.0", "DatasetType": "raw"}\n'
    )
    for sub, ses in SUBJECTS.items():
        ieeg_src = src / f"sub-{sub}" / f"ses-{ses}" / "ieeg"
        ieeg_dst = dst / f"sub-{sub}" / f"ses-{ses}" / "ieeg"
        ieeg_dst.mkdir(parents=True)
        stem = f"sub-{sub}_ses-{ses}"
        for name in (
            f"{stem}_acq-clinical_electrodes.tsv",
            f"{stem}_acq-clinical_coordsystem.json",
        ):
            shutil.copy(ieeg_src / name, ieeg_dst / name)
        for ch in sorted(ieeg_src.glob("*_channels.tsv")):
            shutil.copy(ch, ieeg_dst / ch.name)
        points = read_xyz(ieeg_src / f"{stem}_acq-clinical_electrodes.tsv")
        fs_src = src / "derivatives" / "freesurfer" / f"sub-{sub}"
        fs_dst = dst / "derivatives" / "freesurfer" / f"sub-{sub}"
        (fs_dst / "surf").mkdir(parents=True)
        for hemi in ("lh", "rh"):
            verts, faces, meta = nib.freesurfer.read_geometry(
                str(fs_src / "surf" / f"{hemi}.pial"), read_metadata=True
            )
            c_ras = np.asarray(meta["cras"], dtype=float)
            keep = keep_mask(verts, points, MARGIN_MM) | keep_mask(verts, points - c_ras, MARGIN_MM)
            keep[:: len(verts) // SPREAD_PER_HEMI] = (
                True  # an even sample for the registration check
            )
            v, f = cut(verts, faces, keep)
            note = f"cut from on004194 sub-{sub}"
            nib.freesurfer.write_geometry(
                str(fs_dst / "surf" / f"{hemi}.pial"), v, f, create_stamp=note, volume_info=meta
            )
            sphere, _ = nib.freesurfer.read_geometry(str(fs_src / "surf" / f"{hemi}.sphere.reg"))
            nib.freesurfer.write_geometry(
                str(fs_dst / "surf" / f"{hemi}.sphere.reg"), sphere[keep], f, create_stamp=note
            )


if __name__ == "__main__":
    main(*sys.argv[1:3])
