"""The vendored reference surfaces, loaded by name, and the `brain-mesh v1` reader."""

from __future__ import annotations

import hashlib
import json
import struct
from pathlib import Path

import numpy as np

from .bids import GeometryRefusal
from .surfaces import Surface

DATA_DIR = Path(__file__).parent / "data"
REFERENCE_NAMES = ("fsaverage", "MNI152NLin2009cAsym")
_DIRS = {"fsaverage": "fsaverage", "MNI152NLin2009cAsym": "mni152nlin2009casym"}

_MAGIC = b"NMBM"
_HEADER = 40


def read_brain_mesh(data: bytes, *, hemisphere: str | None = None, source: str = "") -> Surface:
    """Parse a `brain-mesh v1` file (the website's format); strict like the TypeScript reader.

    Layout, little-endian: magic `NMBM`, u16 version 1, u16 index width (16 or 32),
    u32 vertex count, u32 index count, f32[3] scale, f32[3] offset, i16[3n] quantized
    positions (position = q * scale + offset), then the triangle indices.
    """
    if len(data) < _HEADER:
        raise GeometryRefusal("brain-mesh", "file is shorter than its header")
    if data[:4] != _MAGIC:
        raise GeometryRefusal("brain-mesh", "bad magic, not a brain-mesh file")
    version, width, nv, ni = struct.unpack_from("<HHII", data, 4)
    if version != 1:
        raise GeometryRefusal("brain-mesh", f"unsupported version {version}")
    if width not in (16, 32):
        raise GeometryRefusal("brain-mesh", f"unsupported index width {width}")
    if len(data) != _HEADER + 6 * nv + ni * (width // 8):
        raise GeometryRefusal("brain-mesh", "file size does not match its counts")
    if ni % 3:
        raise GeometryRefusal("brain-mesh", "index count is not a multiple of three")
    scale = np.array(struct.unpack_from("<3f", data, 16), dtype=np.float32)
    offset = np.array(struct.unpack_from("<3f", data, 28), dtype=np.float32)
    if not (np.isfinite(scale).all() and np.isfinite(offset).all()):
        raise GeometryRefusal("brain-mesh", "scale or offset is not finite")
    q = np.frombuffer(data, dtype="<i2", count=3 * nv, offset=_HEADER).reshape(nv, 3)
    positions = q.astype(np.float32) * scale + offset
    dtype = "<u2" if width == 16 else "<u4"
    idx = np.frombuffer(data, dtype=dtype, count=ni, offset=_HEADER + 6 * nv)
    if ni and int(idx.max()) >= nv:
        raise GeometryRefusal("brain-mesh", "an index points past the last vertex")
    return Surface(positions, idx.reshape(-1, 3), hemisphere, source)


def _check_sums(directory: Path) -> None:
    sums = directory / "SHA256SUMS"
    for line in sums.read_text(encoding="utf-8").splitlines():
        digest, _, name = line.partition("  ")
        target = directory / name
        if name.endswith((".npz", ".bin")) and target.exists():
            actual = hashlib.sha256(target.read_bytes()).hexdigest()
            if actual != digest:
                raise GeometryRefusal(
                    "reference-corrupt", f"{target.name} does not match SHA256SUMS"
                )


def load_reference(name: str) -> list[Surface]:
    """The reference surfaces for `fsaverage` or `MNI152NLin2009cAsym`: left then right."""
    if name not in _DIRS:
        raise GeometryRefusal(
            "reference-unknown", f"{name!r} is not one of {', '.join(REFERENCE_NAMES)}"
        )
    directory = DATA_DIR / _DIRS[name]
    _check_sums(directory)
    meta = json.loads((directory / "reference.json").read_text(encoding="utf-8"))
    surfaces: list[Surface] = []
    for hemi, label in (("lh", "L"), ("rh", "R")):
        if name == "fsaverage":
            path = directory / f"{hemi}.pial.npz"
            with np.load(path) as npz:
                surfaces.append(Surface(npz["vertices"], npz["faces"], label, str(path)))
        else:
            path = directory / f"{hemi}.mesh.bin"
            surfaces.append(read_brain_mesh(path.read_bytes(), hemisphere=label, source=str(path)))
            surfaces[-1].midline_cut = True
        surfaces[-1].name = name
        surfaces[-1].smooth = bool(meta.get("smooth", False))
    return surfaces
