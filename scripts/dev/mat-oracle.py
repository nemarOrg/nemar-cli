"""Print what a MATLAB file holds, as the MAT walker's tests expect it (card A5).

    uv run --with 'scipy==1.18.1' --with 'h5py==3.16.0' python scripts/dev/mat-oracle.py <file> > <file>.oracle.json

Level 5 files are read by scipy.io.loadmat: one entry per character or numeric array, in file
order, with the variable and struct field names leading to it, its MATLAB class and dimensions,
and its value under the walker's rules (characters as one string per row; at most 64 numbers,
real parts in column-major order; larger numeric arrays as "skipped": "size"). scipy reads an
empty element (zero bytes) as a 1 x 0 double, where the walker lists nothing; the tests compare
numeric arrays only when they hold a value.
v7.3 files are read by h5py: one entry per MATLAB character array, with its rows.
"""

import json
import sys

import numpy as np

NUMERIC_MAX = 64

CLASS = {
    "float64": "double",
    "float32": "single",
    "int8": "int8",
    "uint8": "uint8",
    "bool": "uint8",
    "int16": "int16",
    "uint16": "uint16",
    "int32": "int32",
    "uint32": "uint32",
    "int64": "int64",
    "uint64": "uint64",
    "complex128": "double",
    "complex64": "single",
}


def walk(value, fields, out):
    if value.dtype.names is not None:  # struct array
        for element in value.flatten(order="F"):
            for name in value.dtype.names:
                walk(element[name], fields + [name], out)
        return
    if value.dtype == object:  # cell array
        for member in value.flatten(order="F"):
            walk(member, fields, out)
        return
    dims = list(value.shape)
    if value.dtype.kind == "U":  # with chars_as_strings=False, one character per element
        rows = []
        if value.size > 0 and dims[0] > 0:
            grid = value.reshape(dims[0], -1, order="F")
            rows = ["".join(grid[r, :]) for r in range(dims[0])]
        out.append({"fields": fields, "class": "char", "dims": dims, "value": rows})
        return
    cls = CLASS[str(value.dtype)]
    if value.size > NUMERIC_MAX:
        out.append({"fields": fields, "class": cls, "dims": dims, "skipped": "size"})
        return
    numbers = np.real(value).flatten(order="F").tolist()
    out.append({"fields": fields, "class": cls, "dims": dims, "value": [float(n) for n in numbers]})


def level5(path):
    import scipy.io

    data = scipy.io.loadmat(
        path, squeeze_me=False, struct_as_record=True, chars_as_strings=False, mat_dtype=True
    )
    out = []
    for name, value in data.items():
        if name.startswith("__"):
            continue
        walk(value, [name], out)
    return out


def v73(path):
    import h5py

    out = []

    def visit(name, obj):
        if not isinstance(obj, h5py.Dataset) or obj.dtype != np.uint16:
            return
        if obj.attrs.get("MATLAB_class", b"") != b"char":
            return
        units = obj[()]
        rows = units.shape[-1] if units.ndim > 0 else 1
        grid = units.reshape(-1, rows)
        out.append({"path": "/" + name, "value": ["".join(chr(u) for u in grid[:, r]) for r in range(rows)]})

    with h5py.File(path, "r") as f:
        f.visititems(visit)
    return out


if __name__ == "__main__":
    target = sys.argv[1]
    with open(target, "rb") as f:
        head = f.read(128)
    entries = v73(target) if head[124:126] in (b"\x00\x02", b"\x02\x00") else level5(target)
    json.dump(entries, sys.stdout, indent=1, ensure_ascii=False)
    sys.stdout.write("\n")
