# NEMAR MCP server: design, contracts, and the transport/decode spike

Status: phase 1 of epic #1065 (issue #1293).
Scope: design and contracts only.
No route exists yet; phases 2 to 4 (#1294 to #1296) build the host fork, the
discovery tools, the recording tools, and `read_window`.
Phase 5 (#1297) is docs, OSA wiring, and release.

## 1. Purpose and constraints

NEMAR exposes its catalog and Zarr serving copies to agents through an MCP
server at `mcp.nemar.org`.
ADR 0049 fixes the shape: a stateless, recipe-first broker on Cloudflare
Workers that never computes what a client can compute, with bulk bytes going
direct to S3.
Every converter-side prerequisite this server needs landed in epic #1181:
index v3, `events.parquet`, `catalog.json`, `has_zarr`, and the 302 redirect
contract on `zarr.nemar.org`.
Nothing in the server waits on the data plane.

The owner's standing constraint for this phase is to **minimize Worker
processing**.
Every tool call invokes the Worker, because MCP over Streamable HTTP is
POST JSON-RPC; there is no way to serve a tool call without one Worker
invocation.
So the lever available to this design is CPU milliseconds and subrequests
per call, not invocation count.
Three rules follow from that constraint and recur throughout this document:

1. **Never decode more than a capped taste inside the Worker.**
   Bulk signal reads are a recipe (an S3 URI, a byte range, a scale/offset
   formula, and two ready-to-run code snippets), not bytes.
2. **Cache the expensive parse once per `(dataset_id, source_commit)`, then
   slice the cached result on every call.**
   `index.json` for the largest dataset in the catalog is 12.8 MB; no tool
   should parse it more than once per conversion.
3. **Reuse the existing zarr gateway's D1 gate and edge cache for
   `index.json` itself**, rather than re-implementing dataset visibility or
   cache invalidation a second time in the MCP host.

## 2. Protocol revision and dual-era behavior

The MCP specification revision current since 2026-07-28 is stateless by
construction: no sessions, no `Mcp-Session-Id`, no `initialize` handshake for
a modern client (every request self-describes in `params._meta`), no SSE
resumability, mandatory `server/discover`, and `CacheableResult` (`ttlMs`,
`cacheScope`) on every list result.
Authorization stays optional, so an anonymous server is fully conformant.

The TypeScript SDK split into scoped v2 packages on 2026-07-27 to implement
this revision.
`@modelcontextprotocol/server@2.0.0` ships `McpServer` and
`createMcpHandler`; `@modelcontextprotocol/hono@2.0.0` ships
`createMcpHonoApp`, which wraps a Hono app with the DNS-rebinding and Origin
validation the SDK's other framework adapters ship too.
The wiring, taken verbatim from the SDK's own `examples/hono/server.ts` and
verified against a real `wrangler dev` run in this phase's spike:

```ts
import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";

const handler = createMcpHandler(buildServer); // buildServer returns a fresh McpServer per request
const app = createMcpHonoApp();
app.all("/mcp", (c) => handler.fetch(c.req.raw));
```

`createMcpHandler`'s default `legacy: 'stateless'` serves BOTH eras from this
one route: a 2026-07-28 client gets per-request envelope handling, and a
2025-era client is served through the established stateless
`initialize` + `tools/call` idiom, with no branching in `buildServer` at all.
Do not mount `@modelcontextprotocol/server-legacy` (the frozen v1 SSE/OAuth
code; it is not a compatibility shim, it is the old package under a new
name), and do not use `@hono/mcp` (peer-depends on SDK 1.x) or Cloudflare's
`agents` package (`McpAgent` is Durable-Object stateful, which contradicts
ADR 0049's stateless broker decision outright).

### 2.1 What "modern" actually requires on the wire

The spike's smoke test exercised the real request/response shapes rather
than trusting the spec summary alone.
Confirmed against `@modelcontextprotocol/server@2.0.0`'s own classifier
(`classifyInboundRequest`, `validateStandardRequestHeaders`):

- **Classification is body-primary.**
  A request is "modern" the moment `params._meta` carries the reserved key
  `io.modelcontextprotocol/protocolVersion`.
  The `MCP-Protocol-Version` HTTP header is optional and only cross-checked
  against the body's claim when both are present; it is never the sole
  signal.
- **The required `_meta` envelope keys are exactly two:**
  `io.modelcontextprotocol/protocolVersion` (a string) and
  `io.modelcontextprotocol/clientCapabilities` (an object; `{}` validates).
  `io.modelcontextprotocol/clientInfo` and `io.modelcontextprotocol/logLevel`
  are optional.
- **`Mcp-Method` is mandatory on every modern POST.**
  Its value must equal the JSON-RPC body's `method`.
  A present-but-disagreeing header is rejected at the classifier's own
  edge rung; an ABSENT header is rejected by a separate post-classification
  check (`validateStandardRequestHeaders`).
  Both land on the same wire error: HTTP 400, JSON-RPC `-32020`
  (`HeaderMismatch`).
- **`Mcp-Name` is mandatory only for `tools/call`, `prompts/get`, and
  `resources/read`** (SEP-2243's `MCP_NAME_HEADER_SOURCE` table), mirroring
  `params.name` or `params.uri` respectively.
  It is not required, and has no effect, on `tools/list`, `server/discover`,
  or any other method.
  The plan's summary ("mandatory `Mcp-Method` and `Mcp-Name` headers on
  every POST") is imprecise on this one point; `Mcp-Method` is universal,
  `Mcp-Name` is method-scoped.
- **A legacy 2025-era `initialize` handshake needs an `Accept: application/json,
  text/event-stream` header.**
  Without it the endpoint answers `-32000` ("Not Acceptable").
  This is Streamable HTTP transport behavior, not something particular to
  this server.
- **`GET` and `DELETE` on `/mcp` answer 405, even in the default dual-era
  posture** (`legacy: 'stateless'`, not `legacy: 'reject'`).
  The plan's verified facts attributed the 405 to "modern-only servers"
  specifically; the spike found it holds for a dual-era server too, because
  neither era's transport defines a `GET`/`DELETE` semantics on this
  endpoint in the first place.

### 2.2 Cache hints

`ServerOptions.cacheHints` sets per-operation defaults; a handler or a
per-registration `cacheHint` can override them.
This phase sets `tools/list` and `server/discover` to
`{ ttlMs: 86_400_000, cacheScope: 'public' }` (24 hours, per decision 5):
the tool registry is fixed at deploy time, so there is no reason for a
client to re-fetch it inside a day.
Resolution order, most-specific first: the handler's own result, a
per-registration `cacheHint`, the server-level `cacheHints`, then the
conservative default (`ttlMs: 0`, `cacheScope: 'private'`).
2025-era responses never carry these fields; they are silently absent on
that wire, not defaulted to zero on it.

## 3. Host and routing

Phase 2 implements this section; phase 1 only specifies it.

- A new `HostRoute` arm `"mcp"` in `backend/src/services/host-routing.ts`,
  alongside the existing `"data"` / `"zarr"` / `"api"` forks.
- `MCP_HOSTNAME` in `backend/src/types/bindings.ts`, following the same
  pattern as `DATA_HOSTNAME` / `ZARR_HOSTNAME`.
- `mcp.nemar.org` and `mcp-test.nemar.org` custom-domain routes, plus
  `MCP_HOSTNAME` vars in `backend/wrangler-sccn.toml` for both the
  production and `[env.dev]` sections.
- A path mount `/mcp` on the `api` host fork, for the workers.dev fallback
  and any client that cannot reach the custom domain.
- The canonical client URL is `https://mcp.nemar.org/mcp`.
  A client should never construct any other URL for this server.

## 4. Access

Anonymous.
No authorization header is required or checked.
The existing `rateLimiter` (`backend/src/middleware/rateLimit.ts`) applies
at the Hono layer, before the MCP handler, on its default (unauthenticated
`ip`) bucket.
A later gate can ride the device authorization grant (ADR 0047) without
changing a single tool signature, because the tools carry no notion of
identity today.

## 5. Tool surface

Six tools, ordered by cost.
Every tool's OUTPUT includes a provenance envelope (`section 6.1`); this is
not optional and not only present when the caller asks for it.
Full input/output shapes live in `shared/contract/mcp.ts`; this section is
the narrative each schema's JSDoc restates in code.

### 5.1 `search_datasets`

**Inputs:** `query?`, `modality?`, `task?`, `min_participants?`, `has_hed?`,
`has_zarr?`, `limit` (default 20, capped at 100).
**Outputs:** a page of catalog rows (`dataset_id`, `name`, `doi`, `license`,
`modalities`, `tasks`, `subject_count`, `has_hed`, `has_zarr`) plus `count`
and `limit`.
**Cost class:** one `api.nemar.org/datasets` (or `/datasets/search`) fetch;
no signal bytes, no `index.json` read.
**Cache behavior:** whatever cache policy the wrapped catalog endpoint
already has; this tool adds none of its own.
**`has_zarr` means converted, never verified.**
`zarr_verify_status` never appears as a filter default on this tool; a
caller who wants only fidelity-verified datasets reads
`zarr_verify_status` off `describe_dataset`'s output per dataset and filters
client-side.
**Error that teaches:** an unrecognized `modality`/`task` value is not
rejected outright (the catalog's own vocabulary is authoritative and can
grow); the response's `count` is simply 0, and the tool description should
point the caller at `describe_dataset`'s facet fields on any hit for
spelling.

### 5.2 `describe_dataset`

**Inputs:** `dataset_id`.
**Outputs:** the catalog row's descriptive fields, plus a `cost_hint` object
naming the next cheapest tool and why.
**Cost class:** the D1 row plus the dataset's `catalog.json` entry.
**Never `index.json`** -- the largest index in the catalog is 12.8 MB, and
this tool answers a question `catalog.json` already answers per dataset.
**Cache behavior:** none beyond what the underlying D1 read and
`catalog.json` fetch already have (the catalog document itself is
edge-cached for an hour by `serveCatalog` in `zarr-data.ts`).
**Error that teaches:** an unknown `dataset_id` answers a tool error whose
message says the id was not found in the catalog and suggests
`search_datasets` with a `query` guess, rather than a bare "not found."

### 5.3 `list_recordings`

**Inputs:** `dataset_id`, `modality?`, `min_duration_s?`,
`include_derived` (default `false`), `limit` (default 50, capped at 500),
`offset` (default 0).
**Outputs:** a page of compact recording summaries (`path`, `zarr`,
`source_tree`, `derived`, `groups[]`), `total_count`,
`excluded_derived_count`, `source_commit`.
**Cost class:** one `index.json` parse per `(dataset_id, source_commit)`,
ever; every subsequent call for the same pair is a cache match plus a
slice.
**`include_derived` defaults false.**
A caller has to opt in to seeing an ADR 0028 SSS-filtered MEG store; the
count excluded by that default is always reported
(`excluded_derived_count`), so the omission is visible rather than silent,
matching the day-one value issue #1065 named for this tool.
**Cache behavior:** see section 7; the compact projection (not the raw
`index.json`) is what gets cached, keyed by `(dataset_id, source_commit)`,
long TTL (immutable per commit).
**Error that teaches:** a dataset with `zarr_status` not `ready` answers a
tool error naming the actual status (`pending` or `failed`) rather than an
empty recordings list, so a caller does not read "zero recordings" as "this
dataset has no data."

### 5.4 `get_events`

**Inputs:** `dataset_id`, `recording` (a store's `path` or `zarr`),
`group?`.
**Outputs:** `events[]` (`store_path`, `group_name`, `onset_s`,
`duration_s?`, `sample_index`, `trial_type?`, `value?`, `hed?`), `source`
(`"events_parquet"` or `"events_tsv_fallback"`), `estimated` (boolean).
**Cost class:** `events.parquet` range reads via `hyparquet` +
`hyparquet-compressors` (zstd), once per `(dataset_id, source_commit)`,
cached the same way `list_recordings`' projection is.
**The fallback flips `estimated: true`.**
When the index names no `events_parquet`, the tool falls back to
`events.tsv` from `data.nemar.org` and computes a sample index locally;
that estimate is wrong by a sub-sample amount wherever source and target
rates are not integer multiples, which is common in this catalog, so the
flag is load-bearing, not decorative.
The primary path never sets it, because the converter's own
`sample_index` (`floor(onset_s * rate + 0.5)`, computed against the SERVING
rate) is exact.
**Error that teaches:** a `recording` that does not match any store's
`path` or `zarr` in the cached index answers a tool error listing the
dataset's actual recording identifiers (or a truncated sample of them for a
large dataset), not a bare "not found."

### 5.5 `render_overview`

**Inputs:** `dataset_id`, `recording`, `group?`, `width_px`
(default 800, capped at 4000).
**Outputs:** an MCP `image` content block (`image/png`, base64) plus a
metadata object (`level`, `width_px`, `height_px`, `mime_type`).
**Cost class:** reads the `view/*` min-max pyramid, never level 0; those
reads are kilobytes by construction (biosigIO chunks the pyramid at a
constant column count across levels since 1.2.6, so a viewport-sized read
is one to three requests at any level).
**Picks the smallest view level satisfying `width_px`** -- never a level
finer than what the requested pixel width can show, so the Worker never
decodes more samples than the image needs.
**Cache behavior:** the DECODED pyramid level (not the rendered PNG) is
what gets cached per `(dataset_id, source_commit, recording, group, level)`;
re-rendering a PNG at a different `width_px` from an already-decoded level
is cheap enough to redo per call rather than multiply cache entries by
every possible width.
**Error that teaches:** a `group` that exists in the index but has no
`view/*` pyramid (a store converted before biosigio 1.2.6, or `n_view_levels:
0`) answers a tool error saying so explicitly, distinct from "recording not
found."

### 5.6 `read_window`

**Inputs:** `dataset_id`, `recording`, `group?`, `start_s` (default 0),
`duration_s` (default 10), `channels?` (an array of channel indices),
`taste` (default `false`).
**Outputs (recipe mode, the default):** `{ mode: "recipe", recipe,
envelope }`, where `recipe` is `shared/contract/mcp.ts`'s
`readRecipeSchema` (section 6.2).
**Outputs (taste mode, opt-in):** `{ mode: "taste", start_s, duration_s,
channels, sample_rate_hz, values, envelope }`, `values` already scaled to
physical units.
**Cost class (recipe):** one `index.json` read (cached) plus zero S3
reads; the Worker never touches a signal byte.
**Cost class (taste):** decodes exactly the inner chunks the requested
window spans, capped at `duration_s x channels.length <= 3840` (60 s x 64
channels; see decision 7 and the spike's decode-path verdict below) -- past
the cap, `read_window` never truncates silently, it answers the recipe
instead, because a caller asking for a window this large almost certainly
wants the S3 path anyway.
**Cache behavior:** none across calls (a taste is an inline decode of
specific inner chunks on demand); the recipe path's inputs (`index.json`,
chunk geometry) are the same cached projection every other tool reads.
**Error that teaches:** a `channels` list naming an index past the group's
`n_channels`, or a `start_s + duration_s` past the group's `duration_s`,
answers a tool error naming the actual bound, not a truncated or
zero-padded result.

## 6. Envelope and recipe field tables

Both live in `shared/contract/mcp.ts`, `.passthrough()` per the repository's
established lower-bound convention (`shared/contract/dataset.ts`'s module
doc): a schema here asserts required fields and their types, so an additive
field on either side of the wire never breaks an older consumer.

### 6.1 Provenance envelope

| Field | Type | Source |
|---|---|---|
| `dataset_id` | string | `index.dataset_id` |
| `doi` | string \| null | catalog entry, falling back to `index.doi` |
| `license` | string \| null | catalog entry, falling back to `index.license` |
| `citation` | string \| null | `index.citation` |
| `source_commit` | string (40-hex) | `index.source_commit` |
| `index_etag` | string \| null | the `index.json` HTTP response's ETag, when kept |
| `engine_version` | string | `index.engine_version` |
| `source_tree` | `"raw"` | `store.source_tree` (always `"raw"`, ADR 0027) |
| `derived` | boolean | `store.derived` |
| `sss` | object, optional | `store.sss`, present exactly when `derived` is true (ADR 0028) |
| `lossy` | boolean | always `true` today -- every served level-0 array is int16-quantized and rate-capped relative to the source; there is no lossless path |
| `dtype` | string \| null | from the array-metadata fetch (`zarr.json`), null until made |
| `effective_rate_hz` | number \| null | `group.rate` (the SERVING rate, after the cap) |
| `source_rate_hz` | number \| null | `group.source_rate_hz` (before the cap) |
| `units_report` | object \| null, optional | `store.units_report` |
| `zarr_verify_status` | `"verified"` \| `"failed"` \| `"unverifiable"` \| null | catalog entry's fidelity-sweep verdict; never a filter default anywhere |
| `note` | string \| null, optional | a short caveat the caller should surface verbatim |

### 6.2 Read recipe

| Field | Type | Notes |
|---|---|---|
| `contract_base`, `data_base`, `s3_uri`, `s3_region`, `s3_anonymous` | from `index.json` verbatim | |
| `zarr` | string | the store's `zarr` path |
| `group` | string | the channel group name |
| `level` | `"0"` \| positive integer | `"0"` for the signal array, a view level otherwise |
| `array_path` | string (absolute URL) | `contract_base` + the path `layout.level0`/`layout.view` computes -- the caller never fills the template |
| `dtype`, `codecs` | string \| null, array, optional | from the array-metadata fetch; absent means "not made" |
| `chunk_samples`, `shard_samples`, `n_channels` | number \| null | straight from the index's group entry, no extra fetch |
| `sample_slice`, `channel_slice` | `{ start, end }`, optional | present when the caller named a window |
| `scale_offset` | string | `layout.scale_offset` verbatim: WHERE to find the conversion, not the values themselves |
| `how_to.python_zarr` | string | a ready-to-run Python snippet: `zarr.open(s3_uri, storage_options={"anon": True})`, slice, done |
| `how_to.zarrita` | string | the TypeScript/JS equivalent using `zarrita` |

`buildReadRecipe()` (`shared/contract/mcp.ts`) computes every field above
from an index document plus the store/group it names -- no probing, per the
index's own `layout` doc comment.
Verified against the on008083 fixture in
`test/contract-mcp.unit.test.ts`: `array_path` for level 0 resolves to
`https://zarr.nemar.org/on008083/zarr/sub-01/eeg/a_eeg.zarr/eeg_250hz/0`,
and for view level 1 to the matching `.../eeg_250hz/view/1`.

## 7. Compute-minimization rules and cache key scheme

Restating decision 4 of the phase 1 plan, made concrete:

- **`index.json` is fetched through the existing zarr sub-app**
  (`createZarrDataRoutes(...).fetch(new Request(...))`), so the D1 public
  gate, `canonicalCacheUrl` edge cache, and the `ZARR_DATASET_DOCUMENTS`
  purge list apply unchanged.
  The MCP host does not re-implement any of that.
- **Derived projections use synthetic cache URLs on the mcp host:**
  `https://mcp.nemar.org/_cache/<dataset_id>/<source_commit>/<projection>`.
  `<projection>` is one of `recordings` (the `list_recordings` compact
  array, unfiltered -- filters apply after the cache read, not before),
  `events` (the parsed `events.parquet` rows, unfiltered the same way), or
  `overview/<recording>/<group>/<level>` (the decoded pyramid level, one
  entry per level actually requested, not every level up front).
  All three are immutable per `source_commit`, so they get a long TTL
  (a day or more; the exact number is a phase 2 acceptance item, not fixed
  here).
- **The tool registry is module-scope.**
  Only the transport (`PerRequestHTTPServerTransport`) and the `McpServer`
  instance `createMcpHandler`'s factory returns are per-request; the tool
  definitions themselves, their zod schemas, and any static lookup tables
  are constructed once at module load and reused across invocations within
  one isolate's lifetime.
- **`read_window` is recipe-first.**
  See section 5.6; this is the single biggest lever, because it is the one
  tool whose naive implementation would touch the most bytes.

## 8. Analytics event shape

One Cloudflare Analytics Engine data point per tool call, mirroring the
existing `buildAccessDataPoint` shape in
`backend/src/services/access-metrics.ts` (index + blobs + doubles) rather
than inventing a second convention:

```
indexes: [tool_name]
blobs:   [tool_name, dataset_id ?? "-", cache_status]   // cache_status: "hit" | "miss" | "none"
doubles: [elapsed_ms, upstream_bytes]
```

`cache_status` is `"none"` for a tool call that never consults the
projection cache at all (`search_datasets`, a `read_window` taste), so the
dashboard can tell "cache was irrelevant here" apart from "cache was
consulted and missed."
Whether this rides the existing `ANALYTICS` binding under a new `source`
value, or a dedicated AE dataset, is a phase 2 decision; this section fixes
only the point shape, per decision 4's last bullet.
Phase 2 also sets a p95 CPU budget per call as acceptance criteria, using
this same point's `elapsed_ms` field as the measurement.

## 9. Dependency table

| Package | Version pinned | Role | Spike verdict |
|---|---|---|---|
| `@modelcontextprotocol/server` | `2.0.0` (exact) | MCP server SDK, `createMcpHandler`, `McpServer` | **Works under workerd.** Both protocol eras served correctly; see section 10. |
| `@modelcontextprotocol/hono` | `2.0.0` (exact) | Hono adapter, `createMcpHonoApp` | **Works.** Peers `hono ^4.11.4`, `@modelcontextprotocol/server ^2.0.0`. |
| `zod` | `^3.23.x` (repo bump reverted, see section 10.1) | SDK peer dependency; also this phase's own contract schemas | **Repo bump reverted.** `bun run typecheck` went green after two mechanical fixes (`z.record(valueSchema)` &rarr; `z.record(z.string(), valueSchema)` in three call sites), but `bun test` surfaced a real zod-4/`@asteasolutions/zod-to-openapi` incompatibility that a mechanical fix cannot close without adding new test-preload infrastructure the repo does not have today. Reverted per decision 10's fallback; see section 10.1. This phase's own contract files (`shared/contract/zarr-index.ts`, `shared/contract/mcp.ts`) use only zod APIs unchanged between 3 and 4, so the revert cost them one type-name edit (`z.SafeParseReturnType` instead of zod 4's `z.ZodSafeParseResult`). |
| `hono` | `^4.11.4` | Hono itself; backend previously pinned `^4.6.0` | **Bumped and kept**, per decision 10's unconditional instruction. `bun run typecheck` and the backend suite are green at this version regardless of the zod outcome. |
| `numcodecs` | `0.3.2` | JS Blosc/Zstd/GZip/LZ4/Zlib codecs, WASM-backed | **Does not run under workerd.** `numcodecs/blosc` loads its WASM module via a runtime `fetch()` + `WebAssembly.instantiate()` on the fetched bytes -- dynamic code generation, which workerd's embedder disallows by default. The npm package ships no `.wasm` file to statically import as a workaround either. Not a dependency of the real server; kept only as the spike's path (a) for the record. |
| `fzstd` | `0.1.1` | Pure-JS zstd decompressor, no WASM | **Works under workerd**, and is the chosen decode primitive (decision 7). Also what `hyparquet-compressors` uses for `events.parquet`, so one decoder serves both `render_overview`/`read_window`'s taste and `get_events`. |
| `hyparquet` | `1.30.0` | Parquet reader (`asyncBufferFromUrl`, `parquetReadObjects`) | Not exercised by this spike; snappy is built in, zstd needs `hyparquet-compressors`. Phase 3 item. |
| `hyparquet-compressors` | matching `hyparquet` | zstd codec for `hyparquet` | Same as above. |
| `fast-png` | `8.0.0` | PNG encoding for `render_overview`, pure JS via `fflate` | Not exercised by this spike (no image-producing tool in it). Chosen because it has no WASM dependency, consistent with this phase's decode-path finding. Phase 3 item. |
| `zarrita` | `0.7.5` | Zarr store/array abstraction, FetchStore, sharding | **Not directly exercised by this spike.** The spike tested the codec layer (blosc/zstd decode) in isolation, which is the part decision 7 needed evidence on; zarrita's own store/array logic has no WASM dependency of its own (only the codec it would otherwise delegate to, which this phase replaces with the pure-JS path). Whether to use zarrita for chunk-key/shard-index bookkeeping or hand-roll it (as the spike does, see `README.md`'s shard-index derivation) is a phase 2 decision. |

## 10. Spike results

Full detail, including the exact failure message and the byte-level
derivation of `fixtures/chunk.bin`, is in
`backend/spike/mcp-transport/README.md`.
Summary:

| Measurement | Result |
|---|---|
| Transport, both protocol eras | All of `server/discover`, `tools/list`, `tools/call` (2026-07-28 envelope), the legacy `initialize` handshake, a legacy `tools/call` with no envelope, the `-32020` rejection (disagreeing `Mcp-Name`, missing `Mcp-Method`), and `GET`/`DELETE` 405 -- all behave exactly as documented, under a real `wrangler dev` run. |
| Bundle size, with `numcodecs` | 1447.36 KiB / gzip 465.24 KiB (`wrangler deploy --dry-run`) |
| Bundle size, without `numcodecs` | 843.69 KiB / gzip 263.17 KiB |
| `numcodecs`' contribution | ~604 KiB / ~202 KiB gzip, and it does not work (see below) -- pure cost, no benefit |
| `tools/list` wall time (local `wrangler dev`, 5 calls) | 2.1-2.5 ms |
| `tools/call decode_chunk` wall time (local `wrangler dev`, 5 calls) | 4.5-5.7 ms |
| Decode path (a): `numcodecs` WASM Blosc | **Fails.** `RuntimeError: Aborted(CompileError: WebAssembly.instantiate(): Wasm code generation disallowed by embedder)`. Dynamic WASM compilation from a runtime-fetched byte buffer is exactly what workerd blocks by default; the package also ships no `.wasm` file to statically import instead. |
| Decode path (b): pure JS (blosc2 header parse + `fzstd` + unshuffle) | **Works, and matches the Python-derived ground truth exactly**: first/last 16 values, full-array sum, and an order-sensitive weighted checksum all agree with `fixtures/chunk.expected.json`. |
| **Chosen decode path** | **(b), pure JS.** Decision 7's stated preference (`fzstd` also serves `events.parquet`) is confirmed, and path (a) is now disqualified on evidence, not preference: it does not run on the target platform at all. |

### 10.1 The zod / hono repo-wide bump

Attempted per plan step 5: bump `zod` to `^4.2.0` in both root and
`backend/package.json`, and `hono` to `^4.11.4` in `backend/package.json`,
then `bun install && bun test && bun run typecheck` at the repo root.

**`bun run typecheck` reached green after two mechanical fixes.**
`z.record(valueSchema)` (the single-argument form, implicitly keyed by
string) was removed in zod 4; `z.record(keySchema, valueSchema)` is now
required.
Three call sites needed the one-line fix: `src/lib/upload-progress.ts`
(one), `backend/src/routes/admin/doi.ts` (two).
This phase's own new code (`shared/contract/zarr-index.ts`,
`shared/contract/mcp.ts`, and the pre-existing `shared/contract/dataset.ts`)
already used the two-argument form throughout, so none of it needed
changing.
Separately, zod 4 renamed `z.SafeParseReturnType<Input, Output>` to
`z.ZodSafeParseResult<Output>` (one type parameter, not two); this phase's
`safeParseZarrIndex` needed that one type-annotation update.
Both fixes are kept even after the revert below: the two-argument
`z.record()` form is valid under zod 3 too (it was always the more explicit
spelling of the same call), so there is no reason to undo it.

**`bun test` surfaced a real, non-mechanical incompatibility, and the bump
was reverted.**
`backend/test/openapi-document.test.ts`'s drift guard failed:
`TypeError: strictVersionTagSchema.openapi is not a function`.
`scripts/generate-openapi.ts` extends zod with
`@asteasolutions/zod-to-openapi`'s `extendZodWithOpenApi(z)`, which patches
`ZodType.prototype.openapi` so every zod schema gets an `.openapi()` method.
Under zod 3 this patch is retroactive (a prototype-chain lookup, so import
order never mattered); under zod 4 it is not.
Traced with a minimal reproduction inside this repo (not a synthetic
sandbox, since the failure did not reproduce outside this project's own
`node_modules` -- see the phase 1 PR body for the full derivation
transcript): a zod 4 schema's concrete prototype is apparently
constructed once per shape and does not pick up a LATER patch to
`ZodType.prototype`, so a contract schema imported (and therefore
constructed) before `extendZodWithOpenApi(z)` runs never gets `.openapi()`,
even though `instanceof z.ZodType` still reports `true` for it.
Bumping `@asteasolutions/zod-to-openapi` itself (`^7.3.4` &rarr; `^9.1.0`,
which declares `zod: "^4.0.0"` as its peer) did not change this behavior --
the incompatibility is about import ORDER relative to the patch, not the
library version.

The mechanical-looking fix (extract the `extendZodWithOpenApi(z)` call into
its own side-effect module and import it before any `shared/contract/*`
import in `scripts/generate-openapi.ts`) verified correctly in isolation,
but does not close the gate: `bun test` at the repo root runs `test/` and
`backend/test/` in ONE process, and dozens of OTHER test files import
`shared/contract/*` schemas before `openapi-document.test.ts`'s own module
graph ever runs, permanently caching the un-patched prototype for the whole
process.
Fixing that robustly needs a bun test PRELOAD hook (`bunfig.toml`'s
`[test] preload`) guaranteeing the extend call is the first zod-touching
code in the whole suite -- new test infrastructure the repo does not have
today, which is a redesign of the test harness's module-loading order, not
a mechanical gate-passing fix.
That is outside this implementer's mandate (the plan explicitly says do not
redesign around a plan conflict), so the bump was reverted per decision 10's
own fallback: **the repo's `zod` pin stays `^3.23.x`; this phase's contracts
stay on zod 3; the MCP SDK's own nested zod 4 copy (inside
`node_modules/@modelcontextprotocol/*`) is what the SDK itself uses, and the
spike's isolated `package.json` is what proves the SDK's tool-registration
API against that copy** -- the "two-copy risk" decision 10 named. `hono` stays
bumped to `^4.11.4` per decision 10's unconditional instruction; that half
of the bump has no such conflict and both `bun test` and `bun run typecheck`
are green with it.

A real fix for the underlying `zod-to-openapi`/zod-4 order dependency is a
separate, standalone piece of work (introduce the preload hook, or move
`extendZodWithOpenApi` earlier some other way) -- worth its own issue, not a
silent side effect of this design phase.

## 11. Client compatibility

| Client | Supports protocol revision 2026-07-28 |
|---|---|
| Claude Code | Yes (v2 runtime) |
| Claude Desktop | Stated supported by Anthropic; version unverified in this phase |
| Cursor | Unverified; likely not yet |
| Python `mcp` (PyPI) | Yes, from 2.2.0 |
| `langchain-mcp-adapters` | No -- pins `mcp<2.0.0`. OSA's own consumer (ADR 0049) must therefore speak `mcp` 2.x directly, not through `langchain-mcp-adapters`, to reach this server's 2026-07-28 features. A 2025-era fallback still works against `langchain-mcp-adapters`, since this server serves both eras from the same endpoint. |

## 12. Open items for phases 2 to 5

- **Phase 2 (#1294):** the host fork (`HostRoute "mcp"`, `MCP_HOSTNAME`,
  wrangler routes) and `search_datasets` / `describe_dataset` /
  `server/discover` wiring against a real D1 binding.
  Also: pick the exact TTL for the three synthetic-cache-URL projections
  (section 7), and land the Analytics Engine point (section 8) with a p95
  CPU budget as acceptance.
- **Phase 3 (#1295):** `list_recordings` and `get_events`, including the
  `hyparquet` + `hyparquet-compressors` wiring against real
  `events.parquet` objects, and the `events.tsv` fallback path.
- **Phase 4 (#1296):** `render_overview` (the `fast-png` encode path) and
  `read_window` (the recipe builder wired to live `index.json` data, plus
  the capped taste using this phase's chosen decode path).
- **Phase 5 (#1297):** docs site coverage, the OSA tool-registration wiring
  ADR 0049 anticipates, and the release.
- **ADR 0050** (decision 11): `origin/dev` did not yet carry ADR 0049 when
  this PR was opened (PR #1292 was still open), so per the plan's numbering
  rule this PR omits the ADR file and the README index entry.
  The decision text above (sections 2 to 4 and 7, and this section's decode
  verdict) stands in for it until phase 5, where ADR 0050 should be filed
  once ADR 0049 has landed and its final number is confirmed unclaimed.
- **Whether `zarrita` is used as-is or replaced by hand-rolled chunk-key /
  shard-index logic** (as this phase's spike does for `decode_chunk`) is
  still open; either way, the codec underneath it is this phase's path (b),
  never `numcodecs`.
- **The browser-origin allowlist decision** (which origins beyond
  `nemar.org` get proxied `zarr.nemar.org` access for a browser-executed
  OSA widget, per ADR 0049) is explicitly out of scope for this phase and
  the epic's later phases.
