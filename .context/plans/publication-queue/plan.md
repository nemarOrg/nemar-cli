# Plan: clear the publication queue (epic #2182, re-sequenced)

Status: DRAFT for owner approval, 2026-11-25.
Lead: Claude Opus 5.5 (this session).
Epic: nemarOrg/nemar-cli#2182, branch `feature/issue-2182-epic-publication-queue` from `origin/dev`.

## Goal

Every publication request in the queue reaches a decision the depositor can understand, check and act on.
That means a published dataset, a denial with reasons, or a block with a remedy.
Each decision is backed by evidence that the depositor can reproduce on their own machine.

Measured 2026-11-25 (read-only, `nemar admin repo publish list --json`):

| Fact | Count |
| --- | --- |
| Active requests | 363 (323 requested, 40 blocked) |
| From one depositor | 351 |
| Screen "needs review" | 234, of which 196 only for `image-or-document-file` |
| Screen "recordings NOT screened" | 60 |
| Screen never run for the request | 57 (40 blocked before the screen, 17 requested) |
| Screen clean | 3 (nm000630, nm000566, nm000979) |
| Publication reviews run in production | 0 (`PUBLICATION_REVIEW_ENABLED` is dev only, #1732) |
| Unscreened formats, by datasets | .snirf 204, .zip 129, .mat 104, BrainVision 86, .nirs 24, NIRx about 20, .set 12, .fif 7 |

## Principle: transparent, documented, reproducible

The owner's rule (2026-11-25) is the product's advantage, and it binds every step:

1. **One vocabulary.**
   Every finding kind, screen status, review reason and license outcome has one entry in a typed table.
   The entry holds a plain statement of what was found, what was read, the remedy, and a docs.nemar.org anchor.
   The typecheck fails if an entry is missing.
   Mails, the CLI, the web page and the docs all print from that table (ADR 0045's pattern).
2. **Reproducible.**
   A depositor can run `nemar dataset screen <path>` on their own copy and get the same report the server got, from the same scanner version.
   License lineage is reproduced by `nemar dataset license-check <path>`, which uses the same resolver and the same registry calls.
   Every report names its scanner commit, its reader versions and, for a review, the model, the prompt version and the digest of the inputs.
3. **Honest coverage.**
   A file that was not read, was read only partly, or failed to read is said to be so; it is never counted as clean (ADR 0086).
   A missing companion file is a coverage problem, not an identifier finding.
4. **The automated decision says it is automated.**
   A denial says an automated agent decided it, gives each reason with its remedy and reproduce command, and tells the depositor how to resubmit with a note.

## Owner decisions (2026-11-25)

- The queue comes first.
  Naming policy (#2183) waits.
  The preflight (#2184) and the documentation (#2189) move into the queue track as A9 and A10, because they carry the reproducibility rule.
- Readers are pure TypeScript in nemar-cli.
  No package-registry code runs next to the screen's storage credentials.
- Model input is metadata, never data.
  It may include enrichment, the structural summary, upstream registry records and the screen's coverage counts.
  ADR 0102 §2 stays in force.
- Automatic denial happens as nemarAdmin, only on a real `fail` verdict with reasons.
  It never happens when the model did not run, errored, or returned unknown.
  The mail says the decision was automated and invites a resubmission.
  A resubmission carries a note field: whether the agent was wrong, and what changed since the last submission.
  This supersedes part of ADR 0102 through a new ADR (B2).
- On a pass, the admin is mailed a summary: identifier checks passed, license lineage confirmed, ready to approve.
  Approval stays the administrator's own act (ADR 0093, ADR 0102).
- License: confirm the upstream license through DataCite, Crossref and OpenAlex.
  NC is accepted; ND, all rights reserved, or no license found needs explicit permission.

## Two releases

The screen workflow checks out nemar-cli `main`, so a new reader starts working only after a production release.

- **Release 1 (track A): screening.**
  New readers, the coverage contract, local reproduction and the docs.
  The epic branch merges into `dev` at checkpoint CP2; the owner releases.
  Then the owner re-runs the screen on the queue (O2).
- **Release 2 (track B): review and decisions.**
  License lineage, the ADR, the review extension, automatic denial, the resubmission note and the ready-to-approve mail.
  It runs on a second epic branch from `dev` under the same epic issue.
  The owner enables the review in production per #1732.

## Steps

Tiers: `lead` (this session), `worker-hard`, `worker`; see the board's Parity table.
Every code step lands as one PR into the epic branch and gets its own `project:pr-review-toolkit` review.

| ID | Goal | Depends | Tier | Card |
| --- | --- | --- | --- | --- |
| O1 | Owner approves the three clean requests after reading their screen | none | owner | none (owner action) |
| A1 | Coverage contract: per-format reader registry, report v2, honest per-format counts, remedy and docs per kind and status | none | worker-hard | cards/A1.md |
| A3 | Bounded pure-TS HDF5 metadata reader, checked against h5py on real files | none | worker-hard | cards/A3.md |
| A7 | Measure what trips `image-or-document-file` across the queue; propose policies | none | worker | cards/A7.md |
| B1 | Upstream license lineage resolver (DataCite, Crossref, OpenAlex), compatibility rule, local `license-check` | none | worker-hard | cards/B1.md |
| A2 | BrainVision (.vhdr, .vmrk) and NIRx text headers (.hdr, .inf) readers | A1 | worker | cards/A2.md |
| A4 | SNIRF screening (multiple nirs groups, metaDataTags, labels) and generic HDF5 string scan | A1, A3 | worker-hard | cards/A4.md |
| A5 | MAT v5 reader, EEGLAB .set (classic and v7.3), Homer .nirs, generic .mat, .fdt companion check | A1, A3 | worker-hard | cards/A5.md |
| A6 | ZIP central directory: entry names scanned, small inner recordings read by the registry | A1 | worker | cards/A6.md |
| A9 | `nemar dataset screen <path>`: the server's report, reproduced locally and without mutation | A1 | worker | cards/A9.md |
| A8 | Image and document rule change, per the owner's policy from A7 | A7, A1 | worker | outline, completed at CP1 |
| A10 | docs.nemar.org: one page per vocabulary table, generated from it, with reproduce and remedy | A2, A4, A5, A6, A9 | worker | outline, completed at CP1 |
| CP2 | Seam review of track A, epic into `dev`, owner releases, owner re-screens the queue (O2) | A2, A4, A5, A6, A8, A9, A10 | lead + owner | checkpoints.md |
| B2 | ADR: automatic denial, model inputs, resubmission note, ready-to-approve mail, review reproducibility | none | lead | written by the lead, approved by the owner |
| B3 | Resubmission note on the publication request (migration, route, CLI, web form copy) | B2 | worker | outline, completed after B2 |
| B4 | Review inputs: enrichment, registry records, coverage counts, license lineage; report reproducibility fields | B1, B2 | worker-hard | outline, completed after B2 |
| B5 | Automatic deny as nemarAdmin on a real fail; ready-to-approve admin mail on pass | B2, B3, B4 | worker-hard | outline, completed after B2 |
| C1 | Calibration on a labeled sample of the queue (dev only), with zero false automatic denials | B5 | lead + worker | outline |
| C2 | Release 2, then the owner enables the review in production per #1732 | C1 | owner | checkpoints.md |

Later, outside this plan: #2183 naming policy; .fif and .nwb readers; filing recommendations as issues.

## Section 0: how the manager uses this plan

1. Start prompt: see `runbook.md`.
   Pacing: 30 minutes while workers run, 60 minutes while waiting on people.
2. The tick is the `project:manager-loop` tick, as `runbook.md` adapts it.
3. Precedence: the owner's later instructions override this plan and are logged with `decide`.
   `AGENTS.md` overrides this plan everywhere: no edits in the primary checkout, no version bump, no production commands by agents, no owner switches.
4. Merge authority: the manager squash-merges step PRs into the epic branch after the merge gate.
   It never merges the epic into `dev`, `dev` into `main`, anything in `nemarDatasets/*`, or the docs repo's production branch.
   It never runs a production command; it hands each one to the owner as an exact command.
5. Question classes that may take a default at their deadline: none.
6. Routing: lead tier for design and contested findings; frontier tier only when the owner asks.
   The lead and the manager are this one session (owner to confirm at approval); every judgment call is recorded with `decide`.
