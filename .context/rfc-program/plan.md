# RFC program: plan

**Status:** draft for the owner's approval, 2026-11-20.
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
| Step PRs into `feature/rfc-program` in nemarOrg/nemar-cli (A1, V1) | the manager, after the merge gate |
| Tooling PRs into `main` of nemarOrg/rfcs (R1) | the manager, after the merge gate |
| Step PRs into `main` of nemarOrg/biosig-zarr (B1, B2) | the manager, after the merge gate |
| RFC text PRs in nemarOrg/rfcs (B4, V2) | nobody until the owner opens the RFC: merging one with `opened_at` set is the act of opening it |
| Any PR to nemarOrg/docs (R2, B3) | the owner; a docs merge publishes |
| `feature/rfc-program` into `dev` | the owner, through `/project:epic-dev --finalize`; never an admin merge |
| Tags, releases, repository creation, settings, Discussions, announcements, comments on other repositories | the owner, from the exact commands in section 5 |

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
4. nemarOrg/biosig-zarr exists, initialized with `/project:init-project`, holding the specification text moved from docs.nemar.org, and tagged `2.0.0-draft.1` by the owner.
5. The RFC-0001 text (the whole biosig-zarr format, with `.bzx` as its single-file form) is reviewed and waits as a draft PR for the owner to open it.
6. The counts that RFC-0002 needs are measured, and the RFC-0002 text (dataset version legibility) is reviewed and waits as a draft PR for the owner to open it.

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
   that the commenters differ (people who use electroencephalography (EEG) and magnetoencephalography (MEG) data, and people who build Zarr tools);
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
   It opens after RFC-0001, and after a read-only count of the version Digital Object Identifiers (DOIs) already minted.

## 3. Lead decisions made while writing this pack

1. **RFC-0001's text lives in nemarOrg/rfcs**, at `text/0001-biosig-zarr.md`, because of the one number space.
   nemarOrg/biosig-zarr has no `rfc/` directory; its README links to the RFC.
   This replaces the `rfc/` directory in the planning note's layout.
2. **A draft RFC is a PR, not a merged file.**
   The draft PR takes its number when it is opened (the next number unused by merged files and open PRs), and a number is never reused, even when a draft is withdrawn.
   Merging the PR with `opened_at` and `discussion` set is the act of opening the RFC, so only the owner merges an RFC text PR.
3. **No reader or writer library lives in nemarOrg/biosig-zarr.**
   Python packing goes to biosigIO and TypeScript reading to nemar-cli, outside this program.
4. **B2 moves the text with no normative change.**
   The explicit sample resolution field, the irregular and sparse series requirement, and the independence from RFC-9 (owner decisions 5, 8 and 9) are proposed in RFC-0001 (B4), not written into the moved text,
   so the move stays verifiable word for word; B2's report gives B4 the line numbers to quote.
5. **The schemas and conformance vectors (B5) are an outline** until the owner answers where the vectors live (Q9) and whether RFC-0001 may open without an implementation (Q10).

## 4. Steps

| ID | Goal | Tier | Depends | Owns | Repository and integration branch |
| --- | --- | --- | --- | --- | --- |
| O1 | The owner creates nemarOrg/rfcs and turns on its Discussions | owner | none | settings | nemarOrg/rfcs |
| A1 | An ADR adopts the RFC process, provisional | worker | Q1 to Q7 answered | `.context/decisions/` | nemar-cli, `feature/rfc-program` |
| R1 | nemarOrg/rfcs holds the process, template, schema, index, `rfc-check` and `rfc-clock`, all tested | worker-hard | O1, Q1 to Q7 answered | the whole repository | nemarOrg/rfcs, `main` |
| O1b | The owner adds the `main` ruleset requiring `rfc-check` | owner | R1 | settings | nemarOrg/rfcs |
| R2 | docs.nemar.org has `/policies/rfcs/` | worker | A1, R1, Q17 answered | `src/content/docs/policies/rfcs.md`, sidebar | nemarOrg/docs, `main` (owner merges) |
| R3 | The weekly report shows the open RFCs and when `rfc-clock` last ran | outline | R1, Q7 | to be written at checkpoint C1 | nemar-cli, `feature/rfc-program` |
| O2 | The owner creates nemarOrg/biosig-zarr and amends biosigio#179 | owner | none | settings, one comment | nemarOrg/biosig-zarr |
| B1 | biosig-zarr is initialized with `/project:init-project`, plus the files it does not create | worker-hard | O2, Q8 answered | the whole repository | nemarOrg/biosig-zarr, `main` |
| B2 | The specification text is moved into `spec/index.md` as plain Markdown | worker | B1, Q11 answered | `spec/`, `CHANGELOG.md`, `README.md` | nemarOrg/biosig-zarr, `main` |
| O4 | The owner tags `2.0.0-draft.1` | owner | B2 | one tag | nemarOrg/biosig-zarr |
| B3 | docs.nemar.org renders the specification from the pinned tag, with a per-page license notice | worker-hard | O4, Q12 answered | docs build step, the format page | nemarOrg/docs, `main` (owner merges) |
| B4 | The RFC-0001 text is written and reviewed as a draft PR | lead | R1, B2 | `text/0001-biosig-zarr.md` | nemarOrg/rfcs, PR left open |
| B5 | Schemas and the first conformance vectors | outline | B2, Q9, Q10 | to be written at checkpoint C1 | nemarOrg/biosig-zarr |
| O5 | The owner opens RFC-0001 | owner | B4, O1b, Q15 answered | the thread, the merge, announcements | nemarOrg/rfcs |
| V1 | The counts RFC-0002 needs are measured, read-only | worker | none | `.context/rfc-program/evidence/` | nemar-cli, `feature/rfc-program` |
| V2 | The RFC-0002 text is written and reviewed as a draft PR | outline | V1, O5 | to be written at checkpoint C2 | nemarOrg/rfcs, PR left open |
| O6 | The owner opens RFC-0002 | owner | V2 | the thread, the merge, announcements | nemarOrg/rfcs |

Acceptance gates are literal on each card in [`cards/`](cards/).
Owner steps have no card; their exact commands are in section 5.

## 5. Owner actions, as exact commands

Nothing in this section is run by the manager or a worker.

### O1. Create nemarOrg/rfcs and turn on Discussions

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

```bash
gh repo create nemarOrg/biosig-zarr --public --disable-wiki \
  --description "biosig-zarr: a Zarr v3 layout for one biosignal recording, and its single-file form .bzx"
gh issue comment 179 -R neuromechanist/biosigio \
  --body-file /Users/yahya/Documents/git/nemar/nemar-cli-worktrees/rfc-program/.context/rfc-program/owner/biosigio-179-amendment.md
```

### O4. Tag the first draft (after B2 merges)

```bash
SHA=$(gh api repos/nemarOrg/biosig-zarr/commits/main -q .sha)
gh release create 2.0.0-draft.1 -R nemarOrg/biosig-zarr --target "$SHA" --prerelease \
  --title "2.0.0-draft.1" --notes "The pre-beta text moved from docs.nemar.org; no normative change."
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
3. Announce through the channels the process lists (R1's `PROCESS.md`).
   Broadcast mail is production-only and honors the `announcements` preference.

## 6. Out of scope

- Any reader, writer or packer code (biosigIO, nemar-cli's Zarr reader in #2144, `nemar dataset download --zarr` in #2216).
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
- Related BIDS threads that do discuss the limit, any of which B4 may cite:
  - `https://github.com/bids-standard/bids-specification/issues/1796`, "[ENH] allow timestamps for physio table" (2024-04-18): an optional timestamp column for irregularly sampled tables, and nominal against effective sampling frequency.
  - `https://github.com/bids-standard/bids-specification/issues/2313`, "Storing sparse/non-continuous peripheral physiological data" (2026-01-19, for BEP045): sparse data and continuous data with a changing sampling rate.
  - `https://github.com/bids-standard/bids-specification/issues/2463`, "Plain-text TSV for motion/physio doesn't scale" (2026-07-08): Zarr, Parquet, EDF and the Waveform Database format (WFDB) as candidates, and the owner's comment that Zarr needs a fixed contract the way EDF has one.

## Appendix: pack review (checkpoint C0)

Not yet run.
Before the first tick, an executability reviewer (worker tier) and a design reviewer (lead tier) read this pack;
each finding is listed here with its disposition (fixed, rejected with a reason).
