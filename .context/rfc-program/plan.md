# RFC program: plan

**Status:** revised after the C0 pack review, 2026-11-20; waits for the owner's approval (step O0).
**Owner:** Seyed Yahya Shirazi.
**Lead:** Opus (lead tier) wrote this pack; a Sonnet manager runs it with the `project:manager-loop` skill.

This program sets up NEMAR's Request for Comment (RFC) process and takes the first two RFCs to the point where the owner opens them.
An RFC is how NEMAR asks the community before a decision that people outside NEMAR will implement, cite or depend on.
The analysis behind this plan is in two planning notes that the lead read in full:
[`research/rfc-mechanics.md`](research/rfc-mechanics.md) (process design, and the weight of a versioning change)
and [`research/biosig-zarr-repo.md`](research/biosig-zarr-repo.md) (the specification repository and the outline of RFC-0001).
Where those notes and this plan disagree, this plan wins; where this plan and an Architecture Decision Record (ADR) disagree, the ADR wins.

## 0. How the manager uses this plan

### 0.1 Start prompt

Run it on Claude Code as `/loop ` followed by this text, with no interval:

```text
You are the manager of NEMAR's RFC program.
Run one tick of the runbook at /Users/yahya/Documents/git/nemar/nemar-cli-worktrees/rfc-program/.context/rfc-program/runbook.md, exactly as written, using the project:manager-loop skill.
The state is the board beside it: /Users/yahya/Documents/git/nemar/nemar-cli-worktrees/rfc-program/.context/rfc-program/board.md.
Your manager id is mba-claude-sonnet, the same on every tick.
Do not write product code.
Do not change the plan, a card, a gate, the parity, or a budget limit.
When the runbook says to stop or to ask, or does not cover what you see, record it on the board, ask the owner with a structured question, and stop that thread of work.
```

Pacing: 30 minutes while a worker runs, 60 minutes while everything waits on the owner.

### 0.2 The tick

The tick is the skill's tick, with the project rules in [`runbook.md`](runbook.md).

### 0.3 Precedence

The owner's later instructions override this plan; the manager records each with `decide --by owner`.
The repository's `AGENTS.md` overrides this plan, with no exception.
The owner decisions of 2026-11-20 (section 2) are settled; a worker or reviewer who argues against one is answered by citing it, not by reopening it.

### 0.4 Merge authority

| Pull request (PR) | Who merges |
| --- | --- |
| Step PRs into `feature/rfc-program` in nemarOrg/nemar-cli (A1, A2, V1, S1, N1) | the manager, after the merge gate |
| Tooling PRs into `main` of nemarOrg/rfcs (R1) | the manager, after the merge gate |
| Step PRs into `main` of nemarOrg/biosig-zarr (B1, B2) | the manager, after the merge gate |
| The version 3 text PR in nemarOrg/biosig-zarr (B6, branch `draft/3.0.0`) | nobody before RFC-0001 is accepted; then the owner |
| B5a's PR into `main` of nemarOrg/biosig-zarr (the version 2 schemas and vectors, editorial by the owner's ruling Q33) | the manager, after the merge gate, with a merge commit |
| B5's PR into `draft/3.0.0` of nemarOrg/biosig-zarr (not into `main`) | the manager, after the merge gate, with a merge commit |
| B4b's commit on the open RFC-0001 draft PR | nobody merges; the PR stays a draft |
| B7's PR into `main` of nemarOrg/biosig-zarr (the independence wording, editorial by the editor's ruling under Q39) | the manager, after the merge gate, with a merge commit |
| B7b's PR into `draft/3.0.0` of nemarOrg/biosig-zarr (not into `main`) | the manager, after the merge gate, with a merge commit |
| B4c's commit on the open RFC-0001 draft PR | nobody merges; the PR stays a draft |
| B4d's commit on the open RFC-0001 draft PR | nobody merges; the PR stays a draft |
| RFC text PRs in nemarOrg/rfcs (B4, V2) | nobody until the owner opens the RFC: merging one with `opened_at` set is the act of opening it |
| Any PR to nemarOrg/docs (R2, B3, SC1) | the owner, or the manager when the owner authorizes it for that PR (runbook, "Never"); a docs merge publishes |
| `feature/rfc-program` into `dev` | the owner, through `/project:epic-dev --finalize`; never an admin merge |
| Settings, rulesets, tags and releases | the owner, from the exact commands in section 5 or a merged, reviewed file; or the manager, when the owner says so for that step (runbook, "Never") |
| Repository creation or deletion, Discussions and their categories, announcements, comments on other repositories | the owner only |

### 0.5 Defaults

No question takes a default answer.
Silence is never an answer.

### 0.6 Routing

No frontier trigger is listed: the frontier tier (Fable) is used only when the owner asks.
The lead tier (Opus) writes the outline cards at checkpoints, answers escalations, and implements B4 (the RFC-0001 text), which is judgment-heavy writing.

## 1. Goal

When this program ends:

1. nemarOrg/rfcs exists, holds the process, the template, the index and two working checks (`rfc-check` and `rfc-clock`), and is protected by a ruleset that requires `rfc-check`.
2. An ADR in nemar-cli adopts the process, marked provisional, to be reviewed after the first two RFCs.
3. docs.nemar.org has a page `/policies/rfcs/` that explains the process and links to the index.
4. nemarOrg/biosig-zarr exists, initialized with `/project:init-project`, holding the specification text moved from docs.nemar.org and relicensed, tagged `2.0.0` by the owner; docs.nemar.org points to it instead of copying it.
5. An ADR supersedes the parts of ADR 0128 the owner changed (A2), and the version 3 text RFC-0001 proposes sits on `draft/3.0.0`, tagged `3.0.0-draft.1` (B6, O4b).
6. The back catalog the rollout touches is measured (S1), and the announcements are drafted (N1).
7. The RFC-0001 text (the whole biosig-zarr format, with `.bzx` as its single-file form) is reviewed and waits as a draft PR for the owner to open it.
8. The counts that RFC-0002 needs are measured, and the RFC-0002 text (dataset version legibility) is reviewed and waits as a draft PR for the owner to open it.

Opening an RFC, deciding it, and announcing it are the owner's acts, outside the manager's reach.

## 2. Owner decisions of 2026-11-20

1. **One home.** One public repository, nemarOrg/rfcs, holds the record and the one number space (`NEMAR RFC 0001`).
   Every comment thread, including one for an RFC about a single dataset, is a Discussion in nemarOrg/rfcs.
   No dataset repository gets Discussions, and the NEMAR GitHub App gets no new permission.
2. **The window.** At most 21 calendar days.
   One extension of at most 14 days, granted before the close with a stated reason, so no RFC runs longer than 35 days.
   RFC-0001 uses the same window; the six weeks suggested in the planning note are rejected.
3. **biosig-zarr now.** nemarOrg/biosig-zarr is created now for the whole format, ahead of the "at beta" trigger recorded in neuromechanist/biosigio#179, which the owner amends with a comment.
   It is initialized with `/project:init-project`.
   The license is the one decided on 2026-11-18: the World Wide Web Consortium (W3C) Software and Document License for the text, and Apache License 2.0 for schemas, conformance vectors and code.
4. **RFC-0001 is one RFC** for the whole biosig-zarr format, with `.bzx` as its single-file form.
   It explains why the format and the package carry separate names (the store, and the packing of one store into one file),
   and puts the package-specific items up for comment:
   that the commenters differ (the whole biosignal community, including electroencephalography (EEG) and magnetoencephalography (MEG), and people who build Zarr tools);
   the names `.bzx` and `biosig-zarr`;
   what a `.bzx` snapshot of a Brain Imaging Data Structure (BIDS) dataset changes around the package (rewritten sidecar fields, `events.parquet` left out, the light events group);
   and whether a fix to the packing rules raises `format_version` (the RFC recommends one `format_version` for both).
5. **OME-Zarr RFC-9 is prior art, not a dependency.**
   NEMAR's packing rules are its own and do not follow later changes to RFC-9; RFC-0001 states this independence as an advantage.
6. **RFC-0001 has a section "Why not NWB on Zarr"**, grounded in ADR 0128 and open for comment (Neurodata Without Borders, NWB).
7. **"Why not NWB on Zarr" names `hdmf-zarr` and is fair.**
   It names `hdmf-zarr` and links `https://nwb.org/tools/core/hdmf-zarr/`, says plainly that it is a great tool,
   and then gives the reasons it does not fit NEMAR's case, grounded in ADR 0128:
   NEMAR serves human, low-frequency biosignals organized around signal files that follow BIDS principles,
   where a data file sits beside its metadata sidecars, rather than a container that holds the metadata.
   ADR 0128 supplies the three reasons (separate scope, technical incompatibility, an unsettled NWB Zarr specification) and its revisit conditions.
8. **Irregular and sparse time series are a requirement.**
   European Data Format (EDF) cannot represent irregularly or sparsely sampled time series, and RFC-0001 must address it:
   as a proposed specification requirement and as a question for commenters.
   Checked 2026-11-20: the pre-beta draft does not cover it.
   Its "Time axis" paragraph says level 0 is uniformly sampled, and its open question 9 says a recording that is not continuous has no representation, with one uniform time axis per group and no per-sample timestamps.
   The owner cites the BIDS Extension Proposal 047 (BEP047) discussion; see section 7 for what was found.
9. **An explicit sample resolution field.**
   biosig-zarr and `.bzx` carry the sample resolution in the header metadata
   (bit depth such as 8, 16, 24 or 32, and integer or floating point),
   with its relation to the stored data type and to the per-channel `scale` and `offset` stated.
   Checked 2026-11-20: the draft has a partial equivalent only.
   The root `dtype` (`"int16"` or `"float32"`) is the storage type of every array, and the level-0 `scale` and `offset` define `physical = digital * scale + offset`;
   nothing records the source recording's own resolution (a 24-bit amplifier quantized into an `int16` store is not visible).
   RFC-0001 makes `dtype` explicitly the storage resolution and proposes a new required field for the source resolution, as a requirement and a question for commenters.
10. **RFC-0002 is not pre-decided.**
   Its goal: tell versions made by the dataset's source (its authors, or upstream for a mirror) apart from additions by NEMAR or others,
   and fix the legibility problem that every mirror re-pull is a major version (ADR 0006), which is hard for people to follow.
   The RFC presents the problem and the options with their measured costs:
   an origin recorded for each version, with the upstream tag shown;
   revisiting the rule that a re-pull is a major version;
   and `+N` or another version grammar.
   It opens after RFC-0001 closes, and after a read-only count of the version Digital Object Identifiers (DOIs) already minted.
11. **Later owner decisions** (2026-11-20, recorded in `board-log.md` Decisions, which override anything above):
   D1 to D12 of the time and resolution design are adopted and RFC-0001 proposes them as `format_version` 3;
   RFC-0001 addresses the whole biosignal community, opens with the measured impact, defines "store" as a biosig-zarr store, and ends with a history of the format;
   the moved text is tagged `2.0.0`, a full release whose notes list the four parts the text marks Proposed; RFC-0001's text is `3.0.0-draft.1`;
   the owner relicenses the specification text to the agreed licenses, recorded in `LICENSE.md`, and the format page on docs.nemar.org is removed and replaced by a pointer;
   at most one RFC is open for comment at a time, enforced by `rfc-check`;
   the program has a public epic issue made with `/project:epic-dev` (step E0), and the manager loop drives the steps.
   On 2026-11-20 (Q37/Q38) the owner made biosig-zarr independent of NEMAR: the copyright holder of its text is "the biosig-zarr contributors", and its files name NEMAR only as the text's origin and as its first implementer (cards B7, B7b and B4c; releases `2.0.2` and `3.0.0-draft.3`; published tags stay).
   Since then, decision 5's "NEMAR's packing rules" reads as biosig-zarr's own packing rules; their independence from RFC-9, and the RFC's stating it as an advantage, are unchanged.

## 3. Lead decisions made while writing this pack

1. **RFC-0001's text lives in nemarOrg/rfcs**, at `text/0001-biosig-zarr.md`, because of the one number space.
   nemarOrg/biosig-zarr has no `rfc/` directory; its README links to the RFC.
   This replaces the `rfc/` directory in the planning note's layout.
2. **A draft RFC is a PR, not a merged file.**
   The draft PR takes its number when it is opened (the next number unused by merged files and by every PR, open or closed, that ever added a `text/` file), and a number is never reused, even when a draft is withdrawn.
   Merging the PR with `opened_at` and `discussion` set is the act of opening the RFC, so only the owner merges an RFC text PR.
3. **No reader or writer library lives in nemarOrg/biosig-zarr.**
   Python packing goes to biosigIO and TypeScript reading to nemar-cli, outside this program.
4. **B2 moves the text with no normative change.**
   The explicit sample resolution field, the irregular and sparse series requirement, and the independence from RFC-9 (owner decisions 5, 8 and 9) are proposed in RFC-0001 (B4), not written into the moved text,
   so the move stays verifiable word for word; B2's report gives B4 the line numbers to quote.
5. **The schemas and conformance vectors (B5)** were an outline until the owner answered Q9 (the vectors live in biosig-zarr; nemar-cli vendors them by digest) and Q10 (text plus schemas and a few real vectors, no packer); the lead completed the card at checkpoint C1.
   The owner ruled, as editor (Q33), that the version 2 schemas and vectors, which only transcribe the `2.0.0` text, are editorial: B5a puts them on `main`, released as `2.0.1` (O4d).
   B5 then puts the version 3 schemas and vectors on `draft/3.0.0`, after taking `main` in, so the draft carries both; `3.0.0-draft.2` is tagged on it (O4c), and B4b points RFC-0001 at it.
   Q9 amends nemar-cli's proposed ADR 0124 decision 3: format-level vectors are canonical in biosig-zarr and vendored into nemar-cli by release tag and manifest digest, while the NEMAR-profile cases stay in nemar-cli; the lead's card A3 records it now in a nemar-cli ADR (Q34).
6. **Issue 2217's in-place patch is withdrawn** (the lead's reading of D2 and ADR 0128's "never patched afterward"): the rename of the format tag lands with the version 3 writer through re-conversion; A2 records it, and the owner confirms it on the A2 PR.
7. **Where decisions are recorded:** specification decisions in nemarOrg/biosig-zarr's `.context/decisions/`, NEMAR profile and rollout decisions in nemar-cli, each linking its RFC.
8. **The version 3 text lives on the branch `draft/3.0.0`** in nemarOrg/biosig-zarr; `main` carries only accepted text.
9. **Readers refuse version 3 before it is served:** every NEMAR reader refuses a store whose `format_version` is above 2, and the dataset index records each store's `format_version`, before any version 3 store reaches the serving bucket (design review, finding 1); RFC-0001 states it as a rollout rule and C3 puts it first in the follow-through.
10. **The interim EDF+D fix is owned outside this program:** neuromechanist/biosigio#180, step 1 (refuse EDF+D and BDF+D sources with gaps), is a draft PR by a worker, owned by the owner as biosigIO's maintainer; RFC-0001 cites it, and S1 counts the affected stores.

## 4. Steps

| ID | Goal | Tier | Depends | Owns | Repository and integration branch |
| --- | --- | --- | --- | --- | --- |
| O0 | The owner approves this plan; the lead pushes `feature/rfc-program` | owner | C0 | the approval | nemar-cli |
| E0 | The lead creates the public epic issue and sub-issues with `/project:epic-dev` | lead | O0 | the epic issue, `.claude/epic.local.md` | nemar-cli |
| O1 | The owner creates nemarOrg/rfcs and turns on its Discussions (repository and Discussions done 2026-11-20; two browser steps remain) | owner | none | settings | nemarOrg/rfcs |
| O2 | The owner creates nemarOrg/biosig-zarr and amends biosigio#179 (done 2026-11-20) | owner | none | settings, one comment | nemarOrg/biosig-zarr |
| V1 | The counts RFC-0002 needs are measured, read-only | worker | none (PR after O0) | `.context/rfc-program/evidence/` | nemar-cli, `feature/rfc-program` |
| A1 | An ADR adopts the RFC process, provisional | worker | O0 | `.context/decisions/` | nemar-cli, `feature/rfc-program` |
| A2 | An ADR supersedes the parts of ADR 0128 the owner changed | lead | O0 | `.context/decisions/` | nemar-cli, `feature/rfc-program` |
| S1 | The back catalog the rollout touches, and conversion throughput, are measured read-only | worker | O0 | `.context/rfc-program/evidence/` | nemar-cli, `feature/rfc-program` |
| R1 | nemarOrg/rfcs holds the process, template, schema, index, `rfc-check` and `rfc-clock`, all tested | worker-hard | O0, O1 | the whole repository | nemarOrg/rfcs, `main` |
| O1b | The owner adds the `main` ruleset requiring `rfc-check` | owner | R1 | settings | nemarOrg/rfcs |
| R2 | docs.nemar.org has `/policies/rfcs/` | worker | A1, R1, Q17 answered | `src/content/docs/policies/rfcs.md`, sidebar | nemarOrg/docs, `main` (owner merges) |
| R3 | The weekly report shows the open RFCs and when `rfc-clock` last ran | worker-hard | R1 | the weekly report's RFC section (card R3, written at C1a) | nemar-cli, `feature/rfc-program` |
| B1 | biosig-zarr is initialized with `/project:init-project`, plus the files it does not create | worker-hard | A2, Q8 answered | the whole repository | nemarOrg/biosig-zarr, `main` |
| B2 | The specification text is moved into `spec/index.md` as plain Markdown | worker | B1, Q11 answered | `spec/`, `CHANGELOG.md`, `README.md` | nemarOrg/biosig-zarr, `main` |
| O4 | The owner tags `2.0.0` | owner | B2 | one tag | nemarOrg/biosig-zarr |
| B3 | docs.nemar.org's format page becomes a pointer to nemarOrg/biosig-zarr | worker | O4 | the format page | nemarOrg/docs, `main` (owner merges) |
| B6 | The version 3 text RFC-0001 proposes, on `draft/3.0.0` | lead | O4, A2 | `spec/` on `draft/3.0.0` | nemarOrg/biosig-zarr, draft PR left open |
| O4b | The owner tags `3.0.0-draft.1` | owner | B6 | one tag | nemarOrg/biosig-zarr |
| B4 | The RFC-0001 text is written and reviewed as a draft PR | lead | R1, B2, A2 | `text/0001-biosig-zarr.md` | nemarOrg/rfcs, PR left open |
| A3 | An ADR supersedes ADR 0124 decision 3 in part: format-level vectors are canonical in biosig-zarr, nemar-cli vendors them (Q9, Q34) | lead | Q9, Q34 | `.context/decisions/` | nemar-cli, `feature/rfc-program` (merges only once every lower-numbered ADR is on its base) |
| B5a | Version 2 schemas and vectors on `main` (Q33) | lead | B2, O4, Q9, Q10, Q33 | `schemas/v2/`, `conformance/`, `tools/`, `conformance.yml` | nemarOrg/biosig-zarr, `main` (manager merges) |
| O4d | The manager, on the owner's say-so, releases `2.0.1` on B5a's merge commit | owner | B5a | one release | nemarOrg/biosig-zarr |
| B5 | Version 3 schemas and vectors on `draft/3.0.0`, with `main` taken in | lead | B5a, O4d, B6, Q9, Q10 | `schemas/v3/`, additions to `conformance/` and `tools/` | nemarOrg/biosig-zarr, `draft/3.0.0` (manager merges) |
| O4c | The manager, on the owner's say-so (Q36), tags `3.0.0-draft.2` on B5's merge commit | owner | B5 | one tag | nemarOrg/biosig-zarr |
| B4b | RFC-0001 points at `3.0.0-draft.2` and states the license of quoted text | lead | O4c | `text/0001-biosig-zarr.md` on the open draft PR | nemarOrg/rfcs, PR left open |
| B7 | biosig-zarr `main` names NEMAR only as the text's origin and first implementer, the holder is "the biosig-zarr contributors", and ADR 0005 records it (Q37/Q38) | lead | Q37/Q38, Q39, Q40, Q41, Q42 | `LICENSE.md`, `GOVERNANCE.md`, `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `AGENTS.md`, `.rules/`, `.context/plan.md`, `.context/decisions/` (new ADR 0005 and the index), `spec/version-history.md` | nemarOrg/biosig-zarr, `main` (manager merges) |
| O4e | The manager, on the owner's say-so, releases `2.0.2` on B7's merge commit | owner | B7 | one release | nemarOrg/biosig-zarr |
| B7b | `draft/3.0.0` takes `2.0.2` in and its draft-only text drops NEMAR as decider | lead | B7, O4e | the merge, three lines of `spec/index.md`, `CHANGELOG.md`, `spec/version-history.md` on `draft/3.0.0` | nemarOrg/biosig-zarr, `draft/3.0.0` (manager merges) |
| O4f | The manager, on the owner's say-so, tags `3.0.0-draft.3` on B7b's merge commit | owner | B7b | one tag | nemarOrg/biosig-zarr |
| B4c | RFC-0001 points at `3.0.0-draft.3`, carries the new notice, and calls nothing in biosig-zarr NEMAR's (plus B4b's two held suggestions) | lead | B4b, O4e, O4f | `text/0001-biosig-zarr.md` on the open draft PR | nemarOrg/rfcs, PR left open |
| B4d | RFC-0001 cites the back catalog figures S1 measured (lead's picks, P4) and dates the `2.0.2` release in its history | worker | S1, B4c | `text/0001-biosig-zarr.md` and the PR body on the open draft PR | nemarOrg/rfcs, PR left open |
| SC1 | The Store Contract states the version 3 NEMAR profile choices, as what NEMAR will do after RFC-0001 is accepted (Q29) | lead | B6, O4b | `src/content/docs/platform/zarr/store-contract.md` | nemarOrg/docs, `main` (owner merges, or authorizes the manager) |
| N1 | The RFC-0001 announcements are drafted | worker | B4, Q15 answered (revised by Q31 and Q32) | `.context/rfc-program/owner/announce-0001/` | nemar-cli, `feature/rfc-program` |
| O5 | The owner opens RFC-0001 | owner | B4, B6, O4b, O1b, S1, N1, B5a and O4d, B5 (Q26), O4c, B4c (which follows B4b, B7, O4e, B7b and O4f), B4d, the mail epic #2260's P1 to P3 plus the privacy-policy text in production (owner, 2026-11-20), Q10 and Q18 answered | the thread, the merge, announcements | nemarOrg/rfcs |
| C3 | Checkpoint: RFC-0001 has closed; the lead drafts the decision and outlines the follow-through epic | lead | O5 and the close | `checkpoints.md` row C3 | nemar-cli |
| V2 | The RFC-0002 text is written and reviewed as a draft PR | outline | V1, O5 | written at checkpoint C2 | nemarOrg/rfcs, PR left open |
| O6 | The owner opens RFC-0002 (only after RFC-0001 has closed) | owner | V2, C3 | the thread, the merge, announcements | nemarOrg/rfcs |
| C4 | Checkpoint: RFC-0002 has closed; decision draft and the review of the process ADR | lead | O6 and the close | `checkpoints.md` row C4 | nemar-cli |

Acceptance gates are literal on each card in [`cards/`](cards/).
Owner steps have no card; their exact commands are in section 5.

## 5. Owner actions, as exact commands

Nothing in this section is run by the manager or a worker.

### O0. Approve the plan

The owner says "approved" in the session after reading this plan as revised after C0.
The lead then runs `git -C /Users/yahya/Documents/git/nemar/nemar-cli-worktrees/rfc-program push -u origin feature/rfc-program` and records the approval with `decide "plan approved" --by owner`.

### O1. Create nemarOrg/rfcs and turn on Discussions

Done 2026-11-20 (run by the lead on the owner's instruction), with an initial README commit on `main`; only the two browser steps below remain.

```bash
gh repo create nemarOrg/rfcs --public --disable-wiki \
  --description "NEMAR Requests for Comment: the record, the index and the clock"
gh api -X PATCH repos/nemarOrg/rfcs -F has_discussions=true
```

Then, in the browser (no API exists for these):

1. `https://github.com/nemarOrg/rfcs/discussions/categories`: create a category `RFCs` with the Announcement format, so only maintainers open a thread and anyone with a GitHub account comments.
2. `https://github.com/organizations/nemarOrg/settings/discussions`: turn on organization Discussions with nemarOrg/rfcs as the source repository.

### O1b. Protect `main` (after R1 merges)

```bash
gh api -X POST repos/nemarOrg/rfcs/rulesets --input ops/ruleset-main.json
```

run from a clone of nemarOrg/rfcs; R1 writes `ops/ruleset-main.json`.

### O2. Create nemarOrg/biosig-zarr and amend biosigio#179

Done 2026-11-20 (run by the lead on the owner's instruction), with an initial README commit on `main`.

```bash
gh repo create nemarOrg/biosig-zarr --public --disable-wiki \
  --description "biosig-zarr: a Zarr v3 layout for one biosignal recording, and its single-file form .bzx"
gh issue comment 179 -R neuromechanist/biosigio \
  --body-file /Users/yahya/Documents/git/nemar/nemar-cli-worktrees/rfc-program/.context/rfc-program/owner/biosigio-179-amendment.md
```

### O4. Release 2.0.0 (after B2 merges)

Tag B2's merge commit, not whatever `main` holds later (replace `B2_PR` with B2's PR number):

```bash
SHA=$(gh pr view B2_PR -R nemarOrg/biosig-zarr --json mergeCommit -q .mergeCommit.oid)
gh release create 2.0.0 -R nemarOrg/biosig-zarr --target "$SHA" --title "2.0.0" \
  --notes "Format version 2, moved from docs.nemar.org with no normative change and relicensed (see LICENSE.md). Four parts the text marks Proposed are not yet implemented in NEMAR's stores: the biosig-zarr tag inside stores, .bzx, generated_by, and the conformance classes."
```

Questions Q13 (a w3id.org identifier) and Q14 (DOIs for specification releases) are recorded for this step but change nothing in it; if answered "yes", they are owner acts after the release.

### O4b. Tag 3.0.0-draft.1 (after B6 passes its merge gate; the PR stays open)

```bash
SHA=$(gh pr view draft/3.0.0 -R nemarOrg/biosig-zarr --json headRefOid -q .headRefOid)
gh release create 3.0.0-draft.1 -R nemarOrg/biosig-zarr --target "$SHA" --prerelease --title "3.0.0-draft.1" \
  --notes "The text NEMAR RFC 0001 proposes. Not accepted; see nemarOrg/rfcs."
```

### O4d. Release 2.0.1 (after B5a merges into `main`)

Run by the manager on the owner's say-so (Q33), recorded with `decide` first (runbook, "Never"); replace `B5A_PR` with B5a's PR number:

```bash
SHA=$(gh pr view B5A_PR -R nemarOrg/biosig-zarr --json mergeCommit -q .mergeCommit.oid)
gh release create 2.0.1 -R nemarOrg/biosig-zarr --target "$SHA" --title "2.0.1" \
  --notes "Format version 2, editorial release: the first JSON Schemas for format version 2 and conformance vectors cut from a CC0 recording. The text is unchanged from 2.0.0. The editor ruled these additions editorial on 2026-11-20 (see CHANGELOG.md)."
```

### O4c. Tag 3.0.0-draft.2 (after B5 merges into `draft/3.0.0`)

Run by the manager on the owner's say-so (Q36), recorded with `decide` first (runbook, "Never").

```bash
SHA=$(git ls-remote https://github.com/nemarOrg/biosig-zarr refs/heads/draft/3.0.0 | cut -f1)
gh release create 3.0.0-draft.2 -R nemarOrg/biosig-zarr --target "$SHA" --prerelease --title "3.0.0-draft.2" \
  --notes "The text NEMAR RFC 0001 proposes, with its first JSON Schemas (format versions 2 and 3) and conformance vectors cut from a CC0 recording. Not accepted; see nemarOrg/rfcs."
```

Check first that `SHA` is B5's merge commit (`gh pr view B5_PR -R nemarOrg/biosig-zarr --json mergeCommit -q .mergeCommit.oid`, with B5's PR number).

### O4e. Release 2.0.2 (after B7 merges into `main`)

Run by the manager on the owner's say-so (Q37/Q38), recorded with `decide` first (runbook, "Never"); replace `B7_PR` with B7's PR number:

```bash
SHA=$(gh pr view B7_PR -R nemarOrg/biosig-zarr --json mergeCommit -q .mergeCommit.oid)
gh release create 2.0.2 -R nemarOrg/biosig-zarr --target "$SHA" --title "2.0.2" \
  --notes "Format version 2, editorial release: the specification is independent of NEMAR (ADR 0005). The copyright holder of the text is the biosig-zarr contributors, and NEMAR is named only as the text's origin (first published on docs.nemar.org) and as its first implementer. The normative text, schemas and vectors are unchanged from 2.0.1 (see CHANGELOG.md)."
```

### O4f. Tag 3.0.0-draft.3 (after B7b merges into `draft/3.0.0`)

Run by the manager on the owner's say-so (Q37/Q38), recorded with `decide` first (runbook, "Never"); replace `B7B_PR` with B7b's PR number.
The `test` line stops the command when `draft/3.0.0` has moved past B7b's merge commit:

```bash
SHA=$(gh pr view B7B_PR -R nemarOrg/biosig-zarr --json mergeCommit -q .mergeCommit.oid)
test "$SHA" = "$(git ls-remote https://github.com/nemarOrg/biosig-zarr refs/heads/draft/3.0.0 | cut -f1)" && \
gh release create 3.0.0-draft.3 -R nemarOrg/biosig-zarr --target "$SHA" --prerelease --title "3.0.0-draft.3" \
  --notes "The text RFC-0001 in nemarOrg/rfcs proposes, with release 2.0.2 merged in: the specification is independent of NEMAR, and the copyright holder of its text is the biosig-zarr contributors. No normative change from 3.0.0-draft.2. Not accepted; see nemarOrg/rfcs."
```

### O5 and O6. Open an RFC

1. Create the thread and read back its address and creation time:

   ```bash
   gh api graphql -f query='{repository(owner:"nemarOrg",name:"rfcs"){id discussionCategories(first:20){nodes{id name}}}}'
   gh api graphql \
     -f query='mutation($r:ID!,$c:ID!,$t:String!,$b:String!){createDiscussion(input:{repositoryId:$r,categoryId:$c,title:$t,body:$b}){discussion{url createdAt}}}' \
     -f r=REPOSITORY_ID -f c=RFCS_CATEGORY_ID -f t="RFC 0001: biosig-zarr and its single-file form .bzx" \
     -F b=@opening-post.md
   ```

   The two IDs come from the first command; `opening-post.md` is the opening post the RFC PR carries in its body (R1's template defines it).
2. On the RFC PR, set `discussion` (the URL), `opened_at` (the `createdAt`, to the minute) and `window_days: 21`; `rfc-check` must pass; merge it.
3. Announce from N1's drafts in `.context/rfc-program/owner/announce-0001/`, after filling `{{CLOSE_UTC}}` and `{{THREAD_URL}}`, through the channels the process lists (R1's `PROCESS.md`).
   Only one RFC is open at a time: O6 waits until RFC-0001 has closed.
   Broadcast mail is production-only and honors the `announcements` preference.

## 6. Out of scope

- Any reader, writer or packer code (biosigIO, nemar-cli's Zarr reader in #2144, `nemar dataset download --zarr` in #2216); C3 outlines it as a follow-through epic after acceptance (see `checkpoints.md`).
- The EDF+D interim fix (neuromechanist/biosigio#180, step 1), owned by the owner as biosigIO's maintainer; this program cites it and S1 counts the affected stores.
- Building whatever RFC-0002 decides.
- The five automatic re-pulls held after `copy-failed (HeadObject:access-denied)` (on003774, on003751, on003708, on003702, on003626), found while planning; the owner tracks them separately.

## 7. Sources checked for owner decision 8 (2026-11-20)

- BEP047 is "Audio/video recordings for behavioral experiments" (leads: Benjamin Dichter; BIDS maintainer: Seyed Yahya Shirazi),
  pull request `https://github.com/bids-standard/bids-specification/pull/2231`,
  community review issue `https://github.com/bids-standard/bids-specification/issues/2568` (review period 2026-11-02 to 2026-11-13),
  listed in `https://github.com/bids-standard/bids-website/blob/main/data/beps/beps.yml`.
- **Open item:** no comment in PR 2231's conversation or review comments, or in issue 2568, discusses EDF's limit on irregular or sparse sampling (searched for "EDF", "irregular", "sparse", "timestamp").
  The thread the owner means was not found; it may be in the BEP047 working document or another venue.
  B4 cites it only once the owner supplies the link (question Q18).
  Later the same day, research found the closest match: a 2024-04-22 thread in BIDS issue 1771 (the issue BEP047 grew from), where EDF+D was raised; the preview draft cites it, and B4 keeps it unless Q18 supplies a better link.
- Related BIDS threads that do discuss the limit, any of which B4 may cite:
  - `https://github.com/bids-standard/bids-specification/issues/1796`, "[ENH] allow timestamps for physio table" (2024-04-18): an optional timestamp column for irregularly sampled tables, and nominal against effective sampling frequency.
  - `https://github.com/bids-standard/bids-specification/issues/2313`, "Storing sparse/non-continuous peripheral physiological data" (2026-01-19, for BEP045): sparse data and continuous data with a changing sampling rate.
  - `https://github.com/bids-standard/bids-specification/issues/2463`, "Plain-text TSV for motion/physio doesn't scale" (2026-07-08): Zarr, Parquet, EDF and the Waveform Database format (WFDB) as candidates, and the owner's comment that Zarr needs a fixed contract the way EDF has one.

## Appendix: pack review (checkpoint C0)

Run 2026-11-20: an executability review (Sonnet) and a design review (Opus).
Every finding was applied unless marked otherwise.

Executability: 1 B4 starts from the preview draft, gates on no "Unverified" and no banner; 2 moot, both repositories have an initial commit; 3 step O0 and a runbook rule refuse dispatch before the branch is on origin; 4 V1's row fixed; 5 owner-state steps asked at the first tick and exempt from timebox handlers; 6 B4 says what to do without Q18 and where D1 to D12 are; 7 handlers for owner merges, C3 and C4 as steps, risk dates, checkpoint gates, when to ask questions; 8 B2's report pasted for B4; 9 V1, S1 and B4 gates can fail; 10 O5's questions aligned, Q13 and Q14 recorded only, R3 completes at C1a; 11 asked as Q19 (owner owns Slots); 12 settled by the owner: epic issue (E0); 13 no change, the answers are on the board; 14 `_typos.toml` in R1; 15 O4 tags B2's merge commit.

Design: 1 reader refusal before serving, in the draft and C3; 2 card A2; 3 card B6 and step O4b; 4 and 5 rules added to R1; 6 lead decision 7; 7 settled by the owner: relicense and remove the docs page (B3 rewritten); 8 B2 records the UUID only in an ADR, Q11 reworded; 9 settled by the owner: full release, notes list the Proposed parts, tag scheme in GOVERNANCE.md; 10 disambiguation in the draft; 11 card S1; 12 lead decision 10; 13 draft fixed; 14 C3's follow-through list; 15 card N1 and Q15 widened; 16 settled by the owner: one RFC at a time; 17 draft front matter and section 14 fixed; 18 close instant defined in R1 and the draft; 19 moot; 20 draft marked.
