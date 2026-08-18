#!/usr/bin/env bash
# File the NEMAR / EEGDash Zarr streaming issues.
#
#   Requires: gh (GitHub CLI), authenticated with write access to
#             nemarOrg/nemar-cli and sccn/EEGDash.
#
#   Usage:  bash file-nemar-issues.sh            # dry run, prints what it would do
#           bash file-nemar-issues.sh --go       # actually create the issues
#           bash file-nemar-issues.sh --go --only N1,N4    # a subset
#
# Creates 8 issues on nemarOrg/nemar-cli and 4 on sccn/EEGDash, creates any
# missing labels, then posts "Depends on #N" cross-links once numbers are known.
# Safe to re-run with --only to fill in anything that failed.

set -uo pipefail

GO=0
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
  --go) GO=1 ;;
  --only)
    shift
    ONLY="$1"
    ;;
  *)
    echo "unknown arg: $1" >&2
    exit 2
    ;;
  esac
  shift
done

command -v gh >/dev/null || {
  echo "gh not found. https://cli.github.com/" >&2
  exit 1
}
if [ "$GO" -eq 1 ]; then
  gh auth status >/dev/null 2>&1 || {
    echo "gh not authenticated. Run: gh auth login" >&2
    exit 1
  }
fi

NEMAR_REPO="nemarOrg/nemar-cli"
EEGDASH_REPO="sccn/EEGDash"

declare -A NUM # key -> issue number

want() {
  [ -z "$ONLY" ] && return 0
  case ",$ONLY," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}

ensure_label() {
  local repo="$1" name="$2" color="$3"
  [ "$GO" -eq 1 ] || return 0
  gh label create "$name" --repo "$repo" --color "$color" >/dev/null 2>&1 || true
}

mk() {
  local key="$1" repo="$2" title="$3" labels="$4" bodyfile="$5"
  if ! want "$key"; then
    echo "skip $key"
    return 0
  fi
  if [ "$GO" -eq 0 ]; then
    echo "[dry-run] $key -> $repo"
    echo "          title:  $title"
    echo "          labels: $labels"
    echo "          body:   $(wc -c <"$bodyfile") bytes"
    return 0
  fi
  local url
  url=$(gh issue create --repo "$repo" --title "$title" --label "$labels" --body-file "$bodyfile") || {
    echo "FAILED $key" >&2
    return 1
  }
  echo "$key  $url"
  NUM[$key]="${url##*/}"
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# ---------- labels ----------
for l in "zarr:0e8a16" "data-quality:d93f0b" "priority:b60205" "api:1d76db" \
  "backend:5319e7" "ops:c5def5" "observability:c5def5" "docs:006b75" \
  "agents:5319e7" "epic:3e4b9e" "hpc:fbca04" "performance:fbca04" \
  "reproducibility:0e8a16" "feature:a2eeef"; do
  ensure_label "$NEMAR_REPO" "${l%%:*}" "${l##*:}"
  ensure_label "$EEGDASH_REPO" "${l%%:*}" "${l##*:}"
done

# ---------- N1 ----------
cat >"$TMP/N1.md" <<'BODY_N1_EOF'
### Summary

The Zarr serving-copy converter appears to walk every readable signal file in a dataset repository, including `derivatives/` and `sourcedata/`. It should convert the BIDS raw tree only, and derived data, if converted at all, should be namespaced and explicitly marked.

This produces four distinct problems: a large share of the catalog's reported conversion failures are artifacts of converting things that cannot be converted; `store_count` overstates available recordings by up to 2x; the index is a silent provenance hazard for downstream clients; and at least one dataset has its entire Zarr copy built from `sourcedata/` with the wrong modality.

### Evidence

| Dataset | `store_count` | Raw (`sub-*`) | `derivatives/` | `sourcedata/` | Failures |
|---|---|---|---|---|---|
| `on007763` (MEG) | 105 | 41 | 64 | 0 | 41, **all** under `derivatives/` |
| `on004718` (EEG) | 96 | 48 | 48 | 0 | 6, all raw `.set`, `file_read_error` |
| `on004362` (EDF) | 3052 | 0 | 0 | **3052** | none reported |
| `nm000329` (EEG) | 112 | 112 | 0 | 0 | 0 |

Reproduce for any dataset:

```bash
curl -s https://nemar.s3.us-east-2.amazonaws.com/<id>/zarr/index.json \
  | jq -r '.stores[].path' | cut -d/ -f1 | sort | uniq -c
```

**1. Derivatives are the source of the failures.** Every one of `on007763`'s 41 failures is under `derivatives/`. The dominant code is `not_continuous`, thrown on trial-averaged `_ave.fif` files:

```json
{"path":"derivatives/sub-01/meg/sub-01_task-BCCWJreading_meg_0.1-40-ica_ave.fif","code":"not_continuous"}
{"path":"derivatives/sub-02/meg/sub-02_task-BCCWJreading_meg_0.1-40-ica_ave.fif","code":"not_continuous"}
```

Those are evoked responses. There is no continuous signal to convert. Restricting the walk takes `on007763` from 41 failures to zero. Worth checking how much of the catalog-wide failure count this explains before doing anything else.

**2. `store_count` overstates available recordings.** `on004718` is exactly doubled. Any coverage or capacity figure computed from `store_count` is inflated by an unknown per-dataset factor, including the `zarr_store_count` column (migration 0035) and the observability dashboard.

**3. Provenance hazard for downstream clients.** This is the one with consequences outside NEMAR.

```
sub-01/meg/sub-01_task-BCCWJreading_meg.con                            <- raw
derivatives/sub-01/meg/sub-01_task-BCCWJreading_meg_0.1-40_ica_raw.fif  <- bandpass 0.1-40 Hz, ICA cleaned
```

Both appear in the same `stores` array, same format, same attributes. Nothing marks the second as derived, and nothing records what pipeline produced it. A client that matches on subject and task rather than exact path, or that simply iterates `stores`, will train on someone else's preprocessing and report it as raw NEMAR data. That error is invisible in the results.

The store-level `note` attribute says `"Derived serving copy ... BIDS source remains authoritative"`, but that refers to the Zarr-vs-BIDS relationship, not to whether the BIDS source was itself a derivative. The two senses of "derived" collide.

**4. `sourcedata/` conversion, plus modality misdetection.** `on004362` has 3052 stores, all under `sourcedata/rawdata/`, and nothing from the BIDS raw tree. In BIDS, `sourcedata/` is explicitly the pre-conversion material. The same dataset also mistypes modality:

```json
{
  "path": "sourcedata/rawdata/S001/S001R01.edf",
  "modalities": ["misc"],
  "groups": [{"name":"misc_160hz","modality":"MISC","rate":160.0,"n_channels":64,"n_samples":9760,"duration_s":61.0}]
}
```

64-channel EEG typed as `MISC`. A client filtering on `modality == "EEG"` sees an empty dataset. Plausibly the same root cause: if modality detection keys on BIDS path structure (`sub-*/eeg/`), anything under `sourcedata/` fails to classify. Fixing scope may fix typing for free.

### Proposed fix

1. Walk `sub-*/[ses-*/]<datatype>/` only.
2. Skip `sourcedata/` unconditionally.
3. Skip `derivatives/` by default.
4. Skip non-continuous files rather than reporting them as failures. A file skipped by policy should not appear in `failures`, or should carry a distinct `skipped_by_policy` code excluded from failure metrics.

If derived data is wanted later, and there is a reasonable case since some derivatives are the most usable version of a dataset, do it explicitly: a separate `<id>/zarr/derivatives-index.json`, a `derived: true` field, and pipeline provenance from the `derivatives/<pipeline>/dataset_description.json` `GeneratedBy` block.

### Acceptance criteria

- [ ] `on007763` index contains 41 stores and 0 failures.
- [ ] `on004718` index contains 48 stores.
- [ ] `on004362` either converts its BIDS raw tree or reports zero convertible recordings, and does not expose `sourcedata/`.
- [ ] Catalog-wide failure count re-measured after re-conversion, with the delta recorded.
- [ ] `on004362`-style EEG typed as `EEG`, not `MISC`, or a separate issue opened if the cause is unrelated to scope.
BODY_N1_EOF
mk "N1" "$NEMAR_REPO" "Zarr converter walks the whole repository, not the BIDS raw tree" "zarr,data-quality,bug,priority" "$TMP/N1.md"

# ---------- N2 ----------
cat >"$TMP/N2.md" <<'BODY_N2_EOF'
**Depends on:** batch with N1 (same re-conversion pass)

### Summary

`index.json` is the mandatory entry point to the whole Zarr layer, since anonymous `ListBucket` is denied. It is also entirely undocumented and does not say where the bytes are. Bump to `format_version: 3`, add the fields clients actually need, and publish a schema.

### Problem

Nothing in this repo describes the per-store index schema. `getZarrIndex` (`backend/src/services/s3.ts:750-760`) parses only `store_count` and `source_commit`, and the `zarr-ready` callback body (`routes/callbacks/zarr-ready.ts:36-56`) has no per-store fields. Everything about `path` / `source_key` / `groups` / `n_samples` is discoverable only by probing live objects. External clients are coupling to an undocumented shape.

Separately, the index gives no indication of where to read the bytes from, so every client hardcodes either the `zarr.nemar.org` base or the S3 bucket URL. That removes any freedom to move, mirror, or re-host the serving copy later.

### Proposal

```json
{
  "format": "nemar-zarr-index",
  "format_version": 3,
  "dataset_id": "on007763",

  "contract_base":  "https://zarr.nemar.org/on007763/zarr/",
  "data_base":      "https://nemar.s3.us-east-2.amazonaws.com/on007763/zarr/",
  "data_base_kind": "s3-public",
  "s3_uri":         "s3://nemar/on007763/zarr/",
  "s3_region":      "us-east-2",
  "s3_anonymous":   true,

  "source_commit": "...",
  "updated_utc":   "...",
  "store_count":   41,
  "n_recordings":  41,
  "errors":        0,
  "failure_count": 0,

  "stores": [
    {
      "path": "sub-01/meg/sub-01_task-BCCWJreading_meg.con",
      "zarr": "sub-01/meg/sub-01_task-BCCWJreading_meg.zarr",
      "source_tree": "raw",
      "derived": false,
      "source_key": "SHA256E-...",
      "modalities": ["meg"],
      "groups": [{"name":"meg_250hz","modality":"MEG","rate":250.0,"n_channels":209,"n_samples":552750,"duration_s":2211.0}],
      "n_events": 412,
      "trial_types": {"word": 380, "sentence_end": 32},
      "power_line_frequency": 50.0
    }
  ],
  "failures": [{"path": "...", "code": "..."}]
}
```

**Why `data_base` and `s3_uri` both.** They serve different clients. `data_base` is what an HTTP-based Zarr reader wants; `s3_uri` plus region plus the anonymous flag is what `boto3`, `s3fs` and `zarr` want natively, and handing it over saves every client from parsing a URL back into bucket and key. EEGDash deliberately avoids `s3fs` over the `aiobotocore` pin documented in `downloader.py:12-17`, so a clean `s3://` triple is worth more to it than the HTTPS form.

Make these per-dataset, not global, so datasets can be migrated or mirrored individually.

**Why `n_events` and `trial_types`.** They let a client decide whether a dataset is worth opening, and which epoching strategy to use (see N3), without reading a single signal byte.

**Why `errors` alongside `failure_count`.** The producer contract (`routes/callbacks/zarr-ready.ts:51-55`) defines `failure_count` as the subset of failures that are typed data failures, with the total in `errors`. Only `failure_count` is currently published, and in a 32-dataset sample 9 indexes exposed neither. Publishing both makes completeness assessable.

### Acceptance criteria

- [ ] JSON Schema for `nemar-zarr-index` published and versioned.
- [ ] All fields above present on every regenerated index.
- [ ] `docs.nemar.org` states that `data_base` and `s3_uri` **may change** and must not be hardcoded, and that `contract_base` is the only stable URL.
- [ ] A documented `format_version` stability policy.
BODY_N2_EOF
mk "N2" "$NEMAR_REPO" "Zarr index format v3: declare the data plane, the source tree, and a real schema" "zarr,api,enhancement" "$TMP/N2.md"

# ---------- N3 ----------
cat >"$TMP/N3.md" <<'BODY_N3_EOF'
**Depends on:** batch with N1 and N2

### Summary

There are no events in the Zarr stores. I probed for an `annotations` node and got 404. Every client that wants to epoch must go back to the BIDS tree, fetch `events.tsv` per recording, parse TSV, and align onsets to sample indices in the resampled signal. Publish one columnar file per dataset instead.

### Why this is the highest-value item on the list

**The alignment is only correct if you compute it.** The converter is the only party that knows the exact resampling relationship between source rate and level-0 rate, including polyphase filter delay. Every client currently recomputes `round(onset * rate)` and quietly gets a sub-sample offset wrong wherever the source rate is not an integer multiple of the target, which is common: `nm000329` resamples 1000 Hz to 250 Hz, `on004362` is at 160 Hz, `on007763` has groups at both 200 Hz and 250 Hz within one store. Publishing the sample index makes alignment correct by construction and removes an entire class of silent error from every downstream tool at once.

**One fetch plans the whole job.** A 100-subject dataset with 500 events each is 50k rows, roughly 0.5 to 2 MB dictionary-encoded. A client fetches one object and can compute how many epochs per condition, which shards contain them, and what the event density is, with zero signal bytes read.

**It makes shard planning trivial.** `shard_id = sample_index // shard_samples` is one column operation.

### Schema

```
store_path    string (dict)     joins to index.json stores[].zarr
subject       string (dict)
session       string (dict, nullable)
task          string (dict)
run           string (dict, nullable)
onset_s       float64           as in events.tsv
duration_s    float32
sample_index  int64             onset in LEVEL-0 SAMPLES, post-resample
group_name    string (dict)     which zarr group, e.g. "eeg_250hz"
trial_type    string (dict)
value         string (dict, nullable)
hed           string (dict, nullable)
...           pass through remaining events.tsv columns
```

`hed` matters for N8 and for agent readability generally: NEMAR already tracks `has_hed` and `hed_version` in the datasets table, and HED is what turns an opaque `trial_type` into something a machine can reason about.

### Acceptance criteria

- [ ] `<id>/zarr/events.parquet` present for every dataset with events.
- [ ] `sample_index` verified against a known-rate-change dataset (`nm000329`, 1000 Hz to 250 Hz) to within one sample.
- [ ] Schema documented alongside the index schema from N2.
- [ ] `n_events` and `trial_types` in `index.json` derived from the same source.
BODY_N3_EOF
mk "N3" "$NEMAR_REPO" "Publish \`<id>/zarr/events.parquet\` with converter-computed sample indices" "zarr,enhancement,priority" "$TMP/N3.md"

# ---------- N4 ----------
cat >"$TMP/N4.md" <<'BODY_N4_EOF'
**Depends on:** nothing (can ship before the converter work)

### Summary

Establish `zarr.nemar.org` as the stable public interface for the Zarr layer while the bytes continue to be served directly from S3. The physical location becomes an implementation detail declared by the index (N2), so it can change later without a client release.

### Context

Cloudflare's [Service-Specific Terms](https://www.cloudflare.com/service-specific-terms-application-services/) require a Cloudflare paid service "in order to serve video and other large files via the CDN", restricting "a disproportionate percentage of pictures, audio files, or other large files" on Free, Pro and Business, with Enterprise exempt. Zarr chunk objects in `s3://nemar` are large files hosted outside Cloudflare, so proxying the bulk data plane at archive scale is what the terms restrict. Moving to R2 is not attractive while AWS sponsors the S3 bucket.

Redirecting solves this cleanly: the Worker never carries the bytes, so there is no terms exposure, but every request is still counted.

### Routing

| Request | Response |
|---|---|
| `GET /<id>/zarr/index.json` | Proxied, edge-cached, D1-gated. The contract entry point. |
| `GET /<id>/zarr/<store>/...` with an `Origin` on the NEMAR allowlist | Proxied with CORS, as today. Browser viewer, low volume. |
| `GET /<id>/zarr/<store>/...` with no `Origin` or a non-allowlisted one | `302` to the public S3 URL. Libraries, HPC, agents. |
| `HEAD` anything | Answered directly, never redirected. |

The `HEAD` rule is load-bearing: `data.ts:358` already records that "rclone's HTTP backend does NOT follow HEAD redirects by default", and `fsspec`'s `info()` calls hit exactly that path when a Zarr client probes an object. The 302 fork can reuse the archive pattern at `data.ts:456-463`, including omitting `Content-Length` from a GET 302 while keeping `Last-Modified` and `ETag`.

### Three fixes to make in the same PR

**Fix the `Range` cache bypass.** `zarr-data.ts:137` skips the cache whenever a `Range` header is present. This is not a platform limit. Cloudflare's Cache API docs: *"Results in a 206 response if a matching response with a Content-Length header is found. Your Cloudflare cache always respects range requests"*, and *"Workers Caching expects your Worker to return the full 200 response and does the range slicing itself."* Cache the full object and let `cache.match()` slice. Note `cache.put` throws on a 206, so priming requires a full-object fetch. Even in an index-only role this is worth removing, and it is the one change that makes chunk proxying viable if Enterprise ever lands.

**Drop the D1 read on redirects.** `isPublicDataset` runs on every cache miss. On a redirect path that is a database round trip per chunk. It is also unnecessary: the Worker already fetches an unauthenticated public S3 URL, so the bucket's `NotResource` deny-list is the real enforcement point, and redirecting to a URL that 403s leaks nothing the current 404 does not. Keep the gate on `index.json`.

**Relax the rate limiter on redirects.** A 302 costs a fraction of a millisecond of CPU and zero bytes. The limiter is IP-keyed (`middleware/rateLimit.ts`), so a cluster behind one NAT address looks like one abusive client and gets 429s for requests that cost nothing. Exempt redirects or raise the bucket substantially, and log trips rather than enforcing them.

### Telemetry note

Record bytes on the redirect path from the `Range` header rather than falling back to 0 the way the archive path does. The client asked for exactly that many bytes.

### Acceptance criteria

- [ ] Non-browser `GET` of a chunk returns 302 to the public S3 URL, with the `Range` header preserved by the client on re-request.
- [ ] Browser `GET` from a `*.nemar.org` origin still returns bytes with correct CORS.
- [ ] `HEAD` never returns 302.
- [ ] No D1 query on the redirect path (verify in logs or a test).
- [ ] `recordAccess` emits non-zero bytes for ranged redirects.
- [ ] Range requests for `index.json`-adjacent objects hit the edge cache.
BODY_N4_EOF
mk "N4" "$NEMAR_REPO" "Make zarr.nemar.org the contract: proxy the index, redirect the bytes" "zarr,backend,enhancement" "$TMP/N4.md"

# ---------- N5 ----------
cat >"$TMP/N5.md" <<'BODY_N5_EOF'
**Depends on:** nothing

### Summary

`api.nemar.org/datasets` exposes no Zarr field. None of the four SELECT lists in `backend/src/routes/datasets/catalog.ts` touch one, and the single `zarr` match in the file is a comment at line 31. Yet the `datasets` table carries eleven columns: `zarr_status`, `zarr_converted_at`, `zarr_store_count`, `zarr_index_etag`, `zarr_source_commit` (0035), `zarr_checked_at` (0038), and `zarr_errors`, `zarr_failure_count`, `zarr_deterministic`, `zarr_data_failures`, `zarr_failed_at` (0046).

A client that wants to decide stream-versus-download must currently probe `<id>/zarr/index.json` once per dataset. The failure columns in particular are exactly what that decision needs.

### Proposal

1. Add the zarr columns to the catalog SELECT lists and the response shape, at minimum `zarr_status`, `zarr_store_count`, `zarr_converted_at`, `zarr_source_commit`, `zarr_errors`.
2. Add a `has_zarr=true` filter alongside the existing `has_doi` / `has_hed` filters.
3. Publish `s3://nemar/zarr-catalog.json`: one entry per streamable dataset with id, DOI, license, modalities, participants, tasks, store count, total duration, `has_hed`. This is the front door for anyone, human or agent, who cannot `ListBucket` and does not already know a dataset id.

### Acceptance criteria

- [ ] `GET /datasets?has_zarr=true` returns only datasets with a Zarr copy.
- [ ] Zarr fields present in the dataset object.
- [ ] `zarr-catalog.json` published and refreshed by the same job that runs the zarr sweep.
BODY_N5_EOF
mk "N5" "$NEMAR_REPO" "Expose Zarr state in the public catalog, and publish a top-level zarr catalog" "api,zarr,enhancement" "$TMP/N5.md"

# ---------- N6 ----------
cat >"$TMP/N6.md" <<'BODY_N6_EOF'
**Depends on:** nothing

### Summary

With reads going direct to S3 (N4), Worker analytics see dataset-open events but not bulk traffic. The AWS Open Data program explicitly provides for the missing half.

### Context

From the [AWS onboarding handbook for data providers](https://assets.opendata.aws/aws-onboarding-handbook-for-data-providers.pdf):

> "we permit you to enable S3 bucket logs on your data bucket and to create a second S3 bucket for temporary storage of S3 logs"

with the condition that log objects expire after one month, longer retention being at our own expense. CloudWatch metrics are likewise expected to be enabled on the bucket. So this is the sanctioned path, not a workaround.

The same handbook is the reason not to gate reads: public read-only access is mandatory and the program configures the bucket policy for it.

### Proposal

1. **Server access logging** to a second bucket with a 30-day lifecycle rule.
2. **Weekly Athena or Glue rollup** into a small permanent table, run before logs expire:
   `date, dataset_id, object_class (index|metadata|chunk), requests, bytes, distinct_source_ips, user_agent_class`
   Raw logs churn inside the sponsorship; the rollup is a few kB per day and kept forever. Sizing: a log record is roughly 500 bytes, so a billion monthly requests is about 500 GB, and an Athena scan of that is around $2.50 at $5/TB. Partition by date.
3. **One CloudWatch request-metrics filter** on the `zarr/` prefix for a live dashboard number, roughly $3/month. Do not create per-dataset filters; at 754 datasets that gets expensive and the rollup already gives per-dataset detail.
4. **User-Agent convention.** Ask EEGDash, the viewer, and other first-party clients to send something like `eegdash/0.5 (nemar-zarr)`. In the access logs this is the single most informative field for separating library traffic from crawlers from agents, at zero cost.

### Acceptance criteria

- [ ] Logging enabled with a 30-day expiry rule.
- [ ] Rollup job scheduled and its output queryable.
- [ ] Dashboard reads zarr request volume from CloudWatch.
- [ ] User-Agent convention documented for client authors.
BODY_N6_EOF
mk "N6" "$NEMAR_REPO" "Data-plane telemetry: S3 access logs, rollup, and a User-Agent convention" "ops,observability" "$TMP/N6.md"

# ---------- N7 ----------
cat >"$TMP/N7.md" <<'BODY_N7_EOF'
**Depends on:** N2

### Summary

Store attributes carry provenance as prose. Machines cannot use prose, and the population reading these stores is increasingly machine.

### Problem

Today the store group carries a free-text `note`:

> "Derived serving copy. level 0 of each group is the anti-aliased inference signal; view/* are min/max render envelopes (not for inference). BIDS source remains authoritative."

Good for a human reading the JSON, useless to a client deciding whether the data is suitable, and it collides semantically with the BIDS sense of "derivative" (see N1).

### Proposal

Structured fields on every store:

```json
{
  "derived": false,
  "source_tree": "raw",
  "lossy": true,
  "dtype": "int16",
  "effective_rate_hz": 250,
  "source_rate_hz": 1000,
  "anti_aliased": true,
  "doi": "10.82901/nemar.on007763",
  "license": "CC0",
  "citation": "...",
  "hed_version": "8.2.0",
  "source_commit": "..."
}
```

DOI, license and citation especially. If the data carries its own attribution, any client that reads it has the citation at the moment it needs it rather than reconstructing it later. That has a disproportionate effect on whether NEMAR gets cited correctly.

Then document the whole contract at `docs.nemar.org`:

- store layout: `<store>.zarr/<group>/0` for level 0, `view/` for render envelopes
- per-channel `scale`, `offset`, `unit`, `usable_for_inference`, `row_index`
- the chunk rule: inner chunk is 4.0 s, shard is 300 s or the whole array rounded up to an inner-chunk multiple (verified on `on007763` at 200 Hz, `nm000329` at 250 Hz, `on004362` at 160 Hz)
- `modality_rates`: EEG 250, MEG 250, IEEG 1000, EMG 1000, applied as a cap not a target
- a cost ladder, so clients know the cheap entry points: catalog (kB), index (kB), events.parquet (MB), `view/*` (MB), level 0 (GB)

### Acceptance criteria

- [ ] Structured fields present on regenerated stores.
- [ ] Store contract page live at `docs.nemar.org`.
- [ ] Cost ladder documented.
BODY_N7_EOF
mk "N7" "$NEMAR_REPO" "Structured provenance in store attributes, and a written store contract" "zarr,docs,data-quality" "$TMP/N7.md"

# ---------- N8 ----------
cat >"$TMP/N8.md" <<'BODY_N8_EOF'
**Depends on:** N2, N3, N5

### Summary

Agent traffic will be a growing fraction of reads. Raw Zarr is readable by agents but not well suited to them: they cannot crawl (no `ListBucket`), they have no cost intuition, and they confabulate provenance. An MCP server addresses all three, and it is the only telemetry seam people opt into because it is more convenient than the alternative.

### Scope

Tools, roughly: `search_datasets`, `describe_dataset`, `list_recordings`, `get_events`, `read_window`, `render_overview`.

Design principles:

- **Encode the cost ladder as tool design** rather than documentation nobody reads. `render_overview` should read `view/*`, never level 0.
- **Return provenance with every read**, unavoidably: DOI, license, `derived`, `effective_rate_hz`, `lossy`, `source_commit`, `zarr_index_etag`. An agent that re-runs an analysis after a re-conversion otherwise gets different bytes with no signal, since the store is latest-only by design (migration 0035 is explicit).
- **Semantic search over HED and dataset descriptions**, which is what agents are worst at doing themselves and where NEMAR's HED coverage is a real differentiator.
- **Instructive errors.** A 429 or an over-large read should return the cheaper alternative in the body. Agents actually re-plan on that; humans mostly do not.

The raw S3 path stays open. MCP is what agents reach for because it is easier, not because anything else was closed.
BODY_N8_EOF
mk "N8" "$NEMAR_REPO" "NEMAR MCP server" "enhancement,epic,agents" "$TMP/N8.md"

# ---------- E1 ----------
cat >"$TMP/E1.md" <<'BODY_E1_EOF'
**Depends on:** nothing. One-line fix, do it today.

### Problem

`get_default_cache_dir` (`eegdash/paths.py:44-48`) returns `Path.cwd() / ".eegdash_cache"` and only falls back to `MNE_DATA` if that `mkdir` raises. On a cluster the working directory is usually a home or project filesystem with a hard inode quota, and array jobs launched from the same directory contend on it. A BIDS corpus plus this cache is millions of small files, which is exactly what Lustre and GPFS metadata servers handle worst.

### Proposal

Resolution order:

1. `$EEGDASH_CACHE_DIR`
2. `$SCRATCH` if set (common on HPC schedulers)
3. `$TMPDIR` if set and writable
4. `MNE_DATA`
5. a platform user-cache directory (`platformdirs.user_cache_dir`)
6. `./.eegdash_cache` as the last resort, not the second

Log the resolved path once at first use.
BODY_E1_EOF
mk "E1" "$EEGDASH_REPO" "Cache directory default is a footgun on shared filesystems" "bug,hpc" "$TMP/E1.md"

# ---------- E2 ----------
cat >"$TMP/E2.md" <<'BODY_E2_EOF'
**Depends on:** N2 for the clean path, but implementable against the current index with fallbacks.

### Summary

`EEGDashRaw` is lazy at the record level but eager at the file level: `_download_required_files` fetches whole objects through `boto3` with no range-read path, so touching one 2 s window costs the entire recording. NEMAR publishes Zarr serving copies for most of its public catalog, addressable at 4-second granularity.

### Measured benefit

On `nm000329`, `sub-1_ses-0_task-imagery_run-1_recording-clean_eeg.bdf`: 63 channels, 3315 s, source BDF 627 MB (24-bit at 1000 Hz), level-0 array 63 x 828750 int16 = 104 MB uncompressed.

| Access pattern | Download | Stream | Ratio |
|---|---|---|---|
| One 4 s window | 627 MB | ~126 kB | ~5000x |
| 100 random 4 s windows | 627 MB | up to ~13 MB | ~50x |
| Full single pass | 627 MB | ~104 MB | ~6x |
| Ten passes, no cache | 627 MB | ~1.04 GB | download wins |

Crossover is at the fidelity reduction ratio, source bytes over level-0 bytes: about 6x here, closer to 2x for a float32 FIF already at 200 Hz.

Secondary benefit: `dataset/base.py` is 2155 lines, roughly a thousand of them format repair (split FIF `:1197`, embedded `.fdt` `:945`, CTF directory completion `:988`, CTF dates `:1900` with locale months in `io.py:33`, truncated meg4 `:1957`, coordsystem `:1860`, projectors `:1983`, missing events `:2004`). A uniform int16 serving copy bypasses all of it.

### Important: this changes the data

The Zarr copy is a lossy derived product, not a mirror. Store attributes are explicit: `int16`, rates capped at 250 Hz for EEG and MEG and 1000 Hz for iEEG and EMG, polyphase FIR anti-aliasing, per-channel `usable_for_inference`, and a note that "BIDS source remains authoritative". Fine for most deep learning. Disqualifying for HFOs, for line-noise work at the original rate, for 24-bit dynamic range, and for exactly reproducing a published pipeline.

### Proposal

`EEGDashZarrRaw`, a sibling of `EEGDashRaw` implementing the same braindecode `RawDataset` surface:

- resolve `index.json` once per dataset per session and cache it
- read `s3_uri` / `s3_region` / `s3_anonymous` from the index (N2); do not construct URLs
- match `bids_relpath` against the index `path` by **exact string equality, never fuzzy subject-and-task matching**
- refuse any entry with `source_tree != "raw"` unless the caller explicitly opts in
- open `<store>/<group>/0` and return int16 slices scaled by per-channel `scale` and `offset`
- fall back to `EEGDashRaw` when the index has no entry, the group is not `usable_for_inference`, or the caller needs fidelity the serving copy cannot provide
- gate the whole thing behind an explicit `source="zarr"`, never a silent default

Note that braindecode 1.4.0's existing Zarr path is not reusable: `_zarr_to_memmap` (`braindecode/datasets/base.py:300`) decompresses to a float64 `.npy` memmap, expects `zarr.open(path)[group_name]["data"]` rather than NEMAR's `<group>/0`, and enforces locality twice (`hub.py:819`). This is a local cache format, not a remote reader.

Dependency caution: `s3fs` pulls in `aiobotocore`, which is the exact conflict `downloader.py:12-17` documents as the reason for using `boto3` directly. Prefer `zarr.storage.ObjectStore`, or a small custom Zarr store backed by the existing `boto3` client with range GETs.
BODY_E2_EOF
mk "E2" "$EEGDASH_REPO" "Stream NEMAR Zarr stores instead of downloading recordings" "enhancement,feature" "$TMP/E2.md"

# ---------- E3 ----------
cat >"$TMP/E3.md" <<'BODY_E3_EOF'
**Depends on:** E2, and N3 for the events file

### Summary

Naive random-access epoch sampling over a chunked remote store wastes most of what it reads. The fix is on the client, not in the chunk size.

### Analysis

Inner chunk is 4.0 s. For a 1.0 s ERP epoch at 63 channels and 250 Hz:

| Inner chunk | Chunks per epoch | Read | Useful | Amplification |
|---|---|---|---|---|
| 4 s (current) | 1.25 | 158 kB | 32 kB | 5.0x |
| 2 s | 1.50 | 94 kB | 32 kB | 3.0x |
| 1 s | 2.00 | 63 kB | 32 kB | 2.0x |

So re-chunking would buy 2.5x. Reading the whole 300 s shard and yielding every epoch in it buys 5x, because all 300 seconds get used. The 300 s shard is already a WebDataset-style shard.

Crossover is clean: N epochs read individually cost `N x 1.25 x 4` seconds-equivalent against 300 for the shard, so they cross at **ISI = 5 s**.

| ISI | Epochs per shard | Strategy |
|---|---|---|
| 1-4 s | 300-75 | read the shard |
| 6 s and up | 50 and fewer | range-read chunks |

Most ERP paradigms sit at ISI 1 to 3 s, so shard reads win. Sparse designs (long-ISI oddball, rare-target, spindle marking) fall the other way.

### Proposal

- `IterableDataset`, not map-style. Map-style random access defeats shard locality by construction and this is the single biggest throughput determinant.
- Shard-level shuffling with an in-memory buffer: shuffle shard order, read a shard, shuffle epochs inside it, yield.
- Adaptive strategy switch keyed on events per shard, computed from `events.parquet`.
- Assign shards to DataLoader workers rather than epochs, so each worker holds one decompressed shard.
- Open the store lazily inside each worker. `zarr` plus `boto3` or `s3fs` clients do not survive `fork`, which is the default worker start method on Linux, and this is the same discipline the existing `boto3` client already needs.
BODY_E3_EOF
mk "E3" "$EEGDASH_REPO" "Shard-aware IterableDataset for event-related epoching" "enhancement,performance" "$TMP/E3.md"

# ---------- E4 ----------
cat >"$TMP/E4.md" <<'BODY_E4_EOF'
**Depends on:** E2

### Summary

A dataset built from the Zarr path is not the same data as one built from BIDS. That difference must survive into the result.

### Proposal

Record in the dataset description, and surface in `__repr__`:

- `source: "zarr"` versus `"bids"`
- `format_version` and `source_commit` from the index
- `effective_rate_hz`, `source_rate_hz`, `dtype`
- `lossy: true`
- `source_tree` and `derived` from the store entry
- the dataset DOI

Also consume `sample_index` from `events.parquet` verbatim rather than recomputing `round(onset * rate)`. The converter is the only party that knows the exact resampling relationship including filter delay; recomputing it client-side is a silent sub-sample error wherever source and target rates are not integer multiples.

Without this, someone publishes a 250 Hz int16 result believing it came from the original recording, and nothing in the artifact says otherwise.
BODY_E4_EOF
mk "E4" "$EEGDASH_REPO" "Record serving-copy provenance on every Zarr-backed dataset" "enhancement,reproducibility" "$TMP/E4.md"

# ---------- cross-links ----------
link() {
  local key="$1"
  shift
  local repo="$1"
  shift
  [ "$GO" -eq 1 ] || return 0
  [ -n "${NUM[$key]:-}" ] || return 0
  local refs=""
  for d in "$@"; do
    if [ -n "${NUM[$d]:-}" ]; then
      case "$key$d" in
      N*E* | E*N*) refs="$refs ${OTHER_REPO_REF[$d]:-}#${NUM[$d]}" ;;
      *) refs="$refs #${NUM[$d]}" ;;
      esac
    fi
  done
  [ -n "$refs" ] || return 0
  gh issue comment "${NUM[$key]}" --repo "$repo" --body "Depends on:$refs" >/dev/null && echo "linked $key ->$refs"
}

declare -A OTHER_REPO_REF
for k in N1 N2 N3 N4 N5 N6 N7 N8; do OTHER_REPO_REF[$k]="nemarOrg/nemar-cli"; done
for k in E1 E2 E3 E4; do OTHER_REPO_REF[$k]="sccn/EEGDash"; done

link "N2" "$NEMAR_REPO" "N1"
link "N3" "$NEMAR_REPO" "N1" "N2"
link "N7" "$NEMAR_REPO" "N2"
link "N8" "$NEMAR_REPO" "N2" "N3" "N5"
link "E2" "$EEGDASH_REPO" "N2"
link "E3" "$EEGDASH_REPO" "E2" "N3"
link "E4" "$EEGDASH_REPO" "E2"

echo
if [ "$GO" -eq 1 ]; then echo "Done. Issues created."; else echo "Dry run only. Re-run with --go to create them."; fi
