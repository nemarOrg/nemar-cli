# ADR 0139: A confirmed review fail denies a publication request automatically, and says so

**Status:** accepted
**Date:** 2026-11-25
**Owner:** maintainer (decisions of 2026-11-25), drafted by the epic #2182 lead

## Context

The queue held 363 publication requests on 2026-11-25.
351 of them came from one depositor, and no publication review had run on any of them in production.
ADR 0102 forbids any automatic denial ("A model can be wrong, and a hard fact already refuses approval").
It also keeps the model to the root documents.
On 2026-11-25 the owner decided four things:
- a real review `fail` denies the request automatically, as nemarAdmin;
- a pass mails the administrators a "ready to approve" summary;
- the review sees metadata but never data;
- every decision is documented and can be reproduced by the depositor.

This ADR partially supersedes ADR 0102 (decisions 2 and 9, and the alternative "deny automatically").
ADR 0102 §2's ban on data content, header values, `.tsv` files, identifier findings and screen findings stays in force.

## Decision

1. **What denies automatically.**
   A request is denied automatically only when all of these hold:
   - the request is `requested`, and its current review is bound to the request's current head and anonymous flag (ADR 0102);
   - that review reported a derived verdict of `fail`, with at least one reason that the reason table marks `auto_deny_eligible`;
     eligible reasons are about metadata only, and none is derived from screen coverage, an `acknowledge` gate, license lineage, or infrastructure;
   - the run completed: the model output parsed against its schema, and it was not refused, truncated or timed out;
   - a second, confirming run on `claude-sonnet-5-5` at effort max, over the same inputs, also derived `fail` with at least one eligible reason in common;
   - the request is not anonymous (ADR 0065), and the dataset has fewer than two earlier automatic denials.
     A third failing request goes to an administrator.

   `action_required` never denies.
   Neither does a run that did not start, errored, timed out or returned unknown, nor a confirming run that disagrees; each of these goes to an administrator as today.
   Infrastructure never decides.
2. **Who denies.**
   The Worker calls the same deny function the admin route uses, so there is one code path.
   - `denied_by` is the nemarAdmin service account.
   - `denied_reason` holds the closed reason codes.
   - An audit row records `auto_deny`, together with the review ids, the head, the models, the prompt version and the input digest.
   - The UPDATE is guarded on `status = 'requested'` and on the review still being current, so a race with an administrator, a withdrawal or a new push ends in no change.
3. **Switch, shadow and cap.**
   `PUBLICATION_AUTO_DENY_MODE` is an owner switch with three values: `off`, `shadow` or `on`; when it is absent, the mode is `off`.
   In `shadow`, everything runs except the deny itself.
   The record and the administrators' digest say "would deny", with the reasons, so calibration happens on real requests in production.
   It stays out of `backend/wrangler-sccn.toml`, and a test fails any change that adds it, as for the other owner switches.
   `PUBLICATION_AUTO_DENY_DAILY_CAP` (default 25) is claimed before each denial.
   Past the cap, the request stays `requested` and the administrators' mail says "recommended: deny".
4. **What the depositor is told.**
   The denial mail, and `nemar dataset publish status`, say the following:
   - that an automated agent made this decision;
   - each reason, with its statement, remedy and docs link from one copy table;
   - the commands that reproduce the evidence: `nemar dataset screen --committed` and `nemar dataset license-check`;
   - the review record: head commit, scanner id, resolver version, models, prompt version and input digest;
   - how to resubmit with a note if they believe the agent was wrong;
   - that a person can be asked by replying to the mail, which opens a support ticket (ADR 0112).

   Every sentence comes from the copy table.
   No model-written text, no README text and no finding value appear in the mail.
   The mail goes to the requester and to every owner of the dataset.
   Administrators get one daily digest of automatic denials, and any administrator can reverse a denial by restoring the request to `requested`, with an audit row.
5. **Resubmission note.**
   A publication request carries an optional `resubmission_note`, at most 2,000 characters.
   The CLI and the web form ask for it when the dataset's previous request was denied.
   The note is shown to administrators.
   The model receives it only after the pre-send scan, inside the untrusted fence, with a fifth question: does the note address the previous reasons?
   That answer can only lower the verdict to `action_required`; a note can never produce `pass` on its own, and it can never produce `fail`.
6. **Model inputs, widened to metadata.**
   Besides ADR 0102's root documents and structural summary, the review receives the following, all pre-send scanned:
   - the enrichment document `.nemar/metadata.json` at the head;
   - the upstream registry records found by the license-lineage resolver (title, creators, publisher, license and URL);
   - the license-lineage outcome;
   - the screen's coverage counts per format (files, read, partial, failed).

   It never receives finding kinds, finding counts or values.
7. **License lineage.**
   `needs_permission`, `share_alike_mismatch` and `unresolved` are `action_required` reasons; they never trigger an automatic denial.
   A depositor clears them with recorded permission or a corrected license.
   See the amendment of 2026-11-25 below for the outcomes this decision also covers.
8. **Ready to approve.**
   A `pass` verdict on a request whose screen gate is `clear` changes the administrators' mail headline to "Ready to approve".
   A `pass` with an `acknowledge` gate says "Review passed; the identifier screen still needs an acknowledgment", and quotes the screen's status line.
   The mail lists what was confirmed: the identifier screen gate, the minimum requirements are met, the license lineage outcome and its sources, and the model's four answers.
   It gives the exact approve command.
   Approval stays the administrator's own act (ADR 0093, ADR 0102 decision 9).
   No code path approves.
9. **Reproducibility record.**
   Every review stores and shows the head commit, the scanner id with its reader versions, the resolver version, the model ids and efforts, the prompt version, and a SHA-256 digest of the exact fenced input.
   Two reviews with the same digest and models are comparable.
   Reproducible means that the depositor can see and recompute the evidence (the screen, the license lineage) and can see the inputs, the prompt version and the model.
   It does not mean that a model call returns the same verdict twice, and the mail says so.

## Consequences

- A queue of hundreds of requests can be decided without an administrator reading each failing one.
  The depositor gets a reason, a remedy and the commands to check it, instead of silence.
- A model error can now deny a legitimate request.
  This is bounded by three things: the confirming second model, the cap, and the switch.
  The cost to the depositor is a resubmission, which carries a note.
- One more owner switch, one more column, and a second model call on fails only.
- Calibration (plan step C1) must show zero false automatic denials on a labeled sample before the owner turns the switch on in production.

## Alternatives considered

- **Deterministic facts only:** offered on 2026-11-25; the owner chose to include model fails.
- **Deny on the first model's fail alone:** rejected; a second model is cheap on the failing subset, and it halves the error class that ADR 0102 feared.
- **Let the model read sidecars and tables:** rejected by the owner on 2026-11-25; ADR 0102 §2 stays.

## Receipts

- Epic nemarOrg/nemar-cli#2182.
- Plan `.context/plans/publication-queue/plan.md`.
- ADR 0102, ADR 0093, ADR 0086.
- Queue measurement of 2026-11-25, in the plan.

## Amendment 2026-11-25 (lead, epic #2182)

Decision 7 also covers the lineage outcomes `redistribution_prohibited` and `source_is_publication`, which the license-lineage resolver added after this ADR was written; each needs action and never denies automatically.
The previous-denial input of decision 5 carries closed reason codes only, never a screen code (ADR 0102 §2 stays): the codes the model may see are the allowlist `PREVIOUS_DENIAL_SENDABLE`.
A review that was served its inputs and then fails before or without a model call is counted against the daily cap; this is deliberate, so that a job cannot evade the cap.

## Amendment 2026-11-25: license permission evidence (owner decision, epic #2182 card B6)

A license lineage that needs permission is cleared only by an administrator recording the evidence received, linked to a support ticket.
The depositor is told what to send and where.
The permission covers the named sources, and later requests with the same sources.
It clears that reason alone.

- **What the depositor is told.**
  One sentence per outcome that needs action (`LINEAGE_PERMISSION_REQUEST`, `shared/license-lineage.ts`), worded from the owner's: the upstream license does not permit this copy under the dataset's license, so send evidence from the original authors that they accept this copy under that license, for example an email from them, to support@nemar.org, quoting the dataset id.
  For `redistribution_prohibited` the evidence comes from the repository that holds the data (for example PhysioNet), because its data use agreement may bind the authors too.
  For `unresolved` the depositor replies with a link to the license, or waits for the next check.
  The placeholders are filled from the lineage's closed words and checked identifiers, never from free text.
  The sentence is mailed once per request and outcome when a review stores `license_lineage_unconfirmed` (through the dev mail fence), and `nemar dataset publish status` prints it.
- **What is recorded.**
  `nemar admin dataset publish license-permission <dataset> --ticket <id> --evidence <text> [--apply]` is a dry run by default; with `--apply` it writes a `license_permissions` row and a `license_permission_recorded` audit row in one batch.
  The ticket must exist and be visible to the administrator (ADR 0112).
  The administrator confirms that the ticket holds the evidence; the tool shows the ticket's subject and sender, warns when the sender is not the depositor, and audits both.
  The evidence is the administrator's own summary, at most 1,000 characters; it is shown to administrators only and never sent to a model.
- **What it covers.**
  Each review stores the lineage it was served (its basis: the outcome, the target license and the sources behind the outcome).
  A permission covers a review when the outcome and the target license are the same and it names every source behind the outcome; the dataset's own unreadable files are never covered.
  It covers the request it was recorded against and every later request of the dataset with the same basis.
  Binding the target license as well as the sources follows the owner's wording ("this specific license on the copy that we are publishing"): a later request under another license needs new evidence.
- **What it does.**
  The derivation drops `license_lineage_unconfirmed`, and the stored verdict is derived again without it when the stored column still equals what its report derives; the verdict then follows the other reasons.
  It never clears another reason and never approves; an administrator's override still clears the reason too.
  The admin show and the administrators' mail print "License permission recorded on (date) by (administrator), ticket (ticket)".

## Amendment 2026-11-27 (owner): production runs in shadow mode

`PUBLICATION_AUTO_DENY_MODE = "shadow"` joins production `[vars]`: an eligible fail gets its confirming run and an agreement is recorded as `would_deny`, and nothing is denied.
The owner reads the shadow results on the queue before switching to `on`, which is a separate reviewed change to the same line and its guard test.
The daily cap stays unset (25); past 25 agreements in a day, an agreement is recorded as `capped`, not `would_deny`, and the confirming run has been spent either way.
The daily digest lists the `would_deny` rows to the administrators.
A `would_deny` first run may be reviewed again by an administrator (`start --again`), because nothing was denied.

## Amendment 2026-11-27 (owner, epic #2449): the record names the license matcher

Decision 9's record gains the license matcher version (`scancode-32.5.0+spdx-3.27`), and decision 7's lineage records when it was resolved (ADR 0142).
A LICENSE file that names a different license from the `License` field (`license_file.state` `matches_other`) lowers `authors_and_license` to `unknown`,
and decision 1 gains a condition: while the state is `matches_other`, a `fail` of `authors_and_license` is not eligible for an automatic denial, whatever finding it carries (`license_inconsistent` included),
because both runs would see the same platform fact and their agreement would check nothing.

## Amendment 2026-11-27 (owner hotfix): no mail on `unresolved`, and a publication's own request

Decision 7 and the license permission amendment change in two places, after a depositor received license notices that were wrong.

- **`unresolved` mails nobody.**
  It means NEMAR could not read an upstream record, which is NEMAR's failure, not the depositor's.
  The notice mail goes out only for `needs_permission`, `share_alike_mismatch`, `redistribution_prohibited` and `source_is_publication` (`DEPOSITOR_NOTICE_OUTCOMES`, `shared/license-permission.ts`).
  `unresolved` stays a `license_lineage_unconfirmed` reason: the administrators see it on the decision card and in `nemar admin dataset publish show`, and the after-store step logs why it sent nothing.
- **`source_is_publication` has its own sentence.**
  A paper named as the upstream source is not a license conflict, so the sentence no longer says that the upstream license "does not permit this copy".
  It says that the source named is a publication, not a dataset, so its license is not the data's license,
  and asks the depositor to name the dataset the data came from in `SourceDatasets` (its DOI or repository URL), or to send evidence that the original authors accept this copy under the dataset's license.
- **The target license is named as the dataset declares it.**
  Every sentence names the dataset's `License` as written (`CC-BY-4.0`), not the normalized family (`cc-by`), when that value is a license identifier that normalizes to the license the outcome was judged against;
  otherwise the normalized word stays.
  The review's basis keeps it as `target_license_declared`; what a permission covers does not read it.

## Amendment 2026-11-27 (owner, follow-up): data containers are not publications

Decision 7's `source_is_publication` is for publications only; a record that holds data is read for its license (resolver `license-lineage/5`).
A container's license is read from what it contains, never from a summary that can be more permissive than its parts.
Measured on the depositor's sources after the first hotfix:

- **A DataCite `Collection`'s own rights are never used.**
  A figshare collection (`10.6084/m9.figshare.c.<id>`) is judged by its members: the resolver lists them through figshare's API and reads each member's license.
  `10.6084/m9.figshare.c.6979581.v1` declares CC BY 4.0 on DataCite, while figshare gives the collection no license and its one member is CC0.
  A collection with no member, more than ten, or a member whose license cannot be read is `unresolved`.
  Any other repository's collection is `unresolved`: an administrator decides.
- **An OSF project**, an OSF DOI whose DataCite resourceType is `Project` (OSF registers projects as `Text`, as `10.17605/osf.io/f8sq3`, or as `Dataset`), holds data.
  It is read from OSF's API whatever DataCite's rights say: the node's license and each direct child component's, and a child that declares none counts as none.
  A children list that cannot be read, or that has more than one page, leaves no verdict, and so does a child with children of its own: the tree is not walked, and an administrator decides.
  Every other `Text` record stays a publication.
- **A Crossref `component`** (supplementary material) is judged only for PLOS (`10.1371/`), whose policy puts supplementary files under the article's CC BY.
  A PLOS component takes the license Crossref gives it, else its article's version-of-record license (the article from `relation.is-component-of`, else the DOI without its `.sNNN` suffix; the PLOS file `10.1371/journal.pone.0303144.s001` is not in DataCite).
  Every other publisher's component, and a PLOS component with no license from either, is `unresolved`, never compatible by default; such a record is never cached.
- **Each part is judged on its own.**
  A container's members or children are never merged into one license: each is judged against the dataset's license, and they combine as separate sources do (the most restrictive outcome, and a conflict such as share-alike beside NonCommercial needs permission).
  One merged rank would read CC BY-SA beside CC BY-NC as NonCommercial alone, and a CC BY-SA 4.0 part beside a 3.0 one as compatible with a 3.0 target.
- Genuine publications stay publications: `10.5281/zenodo.6529724` and `10.6084/m9.figshare.28309157` are `JournalArticle` records.

## Amendment 2026-11-27 (owner, third lineage fix): figshare article URLs and stale relations

The owner's ruling for the lineage: anything the resolver cannot determine is an administrator's decision (`unresolved`: amber on the card, no depositor mail), never a guess in either direction.
Resolver `license-lineage/6`.

- **A figshare article URL** (`https://<host>.figshare.com/articles/<...>/<id>[/<version>]`) is read from figshare's API, and the figshare record decides.
  A `dataset` with a license is a dataset under that license.
  A paper-like type (journal contribution, preprint, thesis, book, chapter, conference contribution, poster, presentation, report, monograph, peer review, educational resource) is a publication.
  Any other type (a figure or media item can be a recording or an illustration; software, models and workflows are code), a dataset with no license, a metadata-only record (`is_metadata_record`: the data is held elsewhere or on request), and a record that cannot be read are `unresolved`.
  A version in the URL is read; else the SourceDatasets entry's `Version` when it is a figshare version number; else the latest.
  The record's DOI names the source; a PLOS figshare dataset shares its article's DOI (`10.1371/journal.pone.0211710`, nm000830), so that DOI is never then read from Crossref, which calls it the journal article.
- **An IsDerivedFrom in NEMAR's own metadata is never carried forward on its own.**
  Enrichment's seed stage dropped no earlier IsDerivedFrom, so a paper a depositor moved from SourceDatasets to ReferencesAndLinks stayed IsDerivedFrom through every re-enrichment.
  Once this run has resolved the DOIs (stage 1d), an earlier IsDerivedFrom that SourceDatasets does not name and that resolved to something other than a DataCite `Dataset` is not carried forward: it becomes `References` when ReferencesAndLinks names it, else it is dropped.
  One that resolved to a Dataset (an earlier rule-checked promotion) or whose lookup failed, was skipped or found nothing is kept, so a failed lookup never turns a real dataset relation into a reference.
- **In the resolver, a stale enrichment relation is not a source.**
  An IsDerivedFrom or IsIdenticalTo in `.nemar/metadata.json` that resolves to a publication and that SourceDatasets does not name is skipped and counted (`skipped_stale_relations`), so stale metadata cannot hold a request before its next re-enrichment.
  A relation that resolves to the same record as a SourceDatasets entry is that entry.
  A relation that cannot be read is not skipped: it stays `unresolved`.
  When skipped relations were all a dataset named, the outcome is `unresolved` (an administrator decides), never `no_upstream_declared`; the decision card and `show` print how many were skipped.


## Amendment 2026-11-27 (owner): the name rule and the automatic denial

ADR 0102's amendment of this date adds the platform reason `name_differs_from_upstream`.
Decision 1 requires a confirming run that agrees on an eligible reason, and both runs read the same platform fact, so on its own their agreement would check nothing (the same argument as the license file's amendment above).
So decision 1 gains two conditions:

- **`name_differs_from_upstream` is eligible only in a run whose model itself failed `name_adequate`** (its own answer, which the fact does not lower).
  A denial on it is therefore confirmed by a second model that also failed the name, and `denied_reason` names it as its own code; it may be shown to the next review as a previous denial's reason (`PREVIOUS_DENIAL_SENDABLE`).
  A fail on the fact alone goes to an administrator, whose card asks the depositor to change the Name (ADR 0142's amendment of this date).
- **`name_not_descriptive` stays eligible, unless the Name follows a declared upstream's title** (`name_upstream` is `matches`, which only a declared source can give, never a README candidate): the name then came from the upstream, not from the depositor, and an administrator decides.
  Any other eligible finding beside it still counts.

`name_upstream_unconfirmed` never denies and mails nobody: it is NEMAR's failure to read a record, or an upstream renamed since the copy, which only a person can judge, as `unresolved` is in decision 7.
The depositor's copy (`AUTO_DENY_CODE_COPY.name_differs_from_upstream`) names the rule and the suffix shapes; its docs anchor, `#automatic-denial-name-differs-from-upstream`, is added to the submission standards page with the website's next release.

## Amendment 2026-11-27 (lead, shadow run on 0.10.58): the mail names what is true of the dataset

The shadow run of 40 requests on production 0.10.58 recorded agreements whose denial mail would have stated a reason that was false or about the wrong document.
Before the owner switches `PUBLICATION_AUTO_DENY_MODE` from `shadow` to `on`, decision 1's eligibility and decision 4's mail gain these rules (`shared/publication-auto-deny.ts`; fixtures from the run's first-run reports in `test/fixtures/auto-deny-shadow/`):

- **`license_missing` is eligible only when the platform found no `License` field** (`license_field` false, the fact `license_field_missing`) **and the model's own answer to the finding's question is `fail`.**
  A model's word alone never denies on it, and neither does a question the model answered `unknown` that the fact lowered.
  nm001019 declares `License: CC-BY-4.0` and has no LICENSE file; its `license_missing` blocker would have mailed "The dataset has no license".
  nm001014's sits on a question the model answered `unknown`.
- **A `description_incomplete` finding is named by the document it is about.**
  About the README it is eligible under the README's code and sentence (`readme_missing_or_stub`: "The README is missing, or is a stub that does not describe the dataset", with the remedy to write a README that says what was recorded, from whom, how, and how the files are organized), because that is what the finding says of a template README (nm001032, nm001039, nm001041).
  About `dataset_description.json` it keeps its own sentence.
  About any other document, or none, it is not eligible: the copy names `dataset_description.json` and would misdirect the depositor.
  Mapping, not dropping, was chosen because the README sentence and remedy are accurate for a template README, and dropping would leave those requests to an administrator for no gain in accuracy; a confirming run's README finding under either code agrees with the first run's.
- **`steering_attempt` is eligible only from a blocker finding of that code.**
  The report's `steering` flag is also set by a finding at `note` or `concern` (nm000622: the README tells readers how to count participants), and that still fails the review, but a person decides.
- **`name_not_descriptive` is protected whenever the Name follows the title of any declared source, a publication included**, by the name rule's folding and suffix grammar (`nameFollowsAnySourceTitle`, `shared/name-follows-upstream.ts`).
  nm001028's Name is the exact title of `10.5281/zenodo.3648065`, which its registry types as a journal article, so the name rule's `name_upstream` is `not_applicable` and did not protect it.
  The served snapshot (migration 0163) keeps every declared source's title as `source_titles`; the Worker reads the first run's snapshot, and a snapshot without them (one written before this rule, or one too long for its column) protects the Name.
- **Placeholder authors**: "Original Dataset Authors (see SourceDatasets)", the only author of nine datasets in the run, and entries that open with "Original (dataset or data) authors" or "creators" or that say "see SourceDatasets", are placeholders in `isPlaceholderAuthor` (ADR 0026's rule), so the evidence's `placeholder_authors`, the decision card and the model agree.
  As for every placeholder, a named request whose only author is one fails the Authors minimum.
- **The agreed codes are stored** (migration 0164, `publication_reviews.auto_deny_codes`): written on the first run in the statement that records `would_deny`, `capped`, `denied` or `no_service_account`, so an administrator reads in shadow mode exactly the reasons the mail would name, even after the rule changes.
  `nemar admin dataset publish show` and the decision card's automatic-denial line print each code with its mail sentence; the digest and the mail's retry read them, and recompute from the reports only for a row recorded before the column.
- **An OSF source DataCite does not hold is named by its URL** (ADR 0142's amendment of this date): decision 7's lineage never presents `10.17605/osf.io/<guid>` as a registered DOI when it is NEMAR's construction from `https://osf.io/<guid>` (nm001019's `10.17605/osf.io/fx4ud` does not exist), and the review's registry records name the URL too.
- **A Zenodo record typed as a paper that holds data files** keeps decision 7's classification: it is a publication for the lineage, its outcome is unchanged and nothing automatic widens; the resolver records Zenodo's type and files on the source, and the decision card says so (ADR 0142's amendment of this date).
