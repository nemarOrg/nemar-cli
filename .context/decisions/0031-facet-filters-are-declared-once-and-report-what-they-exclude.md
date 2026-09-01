# ADR 0031: Facet filters are declared once, and report what they exclude

**Status:** accepted
**Date:** 2026-09-01
**Owner:** Seyed Yahya Shirazi

## Context

Phase 1 (#1145) moved dataset filtering into SQL; Phases 2 and 2b (#1146,
#1153) added a batch of new `datasets` columns -- recording-level duration
and channel-count ranges, signal defaults, HED/BIDS versions. None of them
were filterable. `DatasetFilterOptions` (`dataset-filters.ts`) was a flat bag
of nine bespoke fields with no structural concept of "a range filter over a
column that is only partly populated" -- the Phase 1 review deferred
redesigning it with a stated reason: the shape could not be designed without
the full filter list in hand. Phase 3 (#1147) is that filter list, so the
redesign is decided here.

Two constraints shaped the answer. First, three of the new columns are
**pairs** (`channel_count_min/max`, `recording_duration_min/max`, plus the
pre-existing `age_min/max`), not single scalars -- a filter engine built only
for one column per facet gets these three silently wrong. Second, most of the
new columns are 0% to 72% populated today (the Phase 2/2b sweeps have not
finished against production), so a NULL-excludes-by-default policy makes the
initial recall of several filters low by construction, not by bug -- that
needed to be visible to a caller, not just silently swallowed.

## Decision

**One declared table is the single source of truth for which columns are
filterable, split across two files by what each side needs.**
`shared/facets.ts` is the CLI/wire vocabulary (key, flag, value kind, enum
members) with zero SQL; `backend/src/services/dataset-facets.ts` binds each
key to column(s), an SQL kind, and a NULL test. A test asserts the two
declare the exact same set of keys in both directions, so a half-added facet
fails CI instead of a flag silently doing nothing. The existing bespoke
filters (`search`, `modality`, `author`, `task`, `hasDoi`, `hasHed`,
`dataComplete`, `recent`, `licenseTiers`) are NOT migrated into this table --
their semantics (FTS routing, LIKE-joined comma lists) are irregular enough
that forcing them in would have rewritten four passing test files for no
behavioural gain. `buildDatasetFilterClauses` runs its existing chain, then
appends one generic walk over the facet table.

**Two filter kinds, and pairs use overlap, not containment.** A `scalar`
facet is `col BETWEEN ? AND ?`. A `pair` facet is
`col_max >= ? AND col_min <= ?` -- overlap, because `--age 5..18` must match a
dataset spanning 12..25 (it does contain participants in that range);
containment is the tempting-looking wrong answer and reads identically for
any fixture whose ranges happen to nest.

**A derived range beats a sampled exemplar, with a documented fallback.**
`--channels` binds to `COALESCE(channel_count_min/max, n_channels)` on each
side: the derived per-recording pair is authoritative but 0% populated until
the sweep runs, and the exemplar (`n_channels`, one sampled sidecar) is a
known-imperfect but already-available signal (confirmed wrong today:
nm000111 reads 19 while 70 of its 124 recordings are actually 20). Filtering
on the pair alone would return nothing for months; filtering on the exemplar
alone keeps a number already known to be wrong for some datasets. The
COALESCE collapses to the exemplar scalar when the pair is NULL and to the
true overlap once it is populated -- one clause, both states. This is the
only facet with a fallback, and it is documented as an exception, not a
precedent: no other current or near-term facet has both a derived source and
a usable interim proxy at the same time.

**Unknown is excluded by default, and the exclusion is reported, never
assumed.** A NULL never satisfies a SQL comparison, so a row with an
unpopulated filtered column drops out by default -- the correct default,
since silently including it would make `--rate 1000` return datasets of
unknown rate. `include_unknown=1` widens every ACTIVE facet's predicate with
its declared NULL test. Both catalog envelopes gain `excluded_unknown`: the
count that would have matched with unknowns included, minus the count that
did, computed only when a facet is active (an unfiltered list pays nothing)
and via the existing `Promise.allSettled` / `countSearchMatchesSafely`
degradation paths, so a failure omits the field rather than 500ing an
otherwise-good response. This is the same posture ADR 0005 already commits
to for availability: a gap is reported out of band, never faked and never
allowed to block delivery. It matters immediately, not hypothetically:
`--duration`, `--rate`, and `--recordings` filter columns that are 0%
populated in production today, so recall is genuinely low until the Phase
2/2b sweeps finish, and `excluded_unknown` is what tells a caller which of
"no matches" and "matches excluded because unknown" they are looking at.

## Consequences

- Adding the twenty-first facet is one row in each of two tables, not a new
  branch in a growing if-chain -- the overlap logic, the NULL policy, and the
  unknown-count arithmetic are written once and apply to every facet
  automatically.
- `DatasetFilterOptions` gains exactly two fields (`facets`, `includeUnknown`)
  rather than twenty; the nine flat legacy fields are unchanged, so no
  existing caller or test needed to move.
- `hasActiveFilters` (`dataset-search.ts`) folds in one call
  (`isAnyFacetActive`) instead of hand-enumerating facet keys as a third
  maintained list -- closing off the exact enumeration-drift shape that left
  Phase 2b's untested OR-gate terms silently inert.
- Every facet's column must also be projected (a test enforces it), which
  surfaced and closed a pre-existing gap: the `?mine` branch of `GET
  /datasets` had never projected `num_citations` at all, even though the
  public branch has since #804. A user could have filtered `--citations` on
  their own datasets and never seen the number that justified the result.
- `excluded_unknown` costs one extra COUNT query per request, but only when a
  facet is active -- the common unfiltered browse/search path is unaffected.
- `bids_version`/`hed_version` stay prefix/exact only in this phase (a
  lexicographic `>=` is already wrong on production data: `'1.9.0' >
  '1.10.0'` as strings). A true semver range needs either a derived sortable
  column or the distinct-value list Phase 5's facets endpoint will expose;
  tracked as a follow-up rather than shipped as a known-wrong comparison.

## Alternatives considered

- **Add each new column as its own bespoke field on `DatasetFilterOptions`,
  the way the original nine were added.** Fastest to ship one facet at a
  time; rejected because it repeats, twenty times, the exact copy-paste
  surface that let Phase 2b's OR-gate regression through untested, and
  because it has no structural place to put the pair/overlap logic without
  duplicating it three times (age, channels, recording-length).
- **Contain instead of overlap for pair facets.** Simpler mental model
  ("only show datasets entirely inside my range"), but wrong per the issue's
  own worked example and silently so: any fixture whose dataset range nests
  inside the query range can't distinguish the two implementations, which is
  exactly why the plan calls for a fixture built to make them disagree.
- **Filter `--channels` on `n_channels` only, deferring the derived pair
  until the sweep finishes.** Simpler, and correct once the sweep completes,
  but ships a filter using a value already known wrong for some datasets with
  no path to improve without another migration later. Rejected in favour of
  one COALESCE that upgrades itself for free as the sweep runs.
- **Make `include_unknown` the default (include unless asked not to).**
  Would have kept recall high while columns are still sparsely populated,
  but silently returns rows with no relationship to the filter value the
  caller asked for -- worse than low recall, because it looks like a match.
  Rejected; the explicit escape hatch plus the reported count is the honest
  version of the same convenience.
- **Compute `excluded_unknown` per-facet.** More informative, but needs one
  query per active facet rather than one aggregate query, and the CLI
  message this feeds ("N datasets excluded because a filtered field is
  unknown for them") doesn't need the breakdown. Deferred; the aggregate
  form is the one built here.

## Receipts

- Epic #1144, issue #1147 (this phase); #1145 (Phase 1, the deferred
  restructure), #1146 / #1153 (Phase 2 / 2b, the columns this phase makes
  filterable).
- ADR 0005 (availability is reported, never a precondition for serving) --
  the precedent `excluded_unknown` follows.
- Migration 0070 (`recording_stats`) and 0071 (`signal_defaults`) column
  comments, for the exact NULL semantics each facet reads.
- `backend/src/lib/license.ts#parseLicenseTierFilter` -- the drop-unrecognised
  idiom the `enum` facet kind mirrors.
- nm000111: confirmed live case where `n_channels` (19) disagrees with the
  true per-recording distribution (70/124 recordings actually at 20).
