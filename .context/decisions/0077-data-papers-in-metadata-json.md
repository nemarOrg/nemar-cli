# ADR 0077: `metadata.json` serves `data_papers`, the citations judge's verdict, pulled from the dashboard into one D1 column

**Status:** accepted
**Date:** 2026-09-30
**Owner:** Seyed Yahya Shirazi

## Context

A downstream reader of `data.nemar.org/<id>/metadata.json` cannot tell which paper NEMAR treats as a dataset's data paper.
The only signal is the relation type on `related_identifiers[]`, and that is a hint: the enrichment writes it from a README it cannot change, it never searches for a paper the README does not cite, and a data paper can sit under `References` while a tool paper sits under `IsDerivedFrom` (ADR 0075).
The authority on "data paper" is `nemarOrg/nemar-citations`: its judge classifies every anchor DOI, and its fail-closed anchor gate decides which anchors contribute citations.
That is the same decision that produces the citation counts, so a key that reads from it cannot disagree with them.

nemar-citations already publishes to this repository by pull, not push:
the daily Worker cron (`citation-counts-sync.ts`) fetches `dashboard.nemar.org/citations/api/index.json` and UPDATEs two count columns.
Nothing pushes from the citations host, and that host holds no credential for this API.

## Decision

`metadata.json` serves a top-level `data_papers` array, written from a second manifest the dashboard publishes, `dashboard.nemar.org/citations/api/data-papers.json` (schema id `nemar-citations/data-papers@1`).
The Worker's daily cron pulls it beside the counts manifest (`data-papers-sync.ts`) and stores each dataset's list in one nullable JSON TEXT column, `datasets.data_papers` (migration 0088).
An item is `{ doi, title, year, venue, judge_model }`; `doi` is required and the rest may be null.

- **Absent versus empty.** A NULL column omits the key (not judged, or the gate has not processed the dataset yet). The text `[]` serves an empty list (gated, and no data paper).
  A reader can tell "we do not know yet" from "we looked and there is none".
- **The judge is the authority**, as ADR 0075 already says for relation types. The list holds only anchors the trusted judge called `data_paper` and the gate kept. The dataset's own DOI (already `external_links.dataset_doi`) and unjudged identity records are not in it.
- **Bounded, per ADR 0036.** The writer stores at most 10 papers and about 4 KB of JSON per dataset, and skips and logs a row that exceeds the bound rather than truncating it mid-record.
  D1 statements over about 100 KB break backup restore.
- **The writer never inserts and never bumps `updated_at`.** It UPDATEs an existing row and only when the serialized value changed, so a nightly no-op leaves the row untouched.
- **The reader is defensive.** A stored value that is not valid JSON or not the expected shape is omitted and logged, never a 500.
- **Anonymous deposits serve the field like any other dataset.** The owner decided this on 2026-09-30.
  The risk is that a data paper can point straight at the depositing group, which `blindEnrichmentMetadata` already guards against for `related_identifiers[]` (ADR 0065).
  Nothing here blinds it, so if that changes, the writer must skip anonymous rows and `markAnonymous` must null the column (ADR 0065: withhold by construction at the writer, not by filtering on read).
- **Both assemblers read the column.** `routes/data.ts` (`metadata.json`) and `services/page-bundle.ts` each carry their own `SELECT` and feed the same builder, so both select it.
  The raw column is withheld from the catalog detail route's `SELECT d.*`, as `sweep_stamps` is.
- **The cron runs on the dev worker too**, like the counts sync: it only reads a public manifest and writes this environment's own D1, so it cannot email a user, dispatch GitHub work against `nemarDatasets`, or mutate a DOI or a prod-bucket object.
  It is named in `DEV_CRON_ALLOWLIST` so that decision is greppable.

## Consequences

- The key and the citation counts come from one gate, so they agree by construction, and a dataset gains its `data_papers` only once the judge has run on it.
- Lag is structural: the manifest updates after the nightly hallu run merges and deploys the dashboard, and this worker pulls at 03:00 UTC (04:00 on dev), so `metadata.json` trails the run by about 15 to 17 hours.
  `page-bundle.json` can trail longer because of its stale-while-revalidate window.
- `datasets` goes from 83 to 84 columns against a ceiling of 97; thirteen columns remain.
- A dataset whose manifest row disappears keeps its last stored value. The sync never clears a row on absence, because a dashboard outage must not erase verdicts.
- The shape is a contract with nemar-citations: a change to `data-papers@1` is a change to `data-papers-sync.ts`. Rows with an unknown schema id are skipped.
- The vendored neuroschema bundle and `NEUROSCHEMA_VERSION` must move to the release that declares `data_papers` (0.4.1) before the key is schema-valid; until then the served document carries an undeclared key, as it already does for `anonymous`.

## Alternatives considered

- **Push from hallu to a Worker route.** Updates sooner, but the citations host would need a credential (the shared webhook token or an admin API key), this repository would need a new route and its inventory test, and the pushed data could drift from what the dashboard counts.
- **Derive it from the enrichment's `IsDescribedBy`.** Simple and local, but `IsDescribedBy` is a hint, so the key could name a paper the dashboard does not count, or omit one it does.
- **Store it in `enrichment_json`.** Rewritten wholesale by every enrichment run and committed to the public dataset repo, which is nemar-citations' own input.
- **A key in `sweep_stamps`.** Saves the column, but that JSON is bookkeeping about when sweeps ran (ADR 0035) and is hidden from the detail route by design; this is served content.
- **A side table.** ADR 0034 rejects it for catalog facts, and it adds another FK child to rebuild around.

## Receipts

- Design and the agreed decisions: nemarOrg/nemar-citations#250.
- ADR 0034 (column budget), ADR 0035 (sweep stamps), ADR 0036 (bounded rows), ADR 0065 (anonymity, withheld by the writer), ADR 0075 (the judge decides).
- Precedent for the pull: `backend/src/services/citation-counts-sync.ts` (#804).
