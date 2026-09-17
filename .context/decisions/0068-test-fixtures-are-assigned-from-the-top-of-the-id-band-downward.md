# ADR 0068: Test fixtures are assigned from the top of the id band downward, and real datasets allocate upward

**Status:** accepted
**Date:** 2026-09-16
**Owner:** Seyed Yahya Shirazi

## Context

NEMAR mints dataset ids from three prefixes and had, until now, written down only part of where they may land.
`generateDatasetId` picks the LOWEST unused number for a prefix inside `[START_NUMBER, MAX_NUMBER]`, which for `nm` is `[108, 99999]`.
The `xx` sandbox space is partitioned and documented (prod `xx000001-xx089999`, dev ephemeral `xx090001-xx099899`, exemplar fleet `xx099900-xx099999`); the `nm` space is not partitioned at all.

Standing test fixtures nonetheless live in it.
`nm099999` is the end-to-end dataset, created on demand through `POST /admin/datasets/nm099999/reset`, and it exists in both the production and dev catalogs.
Nothing reserved it.
The only thing between a real depositor and that id was `EXCLUDED_IDS = new Set(["nm099999"])`, whose own comment explained it as an artifact of the candidate pool (`nm099999` contributes candidate 100000) rather than as a reservation.
It reserved one id, for one id, by accident of wording.

The absence of a written rule had already cost something concrete.
The platform's standing anonymous deposit was placed at `xx099907`, inside the exemplar fleet, because the fleet is where curated fixtures had previously gone.
But the `xx` band's defining property is that it cannot be published, and an anonymous deposit's whole purpose is to become publicly readable while its depositor stays blinded.
Building the fixture therefore ran into the publish gate, and the first repair (#1428) wrote an exception into the gate so that one dataset could take the one path it needed.
That weakened a real gate for every caller in order to serve a fixture that was in the wrong place to begin with.
The decision that was missing was not "should this dataset be allowed to publish" but "which id does a fixture get".

A second instance was latent in the code at the same time.
Dev sets `SANDBOX_ID_FLOOR=90001` and no ceiling, so its allocation window was `[90001, 99999]`, running straight through the exemplar fleet that `DEV_EPHEMERAL_BAND_END = "xx099900"` already declared off-limits to the cleanup cron.
The fleet was protected only by the accident that its ids were already taken.

The `nemarDatasets` GitHub org is shared between production and dev, because the org name is hardcoded rather than environment-scoped.
A reservation that held only in non-production would therefore not hold at all: a production-minted `nm099998` would collide with the dev fixture's repository even though the two D1 databases never see each other.

## Decision

**The top 100 ids of every allocatable band are reserved for standing test fixtures, and the allocator never returns one.**
`RESERVED_FIXTURE_FLOOR = 99900` applies to `nm` and `xx`.
Real datasets allocate UPWARD from the prefix's start, as they always have; fixtures are assigned DOWNWARD from `MAX_NUMBER` by name.

On the `nm` side `nm099999` (end-to-end, with its own reset endpoint) is in use today, and `nm099998` is designated for the standing anonymous deposit, which #1434 builds.
On the `xx` side the reserved band is the exemplar fleet, which already occupied it.

**Reserved means not allocatable, not invalid.**
`isValidDatasetId` still accepts a reserved id and every route must still serve one.
The reservation binds exactly one thing: what `generateDatasetId` may hand out.

**The reservation is environment-independent.**
It is not fenced to non-production, because the GitHub org is shared and a repository name collision does not care which database allocated it.

**`on` is deliberately excluded.**
OpenNeuro ids are mirrored from upstream and never allocated here, so a reservation would record a decision that nothing makes.

The rule is enforced in `resolveRange`, which is the single source of truth for both the allocator loop and the exhaustion error, so a caller that runs out of ids is told the ceiling it actually hit rather than being told 99999 while the allocator stopped at 99899.

## Consequences

A fixture's id becomes predictable without a registry: the next standing fixture is `nm099997`, and anyone can work that out from this document.
The question that produced the `xx099907` mistake now has a written answer, and the answer is decidable before any code is written.

The `nm` band loses 100 of its 99,892 ids, a 0.1% cost against a band currently holding 203 rows in production, one of which is already the `nm099999` fixture.
That leaves 99,792 allocatable and roughly 99,590 still free, so the cost is theoretical in a way the collision it prevents is not.

Two populations that could previously meet now cannot, but only until the band is 99.9% full; this is a partition, not a proof.
If `nm` ever approaches exhaustion the fixtures must move before the band is opened, not after.

Anything that hard-codes 99999 as the allocation ceiling is now wrong.
`MAX_NUMBER` keeps its meaning as the VALIDITY cap and gains a comment saying so, because the two caps differing is exactly the kind of thing a later reader will assume is a bug.

`DEV_EPHEMERAL_BAND_END` is now derived from `RESERVED_FIXTURE_FLOOR` rather than written out again.
Those two constants said the same thing in two places and only one of them was enforced; deriving one from the other is what makes the cleanup cron's boundary and the allocator's boundary the same boundary.

## Alternatives considered

- **Keep extending `EXCLUDED_IDS` one id at a time.** It is the smallest change and it is what already existed. It loses because the list has to be remembered at exactly the moment a new fixture is created, which is the moment someone is thinking about the fixture rather than about the allocator, and because a list of ids records no rule: it cannot tell the next person which id to pick.
- **Fence the reservation to non-production.** Attractive because fixtures only exist in dev, and it costs production nothing. It loses on a fact of this deployment rather than on principle: `ORG_NAME = "nemarDatasets"` is shared, so the production allocator can collide with a dev fixture's repository without either database being involved.
- **Reserve a separate prefix for fixtures, e.g. `tt`.** The cleanest separation, and it would have made the `xx099907` placement question impossible to get wrong. It loses because a prefix is load-bearing across the whole platform -- `isValidDatasetId`, the webhook receiver, the zarr and data-plane gates, the repository naming convention, every existing regex -- and because the fixture's value comes precisely from being an ordinary `nm` dataset that the real paths treat identically. A fixture on its own prefix would stop exercising the code it exists to exercise.
- **Allocate fixtures upward from the start too, and just take the next free id.** Rejected because a fixture's id would then change as the band fills, and `nm099999` is already named in the e2e reset endpoint, in AGENTS.md, and in nine test files.

## Receipts

- `backend/src/services/datasetId.ts` -- `RESERVED_FIXTURE_FLOOR`, `isReservedFixtureId`, `resolveRange`
- `backend/test/dataset-id-partition.test.ts` -- the band is refused with the band empty, which is the state production is in today
- #1430 (epic), #1431 (this phase), #1423 and #1428 (the gate exception this replaces)
- ADR 0065 -- anonymity is available before first publication and never after; the fixture this rule was written for
- Epic #923 -- the `xx` partition this generalizes
