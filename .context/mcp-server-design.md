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

**Phase 2 correction:** `createMcpHonoApp` builds a STANDALONE Hono app with
its own localhost host/origin validation baked in.
The real server does not live standalone; it lives inside the existing
single worker behind `resolveHostRoute` (section 3), alongside `data`,
`zarr`, and `api`.
Wrapping a second, independent Hono app inside that arrangement would mean
two disagreeing origin-validation layers (`createMcpHonoApp`'s own
localhost-only defaults, wrong for a production custom domain, versus this
worker's real NEMAR-origin allowlist) and would still need to be dispatched
to from the outer fork by hand either way.
So phase 2 uses `createMcpHandler` directly, inside a self-contained Hono
sub-app modeled on `createZarrDataRoutes`
(`backend/src/routes/zarr-data.ts`) rather than the api middleware stack,
with the ORIGIN VALIDATION AND RATE LIMITING DONE HERE INSTEAD -- an origin
gate mirroring the SDK's own middleware (`allowedOrigin`/`corsHeaders` from
`zarr-data.ts`, reused rather than reinvented) and the same rate-limiter
bridge the zarr sub-app uses.
`@modelcontextprotocol/hono` is NOT a dependency of this repo.
The wiring (`backend/src/routes/mcp.ts`, `backend/src/mcp/server.ts`):

```ts
import { createMcpHandler } from "@modelcontextprotocol/server";
import { buildMcpServer } from "../mcp/server.js";

app.all("/mcp", async (c) => {
  const handler = createMcpHandler(
    (ctx) => buildMcpServer({ env: c.env, executionCtx: c.executionCtx, era: ctx.era }),
    { onerror: deps.onerror },
  );
  const response = await handler.fetch(c.req.raw);
  // ...corsHeaders(origin) merged onto the response...
});
```

`createMcpHandler`'s default `legacy: 'stateless'` serves BOTH eras from this
one route: a 2026-07-28 client gets per-request envelope handling, and a
2025-era client is served through the established stateless
`initialize` + `tools/call` idiom, with no branching in `buildMcpServer` at
all -- verified in phase 2 (`backend/test/mcp-route.test.ts`): the same
`search_datasets`/`describe_dataset` tools answer both a modern `tools/call`
and a legacy one built with no `_meta` envelope at all.
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
- **A registered tool's own input-schema rejection is an in-band tool
  result, not a JSON-RPC protocol error.** Phase 2 (`backend/test/mcp-route.test.ts`)
  verified against the real SDK: `tools/call describe_dataset` with a
  malformed `dataset_id` answers HTTP 200 with `isError: true` and a
  `content[0].text` naming the failed field -- the SAME shape a tool's own
  business-logic error (an unknown dataset id) uses -- NOT the bare
  `{ error: { code, message } }` JSON-RPC envelope the `Mcp-Name`
  header/body mismatch (`-32020`) or the origin gate (`-32000`) answer with.
  Phase 1's plan and phase 2's own implementation plan both called this "a
  JSON-RPC validation error"; that phrase describes the `-32020`/`-32000`
  family, not `registerTool`'s own input validation. A caller (or a test)
  checking for a tool-input rejection should read `result.isError`, never a
  bare `response.error`.

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

**Implemented in phase 2** (`backend/src/services/host-routing.ts`,
`backend/src/routes/mcp.ts`, `backend/src/index.ts`).

- A new `HostRoute` arm `"mcp"` in `backend/src/services/host-routing.ts`,
  alongside the existing `"data"` / `"zarr"` / `"api"` forks.
- `MCP_HOSTNAME` in `backend/src/types/bindings.ts`, following the same
  pattern as `DATA_HOSTNAME` / `ZARR_HOSTNAME`.
- `mcp.nemar.org` and `mcp-test.nemar.org` custom-domain routes, plus
  `MCP_HOSTNAME` vars in `backend/wrangler-sccn.toml` for both the
  production and `[env.dev]` sections.
- A path mount `/mcp` on the `api` host fork, for the workers.dev fallback
  and any client that cannot reach the custom domain: `app.all("/mcp", (c) =>
  mcpRoutes.fetch(c.req.raw, c.env, c.executionCtx))`, a single-path forward
  (not a `.route()` sub-tree mount like `/zarrproxy`), so the sub-app sees
  the request at exactly `/mcp`. That means the sub-app's own `GET /`
  descriptor (section 2.2 endpoint discovery) is reachable ONLY via the
  hostname fork, never via the workers.dev/path-mount fallback -- a real,
  observed asymmetry between the two entry points, not a gap: the fallback
  exists for the transport endpoint, not the descriptor.
- The canonical client URL is `https://mcp.nemar.org/mcp`.
  A client should never construct any other URL for this server.
- Anonymous origin gate + rate limiting are done IN THE SUB-APP itself
  (`allowedOrigin`/`corsHeaders`, reused from `zarr-data.ts`; the same
  double-cast `rateLimiter` bridge zarr's sub-app uses), not delegated to
  `@modelcontextprotocol/hono`'s standalone origin/host validation -- see
  section 2's phase 2 correction for why.

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

**Phase 2 correction:** the provenance envelope (section 6.1) rides
RECORDING-level tool responses only -- `list_recordings`, `get_events`,
`render_overview`, `read_window` (phases 3 and 4) -- not optional and not
only present when the caller asks for it, THERE.
`search_datasets` and `describe_dataset` (this phase) never construct one:
building an envelope means reading `index.json` (the envelope's `doi`
fallback, `citation`, `source_commit`, `engine_version` all come from that
document per section 6.1's source table), and `describe_dataset`'s entire
point is answering from D1 plus `catalog.json` WITHOUT that read (section
5.2's "never `index.json`" rule).
Forcing an envelope onto a dataset-level tool would mean either paying for
the index read this phase is designed to avoid, or fabricating envelope
fields from data that was never fetched.
So `search_datasets`'/`describe_dataset`'s own output schemas carry `doi`,
`license`, (`describe_dataset` additionally: `citation`, `zarr_status`,
`zarr_source_commit`, `zarr_verify_status`) directly as top-level fields
instead -- see `shared/contract/mcp.ts`'s `describeDatasetOutputSchema` and
`provenanceEnvelopeSchema`'s own updated module doc.
Full input/output shapes live in `shared/contract/mcp.ts`; this section is
the narrative each schema's JSDoc restates in code.

### 5.1 `search_datasets`

**Inputs:** `query?`, `modality?`, `task?`, `has_hed?`, `has_zarr?`,
`limit` (default 20, capped at 100).
There is no participant-count input because the catalog has no such filter
server-side; a caller reads `subject_count` off each hit instead.
Adding one later is a catalog change first and a tool change second.
**Outputs:** a page of catalog rows (`dataset_id`, `name`, `doi`, `license`,
`modalities`, `tasks`, `subject_count`, `has_hed`, `has_zarr`) plus `count`
and `limit`.
`has_hed` is a boolean on the wire; the catalog's `0 | 1 | null` goes
through the contract's `flagToBoolean`, the one place that conversion lives.
**Cost class:** one catalog fetch: `GET /datasets/search`
(`executeDatasetSearch`, FTS plus Vectorize) when `query` is present, since
that route rejects a request without `q`, and the plain `GET /datasets` list
otherwise; no signal bytes, no `index.json` read.
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
**Cache behavior:** the rendered PNG itself is what gets cached, per
`(dataset_id, source_commit, recording, group, width_px)`, so a repeat call
at the same width is a cache match with zero decode and zero encode work
(decision 4 of the phase 1 plan).
`width_px` defaults to 800 and is capped at 4000, so in practice one or two
widths per recording ever exist; a miss at an unusual width costs one fresh
render, never a second copy of the decoded level.
Phase 4 may add a decoded-level cache underneath if measurements show
repeated renders of one level at many widths, but that is an optimization
to earn, not the baseline.
**Error that teaches:** a `group` that exists in the index but has no
`view/*` pyramid (a store converted before biosigio 1.2.6, or `n_view_levels:
0`) answers a tool error saying so explicitly, distinct from "recording not
found."

### 5.6 `read_window`

**Inputs:** `dataset_id`, `recording`, `group?`, `start_s` (default 0),
`duration_s` (default 10), `channels?` (an array of channel indices;
REQUIRED when `taste` is true), `taste` (default `false`).
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
channels; see decision 7 and the spike's decode-path verdict below).
A taste requires `channels`: the schema cannot know a recording's channel
count, and a MEG store already in the live catalog (on003392) has 320, so
treating an omitted list as "all channels" would pass a request five times
over the cap.
Past the cap, `read_window` never truncates silently: the input schema
rejects the request with a validation error that names the cap and tells
the caller to omit `taste` for a recipe, because a caller asking for a
window this large almost certainly wants the S3 path anyway.
The rejection is deliberate over a silent downgrade to recipe mode; a
caller who asked for numbers and got a recipe would have to notice the
`mode` discriminator changed, whereas an error is impossible to misread.
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
| `doi` | string \| null | the catalog row when one is supplied, its null included (D1 is the system of record; a DOI invalidated after the last conversion must not come back from the stale index); `index.doi` only when no row is |
| `license` | string \| null | same rule as `doi` |
| `citation` | string \| null | `index.citation` |
| `source_commit` | string (40-hex) | `index.source_commit` |
| `index_etag` | string \| null | the `index.json` HTTP response's ETag, when kept |
| `engine_version` | string | `index.engine_version` |
| `source_tree` | `"raw"` | `store.source_tree` (always `"raw"`, ADR 0027) |
| `derived` | boolean | `store.derived` |
| `sss` | object, optional | `store.sss`, present exactly when `derived` is true (ADR 0028); the schema refuses an envelope, and the index reader a store, where the two disagree |
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
| `dtype` | string \| null | Zarr's `data_type` from the array's `zarr.json` (`zarrArrayMetadataSchema`), renamed once here; null when that fetch was not made |
| `codecs` | array, optional | the same document's `codecs`; the key is absent when the fetch was not made |
| `chunk_samples`, `shard_samples`, `n_channels` | number \| null | straight from the index's group entry, no extra fetch |
| `sample_slice`, `channel_slice` | `{ start, end }`, optional | half-open, `end >= start` enforced; present when the caller named a window |
| `scale_offset` | string | `layout.scale_offset` verbatim: WHERE to find the conversion, not the values themselves |
| `how_to.python_zarr` | string | a ready-to-run Python snippet: `zarr.open(s3_uri, storage_options={"anon": True})`, slice, done |
| `how_to.zarrita` | string | the TypeScript/JS equivalent using `zarrita`: a `FetchStore` on `array_path`, `open.v3`, `get` with a `slice` |

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
  `overview/<recording>/<group>/<width_px>` (the rendered PNG, one entry
  per width actually requested, per section 5.5).
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
**Phase 2 decision: a dedicated Analytics Engine dataset**, `ANALYTICS_MCP`
(`nemar_mcp_metrics` prod, `nemar_mcp_metrics_dev` dev;
`backend/src/services/mcp-metrics.ts`, `buildMcpDataPoint`/
`recordMcpToolCall`), not the existing `ANALYTICS` binding under a new
`source` value -- so a future MCP dashboard query can never collide with
`buildAccessDataPoint`'s blob positions (`services/access-metrics.ts`,
`[dataset_id, source, detail]`), which mean something entirely different.
`indexes[0]`/`blobs[0]` is the tool name (not a dataset id, unlike
`buildAccessDataPoint`): a fixed, small vocabulary (`search_datasets`,
`describe_dataset`, ...) is the natural group/sample key for a per-tool
dashboard, and `search_datasets` names no single dataset anyway.
`blobs[1]` is the dataset id when the call named one, else `"-"`.
Optional (`ANALYTICS_MCP?:`), no-ops when absent, same convention as every
other Analytics Engine binding in this codebase.

Every phase 2 tool call is wrapped in `withToolMetrics`
(`backend/src/mcp/server.ts`): it times the callback with
`performance.now()` and records exactly one point per call, on the success
path AND the error path (a thrown exception, or a returned `isError: true`
result) alike -- the point is the measurement, not the success.
Both phase 2 tools report `cache_status: "none"` and `upstream_bytes: 0`:
neither touches the phase 3 `list_recordings`/`get_events` projection cache
(section 7) or a store byte; they read D1 only.
A p95 CPU budget per call as acceptance criteria is still open -- the smoke
run's per-call timings (section 10) are the first measurement toward that,
not the budget itself.

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

## 10. Spike results (phase 1) and the real bundle delta (phase 2)

Full detail of the phase 1 spike, including the exact failure message and
the byte-level derivation of `fixtures/chunk.bin`, lived in
`backend/spike/mcp-transport/README.md` -- deleted by phase 2 (decision 9);
`fixtures/chunk.bin`/`chunk.expected.json` moved to
`backend/test/fixtures/blosc/`, and the decode path itself was promoted to
`backend/src/services/blosc-decode.ts` (`decodeBloscZstdInt16`), dropping
path (a) (`numcodecs`) entirely.
Summary of the phase 1 findings:

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

### 10.2 Phase 2's real bundle delta

`bunx wrangler deploy -c wrangler-sccn.toml --env dev --dry-run`, measured
at three points:

| Measurement | Total Upload | gzip |
|---|---|---|
| Before this PR (dev's checked-out `dev` tip) | 1928.88 KiB | 399.98 KiB |
| After adding the dependencies alone (`@modelcontextprotocol/server`, `zod4`, `fzstd`; no code importing them yet) | 1928.88 KiB | 399.98 KiB (unchanged) |
| After the full phase 2 implementation | 2983.28 KiB | 606.34 KiB |
| **Delta (the real cost of this phase)** | **+1054.40 KiB** | **+206.36 KiB** |

The middle row is unchanged from the first: `wrangler deploy --dry-run`
bundles only what is reachable from `src/index.ts`, and nothing imports the
new dependencies until the route/tool/schema code lands, so adding an unused
dependency to `package.json` costs nothing until something imports it.
The real number is the last row's delta -- the SDK (`McpServer`,
`createMcpHandler`, the wire-protocol codec for both eras) plus the zod 4
registration mirrors (`backend/src/mcp/schemas.ts`) plus the two tools'
own logic and the services they pull in (`dataset-search.ts`,
`dataset-filters.ts`, `sweep-stamps.ts`).
`fzstd` (promoted for `decodeBloscZstdInt16`) contributes nothing to this
delta: no route or tool in phase 2 imports `blosc-decode.ts`, so it is
tree-shaken out of the reachable graph entirely -- it only becomes part of
the deployed bundle once phase 3/4 wires a tool that calls it.

**`bun` installed two copies of zod 4, not one.** Both
`backend/node_modules/zod4/package.json` and
`backend/node_modules/@modelcontextprotocol/server/node_modules/zod/package.json`
exist, byte-identical content (`4.5.4`) but distinct inodes -- **expected,
not a defect**: exactly the "two-copy risk" section 12 named ahead of
time. Harmless for correctness (the SDK's
`registerTool` only ever sees the mirrors built against `zod4`, and the
parity test -- `backend/test/mcp-schema-parity.test.ts` -- proves those
mirrors agree with the zod 3 wire contract on every case in its table), but
it is real, measurable bytes: not isolated here from the delta above, since
Bun's install layout makes the two indistinguishable in the bundle without a
dedicated dependency-graph diff, which was out of scope for this
measurement.

## 11. Client compatibility

| Client | Supports protocol revision 2026-07-28 |
|---|---|
| Claude Code | Yes (v2 runtime) |
| Claude Desktop | Stated supported by Anthropic; version unverified in this phase |
| Cursor | Unverified; likely not yet |
| Python `mcp` (PyPI) | Yes, from 2.2.0 |
| `langchain-mcp-adapters` | No -- pins `mcp<2.0.0`. OSA's own consumer (ADR 0049) must therefore speak `mcp` 2.x directly, not through `langchain-mcp-adapters`, to reach this server's 2026-07-28 features. A 2025-era fallback still works against `langchain-mcp-adapters`, since this server serves both eras from the same endpoint. |

## 12. Open items for phases 2 to 5

- **Phase 2 (#1294): DONE.** The host fork (`HostRoute "mcp"`,
  `MCP_HOSTNAME`, wrangler routes) and `search_datasets` / `describe_dataset`
  / `server/discover` wiring against a real D1 binding are all implemented
  and covered by `backend/test/mcp-*.test.ts` (real bun:sqlite D1, no
  mocks). The three synthetic-cache-URL projections (section 7) and their
  TTL remain open -- they belong to `list_recordings`/`get_events`/
  `render_overview` (phases 3-4), which this phase does not touch. The
  Analytics Engine point (section 8) landed as a dedicated `ANALYTICS_MCP`
  dataset; the p95 CPU budget itself is still open, pending real traffic
  once the host is live -- the smoke run's per-call timings are the
  starting measurement.
  **The workerd smoke now runs, via a throwaway entry, not `index.ts`.**
  `wrangler dev --local` cannot start the real `backend/src/index.ts` in
  this environment at all -- `Uncaught TypeError: Incorrect type for map
  entry 'NON_PROD_SANDBOX_CLEANUP_QUERY': the provided value is not of type
  'function or ExportedHandler'`, reproduced identically on wrangler 4.85.0
  (the repo's pin) and 4.130.0 (latest), both plain and via `cfman`, and on
  the UNMODIFIED epic-branch `index.ts` -- i.e. it predates this PR and is
  unrelated to the MCP work: `index.ts` has exported
  `NON_PROD_SANDBOX_CLEANUP_QUERY`/`PROD_SANDBOX_CLEANUP_QUERY` as plain
  string constants since the epic #923 cron-safety work, and this local
  workerd runtime rejects any named export on the entry module that is not
  a function or `ExportedHandler`. Filed as issue #1324; fixing
  `index.ts`'s export shape is out of this phase's scope.
  So the smoke script drives a MINIMAL throwaway entry instead --
  `backend/scripts/mcp-smoke-entry.ts` (`export default { fetch: (req, env,
  ctx) => mcpRoutes.fetch(req, env, ctx) }`) and
  `backend/scripts/mcp-smoke.wrangler.toml` (same `compatibility_date`/
  `compatibility_flags` as `wrangler-sccn.toml`, a local-only `DB`
  binding, `ENVIRONMENT=development`, nothing else) -- which starts
  cleanly under real workerd. Because the entry IS the mcp sub-app
  directly, every path the script drives, including `/`, reaches the real
  sub-app; there is no host fork in front of it to route around, so the
  loopback caveat a prior version of this note carried (the descriptor at
  `/` being unreachable from the api-host path mount) no longer applies to
  this script.
  Two of the checks (`describe_dataset`/`search_datasets` querying an id
  that does not exist) need the MIGRATED schema, not just a live D1
  binding: an unmigrated local D1 has no `datasets` table at all, and that
  surfaces as a `D1_ERROR` wrapped in `isError: true` whose text never
  mentions `search_datasets`, which is a different (and wrong) reason for
  those checks to fail. The script applies every migration first, via
  `wrangler d1 execute --local --file`, one file at a time with full-line
  `--` comments stripped -- the same technique
  `scripts/d1-migration-check.ts` already uses, and for the identical
  reason: `wrangler d1 migrations apply` scans the raw file text for the
  words "BEGIN TRANSACTION"/"COMMIT" and refuses "a file containing
  several transactions" even when those words appear only inside a
  comment (true for migration 0021 and others). No row data is inserted;
  every check still runs against an empty, merely-migrated catalog.
  `wrangler deploy --dry-run` (bundling only, no runtime start; unaffected
  by the `index.ts` blocker either way) was used for the bundle
  measurement above.

  **Result, two consecutive runs, `backend/scripts/mcp-smoke.sh`:**

  | Check | Verdict |
  |---|---|
  | compatibility_date 2024-12-01 starts the SDK under real workerd | **PASS -- unchanged, not bumped** |
  | `GET /` -- real mcp descriptor, endpoint built from the request origin | PASS |
  | `server/discover` -- 200, `supportedVersions: ["2026-07-28"]` | PASS |
  | `tools/list` -- 200, exactly `search_datasets`/`describe_dataset` | PASS |
  | `tools/list` -- 24h public cache hint (`ttlMs`/`cacheScope` on the result) | PASS |
  | `describe_dataset(xx000000)` -- tool error naming `search_datasets` | PASS |
  | `search_datasets()` -- 200, `count: 0` over the empty migrated catalog | PASS |
  | `describe_dataset(not-an-id)` -- `isError` naming `dataset_id` (no ajv code generation under workerd) | PASS |
  | legacy `initialize` handshake -- 200 | PASS |
  | legacy `tools/call` (no `_meta` envelope) -- 200 | PASS |
  | `Mcp-Name`/body mismatch -- HTTP 400 / `-32020` | PASS |
  | `GET`/`DELETE` `/mcp` -- 405 | PASS |
  | `OPTIONS /mcp` -- 204 with the `Mcp-*` headers allowed | PASS |
  | disallowed `Origin` on `POST /mcp` -- 403 / `-32000` | PASS |

  All 14 checks PASS on both runs. Per-call wall time (`curl`'s
  `%{time_total}`, local loopback, so a floor not a production estimate):
  `server/discover` ~7-8 ms, `tools/list` ~3 ms, `tools/call
  describe_dataset` ~2-7 ms, `tools/call search_datasets` ~4 ms -- all
  comfortably sub-10ms, and the first call of a run (which pays isolate/
  module warm-up) is not meaningfully slower than the rest here, unlike
  the phase 1 spike's cold-start note.
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
- **Tool registration under the two-copy zod split: DONE for `search_datasets`/
  `describe_dataset` (phase 2); `read_window`'s discriminated-union/
  `superRefine` shapes remain a phase 4 item.**
  `registerTool` in `@modelcontextprotocol/server@2.0.0` takes a Standard
  Schema that also emits JSON Schema (`~standard.jsonSchema`), which zod 4
  implements and zod 3 does not.
  So the zod 3 schemas in `shared/contract/mcp.ts` are the WIRE contract and
  the test oracle, not what is handed to `registerTool`.
  Phase 2 added the `zod4` npm alias to `backend/package.json`
  (`"zod4": "npm:zod@^4.2.0"`, which Bun resolved without touching the
  repo-wide `zod` pin -- confirmed: `bun run typecheck` and the pure test
  tier are unaffected), authored registration mirrors of both phase 2
  tools' input and output schemas (`backend/src/mcp/schemas.ts`), and added
  the drift test as **behavior parity, not JSON-Schema-generator
  comparison**: `backend/test/mcp-schema-parity.test.ts` runs one shared
  table of valid/invalid inputs (defaults, the cap, cap-plus-one, a
  malformed id, an unknown passthrough key) through both copies'
  `.safeParse` and asserts identical accept/reject verdicts and, on a shared
  success, identical parsed values -- comparing two DIFFERENT JSON Schema
  generators' output (`zod-to-json-schema` for zod 3, `z.toJSONSchema()` for
  zod 4) would drift on shape even when the accept/reject behavior agrees,
  which is what actually matters for a client. `read_window`'s
  `superRefine`/discriminated-union shapes (the channel-seconds check, the
  recipe/taste result union) are deferred to phase 4 along with the tool
  itself.
- **Whether `zarrita` is used as-is or replaced by hand-rolled chunk-key /
  shard-index logic** (as this phase's spike does for `decode_chunk`) is
  still open; either way, the codec underneath it is this phase's path (b),
  never `numcodecs`.
- **The browser-origin allowlist decision** (which origins beyond
  `nemar.org` get proxied `zarr.nemar.org` access for a browser-executed
  OSA widget, per ADR 0049) is explicitly out of scope for this phase and
  the epic's later phases.
