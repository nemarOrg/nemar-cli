# ADR 0064: A dataset missing more than a tenth of its DATA is withdrawn, and the denominator is data only

**Status:** accepted
**Date:** 2026-09-15
**Owner:** Seyed Yahya Shirazi

Partially supersedes [ADR 0005](0005-availability-is-reported-never-a-precondition-for-serving.md),
which decided that availability is reported and never a precondition for serving. That
still governs HOW a listed dataset delivers: it omits what is missing and never fakes
it. What it no longer does is make serving unconditional. This ADR sets the ceiling 0005
deliberately did not have, and supersedes its ~90%-absent build floor for the serving
question.

## Context

The #1396 sweep measured every one of the 600 imported datasets against both routes
OpenNeuro publishes. After recovering everything recoverable, 17 datasets still hold
content NEMAR cannot serve, and the spread is wide: `on004624` is missing 1 file of
65,063, while `on008730` is missing 935 of 936.

ADR 0005's only magnitude rule is a ~90% absent floor, and it is about whether an
ARCHIVE BUILD fails rather than whether a dataset is served. Nothing in the fleet
reaches it. So a dataset missing a quarter of its recordings was listed, described,
and given a DOI exactly like a complete one, with the shortfall visible only in
`data_complete` and the per-dataset availability report.

**Measuring against `total_files` hid how bad this was.** Metadata is never annexed
(ADR 0015): `.tsv`, `.json`, `README*` and the rest stay in plain git and arrive from
GitHub whether or not a single recording survived. So the metadata is always ~100%
present and dilutes the ratio. `on008017` is missing 4.7% of its tracked files and
**21.6% of its data**. `on004917` is 11.8% against 25.4%. A threshold on all files
would have cleared both. Without the recordings the metadata describes nothing a
reader can analyze, so it must not count toward completeness.

## Decision

**NEMAR lists a dataset only when at least 90% of its DATA files are available.**
Below that, it is withdrawn from the catalog until the content can be served: withdrawal
is `nemar admin withdraw`, which makes the repository private and tombstones the DOIs,
reversed by `restore` the day the data is fetchable again.

**The threshold applies only after recovery has been attempted and has reported what it
cannot get.** Withdrawal is the answer to content that is gone, never to content nobody
has fetched yet, and the difference is not visible without trying.

**Crossing the threshold opens a notice period, it does not withdraw on the spot.** Where
the gap is an upstream defect, the source is told what is missing, what we measured, and
the date the dataset comes down, and withdrawal follows only if the content is still
unfetchable then. A defect an archive can fix in an afternoon should not cost a dataset
its DOI, and most of what #1396 found is that shape: a stale version id, an untagged
object, an export that stopped partway. For this first cohort the date is **15 October
2026**, set in the report sent to OpenNeuro on 2026-09-15.

The notice period is not open-ended and not renegotiated per dataset. If the date passes
with the data still unavailable, the dataset is withdrawn; if it is fixed, the gap closes
and the question does not arise. A dataset whose gap is NOT upstream's -- our own failed
transfer -- gets no notice period, because there is nobody to notify: recover it.

The denominator is data only and never `total_files`: the DISTINCT git-annex keys the
tree names, which is what `git annex find --include '*' --format=${key}` answers and what
the registration scan already computes. The numerator is those keys with no object in
`s3://nemar` at their declared size, the same `isKeyPresentAtDeclaredSize` test the
registration sweep uses, so a zero-byte leftover counts as missing rather than present
(#967).

Keys rather than tree entries, and the two differ: two identical files share one key, so
a key count is slightly below a `120000` entry count (936 entries against 935 keys in
`on008730`). Keys are chosen because both halves of the ratio then measure the same
thing, and because a key is the unit that is fetchable or not. Where a dataset is near
the threshold the distinction is worth checking by hand rather than arguing about in the
abstract.

Below the threshold, ADR 0005 is unchanged: the dataset is listed, serves what it has,
omits what it does not, and advertises nothing it cannot deliver.

## What recovering the content took, and why the threshold comes after it

The threshold is only defensible because the missing content was chased first. Recording
what that took, so nobody reads a withdrawal as a first response:

- **Recovery copies server-side, S3 to S3.** `CopyObject` with `--copy-source` naming an
  object in OpenNeuro's bucket, so bytes never cross the operator's machine: measured at
  30 MiB/s into the bucket while the laptop moved 0.07 MiB/s. That is what made 623 GiB
  feasible at all.
- **A copy is proven, never assumed.** S3 is asked for the SHA-256 of what it wrote and
  it is compared to the annex key; MD5E keys verify by ETag on a single-part copy; above
  CopyObject's 5 GB limit, where no SHA-256 is available, the copy is matched against the
  source's full-object CRC64. A copy that fails verification is deleted rather than left
  looking like content (ADR 0063).
- **What it recovered:** 2,740 keys and about 105 GiB in the first wave, then `on003645`
  619 keys / 51.7 GiB, `on007721` 129 / 22 GiB, `on007816` 424 / 85 GiB, `on007987`
  516 / 38.2 GiB, `on003104` 260, `on005127` 61, `on008003` 2 / 10.7 GiB, `on004148` 1.
  Three datasets that would have been withdrawn on the previous day's numbers came back
  whole.
- **Five separate defects in our own tooling had to be fixed before the measurement could
  be trusted**, each of which had made content look unrecoverable when it was not: a
  double-encoded copy source (`%2520` for a space), no fallback when a recorded version
  was refused, a dry run that reported `would-recover` without probing, a `.log.rmet`
  retraction read as part of the version id, and a base64-encoded pin (any path with a
  space) read as having no pin at all. The last one alone was hiding 3,186 pins across
  two datasets and 11.5 GB of readable content.
- **What remains unrecoverable is upstream's, and was verified as such**: every key was
  tried against both routes OpenNeuro publishes, and the objects are either `403` to
  every anonymous caller, absent from the version list with no delete marker, or readable
  and hashing to something other than the key. 10,217 keys across 18 datasets reach a
  reader by neither route.

Only then does the ratio mean anything. A dataset below 90% after all of that is missing
data nobody can supply, which is what withdrawal is for.

## Consequences

- 11 datasets fall below 90% on measurement day. 5 are public and are on notice rather
  than already down (`on006159` 36.6% of its data missing, `on004917` 25.4%,
  `on004475` 18.4%, `on005571` 18.3%, `on003574` 12.2%); the other 6 are already
  private. Nothing was tombstoned on measurement day: every one of these gaps is an
  upstream export defect, so they go into the 15 October notice.
- The notice period costs something real and it is accepted: until the date passes, five
  datasets stay listed while missing more data than the policy allows. The alternative is
  tombstoning a DOI over a defect the source can clear in a day, which is worse for a
  reader who would rather cite a dataset that gets fixed than chase a tombstone.
- The threshold is deliberately stringent. At 20% the count is 7 and at 50% it is 3,
  and `on008017` at 21.6% or `on003574` at 12.2% are datasets a reader would
  reasonably call broken. A stricter rule withdraws more, and that is the intent:
  NEMAR serves what can be fetched.
- **A withdrawal is not a verdict on the submitter.** These gaps are upstream export
  defects, so the dataset page must say the content is unavailable at source and point
  there, not imply the deposit was bad.
- `on004212` at 28.2% loses its raw recordings to a derivatives gap: 7,495 of the
  missing files are `derivatives/meg_paper/.../permutations/`, and the raw data is
  intact. Withdrawing it denies a reader working recordings over missing permutation
  files. This is the sharpest cost of a flat ratio and is accepted rather than solved:
  a raw-versus-derivatives weighting is a second rule to argue about, and the simple
  one is auditable today. Revisit if the fleet grows more datasets of this shape.
- Withdrawal must be measured from a rescan, never from a stale column. `data_complete`
  is a sweep artifact and a recovery can make a dataset whole minutes later; the three
  datasets recovered this session (`on003645`, `on003104`, `on005127`) would each have
  been tombstoned on yesterday's numbers.
- Retracting a false presence claim (#967) and withdrawing are different repairs and
  both apply: the four anatomical datasets had their claims retracted first, so the
  location log is honest, and are withdrawn second, because honest is not the same as
  servable.

## Alternatives considered

- **Keep ADR 0005 as-is, report and serve everything:** consistent, and it is what
  shipped. Rejected because a DOI on a dataset missing a quarter of its recordings is
  a citation pointing at data nobody can obtain.
- **Threshold on `total_files`:** the obvious reading of "10% missing", and wrong.
  Metadata always arrives, so the ratio understates the loss and lets a dataset
  missing a fifth of its recordings pass.
- **20% or 50%:** measured at both. 50% keeps only the three datasets that are almost
  entirely gone, which does not describe the harm. Rejected as too permissive.
- **Weight raw above derivatives:** better for `on004212` and one more rule to
  maintain and argue. Not taken now; named above as the known cost.

## Receipts

- #1396; the two-route measurement of all 600 imported datasets, 2026-09-15
- ADR 0005 (narrowed here), ADR 0015 (why the denominator is data only)
- Per-dataset ratios in the #1396 PR description
