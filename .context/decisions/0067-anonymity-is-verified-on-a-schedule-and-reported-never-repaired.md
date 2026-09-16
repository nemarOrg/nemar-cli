# ADR 0067: Anonymity is verified on a schedule, and reported, never repaired

**Status:** accepted
**Date:** 2026-09-16
**Owner:** Seyed Yahya Shirazi

Epic #1406, issue #1409.
Follows ADR 0065 (anonymity is pre-publication only) and ADR 0066 (the data-plane broker
this depends on).

## Context

ADR 0065 made anonymity a state the database enforces and put the blind inside every
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

**A declared scope limit is not a gap, and the two must not be spelled the same way.**
`ANONYMITY_DECLARED_SCOPE_LIMITS` holds the things this sweep never looks at:
`signal_headers`, and `deposit_subdirectory_files`
(thousands of acquisition sidecars per dataset, holding parameters rather than prose).
They appear in `unchecked` so a reader of `verified` is told what it does not cover,
and they do NOT withhold the verdict.
Everything else in `unchecked` is a gap that opened on this run, and any one of them
makes the verdict `unverifiable`.
Conflating the two made `verified` unreachable for every real dataset:
the first implementation compared the whole repository tree against the in-scope set,
so any dataset with a `sub-01/` directory reported a budget overrun it never had.
A verdict nothing can reach is a verdict nobody reads, which is ADR 0054's failure
with the sign flipped.

**Every check needs an `unchecked` channel, not only a findings array.**
A `dataset_description.json` with a trailing comma, an `Authors` field holding objects
rather than strings, an `enrichment_json` blob truncated mid-write, an empty tree
listing, a git-annex pointer whose body is a key rather than the content, a 403 from S3:
each is a question that could not be answered, and each used to return "nothing found",
which is how a clean bill of health gets issued for a document nobody could read.
403 in particular is not 404 (`s3-403-is-not-absence`): the bucket denies anonymous
ListBucket, so it covers missing, private, and policy-in-flight alike.

**A check that could not run must never be reported as a disclosure, either.**
The owner-projection check read `.first()` returning `null` as a leak,
because `undefined !== null` is true,
and would have mailed the depositor and every admin an urgent false alarm
for a query that did not return a row.

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
The orchestrator writes the stamp at the END of a successful publication run,
the catalog row exposes it as a derived field (ADR 0034/0035: no new column),
and `zarr_queue.reconcile` re-queues the row when its stored stamp is behind.

**The stamp goes after the DOI is minted, not at the restoration.**
`doi_create` runs after `repo_public`, so a rebuild that raced a stamp written inside the
restoration block would bake the restored attribution with NO DOI, and spend the request
doing it.

**A failed stamp is reported, because nothing else re-checks it.**
The sweep selects `anonymous = 1`; by the time this write happens the row is `anonymous = 0`,
so a dataset that misses its stamp has already left the only pool that would have caught it.
It is non-fatal (the dataset IS published, and what is stale is a derived serving copy,
ADR 0005) but it returns a warning to the approving admin and writes an `audit_log` row.
An earlier version swallowed it behind a comment claiming the sweep would catch it,
which was false.

It is deliberately NOT behind the engine-bump ack gate.
That gate exists because a global bump can hand the whole archive back at once and a person
should confirm it; this is one dataset, asked for by name, for a reason the archive knows
and the converter does not.
`requeue_stamp` is recorded when the request is honored rather than on completion, so a
request that stays on the catalog row, and nothing clears it, re-queues once rather than on
every hourly tick forever.

A request is evaluated for EVERY job status, not only `done`.
"Terminal for this version" (#774) is a statement about the DATA failing to convert;
a rebuild request is about the dataset's METADATA having changed, which the failed attempt
never saw, so it buys one retry on a `failed` row as well.
Two counters are reported, because one cannot say what is needed:
`requeue_requested` counts requests HONORED this run,
`requeue_outstanding` counts rows still carrying a request their stamp is behind.
Reporting only the first renders "asked for and never got" as zero.

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
  per scanned file. The raw host spends no `core` budget (ADR 0066), and the candidate pool
  is small by construction: anonymous deposits are rare and short-lived.
- The file scan is bounded (40 files, 512 KB each, priority-ordered so root BIDS metadata
  is always read) and reports `deposit_files_beyond_budget` when it did not see everything.
- A future advisory pass is additive: it would add findings at a new severity, and nothing
  above has to change to accommodate it.
- The verdict is READ BACK, not only mailed. `GET /datasets/:id` serves
  `anonymity_status`, `anonymity_checked_at`, `anonymity_findings` and `anonymity_unchecked`
  to the owner and to an admin, and `nemar dataset status` renders them. Everyone else is
  served null on those fields, behind the same gate that withholds the identifiers: "this
  deposit has findings" is itself a fact about the person being concealed. Without this the
  mail's own instruction, "run `nemar dataset status`", pointed at a command that showed
  nothing.
- A notification that reached nobody is a result of the run, not a detail of it.
  `sendAnonymityFindingsEmail` returns what it delivered, `AnonymitySweepResult` carries
  `mail_failures`, and the CLI exits non-zero on a non-empty list. For a finding, the mail
  IS the depositor's copy.
- An unchanged set of findings is recorded every run and mailed only when it changes.
  A deposit finding stays true until the depositor edits their own file, so daily mail
  would train both audiences to ignore the one that is new.

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

- Epic #1406, issue #1409; ADR 0065 (the state this verifies), ADR 0066 (the broker it reads through)
- ADR 0005 (partial data still serves; reporting is never more certain than it is),
  ADR 0034 (the column budget), ADR 0035 (sweep stamps live in one JSON column),
  ADR 0054 (a report arrives whether or not anything is wrong, and unknown is never zero),
  ADR 0041 (a DOI cites a real name or nobody)
- Rules: `backend/src/services/anonymity-sweep.ts`, `scripts/zarr/zarr_queue.py`
- Guards: `backend/test/anonymity-sweep.test.ts` (every check with its control, and the
  three "never swept" shapes), `scripts/zarr/test_zarr_queue.py` (the re-queue, honored
  once, and not held by the ack gate),
  `backend/test/anonymity-publication-paths.test.ts` (the stamp's placement in the flip),
  `backend/test/zarr-requeue-flip.test.ts` (the stamp WRITTEN and the catalog projection
  that carries it, both behaviorally: a source-order check stayed green when the write was
  disabled, nulled, or pointed at the wrong row)
- The rule that a finding never carries the text it matched is enforced in
  `backend/test/anonymity-sweep.test.ts`: appending the matched file body to a `detail`
  pasted the concealed depositor's name into `sweep_stamps`, the `audit_log` row and
  forwardable mail at once, and left every other test green.
