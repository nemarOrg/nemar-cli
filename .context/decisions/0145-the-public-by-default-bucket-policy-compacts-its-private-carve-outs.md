# ADR 0145: The public-by-default bucket policy compacts its private carve-outs

**Status:** accepted
**Date:** 2026-11-27
**Accepted:** 2026-11-27
**Owner:** Seyed Yahya Shirazi

Records the deny-list bucket policy, which had no ADR of its own (it was decided in #673 and lives in `backend/src/services/bucket-policy.ts`), and the compaction that keeps it under the cap.
Production incident nemarOrg/nemar-cli#2497.

## Context

The S3 bucket `nemar` is public by default.
One statement, `PublicReadExceptPrivate`, allows anonymous `s3:GetObject` on everything except its `NotResource` list: `staging/*` and one `arn:aws:s3:::nemar/<id>/*` entry per private dataset.
`NotResource` rather than an explicit `Deny`, because a `Deny` with `Principal: *` would also override the backend's and each user's own signed reads.
The list was expected to stay small, since datasets are private only until publication.
It did not: measured read-only on 2026-11-27, the list held 628 entries (627 ids and `staging`), and the policy was 20,431 bytes against AWS's 20,480-byte cap (`MAX_BUCKET_POLICY_BYTES`).
Every new dataset then failed its carve-out at creation, after its id had been claimed and its GitHub repository created, leaving an empty D1 row and an empty repository behind.
45 decades of ids (for example `nm000540` to `nm000549`) were entirely private.

## Decision

The carve-out list is written in a canonical compacted form, computed from the set of private ids on every write:

1. When all ten ids of a decade are private, one entry `arn:aws:s3:::<bucket>/<id minus its last digit>?/*` replaces them (an S3 ARN `?` matches exactly one character).
   When all ten decades of a hundred are covered, one entry `.../<id minus its last two digits>??/*` replaces them.
   A wildcard is never written over an id that is not itself private, and never with `*` inside the id.
   Only ids of the allocator's shape (two lowercase letters and six digits) are grouped.
2. Reading expands both forms back into the id set, so `listPrivateDatasets`, `isDatasetPrivate` and `derivePublicPrefixes`, through which every reader in this repository goes (`hasPublicRead`, the visibility transitions, the migration script), see a covered id as private.
   Removing one id of a covered decade expands the wildcard, drops that id, and recompacts, so the other nine stay private.
   Removal can therefore grow the policy: publishing one id of a covered decade adds 8 entries, and of a covered hundred up to about 17 (nine decade wildcards and nine explicit ids replace one entry).
   Every transition prices the policy it would write before writing it; one that would exceed the cap fails with an error naming the cause and sends the full alert.
   `staging` and any entry this module does not write are kept verbatim; a rewrite never widens public access.
3. The create route checks headroom before claiming an id: if one more explicit entry on top of the compacted policy would exceed the cap, it refuses with 503 and creates nothing.
   The check is advisory: a policy that cannot be read lets the create go on, because the carve-out write fails closed and rolls back.
   If the carve-out, the owner's S3 permission, the upload URLs or the final row update fail after the repository exists, the create is rolled back: the permission is removed, the repository deleted (the same `deleteRepository` and `getDatasetsToken` the admin dataset delete uses), then the claimed row; no upload URL is issued.
   If the repository cannot be deleted, the row is kept with the repository's name, logged as `[datasets:rollback-incomplete]`, and the admins are mailed.
   A creation rolled back after its carve-out landed leaves that carve-out behind: harmless (it keeps an empty prefix private), but it costs one entry until cleaned, and the dataset deletion path (`services/deletion.ts`) removes such a carve-out.
4. A policy write above 80% of the cap logs `[bucket-policy:near-cap]`; a refused create or transition logs `[bucket-policy:full]`.
   Both are also mailed to the admins (production only, under their own `storage_alerts` category, on by default), at most once a day per condition, stamped in `audit_log` (action `storage_policy_alert`); above 95% the near-cap alert escalates under its own stamp, so 80% and 95% each mail once a day.
   A stamp whose mail reached nobody is released, so the next occurrence tries again.

## Consequences

The measured list compacts from 628 entries to 223 (45 decade wildcards, no hundred), and its statement from 20,240 to 7,280 bytes; the first write after deploy compacts it.
Capacity: each explicit entry costs about 31 bytes, so the cap holds about 630 explicit entries.
After compaction the list is 223 entries, so about 400 more explicit entries fit; each full decade frees nine.
This buys time, not a fix: the policy still grows with the private set, and private datasets accumulate (deposits that never publish, anonymous deposits, held datasets).
A lasting design is still owed: for example a separate private prefix (`private/<id>/` objects moved on publication), object tags with a tag-conditioned policy, or an access point per visibility.
Each changes the object layout or the IAM model and needs its own ADR.

## Alternatives considered

- **Compact to thousands (`???`) or with `*`:** a `*` inside the id would match ids of other lengths and is never safe; a thousand wildcard would be safe under the same all-private rule, but no hundred is even fully private today, so it would only add a reading path.
- **Make published datasets' carve-outs public faster, or clean orphans:** necessary hygiene, but does not bound the policy.
- **Return to an allow-list:** it hit the same cap at about 149 public datasets (#673).

## Receipts

- nemarOrg/nemar-cli#2497 (incident, measured numbers).
- #673 (the allow-list hit the cap; the deny-list model replaced it).
- `backend/test/fixtures/bucket-policy/carveout-2026-11-27.txt`: the measured list, used by `backend/test/bucket-policy.test.ts`.
