# ADR 0065: Anonymity is available before first publication and never after, and it is withheld by the writer

**Status:** accepted
**Date:** 2026-09-15
**Owner:** Seyed Yahya Shirazi

## Context

Conferences that review double-blind reject a submission whose dataset names its authors, so a
depositor today must choose between depositing and submitting. NEMAR can serve both: the data
readable, the depositor concealed, until the paper is accepted.

The analysis is `.context/draft-anonymous-deposit-analysis.md` (requirements R1-R5, a
twelve-item leak inventory, predicates A1-A10). The data-plane phase (#1403, ADR 0066) made
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

**Amendment 2026-09-16 (#1423), SUPERSEDED 2026-09-17 by #1433 (epic #1430).**
What #1423 got right survives and is stated below; what it built was withdrawn a day later, so
the original text is replaced rather than left standing with a pointer. It described an
exemplar gate that took the request's intent and a clone tool that blinded `Authors`; neither
exists.

**What was right, and is still the decision.** `anonymous = 1` is not evidence that a release
HAPPENED. It is true of a depositor's deposit, where `anonymous` and `public` arrive together
at the release, and false of a row CREATED anonymous -- which `POST /admin/datasets/exemplar`
does, and which the decision above deliberately permits ("set at INSERT rather than flipped
afterwards, because this is the only moment it is unconditionally legal"). So the request
route's `already_released_anonymously` requires `visibility = 'public'` as well, because the
release is what makes a row public. That term is in the code today and has its own test.

**What was wrong.** #1423 widened `isExemplarPublishAllowed` with an `ExemplarPublishIntent`
so the fleet's anonymous deposit could take the one publish path it needed, and taught the
clone tool to blind `Authors` so that deposit could pass the release's own check. Both existed
to keep a fixture in the `xx` band. The band was the mistake: `xx` publishes only through the
exemplar exception, while an anonymous deposit's defining event is an anonymous RELEASE, so
the one path the fixture needed was the one path its band refuses.

ADR 0068 records the rule that makes the placement decidable. #1433 removed the intent
parameter, the `Authors` blind and the fleet's anonymous entry, and the fleet loader now
REFUSES an `anonymous` key outright. The standing anonymous deposit moves to the reserved id
`nm099998` in #1434, built through the normal upload path from a tree an operator blinds by
hand, which is what a real anonymous depositor does.



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
  TTL. This is why ADR 0066's brokered files are `max-age=300` rather than `immutable`, and it
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

**The platform carries one standing anonymous deposit** (amended 2026-09-17, ADR 0068,
epic #1430; this replaces the `xx099907` text that stood here).
The reason for having one is unchanged and is the decision: the anonymous state is otherwise
only ever exercised against rows a test builds and tears down in the same process, so nothing
is ever tested against a dataset that has been pre-publication for weeks.

What changed is where it lives. It was declared at `xx099907`, inside the exemplar fleet, and
that placement was the mistake ADR 0068 was written to prevent. `xx` publishes only through
the exemplar exception (non-production, `is_exemplar = 1`, sandbox DOIs), while an anonymous
deposit's defining event is an anonymous RELEASE, so the one path the fixture needed was the
one path its band refuses. Keeping it there meant widening a publish gate, which #1428 did and
#1433 undid.

It also could not have been an EXISTING exemplar, which is worth keeping: all of them are
public with sandbox DOIs, so the 0085 backfill stamps `first_published_at` on every one and
the triggers then refuse `anonymous = 1`. That is the invariant working, and it is why the
fixture has to be declared rather than borrowed.

The deposit is now `nm099998`, a reserved id (ADR 0068), built through the normal upload path
from a tree an operator blinds by hand -- which is what the submission standard below asks a
real anonymous depositor to do, so the fixture exercises the instruction rather than bypassing
it. #1434 built it and retired `xx099907`.

**Current state, 2026-09-17, measured on the dev worker rather than asserted:** `nm099998` exists
and is the fixture. A public catalog row over a PRIVATE `nemarDatasets` repository,
`anonymous = 1`, `first_published_at` NULL, `authors` reading
`Anonymous (withheld until publication)`, and `owner_username`, `owner_github`, `github_repo`,
`concept_doi` and `latest_version_doi` all NULL on the detail response.
`v1.0.0` is released: `GET /datasets/nm099998/manifest` answers `{"versions":["v1.0.0"]}` over a
131-file manifest, and the data plane serves `dataset_description.json` out of the private
repository at 200 with 508 bytes declared and 508 delivered, which is ADR 0066's broker doing the
one thing a private-repo deposit needs from it.
Four public surfaces (the detail response, `metadata.json`, the page bundle and the enrichment
file) carry none of the depositor's identity tokens.
`xx099907` no longer exists in either place: no dev D1 row and no GitHub repository, both 404.

**One gap is left open on purpose, and it is a gap in the FIXTURE, not in the blind.** The
fixture is `is_sandbox = 1, is_exemplar = 0`, and the catalog population requires
`is_sandbox = 0 OR is_exemplar = 1` (`services/dataset-filters.ts`,
`routes/datasets/catalog.ts`), so `nm099998` is absent from list and search on dev and cannot
exercise those two paths end to end.
A real anonymous deposit on production is not a sandbox row and WILL be in that population, so
the blind there is load-bearing: list rows go through `toListRow`, hence
`withheldWhileAnonymous`, and owner identity is withheld in the projection itself by
`OWNER_USERNAME_SQL` and `OWNER_GITHUB_SQL`, because a join cannot be blinded by a writer.
`backend/test/anonymity-projection.test.ts` fails if a call site spells the raw join out instead.
So the rule is covered and only the live exercise of it is missing.
Closing that means changing either the fixture's flags or the population filter, and neither is
free: `is_exemplar = 1` would hand an `nm` id to exemplar tooling that declares an `xx`-only band,
and widening the filter changes what every anonymous reader sees.

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

**Amended by #1447: the VERSION DOI is reserved the same way, and the release stopped skipping
the step that mints it.**
An anonymous release originally skipped `version_doi` outright, which reads as correct from the
step's name and was not.
That one step also dispatches the central manifest job, whose callback inserts the
`dataset_versions` row, so skipping it left every anonymous release with no manifest and no
version: the data plane answered 404 "Version not published" for a dataset the release had just
made public, and the catalog listing omitted it.
Measured on the dev worker while building `nm099998`, against a normally published control on
the same worker.
The step now runs and mints the version identifier `reserved`, exactly as `doi_create` already
leaves the concept identifier, so the data is reachable and no identifier resolves.
Four surfaces had to follow, and the first count of them was two, which is the reason this
paragraph now names them.
THREE public readers each held their own copy of
`SELECT version, doi, created_at FROM dataset_versions` and none of them withheld it:
`extensions.nemar.versions[].doi` on `metadata.json`, which sat three lines below the
`dataset_doi` that WAS withheld and had no rule of its own because the array was necessarily
empty for a concealed deposit until now;
the landing page, which renders each row's DOI as a live `https://doi.org/...` anchor and so
handed a reviewer a one-click dead identifier;
and the page bundle, which carries the rows twice in one response.
The rule and the statement are now each declared once, as `VERSION_DOI_SQL` and
`PUBLIC_DATASET_VERSIONS_SQL`, with a source scanner refusing a fourth hand-spelled copy.
The fourth surface is `latest_version_doi`, which `SELECT d.*` carries into the detail response.
That column is left NULL rather than filled: it means the version DOI that is PUBLISHED, and a
concealed deposit has none.
Leaving it NULL has a cost, and the cost is paid rather than avoided.
Two daily sweeps used the column as a stand-in for "this dataset has a version at all" and so
could not see a released concealed deposit: `archive-retry.ts` would never re-dispatch its
failed archive, and `import-integrity.ts` could not resolve a version to read a manifest for,
so no caller of `verifyDatasetVersionS3` could reach a `data_complete` verdict for one.
Both now resolve the version through `resolveCurrentVersion`, which falls back to
`dataset_versions`.
`doi-reconcile.ts` deliberately does NOT follow: for that sweep, not seeing these rows is the
protection, and its refusal is `isAnonymous(row)` in the loop precisely so a later widening of
its candidate query cannot route around it.
The reasoning that makes this safe is the one already stated above: reserving is not
publishing.
What changed is the discovery that the platform was ALSO not publishing the data, which the
release is supposed to do.

**A reservation made during the blind is a debt, and real publication settles ALL of them, not
just the version it is publishing now.**
This is the other half of #1447, and the half that only shows up on the second publication.
`version_doi` mints and publishes the version it was handed; nothing in the run ever revisits an
older `dataset_versions` row.
Peer review is the process that produces a revision, so the ordinary shape at acceptance is
`1.0.1` public beside a `1.0.0` that is still `reserved` -- and the moment `anonymous` clears,
that older row stops being withheld by `VERSION_DOI_SQL` and the landing page renders it as a
live `https://doi.org/...` anchor to an identifier that does not resolve.
The withholding rule above was doing its job; what it was hiding did not stop being dead when
it stopped being hidden.
So publication now runs `completeConcealedEraVersionDois` as a tail job, once per
`dataset_versions` row, through `createEzidVersionDoi` rather than a bespoke status flip:
the reserved-to-public transition, the rebuilt DataCite document, the tombstone refusal and the
concept record's `HasVersion` refresh are all paths that already exist and are already tested,
and an identifier that is already public costs one call and changes nothing, which is what makes
the whole thing safe to run twice.
Every pre-existing row qualifies without a per-row marker, because `first_published_at` was NULL
for the dataset's entire life until this run: the durable "was concealed" signal is
`publication_requests.anonymous = 1`, since `anonymous` and `first_published_at` are rewritten in
the same statement and neither can be read afterwards.

**Which rows, and which requests, are two separate questions, and only one of them has a clean
answer.**
The rows are bounded by `created_at <= first_published_at`, and that bound is load-bearing rather
than tidy: anonymity is impossible after that stamp, which the triggers below enforce, so a version
recorded later cannot have been minted under a blind.
Taking every row instead looks identical on the first real publication, when the stamp is minutes
old and there is nothing else, and is wrong on every publication after it, where an ordinary
revision would be re-attempted forever and, past the cap, reported as an identifier that "may still
be reserved" when the only rows skipped were ordinary public ones.
The requests have no such bound.
`PRIOR_ANONYMOUS_REQUEST_SQL` asks whether this dataset was EVER under the blind, and it is
deliberately unfiltered by `status`, because no status in this state machine separates a run that
happened from one that did not: the deny route accepts a request that is already `approving`, so a
release that reserved an identifier and then failed can be denied afterwards,
and `blocked` is written both before a run and by the orchestrator mid-run,
with `publication-sweep` moving a blocked row back to `requested`.
Both callers of that statement fail in one direction only.
A false positive costs an idempotent pass, an attribution restore that rewrites what is already
there or an EZID call that answers `return_public`; a false negative publishes a permanent record
citing the blinded label, or leaves a version DOI reserved behind a link the page renders as live.
So the statement over-answers on purpose, and the `created_at` bound does the narrowing.

**The window between clearing the flag and settling the debt is real, and accepted.**
`repo_public` clears `anonymous` and the tail job runs at the end of the same invocation, so
between the two a public reader can see a live-looking anchor to a still-reserved identifier, and
can keep seeing it if a later step fails.
Both alternative orderings are worse, for reasons already recorded here: settling before the
restoring commit would make a blinded record permanent, and settling before `version_doi` would
rebuild the concept record's `HasVersion` list without the version being published now.
What makes the window survivable is that it is reported rather than silent, and that approving
again closes it.

Four properties of that tail job are decisions rather than implementation.
It **refuses rather than publishes** when the repository cannot be read: `readRepoMetadata` does
not throw, it degrades to `{ Name }`, and DataCite then renders a `(:unav)` creator -- acceptable
for a mint whose alternative is no DOI, and the exact inversion of ADR 0041 on a dataset that was
anonymous by choice, where it would read as deliberate.
Reserved is recoverable by approving again; a public version DOI attributed to nobody is not.
"Declares no authors" and "could not be read" are told apart by
`BIDS_METADATA_UNAVAILABLE`, exported for this caller, and the second is the only one that stops
the run.
It reads the **rebuilt repository record, not the step order**, for whether attribution has
actually been restored, and leaves every reservation alone while the blinded label is still there.
That is the interlock `doi_create` and `publish_doi` carry at `refuseWhileBlinded`, which cannot
serve here: it reads `datasets.authors`, and `repo_public` has already rewritten that column by the
time the tail job runs.
The repository can answer, because the restoring commit is what puts the real names on `main`.
It is **bounded** at `MAX_CONCEALED_ERA_VERSION_DOIS` (10) registrar round trips, and it says so
in the warning rather than silently doing part of the work.
And it is **non-fatal**, following `stampZarrRequeue`: it returns a warning, writes an
`audit_log` row, and is called from both the finalize block and the all-steps-complete early
return, so "approve again to retry" is true rather than advice.
Publication must not fail because a registrar was down, but an identifier the dataset page now
links has to be reported when it is still dead.

**"No surface" is literal, and it took a review to make it true.** The reserved identifier and
the private repository were each withheld by one surface and served raw by three others, twice
in the SAME HTTP response: the page bundle carried `external_links.github_url: null` beside
`catalog_row.github_repo`, and the catalog's list and detail projections served both columns
out of `SELECT d.*`. The rule now holds wherever a reader who is neither the owner nor an
admin can see the row. It is conditional on the VIEWER, unlike every other rule here, and that
is deliberate: anonymity is toward the public, never toward the depositor (R5), and
`nemar dataset clone`, `commit` and `push` read `github_repo` from these routes to perform the
very commit that ends the anonymity. Two publication steps are deferred for the same reason --
`update_metadata` writes `DatasetDOI` into `dataset_description.json` and `update_readme` adds
a DOI badge to the README, both git-tracked and served publicly by the data plane, so an
anonymous release runs neither and the publication that ends anonymity runs both. Deferred, not
dropped: `doi_create` still reserves the identifier, so the one activated at publication is the
same one. The version-DOI webhook is gated on the same state, because a pushed `v*` tag mints
AND publishes in one pass, and nothing stopped a depositor from pushing one after their
release.

**And the ordering is an invariant, not a step order.** A DataCite record whose creator is the
blinded label is harvested within hours and inverts ADR 0041 on the one identifier nothing can
retract, so `doi_create` and `publish_doi` both read `datasets.authors` and refuse to run while
it still carries `ANONYMOUS_AUTHORS_LABEL`. Relying on where the restoring enrichment sits in
the step list was not enough: the condition that ran it read a row value that its own preceding
`UPDATE` had already cleared, so a RETRY of a failed run skipped the restoration silently and
minted the permanent identifier with no authors.

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

- Epic #1406, issue #1407; ADR 0066 (the data-plane half this depends on, #1403)
- ADR 0034 (the column budget this spends from), ADR 0035 (why not `sweep_stamps`),
  ADR 0017 (row-level visibility, and why it cannot express this),
  ADR 0026 (the placeholder-author gate that orders de-anonymization),
  ADR 0041 (real name or not at all), ADR 0001 (`main` is pull-request-only once public)
- Rules: `backend/src/services/anonymity.ts`, migration `0085_anonymous_deposit.sql`
- Guards: `backend/test/anonymity.test.ts` (the invariant, and the FTS assertion with its
  control), `backend/test/anonymity-projection.test.ts` (one owner rule),
  `backend/test/anonymity-writers.test.ts` (the blinding, driven through `enrichDataset`
  itself rather than through a hand-written fixture),
  `backend/test/anonymity-publication-paths.test.ts` (every path to public carries the stamp,
  and the step set, the mint interlock and the repo-spec visibility),
  `backend/test/anonymous-release.test.ts` (the request route and the catalog, driven through
  the real app on a real database, each with a control),
  `backend/test/concealed-era-version-dois.test.ts` (settling the reservations the blind left
  behind, against local EZID and GitHub stand-ins that record what went on the wire, with the
  reads-nothing refusal and its declares-no-authors control, the still-blinded refusal, and the
  concealed-era boundary in both directions)
