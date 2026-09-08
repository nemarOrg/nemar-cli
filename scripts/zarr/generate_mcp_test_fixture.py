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

USAGE. `uv run --with numcodecs python3 scripts/zarr/generate_mcp_test_fixture.py`
from the repo root. Writes
`backend/test/fixtures/mcp/on003392-synthetic-meg-view3-c-0-0-0.bin` and
`backend/test/fixtures/mcp/nm000329-synthetic-multichunk-view1-c-0-0-{0,1,2}.bin`,
printing each one's byte size. Re-run only if a fixture's geometry needs to
change; the committed bytes are stable and this script is not part of the
conversion pipeline.
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from numcodecs import Blosc

N_CHANNELS = 8
N_COLUMNS = 132
LEVEL = 3

MULTI_N_CHANNELS = 4
MULTI_CHUNK_COLUMNS = (50, 50, 17)

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


if __name__ == "__main__":
    main()
