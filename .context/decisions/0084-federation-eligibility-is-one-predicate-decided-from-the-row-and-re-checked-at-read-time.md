# ADR 0084: Federation eligibility is one predicate decided from the row and re-checked at read time

**Status:** accepted
**Date:** 2026-10-02
**Owner:** Seyed Yahya Shirazi

## Context

Epic #1586 puts NEMAR datasets into Neurobagel's federated search (ADR 0081, ADR 0082, ADR 0083).
Something has to decide which datasets may be federated, write their artifacts to a private store the node on the private node host pulls from, and take a dataset out the moment it should not be there.
Federation is a public disclosure, so the failure that matters is the one that publishes what must not be published: a private dataset, a withdrawn one, and above all an anonymous deposit (ADR 0065, ADR 0067).
The writer also hooks into publication and import, which are production flows that must not be put at risk by a feature that is, for now, only a convenience.

Three terms of Cloudflare's platform recur below.
D1 is the Worker's SQLite database, where the dataset catalog lives.
R2 is Cloudflare's object storage, used here as one private bucket per environment.
An ETag is the hash that S3 and R2 report for an object's contents: it changes whenever the object does, so it names a version of a file without reading it.

## Decision

**Eligibility is one predicate, written once, decided from the D1 row, and re-checked at every read.**

1. **One predicate, two forms.**
   `services/neurobagel-eligibility.ts` holds a list of named terms, each with its SQL and its TypeScript form, so the query that selects and the check that confirms cannot drift; a test drives every combination through both.
   A dataset is eligible when it is `active`, `public`, `anonymous = 0` (NULL is unknown, and unknown is not false), first published, not withdrawn, holds a `dataset_versions` row, and is a real dataset: an `nm` id below the reserved fixture band (ADR 0068) or an `on` OpenNeuro mirror, and neither a sandbox nor an exemplar row.
   **`on` mirrors are included by the owner's decision**, agreed with Neurobagel's principal investigator because NEMAR adds value to them.
   `xx` sandboxes and the reserved `nm0999xx` fixtures are out.
   **No exemplar is federated, in any environment.**
   An earlier draft admitted the exemplar fleet outside production, but the store's object names and the index schema accept `nm` and `on` ids only, so an exemplar would have been rewritten on every run and never indexed, and no staging node exists to read one.
   The predicate therefore takes no environment input: an `xx` id is out by its id, and a row flagged sandbox or exemplar is out by its flag.
   The `not_anonymous` term is the second line behind migration 0085's triggers (which make `anonymous = 1` imply no first publication), not a duplicate of them: a table rebuild drops triggers, and the mutation test proves the term necessary by dropping them first.
2. **A second, independent guard at gather time.**
   The transform's inputs are obtained by calling the real data plane in process, so the transform sees what the public sees.
   Before any depositor file is read, the gathered `metadata.json` must say `anonymous: false` exactly: a missing value, `null`, the string `"false"` and `0` are all refused.
   A disagreement with the row (row eligible, metadata not false) is an anonymity-class finding: it goes to the audit log and nowhere else (no GitHub issue, no mail, ADR 0067), status shows a count and never the identifier, and the dataset is treated as not eligible, so whatever was stored for it is removed.
   The writer also asks the data plane which version it calls the latest, and refuses a dataset on which the two readers disagree (they break a timestamp tie differently), because one version's manifest ETag would otherwise be stamped on another version's content.
3. **Re-checked at read time.**
   The read route (`GET /neurobagel/index.json`, `GET /neurobagel/<name>`) checks the predicate against D1 on every artifact request and serves the index filtered by the same check.
   A dataset that goes private is gone from what the node reads at once, with the stored objects untouched, because there is no path from "went private" to "bytes reach the node" that does not pass the check first (the argument ADR 0066's amendment makes for the data plane's caches).
   The bucket is tidied by the next run.
   The route proxies artifact bytes through the Worker, which ADR 0076 accepts for small files and [`.memory/never-proxy-bulk-bytes.md`](../../.memory/never-proxy-bulk-bytes.md) forbids for bulk.
   This is the first kind: the loader refuses an artifact over 6 MiB and the writer never stores one, and the largest real document is 0.44 MB.
   If artifacts ever approach that cap, serve them by redirect instead of raising it.
4. **Removal, and what the index promises.**
   A dataset that becomes private, withdrawn, archived, deleted, anonymous, a sandbox row, or loses its version has its artifacts deleted and drops out of the index in one run, and removal does not depend on ingestion succeeding.
   The order is for a consumer that may read at any moment: an addition writes artifacts before the index; a removal writes the index before it deletes artifacts.
   The loader checks every artifact's sha256 against the index and stops the WHOLE load on one mismatch, which would also block every removal.
   So the index is patched right after EACH dataset's artifacts are written (read it with its ETag, replace that dataset's entry, write conditional on the ETag: two operations), and never left to the end of a run: a run cut off by the Worker's limits would otherwise leave artifacts newer than the index.
   An index that cannot be patched stops the run there, and the closing sync rebuilds it.
   One window remains, and it is one dataset's own three writes: a cut-off between its first and last put leaves that dataset's artifacts ahead of its entry until the next run, which redoes the set (the JSON-LD, written last, is the commit marker) and patches it again.
   The closing sync rebuilds the index from a fresh bucket listing (each artifact carries its sha256 as R2 custom metadata, which R2 verifies on write), never from memory, and replaces it only when its entries differ, by a write conditional on the index not having changed since it was read.
   It reads the index before it lists the bucket, so a run that replaced the index in between makes the write lose and retry; and it decides eligibility after the listing, so a dataset another run published in the meantime is neither dropped from the index nor deleted.
   The loader refuses an empty index and a mass removal, so the last dataset to leave is taken out of the node with `nb hold`, not by the index.
5. **The writer is a step, never a blocker.**
   It runs as a hook after publication (both of the approval's exits), after a new version's row lands (the manifest-ready callback, after the metadata refresh, and the one reachable legacy inline version path) and after an import completes.
   A hook does nothing at all unless `NEUROBAGEL_WRITER_ENABLED` is exactly `"1"`, hands its work to `waitUntil`, is never awaited, and contains every failure.
   A production-only daily reconcile is the safety net, outside `DEV_CRON_ALLOWLIST`, examining at most `NEUROBAGEL_RECONCILE_MAX` datasets per tick (default 10, never more than 50) in a deterministic order: datasets with no stored set, then datasets whose stored signature is stale, then a window that moves each UTC day.
   A dataset whose ledger shows a standing refusal against its current signature is parked: it joins the window instead of the first two classes, so a dataset refused for ever (no manifest, a document over the cap) cannot take a slot of every tick from the healthy ones, and it is examined again at once when its row changes.
   The guarantee is this, and no stronger: when no dataset is missing or stale, every one is examined within `ceil(eligible / N)` days even when nothing is known to have changed.
   Missing or stale work takes slots first, so while there is any the window is narrower than `N` and a full cycle takes longer.
   A transient failure (an unreachable manifest, a failed read) is never parked, because it is never recorded as a finding.
6. **What a run costs, and the budget that keeps it inside a request.**
   A Worker invocation has 1000 subrequests, every D1 statement, R2 call and outgoing request spends one, and the reconcile shares its tick with every other daily job (ADR 0054); the admin route runs inline in one request.
   The writer counts what it spends at the two bindings it shares with the data plane, so the data plane's own D1 and R2 calls are counted, and charges the data plane's HTTP requests at an allowance of 8 per gather.
   Measured by difference over runs of 1, 3 and 7 datasets in the test environment: a rewritten dataset costs about 22 operations (9 D1 statements, 4 R2 calls, the manifest HEAD and the allowance), an unchanged one 3 (two D1 reads and the HEAD), and a run about 7 more (the plan, the listing, the ledger, the index sync).
   A run takes a budget of 400, begins a dataset only if 30 more (the most one is allowed to cost; a test fails if it does) and a reserve of 30 plus one delete per dataset leaving still fit, and stops with `stopped: ops_budget` and a count of what is left, so the answer to "did it finish" is in the result and the CLI says to run the same command again.
   The first dataset of a run is always examined, so a run makes progress however small the budget.
   At those numbers the default of 10 datasets spends about 230 operations at worst, and a call at the ceiling of 50 stops after about 16 first-time writes (measured: 16 datasets, 360 operations).
   The ceiling of 50 is enforced three times, in the writer, in the route's schema and in the CLI, so a larger request is refused with a reason and never shortened silently.
   The production figures will differ (the git broker mints a token, a presigned redirect adds a request); the allowance is the one number to revisit once a backfill has run.
7. **The fingerprint is derived, never stored in `datasets`** (ADR 0034).
   It is a hash of the row fields the transform reads, the whole enrichment document, the latest version, the manifest's ETag, the curation entry's hash, the transform version, the writer's own revision and the pinned vocabulary, kept as R2 custom metadata, so a second run over unchanged inputs writes nothing.
   A cheap signature of the same row (the enrichment document's length instead of its hash, no ETag) finds likely-stale datasets in one query, and is stamped from the very read the fingerprint comes from, so a row edited mid-run is never left stale.
   The data plane trusts a manifest copy for 60 seconds (ADR 0072), so the writer evicts a copy whose ETag is not the current one before it gathers: content is never older than the ETag it is stamped with.
   What it cannot see is a change to the data plane's own `metadata.json` builder; `NEUROBAGEL_WRITER_REVISION` and the admin `force` are the levers for that.
8. **The read token is a deployment secret, not an account credential.**
   `NEUROBAGEL_READ_TOKEN` is one Worker secret compared in constant time; unset, the route answers 404 as if it did not exist.
   Nothing is minted from it, it is tied to no user, API key, GitHub token or session, so ending an account's credentials has nothing here to cascade to (AGENTS.md, "Revocation cascades, always"); the owner rotates it by changing the secret and the loader's header file together.
   Its route has its own IP-keyed rate bucket, because a bearer nothing validates until the handler runs must not choose the bucket.
9. **Off by default, per environment, never crossing.**
   The committed configuration sets no switch; the bucket is bound per environment (`nemar-neurobagel`, `nemar-neurobagel-dev`); with the switch on and no bucket the writer is a reported `store_unconfigured`, not an error.
   The dev worker sends no mail, dispatches nothing, and cannot reach the production bucket.
10. **Curation, as ADR 0083 requires.**
    A dataset with a curation entry is never converted without it, and a file that does not load stops every dataset (`lookupCuration` answers `stop`): nothing is written, an existing artifact stays, and a finding needs a person.
    The four `curation_*` flags, with the report flags that mean a degraded join, ride on the stored artifact and are listed by `status` as needing review.

## Consequences

A dataset leaves the node's view as fast as D1 changes, and joins it as fast as a hook or a tick can write it.
Every state the writer's `status` shows is derived from the bucket, D1 and the audit log; nothing new is stored in `datasets`, and the only new rows are findings, written when a dataset's state changes and not once per run.
The cost is one more reader of the data plane's caches, one more R2 bucket per environment that must exist before the deploy that binds it, and a first backfill of about 780 datasets that takes `ceil(780 / N)` ticks, or about 50 calls of `nemar admin neurobagel regenerate --execute --limit 50` when a call stops on its budget, which each report and say to run again.
The data plane counts the writer's reads (two small files per regeneration) in its access metrics.
A Worker secret has to be created and its value handed to the node's header file by hand.
Each index patch reads and writes the whole index (about half a megabyte at the full catalog), a few times per run; that is the price of the invariant in item 4.

## Alternatives considered

- **Decide from the gathered metadata.** The data plane serves an anonymous deposit's metadata (ADR 0065 lists it as the trap); the row is the authority and the metadata is the backstop.
- **Filter only when writing.** A dataset made private would stay readable by the node until the next run; the read-time check costs one indexed D1 read per request.
- **A `datasets` column for the fingerprint, or a state table.** ADR 0034; the bucket and the audit log already hold what is needed.
- **No hooks, daily writer only (the architect's first plan).** A new publication would wait up to a day to be federated; the owner chose hooks with a reconcile behind them.
- **A bearer minted per node account.** The loader is a service on a shared host; an account credential would tie federation to a person's key lifecycle for no gain.
- **One index write at the end of a run (the first implementation).** A run cut off in the middle left artifacts newer than the index, and the loader stops the whole load on that.
- **Remove a dataset from the index before rewriting its artifacts, and add it back after.** It closes the last window of item 4 completely, at two more index writes per dataset and a moment in which a dataset being updated is absent from the node; the window it closes is three writes wide.

## Receipts

- Epic #1586, phase issue #1590; ADRs 0034, 0054, 0065, 0066, 0067, 0068, 0072, 0076, 0081, 0082, 0083.
- `backend/src/services/neurobagel-eligibility.ts`, `neurobagel-writer.ts`, `neurobagel-hooks.ts`, `neurobagel-plan.ts`, `neurobagel-ops.ts`, `neurobagel-store.ts`, `neurobagel-gather.ts`, `neurobagel-curation.ts`, `backend/src/routes/neurobagel.ts`, `backend/src/routes/admin/neurobagel.ts`, `shared/contract/neurobagel-admin.ts`.
- Guards: `backend/test/neurobagel-eligibility.test.ts` (each term necessary), `neurobagel-writer.test.ts` (golden bytes, idempotency, removal, ordering, an interrupted run, the budget, parking, the anonymity guards, curation), `neurobagel-fingerprint.test.ts` (every input moves it), `neurobagel-read-route.test.ts` (in workerd), `neurobagel-hooks.test.ts` (each flow through its entry point, and a writer that fails or hangs), `neurobagel-source-scan.test.ts` (syntax-tree scans, each proven by a planted violation), and the mutation battery `scripts/neurobagel/writer-mutation-battery.ts`.
