# ADR 0055: A reconcile reports a disagreement and files nothing, and coverage is looser than ownership

**Status:** accepted
**Date:** 2026-09-10
**Owner:** Seyed Yahya Shirazi

## Context

Epic #1306 built four mechanisms and none of them compares the two sides. The triage sweep (ADR 0052)
starts from the OPEN ISSUES and asks whether each named dataset has recovered, so a failure with no
issue is outside its candidate list entirely.

Being precise about the weekly report, because the first draft of this ADR got it wrong:
`gatherFailures` classifies ROWS from `import_jobs`, so an untracked failure *is* already in the
weekly cause counts. What nothing does is NAME it or act on it — it is one anonymous increment in a
histogram, indistinguishable from a failure that has an issue and an owner.

Two disagreements are possible, and they fail in opposite directions:

- **A failure with no issue.** `import_jobs` says `failed` and nothing on `nemarDatasets/.github`
  names it. It is outside the sweep's candidate list, so nothing will ever verify or close it, and it
  reaches the weekly report only as an anonymous increment. This direction loses work.
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

**Only `failed` is a gap.** `shouldFileImportFailureIssue` requires `resultingStatus === "failed"`,
so `failed` is the only status the filer ever acts on — which makes "failed with no issue" a statement
about a mechanism that should have fired and did not. The others are counted, not listed:

- `quarantined` has its OWN channel: recovery emails an admin, writes an `import_quarantined` audit
  row, and the row is listable at `GET /admin/imports?status=quarantined`. Worse, most quarantine
  reasons (`has_doi`, `made_public`, `reached_complete`, `system_owned`) are excluded from the retry
  candidate set forever, so no machine action could ever clear the entry: it would be a permanent
  line item saying "nothing surfaces this" about something three things surface. There are real
  instances — eight rows quarantined with an upstream reason that the retry candidate query cannot
  match.
- `incomplete` belongs to the retry engine, which has an owner and a next attempt for it. The weekly
  report's `OPEN_FAILURES_QUERY` includes it and this deliberately does not, for that reason.
- `rolled_back` is the resolution, not a problem. Counting it would make the report permanently
  non-empty on a set nobody intends to act on (ADR 0053's rule, reused).

**Closing an issue now HEALS the row, rather than leaving a disagreement to report.** The sweep
closed on the S3 verdict and never wrote `import_jobs.status`, so a dataset it had just certified
complete kept a `failed`/`quarantined` row — and this reconcile then reported that row as an
untracked live failure every day, permanently, since most quarantine reasons can never re-enter the
retry lane. A monitor manufacturing its own findings is worse than no monitor. An applied close now
calls `recoverRow`, which is exactly what `POST /admin/imports/:id/verify` calls on the same verdict,
unconditionally and regardless of prior status. Best-effort and after the close: the close has
landed, so a failure to heal must not undo it — it leaves the disagreement to be reported, which is
where we were before.

**It is not computed outside production.** Both sides have to come from the same world and outside
production they cannot: the issue list is always production's (`IMPORT_FAILURE_ISSUES_REPO` is
hardcoded on a shared org) while the rows are the local D1's, and a non-production worker can never
create an `import_jobs` row because `POST /admin/datasets/import` refuses outside production. A
staging dry run would therefore report every open production issue as missing its row and any stale
dev row as untracked: fiction in both directions. The verdict is `null` with a reason, so it reads as
"not computed" rather than as agreement.

**The daily cron reports it, and the heartbeat row persists the counts.** The first version computed
the verdict and discarded it — the log carried the aggregate line and the plan and never mentioned
the reconcile, so its only voice was a human typing the CLI command, for a comparison whose whole
justification is that it rides the daily sweep. Counts only in the audit row, not the id lists: that
row is read by the weekly report's activity section, and a fleet-sized array in `details` would bloat
every row for a section that wants a number.

**It rides the triage sweep rather than being its own job.** That sweep already fetches the full open
issue list, so the comparison costs no additional GitHub call and cannot add to the shared
subrequest budget ADR 0054 records as unbudgeted. It reads the FULL list, never the sweep's rotation
window: the window is a bound on how many issues a run may WRITE to, and inheriting it here would
report every issue outside today's window as missing its row.

**An issue a human has already triaged is not re-reported.** `no-import-row` is a label a person
applies from exactly this finding, and `decideIssueAction` deliberately preserves it. Without the
skip, the list would mean "rows are missing"; with it, the list means "rows are missing and nobody has
looked yet", which is the actionable one.

**Rollup coverage reads the issue BODY, not only the title's cause.** A rollup names its datasets in
its body, and the title carries only the cause. Matching on the title alone made coverage depend on
the row's CURRENT classification, which is re-derived from `last_error` on every run — so a new
classifier rule shipped in a deploy could move a row to a cause whose rollup is not open and report it
untracked while it sat listed in the old rollup. Reading the body makes coverage a fact about what is
written down.

**No open issues at all is annotated, not substituted.** When failures exist and the issue list comes
back empty, the likeliest cause is a renamed or deleted label: `listOpenIssuesByLabel` throws on any
non-2xx, so this is not a swallowed transport error, but a label rename yields a legitimate 200 with
no issues, and the sweep's own "listed issues but none had labels" guard cannot see it because it only
fires on a non-empty list. The first version *returned early* with that hypothesis, which meant the
largest form of the real gap was reported as a label problem. The label is a hypothesis; the
disagreement is the finding, so the note is appended to it.

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

The lists are ordered OLDEST FIRST and truncated at one shared cap (20, in both the backend report
and the CLI). Ordering newest-first hid exactly the longest-abandoned failures, which are the ones
worth naming; two different caps for one list is how a reader learns to trust neither.

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
