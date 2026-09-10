# ADR 0054: The weekly report arrives whether or not anything is wrong, and unknown is not zero

**Status:** accepted
**Date:** 2026-09-09
**Owner:** Seyed Yahya Shirazi

## Context

Auto-import was off for seven weeks and nothing reported it. ADR 0051 made a failure describable,
ADR 0052 made its tracking issue drain, ADR 0053 made the pipeline's silence detectable. All three
are conditional: they act when something is wrong.

That leaves one hole, and it is the one the incident actually fell through. **An alarm and a broken
alarm look identical from the outside.** A monitor that speaks only on breakage cannot distinguish a
healthy week from a monitor that has stopped running, because both produce no messages. The seven
weeks produced no alarm not because the alarms failed but because none existed, and the same
silence would have followed if they had existed and failed.

The second half of the context is narrower and sharper. The original incident was invisible partly
because **a zero and an unknown rendered the same way**: "0 imports this week" and "no data about
imports this week" are the same three characters on a dashboard, and the first is a quiet week while
the second is a broken pipeline.

## Decision

**The weekly summary is unconditional.** One issue per ISO week on `nemarDatasets/.github`,
mentioning `@nemarAdmin`, filed whether or not anything is wrong. A boring report every week is what
makes "no news" mean something: its absence becomes evidence, which is exactly what was missing.

**Unknown is a first-class value and never renders as zero.** Every count in the report is
`number | null`; `null` renders as `unknown`; and there is exactly ONE renderer (`count`) rather than
a ternary per field, because a per-field ternary is how one field eventually prints `0` for something
nobody measured. The same rule is enforced twice, because the CLI carries its own
renderer -- by convention rather than necessity. `shared/` is importable by both halves, so the rule
COULD be declared once there, the way `shared/contract/account-copy.ts` declares account copy; it was
not, because the two renderers target very different surfaces (a GitHub issue body and a terminal) and
share only the null-handling. That is a real duplication and the second copy is where the rule would
rot unnoticed, so it is tested independently. If a third surface ever needs it, move `count` to
`shared/` instead of copying it again.

Consequences of that rule which are decisions in their own right:

- **A section that could not be read is stated as unknown, not omitted.** A missing section reads as
  "nothing to report", which is the same mistake in a different shape.
- **An unknown counts as needing attention.** A report that cannot see is not a report that found
  nothing, so the headline says so. This is what stops a broken reporter from reading as a healthy
  week -- the founding failure, one level up.
- **Each fact is gathered independently and a failure degrades only that fact.** This is the OPPOSITE
  trade from ADR 0053's sweep, and deliberately: there a failed read must not produce a verdict,
  because the verdict CLOSES an issue. Here nothing is closed on the strength of a number, so a
  partial report is worth more than none -- provided the gaps say so.

**The once-per-week gate fails CLOSED.** The reverse of `decideAutoImportGate`, which fails open on
an unreadable timestamp because a skipped import is worse than an early one. The daily cron evaluates
this gate once a day, so failing open on a bad value would post a duplicate weekly issue *every day*
until the value was fixed -- the notification fatigue this epic exists to prevent, arriving from the
tool built to prevent it. A skipped week costs one report and is visible as a gap, because the titles
are week-labelled and sortable.

Two mechanisms, both kept: the **week-labelled title** is the dedup and the **audit row** is the
record. Neither is atomic -- the title check is itself a read-then-write, and GitHub permits
duplicate titles, so a manual `apply` fired while the Monday cron is mid-scan could produce two
issues for one week. What actually caps the damage is the Monday-only day guard, which allows one
cron attempt per week; the two mechanisms are defence in depth against ordinary repetition, not a
distributed lock. Do not describe them as one.

The audit row is written before the GitHub call, and **deleted again if the post fails**. Reserving
first is `autoImportTick`'s rule, but that rule assumes a caller that retries every 30 minutes; here
the day guard already prevents repetition, so an un-released reservation would burn the whole week
and leave no operator path to re-file. Release-on-failure keeps the anti-duplicate property without
the trap.

**The title names the week the data COVERS, not the week the run happens in.** The cron fires Monday
03:00 UTC over the preceding seven days, so deriving the label from the run instant titled an issue
with the week that had just started while carrying the previous week's numbers -- and the heading, the
headline sentence and the rollover comment all inherited it. The gate still compares run instants,
which is a different question and stays correct, so the two notions are named apart in the code and
the tests.

**The ISO week label is the dedup key, so it is computed properly.** The ISO year is not the calendar
year at boundaries -- 2027-01-01 belongs to 2026-W53, 2024-12-30 to 2025-W01 -- and deriving the
label from `getUTCFullYear()` would mislabel both, letting two weeks claim one title or one week be
filed twice under two. Zero-padded, because the rollover finds last week by sorting labels and
`2026-W9` sorts after `2026-W10`.

**The body is written once and never rewritten.** This is a historical record of a closed window,
which is ADR 0052's rollup shape rather than ADR 0053's current-state shape. A rewrite would restate
the window's numbers from a different instant than the window it claims to describe.

**Filing a week's summary closes the most recent EARLIER open weekly**, which is usually the
preceding week but is not defined as it: a skipped week (the gate fails closed, so skipping is a
designed outcome) would otherwise leave an issue open forever. Strictly earlier, by sorted week label
rather than issue number, so a clock-skewed or hand-filed future label cannot be closed as though it
were the past. Content survives closing, so the series stays readable while the open count stays at
one; a tracker that accumulates is what this epic is about. The closing comment names the successor's
issue number, so the series is navigable forward as well as back.

**No new cron trigger.** `scheduled()` compares `event.cron === AUTO_IMPORT_CRON` by exact string, so
a third trigger risks that branch. The report rides the existing daily tick behind a pure
`shouldRunWeeklySummary(now)` -- Monday UTC, matching the repo's two existing weekly Actions. Every
decision lives in a pure exported function, because nothing in this repo invokes `scheduled()` and a
condition written inline in a `.then()` is untestable by construction.

**The daily crons now record what they did.** `runImportIssueSweepCron` and
`runImportCoverageSweepCron` write an audit row with `userId: null`, the convention `import-retry.ts`
uses for system-initiated rows. Previously only the admin ROUTES wrote those rows and a cron run has
no acting user, so an automated close left nothing queryable -- only a Worker log line with finite
retention. That made "how many issues recovered this week" unanswerable, and was a gap in the durable
record of jobs that close real issues regardless of this report.

## Consequences

Easier: the pipeline's health becomes something a person receives rather than something they must
remember to go and check, and the absence of a report is itself a signal. `nemar admin import-weekly`
renders the same report on demand, with `--body` showing exactly what would be filed, and its exit
code matches `import-coverage`'s -- 0 healthy, 1 unhealthy, 2 could-not-determine -- so one rule works
across the family.

**Why `@nemarAdmin` and not a person's handle.** `shared/contract/user.ts` declares that account
`service`, and ADR 0048 says nothing signs in to a service account as a person -- so the mention looks
like it routes nowhere. It does not: the account's email reaches the maintainers who own it, which is
the delivery path this report relies on. Worth stating because the contract reads the other way.

Harder: 52 issues a year on a shared repo (53 in an ISO long year), mitigated by closing the
previous week's. And the report
is only as good as its inputs -- it aggregates ADRs 0051-0053 rather than measuring anything new, so
a wrong number upstream is a wrong number here. That is why every section names its source and why
`unknown` is preserved rather than smoothed.

**One extra OpenNeuro scan per week, and it races the one it duplicates.** The report calls ADR 0053's
sweep read-only rather than threading the daily run's result through, so the two jobs stay
independent: a coverage failure must not stop the weekly report, and vice versa. ~52 extra scans a
year is a fair price for that.

What the cost is NOT is free of interaction. Both jobs launch under `ctx.waitUntil` in the same tick,
so on Mondays two full paginated scans run concurrently, and `discoverOpenNeuroDatasets` has no
retry or backoff. If that trips an upstream limit the weekly report is the run most likely to lose
its coverage section -- on the one day it exists. Accepted rather than sequenced, because sequencing
would couple the two jobs' failure modes back together, which is the thing independence bought. If it
proves a problem in practice, sequence it and say so here.

**The daily crons write a heartbeat row, not only a row when something changed.** Gating the write on
change made a quiet week (the cron ran seven times with nothing to close) indistinguishable from a
dead cron (it never ran) -- both produce zero rows. That is the exact discrimination this phase
exists to provide, absent from the one section whose job is to show the daily jobs are alive. So the
triage cron records every run, and the weekly report reads an absence of rows as `unknown` **and as
needing attention**, rather than as a quiet week.

**Production-only, and not on the dev-cron allowlist**, for the same reason as ADRs 0052 and 0053: it
files and closes real issues on the `nemarDatasets` org that dev shares with production. Two fences,
the cron wrapper's `isNonProductionEnv` and the route's own `apply` refusal. The route's DRY RUN also
forces past the weekly gate, since it writes nothing and an operator asking to read the report should
not be told to wait for Monday.

## Alternatives considered

- **Report only when something is wrong.** The obvious design and the one this ADR exists to reject:
  it cannot distinguish a healthy week from a broken reporter, which is the founding incident.
- **Render an unknown as zero** (or omit it). Simpler output, and it recreates the exact confusion
  that hid the outage. Declined at every layer, including the CLI's separate renderer.
- **Email instead of an issue.** Reaches a person without them visiting GitHub, and leaves no durable
  searchable record, no thread to comment on, and no way to see last week's next to this week's.
  Also the dev worker holds a live `RESEND_API_KEY` against ~609 real addresses (ADR 0009's fence),
  so an emailing job is a much larger blast radius than an issue-filing one.
- **A new weekly cron trigger.** Declarative and obvious, and it puts a third string next to a branch
  that is selected by exact string equality. Declined for a pure day-of-week guard.
- **A GitHub Action on a weekly cron**, like `check-summary-drift.yml`. No scheduling guard needed and
  the cadence is declared in one place, but the data lives behind admin auth in D1 and the report
  would have to re-fetch it over HTTP, duplicating logic that already exists in the Worker.
- **Store the last-run week in D1 as a column.** Declined per ADR 0034: `audit_log` already answers
  it, and a column is a second source of truth that drifts.
- **Read closed GitHub issues to count recoveries.** Needs a new listing primitive and makes GitHub
  rather than D1 the authority for a time-windowed count. Declined in favour of making the crons
  record what they did, which is useful independently.

## Receipts

- Issue #1312 (phase 4 of epic #1306); ADR 0051 (the classifier), ADR 0052 (the tracking issue's
  lifecycle, and the mutate-before-comment rule reused here), ADR 0053 (coverage and the
  healthy/alarm/unknown split this extends)
- Rules and body: `backend/src/services/import-weekly-summary.ts` (pure), applied by
  `import-weekly-summary-sweep.ts`
- The gate idiom and its opposite failure direction: `decideAutoImportGate` and
  `AUTO_IMPORT_GATE_QUERY` in `backend/src/services/auto-import.ts`
- Counts-and-pointers truncation: ADR 0036
- Derive rather than store, the reason the week is computed and not persisted: ADR 0034
- Operator entry point: `POST /admin/imports/weekly-summary`, `nemar admin import-weekly`
  (dry run by default, and forced past the gate; `apply` production-only)
