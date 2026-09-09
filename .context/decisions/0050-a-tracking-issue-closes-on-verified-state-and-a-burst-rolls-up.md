# ADR 0050: A tracking issue closes on verified state, and a burst rolls up

**Status:** accepted
**Date:** 2026-09-09
**Owner:** Seyed Yahya Shirazi

## Context

`nemarDatasets/.github` held **29 open import-failure issues and zero closed ones** as of
2026-09-09, the day this was written. Nothing ever closed one: `import-failure-issue.ts` said
so in its own header, leaving it to a human. No human did, for seven weeks.

That count is stated here once, with its date, and deliberately not restated in the code: it
changes daily, and a number copied into eleven comments is a number that will be wrong in ten
of them.

A tracker that only accumulates cannot distinguish a live problem from one that healed weeks
ago. At least four of those 29 had already recovered when this was written -- `on003104`,
`on005691`, `on006136` and `on006159` all resolve at `api.nemar.org` today -- so roughly a
seventh of the tracker was already stale, and no reader could tell which seventh without
checking each dataset by hand. That is a large part of why the outage in ADR 0049 went
unnoticed: the signal was buried in noise that never drained.

The other half of the problem is the arrival pattern. Import failures come in **bursts, not
singly**: 15 issues opened on 2026-07-22 inside a three-minute window (#68-#82), and 6 more
on 2026-09-08, the day auto-import was re-enabled by #1308. (#83 in that range is a pull
request, not an issue, which is where an earlier count of 14 came from.) A systemic cause -- one expired PAT, one branch-protection ruleset -- hits every
dataset in the matrix at once. Per-dataset filing turns one cause into dozens of
near-identical issues in a repo that also carries dataset CI for ~785 repos.

Three properties of the only verification primitive available shape the close rule.
`verifyDatasetVersionS3` (`import-integrity.ts`) checks every annex-keyed file in the
published version manifest for presence in S3 at its declared size. It returns
`version: null` when no manifest could be resolved at all, and it compares sizes, never
checksums. It also reports `complete: true` when it compared **nothing**: `complete` is
`missingKeys.length === 0` over the manifest's annex-keyed entries, so a manifest with none of
them yields a pass over an empty set.

## Decision

**An issue closes only on verified S3 state, never on a status column.** The gate is
`complete === true && version !== null`, evaluated against a fresh `verifyDatasetVersionS3`
call. `datasets.data_complete` is a cached verdict and may be stale, so it is at most a
pre-filter, never the gate.

Four refusals are part of the decision, not implementation detail:

- **`version === null` is "unknown", not "incomplete".** No manifest resolved means there is
  nothing to compare against. Reading that as clean would close issues for datasets that never
  published, which is the one mistake here that silently discards a live problem.
- **An empty comparison is not a passing one.** `expectedCount === 0` keeps the issue. Nothing
  was checked, so "verified complete (0/0)" would be a recovery claim over an empty set -- the
  same class of hole as the null manifest, one level down.
- **A transient error keeps the issue.** Fail open on the row, as `zarr-fidelity-sweep` does: a
  GitHub, S3 or D1 error aborts that one issue, lands in the run's `errors`, and leaves it a
  candidate next run. A DECIDING failure leaves the issue byte-for-byte as it was, because
  nothing has been written. An ACTING failure cannot promise that, which is why the write order
  is part of this decision (below).
- **A human-authored issue is never touched.** The machine-filed signature is an exact
  `importFailureIssueTitle` match *plus* the `import-failure` label. Anything else is somebody's
  hand-written record.

The close comment says "present at declared size" and states explicitly that this is
size-level, not checksum-level, verification. Overstating the guarantee would be worse than
not closing.

**The state change goes first, then the comment explaining it.** The two writes are not a
transaction, and commenting first -- so that no issue is ever closed without its record -- puts
the failure in the worse place: a comment that lands ahead of a close that 403s leaves an OPEN
issue asserting "Recovered: closing automatically", and because the verdict is recomputed from
unchanged world state, it re-comments every daily run. Both mutations are idempotent and
self-healing in the other order (a closed issue leaves the candidate set; a correct label makes
`computeLabelUpdate` return null), so the worst case becomes one missing explanation instead of
an unbounded stream of false ones. A comment that fails after its mutation landed is reported
as a `comment`-stage error, and the action still counts, because it happened.

**On an applied run, a count means it happened.** `closed` / `relabelled` are incremented after
the write lands, never from the plan; on a dry run they are "would" counts, and `applied` is what
distinguishes the two readings. Counting from the plan reported `closed: 15, errors: 15` for a run
that closed nothing.

**Total failure has two denominators, because there are two halves that fail wholesale.** Every
WRITE failing is measured over attempts: over `examined` -- which counts keeps, and a keep cannot
fail -- the realistic write outage answered HTTP 200 with ten keeps and five failed writes.
Nothing being JUDGED is measured over decision failures alone, and is the only total failure a dry
run can have. Keeping them separate matters: folding decision failures into the write denominator
made every dry run with a single transient S3 error a 502 that discarded the rest of the plan,
because a dry run attempts no writes at all, so failures and attempts were the same set.

**Closing is a sweep, not a webhook hook.** A recovery does not necessarily pass through
`POST /webhooks/import-state` at all -- a manual `nemar admin recover`, an operator's forced
verify, and every one of the pre-existing issues would be missed by a `complete` hook.

**Past a cap, a burst joins one rollup issue per cause.** Two thresholds, not one:

```
CAP    = 10   // at or above this many open per-dataset issues, roll up
RESUME =  5   // at or below this many, per-dataset filing resumes
```

The rule is `>= CAP` to latch and `<= RESUME` to release, so the band in which nothing changes
is **6 to 9**: at 10 with no rollup the mode latches, and at 5 with one open it releases. That
band is the whole point, and **the mode carries no new D1 state**: it is a function of the
world, because a rollup issue for a cause is either open on GitHub or it is not. A stored flag
could drift out of sync with the tracker it describes; an observation cannot.

**An observation that nothing clears is a latch, so the sweep closes the rollup.** This is
the half that makes the two thresholds real. With no writer for `rollupOpen`, a cause that
crossed the cap once stays rolled up forever and the rule degenerates to "roll up above 5" --
the advertised cap of 10 would hold only before the first burst, and releasing at 5 while
re-latching at 6 is one threshold, not two. So when `decideIssueMode` returns `per-dataset`
with a rollup open, the sweep closes it, with a comment stating that this releases the mode
and is **not** a verdict on the datasets listed in it. Closing a GitHub issue does not delete
it, so the records survive, and any listed dataset that fails again opens its own issue.

The mode the sweep REPORTS is aggregate across causes, while the filer decides per cause
(`rollupOpen` there is that one cause's rollup). Inside the band a cause with no rollup of its
own therefore still files per-dataset while the sweep reports `rollup`. That is a pressure
reading for an operator, not a prediction of the next filing.

**The rollup is a pressure valve, not the normal mode.** Below the cap, per-dataset issues
stay the default: they are greppable, they carry per-dataset history, and they are what the
triage procedure is written against. A rollup's body is written once, at creation, and never
rewritten -- later datasets join as comments -- so it states no running total.

**A re-failure whose cause changed is relabelled, from the STORED error.** The cause is
classified from `import_jobs.last_error` after the upsert, never from the raw incoming callback
message. The callback route already refuses to let a GENERIC message overwrite a SPECIFIC
stored one (ADR 0049's rule, enforced in SQL); classifying the label from the incoming value
applied that rule to D1 and ignored it for the issue, so the `report` job's
`terminal: prepare=failure ...` summary classified as UNKNOWN and stripped a correct cause
label back to `needs-triage` -- silently, and in a two-writer fight with this sweep, which
reads the protected column. One column, one classification, both writers agree.

The label set is recomputed rather than appended to, so a stale cause is retired instead of an issue sitting filed as something it no
longer is. Only labels this module owns -- the declared cause labels plus the legacy
`upstream-403` spelling -- are replaceable; every other label, notably the human-applied
`no-import-row`, survives.

## Consequences

Easier: the open-issue count becomes a real measure of what is broken now, so a burst is
visible as a burst rather than as tracker growth. Triage stops re-checking datasets that
healed. A cause change is visible in the label, so `label:auth-invalid` means what it says.
The sweep doubles as an integrity audit, since it verifies against S3 on the way.

Harder: closing is up to a day late, because it rides the daily cron rather than the
recovery itself. Immaterial for a tracker, and the deliberate price of covering the recovery
paths a webhook cannot see. A rollup loses per-dataset issue history for the datasets in it,
which is why the cap is set where it is rather than at 3.

Bounded by design: `verifyDatasetVersionS3` is one fully-paginated `listObjectSizes` walk per
dataset, i.e. O(pages) Worker subrequests, so the sweep processes 15 issues per run (max 30),
matching `data-integrity-sweep`.

**A bounded window does not drain a backlog by itself, so the window rotates by the calendar
day.** Only a close removes a candidate, so taking the first `limit` off a fresh listing
re-examines the same slice every run. Candidates are sorted oldest-first, so with 29 open and a
limit of 15 it is the 14 NEWEST that would never be examined again -- and a fresh failure files
at the tail, so those are the ones most likely to still be actionable. A stored cursor is the
obvious fix and the wrong one (ADR 0034: derive rather than store; a cursor is a second source of
truth against a list this sweep does not own). The day is already a monotonic counter both
callers share, and the cron runs daily, so the window advances by `limit` per day:
`start_{d+1} = (start_d + limit) mod count`, which tiles contiguously and reaches everything
within `ceil(count / limit)` days.

That bound assumes a stable `count`, and `count` is the modulus, so it is approximate rather
than guaranteed: closes shrink the candidate list and new failures grow it, which means two runs
on the same calendar day over a changed backlog get different windows. **The property bought is
that no candidate is permanently excluded**, which is what a fixed prefix got wrong. An exact
schedule is not available without the cursor this deliberately avoids, and is not worth one.

**Production-only, and not on the dev-cron allowlist.** The tracker is ONE repo shared between
production and dev -- `IMPORT_FAILURE_ISSUES_REPO` is hardcoded, not environment-scoped -- so a
non-production apply writes to the production tracker. Two independent fences, because a
`TEST_ADMIN_API_KEY` reaches the route: `runImportIssueSweepCron` carries an `isNonProductionEnv`
refusal in addition to the cron's prod-only branch, and the admin route refuses `apply` outside
production on its own. The DRY RUN stays available everywhere, since reading the production
tracker from staging is the point.

Whoever adds a new cause label must add it to `IMPORT_FAILURE_CAUSE_LABELS`, or the relabel
pass will not own it and will leave it in place alongside the new one.

## Alternatives considered

- **Close on `import_jobs.status = 'complete'`.** One D1 read instead of an S3 walk, and it is
  what a reader expects. Declined: the status column records what the pipeline *believes*, and
  the whole reason these issues exist is that the pipeline's own account of itself was wrong
  (ADR 0049). The issue's own triage doc already names verification, not status, as the
  authority for closing.
- **A single threshold instead of a band.** Simpler to explain, and wrong at the boundary: a
  tracker hovering at the threshold would fold failures into a rollup on one run and open
  per-dataset issues on the next.
- **Roll up always, one issue per cause.** Least noise, and loses the per-dataset history that
  makes an individual failure diagnosable. Bursts are the exception, so the exception is what
  should get the exceptional treatment.
- **Store the current mode in D1.** Would let the mode be set deliberately, and introduces a
  flag that can disagree with the tracker. `rollupOpen` is already observable at the moment the
  decision is made.
- **Hook the `complete` webhook callback.** Responsive, and structurally blind to every
  recovery that does not pass through it, including every pre-existing issue. It would also add
  GitHub I/O to a route already carrying two `waitUntil` calls.
- **Leave the rollup for a human to close.** Honest about a rollup covering datasets whose state
  is unknown, and it silently turns the cap into 5 forever, because `rollupOpen` is the
  hysteresis and nothing would clear it. Declined once it was clear the two cannot both hold.
- **Comment before the state change, so no issue closes without its record.** Reads better and
  fails worse: see the write-order paragraph above.

## Receipts

- Issue #1310 (phase 2 of epic #1306); the outage and the classifier are ADR 0049
- Rules: `backend/src/services/import-issue-accrual.ts` (pure), applied by
  `import-issue-sweep.ts` (close/relabel) and `import-failure-issue.ts` (file/roll up)
- Verification primitive: `verifyDatasetVersionS3`, `backend/src/services/import-integrity.ts`
- Fail-open-on-the-row precedent: `backend/src/services/zarr-fidelity-sweep.ts` (issue #1068)
- Batch bounds precedent: `data-integrity-sweep`, `routes/admin/datasets-lifecycle.ts`
- Rollup body shape: ADR 0036 (counts and pointers, not per-file lists)
- Operator entry point: `POST /admin/imports/issue-triage`,
  `nemar admin import-issue-triage` (dry run by default; `apply` production-only)
- The stored-vs-incoming error rule this reuses: `isGenericImportError` /
  `lastErrorAssignmentSql` in `backend/src/services/import-error.ts`, ADR 0049
- Derive-rather-than-store, the reason the rotation has no cursor: ADR 0034
