"""Read triangle surfaces (FreeSurfer binary, GIfTI, MATLAB v5) into one `Surface` type."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path

import nibabel as nib
import numpy as np
import scipy.io
from nibabel.gifti import GiftiImage

from .bids import GeometryRefusal

_HEMI_PATTERNS = (
    (re.compile(r"(^|[._\-])(lh|left|l)([._\-]|$)", re.I), "L"),
    (re.compile(r"(^|[._\-])(rh|right|r)([._\-]|$)", re.I), "R"),
)
_GIFTI_STRUCTURE = {"cortexleft": "L", "cortexright": "R"}


@dataclass(eq=False)
class Surface:
    """A triangle mesh. Vertices are in millimeters in the file's own frame."""

    vertices: np.ndarray
    faces: np.ndarray
    hemisphere: str | None = None
    source: str = ""
    c_ras: tuple[float, float, float] | None = None
    name: str = field(default="")

    def __post_init__(self) -> None:
        self.vertices = np.asarray(self.vertices, dtype=np.float64).reshape(-1, 3)
        self.faces = np.asarray(self.faces, dtype=np.int64).reshape(-1, 3)
        if self.faces.size and (self.faces.min() < 0 or self.faces.max() >= len(self.vertices)):
            raise GeometryRefusal("surface-invalid", "a face index points outside the vertices")

    @cached_property
    def is_closed(self) -> bool:
        """True when every edge is shared by exactly two faces (a watertight mesh)."""
        if not len(self.faces):
            return False
        f = self.faces
        edges = np.sort(np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]]), axis=1)
        _, counts = np.unique(edges, axis=0, return_counts=True)
        return bool(np.all(counts == 2))


def guess_hemisphere(name: str) -> str | None:
    """Hemisphere from a file name such as `lh.pial`, `pial.R.surf.gii` or `..._hemi-L_...`."""
    stem = Path(name).name
    stem = re.sub(r"hemi-", "", stem, flags=re.I)
    for pattern, hemi in _HEMI_PATTERNS:
        if pattern.search(stem):
            return hemi
    return None


def read_freesurfer(path: str | Path) -> Surface:
    """FreeSurfer binary triangle surface, with c_ras from the `volume info` footer if present."""
    path = Path(path)
    try:
        verts, faces, meta = nib.freesurfer.read_geometry(str(path), read_metadata=True)
    except Exception as exc:  # nibabel raises several types for a malformed file
        raise GeometryRefusal("surface-unreadable", f"{path.name}: {exc}") from exc
    cras = meta.get("cras") if isinstance(meta, dict) else None
    c_ras = (float(cras[0]), float(cras[1]), float(cras[2])) if cras is not None else None
    return Surface(
        verts,
        faces,
        guess_hemisphere(path.name),
        str(path),
        c_ras,  # type: ignore[arg-type]
    )


def read_gifti(path: str | Path) -> Surface:
    """GIfTI surface (ASCII, Base64Binary or GZipBase64Binary; either array order)."""
    path = Path(path)
    try:
        img = GiftiImage.from_filename(str(path))
    except Exception as exc:
        raise GeometryRefusal("surface-unreadable", f"{path.name}: {exc}") from exc
    pointset = [
        d for d in img.darrays if d.intent == nib.nifti1.intent_codes["NIFTI_INTENT_POINTSET"]
    ]
    triangle = [
        d for d in img.darrays if d.intent == nib.nifti1.intent_codes["NIFTI_INTENT_TRIANGLE"]
    ]
    if len(pointset) != 1 or len(triangle) != 1:
        raise GeometryRefusal(
            "surface-invalid", f"{path.name} needs one POINTSET and one TRIANGLE array"
        )
    hemi = guess_hemisphere(path.name)
    if hemi is None:
        structure = str(pointset[0].meta.get("AnatomicalStructurePrimary", "")).lower()
        hemi = _GIFTI_STRUCTURE.get(structure.replace(" ", ""))
    return Surface(pointset[0].data, triangle[0].data, hemi, str(path))


_MAT_FIELDS = (("vert", "tri"), ("Vertices", "Faces"), ("vertices", "faces"))


def read_mat(path: str | Path) -> Surface:
    """MATLAB v5 file holding a struct (or top-level variables) with vert/tri or Vertices/Faces.

    MATLAB faces are one-based; they are shifted to zero-based when the smallest index is 1.
    A v7.3 (HDF5) file is refused.
    """
    path = Path(path)
    with path.open("rb") as fh:
        head = fh.read(128)
    if head[:8] == b"\x89HDF\r\n\x1a\n" or b"MATLAB 7.3" in head[:116]:
        raise GeometryRefusal("mat-v73", f"{path.name} is MATLAB v7.3 (HDF5), which is not read")
    try:
        data = scipy.io.loadmat(str(path), squeeze_me=True, struct_as_record=False)
    except Exception as exc:
        raise GeometryRefusal("surface-unreadable", f"{path.name}: {exc}") from exc
    holders: list[object] = [data]
    holders += [v for k, v in data.items() if not k.startswith("__")]
    for holder in holders:
        for vname, fname in _MAT_FIELDS:
            verts = _mat_get(holder, vname)
            faces = _mat_get(holder, fname)
            if verts is not None and faces is not None:
                verts = np.asarray(verts, dtype=float)
                faces = np.asarray(faces)
                if faces.size and faces.min() == 1:
                    faces = faces - 1
                return Surface(verts, faces, guess_hemisphere(path.name), str(path))
    raise GeometryRefusal("mat-no-surface", f"{path.name} has no vert/tri or Vertices/Faces fields")


def _mat_get(holder: object, key: str) -> object | None:
    if isinstance(holder, dict):
        return holder.get(key)
    return getattr(holder, key, None)


def read_surface(path: str | Path) -> Surface:
    """Dispatch on the file name: `.gii` GIfTI, `.mat` MATLAB, anything else FreeSurfer."""
    suffix = Path(path).suffix.lower()
    if suffix == ".gii":
        return read_gifti(path)
    if suffix == ".mat":
        return read_mat(path)
    return read_freesurfer(path)
