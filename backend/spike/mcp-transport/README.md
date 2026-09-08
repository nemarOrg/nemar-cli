# MCP transport spike (issue #1293)

**This directory is a spike, not a shippable server.** It exists to answer two
questions the phase 1 design plan left open, with a real `wrangler dev` run
rather than a guess. It is replaced by phase 2 (#1294) and **deleted in that
PR** -- nothing here is meant to survive past phase 1.

## Questions this spike answers

1. Does `@modelcontextprotocol/server@2.0.0` + `@modelcontextprotocol/hono@2.0.0`
   actually serve MCP tool calls under workerd (`wrangler dev`), in both the
   2026-07-28 envelope and the legacy 2025-era `initialize` handshake, and
   does the header-mismatch rejection (`-32020`) work as documented?
2. Which candidate decode path for a served array's blosc/zstd/byte-shuffle
   inner chunks (decision 7 of the phase 1 plan) actually runs on workerd:
   the `numcodecs` JS package's WASM `Blosc` codec, or a from-scratch pure-JS
   decoder built on `fzstd`?

## Result

**Both eras of the transport work.** `server/discover`, `tools/list`,
`tools/call` in the 2026-07-28 envelope, the legacy `initialize` handshake, a
legacy `tools/call` with no envelope at all, the `-32020` rejection for both
a disagreeing `Mcp-Name` and a missing `Mcp-Method`, and the 405 on `GET`/
`DELETE` all behave exactly as the spec and the SDK's migration docs
describe. See `smoke.sh` and the phase 1 PR description for the full
transcript.

**Path (a), `numcodecs`' WASM Blosc codec, does not run under workerd.**
Every `decode_chunk` call reports:

```
RuntimeError: Aborted(CompileError: WebAssembly.instantiate(): Wasm code
generation disallowed by embedder). Build with -sASSERTIONS for more info.
```

`numcodecs/blosc` loads its WASM module the way a browser-targeted Emscripten
build does: fetch the bytes at runtime, then `WebAssembly.instantiate()` on
them. That is dynamic code generation from arbitrary bytes, which workerd's
embedder disallows by default (the same restriction that blocks `eval` and
`new Function`) -- Workers wants WASM modules resolved at bundle time via a
static `import`, not compiled from a byte buffer handed to it at request
time. Nothing short of vendoring and statically importing the raw
`blosc_codec.wasm` file (which the npm package does not even ship -- `npm pack
numcodecs` contains no `.wasm` file, only the JS/WASM glue that tries to fetch
one) would fix this, and that fetch target does not exist as a checked-in
asset today. This confirms the "UNVERIFIED" flag on this path in the phase 1
plan's verified facts, with a concrete failure mode rather than a guess.

**Path (b), the pure-JS decoder in `src/decode.ts`, works and matches ground
truth exactly.** It parses the 16-byte blosc2 chunk header, walks the
per-block offset table, strips each block's 4-byte compressed-length prefix,
decompresses the zstd payload with `fzstd` (pure JS, no WASM), and unshuffles.
Its output matches `fixtures/chunk.expected.json` (captured with a real
Python `zstandard` decompress + manual unshuffle, itself cross-checked
against `numcodecs.Blosc().decode()` on the Python side) bit for bit: the
first/last 16 values, the full-array sum, and an order-sensitive weighted
checksum all agree.

**Verdict for decision 7 (recorded in `.context/mcp-server-design.md` and, if
present, ADR 0050): path (b).** This also matches the plan's stated
preference -- `fzstd` is the same decompressor `hyparquet-compressors` uses
for `events.parquet`, so one pure-JS decoder serves both `render_overview`
and `get_events` with no WASM dependency and no dynamic-codegen restriction
to work around.

## Measurements

| Metric | Value |
|---|---|
| Bundle size (`wrangler deploy --dry-run`), with `numcodecs` | 1447.36 KiB / gzip 465.24 KiB |
| Bundle size, same code with the `numcodecs` import removed | 843.69 KiB / gzip 263.17 KiB |
| `numcodecs`' contribution | ~604 KiB / ~202 KiB gzip -- dead weight given path (a)'s result above |
| `tools/list` wall time (local `wrangler dev`, 5 calls) | 2.1-2.5 ms |
| `tools/call decode_chunk` wall time (local `wrangler dev`, 5 calls, both paths attempted) | 4.5-5.7 ms |

Wall times are local-loopback `curl -w '%{time_total}'` against `wrangler
dev`, not a deployed-edge measurement -- useful for comparing the two decode
paths' relative cost, not as a production latency figure.

## How `fixtures/chunk.bin` was captured

`fixtures/chunk.bin` is one real inner chunk of a live store: nm000329's
`sub-1/ses-0/eeg/sub-1_ses-0_task-imagery_acq-calibration_run-0_eeg.zarr`,
group `eeg_250hz`, level 0 (shape `[63, 138750]`, outer/shard chunk
`[63, 75000]`, inner chunk `[63, 1000]`, `sharding_indexed` with
`bytes` + `blosc` inner codecs -- matching the plan's verified facts
exactly).

1. `HEAD` the shard object (`.../eeg_250hz/0/c/0/0`) to confirm it exists
   (8,970,760 bytes).
2. Range-request the last 1204 bytes (`curl -r -1204`) -- the shard index for
   75 inner chunks (`75 * 16` bytes of `[offset, length]` `uint64` pairs) plus
   its 4-byte `crc32c` trailer. Offsets and lengths were sequential and summed
   exactly to `8970760 - 1204`, confirming the parse.
3. Range-request inner chunk 0's bytes (`offset 0`, `length 119327`) and save
   as `chunk.bin`.

`fixtures/chunk.expected.json` records the ground truth: a real Python
`zstandard` decompress of the block (after stripping the blosc2 chunk header,
per-block offset table, and each block's 4-byte length prefix) plus a manual
byte-unshuffle, with the first/last 16 values, the full sum, and an
order-sensitive weighted checksum (`sum(value[i] * (i+1))`, which a
transposition or reordering bug would not pass by accident the way a bare sum
could). Cross-checked against `numcodecs.Blosc().decode()` on the same input
before being trusted as ground truth -- see the phase 1 PR description for
the full derivation transcript.

`fixtures/zarr-index-v3.json` is the same on008083 fixture used by the
contract tests (`test/fixtures/zarr-index-v3.json`), copied here so this
spike has no path dependency outside its own directory.

## Zod 4 / hono gate

`@modelcontextprotocol/server` depends on `zod ^4.2.0`; the repo pins `zod
^3.23.x` in root and backend `package.json`. `@modelcontextprotocol/hono`
needs `hono ^4.11.4`; backend pins `^4.6.0`. This spike's own `package.json`
installs zod 4 and hono `^4.11.4` in an ISOLATED `node_modules` (its own
`bun.lock`, no workspace linkage to the repo root) specifically so it can
prove the SDK works without first touching the repo's shared dependency
versions. See the phase 1 PR description for the outcome of actually bumping
the repo's own `zod`/`hono` pins and rerunning `bun test` / `bun run
typecheck`.

## Running it yourself

```bash
cd backend/spike/mcp-transport
bun install
bash smoke.sh                                    # full transport smoke test
bunx wrangler deploy --dry-run --outdir /tmp/out  # bundle size
```
