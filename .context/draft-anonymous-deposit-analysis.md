# Draft: anonymous deposit for double-blind review

**Status:** analysis, no decision taken.
**Date:** 2026-09-14
**Owner:** Seyed Yahya Shirazi

Conferences that review double-blind reject a submission whose data record names the authors.
A depositor who wants to submit to one of those venues currently has two choices,
both bad: keep the data out of NEMAR until the paper is accepted,
or deposit it and break the blind.

This document works out what would actually have to be true for NEMAR to serve that case.
It takes no decision; the decision belongs in an ADR,
and the ADR cannot be written until the collisions in section 5 are settled.

---

## 1. What is being asked for, stated precisely

Five requirements, and they are not the same requirement.

**R1 Reviewer access.**
Reviewers can obtain and inspect the data from the submission alone,
without creating an account and without contacting the authors.

**R2 Author concealment.**
Nothing reachable from the submission reveals who deposited the data.

**R3 Reviewer concealment.**
The authors do not learn who the reviewers are.
Double-blind runs in both directions,
and every access mechanism NEMAR has today violates this half.

**R4 Reversibility.**
At acceptance the record becomes the real, attributed, citable record,
with the identifier in the camera-ready still resolving.

**R5 Attribution to the archive.**
NEMAR knows exactly who deposited it, throughout.
Anonymity is toward the public, never toward the archive.

R5 is what separates this from a genuinely anonymous drop box.
Without it there is nobody to hold to the deposit attestation (ADR 0024),
nobody to contact about a consent problem,
and an obvious abuse channel.
The feature to build is **pseudonymous deposit**, not anonymous upload,
and the name matters because it settles several arguments below before they start.

---

## 2. The leak inventory

The working assumption, stated in the original framing, was that the challenge is public search plus GitHub.
Those are two of twelve, and the two that are hardest to fix are not on that list.
Everything below was verified against production on 2026-09-14 unless marked otherwise.

### 2.1 Verified, live, and unintended today

**`uuid.log` on the `git-annex` branch names the depositor's account, machine and directory.**
`git annex init` with no `--description` records `user@host:/absolute/path`,
and `initDataset` in `src/lib/git-annex/init.ts` passes no description.
That line is committed to the `git-annex` branch and is public when the repo is public.
On `nm000281`, which is public right now:

```
b6200c43-...  bpinto@login01:/expanse/projects/nemar/bruno/emg2pose_nemar/bids
```

A login name, an HPC login node, and a path carrying a first name.
Nobody chose to publish that and nobody would think to scrub it.
This is a live disclosure independent of anything in this document,
and section 7 treats it as its own work item.

**Commit authorship carries a personal email address.**
`nm000281`'s public history is authored by `Bru <b.aristimunha@gmail.com>`,
linked to the GitHub account `bruAristimunha`.

**The deposit is attributed on GitHub.**
`GET /repos/nemarDatasets/nm000281/contributors` answers anonymously with `["bruAristimunha", "nemarAdmin"]`,
the push events appear on that account's public activity,
and every later change is a pull request authored by it (ADR 0001 makes published datasets pull-request-only,
and `gh pr create` runs on the depositor's machine with the depositor's token).

### 2.2 Verified, and working as designed

**`GET /datasets/:id` serves `owner_username` and `owner_github` to anonymous callers.**
`backend/src/routes/datasets/catalog.ts`, both the list and the detail projection.

**The website falls back to the depositor's handle when the author list is empty.**
`DatasetCard.astro:33`: `formatAuthorByline(dataset.authors) || dataset.owner_username || "NEMAR"`.
Scrubbing `Authors` therefore makes concealment strictly worse:
it swaps the paper's author list for the depositor's NEMAR handle.

**`datasets.authors` is a search field, a facet and a filter.**
It is populated by enrichment from `dataset_description.json`,
indexed in the full-text search table (ADR 0003),
and exposed as `nemar dataset list --author`.

**The DataCite record is public, harvested and permanent.**
Creators come from the author list; the depositor is added as a `DataCurator` contributor by real name (ADR 0041);
ORCID identifiers ride along on both.
EZID is the registrar (ADR 0007) and the record propagates to DataCite Commons and OpenAIRE.

**Zarr republishes attribution.**
Index format v3 carries dataset-level `doi`, `license` and `citation`,
and every store carries a `nemar` root attribute with the same,
served from public S3 at `zarr.nemar.org`.

### 2.3 Inside the deposit itself

**`.nemar/metadata.json` is committed to the repo and carries the author list plus collected co-author ORCID identifiers.**
An ORCID iD is a permanent global identifier;
one of them in the record de-anonymizes the entire author list in a single lookup.
This is the highest-value leak in the set and the least visible.

**BIDS metadata names people by design.**
`dataset_description.json` has `Authors`, `Funding`, `Acknowledgements` and `EthicsApprovals`;
an institutional review board protocol number identifies the institution even with no name attached.
`README` and `CHANGES` are free text.
`participants.tsv` and `scans.tsv` carry free text and acquisition dates.

**The recordings themselves carry identity.**
European Data Format and BioSemi Data Format headers have a recording-identification field,
EEGLAB `.set` files carry `EEG.comments`,
and Functional Imaging File Format headers carry subject and experimenter fields.
Magnetoencephalography and electroencephalography toolchains ship de-identification helpers precisely because of this.

### 2.4 Weak signals

Dataset identifiers are assigned sequentially in reserved bands (ADR 0011),
so deposit order is public and adjacency is informative to somebody who already knows one neighbour.
Deposit timestamps correlate with submission deadlines.
Neither is worth designing against on its own; both are worth one sentence in the user-facing guidance,
because a depositor who believes the blind is perfect will behave differently from one who knows it is merely good.

---

## 3. Option A: keep the repository private during review

The dataset stays `visibility=private`.
The repository is private, the bucket policy keeps the objects unreadable,
and D1 filters it out of every catalog surface (ADR 0017).
At acceptance the normal publish flow runs.

**What it solves.** Every leak in 2.1 and 2.2 becomes unreachable, because nothing is public.
That is most of the inventory, with no new code.

**What it does not solve, and this is the whole problem.**
Reviewers cannot read it.
The two access mechanisms that exist today, a GitHub collaborator invitation (`nemar dataset invite`)
and an access request (`nemar dataset request-access`),
both require the reviewer to hold a GitHub account and a NEMAR account,
and both tell the depositor exactly who asked.
That violates R3.
For a double-blind venue this is not a rough edge;
it is worse than no anonymity at all, because the authors end up holding reviewer identities.

So Option A is not a design by itself.
It is a design only when paired with an access path that is unattributable in both directions.

### Predicates

**A1. A capability link, not an invitation.**
An unguessable token in a URL, granting read without an account,
recording nothing the depositor can see.
New machinery: a token row, an expiry, a scope, a revocation path, and a serving path.

**A2. The serving path cannot go through GitHub.**
A git-annex clone needs a GitHub credential,
and there is no way to hand a reviewer a read grant on a private repository without either
making it public or naming an account.
The link therefore has to be served by the Worker over presigned object URLs.
That is exactly what `data.nemar.org` already does for published datasets
(`backend/src/routes/data.ts`, `generatePresignedGetUrl` in `services/s3.ts`),
so the honest shape is a token-gated mode on a router that already resolves versions,
renders a file listing, and presigns.
The cost to reviewers is that they browse and download over HTTP instead of cloning,
which for review is usually an improvement, since it removes the git-annex install.

**A3. The identifier has to be a reserved DOI.**
Venues increasingly want an identifier in the submission,
and you cannot have a resolving DOI and a concealed dataset at the same time.
Three ways out, and only one is clean.

*Mint a public DOI with anonymized creators and fix it later.* Reject.
DataCite records are harvested and snapshotted; there is no un-harvesting.
It also inverts ADR 0041, which exists to keep exactly this kind of placeholder out of a permanent record.

*Carry no identifier.* Workable, weak, and some venues object.

*Reserve the identifier.* EZID supports `_status: reserved`,
and `backend/src/services/ezid.ts` already implements creation as reserved,
transition to public, and deletion of a reserved identifier.
The string exists and is stable enough to cite in a camera-ready;
it is absent from the public index and does not resolve;
if the paper is rejected the identifier is deletable.
At acceptance the same identifier goes public against the same dataset with the real creators,
which is R4 satisfied with the identifier unchanged.
This capability is built and unused for this purpose,
so it is close to free.

**A4. Scrubbing is deferred, not removed.**
On the day the dataset goes public, `uuid.log` still names a machine
and the commits still carry a personal email address.
For double-blind that is acceptable, because by then attribution is wanted,
but it is only acceptable if nothing went public early.
The publish flip has to remain the single auditable moment, which is how ADR 0017 already works.

**A5. One link, and the product has to say so.**
A blinded submission that carries both a review link and a repository URL is self-defeating.
The command should print exactly one URL and say what it is for.

**A6. Scheduled cleanup will delete a dataset that is under review.**
Stale `nm` datasets that are private, without a DOI, without an active publication request,
and inactive for ninety days are deleted by the daily cron (migration 0011).
A review window runs three to nine months.
A reserved DOI is not a `concept_doi` and a review link is not a publication request,
so nothing in the current predicate protects such a dataset,
and it would be deleted mid-review, silently.
The fix is one clause in one predicate, and it has to be written down before the feature ships,
not discovered afterwards.

**A7. The window needs a default, a cap, and a defined expiry behaviour.**
Expiry must revert to private and notify the depositor.
It must never publish anything automatically.

---

## 4. Option B: deposit through the NEMAR service account

The deposit is made by NEMAR.
`owner_user_id` points at a service account (ADR 0048),
the commits are authored by the bot,
and the push comes from the GitHub App.
The real depositor is recorded separately.

**The precedent already exists in production.**
Every OpenNeuro import is this shape:
`on008768` serves `owner_username: nemarAdmin`, `owner_github: null`,
and its commits are authored by `nemar-publish-bot`.
A dataset whose public record names no human depositor is not a new concept here;
it is most of the catalog.

**What it solves.** The GitHub-identity family, 2.1 in full, permanently rather than by deferral,
plus `owner_username` in 2.2.
That is precisely the set Option A defers rather than removes.

### Predicates

**B1. The bytes are the hard part, not the commits.**
Git metadata can already be committed server-side:
`commitFilesAsTree` in `backend/src/services/github/contents.ts` commits as the bot with the App token,
and is used today for continuous-integration workflow files.
What cannot move server-side is the data,
which goes from the depositor's machine to the bucket through git-annex with per-user credentials,
and ADR 0010 forbids routing that traffic through the Worker.
The shape has to be: depositor uploads to the bucket as today,
then the backend composes and commits the pointer tree as the bot.
That is implementable, because annex keys are deterministic and the client already computes them,
but it is a second deposit path, not a flag on the existing one.

**B2. The annex branch is still written by the client.**
See 2.1.
Either pass a non-identifying `--description` to `git annex init`, which is a one-line change,
or have the backend build the annex branch, which is not.
The one-line change is worth making regardless of whether this feature is ever built.

**B3. Accountability has to move somewhere that tooling reads.**
Quota, abuse handling, the deposit attestation (ADR 0024), the publication request,
and the contact of last resort all currently key off `owner_user_id`.
A `real_depositor_user_id` column is the obvious answer,
but `datasets` is under an enforced column budget (ADR 0034),
and ADR 0035 reserves the JSON stamp column for bookkeeping.
Ownership is a first-class relationship that wants to be joined and indexed, not a stamp,
so the column is probably right, and that argument belongs in an ADR rather than in a migration nobody reviews as a decision.

**B4. Ownership semantics get strange, and this is the deepest problem.**
If the service account owns the dataset, it owns the permissions.
Deletion of a published dataset is owner-only;
merging its pull requests is governed by GitHub collaboration.
The real depositor loses the ability to act on their own dataset
unless NEMAR grows a permission vocabulary of its own,
which ADR 0002 explicitly declined to build.

There is an escape, and it is the reason the two options are complementary rather than alternative:
**on a private repository, collaborators are not publicly listed.**
Option A plus Option B together dissolve B4.
The depositor stays a collaborator throughout, invisibly, because the repository is private;
the bot authors the commits;
at publication the repository goes public with a history that never named anyone.

**B5. It has to be temporary, or it is a false record.**
A dataset that stays service-owned after publication tells the public that NEMAR deposited it,
which is false, and is the exact failure mode ADR 0041 exists to prevent.
Git history is append-only, so attribution cannot be restored retroactively without a rewrite,
and a rewrite of a published dataset is not on the table.
The resolution is that git history staying bot-authored is honest,
because NEMAR's automation genuinely made those commits;
attribution belongs in the places that carry it,
which are the DOI record, `dataset_description.json`, and the D1 owner,
all of which are set at publication.

**B6. ADR 0041 needs an answer, not an exemption.**
`requiresUploaderName` exempts OpenNeuro imports and the exemplar fleet from the citable-name requirement.
A third exemption would be the wrong instrument,
because the depositor does have a citable name and does want it cited, just not yet.
The curator attribution should come from the real depositor at the moment of de-anonymization,
which makes the exemption temporary and keeps the permanent record complete.

---

## 5. Collisions with standing decisions

Three, and each needs an explicit answer before any code.

**ADR 0026, submission minimums.**
`backend/src/services/submission-minimums.ts` hard-gates native publication on named, non-placeholder authors,
and its rejection message reads
"anonymous submissions and placeholder entries are not accepted".
`PLACEHOLDER_AUTHOR` matches the literal string `anonymous`.
This is a deliberate policy, not an oversight, and it forbids the feature as stated.
The reconciliation is that the gate applies at publication, which is exactly when the blind ends,
so the feature never needs it relaxed.
That has to be stated, because a reader of the gate will otherwise conclude the feature was snuck past it.

**ADR 0041, DOIs cite the uploader by real name or not at all.**
See B6.

**ADR 0002, access control rides on GitHub collaboration.**
A capability link is a NEMAR-side read grant that GitHub cannot express.
It does not contradict ADR 0002's reasoning, which is about not proxying ordinary git operations,
but it does add a second access vocabulary, and the ADR's consequences section already anticipates this
("anything GitHub cannot express, we cannot express").

---

## 6. The option that was not raised, and why it is rejected

Do nothing in NEMAR.
Document that depositors should keep the dataset private
and share a snapshot themselves through a service built for anonymized sharing.
Zero engineering.

Rejected: it sends the depositor to another product at the moment NEMAR wants the deposit,
and a self-hosted snapshot has no provenance link to whatever eventually gets published,
so a reviewer cannot verify that the accepted dataset is the reviewed dataset.
That verification link is the thing an archive is uniquely able to provide.
It is the actual value on offer here, and it is worth building for.

---

## 7. What follows from this

**Now, and independent of any decision below.**
Pass a non-identifying description to `git annex init`.
Decide separately what to do about the repositories that already carry the default one.
This is a live, unintended disclosure of account names, hostnames and directory paths on public repositories.

**The design, if it proceeds.**
Private dataset, reserved EZID identifier, and a tokenized expiring account-free review link
served by the existing `data.nemar.org` router.
That satisfies R1 through R4 and preserves R5,
and the great majority of it is configuration of machinery that already exists.

**The second phase, if the case is confirmed.**
Bot-authored deposit, per Option B.
It is required only for a case not raised in the original framing,
namely a venue or a journal that requires the data to be openly available at submission,
which Option A cannot serve at all.
Confirm that the case is real before building for it.

**A blind check, in the same shape as `evaluateSubmissionMinimums`.**
The blind holds only if the deposit itself is scrubbed,
and a mechanical report of what still names somebody
is worth more than a paragraph of policy:
`Authors`, `Funding`, `Acknowledgements` and `EthicsApprovals` in `dataset_description.json`,
ORCID identifiers in `.nemar/metadata.json`,
recording-identification fields in signal file headers,
and a free-text scan of `README`, `CHANGES` and `participants.tsv`.

**The ADR, before the code.**
It has to answer section 5 explicitly,
and it should be named for what the feature is,
which is pseudonymous deposit with reviewer access, not anonymous upload.
