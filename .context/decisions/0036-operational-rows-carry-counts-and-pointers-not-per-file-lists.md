# ADR 0036: Operational rows carry counts and pointers, not per-file lists

**Status:** accepted
**Date:** 2026-09-02
**Owner:** Seyed Yahya Shirazi

## Context

The hourly production D1 backup could not be restored (#1188):
`restore-remote.sh` aborted with `SQLITE_TOOBIG` on 15 single-row INSERT
statements over D1's ~100 KB statement limit.
Every offender was a row column that inlined an unbounded per-file list,
so row size scaled with a dataset's file count:
`audit_log.details` on forced import verifications inlined the full
`missingKeys`/`zeroByteKeys` arrays (largest: 12,397 annex keys, 1.15 MB,
~88% of the entire audit log),
and `datasets.zarr_data_failures` inlined the per-recording conversion
failure array (largest: 877 entries, 178 KB;
~29% of all `datasets` data).
In both cases the inlined detail duplicated a richer artifact that already
existed outside D1:
`.nemar/availability-report.json` on the dataset repo
(path-keyed with a per-entry reason, versioned in git)
and the published Zarr index's `failures` list
(`<dataset>/zarr/index.json` in the serving bucket).

## Decision

A row in an operational table (audit log, catalog bookkeeping) carries
**flags, counts, and a pointer** —
booleans and totals that answer "how many" and "did it complete",
plus a `detail_ref` naming the artifact that owns the per-file detail.
The detail itself is never inlined, and never merely truncated:
a truncated list is still the wrong data in the wrong place,
and silently discards everything past the cut.

Concretely (#1189):
integrity audit writes store `integrityAuditSummary()`
(services/import-integrity.ts) instead of the raw result;
`zarr_data_failures` stores `{count, detail_ref}`;
migration 0074 rewrote the pre-existing rows into the same summaries,
deriving the counts from the arrays it dropped;
and `auditLogParams` (db/audit-log.ts) bounds every `details` payload at
`AUDIT_DETAILS_MAX_BYTES`,
replacing an oversized one with a truncation marker,
so the next unbounded payload shape cannot recreate the failure.

## Consequences

- Row size — and therefore backup-statement size — is independent of how
  many files a dataset has, which is exactly the condition that makes a
  restore work (a restore is only as good as its largest statement).
- Answering "which files" requires following the pointer to the owning
  artifact rather than querying D1.
  That artifact is richer than the dropped copy was,
  but it is a second hop, and for the availability report it requires repo
  access.
- Compacted historical rows carry `compacted_by: "migration_0074"`;
  their per-key lists are gone from D1.
  The counts survive, and the reports/indexes hold the current detail —
  though not the historical per-run snapshots the audit rows once froze.
- Any new column or audit payload that wants to store a per-item list must
  instead store counts plus a pointer,
  or argue its way past the write-time bound in an ADR superseding this one.
- Hand-rolled `INSERT INTO audit_log` call sites predating #903 bypass the
  bound until they converge on `auditLogStatement`;
  the two import services were converged in #1189,
  the rest write small fixed-shape payloads today.

## Alternatives considered

- **Truncate the arrays to N entries:** keeps wrong data in the wrong
  place, silently discards entries N+1 onward, and leaves row size coupled
  to a cap instead of to the row's actual job. Rejected by design review.
- **Fix it in the backup format** (bound statements, chunked UPDATEs,
  parameterized loads): treats the symptom; every D1 reader and the
  dashboard still pays for megabyte rows, and the duplicate detail still
  drifts from the owning artifact. Kept only as a defense-in-depth idea for
  the backup repo.
- **A separate detail table:** normalizes the duplicate instead of removing
  it; the artifact outside D1 remains the source of truth, so D1 would hold
  a second copy either way.

## Receipts

- #1188 — the restore failure and its statement-size measurements.
- #1189 — the fix: summaries, write-time bound, migration 0074.
- ADR 0004 — the backup this exists to keep restorable.
- ADR 0034 — the same instinct applied to column count rather than row size.
