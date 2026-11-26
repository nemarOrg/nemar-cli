"""Write `brain-mesh v1` files (the reader is `reference.read_brain_mesh`) and shrink meshes.

`encode_brain_mesh` mirrors `encode_brain_mesh` in the website's `scripts/vendor-brain-template.py`
and `encodeBrainMesh` in `src/lib/ieeg-spatial/mesh-format.ts`, byte for byte: float32 positions,
offset and scale rounded to float32 first, halves rounded up (`floor(x + 0.5)`).
"""

from __future__ import annotations

import fast_simplification
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


def edge_stats(faces: np.ndarray) -> tuple[int, int]:
    """(boundary edges, non-manifold edges) of a triangle list: edges used by one face, and
    by more than two. A closed manifold mesh has (0, 0)."""
    f = np.asarray(faces, dtype=np.int64)
    if not len(f):
        return 0, 0
    edges = np.sort(np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]]), axis=1)
    _, counts = np.unique(edges, axis=0, return_counts=True)
    return int((counts == 1).sum()), int((counts > 2).sum())


def decimate(
    vertices: np.ndarray, faces: np.ndarray, max_vertices: int = MAX_VERTICES
) -> tuple[np.ndarray, np.ndarray]:
    """At most `max_vertices` vertices by quadric edge collapse (`fast-simplification`).

    Triangle order and winding are kept by the collapse; a mesh already small enough is
    returned unchanged. A closed input stays free of boundary edges; a few dozen non-manifold
    edges remain on real pial surfaces (`edge_stats`), which does not affect drawing.
    """
    vertices = np.asarray(vertices, dtype=np.float64)
    faces = np.asarray(faces, dtype=np.int64)
    if len(vertices) <= max_vertices:
        return vertices, faces
    target = int(max_vertices * 0.995)
    for _ in range(25):
        reduction = 1.0 - target / len(vertices)
        v, f = fast_simplification.simplify(vertices, faces, target_reduction=reduction, agg=7)
        if len(v) <= max_vertices:
            return np.asarray(v, dtype=np.float64), np.asarray(f, dtype=np.int64)
        target = int(target * 0.95)
    raise GeometryRefusal("decimation", f"could not reach {max_vertices} vertices")


def _closest_on_triangles(p: np.ndarray, a: np.ndarray, b: np.ndarray, c: np.ndarray) -> np.ndarray:
    """Distance from each point to its own triangle (Ericson, Real-Time Collision Detection)."""
    ab, ac, ap = b - a, c - a, p - a
    d1, d2 = np.einsum("ij,ij->i", ab, ap), np.einsum("ij,ij->i", ac, ap)
    bp = p - b
    d3, d4 = np.einsum("ij,ij->i", ab, bp), np.einsum("ij,ij->i", ac, bp)
    cp = p - c
    d5, d6 = np.einsum("ij,ij->i", ab, cp), np.einsum("ij,ij->i", ac, cp)
    vc, vb, va = d1 * d4 - d3 * d2, d5 * d2 - d1 * d6, d3 * d6 - d5 * d4
    with np.errstate(divide="ignore", invalid="ignore"):
        den = va + vb + vc
        v_in, w_in = vb / den, vc / den
        t_ab = d1 / (d1 - d3)
        t_ac = d2 / (d2 - d6)
        t_bc = (d4 - d3) / ((d4 - d3) + (d5 - d6))
    q = a + ab * v_in[:, None] + ac * w_in[:, None]  # interior
    q = np.where(((vc <= 0) & (d1 >= 0) & (d3 <= 0))[:, None], a + ab * t_ab[:, None], q)
    q = np.where(((vb <= 0) & (d2 >= 0) & (d6 <= 0))[:, None], a + ac * t_ac[:, None], q)
    q = np.where(
        ((va <= 0) & (d4 - d3 >= 0) & (d5 - d6 >= 0))[:, None], b + (c - b) * t_bc[:, None], q
    )
    q = np.where(((d1 <= 0) & (d2 <= 0))[:, None], a, q)
    q = np.where(((d3 >= 0) & (d4 <= d3))[:, None], b, q)
    q = np.where(((d6 >= 0) & (d5 <= d6))[:, None], c, q)
    return np.linalg.norm(p - q, axis=1)


def surface_deviation(
    points: np.ndarray, vertices: np.ndarray, faces: np.ndarray, neighbors: int = 4
) -> np.ndarray:
    """Distance from each point to the triangle mesh (vertices, faces): the nearest triangle
    among those touching its `neighbors` nearest vertices."""
    from scipy.spatial import KDTree

    vertices = np.asarray(vertices, dtype=np.float64)
    faces = np.asarray(faces, dtype=np.int64)
    pts = np.asarray(points, dtype=np.float64).reshape(-1, 3)
    order = np.argsort(faces.reshape(-1), kind="stable")
    owner = order // 3  # face index of each (sorted) corner
    starts = np.searchsorted(faces.reshape(-1)[order], np.arange(len(vertices) + 1))
    _, nearest = KDTree(vertices).query(pts, k=min(neighbors, len(vertices)))
    nearest = nearest.reshape(len(pts), -1)
    best = np.full(len(pts), np.inf)
    max_deg = int((starts[1:] - starts[:-1]).max()) if len(vertices) else 0
    for col in range(nearest.shape[1]):
        vid = nearest[:, col]
        for k in range(max_deg):
            valid = starts[vid] + k < starts[vid + 1]
            if not valid.any():
                break
            idx = np.flatnonzero(valid)
            tri = faces[owner[starts[vid[idx]] + k]]
            d = _closest_on_triangles(
                pts[idx], vertices[tri[:, 0]], vertices[tri[:, 1]], vertices[tri[:, 2]]
            )
            best[idx] = np.minimum(best[idx], d)
    return best
