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
The daily cap stays unset (25).
