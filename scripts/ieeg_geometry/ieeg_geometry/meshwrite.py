"""Write `brain-mesh v1` files (the reader is `reference.read_brain_mesh`) and shrink meshes.

`encode_brain_mesh` mirrors `encode_brain_mesh` in the website's `scripts/vendor-brain-template.py`
and `encodeBrainMesh` in `src/lib/ieeg-spatial/mesh-format.ts`, byte for byte: float32 positions,
offset and scale rounded to float32 first, halves rounded up (`floor(x + 0.5)`).
"""

from __future__ import annotations

import numpy as np

from .bids import GeometryRefusal

MAGIC = b"NMBM"
VERSION = 1
HEADER_BYTES = 40
Q_MAX = 32767
MAX_VERTICES = 65_535  # 16-bit indices
MAX_HEMISPHERE_BYTES = 1_500_000


def encode_brain_mesh(positions: np.ndarray, indices: np.ndarray) -> bytes:
    """A `brain-mesh v1` file with 16-bit indices; positions in millimeters."""
    pos = np.ascontiguousarray(positions, dtype=np.float32).reshape(-1, 3)
    idx = np.ascontiguousarray(indices, dtype=np.int64).reshape(-1)
    nv, ni = len(pos), len(idx)
    if ni % 3:
        raise GeometryRefusal("brain-mesh", "index count is not a multiple of three")
    if nv > MAX_VERTICES:
        raise GeometryRefusal("brain-mesh", f"{nv} vertices do not fit 16-bit indices")
    if ni and (idx.min() < 0 or idx.max() >= nv):
        raise GeometryRefusal("brain-mesh", "an index points past the last vertex")
    if not np.isfinite(pos).all():
        raise GeometryRefusal("brain-mesh", "a coordinate is not finite")
    wide = pos.astype(np.float64)
    if nv:
        lo, hi = wide.min(axis=0), wide.max(axis=0)
        offset = ((lo + hi) / 2).astype(np.float32)
        scale = ((hi - lo) / (2 * Q_MAX)).astype(np.float32)
    else:
        offset = np.zeros(3, dtype=np.float32)
        scale = np.zeros(3, dtype=np.float32)
    off64, sc64 = offset.astype(np.float64), scale.astype(np.float64)
    safe = np.where(sc64 > 0, sc64, 1.0)
    q = np.floor((wide - off64) / safe + 0.5)
    q = np.where(sc64 > 0, q, 0.0)
    q = np.clip(q, -Q_MAX, Q_MAX).astype("<i2")
    out = bytearray(MAGIC)
    out += np.array([VERSION, 16], dtype="<u2").tobytes()
    out += np.array([nv, ni], dtype="<u4").tobytes()
    out += scale.astype("<f4").tobytes()
    out += offset.astype("<f4").tobytes()
    out += q.tobytes()
    out += idx.astype("<u2").tobytes()
    if len(out) != HEADER_BYTES + 6 * nv + 2 * ni:
        raise GeometryRefusal("brain-mesh", "writer produced the wrong size")
    return bytes(out)


def signed_volume(vertices: np.ndarray, faces: np.ndarray) -> float:
    """Signed volume of a closed mesh in mm^3: positive when faces wind counter-clockwise
    seen from outside (the website's outward-winding test)."""
    tri = np.asarray(vertices, dtype=np.float64)[np.asarray(faces)]
    return float(np.einsum("ij,ij->i", tri[:, 0], np.cross(tri[:, 1], tri[:, 2])).sum() / 6.0)


def _cluster(vertices: np.ndarray, faces: np.ndarray, cell: float) -> tuple[np.ndarray, np.ndarray]:
    """One pass of vertex clustering on a regular grid of `cell` millimeters."""
    cells = np.floor((vertices - vertices.min(axis=0)) / cell).astype(np.int64)
    dims = cells.max(axis=0) + 1
    key = (cells[:, 0] * dims[1] + cells[:, 1]) * dims[2] + cells[:, 2]
    _, inverse = np.unique(key, return_inverse=True)
    inverse = inverse.reshape(-1)
    n = int(inverse.max()) + 1
    counts = np.bincount(inverse, minlength=n).astype(np.float64)
    merged = np.stack(
        [np.bincount(inverse, weights=vertices[:, k], minlength=n) / counts for k in range(3)],
        axis=1,
    )
    mapped = inverse[faces]
    keep = (
        (mapped[:, 0] != mapped[:, 1])
        & (mapped[:, 1] != mapped[:, 2])
        & (mapped[:, 0] != mapped[:, 2])
    )
    mapped = mapped[keep]
    # a triangle listed twice (same three vertices, same winding) adds nothing
    _, first = np.unique(np.sort(mapped, axis=1), axis=0, return_index=True)
    mapped = mapped[np.sort(first)]
    used = np.unique(mapped)
    remap = np.full(n, -1, dtype=np.int64)
    remap[used] = np.arange(len(used))
    return merged[used], remap[mapped]


def decimate(
    vertices: np.ndarray, faces: np.ndarray, max_vertices: int = MAX_VERTICES
) -> tuple[np.ndarray, np.ndarray]:
    """At most `max_vertices` vertices by clustering on a regular grid, then degenerate faces
    removed. Each cluster becomes the mean of its vertices; triangle order, and so the
    winding, is kept. A mesh already small enough is returned unchanged."""
    vertices = np.asarray(vertices, dtype=np.float64)
    faces = np.asarray(faces, dtype=np.int64)
    if len(vertices) <= max_vertices:
        return vertices, faces
    extent = float(np.ptp(vertices, axis=0).max())
    lo, hi = 0.0, extent  # `hi` merges everything; the answer is the smallest passing cell
    for _ in range(40):
        mid = (lo + hi) / 2
        if mid <= 0:
            break
        count = len(_cluster(vertices, faces, mid)[0])
        if count <= max_vertices:
            hi = mid
        else:
            lo = mid
    v, f = _cluster(vertices, faces, hi)
    while len(v) > max_vertices:  # monotonicity is only approximate; widen until it fits
        hi *= 1.01
        v, f = _cluster(vertices, faces, hi)
    return v, f
