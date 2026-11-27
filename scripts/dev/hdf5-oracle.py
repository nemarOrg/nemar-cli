"""h5py oracle for shared/hdf5-meta.ts (card A3 of the publication-queue plan).

Dev-only. CI does not run it: the TypeScript tests compare the walker's output with the JSON this
script printed once and that is committed beside each fixture.

    uv run --with 'h5py==3.16.0' python scripts/dev/hdf5-oracle.py <file>          # print entries
    uv run --with 'h5py==3.16.0' python scripts/dev/hdf5-oracle.py --generate <dir> # write fixtures
    uv run --with 'h5py==3.16.0' python scripts/dev/hdf5-oracle.py --snirf-variants <dir>  # card A4
    uv run --with 'h5py==3.16.0' python scripts/dev/hdf5-oracle.py --a4-review <dir>  # A4 review 1

The entry list follows the walker's rules exactly (see the module docstring of
shared/hdf5-meta.ts): one entry per group, dataset and attribute, a value only for a string of at
most 64 KiB (at most 4,096 elements) or a numeric of at most 64 elements, and `skipped` saying why
a value was not returned.
"""

from __future__ import annotations

import json
import math
import sys

import h5py
import numpy as np

STRING_BYTES_MAX = 64 * 1024
STRING_ELEMENTS_MAX = 4096
NUMERIC_ELEMENTS_MAX = 64
CHUNK_BYTES_MAX = 1024 * 1024

LAYOUTS = {0: "compact", 1: "contiguous", 2: "chunked", 3: "virtual"}


def type_name(tid) -> str:
    cls = tid.get_class()
    if cls == h5py.h5t.INTEGER:
        signed = tid.get_sign() == h5py.h5t.SGN_2
        return f"{'int' if signed else 'uint'}{tid.get_size() * 8}"
    if cls == h5py.h5t.FLOAT:
        return f"float{tid.get_size() * 8}"
    if cls == h5py.h5t.STRING:
        return "string"
    if cls == h5py.h5t.ENUM:
        return "enum:" + type_name(tid.get_super())
    if cls == h5py.h5t.REFERENCE:
        return "reference"
    if cls == h5py.h5t.VLEN and is_char_sequence(tid):
        return "vlen:string"
    if cls == h5py.h5t.ARRAY:
        dims = "x".join(str(d) for d in tid.get_array_dims())
        return f"{type_name(tid.get_super())}[{dims}]"
    return {
        h5py.h5t.COMPOUND: "compound",
        h5py.h5t.OPAQUE: "opaque",
        h5py.h5t.BITFIELD: "bitfield",
        h5py.h5t.TIME: "time",
        h5py.h5t.VLEN: "vlen",
    }.get(cls, "unknown")


def is_char_sequence(tid) -> bool:
    """A variable-length sequence of one-byte strings: how MATLAB writes struct field names."""
    sup = tid.get_super()
    return (
        sup.get_class() == h5py.h5t.STRING
        and not sup.is_variable_str()
        and sup.get_size() == 1
    )


def base_of(tid):
    """The element type under any array wrapping, and the number of base elements per element."""
    per = 1
    while tid.get_class() == h5py.h5t.ARRAY:
        for d in tid.get_array_dims():
            per *= d
        tid = tid.get_super()
    return tid, per


def shape_of(space):
    kind = space.get_simple_extent_type()
    if kind == h5py.h5s.NULL:
        return None
    if kind == h5py.h5s.SCALAR:
        return []
    return [int(d) for d in space.get_simple_extent_dims()]


def number(x):
    if isinstance(x, (bool, np.bool_)):
        return int(x)
    if isinstance(x, (np.integer, int)):
        return int(x)
    f = float(x)
    if math.isnan(f):
        return "NaN"
    if math.isinf(f):
        return "Infinity" if f > 0 else "-Infinity"
    return f


def text(raw: bytes, nullterm: bool) -> str:
    if nullterm and b"\0" in raw:
        raw = raw[: raw.index(b"\0")]
    return raw.decode("utf-8", "replace")


def value_of(tid, shape, read):
    """(value, skipped) under the walker's rules; `read()` returns the numpy value."""
    if shape is None:
        return None, None
    base, per = base_of(tid)
    count = per
    for d in shape:
        count *= d
    cls = base.get_class()
    if cls == h5py.h5t.VLEN and is_char_sequence(base):
        if count > STRING_ELEMENTS_MAX:
            return None, "size"
        flat = np.asarray(read(), dtype=object).ravel().tolist()
        raws = [b"".join(bytes(c) for c in v) for v in flat]
        if sum(len(r) for r in raws) > STRING_BYTES_MAX:
            return None, "size"
        strings = [text(r, True) for r in raws]
        return (strings[0], None) if shape == [] and per == 1 else (strings, None)
    if cls == h5py.h5t.STRING:
        if count > STRING_ELEMENTS_MAX:
            return None, "size"
        vlen = base.is_variable_str()
        if not vlen and count * base.get_size() > STRING_BYTES_MAX:
            return None, "size"
        flat = np.asarray(read(), dtype=object).ravel().tolist()
        raws = [
            v if isinstance(v, bytes) else (b"" if v is None else str(v).encode())
            for v in flat
        ]
        if vlen and sum(len(r) for r in raws) > STRING_BYTES_MAX:
            return None, "size"
        nullterm = vlen or base.get_strpad() == h5py.h5t.STR_NULLTERM
        strings = [text(r if vlen else r.rstrip(b"\0"), nullterm) for r in raws]
        if shape == [] and per == 1:
            return strings[0], None
        return strings, None
    if cls in (h5py.h5t.INTEGER, h5py.h5t.FLOAT, h5py.h5t.ENUM):
        if count > NUMERIC_ELEMENTS_MAX:
            return None, "size"
        return [number(v) for v in np.asarray(read()).ravel().tolist()], None
    return None, "type"


def entries(path: str):
    out = []
    with h5py.File(path, "r") as f:

        def attrs(obj, owner):
            for name in obj.attrs:
                aid = h5py.h5a.open(obj.id, name.encode())
                tid = aid.get_type()
                shape = shape_of(aid.get_space())

                def read(obj=obj, name=name):
                    return obj.attrs[name]

                value, skipped = value_of(tid, shape, read)
                e = {
                    "path": owner,
                    "kind": "attribute",
                    "name": name,
                    "dtype": type_name(tid),
                    "shape": shape,
                    "value": value,
                }
                if skipped:
                    e["skipped"] = skipped
                out.append(e)

        def visit(name, obj):
            p = "/" + name if name else "/"
            leaf = p.rsplit("/", 1)[-1]
            if isinstance(obj, h5py.Group):
                out.append(
                    {
                        "path": p,
                        "kind": "group",
                        "name": leaf,
                        "dtype": None,
                        "shape": None,
                        "value": None,
                    }
                )
            elif isinstance(obj, h5py.Dataset):
                tid = obj.id.get_type()
                shape = shape_of(obj.id.get_space())
                value, skipped = value_of(tid, shape, lambda obj=obj: obj[()])
                plist = obj.id.get_create_plist()
                layout = LAYOUTS.get(plist.get_layout(), "unknown")
                if layout == "chunked" and value is not None:
                    cls = tid.get_class()
                    variable = cls == h5py.h5t.VLEN or (
                        cls == h5py.h5t.STRING and tid.is_variable_str()
                    )
                    element = 16 if variable else tid.get_size()
                    if math.prod(plist.get_chunk()) * element > CHUNK_BYTES_MAX:
                        value, skipped = None, "size"
                storage = {"layout": layout, "address": None, "size": None}
                if layout == "contiguous":
                    storage["address"] = obj.id.get_offset()
                    storage["size"] = int(obj.id.get_storage_size())
                e = {
                    "path": p,
                    "kind": "dataset",
                    "name": leaf,
                    "dtype": type_name(tid),
                    "shape": shape,
                    "value": value,
                    "storage": storage,
                }
                if skipped:
                    e["skipped"] = skipped
                out.append(e)
            else:
                return
            attrs(obj, p)
            return

        visit("", f)
        f.visititems(visit)
    out.sort(key=lambda e: (e["path"], e["kind"], e["name"]))
    return out


def generate(outdir: str) -> None:
    """Write the two synthetic fixtures. The format is real (h5py and libhdf5 wrote it); the
    content is not a recording."""
    # Dense storage: more than 8 links in one group and more than 8 attributes on one object push
    # libhdf5 past its compact limits, into a fractal heap indexed by a version 2 B-tree.
    with h5py.File(f"{outdir}/dense-latest.h5", "w", libver="latest") as f:
        g = f.create_group("dense")
        for i in range(12):
            sub = g.create_group(f"member_{i:02d}")
            sub.attrs["index"] = np.int32(i)
        for i in range(12):
            g.attrs[f"attr_{i:02d}"] = f"value {i}"
        g.attrs["vlen_list"] = ["alpha", "beta", "gamma"]
        g.attrs["fixed"] = np.bytes_("fixed width")
        g.attrs["doubles"] = np.arange(5, dtype="<f8") / 4
        g.attrs["big_endian"] = np.arange(3, dtype=">i2")
        g.attrs["flag"] = True
        g.attrs["too_many"] = np.arange(100, dtype="<u1")
        c = f.create_group("compact")
        c.create_dataset("scalar_text", data="a scalar string")
        c.create_dataset("small_ints", data=np.arange(6, dtype="<i8").reshape(2, 3))
        c.create_dataset("wide", data=np.zeros((4, 32), dtype="<f4"))
        dcpl = h5py.h5p.create(h5py.h5p.DATASET_CREATE)
        dcpl.set_layout(h5py.h5d.COMPACT)
        space = h5py.h5s.create_simple((4,))
        dset = h5py.h5d.create(
            c.id, b"compact_layout", h5py.h5t.STD_U16LE, space, dcpl=dcpl
        )
        dset.write(h5py.h5s.ALL, h5py.h5s.ALL, np.arange(4, dtype="<u2"))
        c.create_dataset("string_array", data=np.array([b"ab", b"cd"], dtype="S2"))
        ad = np.dtype((h5py.string_dtype(), (2,)))
        c.create_dataset("array_of_strings", data=np.array([("x", "y")], dtype=ad))
        c.attrs["note"] = "compact links only"
        c["soft"] = h5py.SoftLink("/compact/small_ints")
        f.create_dataset("empty", data=h5py.Empty("<f8"))
    # A chunked, deflate-compressed string dataset (and a shuffled numeric one), written with the
    # library's default (earliest) format bounds, so the chunks are indexed by a version 1 B-tree.
    with h5py.File(f"{outdir}/chunked-strings.h5", "w") as f:
        f.create_dataset(
            "labels",
            data=np.array([f"label {i}" for i in range(40)], dtype=object),
            dtype=h5py.string_dtype(),
            chunks=(16,),
            compression="gzip",
        )
        f.create_dataset(
            "fixed_labels",
            data=np.array([b"Fp1", b"Fp2", b"Cz"], dtype="S4"),
            chunks=(2,),
            compression="gzip",
        )
        f.create_dataset(
            "shuffled",
            data=np.arange(30, dtype="<i4"),
            chunks=(10,),
            shuffle=True,
            compression="gzip",
        )
        f.create_dataset(
            "big_chunked",
            data=np.ones(1000, dtype="<f8"),
            chunks=(100,),
            compression="gzip",
        )
        # Over the string rules: 70,000 bytes in one element, and 5,000 elements.
        f.create_dataset(
            "long_text",
            data=np.array([b"x" * 70_000], dtype="S70000"),
            chunks=(1,),
            compression="gzip",
        )
        f.create_dataset("many_labels", data=np.array([b"a"] * 5000, dtype="S1"))
        # Four numbers in one 1.6 MB chunk: over the walker's 1 MiB chunk cap.
        f.create_dataset(
            "huge_chunk",
            data=np.arange(4, dtype="<f8"),
            chunks=(200_000,),
            maxshape=(None,),
            compression="gzip",
        )
        f["external"] = h5py.ExternalLink("elsewhere.h5", "/target")
    # Constructs outside the supported list, one per file, since a walk reports its first reason.
    with h5py.File(f"{outdir}/unsupported-type.h5", "w") as f:
        f.create_dataset("complex", data=np.arange(3, dtype="<f8") * (1 + 1j))
        f.create_dataset("ok", data=np.arange(3, dtype="<i2"))
    with h5py.File(f"{outdir}/unsupported-filter.h5", "w") as f:
        f.create_dataset(
            "checksummed", data=np.arange(8, dtype="<i4"), chunks=(8,), fletcher32=True
        )
        f.create_dataset("ok", data=np.arange(3, dtype="<i2"))


# Made-up values for the identifier-screen fixtures (card A4). No real person is named.
MADE_UP_NAME = "Quillfeather Marlow"


def snirf_variants(outdir: str) -> None:
    """Copies of the real Simple_Probe SNIRF fixture with one change each (card A4): a second
    `nirs` group copied from the first, and a made-up name in SubjectID. Plus a small synthetic
    file whose fields carry identifier-shaped values for the generic HDF5 rules."""
    import shutil

    real = f"{outdir}/snirf-samples-simple-probe.snirf"

    def set_text(f, path, text):
        del f[path]
        f[path] = np.bytes_(text)

    two = f"{outdir}/snirf-two-groups.snirf"
    shutil.copyfile(real, two)
    with h5py.File(two, "r+") as f:
        f.copy("/nirs", "/nirs2")
        set_text(f, "/nirs2/metaDataTags/SubjectID", MADE_UP_NAME)
    named = f"{outdir}/snirf-subject-name.snirf"
    shutil.copyfile(real, named)
    with h5py.File(named, "r+") as f:
        set_text(f, "/nirs/metaDataTags/SubjectID", MADE_UP_NAME)
    with h5py.File(f"{outdir}/identifier-fields.h5", "w") as f:
        g = f.create_group("meta")
        g.create_dataset("DateOfBirth", data=np.bytes_("1971-04-23"))
        g.create_dataset("dob", data=np.bytes_("1971-04"))
        g.create_dataset("BirthDate", data=np.bytes_("unknown"))
        g.create_dataset("Email", data=np.bytes_("someone@example.org"))
        g.attrs["ExperimenterName"] = MADE_UP_NAME
        g.attrs["ManufacturerName"] = "Quillfeather Instruments GmbH"
        g.attrs["AppName"] = "Marlow Recorder"
        g.attrs["Notes"] = "Quillfeather Marlow recorded this"
        g.attrs["SourcePath"] = "/home/qmarlow/data/run1"
        f.create_dataset("signal", data=np.zeros(1000, dtype="<f8"))


def a4_review(outdir: str) -> None:
    """Two synthetic files for review round 1 of card A4: strings the walker does not return
    (over its size rules), and identifier fields that hold numbers."""
    with h5py.File(f"{outdir}/unscanned-strings.h5", "w") as f:
        f.attrs["notes"] = "x" * 70_000  # one string over 64 KiB
        f.create_dataset("labels", data=np.array([b"a"] * 5000, dtype="S1"))  # over 4,096
        f.create_dataset("signal", data=np.zeros(1000, dtype="<f8"))
    with h5py.File(f"{outdir}/numeric-identifiers.h5", "w") as f:
        g = f.create_group("meta")
        g.create_dataset("MRN", data=np.int64(48213907))
        g.create_dataset("dob", data=np.int32(19710423))
        g.create_dataset("BirthDate", data=np.int32(1971))
        g.create_dataset("signal", data=np.zeros(1000, dtype="<f8"))
    with h5py.File(f"{outdir}/skipped-identifier.h5", "w") as f:
        # An identifier-named field too large for the walker to return: not read, so not clean.
        f.create_dataset("PatientID", data=np.arange(100, dtype="<i8"))


def main(argv: list[str]) -> int:
    if len(argv) == 3 and argv[1] == "--generate":
        generate(argv[2])
        return 0
    if len(argv) == 3 and argv[1] == "--a4-review":
        a4_review(argv[2])
        return 0
    if len(argv) == 3 and argv[1] == "--snirf-variants":
        snirf_variants(argv[2])
        return 0
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    # One entry per line: compact, and a diff of two oracle runs names the entries that changed.
    lines = [
        json.dumps(e, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        for e in entries(argv[1])
    ]
    print("[\n" + ",\n".join(lines) + "\n]")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
