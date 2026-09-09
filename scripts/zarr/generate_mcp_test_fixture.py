#!/usr/bin/env -S uv run --with numcodecs python3
"""One-time generator for a synthetic `view/*` pyramid chunk fixture the MCP
`render_overview` tests need (epic #1065 phase 3, issue #1295, PR review item
1).

WHY THIS EXISTS. `render_overview`'s tests need a REAL ADR 0028 derived (SSS-
filtered MEG) store, so `computeProvenanceEnvelope`'s sss-iff-derived
refinement is exercised against a store that actually carries `sss` -- the
bug this fixture's test catches (`buildProjection` in `list-recordings.ts`
was dropping `sss`/`units_report`, making every derived-store envelope
throw) only shows up on a store where `derived: true`. The real live store
(`on003392`, `sub-01/meg/sub-01_task-localizer_meg.zarr`, already committed
as `test/fixtures/zarr-index-on003392-meg-sss-slice.json`) is 320 channels;
its own coarsest view level (`view/4`, 266 columns, one chunk) is 327 KB
compressed -- over the ~150 KB budget for a committed test fixture. So this
script writes a SYNTHETIC chunk with a much smaller channel/column count
instead, encoded with the SAME codec configuration biosigIO's real
`ZarrExporter` uses for a view chunk (`numcodecs.Blosc`, `cname="zstd"`,
`clevel=5`, byte shuffle, one block per chunk) -- so the bytes this script
produces decode through the exact same path
(`backend/src/services/blosc-decode.ts`'s `decodeBloscZstdInt16`) a real
store's chunk would.

GEOMETRY (single-chunk MEG fixture). 8 channels, 132 columns, one chunk
(`view/3/c/0/0/0` for a synthetic 3-level pyramid over 8500 samples:
`floor(8500/4)=2125`, `floor(2125/4)=531`, `floor(531/4)=132` -- the
biosigio stopping rule halts after 132 because 531 is still above the
512-sample floor but 132 itself is at or below it). Data is a simple
per-channel sine wave (min/max envelope of a few periods across the 132
columns), scaled into a distinct int16 range per channel so the pixel-level
render tests have real variation to check, not a rerun of `nm000329`'s
content -- just a different, small, real-shaped signal.

GEOMETRY (multi-chunk fixture, PR review item 15). A second, SEPARATE
synthetic store/group: 4 channels, 117 columns in ONE view level
(`n_samples=468`, `n_view_levels=1`: `floor(468/4)=117`), chunked at
`view_chunk_columns=50` -- three chunks, `50 + 50 + 17` (a short last
chunk, exercising `reassembleViewChunks`' "chunks must arrive in `k` order,
the last may be shorter" case at the route level, not just the pure-function
level). nm000329's own real `view/3` (the smallest level actually needing 3
chunks) is ~490 KB across its three chunks -- over the fixture budget -- so
this is synthetic too, same codec configuration.

GEOMETRY (sharded level-0 fixture, epic #1065 phase 4, issue #1296). A THIRD,
separate synthetic store for `read_window` taste mode: a small sharded LEVEL-0
signal array (not a view pyramid chunk) using the SAME `sharding_indexed`
codec configuration real level-0 arrays use (`test/fixtures/zarr-array-level0.zarr.json`,
nm000329's real `eeg_250hz` level-0 `zarr.json`) -- `bytes` + `blosc`
(zstd/clevel 5/shuffle/typesize 2) inner codecs, `bytes` + `crc32c` index
codecs, `index_location: "end"`. 4 channels, `chunk_samples` 1000,
`shard_samples` 4000, `n_samples` 6500: shard 0 covers samples [0, 4000) as 4
full inner chunks, shard 1 covers [4000, 6500) as 3 inner chunks with the last
(local index 2, [6000, 6500)) truncated to 500 samples -- the real "boundary
chunk is shorter, never padded" rule (`sharding.ts`'s module doc). Shard 0's
local index 2 ([2000, 3000)) is deliberately marked ABSENT (both footer fields
`2**64 - 1`) so the fill-value path is exercised; it is also
non-byte-adjacent to nothing (its neighbours skip straight past it), which is
what exercises `planShardReads`' "do not coalesce across an absent entry"
rule at the route level, not just the pure-function level. Every present
chunk's digital value is `channel * 100 + (global_sample % chunk_samples)` --
deterministic and hand-computable from the sample index alone, so a test can
assert an exact physical value (`digital * scale[channel] + offset[channel]`)
without re-implementing the encoder. `scale`/`offset` are `[0.5, 1.0, 1.5,
2.0]` / `[10.0, 20.0, 30.0, 40.0]`, real-shaped per-channel arrays matching
the live fixture's `attributes.scale`/`attributes.offset` convention. Writes
`backend/test/fixtures/mcp/nm099500-shard-0.bin`,
`backend/test/fixtures/mcp/nm099500-shard-1.bin` (each a full shard object:
concatenated inner-chunk blosc frames, in local-index order, immediately
followed by its own `n_inner * 16 + 4`-byte footer -- `n_inner` little-endian
uint64 `(offset, nbytes)` pairs plus a 4-byte crc32c placeholder, never
verified by the reader), and
`backend/test/fixtures/mcp/nm099500-level0-zarr.json` (the array's own
`zarr.json`, `attributes.scale`/`attributes.offset` included). The dataset id
`nm099500` is fictitious -- test-fixture-only, chosen INSIDE the dataset id
band `isValidDatasetId` (`backend/src/services/datasetId.ts`) accepts (numeric
part `<= 99999`): this fixture's index.json is read through the real zarr
sub-app (`createZarrDataRoutes`), whose own `isPublicDataset` gate calls
`isValidDatasetId` before touching D1 at all, unlike `mcp-route.test.ts`'s/
`mcp-overview.test.ts`'s `nm5000xx`-band ids, which only ever reach tools that
short-circuit before a real index.json fetch.

USAGE. `uv run --with numcodecs python3 scripts/zarr/generate_mcp_test_fixture.py`
from the repo root. Writes
`backend/test/fixtures/mcp/on003392-synthetic-meg-view3-c-0-0-0.bin`,
`backend/test/fixtures/mcp/nm000329-synthetic-multichunk-view1-c-0-0-{0,1,2}.bin`,
and the sharded level-0 fixture set above, printing each one's byte size.
Re-run only if a fixture's geometry needs to change; the committed bytes are
stable and this script is not part of the conversion pipeline.
"""

from __future__ import annotations

import json
import math
import struct
from pathlib import Path

import numpy as np
from numcodecs import Blosc

N_CHANNELS = 8
N_COLUMNS = 132
LEVEL = 3

MULTI_N_CHANNELS = 4
MULTI_CHUNK_COLUMNS = (50, 50, 17)

# Sharded level-0 fixture (epic #1065 phase 4, issue #1296) -- see the module
# docstring's "GEOMETRY (sharded level-0 fixture...)" section.
SHARD_DATASET_ID = "nm099500"
SHARD_N_CHANNELS = 4
SHARD_CHUNK_SAMPLES = 1000
SHARD_SAMPLES = 4000
SHARD_N_SAMPLES = 6500
SHARD_SCALE = [0.5, 1.0, 1.5, 2.0]
SHARD_OFFSET = [10.0, 20.0, 30.0, 40.0]
SHARD_ABSENT_MARKER = (1 << 64) - 1

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES_DIR = REPO_ROOT / "backend" / "test" / "fixtures" / "mcp"
OUT_PATH = FIXTURES_DIR / "on003392-synthetic-meg-view3-c-0-0-0.bin"


def build_minmax_envelope() -> np.ndarray:
    """[2, N_CHANNELS, N_COLUMNS] int16, axis0 = [min, max] (matches the real
    pyramid's `axis0: ["min", "max"]` attribute)."""
    data = np.zeros((2, N_CHANNELS, N_COLUMNS), dtype=np.int16)
    columns = np.arange(N_COLUMNS)
    for ch in range(N_CHANNELS):
        # A distinct amplitude and period per channel so every band has real,
        # channel-specific variation -- not sixteen copies of one signal.
        amplitude = 500 * (ch + 1)
        period = 20 + ch * 3
        center = np.sin(2 * math.pi * columns / period) * amplitude
        spread = 50 + ch * 5
        data[0, ch, :] = (center - spread).astype(np.int16)  # min
        data[1, ch, :] = (center + spread).astype(np.int16)  # max
    return data


def build_multichunk_envelope(n_columns: int, column_offset: int) -> np.ndarray:
    """[2, MULTI_N_CHANNELS, n_columns] int16 for one chunk of the
    multi-chunk fixture -- `column_offset` shifts the sine phase so
    consecutive chunks visibly continue one another rather than each
    starting the wave over."""
    data = np.zeros((2, MULTI_N_CHANNELS, n_columns), dtype=np.int16)
    columns = np.arange(column_offset, column_offset + n_columns)
    for ch in range(MULTI_N_CHANNELS):
        amplitude = 300 * (ch + 1)
        period = 15 + ch * 4
        center = np.sin(2 * math.pi * columns / period) * amplitude
        spread = 30 + ch * 5
        data[0, ch, :] = (center - spread).astype(np.int16)
        data[1, ch, :] = (center + spread).astype(np.int16)
    return data


def digital_value(channel: int, global_sample: int) -> int:
    """`channel * 100 + (global_sample % SHARD_CHUNK_SAMPLES)` -- see the
    module docstring's sharded-fixture geometry section for why this
    particular formula (hand-computable, distinguishes every channel, and
    -- because `SHARD_CHUNK_SAMPLES` divides `SHARD_SAMPLES` evenly -- the
    result for a non-boundary chunk depends only on the LOCAL sample offset
    within that chunk, never on which chunk it is)."""
    return channel * 100 + (global_sample % SHARD_CHUNK_SAMPLES)


def build_shard(entries: list[dict]) -> bytes:
    """`entries`: local-index order, each `{"present": bool, "start": int,
    "length": int}` (`start`/`length` in GLOBAL sample coordinates). Returns
    one complete shard object: concatenated present-chunk blosc frames
    followed by the `n_inner * 16 + 4`-byte footer (`sharding.ts`'s
    `footerByteLength`) -- `n_inner` little-endian uint64 `(offset, nbytes)`
    pairs, absent entries as `(SHARD_ABSENT_MARKER, SHARD_ABSENT_MARKER)`,
    plus a 4-byte crc32c placeholder the reader never verifies."""
    codec = Blosc(cname="zstd", clevel=5, shuffle=Blosc.SHUFFLE, blocksize=0)
    body = bytearray()
    footer_pairs: list[tuple[int, int]] = []
    for entry in entries:
        if not entry["present"]:
            footer_pairs.append((SHARD_ABSENT_MARKER, SHARD_ABSENT_MARKER))
            continue
        start, length = entry["start"], entry["length"]
        data = np.zeros((SHARD_N_CHANNELS, length), dtype=np.int16)
        columns = np.arange(start, start + length)
        for ch in range(SHARD_N_CHANNELS):
            data[ch, :] = [digital_value(ch, int(s)) for s in columns]
        encoded = codec.encode(data)
        offset = len(body)
        body.extend(encoded)
        footer_pairs.append((offset, len(encoded)))

    out = bytearray(body)
    for off, nb in footer_pairs:
        out += struct.pack("<QQ", off, nb)
    out += b"\x00\x00\x00\x00"  # crc32c placeholder -- never verified
    return bytes(out)


def build_sharded_level0_fixture() -> None:
    shard0 = build_shard(
        [
            {"present": True, "start": 0, "length": 1000},
            {"present": True, "start": 1000, "length": 1000},
            {"present": False, "start": 2000, "length": 1000},
            {"present": True, "start": 3000, "length": 1000},
        ]
    )
    shard0_path = FIXTURES_DIR / f"{SHARD_DATASET_ID}-shard-0.bin"
    shard0_path.write_bytes(shard0)
    print(f"wrote {shard0_path} ({len(shard0)} bytes, 4 inner chunks, local index 2 absent)")

    shard1 = build_shard(
        [
            {"present": True, "start": 4000, "length": 1000},
            {"present": True, "start": 5000, "length": 1000},
            {"present": True, "start": 6000, "length": 500},  # truncated boundary chunk
        ]
    )
    shard1_path = FIXTURES_DIR / f"{SHARD_DATASET_ID}-shard-1.bin"
    shard1_path.write_bytes(shard1)
    print(f"wrote {shard1_path} ({len(shard1)} bytes, 3 inner chunks, last truncated to 500 samples)")

    level0_zarr_json = {
        "shape": [SHARD_N_CHANNELS, SHARD_N_SAMPLES],
        "data_type": "int16",
        "chunk_grid": {
            "name": "regular",
            "configuration": {"chunk_shape": [SHARD_N_CHANNELS, SHARD_SAMPLES]},
        },
        "chunk_key_encoding": {"name": "default", "configuration": {"separator": "/"}},
        "fill_value": 0,
        "codecs": [
            {
                "name": "sharding_indexed",
                "configuration": {
                    "chunk_shape": [SHARD_N_CHANNELS, SHARD_CHUNK_SAMPLES],
                    "codecs": [
                        {"name": "bytes", "configuration": {"endian": "little"}},
                        {
                            "name": "blosc",
                            "configuration": {
                                "typesize": 2,
                                "cname": "zstd",
                                "clevel": 5,
                                "shuffle": "shuffle",
                                "blocksize": 0,
                            },
                        },
                    ],
                    "index_codecs": [
                        {"name": "bytes", "configuration": {"endian": "little"}},
                        {"name": "crc32c"},
                    ],
                    "index_location": "end",
                },
            }
        ],
        "attributes": {
            "level": 0,
            "rate": 250.0,
            "source_rate_hz": 1000.0,
            "downsample_factor": 1,
            "kind": "signal",
            "chunk_samples": SHARD_CHUNK_SAMPLES,
            "shard_samples": SHARD_SAMPLES,
            "anti_aliased": True,
            "usable_for_inference": True,
            "scale": SHARD_SCALE,
            "offset": SHARD_OFFSET,
            "physical_formula": "physical = digital * scale + offset",
        },
        "zarr_format": 3,
        "node_type": "array",
        "storage_transformers": [],
    }
    zarr_json_path = FIXTURES_DIR / f"{SHARD_DATASET_ID}-level0-zarr.json"
    zarr_json_path.write_text(json.dumps(level0_zarr_json, indent=2) + "\n")
    print(f"wrote {zarr_json_path}")


def main() -> None:
    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    # Byte-shuffle, zstd, one block per chunk (blocksize=0 lets c-blosc pick
    # one block for a buffer this small) -- the same configuration the live
    # view5/view4 zarr.json fixtures already committed for nm000329 report
    # (`"cname": "zstd", "clevel": 5, "shuffle": "shuffle", "blocksize": 0`).
    codec = Blosc(cname="zstd", clevel=5, shuffle=Blosc.SHUFFLE, blocksize=0)

    # Pass the int16 ARRAY, not `.tobytes()`, to every `.encode()` call
    # below: numcodecs infers the blosc2 frame's typesize from the buffer's
    # own itemsize, and a raw bytes object has itemsize 1 -- exactly the
    # "typesize 1" mismatch this decoder deliberately refuses to
    # reinterpret (`blosc-decode.ts`'s own int16-only invariant), caught by
    # decoding every fixture back in Bun before trusting it.
    data = build_minmax_envelope()
    encoded = codec.encode(data)
    OUT_PATH.write_bytes(encoded)
    print(f"wrote {OUT_PATH} ({len(encoded)} bytes, decoded shape {data.shape})")

    offset = 0
    for k, n_columns in enumerate(MULTI_CHUNK_COLUMNS):
        chunk_data = build_multichunk_envelope(n_columns, offset)
        chunk_encoded = codec.encode(chunk_data)
        chunk_path = FIXTURES_DIR / f"nm000329-synthetic-multichunk-view1-c-0-0-{k}.bin"
        chunk_path.write_bytes(chunk_encoded)
        print(f"wrote {chunk_path} ({len(chunk_encoded)} bytes, decoded shape {chunk_data.shape})")
        offset += n_columns

    build_sharded_level0_fixture()


if __name__ == "__main__":
    main()
