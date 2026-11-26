"""Read triangle surfaces (FreeSurfer binary, GIfTI, MATLAB v5) into one `Surface` type."""

from __future__ import annotations

import re
import warnings
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
    # True for a template shell made of two halves cut exactly at x = 0 (the implicit cap).
    midline_cut: bool = False
    # (data space, transformed space) when a GIfTI transform was applied to the vertices.
    spaces: tuple[str, str] | None = None

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
    """FreeSurfer binary triangle surface, with c_ras from the `volume info` footer if present.

    FreeSurfer surfaces are in tkr (surface) RAS: scanner RAS = tkr RAS + c_ras.
    A malformed footer keeps the geometry, sets `c_ras` to None and warns.
    """
    path = Path(path)
    meta: dict | None = None
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            verts, faces, meta = nib.freesurfer.read_geometry(str(path), read_metadata=True)
    except Exception:  # a malformed footer must not cost the geometry
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                verts, faces = nib.freesurfer.read_geometry(str(path))
        except Exception as exc:  # nibabel raises several types for a malformed file
            raise GeometryRefusal("surface-unreadable", f"{path.name}: {exc}") from exc
        warnings.warn(f"{path.name}: volume info footer is malformed; c_ras unknown", stacklevel=2)
    cras = meta.get("cras") if isinstance(meta, dict) else None
    c_ras = (float(cras[0]), float(cras[1]), float(cras[2])) if cras is not None else None
    return Surface(verts, faces, guess_hemisphere(path.name), str(path), c_ras)


def read_gifti(path: str | Path) -> Surface:
    """GIfTI surface (ASCII, Base64Binary or GZipBase64Binary; either array order).

    A non-identity `MatrixData` transform is applied to the vertices and the two spaces it
    names are recorded in `Surface.spaces`. FreeSurfer's `VolGeomC_R/A/S` metadata is c_ras.
    """
    path = Path(path)
    try:
        img = GiftiImage.from_filename(str(path))
    except Exception as exc:
        raise GeometryRefusal("surface-unreadable", f"{path.name}: {exc}") from exc
    point_code = nib.nifti1.intent_codes["NIFTI_INTENT_POINTSET"]
    tri_code = nib.nifti1.intent_codes["NIFTI_INTENT_TRIANGLE"]
    pointset = [d for d in img.darrays if d.intent == point_code]
    triangle = [d for d in img.darrays if d.intent == tri_code]
    if len(pointset) != 1 or len(triangle) != 1:
        raise GeometryRefusal(
            "surface-invalid", f"{path.name} needs one POINTSET and one TRIANGLE array"
        )
    point = pointset[0]
    hemi = guess_hemisphere(path.name)
    if hemi is None:
        structure = str(point.meta.get("AnatomicalStructurePrimary", "")).lower()
        hemi = _GIFTI_STRUCTURE.get(structure.replace(" ", ""))
    verts = np.asarray(point.data, dtype=np.float64)
    spaces: tuple[str, str] | None = None
    coordsys = point.coordsys
    xform = None if coordsys is None else np.asarray(coordsys.xform, dtype=float).reshape(4, 4)
    if xform is not None and not np.allclose(xform, np.eye(4)):
        verts = verts @ xform[:3, :3].T + xform[:3, 3]
        spaces = (
            str(nib.nifti1.xform_codes.label[coordsys.dataspace]),
            str(nib.nifti1.xform_codes.label[coordsys.xformspace]),
        )
    c_ras = None
    try:
        c_ras = (
            float(point.meta["VolGeomC_R"]),
            float(point.meta["VolGeomC_A"]),
            float(point.meta["VolGeomC_S"]),
        )
    except (KeyError, ValueError):
        pass
    return Surface(verts, triangle[0].data, hemi, str(path), c_ras, spaces=spaces)


# Field-name pairs seen in MATLAB cortex files. MATLAB indexes from one, so every pair
# is read as one-based and checked (smallest index 1, largest equal to the vertex count).
_MAT_FIELDS = (("vert", "tri"), ("Vertices", "Faces"), ("pos", "tri"), ("pnt", "tri"))


def _as_n_by_3(array: object, what: str, path: Path) -> np.ndarray:
    a = np.asarray(array)
    if a.ndim != 2 or 3 not in a.shape:
        raise GeometryRefusal("mat-shape", f"{path.name}: {what} has shape {a.shape}, not N x 3")
    return a if a.shape[1] == 3 else a.T


def read_mat(path: str | Path) -> Surface:
    """MATLAB v5 file holding a struct (or top-level variables) with a vertex/face field pair.

    Pairs: vert/tri, Vertices/Faces, FieldTrip pos/tri and pnt/tri. A 3 x N array is
    transposed, any other shape is refused. Faces are one-based by MATLAB convention: the
    smallest index must be 1 and the largest the vertex count, otherwise the file is refused.
    Units: an extent under 1 mm is taken as meters and scaled by 1000 only if the result is a
    plausible head (largest extent 100 to 300 mm); otherwise it is refused.
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
            if verts is None or faces is None:
                continue
            verts = _as_n_by_3(verts, vname, path).astype(float)
            faces = _as_n_by_3(faces, fname, path)
            if faces.size == 0 or faces.min() != 1 or faces.max() != len(verts):
                raise GeometryRefusal(
                    "mat-faces-base",
                    f"{path.name}: {fname} is not one-based over {len(verts)} vertices "
                    f"(min {faces.min() if faces.size else None}, "
                    f"max {faces.max() if faces.size else None})",
                )
            extent = float(np.ptp(verts, axis=0).max())
            if extent < 1.0:
                if not 100.0 <= extent * 1000.0 <= 300.0:
                    raise GeometryRefusal(
                        "mat-units", f"{path.name}: extent {extent:g} is not plausible in m or mm"
                    )
                verts = verts * 1000.0
            return Surface(verts, faces - 1, guess_hemisphere(path.name), str(path))
    raise GeometryRefusal("mat-no-surface", f"{path.name} has no vertex and face fields")


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
