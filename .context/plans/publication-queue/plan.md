# Plan: clear the publication queue (epic #2182, re-sequenced)

Status: DRAFT v2 for owner approval, 2026-11-25.
It folds in the executability and design reviews (appendix) and the owner's second round of decisions.
Lead: Claude Opus 5.5 (this session); manager: the same session (owner to confirm).
Epic: nemarOrg/nemar-cli#2182.
There are two epic branches from `origin/dev`:

- `feature/issue-2182-epic-pq-decide` (lane D), whose worktree is `/Users/yahya/Documents/git/nemar/nemar-cli-worktrees/epic-pq-decide`.
- `feature/issue-2182-epic-pq-evidence` (lane E), whose worktree is `/Users/yahya/Documents/git/nemar/nemar-cli-worktrees/epic-publication-queue`.
  It holds this plan pack.

## Goal

Every publication request in the queue reaches a decision the depositor can understand, check and act on.
That means a published dataset, a denial with reasons, or a block with a remedy.
Each decision is backed by evidence that the depositor can reproduce.

## Measured 2026-11-25

These were read with `nemar admin repo publish list --json`, read-only.

| Fact | Count |
| --- | --- |
| Active requests | 363: 323 requested, 40 blocked (37 `min_requirements_failed`) |
| From one account | 351, from `bruaristimunha` (our group's batch conversions) |
| Screen states | 234 needs review, 60 recordings not screened, 57 never screened (40 of them blocked), 7 EDF-only clean, 3 clean, 1 incomplete, 1 error |
| Publication reviews run in production | 0 (`PUBLICATION_REVIEW_ENABLED` is dev only, #1732) |
| Requests with no blocker left (of 306 screened and requested), as steps land | none: 3; images only: 4; BrainVision/NIRx only: 21; SNIRF, MAT or ZIP alone: 4, 5 or 5; **all five: 154** |
| Formats nobody would read even then, by datasets | files with no extension 59, .other 26, .rar, .fig, .npy, .nev, .avg and others |

**Conclusion (owner, 2026-11-25): two lanes.**
Readers alone cannot clear the queue: most requests carry several blockers, and about half keep an unread format.
So lane D makes a documented decision possible for every request now, and lane E improves the evidence behind those decisions.

## Principle: transparent, documented, reproducible

This is the owner's rule of 2026-11-25, and every step is bound by it.

1. **One vocabulary.**
   Every finding kind, screen status, incomplete reason, review reason, license outcome and acknowledgment group has one entry in a typed table.
   The entry holds a plain statement, what was read, the remedy and a docs anchor, and a missing entry fails the typecheck.
   Mails, the CLI, the web page and the docs print from these tables (ADR 0045's pattern).
2. **Reproducible.**
   - `nemar dataset screen` recomputes the screen, and says exactly what a local run cannot see.
   - `nemar dataset license-check` recomputes the license lineage with the same resolver.
   - A review shows its inputs' digest, its prompt version and its models.
   - A model verdict is not claimed to be repeatable; its inputs are.
3. **Honest coverage.**
   Not read, partly read and failed are each said as such and never counted as clean (ADR 0086).
   A missing companion file is a coverage gap, not an identifier finding.
4. **An automated decision says it is automated** (ADR 0139, proposed).
5. **A batch acknowledgment is a documented act.**
   Each acknowledgment group has a published page saying what the group is, why it is acceptable, and who acknowledged it when.
   The recorded reason links to that page.

## Owner decisions

Round 1 is in memory and in ADR 0139.
Round 2, 2026-11-25:
- two lanes;
- enable the existing review in production in shadow first, on a batch of 20;
- measure images and documents in HEAD and in history, batch-acknowledge the harmless groups with a documented reason, and look at the risky groups one by one;
- build a quiet re-screen mode with a digest before any queue re-screen.

## Lane D: decide

| ID | Goal | Depends | Tier | Card |
| --- | --- | --- | --- | --- |
| O1 | The owner approves the three clean requests | none | owner | the commands are in checkpoints.md |
| D0 | Review in production, shadow: a PR adds `PUBLICATION_REVIEW_ENABLED` to production `[vars]`, with ADR 0102 item 7's staging evidence; the owner merges and releases, then starts reviews on 20 requests and compares them with their judgment | none | lead, then owner | cards/D0.md |
| D1 | Upstream license lineage resolver, compatibility rule, `nemar dataset license-check`, read-only admin view | none | worker-hard | cards/D1.md |
| D2 | Measure every blocker in the queue, in HEAD and history: image and document groups, files with no extension, unknown formats | none | worker | cards/D2.md |
| D3 | Batch acknowledgment: documented groups, one admin act per group with a recorded reason that links to the group's page | D2 | worker-hard | outline; completed at CP-D1 after the owner picks groups from D2 |
| D4 | Quiet re-screen: an admin batch re-screen, paced, with no per-request mail and one digest | none | worker | cards/D4.md |
| B2 | ADR 0139: automatic denial (off, shadow or on), model inputs, resubmission note, ready-to-approve mail, review record | none | lead, then owner | the draft is on the decide branch |
| B3 | Resubmission note on the publication request | B2 | worker | outline; CP-D2 |
| B4 | Review inputs widened to metadata (enrichment, registry records, lineage, coverage counts), and the review record | D1, B2 | worker-hard | outline; CP-D2 |
| B5 | Automatic deny in shadow mode, then on; the pass mail "Ready to approve" | B2, B3, B4 | worker-hard | outline; CP-D2 |
| C1 | Calibration in production shadow mode: zero false would-denies on the owner-labeled sample | B5, D0 | owner + lead | outline |

Lane D releases go through `dev`: D1, D4 and B2 to B5 merge into the decide branch.
The epic PR into `dev` is opened at CP-D3 and merged by the owner.

## Lane E: evidence

| ID | Goal | Depends | Tier | Card |
| --- | --- | --- | --- | --- |
| A1 | Coverage contract: reader registry, `RangeSource` with per-reader limits and a page cache, report v2 (accepted by the Worker), the door's new keys, superseded recordings for every reader, copy tables with remedies, and a shared report builder | none | worker-hard | cards/A1.md |
| A3 | Bounded pure-TS HDF5 metadata reader, checked against h5py | none | worker-hard | cards/A3.md |
| A4 | SNIRF and generic HDF5 readers | A1, A3 | worker-hard | cards/A4.md |
| A2 | BrainVision and NIRx text headers | A1 | worker-hard | cards/A2.md |
| A5 | MAT v5, EEGLAB `.set` (classic and v7.3), Homer `.nirs`, generic `.mat` | A1, A4 | worker-hard | cards/A5.md |
| A6 | ZIP archives | A1 | worker-hard | cards/A6.md |
| A9 | `nemar dataset screen`: local reproduction, stating its gaps | A1 | worker | cards/A9.md |
| A10 | docs.nemar.org pages generated from the copy tables, live before release | A2, A4, A5, A6, A9 | worker | outline; CP-E1 |

**Reader merge gate (the owner's rule: false positives measured).**
Each reader card runs its reader over public copies of upstream data that the queue converts: OpenNeuro's public S3 and PhysioNet open data.
It reports the findings per kind per 100 files.
- Identifier-severity findings on these public datasets must be 0, or each one is explained.
- Review-severity findings must be at most 5 per 100 files.

Lane E's release order: the Worker parses report v2 before any screen emits it.
A1 makes the Worker accept v2 in the same release that switches the emitter.
A screen that runs in the deploy window is re-run with D4.

## Section 0: how the manager uses this plan

1. Start prompt: `runbook.md`.
   Pacing: 30 minutes while workers run, 60 minutes while waiting on people.
2. The tick is the `project:manager-loop` tick, as `runbook.md` adapts it.
3. **Precedence.**
   - The owner's later instructions override this plan and are logged with `decide`.
   - `AGENTS.md` overrides this plan, with one exception the owner approves with this plan: manager-loop drives the epic in place of a hand-run `/project:epic-dev`.
     `.claude/epic.local.md` records both branches and points here.
4. **Merge authority.**
   - The manager squash-merges step PRs into their lane's epic branch after the merge gate in `runbook.md`.
     The phase-PR gate is local, per the owner's rule of 2026-10-26: typecheck, lint, biome on the touched files, the targeted tests, and the pure unit tier.
     The remote live tier is not awaited, and its skip is noted on the PR.
   - It never merges an epic into `dev`, anything into `main`, anything in `nemarDatasets/*`, or the docs repository.
   - It never runs a production or staging command; it hands each one to the owner as an exact command.
5. Question classes that may take a default at their deadline: none.
6. **Routing.**
   - Lead tier for design and contested findings.
   - Frontier tier only when the owner asks.
   - Implementers on Sonnet 5.5 for `worker` cards and on Opus 5.5 for `worker-hard` cards.
   - Reviewers on Sonnet 5.5 (owner rule).

## Appendix: pack review dispositions

- **Design review (13 findings).**
  - 1: fixed by the measurement above and the two lanes.
  - 2: fixed in D2 (history).
  - 3, 4, 6, 9 and 10: fixed in A1, D1 and A9.
  - 5: fixed by the A2/A4/A5 severity rules and the reader merge gate.
  - 7: fixed by D4.
  - 8: fixed by D2 (blocked requests are classified), D3 (batch acknowledgment) and a throughput note in risks.md.
  - 11: fixed in risks.md.
  - 12: fixed in ADR 0139.
  - 13: fixed in ADR 0139 decision 8 (the pass mail requires the gate to be `clear`).
- **Executability review (32 findings).**
  - 1 and 2: fixed (the branches are pushed at setup; B2 is `owner`).
  - 3: fixed (local phase gate).
  - 4: fixed (`*.integration.test.ts` naming; CLI-spawn tests in their own files).
  - 5: fixed (two lanes).
  - 6 to 29: fixed in the cards and the runbook.
  - 30 to 32: fixed.
