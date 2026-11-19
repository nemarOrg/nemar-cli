from pathlib import Path

import numpy as np
import pytest

from ieeg_geometry.surfaces import Surface

FIXTURES = Path(__file__).parent / "fixtures" / "mini_dataset"


@pytest.fixture(scope="session")
def mini() -> Path:
    return FIXTURES


def icosphere(order: int, radius: float = 10.0, center=(0.0, 0.0, 0.0)) -> Surface:
    """A closed, outward-wound icosphere. Midpoint vertices are appended after the old ones."""
    t = (1 + 5**0.5) / 2
    verts = [
        (-1, t, 0),
        (1, t, 0),
        (-1, -t, 0),
        (1, -t, 0),
        (0, -1, t),
        (0, 1, t),
        (0, -1, -t),
        (0, 1, -t),
        (t, 0, -1),
        (t, 0, 1),
        (-t, 0, -1),
        (-t, 0, 1),
    ]
    faces = [
        (0, 11, 5),
        (0, 5, 1),
        (0, 1, 7),
        (0, 7, 10),
        (0, 10, 11),
        (1, 5, 9),
        (5, 11, 4),
        (11, 10, 2),
        (10, 7, 6),
        (7, 1, 8),
        (3, 9, 4),
        (3, 4, 2),
        (3, 2, 6),
        (3, 6, 8),
        (3, 8, 9),
        (4, 9, 5),
        (2, 4, 11),
        (6, 2, 10),
        (8, 6, 7),
        (9, 8, 1),
    ]
    v = [np.array(p, dtype=float) / np.linalg.norm(p) for p in verts]
    for _ in range(order):
        cache: dict[tuple[int, int], int] = {}

        def mid(a: int, b: int, cache=cache) -> int:
            key = (min(a, b), max(a, b))
            if key not in cache:
                m = (v[a] + v[b]) / 2
                v.append(m / np.linalg.norm(m))
                cache[key] = len(v) - 1
            return cache[key]

        new = []
        for a, b, c in faces:
            ab, bc, ca = mid(a, b), mid(b, c), mid(c, a)
            new += [(a, ab, ca), (b, bc, ab), (c, ca, bc), (ab, bc, ca)]
        faces = new
    return Surface(np.array(v) * radius + np.asarray(center), np.array(faces))


@pytest.fixture(scope="session")
def sphere() -> Surface:
    return icosphere(3)
