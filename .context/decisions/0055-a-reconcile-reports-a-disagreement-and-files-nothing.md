# ADR 0055: A reconcile reports a disagreement and files nothing, and coverage is looser than ownership

**Status:** accepted
**Date:** 2026-09-10
**Owner:** Seyed Yahya Shirazi

## Context

Epic #1306 built four mechanisms and every one of them reads a single side of a correspondence and
trusts the other. The triage sweep (ADR 0052) starts from the open issues and asks whether each
dataset has recovered. The weekly report (ADR 0054) counts issues by cause. ADR 0051's classifier
describes whatever message arrives. Nothing asked whether the failures and the issues describe the
same set.

Two disagreements are possible, and they fail in opposite directions:

- **A row with no issue.** `import_jobs` says `failed` or `quarantined` and nothing on
  `nemarDatasets/.github` tracks it. The dataset is broken and *invisible*: absent from the sweep's
  candidate list, because that list is built from the issues, and absent from the weekly report's
  counts, because those count issues. This direction loses work silently, which is the epic's
  founding failure wearing different clothes.
- **An issue with no row.** An open machine-filed issue whose dataset has no `import_jobs` row at
  all. ADR 0051's taxonomy already contains `no_import_row`, which is evidence this happens. The
  sweep cannot resolve it: with no row there is nothing to verify, so `decideIssueAction` returns
  `keep` every day forever. This direction accrues stale issues, which is what ADR 0052 exists to
  stop.

The gap fell between phases: #1310 handed it to #1311, and #1311 turned out to be a different
question (upstream OpenNeuro versus our catalog) sharing no query, verdict or threshold with it.
The epic closed with the gap named rather than papered over, as issue #1352.

## Decision

**The reconcile reports and files nothing.** Filing the missing issues is the obvious action and the
one most able to do harm: a batch of newly-filed issues on a shared repo is precisely the flood ADR
0052's rollup exists to prevent, and the first run has the largest batch by construction. Report
first, and add filing later behind the rollup's own mode if the reports prove the shape is right.
A reconcile that is wrong and silent costs nothing; a reconcile that is wrong and files is an
incident.

**Coverage is a LOOSER test than ownership, and that asymmetry is the point.**
`decideIssueAction` demands an exact rebuilt title before the automation may mutate an issue, so a
hand-written issue that merely resembles the format is never closed by a machine. That strictness is
right for mutation and wrong here, because the question is different: *will a human see this
failure?* Under the strict test, someone who filed their own issue about `on008065` would be told
the dataset is untracked, and the only way to satisfy the report would be to file a duplicate of the
issue they had just written. So a row counts as covered by an exact machine-filed title, by any open
issue naming the dataset, or by an open rollup for its cause. Ownership stays strict; visibility is
what is being measured.

The other direction stays strict: only machine-filed issues are reported as missing a row. Telling
someone their hand-written issue is inconsistent with a table they have never heard of is noise, not
a finding.

**An open rollup covers the rows of its cause.** Without this the reconcile would report nearly
every failed row as untracked at exactly the moment the rollup is working, turning the mechanism that
prevents notification fatigue into its largest source. The rollup title is built from the
`cause` (`auth_invalid`), not from the hyphenated label (`auth-invalid`); the first implementation
used the label, matched no rollup that exists, and would have shipped that storm.

**A row the retry engine has PARKED is not untracked.** `blocklisted = 1` rows are already surfaced:
the weekly summary lists every one of them in its parked section with the reason and how long it has
been there (`PARKED_QUERY`, ADR 0054). Reporting them here as "untracked, so nothing surfaces them to
triage" would be a false statement about a set that is reported every Monday, and it is the same rule
ADR 0053 applies when it keeps blocklisted datasets out of its backlog: an alarm that is permanent on
a set nobody intends to act on gets muted, and then the real one is muted with it. They are COUNTED
(`parked`) rather than dropped, so a reader can see why the untracked number is smaller than the raw
failure count. A NULL in that column reads as not-parked, which reports rather than hides.

**`rolled_back` is resolved, not unresolved.** Only `failed` and `quarantined` count. A rolled-back
import is an orphan that was cleaned up; counting it would make the report permanently non-empty on
a set nobody intends to act on, which is how an operator learns to ignore a report (ADR 0053's rule
about `tracked`/`blocklisted`, reused).

**It rides the triage sweep rather than being its own job.** That sweep already fetches the full open
issue list, so the comparison costs no additional GitHub call and cannot add to the shared
subrequest budget ADR 0054 records as unbudgeted. It reads the FULL list, never the sweep's rotation
window: the window is a bound on how many issues a run may WRITE to, and inheriting it here would
report every issue outside today's window as missing its row.

**A failure leaves the verdict null, never an empty one.** `reconcile: null` plus a `reconcileError`
means the comparison did not happen; `reconcile: {rowsWithoutIssue: [], ...}` means it happened and
they agree. Rendering the first as the second is ADR 0054's founding confusion one level down, so
the CLI prints `reconcile=unknown` and the counts carry their denominator (`rows_examined`) so a
clean report can be told from an empty input.

The error is its own field rather than an entry in the sweep's `errors[]`, because that array is
per-issue (`{issue, dataset_id, stage}`, answering which half of one issue's triage broke) and would
have needed an invented issue number — and would then count against `attempted`, the denominator for
"did every write fail?".

## Consequences

Easier: a failed import can no longer be invisible to both the sweep and the weekly report, and a
permanently-unresolvable issue is named instead of being `keep`-ed forever. `nemar admin
import-issue-triage` shows both directions with the cause per row, so the output is actionable
without a query.

Harder: the reconcile is only as good as `import_jobs`. `deleteDatasetCascade` deliberately does not
touch that table (migration 0044), so a deleted dataset leaves its row behind and would report as
untracked — correctly, in that the row is unresolved, but an operator may read it as a live problem.
If that proves noisy, the fix is a `dataset_deleted` status rather than a filter here, because the
row outliving the dataset is the property that makes a rolled-back orphan auditable.

**It does not close the loop it measures.** Someone still has to act on both lists. That is the
deliberate consequence of report-only, and the reports themselves are the evidence for whether
filing should be automated.

## Alternatives considered

- **File the missing issues automatically.** The obvious design, and rejected for now for the reason
  above: the first run has the largest batch, on a shared repo, and ADR 0052 exists because that
  flood already happened once.
- **Close the row-less issues automatically.** Symmetrical and worse: an issue with no row may be
  the only record that an import was ever attempted, and closing it destroys the trail that would
  explain the missing row.
- **Its own sweep, route and cron.** Consistent with phases 3 and 4, and it would pay a second full
  GitHub issue listing for a comparison the triage sweep can make for free, on a tick whose
  subrequest budget is already unmeasured.
- **Reuse the strict ownership test for coverage.** One rule instead of two, and it manufactures
  false positives whose only remedy is filing duplicates.
- **Report `rolled_back` rows too, for completeness.** Every row would eventually appear, and a
  report that is never empty is a report nobody reads.

## Receipts

- Issue #1352, epic #1306; ADR 0051 (the classifier, whose causes this reports),
  ADR 0052 (the tracking issue's lifecycle and the rollup whose mode this must respect),
  ADR 0053 (the exclude-what-is-already-tracked rule reused here),
  ADR 0054 (unknown is not zero, applied to a verdict rather than a count)
- Rules: `backend/src/services/import-reconcile.ts` (pure), read by
  `import-issue-sweep.ts`'s `RECONCILE_ROWS_QUERY`
- Identity, and why coverage and ownership differ: `decideIssueAction` and
  `importFailureIssueTitle` in `import-issue-accrual.ts` / `import-issue-identity.ts`
- Counts-and-pointers truncation: ADR 0036
- Operator entry point: `nemar admin import-issue-triage` (the reconcile section is printed on a dry
  run too, since it describes state rather than a change)
