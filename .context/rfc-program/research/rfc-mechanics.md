> **Historical planning note, 2026-11-20.**
> The owner decisions in [`../plan.md`](../plan.md) section 2 override it where they differ:
> one central thread venue, a 14-day extension cap, RFC-0001 covering the whole format with RFC-9 as prior art only, and RFC-0002 not pre-decided.

# NEMAR Request for Comment mechanics, and the weight of a dataset versioning change

Planning document, not a decision.
Written 2026-11-20 against nemar-cli `dev` at `065794d9`.
No repository, Discussion, category, label, issue or other GitHub object was created, and no checkout was edited.
Every GitHub and production call made for this document was a read.

**Legend.**
**[V]** is verified in this session, with the file and line or the command that showed it.
**[D]** is external documentation read in this session.
**[I]** is inference or a design proposal; it has not been tested.

Abbreviations, defined once:
Request for Comment (RFC),
Architecture Decision Record (ADR),
Digital Object Identifier (DOI),
Semantic Versioning 2.0.0 (SemVer),
command-line interface (CLI),
continuous integration (CI),
Coordinated Universal Time (UTC),
Amazon Simple Storage Service (S3),
Cloudflare's SQLite database service (D1),
Hierarchical Event Descriptors (HED),
Brain Imaging Data Structure (BIDS),
BIDS Extension Proposal (BEP),
Python Enhancement Proposal (PEP),
Open Microscopy Environment Next-Generation File Format (OME-NGFF),
final comment period (FCP).
EZID is the California Digital Library's identifier service that NEMAR mints DataCite DOIs through (ADR 0007).

---

## Summary

**Part A** recommends one public repository, `nemarOrg/rfcs`, as the record and the number space for every RFC,
with the comment thread in a GitHub Discussion:
the organization's Discussions for an organization RFC,
and the dataset repository's own Discussions, switched on for that one repository, for a dataset RFC.
The status of an RFC is derived from recorded dates by one pure function,
a CI check refuses any record that breaks the 21-day window or takes a second extension,
and a scheduled job posts reminders and locks the thread at close but never decides.
An accepted RFC becomes an ADR in `.context/decisions/`, and the ADR names the RFC.

**Part B** finds the owner's `+N` idea heavier than it looks.
The version string is a component of six public identifiers (git tag, version DOI, S3 manifest key, data-plane route, website landing URL, compute contract),
about twenty validators accept only `X.Y.Z`,
SemVer gives `1.0.0+1` and `1.0.0+2` equal precedence,
the `semver` package the CLI uses silently drops `+N`,
DataCite and AWS both list `+` as a character to avoid,
and the website landing URL a DOI points at would read `+` as a space.
For mirrors, adopting upstream's numbers collides with numbers NEMAR has already minted (on004362's NEMAR `v2.0.0` is upstream `1.0.1`).
The goal, showing who made each change, can be met without a new grammar:
record a change origin per version from facts GitHub already authenticates, show it on the landing page and the API, and put it in the DataCite record.
The recommended RFC asks the community about the goal first and presents the grammar change as one option among three.

---

## Part A: RFC mechanics

### A1. What an RFC is for, and what it is not for

An RFC is used when a decision needs input from people outside the NEMAR team **[I]**:

- it changes what an already published identifier, version or file means to a reader (the versioning RFC);
- it defines a format or contract that people outside NEMAR will implement or depend on (the `.bzx` package);
- it changes what depositors, authors or users must do, or what NEMAR may do to their datasets;
- it changes the content of many datasets at once (a curation campaign, such as adding HED annotations to a set of datasets);
- it changes one published dataset's author-owned content without the agreement of the dataset's owner (dataset scope).

An RFC is **not** used for:

- a privacy correction, which acts at once under ADR 0085 and never waits for a comment window;
- a security fix;
- an internal architecture choice, which an ADR alone records;
- an ordinary contribution to a dataset, which is a pull request under ADR 0001.

### A2. What exists today

| Fact | Evidence |
|---|---|
| Discussions are off on `nemarOrg/.github`, `nemarDatasets/.github`, `nemarOrg/nemar-cli`, `nemarOrg/docs`, `nemarDatasets/nm000103` and `nemarDatasets/on003645` | **[V]** `gh api graphql` on `hasDiscussionsEnabled`, all `false`, no categories |
| No nemarOrg repository has Discussions on (16 repositories) | **[V]** `gh api graphql` over `organization(login:"nemarOrg").repositories` |
| No nemarDatasets repository has Discussions on | **[V]** paged GraphQL scan of 1,500 of the 1,510 repositories, 0 enabled |
| Organization Discussions are not set up for either organization | **[V]** `curl https://github.com/orgs/{nemarOrg,nemarDatasets}/discussions` answers 404 |
| `nemarOrg/rfcs` does not exist | **[V]** `gh api repos/nemarOrg/rfcs` answers 404 |
| nemarDatasets holds 1,510 repositories, 916 public and 594 private; ADR 0020 still says about 785 | **[V]** GraphQL `totalCount` by privacy |
| Issues are on for dataset repositories | **[V]** `hasIssuesEnabled: true` on nm000103 and on003645 |
| `nemarOrg/nemar-cli` is public, so ADR links resolve for anyone | **[V]** `isPrivate: false` |
| `nemarOrg/docs` is private at source and public at the URL | **[V]** `isPrivate: true`; ADR 0059 |
| Announcement channels already built: news posts, CLI notices with an expiry, and broadcast mail that honors an `announcements` preference | **[V]** `backend/src/routes/news.ts`, `backend/src/routes/admin/notices.ts`, `backend/src/services/broadcast.ts:25-50`, `backend/src/services/email.ts:343-357` |
| The ADR index test allows only `proposed`, `accepted` and `superseded by ADR-NNNN` as a Status | **[V]** `test/adr-index.unit.test.ts:120-127` |

nemarOrg is on GitHub Free and nemarDatasets on GitHub Team (stated in the project instructions, not re-read in settings).
What that means here **[I]**, from GitHub's plan documentation, not re-read this session:
on Free, rulesets and branch protection apply to public repositories only, so `nemarOrg/rfcs` must be public to protect `main`, which it should be anyway;
on either plan, a scheduled workflow in a public repository is disabled after 60 days with no repository activity, which matters for a quiet RFC repository (A7).
Team adds nothing an RFC needs.
A private dataset repository's Discussions are visible only to its collaborators, so a dataset RFC is possible only on a public dataset.

### A3. Where RFCs live

| | A. Organization Discussions only | B. `nemarOrg/rfcs` text by pull request, one linked Discussion | C. Per-dataset Discussions |
|---|---|---|---|
| Text history | Edit history only, no review of text changes | Every change is a reviewed commit with a diff | Edit history only |
| Barrier to comment | A GitHub account | A GitHub account (comments go to the Discussion, not the pull request) | A GitHub account |
| Number and index | Discussion numbers, shared with nothing durable | One RFC number space and an index that CI checks | None across datasets |
| Clock automation | GraphQL only | GraphQL for the thread, files for the record | GraphQL per repository, needs a token on nemarDatasets |
| Record if the thread is lost | Lost | Kept in git | Lost |
| Setup | One organization setting and one category, both by hand | One public repository, one organization setting, one category | One setting per dataset repository, on demand |
| Fit for "on a specific dataset" | Poor | The record is central; the thread can sit on the dataset | Good |

**Recommendation [I]: B for the record of every RFC, with the thread placed by scope.**

- **Organization RFC:** the thread is in nemarOrg's organization Discussions, with `nemarOrg/rfcs` as the source repository, in a category named `RFCs` of the Announcement format, so only maintainers open a thread and anyone with a GitHub account comments.
- **Dataset RFC:** the record is still `nemarOrg/rfcs` (one number space, one index), and the thread is in the dataset repository's own Discussions, switched on for that one repository when the RFC opens, in its default `Announcements` category.
  Switching it on is a repository setting, not a content change, so it makes no version.
  It is rehearsed on the fixture `nm099999` first, because the live-dataset rule forbids changing a real dataset's settings during development.
  The alternative is one `Dataset RFCs` category in nemarDatasets' organization Discussions, sourced from `nemarDatasets/.github`: one setup, but the thread sits away from the dataset (open decision 1).
- Discussion categories cannot be created through the API (no GraphQL mutation exists, to my knowledge, not re-checked), so the one category is made by hand once.
- A dataset repository gets no Discussion template file, because a file in a published dataset is a pull request and a version; the job posts the opening text instead.

### A4. Numbering and naming

**[I]**

- `NEMAR RFC 0001`, four digits, one sequence for organization and dataset RFCs, independent of ADR numbers and of Discussion numbers.
- The number is assigned when the draft's pull request is merged as `open`, in the order RFCs open; a draft has no number.
- A number is never reused; a withdrawn or rejected RFC keeps its number.
- File: `text/NNNN-short-kebab-title.md`; a dataset RFC adds `scope: dataset` and `dataset: <id>` to its front matter rather than living in another folder.
- Thread title: `RFC 0002: <title>` for the organization, `RFC 0002 (<dataset id>): <title>` for a dataset.

### A5. Roles

**[I]**

- **Anyone may propose** a draft, as a pull request to `nemarOrg/rfcs` or as an idea sent to the support address.
- **A shepherd opens it.** Only a NEMAR account with the `owner` or `admin` role opens an RFC, because opening starts a clock and an announcement.
  The shepherd keeps the clock, writes the final-comment summary and drafts the decision comment.
- **A dataset RFC** may be requested by the dataset's owner, a NEMAR administrator, or a contributor whose ordinary pull request was contested.
  The dataset owner is told directly when one opens, and their position is recorded in the decision whether or not they comment.
- **Who decides** is open decision 4.
  The recommendation: the owner decides an organization RFC; a dataset RFC is decided by NEMAR with the dataset owner's recorded position, and a change to author-owned content needs the dataset owner's consent (ADR 0109 already protects that content in pull request review).

### A6. Lifecycle

The record stores **events**; the status is **derived** from them and the current time by one pure function, `rfcStatus(record, now)`, which the CI check and the scheduled job both import **[I]**.
This follows the repository's own habit of one predicate for one rule (for example `mirrorFlagOf`, `shared/source-snapshot.ts:307-330` **[V]**).

| State | Entered when | Recorded event |
|---|---|---|
| `draft` | A pull request adds `text/NNNN-*.md` without a number | none (the pull request) |
| `open` | The draft is merged with `discussion` and `opened_at`; the thread exists | `opened_at`, `window_days`, `discussion` |
| `extended` | The shepherd grants the one extension before the close | `extension: {granted_at, days, reason}` |
| `final-comment` | The shepherd posts the comment summary and proposed disposition, at the latest 7 days before the close | `final_comment_at`, `proposed_disposition` |
| `closed` | `now` passes the close; the thread is locked; awaiting a decision | none (derived) |
| `accepted` / `rejected` | The decision pull request merges | `decision`, `decided_at`, `decided_by`, `adr` |
| `withdrawn` | The author or shepherd withdraws it, at any time before a decision | `withdrawn_at`, `reason` |

`accepted`, `rejected` and `withdrawn` are terminal.
An RFC that needs another round is withdrawn and opened again under a new number that links the old one.

### A7. The clock, and how it is enforced

**Rules [I]**

1. Days are calendar days in UTC.
   `opened_at` is the thread's creation instant as GitHub reports it, and the CI check requires the record to agree with it to the minute.
2. `window_days` is an integer from 7 to 21, declared when the RFC opens, and never shortened.
   The close is `opened_at + window_days`.
3. **One extension at most.**
   Only the shepherd grants it, before the close, with a reason posted in the thread and recorded in the file.
   Its length is capped (open decision 2; the recommendation is at most 14 days, so no RFC runs longer than 35 days).
4. **Final comment lies inside the window.**
   It begins when the shepherd posts the summary of comments and the proposed disposition, and it must begin at least 7 days before the close (5 days if the window is 7 to 10 days).
   An RFC can be accepted only if its proposed disposition was posted that early; otherwise it can only use its extension, be rejected, or be withdrawn.
   This is checked on the decision pull request, so the rule is enforced and not trusted.
5. **A material change to the text** is allowed until final comment begins, logged in the file's change log and announced in the thread.
   A material change after that uses the extension; if the extension is spent, the RFC is withdrawn and resubmitted.
6. **A decision is due within 14 days of the close.**
   An overdue RFC is flagged; nothing decides it automatically, because silence is not consent.

**Enforcement [I], specified and not built**

- **`rfc-check`**, a required check on every pull request to `nemarOrg/rfcs`:
  validates the front matter against `schema/rfc.schema.json`;
  enforces rules 2 to 4 and 6 (`window_days` from 7 to 21, at most one extension, extension within the cap and granted before the close, final comment early enough for `accepted`, decision fields only after the close);
  checks that status moves only forward, that numbers are unique and match the file name, and that the generated index in `README.md` matches the files (the same "enforced, not decorative" rule the ADR index test applies).
- **`rfc-clock`**, a scheduled workflow (`cron: "0 14 * * *"` plus `workflow_dispatch`), with `permissions: {contents: read, discussions: write}`:
  for each RFC that is `open`, `extended` or `final-comment`, it posts a reminder at 7 and 2 days before the close, once each, marked by a hidden comment marker so a rerun posts nothing twice;
  at the close it posts a closing comment, locks the thread (`lockLockable`) and sets the labels;
  it never edits a file and never decides.
  If GitHub's state disagrees with the record (a thread unlocked after its close, a thread deleted), it fails the run and says so, and it repairs nothing it did not do itself.
- **The token.** The repository's own token can write Discussions in nemarOrg.
  A dataset thread lives in nemarDatasets, so the job needs the NEMAR App's installation token there with the Discussions permission; adding that permission is an owner act that touches the App on 1,510 repositories (open decision 9).
- **A stopped clock must be visible.**
  A quiet public repository loses its scheduled workflows after 60 days, so the weekly report (ADR 0054, which arrives whether or not anything is wrong) gains one line: the open RFCs, their close dates, and when `rfc-clock` last ran.
  The other way to host the clock is the Worker's production cron, which never goes stale but puts RFC code in nemar-cli (open decision 9).

### A8. Templates

**RFC file [I]**

```markdown
---
number: 2
title: Show who made each change to a dataset version
scope: org            # org | dataset
dataset: null         # e.g. nm000123 when scope is dataset
shepherd: <GitHub login>
authors: [<names>]
discussion: <URL>
opened_at: 2027-01-11T16:00:00Z
window_days: 21
extension: null       # {granted_at, days, reason}
final_comment_at: null
proposed_disposition: null   # accept | reject
decision: null        # accepted | rejected | withdrawn
decided_at: null
decided_by: null
adr: null             # ADR-NNNN when accepted
supersedes_rfc: null
---

## Summary            (three sentences a non-specialist can read)
## Scope              (organization, or one dataset and why)
## Problem            (what is wrong today, with measured facts)
## Proposal           (including the one-sentence verdict the ADR would carry)
## Who is affected    (depositors, authors, users, tools, NEMAR)
## What does not change, and what is irreversible
## Options considered (each with its cost)
## Prior art
## Questions for commenters   (numbered, answerable)
## How the decision will be made   (criteria written before comments arrive)
## Rollout and cost
## Change log         (dated, one line per material change)
```

**Opening post in the thread:** the summary, the questions for commenters, the close date in UTC, the link to the file at its merge commit, and how to comment without a GitHub account.

**Decision comment:** the disposition; a count of comments and commenters; a response to each substantive objection, borrowed from OME-NGFF, where editors who overrule reviewers answer in writing; what changes and when; and the ADR link, or the reason there is none.

### A9. Labels and categories

**[I]**

- One Discussion category, `RFCs` (Announcement format), in nemarOrg's organization Discussions.
  Dataset threads use the dataset repository's default `Announcements` category.
- Labels in `nemarOrg/rfcs`, also used on its Discussions: `rfc`, `scope:org`, `scope:dataset`, `status:open`, `status:extended`, `status:final-comment`, `status:closed`, `status:accepted`, `status:rejected`, `status:withdrawn`.
  The labels are a view set by `rfc-clock`; the file is the record, and where they disagree the file wins.
- On a dataset repository the job creates the same labels on first use.

### A10. How the outcome is recorded, and the link to ADRs

**[I]**

- The decision pull request sets `decision`, `decided_at`, `decided_by` and, when accepted, `adr`.
- **An accepted RFC produces an ADR** in `.context/decisions/`, through the usual pull request, with a line under the header:
  `Decided through NEMAR RFC 0002 (<link>).`
  The ADR states the verdict; the RFC keeps the argument and the comments.
  This matches the existing rule that `.context/` keeps the analysis and the ADR is the verdict, and that the ADR wins where they disagree.
- **A rejection produces an ADR only when it closes off a reasonable path** (the README's own test for writing one), for example "dataset versions stay `X.Y.Z`; origin is recorded in metadata".
  That ADR is `accepted` and states what was kept.
  A plain "not now" produces none.
  The index test admits no `rejected` status **[V]** (`test/adr-index.unit.test.ts:127`), and none is needed: the RFC file records the rejection.
- An RFC that would change an accepted ADR's verdict says so, and the resulting ADR supersedes it; an amendment is only for a clarification (the README's convention).
- The process itself is adopted by an ADR, marked provisional, and reviewed after the first two RFCs.
  ADR numbers 0120 and 0127 are absent on `dev` and appear in other branches' history **[V]** (`ls .context/decisions`, `git log --all -- '.context/decisions/0127*'`), so the number is taken when that ADR is written.

### A11. Announcement channels

**[I]**, using channels that exist **[V]** (A2):

| Channel | Organization RFC | Dataset RFC |
|---|---|---|
| The Discussion thread (watchers are notified) | yes | yes, on the dataset repository |
| A news post on the website | yes | no |
| A CLI notice with `expires_at` set to the close | yes | no |
| Broadcast mail to `all`, honoring the `announcements` preference | yes, once at open | no |
| Mail to one user (`user:<username>`) | no | the dataset owner and collaborators |
| A banner on the dataset landing page | no | later (not built) |
| External lists (BIDS, EEGLAB, Neurostars) | by hand, for format RFCs | no |

Mail is production-only.
Development D1 holds real addresses, so an announcement is never sent from staging (the project's hard rule).
Comments sent to the support address (ADR 0112 tickets) are posted to the thread by a maintainer, with the sender's name only if they agree.

### A12. The page on docs.nemar.org

**[I]**

- Path `/policies/rfcs/` ("Requests for Comment"), beside the Contributor Terms and the Takedown Procedure; the Markdown mirror follows automatically.
- Content: what an RFC is for (A1), the two scopes, the states, the clock rules, how to comment with or without a GitHub account, how a decision is recorded, and a link to the index in `nemarOrg/rfcs`.
- The page links to the index and does not copy it, because two copies drift (ADR 0057).
- `/platform/doi-and-versioning/` gains a link to the versioning RFC while it is open.
- A docs pull request needs the owner's approval.

### A13. Prior art, and what to borrow

| Process | What it does | Borrow | Leave |
|---|---|---|---|
| Rust RFCs | Text as a pull request to `rust-lang/rfcs`; a team member starts a 10-day FCP with a proposed disposition (merge, close, postpone); a bot runs the timers | A proposed disposition announced before the end; a bot that keeps time | Comment threads on the pull request itself; sign-off checkboxes for a small team |
| Python PEPs | Numbered by editors; states Draft, Accepted, Provisional, Deferred, Rejected, Withdrawn, Final, Superseded; discussion on a forum; a `Resolution` header links the decision | The distinction between rejected and withdrawn; a header linking the decision | The large state set |
| OME-NGFF RFC-1 **[D]** | DRAFT, RFC and SPEC phases; editors pick reviewers who recommend Reject, Major changes, Minor changes or Accept; reviews and responses are files in the repository; editors who overrule reviewers answer in writing; adoption needs two released implementations | Written answers to each substantive objection; for a format RFC such as `.bzx`, implementation evidence before acceptance | Month-long phases, which break the 21-day cap |
| BIDS BEPs | Drafts in shared documents with open comments, numbered on a public list, converted to pull requests on the specification, approved by the maintainers and Steering Group | A low barrier to comment for researchers; a public numbered list | Open-ended timelines |

NEMAR's audience already knows BEPs, so the docs page should say in one sentence how an RFC differs: it is bounded in time and ends in a recorded decision.

### A14. Setup, for the owner to do (nothing here was done)

1. Write the ADR that adopts the process (provisional).
2. Create the public `nemarOrg/rfcs` repository (MIT for tooling, CC BY 4.0 for text; open decision 8) with a ruleset on `main` requiring `rfc-check`.
3. Turn on nemarOrg organization Discussions with `nemarOrg/rfcs` as the source, and create the `RFCs` category by hand.
4. Decide the token for dataset threads (open decision 9) and rehearse a dataset thread on `nm099999`.
5. Add the weekly report line and the docs page.
6. Open RFC 0001.

---

## Part B: what a versioning and DOI change would weigh

### B1. The proposal, and one ambiguity to settle first

The owner's idea: versions and DOIs are transparent today but do not show who made a change (the first party or NEMAR, the authors, or others).
Plain `vX.Y.Z` would be reserved for the first party, and other contributions marked `+1`, `+2`, and so on.
A mirror would take its upstream version and append `+N` for NEMAR's additions.
Open: what to do with grouped additions such as HED annotations or post-processing.

**"First party" is used two ways [I].**
In the mirror rule, the upstream authors are the first party and NEMAR's additions are `+N`.
In the owner's own vocabulary elsewhere, "first-party processing" means NEMAR's own processing (the processing plan of 2026-10-12, in the owner's notes).
The only reading consistent with the mirror rule is: the first party is the dataset's source (the depositor and authors for `nm`, upstream for `on`), and NEMAR is one of the other parties.
The RFC must define the term, and should replace a binary (plain or `+N`) with three named origins: **source**, **NEMAR**, **community**, plus **unknown**.
A bare `+N` says that someone other than the source changed the dataset; it does not say who, which is the stated goal.

### B2. What the system does today

**Numbering rules.**
ADR 0006: an upstream re-pull is a major bump, and minor and patch are NEMAR's own corrections; it considered and **rejected** "mirror upstream's version string verbatim" because it "collides when upstream and NEMAR both change" **[V]** (`0006-...md:15-20, 31`).
ADR 0111: `N.0.0` is a pure mirror of one upstream tag, NEMAR's corrections replay as `N.0.1`, the next `N` is the major after the highest of the version rows, the `v*` tags and `Version` on `main` **[V]** (`0111-...md:116`), and a version is a mirror when it is `N.0.0` with a recorded `source_version` **[V]** (`0111-...md:158-162`).
The public docs promise readers that "a version that is not `N.0.0` carries a change that NEMAR made itself" **[V]** (`curl https://docs.nemar.org/platform/doi-and-versioning.md`).
ADR 0016 is about the CLI's own npm releases; for datasets only its 2026-10-04 amendment matters: tags are moved only by CI, except during a privacy correction **[V]** (`0016-...md:35-37`).
ADR 0085: a privacy correction keeps version numbers and DOIs and issues no new version **[V]** (index line 75).

**The version string is part of six public identifiers [V].**

| Identifier | Form | Where |
|---|---|---|
| Git tag on the dataset repository | `v1.0.2` | `src/lib/repull/release.ts:248`; publication `create_tag` step, `backend/src/services/publication-orchestrator.ts:1475-1498` |
| Version DOI | `10.82901/NEMAR.NM000104.V1.0.2` | `backend/src/services/doi.ts:182-189` uppercases the version into the suffix |
| DOI landing target | `https://.../dataset/<id>?v=v1.0.2`, not encoded | `shared/datacite-constants.ts:223-229` |
| S3 version manifest and siblings | `<id>/version/v1.0.2.json`, `-summary.json`, `-records.json` | `backend/src/services/s3.ts:601-612, 788, 842, 857` |
| Data-plane routes | `/<id>/v1.0.2/<path>`; a bare `1.0.2` is a 404 | `backend/src/services/data-router.ts:48, 107`; memory note `data-plane-needs-v-prefix` |
| Compute contract | `latest` or `v1.0.2` | `shared/contract/compute.ts:99` |

Derivatives are keyed by a line that includes the version (ADR 0123, proposed), so a seventh identifier is coming.

**Validators that accept only `X.Y.Z` [V]** (`grep` over `backend/src`, `shared`, `src`):
`backend/src/routes/callbacks/version-doi.ts:91` (no DOI for anything else),
`backend/src/routes/webhooks/github.ts:169` (tag push dispatch, `-rc`, `-alpha`, `-beta` only),
`backend/src/services/data-router.ts:48`,
`backend/src/services/publication-orchestrator.ts:1698-1724`,
`backend/src/services/github/workflows.ts:86-114` (the `version-check` script every dataset repository runs as a required check),
`src/lib/semver.ts:41` (refuses build metadata on purpose),
`shared/repull-state.ts:321`, `shared/source-snapshot.ts:213, 307`, `shared/pr-review.ts:433`, `shared/repull-merge-acceptance.ts:112`,
`backend/src/services/upstream-repull-scheduler.ts:134`, `backend/src/services/github/dispatch.ts:376`,
`backend/src/services/upstream-backfill.ts:75, 111`,
`backend/src/services/archive-retry.ts:75`, `backend/src/services/doi-reconcile.ts:59`.
The central workflow `run-version-doi.yml` in `nemarDatasets/.github` documents the same tag pattern **[V]** (`gh api .../run-version-doi.yml`).
A grammar change touches every one of them, and the `version-check` change reaches all 1,510 dataset repositories at once (ADR 0020).

**Ordering.**
The data plane's `latest` is the newest row by `created_at`, not the highest number **[V]** (`backend/src/services/data-router.ts:96-105`).
`version-check` demands a strict numeric increment over `main` **[V]** (`workflows.ts:97-114`).
ADR 0111 takes a mirror's tag from its highest-semver row **[V]** (`0111-...md:151`).
Today these agree because every version is a higher `X.Y.Z`; a scheme that can produce a lower number later makes them disagree.

**DataCite relations.**
A version DOI carries `IsVersionOf` its concept DOI, and the concept carries `HasVersion` for each version **[V]** (`backend/src/services/doi.ts:404-409`, `backend/src/routes/admin/doi.ts:838-848`, `backend/src/routes/callbacks/version-doi.ts:635`).
No `IsNewVersionOf` or `IsPreviousVersionOf` links one version to the next **[V]** (`grep` finds none).
`SourceDatasets` becomes `IsDerivedFrom` **[V]** (`backend/src/services/llm-enrich.ts:346, 412-421`), and the docs say a mirror's record lists the OpenNeuro snapshot DOI among its related identifiers.
The `<version>` element is the version string **[V]** (`backend/src/services/datacite.ts:995-997`).

**Attribution of a version today.**
Version DOIs are minted without the uploader as `DataCurator`; issue #1261 is still open **[V]** (`gh issue view 1261`; ADR 0041 Consequences).
ADR 0041 allows a person in a DOI only by real given and family name, never a handle.
Accounts are matched to GitHub by `users.github_username`, case-insensitive; no numeric GitHub id is stored **[V]** (`backend/src/services/pr-review-exemption.ts:57-63`; no `github_id` column found).

**Mirrors.**
An upstream tag may be one to four numeric parts and includes the legacy `00001` **[V]** (`shared/source-snapshot.ts:38-42`); neither `00001` nor `1.0.0.1` is valid SemVer **[V]** (probe below).
The public wire carries the `mirror` flag and deliberately not the upstream tag; the tag is on an owner, collaborator and administrator route **[V]** (`0111-...md:683, 2189-2193`).
On 2026-10-29, 568 of 611 mirrors were `not_examined`, because the backfill had not run (owner's notes); the current count was not measured.

**Measured counts [V]** (`curl https://api.nemar.org/datasets?limit=100&offset=...`, 10 pages):
910 public datasets (583 `on`, 327 `nm`), 909 with a DOI.
305 have a latest version above `1.0.0` (25 `on`, 280 `nm`), so they hold at least two versions each; ten are at `v2.0.0` (five re-pulled mirrors and nm000103 to nm000107).
222 report HED (38 `on`, 184 `nm`).
The total number of version DOIs was not measured; it is one read-only query, `SELECT count(*) FROM dataset_versions WHERE doi IS NOT NULL`, for the owner.

**Re-pull switches, read today [V]** (`nemar admin repull auto`, production, read-only):
`AUTO_REPULL_ENABLED` on, `AUTO_REPULL_MERGE_ENABLED` off, caps at their defaults (2 and 5).
Eleven automatic re-pulls are open, all targeting `v2.0.0`: six `pr_open` held for BIDS validation, five `prepared` and held after `copy-failed (HeadObject:access-denied)`.

### B3. What `+` means under SemVer, measured

SemVer rule 10: build metadata is ignored when determining precedence.
Rule 9: a pre-release has lower precedence than the release.
Measured with the `semver` package the CLI depends on **[V]** (`bun run semver-probe.ts`):

| Comparison | Result |
|---|---|
| `1.0.0+1` vs `1.0.0+2` | equal (0) |
| `1.0.0` vs `1.0.0+1` | equal (0) |
| `1.0.0-1` vs `1.0.0` | lower (-1) |
| `1.0.0-post.1` vs `1.0.0` | lower (-1) |
| `1.0.1` vs `1.0.0+5` | higher (1) |
| `semver.valid("2.0.2+3")` | `"2.0.2"`: the metadata is dropped silently |

So `+N` cannot express "a later version": every tool that sorts by SemVer treats `1.0.0`, `1.0.0+1` and `1.0.0+2` as one version, and normalizing code collapses them into the same string, which here means the same tag, DOI suffix and S3 key.
A pre-release marker orders correctly only if it is attached to the next patch (`1.0.0 < 1.0.1-nemar.1 < 1.0.1`), and it then tells every reader and every package tool that the version is unstable; NEMAR refuses DOIs for pre-releases today **[V]** (`version-doi.ts:88-101`).
A fourth part (`1.0.0.1`, `1.0.0_1`, `1.0.0.post1`) orders correctly with a custom comparator and is safe in every identifier below, but it is not SemVer, and on a mirror `2.0.2.1` cannot be told apart from an upstream four-part tag.

### B4. Is `+` safe in each identifier?

| Surface | Finding |
|---|---|
| Git ref | Allowed: `git check-ref-format refs/tags/v1.0.0+1` passes **[V]**; `~` and `:` are refused **[V]**, which rules out Debian's `~` |
| URL path | Literal: `new URL(".../on003645/v2.1.0+1/manifest.json").pathname` keeps `+` **[V]** |
| URL query | Decoded as a space: `new URLSearchParams("v=v1.0.0+1").get("v")` is `"v1.0.0 1"` **[V]**; the DOI landing target puts the version in `?v=` unencoded **[V]** (`shared/datacite-constants.ts:228`), so every `+` DOI would point at a broken page unless the builder encodes it as `%2B` before the first mint |
| S3 key | AWS lists `+` among characters that "might require additional code handling and most likely must be URL encoded" **[D]** (Amazon S3 object key naming guidelines); not measured against NEMAR's signer or the bucket |
| DOI suffix | DataCite lists `+` as a reserved character that "should not be included in a DOI suffix" **[D]** (DataCite DOI basics); NEMAR already uses `.`, which that page also discourages |
| EZID API | The identifier is put in the request path unencoded **[V]** (`backend/src/services/ezid.ts:355, 373, 405`); EZID's handling of `+` was not tested |
| DataCite `<version>` | Free text with no required format **[D]** (DataCite versioning guidance), so any grammar fits |

### B5. The versions and DOIs already published

**[V]** facts, **[I]** consequences:

- Version DOIs are permanent (ADR 0007, ADR 0018), tags move only by CI (ADR 0016 amendment), and a privacy correction keeps numbers and DOIs (ADR 0085).
  Nothing published is renamed, under any option.
- So a new grammar applies only to versions minted after a cutover, and readers face two grammars on the same dataset forever.
  The published promise "a version that is not `N.0.0` carries a change that NEMAR made itself" stays true for every pre-cutover mirror version and must be kept true or explicitly bounded by date.
- **Taking upstream's number collides with numbers NEMAR has minted.**
  on004362's NEMAR `v2.0.0` is upstream `1.0.1` (owner's notes, re-pull record 3); if upstream releases `2.0.0`, "use upstream's version" names it `2.0.0`, and the tag `v2.0.0` and the DOI `NEMAR.ON004362.V2.0.0` already exist for different content.
  The same holds for any mirror where NEMAR took a patch (`v1.0.2`) that upstream later also releases.
  25 public mirrors are above `1.0.0` today **[V]**.
- **Taking upstream's number can go backwards.**
  A mirror at NEMAR `v1.0.5` whose next upstream tag is `1.0.1` would be released as a lower number: `version-check` refuses it, and the data plane's `latest` (by time) would still serve it as latest.
- Upstream numbers are not always SemVer (`00001`, four parts **[V]**), and many mirrors have no known upstream tag at all (568 not examined on 2026-10-29), so "use upstream's version" needs a rule for each case.

### B6. Recording and verifying who made a change

**[I]**, built only from facts the system already authenticates:

- **One merged pull request is one version.**
  `version-check` requires every pull request to a published dataset to raise `Version` **[V]** (`workflows.ts:86-114`), and the tag follows the merge (versioning guide), so a version has exactly one producing pull request, apart from the first publication and old imports.
- **The origin is read from GitHub, not from git.**
  For the tagged commit, `GET /repos/{owner}/{repo}/commits/{sha}/pulls` gives the pull request; its author is authenticated by GitHub.
  Commit author fields are not evidence; anyone can write them.
- **Classes and precedence:**
  `source` when the author is the dataset's owner or a collaborator the owner granted (ADR 0002), or the commit is a re-pull's `N.0.0` (from the `upstream_repulls` record and its `Upstream-Snapshot` trailer);
  `nemar` when the author is a NEMAR account with the `owner` or `admin` role acting on a dataset it does not own, or the NEMAR App outside a re-pull's `N.0.0` (for example `N.0.1` corrections);
  `community` for any other authenticated GitHub user;
  `unknown` when none of these can be shown, never guessed (ADR 0054).
  A NEMAR administrator who owns the dataset counts as `source` for that dataset (open decision 10).
- **Storage:** `dataset_versions.change_origin` and `change_origin_basis` (`pr-author`, `repull-record`, `publication`, `unknown`), written at version insert where `source_version` is already written (ADR 0111 decision 4); `datasets` gains no column, so ADR 0034's budget is untouched.
  A backfill reads public pull request history and writes only where the value is NULL, as `upstream-backfill` does.
- **Identity caveat:** accounts are matched by login, not by GitHub's numeric id **[V]**, and ADR 0107 records a login no one has registered; storing the numeric id at sign-in would make the match durable.
- **Anonymous deposits (ADR 0065):** the public wire shows the class only, never a name or login, for any dataset that is anonymous.
- **Public display:** the landing version entries gain `origin` beside `mirror`; a mirror's upstream tag, already public in its `SourceDatasets` entry, could join it (today it is kept off the public wire, B2).
- **DataCite:** at version mint, a contributor for the change maker (NEMAR as an organization, or a community person by real name and ORCID iD, only under ADR 0041's rule), a description line naming the change and its pull request, and `IsNewVersionOf` and `IsPreviousVersionOf` links between consecutive versions.
  This depends on #1261 (version DOIs carry no curator today) and must pass ADR 0018's validated-metadata gate.

### B7. Mirrors and the automatic re-pull

**[I]** unless marked:

- Adopting upstream numbers on mirrors supersedes ADR 0006 (it reopens an alternative 0006 rejected) and parts of ADR 0111 (decisions 1, 2 and 5, the `mirror` flag's definition, the CLI's manual-major refusal) and rewrites two public docs pages.
- The switches are the owner's (ADR 0111; `backend/test/repull-switches-flag.test.ts`).
  `AUTO_REPULL_ENABLED` is on, with eleven automatic re-pulls open toward `v2.0.0` **[V]**.
  A grammar change must not land while the automatic path can open or merge under the old rule: the owner turns the open switch off across the cutover, and the RFC says what happens to records already open (merge under the old rule, or abandon before their merge; a merged record cannot be abandoned).
  `AUTO_REPULL_MERGE_ENABLED` stays off throughout.
- With option D (B9), nothing in the re-pull machinery changes: `N.0.0` keeps meaning an upstream pull, and the new `origin` reads `source` for it.

### B8. Grouped additions

**[I]**, grounded in existing decisions:

- **HED annotations added by NEMAR** change sidecars or event files, so each dataset gets one version and one version DOI with origin `nemar`, as today.
  A campaign across many datasets is **one organization RFC**, which also sets an opt-out window for each dataset's owner; each version carries a campaign identifier in its metadata, not in its number.
  ADR 0109's protection of author-owned content still applies to each pull request.
  DOI volume grows by one per dataset touched; with 222 datasets already reporting HED, the campaign's size should be counted before the RFC.
- **Derivatives and post-processing by NEMAR** are not dataset versions at all.
  ADR 0123 (proposed) keeps derivatives in their own keyed store, never in the dataset repository, and the processing plan (draft) gives products their own DOI lineage (`10.82901/NEMAR.<ID>.P.<RECIPE>`, NEMAR as creator).
  They should relate to the dataset version by `IsDerivedFrom`, with no change to the dataset's number.
- **Derivatives an author uploads** into the dataset's `derivatives/` are an ordinary content change and an ordinary version with origin `source`.
- **Neurobagel annotations** are a reviewed file in nemar-cli (ADR 0083), not dataset content, so no version.
- **Privacy corrections** stay the exception: no version (ADR 0085), and the ledger is their record.

### B9. The options

| Option | Who-changed visible | Ordering | Identifier safety | Cost |
|---|---|---|---|---|
| A. `X.Y.Z+N` (owner's idea) | Class only (not who), and only after cutover | Broken under SemVer; `semver` drops it | `+` discouraged by DataCite and AWS; breaks the landing URL unless encoded | Every validator, `version-check` on 1,510 repositories, website, CLI, ADRs 0006 and 0111 |
| B. Pre-release on the next patch (`1.0.1-nemar.1`) | Class, by token | Correct under SemVer | Safe characters | As A, and every reader is told the version is unstable; DOI refusal must change |
| C. Fourth part (`1.0.0.1` or `1.0.0_1`) | Class only | Correct with a custom comparator | Safe characters | As A, and it is not SemVer; ambiguous with four-part upstream tags |
| D. Keep `X.Y.Z`; record origin per version in D1, on the landing page and API, and in DataCite | Who, by class and by name where citable; also for every past version through the backfill | Unchanged | Unchanged | One table change, one backfill, a website field, the DataCite contributor and relation work (#1261) |
| E. As D, and expose a mirror's upstream tag on the public wire | As D, plus upstream's number beside NEMAR's | Unchanged | Unchanged | As D, plus one public field |

D and E show **who**, which A to C cannot, and they also cover the 910 datasets already published, which A to C never can.

### B10. Conditions the versioning RFC must state

1. The definition of "first party" and the origin classes, for `nm`, `on`, `xx` and anonymous datasets.
2. If the grammar changes: the exact grammar, the ordering rule and its comparator, and evidence that each surface in B2 and B4 accepts it, tested on the sandbox DOI shoulder and an `xx` fixture before the first real mint, since a minted DOI can never be withdrawn.
3. The cutover: from which date it applies, that no published tag, DOI or manifest is renamed, and which published promises stay true for older versions.
4. For mirrors: what happens on collision with a number NEMAR already minted, on a lower upstream number, on a non-SemVer upstream tag, and on an unknown tag.
5. What evidence establishes the origin of a version, what is `unknown`, and that unknown is never guessed.
6. What anonymity (ADR 0065) and real-name attribution (ADR 0041) allow to be shown.
7. The ADRs it supersedes or amends (0006, 0111, and the DataCite parts of 0041), and the docs pages it rewrites.
8. The owner's re-pull switches during the cutover, and the fate of open re-pull records.
9. The rollout of `version-check` to 1,510 repositories (ADR 0020): canary on `nm099999`, then batches.
10. Grouped additions: campaigns as one RFC with an owner opt-out, and derivatives outside the version line.
11. DOI volume: whether every origin still gets a version DOI (recommended, as today).
12. The decision criteria, written before comments open.

### B11. Recommended framing

**[I]**

- **Title:** "Show who made each change to a dataset version."
  Lead with the problem, not the `+` syntax, so commenters judge the goal before the mechanism.
- **Proposal:** option E, with A to C presented fairly as alternatives and their measured costs (B3, B4, B5), including the collision example.
- **Questions for commenters:**
  1. Would a visible origin (source, NEMAR, community) on each version change how you cite or trust a dataset?
  2. Do your tools parse NEMAR version strings, tags, DOIs or data-plane paths, and would a grammar outside `X.Y.Z` break them?
  3. For mirrors, is OpenNeuro's version shown beside NEMAR's enough, or do you need it inside NEMAR's number?
  4. For curation campaigns such as HED, what notice and opt-out should a dataset's owner get?
- **Pre-registered criteria:** a grammar change is adopted only if commenters show a use that metadata cannot serve, and the identifier evidence of condition 2 is complete.
- **Before drafting:** measure the number of version DOIs and a sample of origins from pull request history, so the RFC cites real numbers rather than estimates.
- **Order:** open the `.bzx` RFC first (additive, no published identifier changes), and this one second, once the counts are in.

---

## Open decisions for the owner

| # | Decision | Recommendation |
|---|---|---|
| 1 | Where a dataset RFC's thread lives | The dataset repository's own Discussions, switched on for that repository when the RFC opens; record in `nemarOrg/rfcs` |
| 2 | Length cap of the one extension | At most 14 days, granted once by the shepherd before the close, with a posted reason (so at most 35 days in all) |
| 3 | What final comment means | Inside the window: the shepherd's summary and proposed disposition, at least 7 days before the close; required for an acceptance |
| 4 | Who decides | The owner for organization RFCs, answering each substantive objection in writing; for a dataset RFC, NEMAR with the dataset owner's recorded position, and the owner's consent for changes to author-owned content |
| 5 | Who may open | Anyone proposes; a NEMAR owner or administrator opens as shepherd |
| 6 | RFC to ADR | An accepted RFC, or a rejection that closes off a reasonable path, gets an ADR that names the RFC; the ADR wins |
| 7 | Comments without a GitHub account | Yes: through the support address, posted with consent |
| 8 | Licenses for `nemarOrg/rfcs` | MIT for tooling, CC BY 4.0 for text |
| 9 | Where the clock runs, and its token | A scheduled Action in `nemarOrg/rfcs`, plus a weekly report line that shows a stopped clock; for dataset threads, add the Discussions permission to the NEMAR App (an owner act across 1,510 repositories) |
| 10 | What "first party" means | The dataset's source (depositor and authors for `nm`, upstream for `on`); NEMAR and community are separate named origins, and an administrator who owns a dataset counts as its source |
| 11 | The proposal the versioning RFC carries | Option E: keep `X.Y.Z`, record and show origin per version, expose the upstream tag; `+N` and the alternatives presented with their measured costs |
| 12 | Upstream numbers for mirrors | No for existing mirrors (collision with minted NEMAR numbers); show the upstream tag beside NEMAR's number instead |
| 13 | Grouped additions | A campaign is one organization RFC with an owner opt-out and one version per dataset with origin `nemar`; derivatives stay outside the version line (ADR 0123 and the processing plan) |
| 14 | Re-pull switches during the RFC | No change needed for option E; if a grammar change is accepted, turn `AUTO_REPULL_ENABLED` off across the cutover and decide the open records first |
| 15 | Order of the first two RFCs | `.bzx` first, versioning second after the version and origin counts are measured |

**Incidental finding, outside this plan's scope [V]:** five automatic re-pull records (on003774, on003751, on003708, on003702, on003626) are held after `copy-failed (HeadObject:access-denied)`, the latest on 2026-11-20 at 03:00 UTC, so the S3 permission problem first seen on 2026-11-09 still affects some datasets.

---

## Appendix: the reads this document rests on

```bash
gh api graphql   # hasDiscussionsEnabled on .github, nm000103, on003645, nemar-cli, docs
gh api graphql   # nemarOrg repositories; nemarDatasets repositories paged (1,500 of 1,510), totalCount by privacy
curl -s -o /dev/null -w '%{http_code}' https://github.com/orgs/<org>/discussions   # 404 for both
gh api repos/nemarOrg/rfcs                                                       # 404
gh api repos/nemarDatasets/.github/contents/.github/workflows/run-version-doi.yml
gh issue view 1261 -R nemarOrg/nemar-cli                                          # OPEN
curl -s 'https://api.nemar.org/datasets?limit=100&offset=N'                       # N = 0..900
curl -s https://docs.nemar.org/platform/doi-and-versioning.md
curl -s https://docs.nemar.org/cli/guides/versioning.md
nemar admin repull auto                                                           # production, read-only
git check-ref-format refs/tags/v1.0.0+1                                           # and four other forms
bun run semver-probe.ts   # semver.compare, semver.valid, URLSearchParams, new URL
```

External documentation read: Amazon S3 object key naming guidelines, DataCite "DOI basics" and "Versioning", OME-NGFF RFC-1.
Rust RFC, PEP 1 and BIDS BEP descriptions are from prior knowledge and were not re-read.
