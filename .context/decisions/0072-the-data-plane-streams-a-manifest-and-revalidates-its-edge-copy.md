# ADR 0072: The data plane streams a manifest, answers one question per read, and revalidates its edge copy on every use

**Status:** accepted
**Date:** 2026-09-24
**Owner:** Seyed Yahya Shirazi

## Context

Every data.nemar.org request that names a file, a directory, a tombstone or `metadata.json`
needs the version manifest (`<id>/version/v<X>.json`), and `loadManifest` read it whole
and `JSON.parse`d it per request. nm000281's v1.0.3 manifest is 42,849,468 bytes and
102,532 entries; in a 128 MB isolate every request for that dataset ended in
`exceededMemory`, and an isolate that exceeds its memory fails every request it is
serving, not only the one that pushed it over (#1502). Seven catalog datasets have more
than 45,000 files. ADR 0066 makes the manifest the capability list, so whatever replaced
the whole parse had to stay the one source the gate reads.

Two facts measured while fixing it constrain the design. A version's manifest is NOT
immutable: the S3 objects for nm000132's three versions were all last written on
2026-05-27, months after those versions were published, and nm000281's on 2026-08-31,
because the pipeline regenerates manifests in place. And `manifest.json`, which presigns
every entry into one JSON document, cannot be bounded by reading less: its answer is the
whole manifest.

## Decision

**A manifest is read as a stream and a read answers one question.** The body is tokenized
incrementally (`services/manifest-scan.ts`) and a query (`services/manifest-queries.ts`)
keeps only its answer: one entry, one directory's immediate children, a boolean, a digest
of totals and the BIDS index, or a count. The verdict is still `JSON.parse`'s: the whole
body is read on every scan, and a document broken anywhere, including after the entry a
caller wanted, is malformed.

**No query reads a manifest whole, whatever the manifest looks like.** Where the stream
cannot prove an answer, it says so instead of materializing the document to find out.
The `metadata.json` digest is the case: its totals are exact only while keys strictly
ascend (so no key repeats). Once the order breaks, the totals are reported unproven, and
the route takes them from the catalog row, as it does when no manifest can be read. The
BIDS index and sessions are sets, so they stay exact in any order. An entry whose size
is not a non-negative integer is counted as a file and left out of `size_bytes`. Both
cases are logged. Manifests are rewritten in place, so "no current manifest is unsorted"
is an observation, not an invariant, and the bound cannot depend on it.

**The raw body is kept in the Workers Cache API, and a copy never answers without S3
saying so.** The copy is stored with the S3 ETag it came with, under a dataset- and
version-scoped synthetic key on a path no public route serves, and every use sends
`If-None-Match`. Only a 304 lets the copy answer; a rewrite gets a 200 and replaces it; a
404 is absent. The cache is read only after the visibility gate, as the manifest always
was. A copy is stored only after the scanner accepted the whole document, and a copy that
cannot be read back whole is not trusted: S3 answers instead.

**`manifest.json` refuses more than 30,000 entries** with a 413 that names the
per-directory JSON listing. It counts first and keeps nothing, so the refusal costs what
any other lookup costs.

## Consequences

- A request's memory follows its answer, not the dataset. Measured on a generated
  63 MB, 149,979-entry manifest: under 1 MB of live memory for a lookup under Bun, and an
  isolate heap that stayed under about 27 MB under local workerd on a 43 MB one.
- CPU still follows the manifest: every scan tokenizes the whole body (about 45 ms for
  40 MB under Bun, about 140 ms per request for 43 MB under local workerd). This is the
  stopgap the issue named. A per-directory index written at publication, still read
  from the manifest the gate trusts, is what removes it.
- Every read costs one conditional S3 request even on a cache hit, and a miss costs one
  full read that also fills the cache. The cache changes where the bytes come from, never
  what the route decides. The tail of a cache write goes to `waitUntil`, so a slow or
  wedged `cache.put` never delays an answer.
- `metadata.json` for a manifest whose keys are out of order reports the catalog row's
  `total_files` and `size_bytes`, which can be stale, instead of the manifest's. That
  departs from the pre-#1502 route, which parsed the whole document and summed it
  (concatenating a string size). This is the price of having no unbounded path.
- Seven datasets lose `manifest.json` (every one at 45,424 files or more, where the old
  path already needed about 90 MB). Their files remain enumerable one directory at a time.

## Alternatives considered

- **Trust the edge copy for a TTL.** Rejected: manifests are rewritten in place, and a
  stale capability list serves paths the current manifest no longer names.
- **Stop scanning at the requested entry.** Rejected: a truncated or corrupt manifest
  would then answer for its first part, which is a partial answer presented as complete.
- **Shard the manifest at publication, or index it in D1 or KV.** The right end state and
  a pipeline change across the Actions repository and every published version; left as
  the follow-up.
- **Stream `manifest.json` out as it scans.** Keeps every entry servable, but a manifest
  found malformed at its end could no longer be answered with the 404 it gets today once
  a 200 was sent. Not ruled out; not needed to stop the isolate dying.

## Receipts

- Issue #1502; `backend/src/services/manifest-scan.ts`, `manifest-queries.ts`,
  `manifest-source.ts`, `backend/src/routes/data.ts`
- ADR 0066 (the manifest is the capability list; cache keys never content-addressed across
  datasets), ADR 0050 (no WebAssembly: the scanner is plain JavaScript)
- Guards: `backend/test/manifest-scan.test.ts`, `manifest-queries.test.ts`,
  `manifest-source.test.ts`, `data-route-manifest-stream.test.ts`
