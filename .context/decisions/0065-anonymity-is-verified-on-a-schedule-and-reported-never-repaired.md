# ADR 0065: Anonymity is verified on a schedule, and reported, never repaired

**Status:** accepted
**Date:** 2026-09-16
**Owner:** Seyed Yahya Shirazi

Epic #1406, issue #1409.
Follows ADR 0063 (anonymity is pre-publication only) and ADR 0064 (the data-plane broker
this depends on).

## Context

ADR 0063 made anonymity a state the database enforces and put the blind inside every
writer NEMAR controls.
Phases 1-3 delivered that.
What none of it delivered is a reason to keep believing it tomorrow.

Every one of those blinds is a claim about code that nothing re-reads.
A projection that loses its `AND d.anonymous = 0`,
an admin `UPDATE` that clears `enrichment_json` without re-blinding,
a repository flipped public by hand, an EZID record advanced out of `reserved`:
each is silent, each is a single line, and each discloses a person.
Phase 2 of this epic shipped two blinds whose deletion left 3,418 tests green,
which is what an unverified guarantee looks like from the inside.

And half the leak inventory was never NEMAR's to blind at all.
`dataset_description.json`, README, `participants.tsv` and the recordings are the
depositor's files, git-tracked, and served publicly from the data plane.

## Decision

**A daily sweep re-checks every anonymous deposit, and it answers two different questions
without ever letting one stand in for the other.**

**Invariants NEMAR owns.**
The repository is private,
`datasets.authors` holds the blinded label,
`enrichment_json` carries none of the blinded keys,
`first_published_at` is NULL,
the EZID record is `reserved` and its DataCite document names nobody,
the catalog's owner projection returns nothing,
and the published Zarr index carries no real attribution.
A failure here is a NEMAR bug, reported as `severity: "invariant"`.

**What the depositor left in their own files.**
Reported as `severity: "deposit"` and addressed to them, because NEMAR cannot fix it.

**The file checks are deterministic, and that is a design choice rather than a limitation.**
They do not ask whether a string is a person's name, which is the hard problem and the one
a model would be needed for.
They ask a narrower question with an exact answer:
does this file contain THE DEPOSITOR,
whose real name, username, GitHub handle, email and ORCID iD are all in the `users` row
NEMAR is concealing?
Plus two patterns that identify regardless of who wrote them:
any ORCID iD, and any email address.
No classifier, no false-positive budget, and a finding a depositor can reproduce without
arguing with it.
An advisory model-guided pass over free text is a reasonable SECOND layer, and the
pre-screen machinery of #666 is its natural home; it is not a substitute for this one, and
building it first would have made the deterministic core look optional.

**It reports; it never repairs.**
A dataset that has already been disclosed cannot be un-disclosed by flipping a flag,
and an automatic fix would destroy the evidence that the guarantee had failed.
The sweep writes ONLY `sweep_stamps` (ADR 0034), on every verdict.

**It files no GitHub issue.**
Every other escalating sweep here does, and this one must not:
`nemarDatasets` is public-facing and shared between production and dev,
so filing the finding would publish it.
The durable record is an `audit_log` row; the depositor and the admins get email,
under a `dataset_anonymity` category of its own rather than riding `publication_request`,
because an admin who stops watching publication requests has said nothing about wanting to
stop hearing that a concealed depositor may have been disclosed.

**What it cannot check is reported, never assumed clean** (ADR 0005, ADR 0054).
Identity inside the recordings themselves,
the recording-identification field of an EDF or BDF header,
`EEG.comments` in an EEGLAB file,
subject fields in a FIFF header,
lives in annexed binaries a Worker will not pull gigabytes to read.
`signal_headers` is therefore in `unchecked` on every run for every dataset,
and the CLI prints that line even for a verified one.
"Verified" means everything this sweep can check is fine, and no surface may imply more.

**The cadence is the candidate predicate.**
Unlike the fidelity sweep, which re-arms on a changed `zarr_source_commit`,
there is nothing to compare against here:
a projection regression, a hand-flipped repository and an EZID status change all happen
with the dataset row untouched.
Every anonymous deposit not attempted in the last 20 hours is a candidate.

## The other half: the flip is now complete

De-anonymization was incomplete, and permanently so.
An anonymous deposit is `visibility = 'public'`, so the Zarr converter picks it up and
bakes the catalog row's attribution into `index.json`'s `citation` and every store's
`nemar` root attribute: the blinded label, and no DOI.
Re-conversion fires on a `latest_version` change or a GLOBAL `ZARR_ENGINE_VERSION` bump,
and publishing out of anonymity causes neither.
The tag comes from the depositor's own `Version` field,
`createTag` treats an existing ref as success,
and the `dataset_versions` row is written by callbacks the anonymous release never reaches.

**Owner decision, 2026-09-16:** anonymous deposits keep converting.
"The data is public so the viewer should be available as well, that is a NEMAR product."
So the fix is to make the flip re-convert rather than to withhold the viewer.

**`sweep_stamps.$.zarr_requeue_at` is the lever, and it is new capability.**
The conversion queue's state is SQLite on the Hallu node, not D1,
so the backend had no way at all to say "re-convert this one dataset" --
only the global engine stamp, which is the wrong tool for one dataset.
The orchestrator writes the stamp when it de-anonymizes,
the catalog row exposes it as a derived field (ADR 0034/0035: no new column),
and `zarr_queue.reconcile` re-queues a `done` row whose stored stamp differs.

It is deliberately NOT behind the engine-bump ack gate.
That gate exists because a global bump can hand the whole archive back at once and a person
should confirm it; this is one dataset, asked for by name, for a reason the archive knows
and the converter does not.
`requeue_stamp` is recorded when the request is honored rather than on completion, so a
request that stays on the catalog row, and nothing clears it, re-queues once rather than on
every hourly tick forever; the ordinary retry machinery owns a failed conversion.

`_requeue_is_stale` reads a NULL stamp with a request in hand as STALE,
which is the opposite of `_engine_is_stale` and not an inconsistency:
the engine stamp is archive-wide, so NULL there would re-convert everything
(hence the seeding in `migrate_schema`),
while this one is per-dataset and its blast radius is the one dataset that was asked for.

## Consequences

- The sweep is PRODUCTION-ONLY on the cron and deliberately absent from
  `DEV_CRON_ALLOWLIST`: it mints a GitHub App token to read private repositories in the
  shared org, and it emails a real depositor. Either disqualifies it.
  The sweep function itself is unguarded so the admin route works on staging.
- It costs two GitHub `core` calls per dataset for the repository tree, plus one raw fetch
  per scanned file. The raw host spends no `core` budget (ADR 0064), and the candidate pool
  is small by construction: anonymous deposits are rare and short-lived.
- The file scan is bounded (40 files, 512 KB each, priority-ordered so root BIDS metadata
  is always read) and reports `deposit_files_beyond_budget` when it did not see everything.
- A future advisory pass is additive: it would add findings at a new severity, and nothing
  above has to change to accommodate it.

## Alternatives considered

- **Keep anonymous deposits out of the Zarr pipeline.** One line, and the blinded
  attribution could never fossilize. Rejected by the owner: the viewer is part of what a
  public dataset gets, and a deposit under review is public.
- **Detect the stale index and let an operator run `hallu-zarr.sh --dataset <id>`.** No new
  mechanism, but a flip that needs a human to finish is not complete, which is this phase's
  stated bar.
- **Repair what the sweep finds.** Rejected in the issue and reaffirmed here: it destroys
  the evidence that a guarantee failed, and it cannot un-disclose anything.
- **A model-guided pass over free text as the primary check.** Available and worth having
  later. Not first: a deterministic finding is reproducible and actionable, an advisory one
  needs a human either way.

## Receipts

- Epic #1406, issue #1409; ADR 0063 (the state this verifies), ADR 0064 (the broker it reads through)
- ADR 0005 (partial data still serves; reporting is never more certain than it is),
  ADR 0034 (the column budget), ADR 0035 (sweep stamps live in one JSON column),
  ADR 0054 (a report arrives whether or not anything is wrong, and unknown is never zero),
  ADR 0041 (a DOI cites a real name or nobody)
- Rules: `backend/src/services/anonymity-sweep.ts`, `scripts/zarr/zarr_queue.py`
- Guards: `backend/test/anonymity-sweep.test.ts` (every check with its control, and the
  three "never swept" shapes), `scripts/zarr/test_zarr_queue.py` (the re-queue, honored
  once, and not held by the ack gate),
  `backend/test/anonymity-publication-paths.test.ts` (the stamp's placement in the flip)
