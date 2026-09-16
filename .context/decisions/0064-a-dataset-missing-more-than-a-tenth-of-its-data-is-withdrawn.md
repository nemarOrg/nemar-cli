# ADR 0064: A dataset missing more than a tenth of its DATA KEYS is withdrawn, and the denominator is data only

**Status:** accepted
**Date:** 2026-09-15
**Owner:** Seyed Yahya Shirazi

Partially supersedes [ADR 0005](0005-availability-is-reported-never-a-precondition-for-serving.md),
which decided that availability is reported and never a precondition for serving. That
still governs HOW a listed dataset delivers: it omits what is missing and never fakes
it. What it no longer does is make serving unconditional. This ADR sets the ceiling 0005
deliberately did not have.

0005's ~90%-absent ARCHIVE BUILD floor is untouched and still governs builds. It answers
whether a build that read essentially nothing is a failed read path; this ADR answers
whether a dataset is listed at all. Nothing in the fleet reaches the build floor, which is
why a separate rule was needed.

## Context

The #1396 sweep measured every one of the 600 imported datasets against both routes
OpenNeuro publishes. After recovering everything recoverable, 16 datasets still hold
content NEMAR cannot serve, and the spread is wide: `on004624` is missing a single key,
while `on008730` is missing 935 of its 935.

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

**NEMAR lists a dataset only when at least 90% of its DISTINCT ANNEXED DATA KEYS are
available.** "Files" is the wrong word for the rule and this ADR's own argument says why:
an entry count runs above a key count, so a file-based denominator understates the loss.
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

Keys, never tree entries, and the gap between them is not cosmetic. Two identical files
share one key, so an entry count runs above a key count: `on008730` has 936 entries over
935 keys, and `on004078` has 9,447 over 9,223. `on006159` is the case that moved a
verdict: re-measured against the live dataset, 222 of its 480 distinct keys have no
object, which is **46.25% of its data missing**. The first pass reported 36.6% because it
divided by a tree-entry count, and both halves of that ratio were wrong -- the numerator
counts entries too. Worse, a `120000` count misses annexed files entirely on an adjusted or unlocked
branch, where git-annex writes a `100644` pointer file whose content is the
`/annex/objects/...` path instead of a symlink; `on008465` is all pointer files and a
symlink count calls it 0 annexed files of 5,349. `git annex find` answers correctly for
both shapes, which is why it is the definition here.

**A shortfall files its own tracking issue.** The import publish gate refuses when the
bucket cannot back the keys a dataset's tree names, and it now emits a distinct marker,
`[nemar-data-unavailable]`, carrying the availability figure. The `nemarDatasets/.github`
classifier turns that into a `data-unavailable` label instead of the unlabeled
`needs-triage` a gate failure used to produce, so the issue is triaged by severity: one
key of 65,063 and 935 of 935 are the same sentence without the ratio. The marker claims
ONLY the shortfall, never that the content is gone at source -- that is the unmeasured
`upstream_403` filing this ADR exists to correct, and `nemar admin fleet content-recovery
<id>` is what turns it into a verdict.

At or above the threshold, ADR 0005 is unchanged: the dataset is listed, serves what it
has, omits what it does not, and advertises nothing it cannot deliver. Below it, and after
the notice period, the dataset is not listed at all, which is what this ADR adds.

## What recovering the content took, and why the threshold comes after it

The threshold is only defensible because the missing content was chased first. Recording
what that took, so nobody reads a withdrawal as a first response:

- **Recovery copies server-side, S3 to S3.** `CopyObject` with `--copy-source` naming an
  object in OpenNeuro's bucket, so bytes never cross the operator's machine: measured at
  30 MiB/s into the bucket while the laptop moved 0.07 MiB/s. That is what made ~620 GB
  feasible at all.
- **A copy is proven, never assumed.** S3 is asked for the SHA-256 of what it wrote and
  it is compared to the annex key; MD5E keys verify by ETag on a single-part copy; above
  CopyObject's 5 GB limit, where no SHA-256 is available, the copy is matched against the
  source's full-object CRC64. A copy that fails verification is deleted rather than left
  looking like content (ADR 0063).
- **What it recovered:** 2,740 keys and about 105 GiB in the first wave across the wider
  fleet, then, on the withdrawn cohort and the datasets the sweep flagged: `on008065`
  5,173 keys / 94.3 GiB, `on003645` 619 / 51.7 GiB, `on007987` 516 / 38.2 GiB, `on007816`
  424 / 85 GiB, `on003104` 260, `on007721` 129 / 22 GiB, `on005127` 61, `on005279` 30,
  `on008003` 2 / 10.7 GiB, `on004148` 1, `on005516` 1. Six of the eleven withdrawn
  datasets came back and were reinstated, and three more that would have been withdrawn
  on the previous day's numbers never had to be.
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
  and hashing to something other than the key. 10,217 keys across those 16 datasets
  reach a reader by neither route.

Only then does the ratio mean anything. A dataset below 90% after all of that is missing
data nobody can supply, which is what withdrawal is for.

## Consequences

- 14 datasets fall below 90% on measurement day. 5 are public and are on notice rather
  than already down (`on006159` 46.2% of its data missing, `on004917` 25.4%,
  `on004475` 18.4%, `on005571` 18.3%, `on003574` 12.2%); the other 9 are already
  private. Nothing was tombstoned on measurement day: every one of these gaps is an
  upstream export defect, so they go into the 15 October notice.
- **The first count of these was wrong, by the mistake this ADR exists to name.** A
  scratch script counted the denominator as `120000` tree entries, which misses the
  other shape git-annex uses: on an adjusted or unlocked branch an annexed file is a
  `100644` POINTER FILE whose content is the `/annex/objects/...` path. `on008465` is
  entirely pointer files, so it counted as 0 annexed files of 5,349 and dropped out of
  the ratio altogether when it is really 24 missing of 3,853. Symlink counts also
  over-count where files share content: `on006159` has 664 symlinks over 480 distinct
  keys, and re-measuring it by key gives 222 of 480, a 46.25% shortfall rather than the
  36.6% first reported. Count keys, the way `git annex find` does, and the two shapes
  stop mattering.
- The notice period costs something real and it is accepted: until the date passes, five
  datasets stay listed while missing more data than the policy allows. The alternative is
  tombstoning a DOI over a defect the source can clear in a day, which is worse for a
  reader who would rather cite a dataset that gets fixed than chase a tombstone.
- The threshold is deliberately stringent. At 20% missing the count is 10 and at 50% it
  is 6, and `on008017` at 21.6% or `on003574` at 12.2% are datasets a reader would
  reasonably call broken. A stricter rule withdraws more, and that is the intent:
  NEMAR serves what can be fetched.
- **A withdrawal is not a verdict on the submitter.** These gaps are upstream export
  defects, so the dataset page must say the content is unavailable at source and point
  there, not imply the deposit was bad.
- `on004212` at **39.0% of its data keys missing** (7,495 of 19,220) loses nothing a
  reader needs: every one of those keys is under
  `derivatives/meg_paper/.../permutations/`, and the raw recordings are intact.
  Withdrawing it denies a reader working recordings over missing permutation files.
  This is the sharpest cost of a flat ratio and is accepted rather than solved: a
  raw-versus-derivatives weighting is a second rule to argue about, and the simple one
  is auditable today. Revisit if the fleet grows more datasets of this shape.
  **This bullet first said 28.2%, and that number was this ADR's own mistake.** 28.2%
  is 7,503 of 26,620 TREE ENTRIES; the rule above is distinct annex keys, which is
  7,495 of 19,220. An entry count runs above a key count, so the entry basis reports a
  smaller shortfall and the dataset looks less damaged than it is. Corrected from a
  re-measurement on 2026-09-16 (`nemar admin fleet key-registration on004212`).
- Withdrawal must be measured from a rescan, never from a stale column. `data_complete`
  is a sweep artifact and a recovery can make a dataset whole minutes later; the three
  datasets recovered this session (`on003645`, `on003104`, `on005127`) would each have
  been tombstoned on yesterday's numbers.
- Retracting a false presence claim (#967) and withdrawing are different repairs, and
  the first does not imply the second. The claims on the anatomical datasets were
  retracted immediately -- 230 keys across `on003574`, `on004475`, `on004917`,
  `on005571` and `on005279` -- because a log that advertises content NEMAR does not
  hold is wrong today whatever happens in October. Withdrawal is the separate question,
  and for the five public datasets it waits for the notice period. Honest is not the
  same as servable, but it is owed sooner.

## Alternatives considered

- **Keep ADR 0005 as-is, report and serve everything:** consistent, and it is what
  shipped. Rejected because a DOI on a dataset missing a quarter of its recordings is
  a citation pointing at data nobody can obtain.
- **Threshold on `total_files`:** the obvious reading of "10% missing", and wrong.
  Metadata always arrives, so the ratio understates the loss and lets a dataset
  missing a fifth of its recordings pass.
- **20% or 50%:** measured at both. At 20% the count is 10 and at 50% it is 6, so a 50%
  rule keeps only the datasets that are almost entirely gone and lets `on004917` at
  25.4% stay listed. Rejected as too permissive.
- **Weight raw above derivatives:** better for `on004212` and one more rule to
  maintain and argue. Not taken now; named above as the known cost.

## Receipts

- #1396; the two-route measurement of all 600 imported datasets, 2026-09-15
- ADR 0005 (narrowed here), ADR 0015 (why the denominator is data only)
- Per-dataset ratios in the #1396 PR description
