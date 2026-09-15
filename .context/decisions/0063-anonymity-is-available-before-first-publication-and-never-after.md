# ADR 0063: Anonymity is available before first publication and never after, and it is withheld by the writer

**Status:** accepted
**Date:** 2026-09-15
**Owner:** Seyed Yahya Shirazi

## Context

Conferences that review double-blind reject a submission whose dataset names its authors, so a
depositor today must choose between depositing and submitting. NEMAR can serve both: the data
readable, the depositor concealed, until the paper is accepted.

The analysis is `.context/draft-anonymous-deposit-analysis.md` (requirements R1-R5, a
twelve-item leak inventory, predicates A1-A10). The data-plane phase (#1403, ADR 0064) made
the readable half possible -- the data plane serves a dataset's git-tracked metadata itself,
so a repository can stay private without the dataset becoming unreadable. This ADR is the
concealed half.

Four facts about the existing system shape it, and each was checked rather than assumed:

- **Nothing records that a dataset has been published.** `datasets.publish_date` is written by
  no code. `visibility` is current state with no history, and the admin visibility route leaves
  no row-local trace at all.
- **The obvious substitute is unsound.** `repo_public` runs before `doi_create`
  (`shared/publication-steps.ts`), so a crashed publish leaves `visibility='public'` with
  `concept_doi IS NULL`. Any predicate of the form "no DOI means never published" is wrong for
  exactly the datasets whose history is most confused.
- **The leak is field-level and the machinery is row-level.** ADR 0017's rule answers "may this
  caller see this row". Anonymity needs "this row is visible, these fields are not", and there
  is no chokepoint: `dataset-filters.ts` governs `FROM`/`WHERE`, not `SELECT`, and the owner is
  joined in five separate projections. The split cuts both ways, which the first draft of this
  ADR noticed and then did not follow through on: `?owner=<username>` matches the REAL username
  in a `WHERE` clause, so a projection that nulls the returned name still answers the question
  "did this person deposit this".
- **`datasets.authors` reaches the full-text index through a trigger**, with no visibility
  predicate, so a read-time filter would hide names from the API while leaving them searchable.

## Decision

**Anonymity is available only before a dataset's first publication, and the database enforces
it.** Migration 0085 adds `first_published_at` and `anonymous` to `datasets`, plus two triggers
that refuse any row which is simultaneously anonymous and published. The rule is in the schema
rather than in a service because a service check is one a future route can forget, and this one
protects a person who was promised concealment.

Retracting an already-public attribution is theater: DataCite is harvested, the landing page is
indexed, and the git history is in every clone. So publication is a one-way door.

**Two columns, spent deliberately.** ADR 0034 caps `datasets` and asks whether a fact can be
derived at read time; neither of these can, as the crashed-publish case above shows.
`first_published_at` also closes a gap that predates this feature. `anonymous` is
authorization-adjacent and filtered in SQL, so it does not belong in the `sweep_stamps` JSON
(ADR 0035), whose convention -- a missing key means "not yet swept" -- is precisely wrong for a
fact whose absence must mean "not anonymous". The budget goes 81 to 83 against a ceiling of 97,
and the pin in `datasets-column-budget.test.ts` is bumped deliberately: the tripwire working.

**`first_published_at` means "public WITH attribution", not "public".** An anonymous deposit is
deliberately `visibility='public'`, so a stamp on every transition to public would forbid the
state this ADR adds. Every path to public therefore carries `FIRST_PUBLICATION_STAMP_SQL`,
which takes the stamp only when the row is not anonymous -- and every path means every path:
the publication orchestrator, the admin visibility service, and the direct make-public route.
A single writer was not enough. The first draft stamped only in the orchestrator, which left
`nemar admin make-public` able to publish a dataset with the column still NULL, and therefore
able to make an already-published dataset anonymous afterwards -- the exact thing the triggers
exist to refuse.

**Identity is withheld by the WRITER, not filtered by the reader.** Wherever NEMAR writes the
depositor's identity, the writer checks anonymity, so the public columns never hold the real
values and no read site has to remember anything:

- `enrich-dataset.ts` writes the blinded author label into `datasets.authors`, which keeps the
  real names out of `datasets_fts` by construction, and strips attribution from
  `.nemar/metadata.json` before committing it. That file is backend-authored, so no depositor
  scrub can suppress it, and since #1403 it is publicly served from the manifest -- checked on a
  live public dataset, where it returns 200 and names the authors. What is stripped is
  everything that names a person or their group: authors, contributors, funding references, and
  also geo-locations and related identifiers, which name an institution and point at the
  submitting group's own preprint respectively.
- `doi.ts` omits the DataCurator while anonymous, and both mint sites pass the flag. ADR 0041
  says a DOI cites the uploader by real name or not at all; this is the "not at all" branch, on
  an identifier that stays `reserved` and is therefore never harvested. Zenodo has no
  unattributed form -- `creators` is mandatory -- so that branch refuses instead.
- The same function's DOI metadata sync is skipped entirely while anonymous. It rebuilds the
  DataCite document from live state and would otherwise undo, a hundred lines later and in the
  same call, the blind applied above it. A reviewer found this by reading the whole function
  rather than the diff.
- The admin routes that write the same surfaces are closed too: `POST
  /datasets/:id/enrichment` is a second writer of `.nemar/metadata.json` and now blinds what it
  commits, and `POST /datasets/:id/doi/update` refuses both `status: public` and a metadata
  rebuild while the flag is set.

**The owner is the exception, and it takes three rules rather than one.** `owner_username` and
`owner_github` are joined from `users` at read time and cannot be kept out of the row by a
writer, so `OWNER_USERNAME_SQL` / `OWNER_GITHUB_SQL` in `services/anonymity.ts` are the single
definition of when an owner is PROJECTED, interpolated at every projection. A source-level test
fails if any site spells the join out instead, with an explicit allowlist for the admin and
service reads that resolve identity on purpose -- because R5 says anonymity is toward the public
and never toward the archive.

Projection is not the whole surface, and assuming it was is how the first draft shipped two
holes. `GET /datasets/:id` is `SELECT d.*`, so it served the raw `owner_user_id` beside the
nulled username: fetch it for the anonymous dataset, find any other public dataset with the
same value, read its disclosed owner. One request, and a stable pseudonymous handle linking a
depositor's several anonymous deposits even with nothing to join against. And `?owner=` filters
on the real username, confirming authorship without ever projecting it. Both are closed at
their own sites, because neither is reachable from a `SELECT` list.

**Anonymity is not a visibility value.** The dataset stays `visibility='public'`: listed,
browsable, downloadable. The repository is private instead. That breaks three predicates that
had been using "public row" as a proxy for "public repo", and all three are updated rather than
left to rot: the zarr fidelity sweep (which would stamp `unverifiable` forever), the staleness
candidates (which would stop nagging an abandoned anonymous deposit), and fleet drift (which
would report every anonymous deposit as `PUBLIC_UNPROTECTED`).

**De-anonymization is ordered, and the publication route refuses to proceed without it.**
Restoring attribution is a content commit to `dataset_description.json`, not a flag flip, and it
has to land while the repository is still private, because ADR 0001 makes `main`
pull-request-only once public. NEMAR keeps no shadow copy of the real author list and needs
none.

The first draft claimed this came for free: that the blinded label is a string ADR 0026's
`PLACEHOLDER_AUTHOR` matches, so the existing submission-minimums gate already refused a
still-blind publication request. That was wrong twice over, and it is recorded here because it
is the kind of claim that reads as a citation and is really an assumption. The regex is anchored
on the whole entry (`^anonymous$`), so it does not match `Anonymous (withheld until
publication)`; and the gate reads `dataset_description.json` from the repository, so it never
sees NEMAR's `datasets.authors` column at all. The interlock is therefore written out:
`routes/datasets/publication.ts` blocks a request from an anonymous deposit with the reason
`anonymous_deposit`, naming both halves of the fix. Publication then stamps `first_published_at`
and clears `anonymous` in the SAME statement that makes the repository public -- one statement
because the triggers refuse the intermediate state, and at that step rather than at the end of
the run because every later step can fail and return, which would otherwise leave a dataset
public in the world and anonymous in D1 forever.

## Consequences

Easier: a depositor can submit to a blind venue without choosing between depositing and
reviewing. The archive keeps full knowledge throughout (R5), so the record becomes properly
attributed at acceptance rather than being reconstructed.

Harder, and worth stating plainly:

- **NEMAR cannot blind the depositor's own files.** `Authors`, `Funding`, `Acknowledgements`,
  `EthicsApprovals`, free text in README and `participants.tsv`, and identifiers inside signal
  headers are the depositor's to scrub. The mechanical blind check that reports what still names
  somebody is phase 4's, and until it exists the guarantee is "NEMAR adds nothing", not "nothing
  names you".
- **Cached responses outlive a state change.** Nothing purges the edge, per-URL purge caps at 30
  URLs and prefix purge is Enterprise-only, so anything already fetched stays fetchable for its
  TTL. This is why ADR 0064's brokered files are `max-age=300` rather than `immutable`, and it
  bounds how quickly a deposit can become anonymous after it has been read.
- **Anonymity applied late is anonymity applied to a record that is already out.** Enrichment
  runs on upload, so by the time a depositor asks to be concealed the real names are usually in
  `datasets.authors`, in the `enrichment_json` the detail route serves raw, and committed to
  `.nemar/metadata.json`. `markAnonymous` therefore scrubs D1 in the same statement that sets
  the flag, and returns `repoMetadataStale` for the one surface it cannot reach from the
  database. A flag flip alone would have been a promise already broken at the moment it was
  made.
- **An abandoned anonymous deposit now sends admins mail that names its depositor.** The
  staleness warning pairs the dataset id with the owner's email, and widening the candidate
  predicate routes anonymous deposits into it. That is admin-only and consistent with R5, but
  it is the first NEMAR mail that names a concealed depositor, so it is written down rather
  than discovered.
- **`visibility` and repository state have come apart.** Every future predicate that means
  "readable on GitHub" must say so rather than reading `visibility`, and the three fixed here
  are evidence the proxy was load-bearing in places nobody had listed.

**The staging fleet carries one standing anonymous deposit.** `xx099907` is created anonymous
and never published, because the state is otherwise only ever exercised against rows a test
builds and tears down in the same process. It could not be an existing exemplar: all seven are
public with sandbox DOIs, so the 0085 backfill stamps `first_published_at` on every one and the
triggers then refuse `anonymous = 1` -- which is the invariant working, and the reason the
fixture had to be declared rather than borrowed. Publishing it destroys it permanently, so the
fleet file marks it, the clone tool skips it under `--all --publish`, and the
publication-request route refuses it.

**A blinded deposit is submitted blinded, and that is an EXCEPTION to the submission
standards rather than a silent special case.** NEMAR asks the depositor to anonymize their own
`dataset_description.json` before requesting an anonymous release, exactly as a double-blind
venue asks for a blinded manuscript, and restores attribution at acceptance. The alternative --
accepting real names and having NEMAR conceal them -- was considered and rejected as
unachievable: that file is git-tracked, part of the dataset, and served publicly from the data
plane, so NEMAR cannot conceal what it says.

So ADR 0026's `Authors` rule INVERTS for an anonymous release rather than relaxing. A
publication requires at least one real name; a release requires none, and both require a
non-empty field. The two are exact complements over the same input, which is what makes
"blind to release, restore to publish" an enforced ordering rather than advice. Every other
minimum -- a descriptive Name, an ethics statement -- applies unchanged.

The enforcement stops at what is structured. `Authors` is checked because it is a field;
README, `participants.tsv` and identifiers inside signal headers are the depositor's to scrub
and are REPORTED by the blind check, never enforced at the gate. The exception set is listed
for depositors on `docs.nemar.org` (#1412), because a requirement that is waived in one
direction and reversed in another is not something anyone should have to infer from a refusal
message.

**What a blinded submission cites is the landing page, never the DOI.** The identifier is
minted at release but stays `reserved` -- registered, not advertised, and it does NOT resolve.
So it cannot do a citation's job during review, while `nemar.org/dataset/<id>` resolves and
states why the dataset has no authors, which is strictly more informative to a reviewer. Both
surfaces follow from that: `nemar dataset status` marks the DOI `(reserved)` and prints a
`Cite:` line, and the data plane serves `external_links.dataset_doi: null` while anonymous so a
dead identifier never reaches signposting, JSON-LD or a citation widget. Reserving early is
still worth it -- the same identifier becomes the real one at publication -- but reserving is
not publishing, and no surface may blur the two.

## Alternatives considered

- **Filter identity at read time.** The obvious design, and it leaves the real names in
  `datasets_fts` (fed by a trigger, not a query) and in `.nemar/metadata.json` (backend-written
  and publicly served). It also inherits ADR 0017's recurring cost at every read site, where
  getting one wrong exposes a person rather than a private row.
- **Model anonymity as a third `visibility` value.** Tempting, and it would have silently
  changed the meaning of every `visibility = 'public'` predicate in the codebase, including the
  ones that gate the data plane and the bucket policy. The breakage would have been discovered
  by users.
- **A side table for anonymity state.** ADR 0034 rejected side tables for dataset attributes and
  its reasoning holds: the catalog read path and FTS are built on one table.
- **Keep a server-side copy of the real author list and restore it automatically.** Rejected:
  it means storing the identity in a second place for the sole purpose of a flip that the
  depositor has to perform anyway, and ADR 0026's gate already prevents publishing while blind.
- **Mint a public DOI with anonymized creators.** Rejected in the analysis (A6) and reaffirmed
  here: DataCite records are harvested and snapshotted, and it inverts ADR 0041.

## Receipts

- Epic #1406, issue #1407; ADR 0064 (the data-plane half this depends on, #1403)
- ADR 0034 (the column budget this spends from), ADR 0035 (why not `sweep_stamps`),
  ADR 0017 (row-level visibility, and why it cannot express this),
  ADR 0026 (the placeholder-author gate that orders de-anonymization),
  ADR 0041 (real name or not at all), ADR 0001 (`main` is pull-request-only once public)
- Rules: `backend/src/services/anonymity.ts`, migration `0085_anonymous_deposit.sql`
- Guards: `backend/test/anonymity.test.ts` (the invariant, and the FTS assertion with its
  control), `backend/test/anonymity-projection.test.ts` (one owner rule),
  `backend/test/anonymity-writers.test.ts` (the blinding, driven through `enrichDataset`
  itself rather than through a hand-written fixture),
  `backend/test/anonymity-publication-paths.test.ts` (every path to public carries the stamp)
