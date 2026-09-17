# ADR 0068: Test fixtures are assigned from the top of the id band downward, and real datasets allocate upward

**Status:** accepted
**Date:** 2026-09-16
**Owner:** Seyed Yahya Shirazi

## Context

NEMAR uses three dataset-id prefixes, mints two of them (`nm` and `xx`; `on` is mirrored from OpenNeuro), and had, until now, written down only part of where they may land.
`generateDatasetId` picks the LOWEST unused number for a prefix inside `[START_NUMBER, MAX_NUMBER]`, which for `nm` is `[108, 99999]`.
The `xx` sandbox space is partitioned and documented (prod `xx000001-xx089999`, dev ephemeral `xx090001-xx099899`, exemplar fleet `xx099900-xx099999`); the `nm` space is not partitioned at all.

Standing test fixtures nonetheless live in it.
`nm099999` is the end-to-end dataset, created on demand through `POST /admin/datasets/nm099999/reset`, and it exists in both the production and dev catalogs.
Nothing reserved it.
The only thing between a real depositor and that id was `EXCLUDED_IDS = new Set(["nm099999"])`,
whose own comment explained it as an artifact of the candidate pool (`nm099999` contributes candidate 100000) rather than as a reservation.
So it did reserve that one id, but incidentally, as a side effect of a rule about something else.

The absence of a written rule had already cost something concrete.
The platform's standing anonymous deposit was placed at `xx099907`, inside the exemplar fleet, because the fleet is where curated fixtures had previously gone.

In the `xx` band, publication is itself an exception.
`xx` datasets cannot publish at all; the fleet publishes only through `isExemplarPublishAllowed`,
which admits a row when the environment is non-production AND the id is `xx` AND `is_exemplar = 1`,
and mints sandbox EZID DOIs rather than real ones.
That gate also refused any anonymous exemplar outright (`row.anonymous !== 1`).
An anonymous deposit's defining event is the opposite: an anonymous release,
which makes the row publicly readable while the depositor stays blinded, and which is a real publication path with real semantics.
So the fixture whose whole purpose was to take that path had been put in the one band where taking it meant widening an exception,
and the refusal it hit reported itself as "Cannot publish sandbox datasets",
naming the band rather than the anonymity term that actually fired.

The first repair (#1428) widened the exception: `isExemplarPublishAllowed` gained an `ExemplarPublishIntent` parameter so an explicit `anonymousRelease` could pass the anonymity term.
That relaxation is narrow, and it was built to fail closed: the parameter defaults to `{}`,
the gate stays non-production-only and exemplar-only,
and the three callers that ask the destructive question pass no intent and are unchanged.
It is not dangerous.
It is the wrong repair, because it answers "should this dataset be allowed to publish"
when the question that was actually open was "which id does a fixture get".

A second instance was latent in the code at the same time.
Dev sets `SANDBOX_ID_FLOOR=90001` and no ceiling, so its allocation window was `[90001, 99999]`,
running straight through the exemplar fleet that `DEV_EPHEMERAL_BAND_END = "xx099900"` already declared off-limits to the cleanup cron.
The fleet was protected only by the accident that its ids were already taken.

The `nemarDatasets` GitHub org is shared between production and dev, because the org name is hardcoded rather than environment-scoped.
A reservation that held only in non-production would therefore not hold at all:
a production-minted `nm099998` would collide with the dev fixture's repository even though the two D1 databases never see each other.

## Decision

**The top 100 ids of each allocating PREFIX are reserved for standing test fixtures, and the allocator never returns one.**
`RESERVED_FIXTURE_FLOOR = 99900` applies to `nm` and `xx`, so `nm099900`-`nm099999` and `xx099900`-`xx099999` are reserved.
Note that this is a property of the prefix, not of each band inside it:
the top of the prod sandbox band (`xx089900`-`xx089999`) and the top of the dev ephemeral band (`xx099800`-`xx099899`) are allocated normally.
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

The rule is enforced in `resolveRange`, which is the single source of truth for both the allocator loop and the exhaustion error,
so a caller that runs out of ids is told the ceiling it actually hit rather than being told 99999 while the allocator stopped at 99899.

## Amendment 2026-09-17 (#1440): environment ownership is declared, not inferred

Moving the standing anonymous deposit to a reserved `nm` id had a consequence this ADR did not foresee, found in review of #1437 rather than in the plan.

Three fences decide "does this environment own this dataset?" from the id SHAPE, via `isDevRangeDatasetId` (`/^xx09\d{4}$/`).
That predicate was quietly answering two different questions at once: "is this a dev SANDBOX dataset" and "does the dev worker own this".
They were the same set until a reserved `nm` fixture existed, which is the second and not the first.

The measured consequences, all in code that predates this ADR:

- `services/deletion.ts` refused to cascade-delete `nm099998` from the dev worker, so the documented recovery for a failed fixture build, delete then recreate, did not work on the only worker that could run it.
- `routes/webhooks/github.ts` made the DEV worker refuse pushes to its own fixture, answering `prod_range_repo_on_dev_worker`, so enrichment could never run against the one dataset built to exercise the anonymity surfaces.
- The same file made the PRODUCTION worker treat those pushes as its own and dispatch an ENRICHMENT run for a repository it has no D1 row for.
  Stated narrowly on purpose, because a first draft of this amendment said "enrichment, zarr and version-DOI" and two thirds of that was wrong: `shouldDispatchZarr` is defined but never called (retired with the Actions dispatch path in #1109), and the version-DOI path already refused this case, because its anonymity check reads `SELECT anonymous FROM datasets` on the calling worker and treats an ABSENT row as anonymous (#1408).
  Enrichment alone is enough to justify the change, and an ADR that overstates its evidence is worse than one that understates it.
- A fourth fence, found only after the first three were fixed: `services/publication-sweep.ts` scoped its non-production candidate set with `AND pr.dataset_id LIKE 'xx09%'`, the same question asked a fourth way.
  An anonymous release IS a publication request, so the standing anonymous deposit is the dataset most likely to land in the `blocked` state that sweep exists to clear, and moving it to a reserved `nm` id dropped it out of the sweep's reach.

**Environment ownership is therefore declared, in `DEV_OWNED_FIXTURE_IDS`, and not inferred from the id.**
`isDevOwnedDatasetId` is `isDevRangeDatasetId(id) || DEV_OWNED_FIXTURE_IDS.has(id)`, and the three fences use it.
`isDevRangeDatasetId` keeps its own meaning and its other callers; conflating the two questions is what caused this, and it is not fixed by redefining the first one.

**A declared list is right here, and this ADR rejects exactly that shape for the allocator.**
The difference is what the two are being asked.
The allocator needs a rule, because "which id does the next fixture get" has to be answerable without consulting a list, and a list records no rule.
Ownership is a FACT about a particular fixture, not something derivable from its id, so there is no rule to record.
Position does not encode it either, which is what rules out partitioning the reserved band by owner: `nm099999` and `nm099998` are adjacent and differ.

**`nm099999` is deliberately not in the set.**
It exists in both the production and dev catalogs, and it is maintained through `POST /admin/datasets/nm099999/reset` rather than a delete-and-recreate cycle.
Adding it would let a non-production worker cascade-delete a GitHub repository production also uses.

The cost is that adding a standing fixture now means adding it in two places, the reserved band and the ownership set.
That is a real cost and it is the right one: the alternative is a rule that cannot express the thing it is being asked to express, which is how this was missed the first time.

## Consequences

A fixture's id becomes predictable without a registry: the next standing fixture is `nm099997`, and anyone can work that out from this document.
The question that produced the `xx099907` mistake now has a written answer, and the answer is decidable before any code is written.

The `nm` prefix loses 100 of its 99,892 ids, a 0.1% cost.
Production holds 203 `nm` rows, but only 197 of them are in the allocatable window: five (`nm000103`-`nm000107`,
the live datasets) predate `START_NUMBER = 108` and one is `nm099999`, already inside the reserved band.
That leaves 99,792 allocatable and 99,595 free, so the cost is theoretical in a way the collision it prevents is not.

Two populations that could previously meet now cannot, but only until the band is 99.9% full; this is a partition, not a proof.
If `nm` ever approaches exhaustion the fixtures must move before the band is opened, not after.

Anything that hard-codes 99999 as the allocation ceiling is now wrong.
`MAX_NUMBER` keeps its meaning as the VALIDITY cap and gains a comment saying so, because the two caps differing is exactly the kind of thing a later reader will assume is a bug.

`DEV_EPHEMERAL_BAND_END` is now derived from `RESERVED_FIXTURE_FLOOR` rather than written out again.
Those two constants said the same thing in two places and only one of them was enforced;
deriving one from the other is what makes the cleanup cron's boundary and the allocator's boundary the same boundary.

## Alternatives considered

- **Keep extending `EXCLUDED_IDS` one id at a time.**
  It is the smallest change and it is what already existed.
  It loses because the list has to be remembered at exactly the moment a new fixture is created,
  which is the moment someone is thinking about the fixture rather than about the allocator,
  and because a list of ids records no rule: it cannot tell the next person which id to pick.
- **Fence the reservation to non-production.**
  Attractive because fixtures only exist in dev, and it costs production nothing.
  It loses on a fact of this deployment rather than on principle:
  `ORG_NAME = "nemarDatasets"` is shared,
  so the production allocator can collide with a dev fixture's repository without either database being involved.
- **Reserve a separate prefix for fixtures, for example `tt`.**
  The cleanest separation, and it would have made the `xx099907` placement question impossible to get wrong.
  It loses because a prefix is load-bearing across the whole platform:
  `isValidDatasetId`, the webhook receiver, the zarr and data-plane gates,
  the repository naming convention, and every existing regex.
  It also loses because the fixture's value comes precisely from being an ordinary `nm` dataset that the real paths treat identically;
  a fixture on its own prefix would stop exercising the code it exists to exercise.
- **Allocate fixtures upward from the start too, and just take the next free id.**
  Rejected because a fixture's id would then change as the band fills,
  and `nm099999` is already named in the end-to-end reset endpoint, in AGENTS.md, and in more than thirty test files.

## Receipts

- `backend/src/services/datasetId.ts` -- `RESERVED_FIXTURE_FLOOR`, `isReservedFixtureId`, `resolveRange`
- `backend/test/dataset-id-partition.test.ts` -- the band is refused against a FULL allocatable band, seeded directly, since that is the only state in which it can be crossed
- `backend/src/routes/admin/exemplar.ts` -- `EXEMPLAR_ID_RE`, which declares the same band separately and is cross-checked against `isReservedFixtureId` by a drift test
- #1430 (epic), #1431 (this phase)
- #1423 and #1428 -- the gate exception this rule makes unnecessary; #1433 withdraws it, and until then it remains live
- ADR 0065 -- amended in this phase to record that the fixture's placement, not its reasoning, is what was wrong
- ADR 0065 -- anonymity is available before first publication and never after; the fixture this rule was written for
- Epic #923 -- the `xx` partition this generalizes
