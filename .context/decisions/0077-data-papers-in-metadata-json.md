# ADR 0077: `metadata.json` serves `data_papers`, the citations judge's verdict, pulled from the dashboard into one D1 column

**Status:** accepted
**Date:** 2026-09-30
**Owner:** Seyed Yahya Shirazi

## Context

A downstream reader of `data.nemar.org/<id>/metadata.json` cannot tell which paper NEMAR treats as a dataset's data paper.
The only signal is the relation type on `related_identifiers[]`, and that is a hint.
The enrichment writes it from a README it cannot change, and it never searches for a paper the README does not cite.
Both failure directions have reached production (ADR 0075):
`nm000275`'s own Scientific Data descriptor was labeled `References`,
while the BIDS, EEG-BIDS and MEG-BIDS papers were labeled `IsDescribedBy` on dozens of datasets.

The authority on "data paper" for citation purposes is `nemarOrg/nemar-citations`.
Its judge classifies every anchor DOI, and its fail-closed anchor gate decides which anchors contribute citations.
ADR 0075 already names that pair as the backstop for citation counts and the decider of `IsSupplementTo`.
ADR 0075 also considered and rejected "let the citation pipeline alone decide" relation labels,
because `metadata.json` is also the DataCite record and other consumers read it.

nemar-citations already publishes to this repository by pull, not push:
the daily Worker cron (`citation-counts-sync.ts`) fetches `dashboard.nemar.org/citations/api/index.json` and UPDATEs two count columns.
Nothing pushes from the citations host, and that host holds no credential for this API.

## Decision

This ADR EXTENDS the judge's role to a dedicated key.
It does not reverse ADR 0075: `related_identifiers[].relation_type` stays with the enrichment and stays guarded by ADR 0075,
and the judge's verdict goes in its own key instead of overwriting those labels.

`metadata.json` serves a top-level `data_papers` array, written from a second manifest the dashboard publishes,
`dashboard.nemar.org/citations/api/data-papers.json` (schema id `nemar-citations/data-papers@1`).
The Worker's daily cron pulls it beside the counts manifest (`data-papers-sync.ts`).
Each dataset's list is stored in one nullable JSON TEXT column, `datasets.data_papers` (migration 0088).
An item is `{ doi, title, year, venue, judge_model }`; `doi` is required and the rest may be null.

**What the key means**

- **Absent versus empty.**
  A NULL column omits the key: not judged, or the gate has not processed the dataset yet.
  The text `[]` serves an empty list: gated, and no data paper.
  A reader can tell "we do not know yet" from "we looked and there is none".
- **Contents.**
  Only anchors the trusted judge called `data_paper` and the gate kept.
  The dataset's own DOI is not listed, because `external_links.dataset_doi` already carries it.
  Unjudged identity records are not listed either.
  An entry may be a deposit of the same data, such as a figshare or Zenodo record, because the judge counts those as `data_paper`.
  It is not always a journal article.
- **Trust.**
  `data_papers` is the judge-confirmed statement.
  A reader who wants to know which paper is this dataset's data paper should use it, not `related_identifiers[].relation_type`.

**How the pull behaves**

- **The schema id is checked once, for the whole manifest.**
  A different id skips the whole manifest, not individual rows.
  So does a body over 1 MiB (declared or streamed) and a list of more than 5000 datasets.
  Each leaves D1 untouched and logs an error.
- **A row that is present but cannot be stored fails closed.**
  That covers a bad DOI shape, more than 10 papers, more than 4096 serialized bytes, a non-array, bad field types,
  or a list that ADR 0075's guard empties (below).
  The dataset's column is set to NULL, and the row is logged with `console.error`, the dataset id and the reason.
  The stored claim can no longer be trusted to match the producer.
  NULL makes no statement, where a stale list would keep making one.
  The summary reports `rejected` and `cleared`.
- **A row that is absent is untouched.**
  A dashboard outage or a partial manifest must not erase verdicts.
- **A dataset listed twice is ambiguous.**
  Neither row is used and nothing is written, not even a clear.
- **ADR 0075's guard is applied by the writer.**
  An entry whose DOI is on `shared/never-data-paper.ts`, or whose title reads as a BIDS specification or tool paper, is dropped and logged.
  A non-empty list that the guard empties is refused and clears the column, rather than being stored as `[]`.
  `[]` would claim "judged, and no data paper" for a dataset the producer said had one.
- **Only `nm` and `on` ids are ever written,** because NEMAR serves only those.
  A `ds*` or `xx*` row is rejected even if the catalog holds it.
- **The writer never inserts and never bumps `updated_at`.**
  It UPDATEs an existing row, and only when the serialized value changed.
- **A chunk that D1 refuses does not abort the rest.**
  It is logged and counted in `failedChunks`.
- **The reader is defensive.**
  A stored value that is not valid JSON or not the expected shape is omitted and logged, never a 500.

**Bounds, and how they relate to ADR 0036**

ADR 0036 is scoped to operational rows (the audit log, catalog bookkeeping).
It says a row there carries flags, counts and a pointer, never a per-file list, and never one that is merely truncated.
It also says a new column that wants to store a per-item list must argue past its write-time bound in an ADR superseding it.
`data_papers` is served content, not operational bookkeeping, so this ADR does not supersede 0036.
It applies the same discipline instead.
The bound is at write time: at most 10 papers and 4096 serialized bytes per dataset.
An over-bound list is refused whole, never cut.
The one place content is truncated is a single over-long `title` (500), `venue` (200) or `judge_model` (100) string.
A DOI over 255 characters is refused instead, because a cut DOI names a different paper.
D1 statements over about 100 KB break backup restore, and these bounds stay far below that.

**Where it is stored**

- A column, because the verdict is an LLM judgment made by an external pipeline and nothing in this database can recompute it.
  ADR 0034 spends columns only on facts that cannot be derived at read time, and this is one.
- Not `enrichment_json`: every enrichment run rewrites it wholesale, and it is committed to the dataset repo as `.nemar/metadata.json`, which is nemar-citations' own input.
- Not `sweep_stamps`: that JSON is bookkeeping about when sweeps ran (ADR 0035), and the detail route hides it by design.
- Not a side table: ADR 0034 rejects side tables for catalog facts.

**Anonymous deposits serve the field like any other dataset.**
The owner decided this on 2026-09-30.
ADR 0065 has `enrich-dataset.ts` strip related identifiers from `.nemar/metadata.json` for an anonymous deposit,
because they point at the submitting group's own preprint, and a data paper can point at the depositing group in the same way.
Nothing here blinds it.
If that decision changes, the writer must skip anonymous rows and `markAnonymous` must null the column,
because ADR 0065's rule is to withhold at the writer and not to filter on read.

**Both assemblers read the column.**
`routes/data.ts` (`metadata.json`) and `services/page-bundle.ts` each carry their own `SELECT` and feed the same builder, so both select it.
The raw column is withheld from the catalog detail route's `SELECT d.*`, as `sweep_stamps` is.

**The cron runs on the dev worker too,** like the counts sync.
It only reads a public manifest and writes this environment's own D1, so it cannot email a user, dispatch GitHub work against `nemarDatasets`, or mutate a DOI or a prod-bucket object.
It is named in `DEV_CRON_ALLOWLIST` so that decision is greppable.

## Consequences

- **One document now carries two statements about the data paper.**
  `related_identifiers[].relation_type` comes from the enrichment, guarded by ADR 0075.
  `data_papers` comes from the judge.
  Nothing reconciles them, and they can disagree, for example when the judge confirms a paper the enrichment left as `References`.
  `data_papers` is the judge-confirmed one, and readers should trust it for "data paper".
- **The key and the citation counts agree by construction,** because both come from one gate.
  A dataset gains its `data_papers` only once the judge has run on it.
- **Lag is structural.**
  The manifest updates after the nightly hallu run merges and deploys the dashboard.
  This worker pulls at 03:00 UTC (04:00 on dev), so `metadata.json` trails a run by about 15 to 17 hours.
  `page-bundle.json` can trail longer because of its stale-while-revalidate window.
- **DOIs are served as the producer emits them,** in lowercase canonical form.
  Consumers must compare them case-insensitively.
  Consumers must also escape a DOI when rendering it, because the accepted pattern (`10.<registrant>/<non-whitespace>`) admits characters such as `<` and `>`.
- **There is no freshness guard.**
  `last_updated` is ignored, so a rolled-back dashboard deploy overwrites newer verdicts with older ones.
  This is accepted and worth revisiting if it happens.
- **`datasets` goes from 83 to 84 columns** against a ceiling of 97; thirteen remain.
- **A dataset whose manifest row disappears keeps its last stored value.**
  Only a present-but-unstorable row clears it.
- **The shape is a contract with nemar-citations.**
  A change to `data-papers@1` is a change to `data-papers-sync.ts`, and a manifest with an unknown schema id is never partially applied.
- **The vendored neuroschema bundle and `NEUROSCHEMA_VERSION` must move to the release that declares `data_papers` (0.4.1) before the key is schema-valid.**
  Until then the served document carries an undeclared key, as it already does for `anonymous`.
- **`citation-counts-sync.ts` has the same unbounded-body gap this ADR closes here.**
  It reads the whole response with no size limit, and a separate issue tracks it.

## Alternatives considered

- **Push from hallu to a Worker route.**
  Updates sooner, but the citations host would need a credential (the shared webhook token or an admin API key), this repository would need a new route and its inventory test, and the pushed data could drift from what the dashboard counts.
- **Derive it from the enrichment's `IsDescribedBy`.**
  Simple and local, but `IsDescribedBy` is a hint, so the key could name a paper the dashboard does not count, or omit one it does.
- **Overwrite the relation labels with the judge's verdict.**
  ADR 0075 rejected letting the citation pipeline alone decide relation labels, since the DataCite record and other consumers read them.
- **Store it in `enrichment_json`.**
  Rewritten wholesale by every enrichment run and committed to the public dataset repo, which is nemar-citations' own input.
- **A key in `sweep_stamps`.**
  Saves the column, but that JSON is bookkeeping about when sweeps ran (ADR 0035) and is hidden from the detail route by design.
- **A side table.**
  ADR 0034 rejects it for catalog facts, and it adds another FK child to rebuild around.
- **Clear nothing on a bad row, keep the old list.**
  Simpler, but a stale list keeps asserting a claim the producer no longer backs, so a bad row fails closed instead.

## Receipts

- Design and the agreed decisions: nemarOrg/nemar-citations#250.
- ADR 0034 (the column budget and its derivability test), ADR 0035 (sweep stamps are bookkeeping), ADR 0036 (bounded operational rows), ADR 0065 (identity is withheld by the writer).
- ADR 0075 (standards papers are never a data paper; the judge backs citation counts and decides `IsSupplementTo`; letting the citation pipeline alone decide relation labels was rejected there, and this ADR extends the judge to a separate key instead).
- Precedent for the pull: `backend/src/services/citation-counts-sync.ts` (#804).
