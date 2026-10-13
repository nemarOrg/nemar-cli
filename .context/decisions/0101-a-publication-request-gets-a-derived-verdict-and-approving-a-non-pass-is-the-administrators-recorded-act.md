# ADR 0101: A publication request gets a derived verdict, and approving over a non-pass is the administrator's recorded act

**Status:** proposed
**Date:** 2026-10-12
**Owner:** Seyed Yahya Shirazi

Epic #1726, Phase 0 (#1727).
Takes the shape of ADR 0092 (a derived verdict from a Worker-gated model review) and ADR 0093 (an administrator queue, and an approval that is the administrator's own).
Builds on ADR 0086 (the identifier screen, its gate, its mail and its binding to a commit), ADR 0026 (mechanical submission minimums), ADR 0080 (the web approval executor), ADR 0065 (anonymous releases), ADR 0053 and ADR 0054 (unknown is never green).
Retires the advisory pre-screen of ADR 0014, and narrows the "adequacy stays advisory" half of ADR 0026 (see Relations below).
The analysis behind this decision, the comparison with the pull-request review, the cost arithmetic and the refined phase plan are in [`.context/publication-review-design.md`](../publication-review-design.md); this ADR is the verdict.

## Context

A publication request is checked today by parts that do not meet.
The submission minimums hard-block at request time (ADR 0026).
A request waits for its Brain Imaging Data Structure (BIDS) validation run before it is recorded as `requested` (ADR 0086, amendment of 2026-10-07).
The identifier screen reads bytes in CI and reports kinds and counts in a closed vocabulary (ADR 0086).
On the dev Worker only, an advisory pre-screen asks a model about the README and the name (ADR 0014).
The administrator then gets one email and approves or denies, from a terminal or from a web button that dispatches an executor (ADR 0080).
Nothing combines those results into one answer, and nothing stops an approval that one of them would have questioned.

Five facts, each checked against the code on 2026-10-12, shape the answer.

- **The identifier screen does not read the files a reviewer reads.**
  Its text rule runs only on text files under `sourcedata/` and `code/`, and its JSON key rule skips `dataset_description.json`, `participants.json` and BIDS sidecars outside `sourcedata/` (`readCandidates` and `JSON_EXCLUDED` in `scripts/identifier-fleet-lib.ts`).
  The root README, CHANGES and LICENSE are matched by path rules only.
  So "text the screen has cleared" does not, today, include a single byte of the text a model would be asked to judge.
- **The pre-screen never ran in production.**
  `PRESCREEN_ENABLED` is set only in `[env.dev.vars]` of `backend/wrangler-sccn.toml`.
  Its deployed workflow (`run-prescreen.yml` in `nemarDatasets/.github`) sends the README and `dataset_description.json` to a model in parallel with the screen, takes its callback URL from the dispatch payload, authenticates with a stored token rather than workload identity federation, accepts free-text reasons, and prints the model's reasons in its public log.
- **Approving a publication is not a GitHub act.**
  A pull request is approved on GitHub with the administrator's own token (ADR 0093).
  A publication is approved by calling `POST /admin/publish/:id/approve`, which runs the sixteen-step orchestrator, and its `publish_doi` step cannot be undone.
  Any gate therefore has to live where that call is answered, not only in a client.
- **The content is unpublished, and its owner asked for it to be published.**
  ADR 0092 refuses to send a pull request on an unpublished or anonymous dataset to a model, because nothing of that dataset is public yet.
  A publication request is the depositor asking that this exact content become public; that request is what licenses a model to read it, and nothing else does.
- **The surfaces disagree already.**
  `nemar admin publish approve` lists the steps it will run but not the screen before its prompt, so a screen refusal arrives after the administrator confirmed, and it exits 0 when an approval fails (#1581).
  The website's approval page sends a fixed empty body and shows no screen, so it can approve a request whose screen needs an acknowledgment only if the same administrator recorded that reason from a terminal first.

## Decision

**Each publication request gets one verdict, derived by the Worker from the mechanical gates and from a no-tools model review that runs only after the identifier screen has reported for the same commit and only on bytes the shared mechanical rules have just passed; a non-pass needs the administrator's recorded override, a hard fact cannot be overridden, nothing is ever denied automatically, and unknown is never green.**

### 1. What a review belongs to

- **A review is bound to the request, the commit and the kind of release.**
  `publication_reviews` holds one row per (`request_id`, `head_sha`, `anonymous`).
  `head_sha` is the commit of `main` the identifier screen reported (`ScreenReport.head`), so the review and the screen always read the same commit.
  `anonymous` is the request's flag at that time, because an anonymous release asks different questions.
  The version being published is a function of the commit: it is the `Version` the review job reads from `dataset_description.json` at `head_sha`, recorded in the report's evidence.
- **A verdict belongs to what it read, and is never carried over.**
  A push to `main` makes the screen stale, and ADR 0086's head check already refuses approval then; re-running the screen reports a new head, which starts a new review row.
  A re-request resets the screen (`RESET_SCREEN_COLUMNS_SQL`), and its new screen result starts the review for that commit and flag, which finds the existing row only when both are unchanged.
  A denied request that is requested again is a new request and gets a new review.
  An override is a column of the review row it was given for, so it cannot survive into another commit's review.
- **The review in force is the newest row of the request whose `head_sha` equals the request's screened head and whose `anonymous` equals the request's flag.**
  Any other row is history, shown as such, never as the verdict.

### 2. The rule on what a model may receive

This rule is not negotiable, and nothing in this ADR or a later phase may weaken it.

- **The identifier screen stays mechanical.**
  `shared/identifier-scan.ts`, the closed vocabulary of `shared/identifier-screen-report.ts` and `describeScreen` remain the only judge of identifiers.
  Delegating any part of the identifier review to a model is out of scope.
- **A model never receives a header value, an identifier finding, a screen report, or data content.**
  Data content means recordings, any byte of a signal header, and the rows of any table (`participants.tsv`, `_scans.tsv`, `_events.tsv`, `_channels.tsv`, and every other).
  The model is not told the screen's state, kinds or counts, and is not asked about privacy or identifiers at all: its findings vocabulary has no such code.
- **The review starts only from a screen result, for that result's commit.**
  It is never dispatched at request time, in parallel with the screen, or before the screen reports.
  It runs when the screen's gate (`screenGate`) is `clear` or `acknowledge` for the request; it does not run when the gate is `blocks` (the request is blocked), `wait`, or `rerun` (the screen did not run, did not report, or was never started).
- **Every byte sent to the model has passed the shared mechanical rules immediately before it is sent.**
  Because the screen does not read the files the model reads (Context), screen-first is the ORDERING rule, and a pre-send check is the CONTENT rule.
  The review job runs the shared rules of `shared/identifier-scan.ts` over exactly the bytes it is about to send: `scanTextForLocalPaths` on each text file, `scanJsonKeys` on each JSON document, `scanTableColumns` on the `participants.tsv` header row, and `scanPaths` on the paths any structural fact is derived from.
  A file with any finding, a file it cannot read in full, and a file that is not valid UTF-8 are withheld from the model whole; the evidence says which file classes were withheld and the counts by finding kind, in the screen's own vocabulary; and a criterion that needs a withheld file cannot be better than unknown.
- **What this guarantees, and what it does not.**
  It guarantees that no text reaches a model that a NEMAR mechanical rule would flag, and that the model's input is bounded and enumerated.
  It does not guarantee that the text names nobody: no mechanical rule recognizes a person's name in prose, in the screen or here.
  That residual is accepted because these files are exactly what the depositor asked to make public, and it is stated wherever the review is described (open judgment call 2).

### 3. What the model is shown, by file class

| File class | Shown to the model | Never shown |
|---|---|---|
| `README` (root, any of the BIDS spellings) | The text, at most 24,000 characters, fenced; a longer file is cut and the cut is a fact | Anything after the cut |
| `dataset_description.json` | The BIDS-defined top-level keys only (Name, BIDSVersion, HEDVersion, DatasetType, License, Authors, Acknowledgements, HowToAcknowledge, Funding, EthicsApprovals, ReferencesAndLinks, DatasetDOI, GeneratedBy, SourceDatasets), re-serialized, at most 16,000 characters | Any other key, which is counted only |
| `CHANGES` | The text, at most 8,000 characters | Anything after the cut |
| `LICENSE` (root) | The text, at most 4,000 characters, to compare with the `License` field | Anything after the cut |
| `participants.json` | The column descriptions, at most 8,000 characters | Nothing else exists in it |
| `participants.tsv` | The header row and the row count | Every row and every value |
| Sidecar JSON and TSV (`_eeg.json`, `_channels.tsv`, and the rest) | Counts per suffix and datatype | Every value |
| File list | A structural summary computed by the job: subject, session and recording counts, datatypes, task labels that match `^[A-Za-z0-9]{1,32}$` (at most 30), file formats folded into the preflight's closed list (`KNOWN_FORMATS`, the rest `.other`), and whether `derivatives/`, `sourcedata/` and `code/` exist | Paths, subject labels, file names |
| Ethics statement | `EthicsApprovals` and the README, as above | Any document file |
| Recordings, `sourcedata/`, `derivatives/`, `code/` contents | Nothing | Everything |
| The depositor's NEMAR account, the screen's result | Nothing | Everything |

For an anonymous release (ADR 0065) the model is told the release is anonymous and that `Authors` is blinded by design; the authors half of its question is answered by the fact that the inverted rule of ADR 0026 passed, and the model is not asked whether the text reveals the depositors.

### 4. What the model answers

- **No tools, one call, a schema-constrained answer**, exactly as in ADR 0092.
  Dataset text is untrusted: it sits in blocks fenced by a per-run random nonce, the platform's facts sit outside any fence, an instruction found in the text sets `steering`, and the model writes only a result per question, findings from a closed list, a short summary and the steering flag.
  It cannot write the evidence, the version, the model name, a reason or the verdict.
  Free text is reduced by `sanitizeNote` and only its start is kept.
- **Four questions, each answered `pass`, `fail` or `unknown`:**
  - `complete_and_honest`: the README says what the data is, how it was collected and how to use it, and what it claims agrees with the structural summary (modalities, subject count, tasks, presence of recordings);
  - `meets_standards`: the README, the description and the ethics statement meet the published submission standards beyond the mechanical floor, an ethics statement stating an approval or exemption rather than boilerplate;
  - `authors_and_license`: the authors are real people or named bodies and consistent between files, and the license is a recognized license consistent between `License` and `LICENSE`;
  - `name_adequate`: the name describes this dataset (the adequacy half of ADR 0014, above ADR 0026's 25-character floor).
- **Findings come from a closed list** (`readme_missing_or_stub`, `readme_mismatch`, `description_incomplete`, `ethics_statement_missing`, `ethics_statement_inadequate`, `authors_placeholder`, `authors_inconsistent`, `license_missing`, `license_inconsistent`, `name_not_descriptive`, `changes_inconsistent`, `evidence_incomplete`, `steering_attempt`, `other`), declared in `shared/publication-review.ts`.
- **The model is `claude-haiku-5-5` at effort `high`**, the model of ADR 0092, named in a closed list in the contract so that a change is a reviewed code change.
  A typical review costs about $0.002 and the worst case about $0.01 at the rates cached on 2026-10-06; the platform cap below bounds a day's worst case to about $0.50.
  The arithmetic, and the same figures for Sonnet 5.5 and Opus 5.5, are in the design note.

### 5. The derived verdict

- **Three outcomes:** `pass`, `fail` and `action_required`.
  `pass`: every input is clean, the model ran and passed every question, and no fact lowered an answer.
  `fail`: a hard fact failed, the model failed a question, or the text tried to steer the model.
  `action_required`: everything else, including a review that is running, did not run, did not report, could not read what it needed, or could not decide.
  There is no neutral outcome, and a review that could not run is never clean (ADR 0053, ADR 0054).
- **Every non-pass carries reasons from a closed vocabulary, and each reason says what clears it.**
  The table lives in `shared/publication-review.ts`, with the words every surface shows:

  | Clears it | Reasons |
  |---|---|
  | **Nothing: approval is refused** (the cure is named) | `request_blocked` (the request's block reason is shown; the depositor fixes and requests again), `submission_minimum_failed` (ADR 0026, evaluated at the reviewed commit), `identifier_screen_blocks` (direct identifiers), `identifier_screen_not_run` (re-run the screen), `identifier_screen_stale` (re-run the screen) |
  | **The identifier screen's acknowledgment** (ADR 0086's recorded reason, unchanged) | `identifier_screen_needs_acknowledgment` |
  | **The administrator's override** (`--force`, or the explicit confirmation in `next` and on the web page) | `review_not_started`, `review_running`, `review_did_not_report`, `review_limit_reached`, `review_could_not_run` (with the closed run-error word), `text_withheld`, `question_failed` and `question_unknown` (per question, with the findings), `steering_attempt`, `bids_not_passed_at_review`, `version_missing` (the orchestrator would publish its default `1.0.0`), `version_malformed` (not `X.Y.Z`), `version_already_released` (a tag or a `dataset_versions` row exists for the version at the commit; `createTag` treats an existing tag as success, so the new content would be published under a tag that names other content), `doi_state_unexpected` (the row already carries a concept Digital Object Identifier (DOI) that no earlier anonymous release of this dataset reserved) |

  The hard reasons are exactly the ones an earlier decision already made unconditional: a blocked request, ADR 0026's minimums, and the states in which ADR 0086's screen gate refuses.
  Everything this ADR adds is a reason an administrator can pass on the record, because each is a judgment or a sanity fact, never a policy.
- **Facts overrule the model, and can only lower it.**
  A withheld or cut file makes every question that needs it at best `unknown`.
  A missing README fails `complete_and_honest`; a missing `License` fails `authors_and_license`; a name under 25 characters fails `name_adequate` (and is a hard minimum besides); a placeholder author on a named release fails `authors_and_license`; a structural summary with no recordings makes `complete_and_honest` at best `unknown`.
  A report agrees with itself in the safe direction, as in ADR 0092: a finding that names a steering attempt sets the flag, and a question passed with a blocker filed against it becomes `unknown`.
- **The verdict is stored when decided and re-derived when used.**
  The row stores the verdict computed when the result arrived.
  The queue, the detail view and the approval gate re-derive it from the stored report and the live facts (the request's state, its screen, its acknowledgment, the `dataset_versions` rows, the concept DOI) and use the STRICTER of the two, so either can lower a verdict and neither can raise it (ADR 0093's rule).
  A stored report that no longer parses reads as `action_required` with `review_could_not_run` unless the column says `fail`.
- **Requests the submission gate exempts are not reviewed.**
  OpenNeuro mirrors and exemplars passed an upstream review (ADR 0014, ADR 0026), so for them the review is "not applicable": no row, no gate, and the importer of ADR 0089 is unchanged.
  The predicate is `requiresUploaderName` (`dataset.source !== 'openneuro' && !dataset.is_exemplar`); an anonymous release of a mirror keeps ADR 0065's blind check, which is the submission gate's job, not this review's.

### 6. Order, triggers and the mail

- **The chain is request, BIDS, screen, review, mail.**
  A request is recorded `requested` only after BIDS validation and the minimums pass (ADR 0086, amendment of 2026-10-07); the screen is dispatched then; when its result is stored (`storeScreenResult`) or an administrator's re-run reports, the Worker starts the review for that head if the rule of section 2 allows it.
- **The admin email waits for the review, as it waits for the screen, and cannot be lost.**
  The mail lease of ADR 0086 is taken only when the screen is not pending AND no review of the screened head is `dispatched` and younger than the review deadline.
  The review row is written before the screen callback tries the mail, so the two cannot race.
  Storing a review result tries the mail; a review that never reports is marked `unreported` by the watchdog, which then mails it as such.
  The email carries one more section, the review's headline and reasons in the shared words, with the next command.
  The worst case is the screen's 50 minutes plus the review's 30 and one 30-minute tick; the expected case is minutes.
- **A review is started again only by an administrator, by name, or by a new screen result.**
  `start` restarts a row that was declined, errored, never reported, or is past its deadline; it never restarts one that is running or has a result.
- **No mail goes to the depositor about the review.**
  The depositor learns a decision as today, from the denial or approval mail; a typed comment from `next` (`c`) is the one new mail, and it carries only the administrator's words.

### 7. Store, workflow and limits

- **The table.** `publication_reviews`: `id`, `request_id`, `dataset_id`, `head_sha`, `anonymous`, `requested_by` (the depositor, for the cap), `started_by` (an administrator who started it by name, or NULL), `state` (`dispatched`, `reported`, `declined`, `errored`, `unreported`), `verdict` (`pass`, `fail`, `action_required`, set exactly when decided), `detail` (the closed word for a declined or errored row), `report` (the parsed report, re-serialized, never the callback body), `nonce`, `claimed_at`, `attempts`, `override_by`, `override_at`, `created_at`, `decided_at`; `UNIQUE (request_id, head_sha, anonymous)`; CHECK constraints in the manner of migration 0092 so that no row can pair a state with the wrong kind of word.
  No foreign keys, as for `pr_reviews`.
  No column is added to `datasets` (ADR 0034).
- **The contract.** `shared/publication-review.ts` declares the report, its parser (a branded type, as in ADR 0092), the evidence block, the four questions, the findings, the reasons with what clears each, `verdictOf`, and `describePublicationReview`, which produces the words every surface shows.
  The Worker parses at the door, before a byte is stored; the job validates with the same parser before it posts.
  `shared/contract/publication-review-admin.ts` declares the admin API's shapes and error codes.
- **The reviewer.** `run-publication-review.yml` in `nemarDatasets/.github`, authored in this repository and deployed by whole-file copy, holds the only federated Anthropic identity for this review.
  It follows `run-pr-review.yml` step for step: mask the callback token first; validate every payload field; claim before anything is installed, minted or read; check out `nemarOrg/nemar-cli` at `main` for the script; mint a read-only token (contents and actions: read) for ONE dataset repository; fetch `main` as git data with `init` and `fetch`, never a checkout; refuse as `stale_head` when the fetched `main` is not the dispatched head; mint the OpenID Connect token last; give the model step the federated identity and the callback token and no GitHub credential; report a failure after the claim through a dependency-free `curl` step; one concurrency group per run; print ids and fixed words only, because the log is public.
- **What differs from the pull-request review, and why.**
  There is no GitHub event: the Worker starts the review itself, from the screen result, so the App needs no new subscription.
  There is no pull-request text, no fork and no head ref to compare: the job reads `main` at the screened commit.
  Nothing is written to GitHub, no check-run and no comment, because the repository is private and the result is for administrators; so there is no republish pass and no `published_at`.
  The claim checks that the review is the newest of its request, that the request is still `requested`, and that the request's screened head and flag are still the row's, in the same conditional update that claims it; a claim that cannot settle closes the attempt as `stale_head`, as in ADR 0092.
  The callback origin comes from the workflow's own table keyed by the environment's NAME, never from the payload (the screen workflow takes a URL from its payload; this one does not).
  The read token also reads Actions, for the BIDS run of the reviewed commit, and no pull requests.
  The token domain is `publication-review`; the routes are `/webhooks/publication-review-claim` and `/webhooks/publication-review-result`.
- **The watchdog.** `sweepPublicationReviews`, on the 30-minute tick, PRODUCTION ONLY like every other watchdog: a row `dispatched` for more than 30 minutes becomes `unreported` (its nonce kept, so a late report still lands and replaces it) and its request's mail is tried.
  It runs whatever the flag says, so turning the review off never strands a row.
  The dev Worker never ages a row, so every surface reads a row dispatched more than the deadline plus one tick ago as `review_did_not_report`, as ADR 0093 does.
- **Caps.** A depositor's requests may cost 5 model calls in any 24 hours, and the platform 50, counted from `attempts` after the insert so concurrent starts cannot all slip under (ADR 0092's ranking).
  Over a cap the row is `declined` (`review_limit_reached`), which is `action_required`.
  An administrator's `start` is not held by the depositor's allowance, only by the platform's.
  There is no contributor tally and no override table: depositors are approved accounts (ADR 0040), publication requests are rare, and the cap is enough.
- **The flag.** `PUBLICATION_REVIEW_ENABLED = "1"` in `[env.dev.vars]` and absent from `[vars]` of `backend/wrangler-sccn.toml`, so production is dark; turning it on is a reviewed change to that file.
  The flag switches both the spend and the gate: with it off no review is started and no approval is gated by one, and a stored review is shown as advice.
- **Environment fences.** The dev Worker starts reviews only for the datasets it owns (`isDevOwnedDatasetId`), and production never for those; each Worker answers only from its own D1.
  The review sends no email to anyone but administrators, under the production-only fence of `getAdminEmailsForCategory`, and makes no write to `nemarDatasets` at all.
- **Credentials.** The only credential minted is the one-shot callback token (an HMAC over the review id and a nonce, spent by the result), which grants nothing beyond posting that review's report.
  Nothing new joins the revocation cascade (AGENTS.md).

### 8. What the administrator sees and may do

`nemar admin publish` takes the shape of `nemar admin pr-reviews` (ADR 0093).

- **`list`** keeps its filters and shows the review's outcome, or its state, beside the screen's headline; `--needs-me` keeps the requests an administrator can act on.
  A request with no review of its current commit reads `not reviewed`, which is not an error, so the command works with the flag off.
- **`show <dataset>`** prints the screen through `describeScreen`, then the review: outcome, every reason with what clears it, the findings, the summary, the evidence counts, what the model was shown and what was withheld, the model name, the commit and the version, and the next command.
- **`start <dataset>`** and **`start --all`** start the review of the current screened commit, as in ADR 0092's amendment of 2026-10-10; `--all` asks before spending and stops when the platform's cap is spent.
- **`approve <dataset>`** shows the screen and the review before it asks (today it shows the steps only).
  A hard reason refuses and names its cure.
  The screen's reason needs `--acknowledge-identifier-screen "<reason>"`, as today.
  Every other non-pass needs `--force`.
  `--yes` skips the question, never the reason and never the force.
  The override is sent as the id of the review the administrator was shown, so it attaches to that review or not at all.
  Every failure exits non-zero (#1581).
- **`next`** walks the requests that need a person, oldest first, one card each: dataset, depositor, release kind, version, the screen, and a short read of the review.
  `y` approves from this terminal and runs the same loop as `approve`; `n` denies with a typed reason, which the depositor is mailed as today; `c` mails the depositor a typed message and leaves the request open; `d` shows the whole review; `s` skips; `q` stops.
  `y` is not offered for a card with a hard reason.
  For the screen's reason it asks for the acknowledgment.
  For any other non-pass `y` is refused unless the run was started with `--force`, and then it shows the reasons again and asks one more question, defaulting to no, that names them; `--yes` never answers it.
  This differs from ADR 0093 on purpose: there an uncertain or missing review only asks for confirmation; here every non-pass needs the force path, because the act that follows publishes a DOI.
  An empty comment or reason cancels; a write whose outcome is unknown stops the run; lines typed before a card was shown are discarded in a terminal, as in ADR 0093.
- **The web page shows the same words.**
  The Worker serves the review rendered by `describePublicationReview` beside `identifier_screen` in `GET /admin/publish/requests`, as it serves the screen today, so the page renders the server's sentences.
  The small fixed vocabulary the page needs to decide by itself (the outcome words, what clears a reason, the confirmation sentences) is declared once in `shared/contract/publication-review-copy.ts`, transcribed into `nemarOrg/website` and pinned by a drift test on each side, the pattern of ADR 0045.
  A non-pass needs the same explicit confirmation on the page, sent as the review id in `approve-dispatch`'s body.
- **The server enforces; the client explains.**
  `POST /admin/publish/:id/approve` and `approve-dispatch` run the review gate after ADR 0086's screen gate and before the request is marked `approving`, and refuse with 409 `publication_review_not_clear` and the shared words.
  The command-line interface (CLI) refuses earlier with the same words so that nobody confirms what will be refused, but the Worker's answer is the gate, because the web path and any other client reach `/approve` without it.

### 9. Who approves

- **The approver of record is the administrator who passed the gate**: the one whose credential called `/approve` from a terminal, or the one who claimed the web dispatch.
  An override and a screen acknowledgment are recorded with that administrator's id and the review or screen state they were shown, and satisfy a later run only when that run is attributed to the same administrator; a run attributed to anyone else passes the gate on its own or not at all.
- **No Worker code path decides an approval or a denial.**
  The review never calls `/approve` or `/deny`, a verdict never changes a request's status, and nothing is denied automatically.
  An executor never decides: it carries out a decision someone made.
- **Making "attributed to" exact is Phase 3's, and its shape is set here.**
  Until then ADR 0080's lease-based attribution stands, with the gap #1604 describes: a terminal approval inside a live web lease is recorded as the clicker's, and could ride on the clicker's recorded override.
  The proposed fix: the web claim mints a one-time dispatch token bound to the request, the clicker and the claim; the executor presents it on `/approve`; the clicker is the approver only for a run that carries it while the claim is live, and every other caller is recorded as themselves.
  The same token is the `request_id` precondition of #1579 and authenticates the release endpoint of #1582, so the three issues share one mechanism.
  Phase 3 records that change in its own ADR, because it changes ADR 0080's decision 5.

### 10. Relations to earlier decisions

- **ADR 0014's pre-screen retires.**
  Its name check becomes the `name_adequate` question, under a contract that keeps the model behind the screen, fences its input, closes its vocabulary, takes no URL from a payload and prints nothing.
  The request route stops dispatching it and `PRESCREEN_ENABLED` is removed in Phase 1; the callback route stays one release for anything in flight on dev; the `prescreen_*` columns stay for the rows that have them; `run-prescreen.yml` is deleted from `nemarDatasets/.github` when this ships.
- **ADR 0026 stands, narrowed in one clause.**
  Its mechanical minimums stay hard blocks, at the request and now also at the reviewed commit.
  "Adequacy stays LLM-advisory" becomes "adequacy is judged by the model review and a non-pass needs the administrator's override": a speed bump the administrator can pass, never a denial.
  On acceptance ADR 0026 gains a note pointing here.
- **ADR 0086 stands.**
  Its gate, acknowledgment, binding and mail lease are unchanged; the mail now also waits for the review, which ADR 0086 gains as an amendment on acceptance.
- **ADR 0080 stands until Phase 3** (section 9).
- **ADR 0092 and ADR 0093 are the template**, and section 7 lists where this departs from them.

### Failure modes, and what the administrator sees

Every one of these is `action_required` or a refusal, never a pass, and each has a closed word and a sentence in the shared module.

| Where the chain stops | Recorded as | The administrator sees |
|---|---|---|
| The flag is off | no row | "not reviewed (the automated review is off)"; no gate |
| The screen is pending, did not run, did not report, or is stale | no row | the screen's own words and its cure (ADR 0086); approval refused by the screen gate |
| The screen blocks | no row; the request is `blocked` | `request_blocked` and `identifier_screen_blocks`; approval refused |
| The secret or a credential is missing | `errored` / `dispatch_unconfigured` | `review_could_not_run`, with `start` once it is fixed |
| GitHub refuses or drops the dispatch | `errored` / `dispatch_failed` (fenced by nonce and `claimed_at IS NULL`, as in ADR 0092) | `review_could_not_run`; `start` |
| GitHub accepts the dispatch and nothing runs | `unreported` after 30 minutes (production), or by time (dev) | `review_did_not_report`; the mail goes saying so |
| A newer review, a changed request or a moved head at the claim | `errored` / `stale_head`, not counted against the caps | the current row's state, or the screen's staleness |
| The claim answer is lost or the Worker answers 5xx | the job fails loudly after three tries; the row ages to `unreported` | `review_did_not_report` |
| Federation is refused or misconfigured | `errored` / `auth_failed` | `review_could_not_run` |
| `main` cannot be fetched or a file cannot be read | `errored` / `evidence_unavailable`, or the file is withheld | `review_could_not_run`, or `text_withheld` with the questions it lowered |
| The model is unavailable, refuses, runs out of room or returns nothing usable | `errored` / `model_unavailable`, `model_refused`, `model_truncated`, `model_invalid` | `review_could_not_run` |
| The report fails the parser | `errored` / `report_invalid`, the parser's fixed word logged | `review_could_not_run` |
| The job fails after the claim | `errored` / `workflow_failed` via the `curl` step | `review_could_not_run` |
| A cap is reached | `declined` / `review_limit_reached` | `review_limit_reached`; `start` (the platform cap still applies) |

## Consequences

- An administrator sees, for every request, one outcome and the reasons for it, in the same words in the email, the terminal and the web page, and cannot approve over a non-pass without saying so on the record.
- A model is now in the approval path of every native publication, as a gate the administrator can pass, never as a judge of identifiers and never as the last word.
- The text of the README, the description, CHANGES, LICENSE and `participants.json` of every native request goes to a model before a person has read it, after the mechanical rules have passed it.
  The depositor-facing policy must say so before the flag is turned on in production.
- Every dataset with a recording format the screen cannot parse (BrainVision, EEGLAB, FIF and others, ADR 0087) carries the screen's acknowledgment reason; the model still reviews it, and one recorded reason clears that reason without `--force`.
  How large a share of native requests that is has not been measured.
- A terminal can no longer approve a `blocked` request after re-running its screen, which it can today; a blocked request is the depositor's to fix.
- The email waits a few minutes longer.
- Phase 1 must read the screen's state and head the same way ADR 0086's gate does; a second reading of the screen would be a second source of truth.
- Accepted risks, stated so nobody rediscovers them:
  - **Prose that names a person.** No mechanical rule sees it, here or in the screen; the model is not asked about it; a person reading the README is still the only check.
    Extending the screen to the root documents, so that the screen and the pre-send check apply the same rules to the same files, is a follow-up outside this epic.
  - **A model wrong in the green direction.** A pass is a model's opinion that facts could not contradict, not a certification; the gate makes a non-pass cost something and leaves a pass to the administrator's own reading.
  - **Override fatigue.** If the model is often wrong, administrators will learn to pass `--force`; the soak measures the rate before production (open judgment call 6).
  - **The interim attribution gap** of section 9, closed by Phase 3, which is why the flag stays off in production until it ships.

## Alternatives considered

- **Read a verdict from the model.** The one field an injected instruction would target, and the field ADR 0092 refused for the same reason. Rejected.
- **A workflow in each dataset repository.** A collaborator can edit it on a branch, the federation rule would have to trust every repository, and it would be rolled out to about 785 of them (ADR 0020). Rejected for one central workflow.
- **Let the model review the identifier findings, or ask it about privacy.** Explicitly out of scope; a model that sees a finding sees the value's neighbourhood, and a model's silence about privacy would read as a clean bill. Rejected.
- **Trust the screen's verdict as clearing the text (the literal screen-first option).** The screen does not read those files (Context), so the rule would have been true by name only. Kept as the ordering rule, replaced as the content rule by the pre-send check.
- **Run the model only when the screen is `clear`.** Would leave every dataset in a format the screen cannot parse without a review, while protecting nothing the pre-send check does not already protect. Rejected (open judgment call 1).
- **Keep the advisory pre-screen beside the review.** Two model calls about the same text, one of them outside every rule of section 2, and two answers that can disagree. Rejected.
- **Deny automatically on a model fail, or on a hard fact.** Nothing is ever auto-denied: a model can be wrong, and a hard fact already refuses approval without closing the request, so the depositor can fix and request again. Rejected.
- **Enforce the gate in the CLI only, as ADR 0093 does for pull requests.** A pull-request approval happens on GitHub with the administrator's own token; a publication approval is answered by the Worker, and the web path and any other client reach it without the CLI. Rejected.
- **Show another commit's verdict with a warning.** A pass about other content is the mistake ADR 0093 exists to prevent. Rejected.
- **A tally and an override table per depositor, as for contributors.** Depositors are approved accounts and requests are rare; the cap bounds spend without a reputation system. Rejected.
- **Send the email at the screen and a second one at the review.** Two mails per request, and the first asks for a decision before its information is in. Rejected.

## Open judgment calls for the maintainer

Each has a recommendation; the decision above follows the recommendation.

1. **Run the model when the screen needs an acknowledgment**, not only when it is clear. Recommended: yes, for the reason in Alternatives.
2. **Send README and description prose to a model at all**, given that no mechanical rule can see a name in prose. Recommended: yes, with the pre-send check, the policy notice, and the follow-up that extends the screen to the root documents.
3. **One recorded screen acknowledgment clears the screen's reason without `--force`.** Recommended: yes, one act per reason; the alternative asks for two flags on every request whose screen needs a person.
4. **The version facts (`version_already_released`, `version_malformed`, `version_missing`) are passed with `--force`, not hard.** Recommended: yes, keeping the hard set to policies already made unconditional; the alternative makes `version_already_released` hard, which would also refuse a de-anonymizing publication that keeps the anonymous release's version (ADR 0065 calls a new revision the ordinary shape, not a rule).
5. **A `blocked` request is not approvable from a terminal.** Recommended: yes; this closes a path that exists today.
6. **The model.** Recommended: Haiku 5.5 at `high` for the soak, re-running the soak requests on Sonnet 5.5 if the administrator judges more than one in five of the non-pass outcomes wrong; cost decides nothing at either price.
7. **The mail waits for the review.** Recommended: yes.
8. **The depositor does not see the review in this epic.** Recommended: yes; revisit with the soak's false-fail rate in hand.
9. **Caps of 5 calls per depositor and 50 per platform per day.** Recommended: these; the volume of native requests is not yet measured, and Phase 5 reads it first.
10. **`y` in `next` runs the approval in the terminal**, not through the web executor. Recommended: inline, because `/approve` from the administrator's own credential is the contract; a very large dataset can still be approved from the web.
11. **The flag switches the gate as well as the spend.** Recommended: yes; a gate that outlives its review would ask for `--force` on every request reviewed before a switch-off.
12. **Production is turned on only after Phase 3 (attribution) and Phase 4 (the web page) have shipped.** Recommended: yes; before Phase 4 the web page cannot pass the gate, and before Phase 3 an override can be attributed to the wrong administrator.

## Before it is switched on

1. Create a federation rule (and, preferably, its own service account) that accepts only `repo:nemarDatasets/.github:ref:refs/heads/main` with `job_workflow_ref` `nemarDatasets/.github/.github/workflows/run-publication-review.yml@refs/heads/main`, so the review's spend and its revocation are its own.
2. Release the review script to `main` before deploying the workflow, which checks the script out of `main` (the note ADR 0086 makes for the screen).
3. Deploy `run-publication-review.yml` by whole-file copy, and add it to the parity test's sparse checkout.
4. State on the published submission standards that a model reads the README and the description of a native request after the identifier screen.
5. Soak on dev (Phase 5) against a standing native fixture that dev owns; ADR 0068 names `nm099997` as the next one, declared dev-owned before it is created and never approved under a name.
6. Ship Phases 3 and 4, then add `PUBLICATION_REVIEW_ENABLED = "1"` to `[vars]`, and run `nemar admin publish start --all` once for the requests already open.

## Receipts

- Epic #1726; this phase #1727; approval issues #1579, #1581, #1582, #1583, #1603, #1604 and their neighbours #1580, #1584.
- The screen's coverage: `readCandidates` and `JSON_EXCLUDED` in `scripts/identifier-fleet-lib.ts`; the shared rules in `shared/identifier-scan.ts`.
- The pre-screen: `backend/wrangler-sccn.toml` (`PRESCREEN_ENABLED`), `backend/src/routes/datasets/publication.ts`, `run-prescreen.yml` in `nemarDatasets/.github` (read 2026-10-12).
- The template: `shared/pr-review.ts`, `backend/src/services/pr-review.ts`, `backend/src/routes/callbacks/pr-review.ts`, migrations 0092 and 0095, `.github/dataset-workflows/run-pr-review.yml`, `scripts/ci/pr-review*.ts`, `src/commands/admin-pr-reviews.ts`, `src/lib/pr-review-*.ts`.
- The approval path: `backend/src/routes/admin/publish.ts`, `backend/src/services/publication-orchestrator.ts`, `backend/src/services/identifier-screen.ts`, `backend/src/services/approval-dispatch.ts`, `src/commands/admin.ts`, `src/lib/api/publish.ts`.
