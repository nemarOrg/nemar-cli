"""Recover a lower-order icosahedral mesh from a higher-order one (fsaverage to fsaverage6)."""

from __future__ import annotations

import numpy as np


def coarsen_faces(faces: np.ndarray, n_coarse: int) -> np.ndarray:
    """Faces of the order-(k-1) mesh from the order-k faces.

    FreeSurfer's icosahedral meshes keep the lower order's vertices as the first
    `n_coarse` vertices and append one midpoint vertex per edge. Each coarse triangle
    (a, b, c) becomes three corner triangles plus a central triangle made of its three
    midpoints; the central triangle has the coarse winding. The coarse parents of each
    midpoint are its two neighbors with index below `n_coarse`.
    """
    faces = np.asarray(faces)
    is_new = faces >= n_coarse
    central = faces[is_new.all(axis=1)]
    corner = faces[is_new.sum(axis=1) == 2]
    parents: dict[int, set[int]] = {}
    for tri in corner:
        old = [int(v) for v in tri if v < n_coarse]
        for v in tri:
            if v >= n_coarse:
                parents.setdefault(int(v), set()).update(old)
    out = np.empty((len(central), 3), dtype=np.int64)
    for i, (m1, m2, m3) in enumerate(central):
        p1, p2, p3 = parents[int(m1)], parents[int(m2)], parents[int(m3)]
        (a,) = p3 & p1
        (b,) = p1 & p2
        (c,) = p2 & p3
        out[i] = (a, b, c)
    return out
