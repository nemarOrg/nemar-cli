# ADR 0050: A tracking issue closes on verified state, and a burst rolls up

**Status:** accepted
**Date:** 2026-09-09
**Owner:** Seyed Yahya Shirazi

## Context

`nemarDatasets/.github` held **28 open import-failure issues and zero closed ones**. Nothing
ever closed one: `import-failure-issue.ts` said so in its own header, leaving it to a human.
No human did, for seven weeks.

A tracker that only accumulates cannot distinguish a live problem from one that healed weeks
ago. At least four of those 28 had already recovered when this was written -- `on003104`,
`on005691`, `on006136` and `on006159` all resolve at `api.nemar.org` today -- so roughly a
seventh of the tracker was already stale, and no reader could tell which seventh without
checking each dataset by hand. That is a large part of why the outage in ADR 0049 went
unnoticed: the signal was buried in noise that never drained.

The other half of the problem is the arrival pattern. Import failures come in **bursts, not
singly**: 14 issues opened on 2026-07-22, and 6 more on 2026-09-08, the day auto-import was
re-enabled. A systemic cause -- one expired PAT, one branch-protection ruleset -- hits every
dataset in the matrix at once. Per-dataset filing turns one cause into dozens of
near-identical issues in a repo that also carries dataset CI for ~785 repos.

Two properties of the only verification primitive available shape the close rule.
`verifyDatasetVersionS3` (`import-integrity.ts`) checks every annex-keyed file in the
published version manifest for presence in S3 at its declared size. It returns
`version: null` when no manifest could be resolved at all, and it compares sizes, never
checksums.

## Decision

**An issue closes only on verified S3 state, never on a status column.** The gate is
`complete === true && version !== null`, evaluated against a fresh `verifyDatasetVersionS3`
call. `datasets.data_complete` is a cached verdict and may be stale, so it is at most a
pre-filter, never the gate.

Three refusals are part of the decision, not implementation detail:

- **`version === null` is "unknown", not "incomplete".** No manifest resolved means there is
  nothing to compare against. Reading that as clean would close issues for datasets that never
  published, which is the one mistake here that silently discards a live problem.
- **A transient error keeps the issue.** Fail open on the row, as `zarr-fidelity-sweep` does:
  a GitHub, S3 or D1 error aborts that one issue, lands in the run's `errors`, leaves the issue
  exactly as it was, and leaves it a candidate next run.
- **A human-authored issue is never touched.** The machine-filed signature is an exact
  `importFailureIssueTitle` match *plus* the `import-failure` label. Anything else is somebody's
  hand-written record.

The close comment says "present at declared size" and states explicitly that this is
size-level, not checksum-level, verification. Overstating the guarantee would be worse than
not closing.

**Closing is a sweep, not a webhook hook.** A recovery does not necessarily pass through
`POST /webhooks/import-state` at all -- a manual `nemar admin recover`, an operator's forced
verify, and every one of the 28 pre-existing issues would be missed by a `complete` hook.

**Past a cap, a burst joins one rollup issue per cause.** Two thresholds, not one:

```
CAP    = 10   // at or above this many open per-dataset issues, roll up
RESUME =  5   // at or below this many, per-dataset filing resumes
```

Inside the 5-10 band nothing changes; whichever mode is in effect holds. That band is the
whole point, and **the mode carries no new D1 state**: it is a function of the world, because
a rollup issue for a cause is either open on GitHub or it is not. A stored flag could drift
out of sync with the tracker it describes; an observation cannot.

**The rollup is a pressure valve, not the normal mode.** Below the cap, per-dataset issues
stay the default: they are greppable, they carry per-dataset history, and they are what the
triage procedure is written against.

**A re-failure whose cause changed is relabelled.** The label set is recomputed rather than
appended to, so a stale cause is retired instead of an issue sitting filed as something it no
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
matching `data-integrity-sweep`. A 28-issue backlog therefore drains over two runs.

**Production-only, and not on the dev-cron allowlist.** The sweep writes to the shared
`nemarDatasets` org, so `runImportIssueSweepCron` carries its own `isNonProductionEnv` refusal
in addition to the cron's prod-only branch. The admin route stays callable on staging as a dry
run.

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
  recovery that does not pass through it, including all 28 existing issues. It would also add
  GitHub I/O to a route already carrying two `waitUntil` calls.

## Receipts

- Issue #1310 (phase 2 of epic #1306); the outage and the classifier are ADR 0049
- Rules: `backend/src/services/import-issue-accrual.ts` (pure), applied by
  `import-issue-sweep.ts` (close/relabel) and `import-failure-issue.ts` (file/roll up)
- Verification primitive: `verifyDatasetVersionS3`, `backend/src/services/import-integrity.ts`
- Fail-open-on-the-row precedent: `backend/src/services/zarr-fidelity-sweep.ts` (issue #1068)
- Batch bounds precedent: `data-integrity-sweep`, `routes/admin/datasets-lifecycle.ts`
- Rollup body shape: ADR 0036 (counts and pointers, not per-file lists)
- Operator entry point: `POST /admin/imports/issue-triage`,
  `nemar admin import-issue-triage` (dry run by default)
