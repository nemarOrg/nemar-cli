# Zarr serving copy — operations runbook

NEMAR keeps a derived, **latest-only** Zarr v3 serving copy of every recording so
signals can be scrubbed in the browser (zarrita) and streamed for ML, from a
single conversion. BIDS stays the source of truth; the Zarr store is reproducible.
Epic: nemarOrg/nemar-cli#684.

This runbook covers the **serving** side owned by `nemar-cli` (backend trigger,
callback, D1 state, and the Cloudflare cache host + CORS). The conversion itself
runs in `nemarDatasets/.github` (`run-generate-zarr.yml`); the viewer lives in
`nemarOrg/website`.

## Data flow

```
PR merged to main (dataset repo)
  -> GitHub App push webhook -> POST /webhooks/github
       shouldDispatchZarr(): touched a data file or *_events.tsv ?
         -> triggerZarrGeneration() -> repository_dispatch[generate-zarr]
  -> nemarDatasets/.github run-generate-zarr.yml
       diff HEAD vs last-converted commit (from index.json); biosigIO convert
       aws s3 sync -> s3://nemar/<id>/zarr/<bids-path>.zarr/  (latest-only)
       rebuild s3://nemar/<id>/zarr/index.json
       POST /webhooks/zarr-ready  (X-Webhook-Token: NEMAR_WEBHOOK_TOKEN)
  -> backend: update datasets.zarr_* ; Cloudflare cache-purge index.json + changed zarr.json
Browser (nemarOrg/website) -> https://zarr.nemar.org/<id>/zarr/... (CDN, CORS)
```

## S3 layout

```
s3://nemar/<id>/zarr/
  index.json                              store manifest + incremental state
  sub-01/eeg/sub-01_task-rest_eeg.zarr/   one store per recording (zarr.json + chunks)
  ...
```

`<recording>.<ext>` → `<recording>.zarr` (strip the data extension, append
`.zarr`; the BIDS suffix `_eeg`/`_emg` is preserved). Latest-only: a store is
overwritten in place on change and deleted when its source file is removed.

## Access model — open data, gated browser path

**The S3 data stays open** (public-read; honoring NEMAR's open-data contract).
`curl`/server-side downloads of any `s3://nemar/<id>/zarr/...` object work for
anyone — that is intentional.

**The authoritative browser gateway is `https://zarr.nemar.org`** (Cloudflare in
front of the S3 origin). The browser viewing path is gated by **CORS at the
edge**, not by locking the data:

- Do **NOT** put a wildcard browser CORS on the S3 bucket. With no permissive S3
  CORS, a browser cannot read S3 zarr objects cross-origin directly — it must go
  through `zarr.nemar.org`.
- On `zarr.nemar.org`, set `Access-Control-Allow-Origin` to **NEMAR origins
  only**. A third-party site (e.g. OpenNeuro) therefore cannot stream our chunks
  cross-origin in a browser, while the open S3 data remains downloadable. This is
  what makes `zarr.nemar.org` the single authoritative HTTP gateway for viewing.

### Implementation: a Worker proxy (`zarr.nemar.org`)

`zarr.nemar.org` is bound as a Workers Custom Domain on the same nemar-api Worker
(`backend/wrangler-sccn.toml` routes, alongside api/data.nemar.org). The hostname
fork in `backend/src/index.ts` dispatches it to a self-contained sub-app,
`backend/src/routes/zarr-data.ts`, which:

- **Gates** to PUBLIC datasets (D1 `visibility='public'`); private data is never
  browser-streamable.
- **CORS restricted to NEMAR origins** (`*.nemar.org` + `localhost`): reflects an
  allowed `Origin`, omits `Access-Control-Allow-Origin` for anyone else (so
  OpenNeuro etc. can't cross-origin stream our chunks), exposes
  `ETag, Content-Length, Content-Range, Accept-Ranges`, allows `Range`, answers
  `OPTIONS` (204).
- **Proxies** the public S3 object (`https://<bucket>.s3.<region>.amazonaws.com/<id>/zarr/<path>`)
  server-side and **passes `Range` through** (206 for sharded level-0 reads).
- **Edge-caches** full-object GETs via the Workers Cache API (`caches.default`):
  `Cache-Control max-age=86400` on chunk objects (the bulk path; immutable per
  conversion), `max-age=60` on `index.json` / `zarr.json` (re-conversion surfaces
  within a minute). Range responses pass through uncached.

Dev/workers.dev reaches the same handlers at `<worker>/zarrproxy/<id>/zarr/<path>`
(the `zarr.nemar.org` custom domain only exists in the prod env).

The S3 origin objects are public-read (deny-list policy), so the Worker fetches
them without signing; the browser only ever talks to `zarr.nemar.org` and never
sees an S3 CORS header (there is none — that's the point).

> Staleness model: chunks sit on a stable key + long TTL (immutable per
> conversion). On the rare in-place re-conversion, `/webhooks/zarr-ready` purges
> `index.json` + each changed store's `zarr.json` **once `CLOUDFLARE_API_TOKEN` +
> `CLOUDFLARE_ZONE_ID` are set** (the zone purge API also clears the Worker
> Cache-API entries for the custom domain); until then it's TTL-only, which is
> fine (60 s metadata, 1 day chunks). A zero-stale upgrade (commit-hashed store
> prefix) is possible later without changing the viewer.

> Cost note: a Worker proxy bills one Worker request per chunk (cache hits still
> invoke the Worker). If viewing volume grows, switch to a non-Worker
> proxied-subdomain + Cache Rules + a CORS Transform Rule (zero Worker cost) —
> the viewer URL is unchanged. This needs a zone-scoped token / dashboard.

## Backend wiring (this repo)

- Trigger: `shouldDispatchZarr` + `triggerZarrGeneration`
  (`backend/src/routes/webhooks.ts`, `backend/src/services/github.ts`).
- Callback: `POST /webhooks/zarr-ready` (`X-Webhook-Token`), updates
  `datasets.zarr_*` and best-effort purges the cache
  (`backend/src/services/cloudflare.ts`).
- State: migration `0035_dataset_zarr_columns.sql` — `zarr_status`,
  `zarr_converted_at`, `zarr_store_count`, `zarr_index_etag`,
  `zarr_source_commit` on `datasets` (per-dataset; latest-only).

## Environment / secrets (SCCN, both prod + dev)

| Name | Where | Purpose |
|---|---|---|
| `ZARR_CACHE_BASE_URL` | wrangler var | `https://zarr.nemar.org` (viewer + purge target base) |
| `CLOUDFLARE_API_TOKEN` | Workers secret | scoped token, `Zone.Cache Purge` on the SCCN zone |
| `CLOUDFLARE_ZONE_ID` | wrangler var | SCCN zone id for `zarr.nemar.org` |
| `NEMAR_WEBHOOK_TOKEN` | Workers secret | shared bearer for `/webhooks/zarr-ready` (already set) |

Purge degrades gracefully: if `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ZONE_ID` are
unset, the callback still records state and caching falls back to TTL-only.

## Ops

```bash
# Manual / recovery (once the .github workflow + admin CLI land):
nemar admin zarr regenerate <id> [--full]   # dispatch a (full) reconversion
nemar admin zarr status <id>                # show zarr_status / store count / commit
nemar admin zarr backfill --all             # one-time sweep over public datasets

# Verify CORS + range against the cache host:
curl -sI -H 'Origin: https://ww2.nemar.org' -H 'Range: bytes=0-99' \
  https://zarr.nemar.org/nm099999/zarr/<path>.zarr/zarr.json
# expect: 206, Access-Control-Allow-Origin: https://ww2.nemar.org,
#         Access-Control-Expose-Headers includes ETag, Content-Range

# A foreign origin must NOT be allowed:
curl -sI -H 'Origin: https://openneuro.org' \
  https://zarr.nemar.org/nm099999/zarr/index.json
# expect: no Access-Control-Allow-Origin for that origin
```
