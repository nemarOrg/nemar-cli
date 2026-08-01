# ADR 0003: `datasets` is the single table of record; FTS5 for lexical, id-only Vectorize

**Status:** accepted
**Date:** 2026-05 (backfilled 2026-07-31)
**Owner:** Seyed Yahya Shirazi

## Context

Dataset facts lived in two tables (`datasets` and `nemar_catalog`) with three competing writers, plus a Vectorize index that carried copies of those facts in its metadata. Every fact therefore had two or three homes that could disagree, and search results could show values that no longer matched the row.

## Decision

Collapse everything into `datasets` as the sole source of truth per fact, including legacy catalog-only rows (folded in under a sentinel system owner so the `NOT NULL` owner FK stays intact). Lexical search becomes an FTS5 external-content index kept in sync by `AFTER` triggers inside the same D1 write transaction. Vectorize stores **only the vector id**; every hit is hydrated from the live row at query time. `nemar_catalog` is dropped.

## Consequences

- Drift becomes structurally impossible rather than merely policed: one table, one writer per domain, an index that updates in the same transaction, and a vector store carrying zero facts.
- Search costs an extra D1 read per result set to hydrate. Accepted deliberately in exchange for never serving a stale fact.
- **`wrangler d1 export` refuses any database containing an fts5 virtual table.** This is a permanent operational tax: the backup path must export table-by-table and recreate the index from `sqlite_master` on restore. See ADR 0004.
- Re-embedding needs its own dirty-tracking (`embedding_dirty`) since the vector no longer carries the text it was built from.

## Alternatives considered

- **Keep two tables with a policed invariant:** retains a permanent inter-table invariant plus a hand-maintained `search_text` column that reviewers judged unnecessary. Rejected.
- **Keep `nemar_catalog` as a 4-hour eventually-consistent projection:** relocates drift rather than eliminating it, and was premised on the incorrect claim that D1 lacks FTS5. Rejected on the facts.

## Receipts

- `.context/research-catalog-consolidation.md`
- `.context/blast-radius-catalog-fold.md`
- #646, #665; migrations 0029-0033
