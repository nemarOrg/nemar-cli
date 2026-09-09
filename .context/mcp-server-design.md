# NEMAR MCP server: design, contracts, and the transport/decode spike

Status: phase 1 of epic #1065 (issue #1293).
Scope: design and contracts only.
No route exists yet; phases 2 to 4 (#1294 to #1296) build the host fork, the
discovery tools, the recording tools, and `read_window`.
Phase 5 (#1297) is docs, OSA wiring, and release.
(Phase 3, #1295, moved `render_overview` here from phase 4 -- this
section's original phase-4 placement was corrected to match the issues;
`read_window` alone remains phase 4's scope.)

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
all -- verified in phase 2 from two independent sources: `backend/test/mcp-route.test.ts`'s
"a legacy initialize handshake plus a legacy tools/call ... both work" test
drives the legacy path against `describe_dataset` (in-process, real
`@modelcontextprotocol/server`, real bun:sqlite D1), and
`backend/scripts/mcp-smoke.sh`'s "legacy tools/call (no `_meta` envelope at
all)" check drives the identical legacy path against `search_datasets`
under REAL workerd. Between the two, both phase 2 tools are proven to
answer a legacy `tools/call` built with no `_meta` envelope at all, on both
runtimes this server actually serves from.
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
`{ ttlMs: 86_400_000, cacheScope: 'public' }` (24 hours): the tool
registry is fixed at deploy time, so there is no reason for a client to
re-fetch it inside a day.
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

**Phase 2 implementation, three additive output fields (PR #1323 review):**
- **`note`** (`string | null`, optional): a caveat the caller should
  surface verbatim. Two producers, joined with a space when both fire on
  the same call: `executeDatasetSearch`'s own `warning` (a degraded
  `count`, e.g. the count query itself failed -- ADR 0005, partial data
  still serves), and a NEW phase 2 case -- a hit whose id has no row in
  the follow-up license/zarr lookup names the unresolved ids here (see
  below), rather than presenting `license: null, has_zarr: false` as a
  confirmed fact.
- **`truncated`** (`boolean`, optional): `executeDatasetSearch`'s own
  `truncated` passed through unchanged, on the `query` path only -- the
  no-`query` catalog-list path always answers its own exact `count`, so
  this is never set there.
- **The search index itself being unavailable is a tool error, not an
  empty page.** `executeDatasetSearch` DEGRADES (`method: "unavailable"`)
  rather than throwing when `datasets_fts` is missing; earlier phases of
  this design treated ADR 0005 ("partial data still serves") as license to
  pass that straight through as `count: 0`, but an infra failure silently
  read as "no matches" is exactly the kind of masking ADR 0005 does NOT
  endorse. `search_datasets` instead answers `isError: true` naming the
  fallback (browse without `query`, or retry) and logs one
  `console.error`.
- **A follow-up-lookup miss is reported, not silently guessed.** The
  `query` path's license/Zarr facts come from a SEPARATE query keyed by
  the search hits' ids (design doc's own cost-class note above); when
  that lookup has no row for a hit id (a stale Vectorize id, or a delete
  race), the hit still gets the schema-required `license: null,
  has_zarr: false`, but the ids are named in `note` and `console.warn`'d
  -- extracted as the pure `mergeHitsWithCatalog`
  (`backend/src/mcp/tools/search-datasets.ts`), unit-tested directly with
  a real, deliberately incomplete `Map`.

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
`source_tree`, `derived`, `groups[]` -- each with `name`, `modality`,
`rate`, `n_channels`, `duration_s`, `n_view_levels`, plus the internal
`n_samples`/`view_chunk_columns` `render_overview` needs), `n_events` per
store when the index has it, `total_count`, `excluded_derived_count`,
`source_commit` (nullable -- see below), plus `index_format_version`,
`discovered_count`/`failure_count`/`pending_count` (null for a legacy
index), `excluded_legacy_non_raw_count`, `note`, and an optional
dataset-level `envelope` built from the first recording on the page.
**Cost class:** one `index.json` parse per `(dataset_id, source_commit)`,
ever; every subsequent call for the same pair is a cache match plus a
slice -- proven in `mcp-recording-tools.test.ts` by asserting the fixture
upstream's request log gains no new `index.json` GET on a second call.
**`include_derived` defaults false.**
A caller has to opt in to seeing an ADR 0028 SSS-filtered MEG store; the
count excluded by that default is always reported
(`excluded_derived_count`), so the omission is visible rather than silent,
matching the day-one value issue #1065 named for this tool.
**Legacy (v1/v2) indexes are served honestly, not rejected.** About half
the catalog still publishes `format_version` 1 while the ADR 0033 engine
bump re-converts the back catalog. A legacy document has no
`source_tree`/`derived` at all; `list_recordings` infers `source_tree:
"raw"` and `derived: false` for every store EXCEPT one whose `path` falls
under `derivatives/`, `sourcedata/`, or `code/` (ADR 0027's raw-only rule,
which a legacy index predates) -- those are excluded outright and counted
in `excluded_legacy_non_raw_count`, and every legacy response carries a
`note`: "legacy index v1: re-conversion pending; source_tree, derived and
engine stamp are inferred." `source_commit` is `null` when the document's
own `source_commit` does not match the 40-hex pattern (a v1 document
predates the #1197 guarantee; on008083 once published `""`) -- a widening
of the phase 2 non-nullable shape, safe since no consumer existed yet.
**Cache behavior:** see section 7; the compact projection (not the raw
`index.json`) is what gets cached, keyed by `(dataset_id, source_commit)`,
7-day TTL (immutable per commit) -- and is bypassed entirely (never read,
never written) for a dataset whose D1 `zarr_source_commit` is missing or
not 40-hex, so a `list_recordings`/`get_events`/`render_overview` call for
such a dataset is always reported `cacheStatus: "miss"` rather than being
keyed on a guess. The SAME cached projection is shared by `get_events` and
`render_overview` (a `list_recordings` call primes the cache the other two
read, and vice versa) -- see `backend/src/mcp/tools/list-recordings.ts`'s
exported `loadRecordingsProjection`.
**Error that teaches:** a dataset with `zarr_status` not `ready` answers a
tool error naming the actual status (`pending` or `failed`) rather than an
empty recordings list, so a caller does not read "zero recordings" as "this
dataset has no data."

### 5.4 `get_events`

**Inputs:** `dataset_id`, `recording` (a store's `path` or `zarr`),
`group?`, `limit` (default 1000, capped at 5000), `offset` (default 0).
**Outputs:** `events[]` (`store_path`, `group_name`, `onset_s`,
`duration_s?`, `sample_index`, `trial_type?`, `value?`, `hed?`, plus any
`subject`/`session`/`task`/`run`/`x_`-prefixed extra passed through),
`source` (`"events_parquet"` or `"events_tsv_fallback"`), `estimated`
(boolean), `total_count`, `limit`, `offset`, `truncated`, `note`, and an
optional `envelope`.
**Cost class:** the WHOLE `events.parquet` file is read once per
`(dataset_id, source_commit)` on a miss (`hyparquet`'s `asyncBufferFromUrl`
+ `parquetMetadataAsync` + `parquetReadObjects`, no `columns` filter so
every pass-through BIDS entity column survives), grouped by `store_path`,
and every store's rows are written to the cache in one pass -- so ONE
dataset-wide read serves every recording's future `get_events` call, not
just the one this request named. **Codec: hand-rolled ZSTD-only, not
`hyparquet-compressors`** -- that package's `compressors` export eagerly
WASM-compiles its `SNAPPY` entry (the `hysnappy` dependency) at module
load, which crashes isolate startup under real workerd regardless of
whether any dataset's parquet ever uses SNAPPY (none in the live catalog
does; every column sampled is ZSTD). `get-events.ts` builds
`{ ZSTD: (input) => decompress(input) }` from `fzstd` directly instead --
functionally identical to what the package supplied for ZSTD. See section
9's `hyparquet-compressors` row and section 10.3.
**The fallback flips `estimated: true`.**
When the index names no `events_parquet` (every v1 index today), the tool
derives the sibling `events.tsv` from the recording's `path` (BIDS naming:
the trailing `_<suffix>.<ext>` becomes `_events.tsv`) and fetches it
credential-free from `raw.githubusercontent.com` -- the SAME URL builder
the zarr fidelity sweep uses (`rawContentUrl`,
`services/zarr-fidelity-sweep.ts`, exported for this reuse), `ref` the
resolved 40-hex `source_commit` when usable else `main` -- and computes a
sample index locally against the resolved group's serving rate; that
estimate is wrong by a sub-sample amount wherever source and target rates
are not integer multiples, which is common in this catalog, so the flag is
load-bearing, not decorative. A clean 404 (a missing file, or a private
repo, which reads identically to an anonymous GET) answers `events: []`
with a note that no events file was found next to the recording; BIDS
inheritance (walking up to a session/subject/root-level events.tsv) is
explicitly out of scope, and the note says so. Never `data.nemar.org`:
its file branch is a redirect with no injectable `fetch` seam.
The primary path never sets `estimated`, because the converter's own
`sample_index` (`floor(onset_s * rate + 0.5)`, computed against the SERVING
rate) is exact.
**Error that teaches:** a `recording` that does not match any store's
`path` or `zarr` in the cached recordings projection answers a tool error
listing up to 20 of the dataset's actual `zarr` identifiers, not a bare
"not found."

### 5.5 `render_overview`

(Landed in phase 3, #1295 -- moved here from phase 4 to match the issues;
this section's content is otherwise unchanged in intent.)

**Inputs:** `dataset_id`, `recording`, `group?`, `width_px`
(default 800, capped at 4000).
**Outputs:** an MCP `image` content block (`image/png`, base64) plus a
metadata object (`level`, `width_px`, `height_px`, `mime_type`,
`columns_read`, `chunks_read`, `bytes_read`, an optional `envelope`).
`columns_read`/`chunks_read`/`bytes_read` are all `0` on a cache hit --
nothing was actually read that call.
**Cost class:** reads the `view/*` min-max pyramid, never level 0 and never
`zarr.json` -- every geometry fact (`n_view_levels`, `n_samples`,
`n_channels`, `view_chunk_columns`) comes off the shared `recordings`
projection (section 5.3), never a probe fetch. Verified live on nm000329's
`eeg_250hz` group (138750 samples, 5 view levels): the column count at
level `L` is `Math.floor(n / 4)` applied ITERATIVELY from level 1 (never
`n0 / 4**L` in one step, which can disagree near a level boundary) --
`[34687, 8671, 2167, 541, 135]` for levels 1 through 5. A level's chunk
count is `Math.ceil(levelColumns / (group.view_chunk_columns ?? 1024))`;
nm000329's level 5 (135 columns) and level 4 (541 columns) both land under
the default 1024, so both are naturally one chunk each -- no special-casing
"is this the last level" is needed, the same `ceil` formula produces it.
**Picks the COARSEST view level satisfying `width_px`** (`pickViewLevel`,
`backend/src/mcp/overview.ts`) -- the highest `L` whose column count is
still `>= width_px`, never a level finer than what the requested pixel
width can show; when even level 1 (the finest that exists) has fewer
columns than `width_px`, level 1 is returned rather than erroring. Table
(nm000329, 5 levels): `width_px` 100 -> level 5, 800 -> level 3, 4000 ->
level 2, 40000 -> level 1.
**Image geometry:** one grayscale band per channel,
`rowPx = clamp(floor(1200 / n_channels), 2, 24)` (63 EEG channels -> 19px
rows, a 320-channel MEG store -> 3px rows), a 1px separator between bands,
each channel scaled to its OWN min/max over the level, a min-max bar drawn
dark on a light background per `width_px` column bucket. `fast-png`'s
`encode({ width, height, data, channels: 1, depth: 8 })`.
**Cache behavior:** the rendered PNG itself is what gets cached, per
`(dataset_id, source_commit, recording, group, width_px)`, so a repeat call
at the same width is a cache match with zero decode and zero encode work
(section 7's compute-minimization rule) -- `level`/`width_px`/`height_px`
are still recomputed on a hit (cheap, no I/O) so the metadata is always
present.
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

**Landed in phase 4, #1296.** Section 5.6 as originally written (phase 1)
capped a taste at `duration_s x channels.length <= 3840` alone, inferred
before the real on-disk geometry was checked. It was wrong on both axes it
was meant to bound (below); this section is the corrected, as-shipped
version.

**Inputs:** `dataset_id`, `recording`, `group?`, `start_s` (default 0),
`duration_s` (default 10), `channels?` (an array of channel indices;
REQUIRED when `taste` is true), `taste` (default `false`).
**Outputs (recipe mode, the default):** `{ mode: "recipe", recipe,
envelope }`, where `recipe` is `shared/contract/mcp.ts`'s
`readRecipeSchema` (section 6.2), `dtype: null`, `codecs` absent (no
array-metadata fetch was made).
**Outputs (taste mode, opt-in):** `{ mode: "taste", start_s, duration_s,
channels, sample_rate_hz, values, recipe, chunks_read, bytes_read, note,
envelope }` -- `values` (`[channel][sample]`) already scaled to physical
units and rounded to six significant digits (`note` says so); `recipe` is
FULLY populated (`dtype`/`codecs` present) since a taste already fetched
the array metadata a bare recipe would have needed a second call for.

**The real on-disk geometry (verified live, not inferred).** Level 0 of
every served store is a SHARDED Zarr v3 array: shape `[n_channels,
n_samples]`, outer chunk (shard) `[n_channels, shard_samples]`, inner chunk
(the `sharding_indexed` codec's own `chunk_shape`) `[n_channels,
chunk_samples]`, `index_location: "end"`. Confirmed on nm000329's
`eeg_250hz` (63 channels, shard 75000, chunk 1000) and on003392's
`meg_250hz` (320 channels, chunk 1000; shard 68000 on the `sub-06` store
measured here, 69000 on the `sub-01` store
`test/fixtures/zarr-index-on003392-meg-sss-slice.json` captures -- both real,
because `shard_samples` is a per-STORE property and this code reads it from
the specific store's own group entry rather than assuming one figure per
dataset or per group name) -- `test/fixtures/zarr-array-level0.zarr.json` is nm000329's real
level-0 `zarr.json`, attributes included. An inner chunk always spans EVERY
channel, so the chunk grid is always `1 x ceil(n_samples / shard_samples)`
and a shard's object key is always `<zarr>/<group>/0/c/0/<j>` -- a taste of
one channel still decodes every channel of every inner chunk the window
spans. **Cost is driven by duration (how many inner chunks) and the
store's own channel count, never by how many channels the caller asked
for.** The shard footer is the shard object's last `n_inner * 16 + 4`
bytes: `n_inner` little-endian uint64 `(offset, nbytes)` pairs (chaining
contiguously from 0 whenever nothing is absent) plus a crc32c word this
reader strips but never verifies. Verified against nm000329's real `c/0/0`
shard (`backend/test/fixtures/mcp/nm000329-shard-index-c-0-0.bin`, captured
`curl -A "nemar-cli/mcp-phase4" -H "Range: bytes=-1204"`): 75 entries, all
present, offsets chaining from 0, `sum(nbytes) + 1204 == 8_970_760`, the
shard's real `Content-Length`. An absent inner chunk is marked `2^64 - 1`
in both fields and reads as `fill_value` (0 digital) with NO byte fetch at
all.

**A shard's footer entry count is CONSTANT across every shard, including the
final one: it is `shard_samples / chunk_samples`, never a function of how
many samples fall inside that particular shard.** This is the one thing this
phase got wrong at first, and it is worth stating at length because the
failure was silent. `nInnerForShard` originally computed
`ceil(min(shard_samples, n_samples - shard_start) / chunk_samples)`, which
is smaller for a boundary shard. For nm000329's shard 1 that is 64 instead
of 75, so the reader Range-read the last `footerByteLength(64)` = 1028 bytes
instead of the real 1204. That slice begins 176 bytes -- exactly 11 entries
-- into the true footer, so every local index it parsed was the wrong entry,
shifted by 11 chunks: a request for sample 75,000 returned sample 86,000, 44
seconds of drift at 250 Hz. Nothing errored, because every misread entry
still pointed at a real, full-size, cleanly decoding chunk. It was caught by
capturing the real BOUNDARY shard's footer
(`backend/test/fixtures/mcp/nm000329-shard-index-c-0-1.bin`, `Content-Length`
7,651,790): 75 entries, local indices 0-63 present and chaining contiguously
with `sum(nbytes) == 7_650_586`, and 64-74 marked absent because they lie
wholly past the array's extent. Per the Zarr v3 sharding spec, a chunk past
the array's real data is an ABSENT ENTRY, not an omitted one.

**A present chunk that merely straddles `n_samples` is stored FULL SIZE and
fill-padded.** Zarr never emits a narrower chunk. Verified on that same
shard's final present entry (local index 63, offset 7,560,477, nbytes
90,109, nominally covering [138000, 139000) with only [138000, 138750)
real): those exact bytes decode to 63,000 values, 63 channels x 1000
columns, not 63 x 750. So a decoded chunk's STRIDE (always `chunk_samples`)
and its VALID SPAN (truncated at `n_samples`) are two different quantities.
`chunkSampleSpan` reports the valid span; `DecodedSegment.stride`
(`backend/src/mcp/taste.ts`) carries the stride separately, and indexing
with `end - start` instead would mis-stride every channel above the first.
The fill padding is real stored data but is NOT addressable through
`read_window`: a window past the array's extent is a bounds error, never
padding returned as if it were signal.

Both fixtures encode these rules now. The synthetic generator briefly wrote
a three-entry boundary footer -- matching the reader's bug rather than the
spec -- so generator and reader agreed and the whole suite was green while
production data was being misread; it now derives the entry count from the
chunk grid and pads the straddling chunk, and the committed real boundary
footer is what pins the rule against the actual producer.

**Three caps, not the phase-1 product alone.** The original
`duration_s x channels.length <= 3840` check does not bound either cost it
was meant to: `3840 s x 1 channel` satisfies it, but at 250 Hz that is
960,000 samples and roughly 614 MB decoded on a 320-channel store (duration
alone drives chunk count, and every chunk carries every channel); and
`3840` channel-SECONDS at 1000 Hz is 3,840,000 channel-SAMPLES in the
response, tens of megabytes of JSON. So:
  1. `READ_WINDOW_TASTE_MAX_DURATION_S` (60) and
     `READ_WINDOW_TASTE_MAX_CHANNELS` (64) are now HARD per-field caps,
     enforced inside the taste branch of `readWindowInputSchema`'s
     `superRefine` (never promoted to the fields' own `.max()`, which would
     also constrain the zero-cost recipe path).
  2. The original channel-seconds product check
     (`READ_WINDOW_TASTE_MAX_CHANNEL_SECONDS = 60 x 64 = 3840`) stays, per
     the lead's decision, though it is now mathematically dominated by the
     two hard caps above (their own product is exactly 3840, so no input
     satisfying both can ever exceed it) -- harmless, kept for the boundary
     case it was written for.
  3. **`READ_WINDOW_TASTE_MAX_CHANNEL_SAMPLES` (65,536) is the real
     response-size bound** (`channels.length x n_samples`, the WINDOW's
     sample count): 65,536 values round-tripped at six significant digits
     is under about 900 KB. It cannot be schema-enforced (the schema does
     not know a group's sampling rate, so it cannot turn `duration_s` into
     a sample count) and is checked in `read-window.ts` right after the
     group's rate is known, naming the rate, the computed product, the
     cap, and the two ways under it (fewer channels, a shorter window) or
     the recipe. At 250 Hz it buys 64 channels x 4 s or 8 channels x 32 s;
     at 1000 Hz (the modality-rate ceiling), 2 channels x 32 s.
A taste REQUIRES `channels`: the schema cannot know a recording's channel
count, and a MEG store already in the live catalog (on003392) has 320, so
treating an omitted list as "all channels" would pass a request five times
over the 64-channel cap. Past any of the three caps, `read_window` never
truncates silently -- an error names the cap and points at the recipe
(omit `taste`), deliberately over a silent downgrade to recipe mode: a
caller who asked for numbers and got a recipe would have to notice the
`mode` discriminator changed, whereas an error is impossible to misread.

**Taste reads inner chunks only, never a whole shard.** Per requested
window: resolve the recording/group exactly as the other recording tools
do (unknown recording lists identifiers; unknown group lists names); `+ 0.5`-floor
`start_s`/`duration_s` into `[startSample, endSample)` against the group's
own `rate` (the converter's own `sample_index_for` rounding -- ties round
UP, deliberately not `Math.round`'s banker's rounding); a window past the
group's `duration_s`, or a channel index at or past `n_channels`, is a tool
error naming the actual bound, never a truncated or zero-padded result.
Compute the spanned shard indices (`shardsForWindow`) and, per shard, the
spanned LOCAL inner-chunk indices (`innerIndicesForWindowInShard`); fetch
each shard's footer with a single suffix `Range: bytes=-<n_inner*16+4>`
request (cached, below), parse it, and **coalesce** the wanted local
indices into the fewest HTTP Range reads: a run of index-consecutive,
byte-adjacent PRESENT entries becomes one `Range: bytes=a-b` request
(`planShardReads`); an absent entry is always its own no-fetch read and
breaks any run around it. A 60 s window at 1000 Hz spans at most two
shards, so the worst case is a handful of subrequests, never one per inner
chunk. Each fetched range is decoded per inner chunk with the existing
`decodeBloscZstdInt16` (no new codec work); an absent chunk contributes
`fill_value` (0 digital, i.e. `offset[channel]` physical) for its span with
no fetch. `physical = digital * scale[channel] + offset[channel]`, both
per-channel arrays read once from the level-0 array's own `zarr.json`
attributes (`array-metadata.ts`) -- the SAME fetch that fills the embedded
recipe's `dtype`/`codecs` for free.

**A v1/v2 index is a typed refusal, not degraded service.** No legacy
document carries `layout`, `data_base`, or per-group `chunk_samples`/
`shard_samples`, so no recipe -- let alone a taste -- is computable at all;
`list_recordings`/`get_events` still work against that dataset's current
index, and the error says so. A v3 group missing `chunk_samples`/
`shard_samples` on its OWN entry answers the same typed-refusal shape when
`taste` is requested (never a silent downgrade): the error text says a
recipe is still computable for that group (with those two fields null) by
retrying without `taste`.

**Recipe mode makes no reads beyond `index.json`, and does not touch the
`recordings` projection cache the other three tools share.**
`buildReadRecipe` needs the FULL index document (`contract_base`,
`data_base`, `s3_uri`, `layout`, per-group `chunk_samples`/`shard_samples`),
none of which the compact `recordings` projection (section 7) carries, so
this tool calls `readZarrIndex` directly -- the same function
`loadRecordingsProjection` calls internally on ITS OWN cache miss --
relying on the zarr sub-app's own edge cache for `index.json` rather than
adding a fourth projection kind that would just duplicate it. `dtype` is
null and `codecs` absent (no array-metadata fetch); the envelope's `dtype`
is null too. The metrics point reports `cacheStatus: "none"` and
`upstreamBytes: 0` for recipe mode (the index read is accounted for by the
zarr sub-app's own layer, not this tool's projection-cache facts).

**Cache.** Two projection kinds (section 7), both consulted only by taste
mode, both immutable per `(dataset_id, source_commit)` and bypassed when
the commit is not 40-hex: `array/<zarr>/<group>/0` (the level-0 `zarr.json`
-- `data_type`, `codecs`, `scale[]`, `offset[]`) and
`shardidx/<zarr>/<group>/0/<j>` (one shard's parsed footer, as `[offset,
nbytes]` pairs, `[-1, -1]` for absent). Decoded WINDOWS are never cached --
a taste is an inline decode of a specific window on demand. The metrics
`cacheStatus` is `"hit"` only when every projection the call consulted
(the array metadata and every shard footer touched) was a hit;
`upstreamBytes` is the total upstream bytes fetched for the call: the
array-metadata `zarr.json` GET when it was not a cache hit (a plain full
GET, not a Range read) plus every shard-footer Range read plus every
inner-chunk Range read.

**The taste response is not duplicated into `content`.** Every other tool
puts `JSON.stringify(output)` in both `content` and `structuredContent`;
for a taste near the channel-samples cap that would put roughly 900 KB of
numbers in `content` twice. Taste mode's `content` is a compact one-line
summary instead (shape, rate, sample range, bytes/chunks read, the first
few values of the first channel); `structuredContent` still carries the
full object. Recipe mode keeps the both-places convention -- it stays
small.

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

**`read_window` (phase 4, section 5.6) is the one caller that sometimes
supplies `arrayMetadata`.** Recipe mode never does (zero reads beyond
`index.json`, so `dtype`/`codecs` stay null/absent); a TASTE already fetches
the level-0 array's `zarr.json` for its own reason (the `scale[]`/`offset[]`
physical-units conversion), so it passes that same document's `data_type`/
`codecs` into `buildReadRecipe` too -- `dtype`/`codecs` come along for free,
and a taste response's embedded recipe is always fully populated where a
bare recipe-mode response is not.

## 7. Compute-minimization rules and cache key scheme

The rule of never re-doing work an existing cache already paid for, made
concrete:

- **`index.json` is fetched through the existing zarr sub-app**
  (`createZarrDataRoutes(...).fetch(new Request(...))`), so the D1 public
  gate, `canonicalCacheUrl` edge cache, and the `ZARR_DATASET_DOCUMENTS`
  purge list apply unchanged.
  The MCP host does not re-implement any of that.
- **Derived projections use synthetic cache URLs on the mcp host:**
  `https://mcp.nemar.org/_cache/<dataset_id>/<source_commit>/<projection>`
  (`backend/src/mcp/projection-cache.ts`'s `projectionUrl`) -- a constant
  key NAMESPACE, never a real route this sub-app answers. **Fixed in phase
  3 (#1295) at a 7-day TTL** (`Cache-Control: public, max-age=604800`,
  `PROJECTION_CACHE_CONTROL`): immutable per `(dataset_id, source_commit)`,
  since a re-conversion mints a new commit and the old key never again
  resolves to different bytes -- unlike `zarr-data.ts`'s per-chunk
  `cacheControlFor`, there is no tokened/untokened split to make here.
  The concrete `<projection>` strings, one cache entry per commit unless
  noted:
    - `recordings` -- the FULL, unfiltered `list_recordings` array plus the
      index-level facts (`engine_version`/`doi`/`license`/`citation`/
      `isLegacy`, `events_parquet` URL, `data_base`) every recording-level
      tool needs; filters (`modality`, `min_duration_s`, `include_derived`)
      and pagination apply AFTER the cache read. Shared by all three
      recording tools -- a `list_recordings` call primes the entry
      `get_events`/`render_overview` read, and vice versa.
    - `events/<zarr>` -- one entry per STORE (keyed by the store's own
      `zarr` path, matching the parquet's own `store_path` column), written
      for every store in the dataset in one pass on the first `get_events`
      miss for that commit (reading `events.parquet` once serves every
      recording's future call). `events/_stores` is a companion entry: the
      store list with per-store row counts.
      **The per-store fan-out is bounded** by
      `MAX_STORE_FANOUT_ENTRIES` (2000, in
      `backend/src/mcp/tools/get-events.ts`): above it only the requested
      store's entry is written, and each other store's first call re-reads
      the parquet (the behavior that existed before the fan-out).
      Store counts in the catalog are not bounded by anything this code
      controls -- nm000281 publishes 25,253 stores and on005873 10,944
      (measured 2026-09-08 from `zarr.nemar.org/catalog.json`) -- so one
      `Response` plus one `JSON.stringify` per store inside a single
      request's `waitUntil` is an unbounded cost with no proportional
      cache benefit. The `_stores` summary is one entry either way and
      stays complete.
      The whole-file parquet read itself is bounded only by the published
      file (largest observed: nm000103 at 2.8 MB, 3,522 stores); its peak
      isolate memory is a separate, still-open measurement -- phase 4's
      `read_window` memory script (section 10.4) measures ONLY the
      `read_window` taste path (issue #1296's own definition of done), not
      `get_events`' parquet read, which this paragraph had anticipated
      lumping in. Correcting the forward reference here rather than leaving
      it stale.
    - `overview/<zarr>/<group>/<width_px>` -- the rendered PNG bytes,
      `Content-Type: image/png`, one entry per (recording, group, width)
      actually requested (per section 5.5, in practice one or two widths
      per recording).
    - **Phase 4 (#1296) adds two kinds, consulted only by `read_window`
      taste mode:** `array/<zarr>/<group>/0` -- the level-0 array's `zarr.json`
      (`data_type`, `codecs`, `scale[]`, `offset[]`) -- and
      `shardidx/<zarr>/<group>/0/<j>` -- one shard's parsed footer, stored
      compactly as `[offset, nbytes]` number pairs (`[-1, -1]` marking an
      absent inner chunk), never the raw ~1.2 KB footer bytes. Decoded
      WINDOWS are never cached -- a taste is an inline decode of a specific
      window on demand (section 5.6). Recipe mode touches neither kind
      (and does not touch `recordings` either -- it reads `index.json`
      directly via `readZarrIndex`, section 5.6).
  A dataset whose D1 `zarr_source_commit` is missing or not 40-hex bypasses
  this cache entirely for every projection kind (never read, never
  written) rather than being keyed on a guess -- every such call reports
  `cacheStatus: "miss"`.
  A `CacheLike.match`/`.put` that throws (synchronously or as a rejected
  promise) is logged once and treated as a miss/no-op, mirroring
  `zarr-data.ts`'s `safeCachePut` discipline exactly.
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
blobs:   [tool_name, dataset_id ?? "-", cache_status, outcome]
         // cache_status: "hit" | "miss" | "none"
         // outcome (PR #1323 review, phase 2 implementation): "ok" | "tool_error" | "exception"
doubles: [elapsed_ms, upstream_bytes]
```

`cache_status` is `"none"` for a tool call that never consults the
projection cache at all (`search_datasets`, a `read_window` taste), so the
dashboard can tell "cache was irrelevant here" apart from "cache was
consulted and missed."
**`outcome` (phase 2 implementation, the 4th blob) distinguishes how the
call actually finished:** `"ok"` for a normal (non-error) result,
`"tool_error"` for a normal `CallToolResult` with `isError: true` (a
business-logic error the tool handled itself -- an unknown dataset id, a
malformed-but-schema-valid state), `"exception"` for a thrown error
`withToolMetrics` itself caught (a D1 query failure, say) -- the metrics
point is written for that case too, then the error is rethrown unchanged
so the transport's own error handling is unaffected. This lets a future
dashboard tell "the tool ran and reported a business-logic problem" apart
from "the tool never got to run its own logic at all," which a bare
success/failure count cannot.
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
`withToolMetrics(env, name, getDatasetId, fn)` reads the dataset id by
calling `getDatasetId(args)` BEFORE `fn` runs, not from `fn`'s return
value: a thrown D1 error is therefore still attributed to the right
dataset, since the id was already captured before the tool had a chance
to fail. Both phase 2 tools report `cache_status: "none"` and
`upstream_bytes: 0`: neither touches the phase 3
`list_recordings`/`get_events` projection cache (section 7) or a store
byte; they read D1 only.
A p95 CPU budget per call as acceptance criteria is still open -- the smoke
run's per-call timings (section 10) are the first measurement toward that,
not the budget itself.

## 9. Dependency table

| Package | Version pinned | Role | Spike verdict |
|---|---|---|---|
| `@modelcontextprotocol/server` | `2.0.0` (exact) | MCP server SDK, `createMcpHandler`, `McpServer` | **Works under workerd.** Both protocol eras served correctly; see section 10. |
| `@modelcontextprotocol/hono` | `2.0.0` (exact) | Hono adapter, `createMcpHonoApp` | **Works.** Peers `hono ^4.11.4`, `@modelcontextprotocol/server ^2.0.0`. |
| `zod` | `^3.23.x` (repo bump reverted, see section 10.1) | SDK peer dependency; also this phase's own contract schemas | **Repo bump reverted.** `bun run typecheck` went green after two mechanical fixes (`z.record(valueSchema)` &rarr; `z.record(z.string(), valueSchema)` in three call sites), but `bun test` surfaced a real zod-4/`@asteasolutions/zod-to-openapi` incompatibility that a mechanical fix cannot close without adding new test-preload infrastructure the repo does not have today. Reverted to the pre-bump pin per section 10.1's fallback path. This phase's own contract files (`shared/contract/zarr-index.ts`, `shared/contract/mcp.ts`) use only zod APIs unchanged between 3 and 4, so the revert cost them one type-name edit (`z.SafeParseReturnType` instead of zod 4's `z.ZodSafeParseResult`). |
| `hono` | `^4.11.4` | Hono itself; backend previously pinned `^4.6.0` | **Bumped and kept**: unlike the `zod` bump, this half of the upgrade has no test-harness conflict, so it stands unconditionally. `bun run typecheck` and the backend suite are green at this version regardless of the zod outcome. |
| `numcodecs` | `0.3.2` | JS Blosc/Zstd/GZip/LZ4/Zlib codecs, WASM-backed | **Does not run under workerd.** `numcodecs/blosc` loads its WASM module via a runtime `fetch()` + `WebAssembly.instantiate()` on the fetched bytes -- dynamic code generation, which workerd's embedder disallows by default. The npm package ships no `.wasm` file to statically import as a workaround either. Not a dependency of the real server; kept only as the spike's path (a) for the record. |
| `fzstd` | `0.1.1` | Pure-JS zstd decompressor, no WASM | **Works under workerd**, and is the chosen decode primitive (section 10's spike verdict). **Phase 3: also the codec `get_events` uses directly for `events.parquet`** (see the `hyparquet-compressors` row below) -- one decoder serves `render_overview`'s pyramid chunks AND `get_events`'s parquet rows. |
| `hyparquet` | `1.30.0` | Parquet reader (`asyncBufferFromUrl`, `parquetReadObjects`) | **Phase 3: works under workerd on its own.** Confirmed via `bunx wrangler dev --local` against the throwaway smoke entry (bundled and started cleanly with `hyparquet` in the graph). `hyparquet`'s own built-in SNAPPY path (`src/snappy.js`) is a pure-JS port (`snappyjs`), not WASM -- the incompatibility is entirely in the `hyparquet-compressors` package, next row. |
| `hyparquet-compressors` | matching `hyparquet` | zstd codec for `hyparquet` | **REMOVED from `package.json` (phase 3). Does not run under workerd.** Its `compressors` export EAGERLY constructs `SNAPPY: snappyUncompressor()` (the `hysnappy` dependency) at MODULE LOAD, which synchronously compiles a WASM module -- `WebAssembly.Module(): Wasm code generation disallowed by embedder`, reproduced under real workerd (`bunx wrangler dev --local` against `mcp-smoke-entry.ts`; the exact failure class this table's `numcodecs` row already documents for `blosc-decode.ts`). This crashes isolate startup for EVERY request, not only a `get_events` call, regardless of whether any dataset's parquet actually uses SNAPPY (none in the live catalog does -- every column sampled, nm000329 included, is ZSTD). The package's own `ZSTD` entry was exactly `fzstd`'s `decompress`, already a pinned dependency, so `backend/src/mcp/tools/get-events.ts` now builds a one-entry `{ ZSTD: (input) => decompress(input) }` compressors map itself instead of importing the package -- functionally identical for every dataset that exists, none of `hysnappy`'s baggage. A dataset whose parquet ever used a non-ZSTD codec would throw here (hyparquet's own missing-compressor error) rather than silently mis-decode. |
| `fast-png` | `8.0.0` | PNG encoding for `render_overview`, pure JS via `fflate` | **Phase 3: works under workerd**, confirmed by the smoke script's `tools/list` registering `render_overview` and by `mcp-overview.test.ts`'s route-level PNG round-trip (encode here, decode back with the same package in the test). No WASM dependency, consistent with the decode-path finding. |
| `zarrita` | `0.7.5` | Zarr store/array abstraction, FetchStore, sharding | **Not directly exercised by this spike.** The spike tested the codec layer (blosc/zstd decode) in isolation, which is the part the spike needed evidence on (section 10); zarrita's own store/array logic has no WASM dependency of its own (only the codec it would otherwise delegate to, which this phase replaces with the pure-JS path). Whether to use zarrita for chunk-key/shard-index bookkeeping or hand-roll it (as the spike does, see `README.md`'s shard-index derivation) is a phase 2 decision. |

## 10. Spike results (phase 1) and the real bundle delta (phase 2)

Full detail of the phase 1 spike, including the exact failure message and
the byte-level derivation of `fixtures/chunk.bin`, lived in
`backend/spike/mcp-transport/README.md` -- deleted by phase 2 once its decode
path was promoted and its transport wiring superseded by the real host fork;
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
| **Chosen decode path** | **(b), pure JS.** The stated preference for a pure-JS codec (section 9's `fzstd` row; `fzstd` also serves `events.parquet` in phase 3) is confirmed, and path (a) is now disqualified on evidence, not preference: it does not run on the target platform at all. |

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
redesign around a plan conflict), so the bump was reverted to its own
documented fallback: **the repo's `zod` pin stays `^3.23.x`; this phase's
contracts stay on zod 3; the MCP SDK's own nested zod 4 copy (inside
`node_modules/@modelcontextprotocol/*`) is what the SDK itself uses, and the
spike's isolated `package.json` is what proves the SDK's tool-registration
API against that copy** -- the two-copy arrangement this section documents.
`hono` stays bumped to `^4.11.4`, unconditionally, since that half of the
bump has no such conflict and both `bun test` and `bun run typecheck`
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

### 10.3 Phase 3's real bundle delta

Same measurement (`bunx wrangler deploy -c wrangler-sccn.toml --dry-run`),
before phase 3's code and dependencies landed versus after:

| Measurement | Total Upload | gzip |
|---|---|---|
| Before this PR (epic branch tip, phase 2 already merged) | 2986.72 KiB | 607.29 KiB |
| After the full phase 3 implementation | 3235.64 KiB | 662.82 KiB |
| **Delta (the real cost of this phase)** | **+248.92 KiB** | **+55.53 KiB** |

(The "before" row here is a few epic-branch commits ahead of section 10.2's
own "after" row for phase 2 -- 2983.28 KiB there versus 2986.72 KiB here --
from unrelated `dev` syncs merged into the epic branch between the two
measurements, not from anything in this phase.)

The delta is `hyparquet` (parquet metadata/row-group decode), `fast-png`
(PNG encode), the three new tools and their supporting modules
(`index-reader.ts`, `catalog-row.ts`, `projection-cache.ts`, `envelope.ts`,
`overview.ts`), and the zod 4 registration mirrors for all three.
`hyparquet-compressors` contributes NOTHING to this bundle -- it was removed
from `package.json` entirely (section 9's `hyparquet-compressors` row) once
`bunx wrangler dev --local` against the throwaway smoke entry proved it
crashes isolate startup under real workerd (`hysnappy`'s eager WASM
compile). `compatibility_date` is unchanged (`2024-12-01`); the smoke
script's compatibility-date check still passes, twice consecutively, after
the fix.

### 10.4 Phase 4's real bundle delta and taste-mode memory measurement

Same measurement (`bunx wrangler deploy -c wrangler-sccn.toml --dry-run`,
`wrangler 4.85.0` both times), before phase 4's code landed versus after:

| Measurement | Total Upload | gzip |
|---|---|---|
| Before this PR (epic branch tip, phase 3 already merged) | 3243.99 KiB | 664.88 KiB |
| After the full phase 4 implementation | 3285.36 KiB | 673.76 KiB |
| **Delta (the real cost of this phase)** | **+41.37 KiB** | **+8.88 KiB** |

(The "before" row here is a few epic-branch commits ahead of section 10.3's
own "after" row for phase 3 -- 3235.64 KiB there versus 3243.99 KiB here --
the same "unrelated `dev` syncs merged into the epic branch between the two
measurements" pattern section 10.3 already notes for its own before/after
pair, not anything in this phase.)

**Phase 4 adds NO new dependencies** (`package.json` is untouched by this
phase): the delta above is entirely new first-party TypeScript --
`sharding.ts`, `array-metadata.ts`, `taste.ts`,
`tools/read-window.ts`, the `read_window` zod 4 registration mirror in
`schemas.ts`, and the contract additions in `shared/contract/mcp.ts`. An
order of magnitude smaller than phase 3's `+248.92 KiB` (which added three
whole dependencies -- `hyparquet`, `fast-png`, and the codec work) is exactly
what "no new dependencies, mostly pure planning/decode logic reusing the
existing blosc decoder" predicts.

**Taste-mode memory measurement**, per issue #1296's definition of done:
`backend/scripts/read-window-memory.ts` (committed) drives the REAL
`readWindowTool` -- not a route-level HTTP call, but the same function
`server.ts` registers -- against the two LIVE datasets this phase's geometry
facts were verified against, with a local bun:sqlite D1 standing in for
Cloudflare D1 (the only non-production piece; every `index.json`/`zarr.json`/
shard fetch is a real network call to `zarr.nemar.org` /
`nemar.s3.us-east-2.amazonaws.com`, named User-Agent per this repo's
api/zarr-host convention). Each case sits just under
`READ_WINDOW_TASTE_MAX_CHANNEL_SAMPLES` (65,536) without landing exactly on
it, to avoid a float-rounding rejection at the boundary:

| Case | Requested | Window | Channel-samples | `chunks_read` | `bytes_read` (upstream) | Bun `heapUsed` delta | Analytic bound |
|---|---|---|---|---|---|---|---|
| nm000329 `sub-1` (63 ch store) | 63 channels x 4.12 s | 1030 samples | 64,890 | 2 | 245,312 B | 1,781,470 B (~1.70 MiB) | 645,120 B (~630 KiB) |
| on003392 `sub-06` (320 ch store, taste capped at 64) | 64 of 320 channels x 4.08 s | 1020 samples | 65,280 | 2 | 1,215,811 B | 5,816,249 B (~5.55 MiB) | 1,162,240 B (~1.11 MiB) |
| nm000329 `sub-1` at the BOUNDARY shard (start 300 s = sample 75,000) | 1 channel x 4 s | 1000 samples | 1,000 | 1 | 126,776 B | 506,501 B (~495 KiB) | 134,000 B (~131 KiB) |

The third case is not about memory. It exists because the first two both start
at sample 0 and so never touch the truncated last shard, which is precisely
where the footer-entry-count defect lived: a request for sample 75,000
returned sample 86,000, 44 seconds later, and both readings decoded cleanly
into plausible EEG. Measured directly against the live bytes, channel 0 at
sample 75,000 begins `[12889, 14040, 13530, 12743, ...]` under the constant
entry count, and `[-2135, -2040, -2880, -3742, ...]` under the old per-shard
one -- the latter being local chunk 11 of that shard. Keeping the case in the
script means the fixed path is re-exercised against production on every run
rather than in a one-off check.

The `heapUsed` deltas are noisy run to run (the nm000329 case measured
3,295,454 B on an earlier run of the same code and window), so read them as an
order of magnitude, not a figure to regress against; `bytes_read` and
`chunks_read` are the stable, production-observable numbers.

Both cases span exactly 2 inner chunks (a `~4 s` window at 250 Hz, `chunk_samples`
1000, crosses one chunk boundary), confirming the "at most a handful of
subrequests, never one per inner chunk" claim in section 5.6 at these sizes.
`bytes_read` (the tool's own reported figure, observable in production via
the Analytics Engine point, section 8) is total upstream bytes fetched,
which is the array-metadata GET plus the footer and chunk Range reads --
larger for on003392 because its inner chunks are 320-channel-wide, over 5x
nm000329's 63.

**Honesty note (read before trusting the `heapUsed` column):**
`process.memoryUsage().heapUsed` is a Bun (V8) heap measurement standing in
for a real Cloudflare Workers `workerd` isolate -- Bun's GC pacing, object
layout, and heap growth policy are not workerd's, and this single Bun
process never pays a fresh isolate's own baseline either. The `heapUsed`
delta is roughly 5x the analytic bound in both cases here, consistent with
that gap being real V8/Bun overhead (module graph, JSON parsing of a
larger-than-strictly-needed `index.json`, HTTP client bookkeeping) rather
than anything read_window itself retains. **The number to actually trust
for isolate sizing is the analytic bound**:
`n_channels_in_store x chunk_samples x 2` bytes for ONE decoded inner
chunk held at a time (the code never holds a second one until the first has
been copied out and released -- `read-window.ts`'s fetch-decode-copy loop,
`taste.ts`'s `assembleTasteValues`) plus
`channels.length x window_samples x 8` bytes for the output `number[][]`
(a plain JS array of doubles) -- both printed by the script alongside the
measured figures above, and reproducible with `bun run backend/scripts/read-window-memory.ts`.

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
- **Phase 3 (#1295): DONE.** `list_recordings`, `get_events`, and
  `render_overview` (moved here from phase 4, section 5.5) all landed, each
  with real-route tests (real D1, a real `Bun.serve()` fixture upstream, a
  real in-memory projection cache -- `backend/test/mcp-recording-tools.test.ts`,
  `backend/test/mcp-overview.test.ts`, `backend/test/mcp-index-reader.test.ts`,
  `backend/test/mcp-projection-cache.test.ts`). `list_recordings`/`get_events`
  serve a legacy (v1/v2) index honestly -- an inferred `source_tree`/
  `derived`, a `note`, `excluded_legacy_non_raw_count` -- rather than
  failing on the roughly half of the catalog still pre-ADR-0033-bump (as of
  2026-09-08; see `index-reader.ts`'s module doc for the same figure at the
  code level).
  `get_events` reads `events.parquet` with `hyparquet`, falls back to a
  sibling `events.tsv` (flagged `estimated: true`) for a v1 index, and
  computes `sample_index` locally on that path with the exact
  `Math.floor(onset_s * rate + 0.5)` rule the converter itself uses.
  `render_overview` reads only the `view/*` pyramid (never level 0, never
  `zarr.json`) and encodes a grayscale envelope PNG with `fast-png`.
  **`hyparquet-compressors` was dropped** (section 9's row, section 10.3):
  it crashes isolate startup under real workerd (`hysnappy`'s eager WASM
  compile), discovered by the smoke script, not by `bun test` -- `bun test`
  alone would have stayed green. `get_events` now builds its own
  ZSTD-only `compressors` map from `fzstd` instead. All five tools verified
  together under real workerd via `backend/scripts/mcp-smoke.sh`, two
  consecutive runs, `compatibility_date` unchanged.

  **Result, two consecutive runs (same script, same throwaway entry as
  phase 2's table above):**

  | Check | Verdict |
  |---|---|
  | compatibility_date 2024-12-01 starts the SDK under real workerd | **PASS -- unchanged, not bumped** |
  | `GET /` -- real mcp descriptor, endpoint built from the request origin | PASS |
  | `server/discover` -- 200, `supportedVersions: ["2026-07-28"]` | PASS |
  | `tools/list` -- 200, all five tools (`search_datasets`, `describe_dataset`, `list_recordings`, `get_events`, `render_overview`) | PASS |
  | `tools/list` -- 24h public cache hint (`ttlMs`/`cacheScope` on the result) | PASS |
  | `describe_dataset(xx000000)` -- tool error naming `search_datasets` | PASS |
  | `search_datasets()` -- 200, `count: 0` over the empty migrated catalog | PASS |
  | `list_recordings(xx000000)` -- tool error, not found in the public catalog | PASS |
  | `describe_dataset(not-an-id)` -- `isError` naming `dataset_id` (no ajv code generation under workerd) | PASS |
  | legacy `initialize` handshake -- 200 | PASS |
  | legacy `tools/call` (no `_meta` envelope) -- 200 | PASS |
  | `Mcp-Name`/body mismatch -- HTTP 400 / `-32020` | PASS |
  | `GET`/`DELETE` `/mcp` -- 405 | PASS |
  | `OPTIONS /mcp` -- 204 with the `Mcp-*` headers allowed | PASS |
  | disallowed `Origin` on `POST /mcp` -- 403 / `-32000` | PASS |

  All 15 checks PASS on both runs. Per-call wall time (`curl`'s
  `%{time_total}`, local loopback, so a floor not a production estimate):
  `server/discover` ~9-10 ms, `tools/list` ~5-6 ms, `tools/call
  describe_dataset` ~3-8 ms, `tools/call search_datasets`/
  `list_recordings` ~4-6 ms -- comfortably sub-10ms, consistent with phase
  2's numbers.
  `get_events` and `render_overview` are exercised indirectly here
  (through `tools/list`'s five-tool listing and, for `render_overview`,
  the bundle-size measurement in section 10.2); their own real-route
  behavior is covered by `backend/test/mcp-recording-tools.test.ts` and
  `backend/test/mcp-overview.test.ts` instead of a dedicated smoke check,
  the same division phase 2 drew between `search_datasets`/
  `describe_dataset`'s smoke coverage and their broader route-test suites.
- **Phase 4 (#1296): DONE.** `read_window` landed in both modes: recipe
  (the default, zero signal bytes touched, reading `index.json` directly
  rather than through the `recordings` projection cache the other three
  tools share) and taste (a capped inline decode reading real sharded
  Zarr v3 geometry -- see section 5.6's rewrite for the corrected caps and
  the shard/footer/coalescing mechanics, `backend/src/mcp/sharding.ts`,
  `array-metadata.ts`, `taste.ts`). `render_overview` was never this
  phase's scope (moved to phase 3, see section 5.5's header note; landed
  there instead). Six tools now registered
  (`backend/test/mcp-route.test.ts`'s `tools/list` assertion, the smoke
  script). Real-route tests: `backend/test/mcp-read-window.test.ts` (real
  D1, a real `Bun.serve()` fixture upstream serving a synthetic sharded
  store -- `nm099500`, generated by `scripts/zarr/generate_mcp_test_fixture.py`'s
  `build_sharded_level0_fixture`, 4 channels, a deliberately absent
  mid-array inner chunk, a straddling boundary chunk stored full size with
  fill padding, and a trailing entry marked absent as wholly past
  `n_samples`; expected values emitted alongside as
  `nm099500-expected.json` so the tests read ground truth from data rather
  than re-implementing the generator's formula -- plus BOTH REAL nm000329
  shard footers, `c/0/0` and the boundary `c/0/1`, captured live);
  `backend/test/mcp-sharding.test.ts` (pure footer/planning tests against
  both: 75 entries each, `sum(nbytes) + 1204 == 8_970_760` for `c/0/0`, and
  75 entries with 64 present and 11 absent, `sum(nbytes) + 1204 ==
  7_651_790`, for the boundary shard that pins the constant entry count). Bundle delta +41.37 KiB /
  +8.88 KiB gzip, no new dependencies; taste-mode memory measured against
  live nm000329 and on003392 -- see section 10.4 for both, including the
  Bun-heap-vs-analytic-bound honesty note.
  **One interpretation call worth flagging:** the approved plan's text for
  a v3 group missing `chunk_samples`/`shard_samples` when `taste` is
  requested reads "a recipe is still computable there... and is returned".
  Taken fully literally that could mean silently downgrading to a recipe
  result rather than erroring; implemented instead as a typed tool error
  (matching the "same shape" -- i.e. same KIND of response, a refusal -- as
  the v1 case immediately before it, and consistent with this same section's
  explicit "no silent mode-discriminator downgrade" reasoning for the
  taste-cap rejection). The error text names the fact that a recipe IS
  computable by retrying without `taste`.
- **Phase 5 (#1297):** docs site coverage, the OSA tool-registration wiring
  ADR 0049 anticipates, and the release.
- **ADR 0050:** `origin/dev` did not yet carry ADR 0049 when this PR was
  opened (PR #1292 was still open), and the ADR index test enforces
  gapless numbering, so this PR omits the ADR file and the README index
  entry -- filing 0050 now would either collide with 0049's number or
  leave a gap the index test rejects. It should be filed once ADR 0049 has
  landed on `dev` and its final number is confirmed unclaimed (expected in
  phase 5). Its content, staged here in the meantime:

  **The rule ADR 0050 will formalize: no WASM in the Worker bundle,
  ever, for a package this server depends on.** Two independent
  dependencies hit the identical failure, caught only under real
  workerd, never under `bun test`:
  - **Phase 1:** `numcodecs`'s Blosc codec loads its WASM module via a
    runtime `fetch()` + `WebAssembly.instantiate()` on the fetched bytes
    (dynamic code generation) -- `RuntimeError: Aborted(CompileError:
    WebAssembly.instantiate(): Wasm code generation disallowed by
    embedder)`. See section 10's decode-path table.
  - **Phase 3:** `hyparquet-compressors`'s `compressors` export eagerly
    constructs `hysnappy`'s `snappyUncompressor()` at MODULE LOAD, which
    synchronously compiles a WASM module -- `WebAssembly.Module(): Wasm
    code generation disallowed by embedder`, crashing isolate startup for
    EVERY request regardless of whether any call actually needed SNAPPY.
    See section 9's `hyparquet-compressors` row and section 10.3.
  Both were only caught by `bunx wrangler dev --local` against a real
  workerd instance (the throwaway smoke entry this section's tables
  measure); `bun test` alone stayed green in both cases, because bun's own
  JS runtime has no equivalent restriction on WASM code generation. The
  fix pattern in both cases was the same: replace the WASM-eager package
  with a hand-rolled subset built on an already-proven pure-JS codec
  (`fzstd`), never a mock or a stub -- the resulting code still really
  decodes the real byte format, just without the disallowed compile step.
  **The actionable rule for phase 4 and beyond:** before adding any new
  dependency that touches binary decode/encode (codecs, compression,
  image or audio formats), check whether it ships a WASM artifact and, if
  so, whether it is loaded eagerly (module load / import time) or lazily
  behind a call a request path can avoid -- eager WASM loading is
  disqualifying under workerd's embedder restriction regardless of
  whether the WASM would otherwise work, and `bun test` will not catch
  it; only a real `wrangler dev --local` (or deployed) run will.
- **Tool registration under the two-copy zod split: DONE, all six tools,
  including `read_window`'s discriminated-union/`superRefine` shapes
  (phase 4).**
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
  which is what actually matters for a client. Phase 4 extended the table
  with `read_window`'s own cases: defaults, taste without `channels`, each
  hard cap (`duration_s` 60/61, `channels.length` 64/65) and the
  channel-seconds product cap, unknown keys, a malformed id, and a negative
  `start_s` -- `readWindowInputSchema4`/`readWindowOutputSchema4` in
  `backend/src/mcp/schemas.ts`, including its own `superRefine` mirroring
  the three taste-mode checks and a `discriminatedUnion` for the
  recipe/taste result shapes.
- **CLOSED (phase 3): `zarrita` is never used in the Worker.**
  `render_overview`'s chunk keys (`view/<L>/c/0/0/<k>`) and its chunk plan
  (`Math.ceil(levelColumns / (view_chunk_columns ?? 1024))`) are hand-rolled
  in `backend/src/mcp/overview.ts` -- no store/array abstraction needed for
  a fixed, non-sharded, always-regular-chunked object shape. `zarrita`
  remains the recommendation the read recipe's `how_to.zarrita` snippet
  hands to a CLIENT (section 6.2); the Worker itself never imports it. The
  codec underneath every in-Worker decode is this phase's path (b) -- pure
  JS, no WASM -- for both the blosc/zstd pyramid chunks (`fzstd` via
  `decodeBloscZstdInt16`) and the parquet zstd codec (`fzstd` directly,
  section 9's `hyparquet-compressors` row), never `numcodecs`.
- **The browser-origin allowlist decision** (which origins beyond
  `nemar.org` get proxied `zarr.nemar.org` access for a browser-executed
  OSA widget, per ADR 0049) is explicitly out of scope for this phase and
  the epic's later phases.
