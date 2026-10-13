# Publication review: design analysis and phase plan

> **STATUS: ANALYSIS, NOT A RULING.**
> [ADR 0100](decisions/0100-a-publication-request-gets-a-derived-verdict-and-approving-a-non-pass-is-the-administrators-recorded-act.md) is the verdict.
> Where this note and the ADR disagree, the ADR wins.
> This note keeps what was read, the comparisons, the arithmetic and the refined plan for epic #1726.
> Written 2026-10-12 for Phase 0 (#1727), against the epic branch at `9cc6586f`.

## 1. What was read

Decision records, in full: the index; ADR 0014, 0026, 0040, 0065 (decision and the anonymous-release sections), 0080, 0086 (with every amendment and the known gaps of 2026-10-10), 0087, 0089, 0092 (with the amendment of 2026-10-10 and the open items), 0093 (with the amendment of 2026-10-10), and the 2026-10-12 amendments to 0092 and 0093 in open pull request #1720.

The pull-request review, as the model to follow:
`shared/pr-review.ts`;
`backend/src/services/pr-review.ts`;
`backend/src/routes/callbacks/pr-review.ts`;
migrations `0092_pr_reviews.sql` and `0095_pr_review_attempts.sql`;
`.github/dataset-workflows/run-pr-review.yml`;
`scripts/ci/pr-review.ts`, `pr-review-prompt.ts`, and the head of `pr-review-evidence.ts`;
and, through a read-only survey, `src/commands/admin-pr-reviews.ts`, `src/lib/pr-review-approve.ts`, `src/lib/pr-review-next.ts`, `shared/contract/pr-review-admin.ts` and their tests.

The publication path:
`backend/src/routes/datasets/publication.ts` (the request route);
`backend/src/routes/admin/publish.ts` (list, deny, approve, approve-dispatch, the screen re-run);
`backend/src/services/identifier-screen.ts` (start, store, mail lease, watchdog, gate);
`backend/src/services/publication-orchestrator.ts` (the approve entry, the screen gate call, the version tag);
`backend/src/services/approval-dispatch.ts` (`ACTIVE_REQUEST_TAIL_SQL`, `resolveApprover`);
`backend/src/services/submission-minimums.ts` and `submission-gate.ts`;
the publication migrations (0005, 0028, 0045, 0086, 0090, 0091);
`shared/identifier-screen-report.ts`, and the coverage rules in `shared/identifier-scan.ts` and `scripts/identifier-fleet-lib.ts`;
`backend/wrangler-sccn.toml` for the flags.
Through a read-only survey: `src/commands/admin.ts` (`nemar admin publish`) and `src/lib/api/publish.ts`.

Deployed workflows in `nemarDatasets/.github`, read through the API on 2026-10-12: `run-prescreen.yml`, `run-identifier-screen.yml`, `approve-publication.yml`.

The website (`nemarOrg/website`, local checkout, read only): `src/pages/admin/publication-requests.astro`, `src/components/PublicationRequestRow.astro`, `src/lib/publication-queue.ts`, `src/lib/admin-api.ts`, `src/lib/publication-block.ts`, `src/lib/account-copy.ts` and the drift tests under `test/`.

Repository rules: AGENTS.md hard rules, `.rules/documentation.md`, `.memory/README.md` and the notes on sentinels, tri-state fetches, make versus take, plan claims and the epic branch's CI.

Open issues #1579, #1580, #1581, #1582, #1583, #1584, #1603 and #1604.

## 2. Facts that shaped the design

Each was checked against the code, not taken from a document.

1. **The identifier screen does not read the documents a reviewer reads.**
   `readCandidates` (`scripts/identifier-fleet-lib.ts`) sends to the text rule (`scanTextForLocalPaths`) only `.py .m .r .txt .md .yml .yaml .xml .iml .cfg .ini` files under `sourcedata/` or `code/`, and to the JSON key rule (`scanJsonKeys`) only JSON that is neither a Brain Imaging Data Structure (BIDS) sidecar outside `sourcedata/` nor `dataset_description.json`, `participants.json` or `genetic_info.json` (`JSON_EXCLUDED`).
   The root README, CHANGES and LICENSE are therefore seen only as paths, by `scanPaths`, which every path goes through; their content is never read.
   So a screen verdict of `clean` says nothing about the bytes of the five files the review sends to the model.
   This is what turned "screen first" from a content rule into an ordering rule, with a pre-send check as the content rule.
2. **The shared text rules are narrow.**
   For free text there is one rule, a local user path (`/Users/<name>`, `C:\Users\<name>`).
   For JSON there is a key rule over a closed set of key names (`patientname`, `birthdate`, `mrn` and others at identifier severity; `email`, `contact`, `phone`, `address` and others at review severity).
   No rule recognizes a person's name in prose.
3. **The advisory pre-screen is a dev-only feature with a weaker contract than the rest.**
   `PRESCREEN_ENABLED = "true"` appears only in `[env.dev.vars]`.
   Its workflow builds a prompt from the README (first 6 KB) and `dataset_description.json` (first 4 KB) with no nonce fence, runs `claude -p --model haiku` with `CLAUDE_CODE_OAUTH_TOKEN`, takes `callback_url` from the payload, accepts any `reasons` strings, prints `{verdict, reasons}` to the log, and prints the raw model output and the command-line tool's error output on failure.
   It is dispatched from the request route in parallel with the identifier screen, so the model reads the README before any screen has reported.
4. **Approval is answered by the Worker.**
   `POST /admin/publish/:id/approve` runs `runPublicationApproval`, which reads the newest request in `requested`, `approving` or `blocked` (`ACTIVE_REQUEST_TAIL_SQL`), runs the screen gate (`checkApprovalScreenGate`) unless a resumed run has already started publishing, and then marks the request `approving`.
   Nothing in that path refuses a `blocked` request; the screen gate refuses one whose screen was reset by the block, and `nemar admin publish screen` re-runs the screen on a `blocked` request (`RERUN_GUARD_SQL`).
   So, by reading the code (not exercised), a terminal can approve a request blocked for `min_requirements_failed` once its screen has been re-run and is clear.
   `approve-dispatch` refuses a `blocked` request (`not_dispatchable`).
5. **The version published is read at approval time.**
   `getVersionTag` reads `Version` from `dataset_description.json` and defaults to `1.0.0`; `create_tag` tags the current head of `main` with `v<version>`.
   `createTag` (`backend/src/services/github/contents.ts`) treats a 422 on the ref, an existing tag, as success, so a version that was already released does not stop the run: the old tag stays where it was and the new content is published under it.
   `dataset_versions` is unique on `(dataset_id, version)`.
6. **The web executor runs the command-line interface (CLI).**
   `approve-publication.yml` runs `nemar admin publish approve <id> --yes [--resume]` with a service key per environment, so any gate that only the CLI enforces would either be skipped by the executor or refuse every web approval.
7. **The CLI approve command shows the steps but not the screen before its prompt, sends no request id, and exits 0 on every failure** except a bad `--acknowledge-identifier-screen` length (#1581, confirmed by reading `handleCommandError`).
8. **The website's approval page renders none of the screen.**
   `PublicationRequest` in `src/lib/admin-api.ts` declares no `identifier_screen`; `approveDispatch` sends the literal body `{}`; its error map has no `identifier_screen_not_clear`; and its transcription of the block reasons (`src/lib/publication-block.ts`) has six values where nemar-cli's `publicationBlockReasonSchema` has seven (it lacks `identifier_screen_findings`), with no drift test to notice.
9. **The pull-request review never sends an unpublished dataset to a model** (`REVIEWABLE_DATASET_PREDICATE` requires `first_published_at`); a publication review is by definition about an unpublished dataset, so the licence to read it has to be stated, and the ADR states it: the depositor's own request to publish exactly this content.
10. **Cron.** Production runs `0 3 * * *` and `*/30 * * * *`; dev runs only `0 4 * * *`.
    Every watchdog is production-only, which is why ADR 0093's surfaces age a dispatched row by time.

## 3. Pull-request review and publication review, side by side

| Concern | Pull-request review (ADR 0092, 0093) | Publication review (ADR 0100) |
|---|---|---|
| What starts it | The App's `pull_request` delivery to the Worker | The Worker itself, when the identifier screen's result for the request is stored, or an administrator's `start` |
| Unit | (dataset, pull request, head commit) | (request, screened commit, anonymous flag) |
| Who wrote the text | Anyone on GitHub, forks included | The depositor, an approved account |
| Eligible datasets | Active, public, named, first-published | Native submissions (`requiresUploaderName`); mirrors and exemplars are not applicable |
| Ordering against other checks | Independent of BIDS and version checks | Strictly after the BIDS wait and the identifier screen, for the screen's commit |
| What the model reads | The diff of changed metadata files, pull-request title and body, commit subjects | README, BIDS keys of `dataset_description.json`, CHANGES, LICENSE, `participants.json`, the `participants.tsv` header, a structural summary |
| Pre-send content rule | None (the content is already public) | The shared mechanical rules over exactly the bytes sent; a file with a finding is withheld whole |
| Questions | 3 (nothing lost, revision advances, materially better) | 4 (complete and honest, meets standards, authors and license, name adequate) |
| Facts that overrule | Removed files, version not advanced, truncated list, no change | Withheld or cut files, missing README or License, short name, placeholder authors, no recordings |
| Outcomes | `pass`, `fail`, `uncertain` | `pass`, `fail`, `action_required` |
| Where the result goes | A check-run and one edited pull-request comment, plus D1 | D1, the admin email, the CLI and the web page; nothing on GitHub |
| Republish pass | Yes (`published_at`, five attempts) | None (nothing to publish) |
| Claim predicate | Latest delivery of the pull request, dataset still eligible | Newest review of the request, request still `requested`, screened head and flag unchanged |
| Callback origin | Workflow's table by environment name | Same |
| Read token | Contents and pull requests: read, one repository | Contents and actions: read, one repository |
| Watchdog | Production, 30 minutes, then republish | Production, 30 minutes, then the request's mail |
| Spend control | Contributor tally and overrides; 3/6, 20/100 per hour/day; 400 per day | 5 calls per depositor per day; 50 per day for the platform; no tally |
| Flag | `PR_REVIEW_ENABLED`, stops new reviews only | `PUBLICATION_REVIEW_ENABLED`, stops new reviews and the gate |
| Where the gate is | The CLI (approval is a GitHub review with the administrator's token) | The Worker (`/approve` and `approve-dispatch`); the CLI refuses earlier with the same words |
| A non-pass | `fail`, running or unread needs `--force`; uncertain or missing asks for confirmation | Every non-pass needs the force path, except hard reasons (refused) and the screen's reason (its own acknowledgment) |
| Who approves | The administrator's own GitHub login | The administrator who passed the gate; exact attribution in Phase 3 |

## 4. Data flow

```
depositor: nemar dataset publish request
   |
   v
POST /datasets/:id/publish/request ---- minimums fail / owner unnamed / CI failed --> 422 blocked
   |                                    CI pending --> blocked; sweep releases later
   v status = requested
startScreenAndNotify --> repository_dispatch[run-identifier-screen] --> workflow reads bytes
   |                                                                       |
   |                         POST /webhooks/identifier-screen-result <------
   v
storeScreenResult (state, head H)
   |-- gate blocks --> request blocked, depositor mailed (unchanged)
   |-- gate wait/rerun --> nothing to review; admin mail says so (unchanged)
   |-- review not applicable (mirror, exemplar) or flag off --> admin mail now (unchanged)
   v gate clear or acknowledge, flag on, native
startPublicationReview(request, H, anonymous)
   |-- row exists for (request, H, anonymous) --> reuse
   |-- over a cap --> declined (review_limit_reached) --> admin mail
   v insert dispatched row, then dispatch
repository_dispatch[run-publication-review] {dataset_id, request_id, review_id, head_sha, environment, callback_token}
   |
   v workflow (nemarDatasets/.github, main only)
mask token -> validate -> POST /webhooks/publication-review-claim (one shot)
   |-- 401/409 --> stop green, nothing spent (stale_head recorded by the Worker)
   v claimed
checkout nemar-cli main -> bun install -> federation check -> read-only token (one repo)
-> git init + fetch main (no checkout) -> fetched main == H ? else stale_head
-> read files at H -> pre-send check (shared rules) -> withhold flagged files
-> evidence (structural summary, version, minimums, tag exists, BIDS run at H)
-> OIDC token -> one model call (Haiku 5.5, high, no tools, JSON schema)
-> assemble + parse report -> POST /webhooks/publication-review-result
   |                                    (failure after claim: curl reports workflow_failed)
   v
Worker: parse at the door -> store report and verdict -> try the admin mail
   |
   v
admin mail (screen section + review section)  /  production watchdog: unreported after 30 min, then mail
   |
   v
nemar admin publish list | show | next | approve        website approval page
   |                                                      |
   v                                                      v
POST /admin/publish/:id/approve  <------------- approve-dispatch -> executor -> /approve
   screen gate (ADR 0086) -> review gate (ADR 0100) -> mark approving -> 16 steps
```

## 5. Screen first: the options weighed

The brief named a strong option: run the model only on content the screen has cleared for the commit, and otherwise record `action_required`.
Three readings of it were weighed.

| Reading | What it protects | What it costs | Verdict |
|---|---|---|---|
| A. The model runs only when the screen's state is `clear` | Nothing the model sees, because the screen did not read those files (fact 1) | Every dataset with a recording format the screen cannot parse (BrainVision, EEGLAB, FIF and others, per ADR 0087; most mirrors, per ADR 0089) needs an acknowledgment, so a large share of requests, not yet measured for native deposits, would never get a model review | Rejected as stated |
| B. The model runs after the screen reports for the same commit, when its gate is `clear` or `acknowledge`, and only on bytes the shared rules pass immediately before sending | Exactly the bytes sent, per file, with the same rules the screen uses elsewhere | One more scan in the review job; a withheld file lowers questions to unknown | Chosen |
| C. Extend the screen to read the root documents, then trust its verdict | The same as B, and the screen's own report would cover README and the description for every surface | A change to the scanner the upload preflight and the fleet scan share, with new findings on already-published datasets; outside this epic's scope | Recommended as a follow-up, not a prerequisite |

Under B the ordering still matters: the review never runs on a request whose screen has not reported, so a request with direct identifiers in its headers, which the screen blocks, never reaches a model at all, and a review is never about another commit than the screen's.

## 6. Cost estimate

Prices are the first-party rates the `claude-api` reference cached on 2026-10-06; the pull-request review's federation audience is `https://api.anthropic.com`, so these are the rates that apply.
Haiku 5.5: $0.10 per million input tokens and $0.50 per million output tokens for prompts up to 100,000 tokens.
Sonnet 5.5: $2 and $10.
Opus 5.5: $4 and $20.
Thinking is billed as output and counts toward `max_tokens` (the pull-request review's script says so for adaptive thinking at high effort).
Token counts use four characters per token; nothing here was measured with `count_tokens`.

Input, worst case: system prompt and schema about 1,500 tokens; facts about 1,000; README 24,000 characters (6,000 tokens); description 16,000 (4,000); CHANGES 8,000 (2,000); LICENSE 4,000 (1,000); `participants.json` 8,000 (2,000).
Total about 17,500 tokens.
Input, typical: about 5,000 tokens (a few-kilobyte README and description).
Output: `max_tokens` 16,000 is the ceiling; a typical answer with thinking at high effort is assumed at 3,000.

| Model | Typical call | Worst call | Worst day at the platform cap (50) |
|---|---|---|---|
| Haiku 5.5 | 5,000 x 0.10 / 1e6 + 3,000 x 0.50 / 1e6 = $0.0005 + $0.0015 = **$0.002** | 17,500 x 0.10 / 1e6 + 16,000 x 0.50 / 1e6 = $0.00175 + $0.008 = **$0.00975** | 50 x $0.00975 = **$0.49** |
| Sonnet 5.5 | $0.010 + $0.030 = **$0.040** | $0.035 + $0.160 = **$0.195** | **$9.75** |
| Opus 5.5 | $0.020 + $0.060 = **$0.080** | $0.070 + $0.320 = **$0.390** | **$19.50** |

At a realistic volume (assumed, not measured: a handful of native requests a day, restarts included), Haiku 5.5 costs cents a month and Sonnet 5.5 a few dollars.
Cost does not decide the model; the quality of the judgments does, which is why ADR 0100 asks the soak to measure them (open judgment call 6).
Each review also takes about two to four minutes of Actions time on `nemarDatasets/.github`, assumed from the pull-request review's job shape.

## 7. Refined phase plan

The epic's order holds, with two changes: the server-side gate lands in Phase 2 together with the CLI that can pass it, and #1581 (exit codes) moves into Phase 2 because Phase 2 adds new refusal paths to the same command.
Production is turned on only after Phases 3 and 4.

### Phase 1 (#1728): store, contract, workflow, mail

Files:

- `shared/publication-review.ts`: report and evidence shapes, the branded parser, the four questions, findings, reasons with what clears each, `verdictOf(report, facts)`, `describePublicationReview`, the run errors.
- `shared/contract/publication-review-admin.ts`: the admin API's shapes and error codes.
- `shared/submission-minimums.ts`: the pure rules moved out of `backend/src/services/submission-minimums.ts` (which re-exports them), so the review job and the Worker evaluate one function.
- `shared/untrusted-text.ts`: `fence`, `tidy`, `tidyPath` and `sanitizeNote` moved out of the pull-request review, which imports them back, so the two reviews cannot drift.
- Migration `0096_publication_reviews.sql` (the next free number at the time; check `ls backend/src/db/migrations`).
- `backend/src/services/publication-review.ts`: start (from `storeScreenResult` and from an admin start), caps ranked after insert, dispatch, claim, store, the production-only watchdog.
- `backend/src/routes/callbacks/publication-review.ts`: claim and result, under the `publication-review` token domain in `backend/src/services/github/callback-tokens.ts`.
- `backend/src/services/github/dispatch.ts`: `triggerPublicationReviewRun`.
- `backend/src/services/identifier-screen.ts`: the mail lease waits for an in-flight review; the email gains the review section (`backend/src/services/email.ts`).
- `backend/src/routes/admin/publish.ts`: `publication_review` on each list row, `GET /admin/publish/:id/review`, `POST /admin/publish/:id/review/start` (with the cookie Origin rule).
- `backend/src/index.ts`: the watchdog on the 30-minute tick, production only.
- `backend/wrangler-sccn.toml`: `PUBLICATION_REVIEW_ENABLED = "1"` in `[env.dev.vars]` only; `PRESCREEN_ENABLED` removed.
- `backend/src/routes/datasets/publication.ts`: the pre-screen dispatch removed.
- `.github/dataset-workflows/run-publication-review.yml`, `scripts/ci/publication-review.ts`, `scripts/ci/publication-review-evidence.ts` (git reads at the commit, the structural summary, the pre-send check through `shared/identifier-scan.ts`, the minimums, the tag lookup, the BIDS run), `scripts/ci/publication-review-prompt.ts`.

Tests (real D1 through `backend/test/helpers/d1.ts` with every migration, the real Hono routes, real git repositories, no mocks of business logic):

- `test/publication-review-contract.test.ts`: the parser refuses unknown keys, values outside the closed sets, counts that do not add up, and every way of putting free text where a word belongs; every `FindingKind` and every reason is classified (a `Record` over the union, so a new kind fails the build); facts only lower; the report agrees with itself in the safe direction.
- `backend/test/publication-review-flow.test.ts`: a stored screen result starts exactly one review; `blocks`, `wait` and `rerun` start none; the flag off starts none and the mail goes as before; a mirror and an exemplar start none; the dedupe key; a re-request with the other flag starts a new row; caps ranked after insert under concurrent starts; dispatch failure fenced by nonce and `claimed_at IS NULL`; a forged, replayed or stale claim refused; an unsettled claim closed as `stale_head`; the watchdog marks `unreported` and keeps the nonce; a late report replaces it; the dev Worker refuses a dataset it does not own and production refuses one dev owns.
- `backend/test/publication-review-mail.test.ts`: the mail waits for an in-flight review and goes when it reports, errs or is marked unreported; it never goes twice for one result in the normal case.
- `test/publication-review-evidence.test.ts`: on real git repositories, a README with a local user path is withheld and counted; a `dataset_description.json` with an identifier key is withheld; a file that is not UTF-8 or is over its cap is withheld or cut and says so; `participants.tsv` rows never appear in the prompt (assert on the built message); no path or subject label appears in the prompt.
- `test/publication-review-workflow.test.ts`: the workflow's shell steps run against a stand-in Worker (validation, the claim's 200/401/409/5xx handling, the `curl` reporter), as `test/pr-review-workflow.test.ts` does.
- Mutation checks in the dangerous direction: removing the pre-send check, the screen-head predicate in the claim, or the flag check must turn a test red.

Must not: add the approval gate (that is Phase 2's, with the CLI); write anything to GitHub; send any byte of a table row, a header or a screen report to the model; change `shared/identifier-scan.ts` or the screen's verdicts; dispatch anything from the dev Worker for a dataset it does not own; read the screen's state or head differently from ADR 0086's gate.

### Phase 2 (#1729): the CLI and the gate

Files:

- `src/commands/admin-publish.ts` (the `publish` group moved out of `src/commands/admin.ts`), with `list` (review column, `--needs-me`), `show`, `start`, `start --all`, `next`, and `approve` showing the screen and the review before its prompt.
- `src/lib/publication-review-gate.ts` (the CLI's early refusal, from the shared reasons table) and `src/lib/publication-review-next.ts` (`parseChoice`, `approveAllowed`).
- `backend/src/services/publication-orchestrator.ts`: `checkApprovalReviewGate` after `checkApprovalScreenGate`, before `approving`; `approveSchema` gains `override_publication_review` (a review id).
- `backend/src/routes/admin/publish.ts`: `approve-dispatch` takes the same field and records the override at the claim; `POST /admin/publish/:id/comment` for `c` (an admin message mailed to the depositor, audited).
- #1581: every failure path of `approve`, `list` and `deny` exits non-zero; a declined confirmation is decided and tested.

Tests:

- `test/admin-publish-cli.test.ts`: the real binary against the real backend app on `Bun.serve` over real D1 (the shape of `backend/test/helpers/pr-queue-app.ts`), covering list, show, start, approve over each reason class, `--yes` never skipping a reason, the override bound to the review shown (a review that changed in between is refused), and `next` with typed answers.
- `test/publication-review-next.unit.test.ts`: answer parsing, when `y` is offered, the extra confirmation under `--force`, type-ahead discard.
- `backend/test/publication-review-gate.test.ts`: the gate on `/approve` and `approve-dispatch`; hard reasons refused even with an override; an override recorded by one administrator does not satisfy another's run; flag off means no gate; mirrors and exemplars not gated; the importer's approve path (`src/lib/import-publication.ts`) still passes for a mirror with the flag on.
- Exit-code tests for each failure path of `approve`.

Must not: let the Worker approve or deny anything; let `--yes` stand in for `--force` or for the screen's reason; change the orchestrator's steps; change ADR 0080's attribution (Phase 3's).

### Phase 3 (#1730): approval robustness

Order: #1583 (validate the id before the claim) and #1579 (request id precondition) first, because the dispatch token builds on them; then #1604 (attribution by a dispatch token that carries the request id and the clicker), #1582 (a release endpoint authenticated by the same token), #1603 (Origin on `/approve` and `/deny`, and `/deny` refused while an approval is in flight); triage #1580 (persist the lock continuation token) and #1584 (Origin for every cookie-authenticated admin write) and close or keep each with its reason.

Files: migration for the dispatch token's columns on `publication_requests`; `backend/src/services/approval-dispatch.ts`, `backend/src/routes/admin/publish.ts`, `backend/src/services/publication-orchestrator.ts`; a pull request to `nemarDatasets/.github` for `approve-publication.yml` (pass the token and the request id, call the release endpoint on failure); a new ADR that partially supersedes ADR 0080's decision 5.

Tests: each issue's acceptance test, written to fail without the change; a terminal approval by another administrator inside a live web lease is recorded under that administrator and does not ride on the clicker's override.

Must not: weaken the lease; let a dispatch token approve anything by itself (it carries attribution, not authority).

### Phase 4 (#1731): the web page

Files in `nemarOrg/website`: render `publication_review` and `identifier_screen` from the list response; an acknowledgment field for the screen's reason; an explicit confirmation for a non-pass, sent as the review id; `FRIENDLY` entries for `identifier_screen_not_clear`, `publication_review_not_clear` and `invalid_body`; the transcription of `shared/contract/publication-review-copy.ts` with a drift test that reads the nemar-cli file as text (the sparse checkout of `dev` in `ci.yml`, as for account copy); the seventh block reason in `src/lib/publication-block.ts`.
In this repository: `shared/contract/publication-review-copy.ts` (plain string literals, the account-copy rules) and a parity test that reads the website's copy through an environment variable or the sibling checkout.

Must not: compute a verdict in the browser; offer Approve for a hard reason; send a body the route does not accept.

### Phase 5 (#1732): soak and release

Order: finalize the epic into `dev` (the dev Worker deploys only from `dev`); declare `nm099997` dev-owned (ADR 0068's process, with the guard test) and create it as a native, named, private deposit owned by a test account; deploy `run-publication-review.yml`; create its federation rule; run the scenarios (a request that passes, one the model holds, one the screen holds, one with failing BIDS, one whose commit changes after the review, one over the depositor cap) and record each link (dispatch, claim, federation, model call, callback, stored verdict, CLI, web page); deny every request after reading it; release with the flag off in production; record in the release notes how it is turned on and what to read first (`nemar admin publish list`, then `nemar admin publish show` on one request); delete `run-prescreen.yml` from `nemarDatasets/.github` after the release.

Must not: approve `nm099997` under a name; turn the flag on in production in the release itself.

## 8. Risks

1. **Prose that names a person reaches a model.** The pre-send rules cannot see it (fact 2). Mitigated only by the policy notice and by the follow-up that brings the root documents under the screen.
2. **Override fatigue.** A model that is often wrong teaches administrators to pass `--force`. The soak measures how often an administrator disagrees.
3. **The mail is later.** Bounded by the screen's 50 minutes, the review's 30 and a tick.
4. **Dev never ages a row.** Every surface must read a dispatched row past its deadline as not reported, or a stuck dev review would read as running forever.
5. **The interim attribution gap.** Until Phase 3, an override can ride on ADR 0080's lease-based attribution; the flag stays off in production until Phase 3 ships.
6. **The web page cannot pass the gate until Phase 4.** With the flag on and Phase 4 not shipped, every web approval of a non-pass is refused.
7. **The workflow runs `main` of nemar-cli.** A workflow deployed before the script is released fails every review after the claim (reported as `workflow_failed`); the release order in ADR 0100 avoids it.
8. **Two copies of fence and sanitizer helpers.** Phase 1 moves them to one shared module; leaving two invites the drift ADR 0092 fixed once already (`sanitizeNote`'s ordering bug).
9. **The ADR number.** Open pull request #1722 also claims 0100; whichever merges second renumbers.
10. **A scope creep in `c`.** A comment to the depositor is a new mail type; it must carry only the administrator's typed words and must not be a side channel for the review's text.
11. **Unmeasured volume.** The caps are guesses until Phase 5 counts native requests.
12. **A model change.** Moving from Haiku 5.5 to Sonnet 5.5 is a one-constant change in the contract, but it changes the cost table above by a factor of about twenty.

## 9. What this note could not verify

- What the later steps (`version_doi`, the manifest callback that writes `dataset_versions`) do with a version that already has a row; `createTag` is known to keep the old tag (fact 5), which is why `version_already_released` is a reason at all.
- The exact columns that record a concept Digital Object Identifier's status, for `doi_state_unexpected`; Phase 1 defines the predicate against the schema.
- Whether the published submission standards or the contributor terms already say that a model reads submission text (the policy pages live in the docs repository).
- The number of native publication requests per day, and the share of them whose screen needs an acknowledgment.
- Model latency and token counts on real READMEs (no call was made in this phase).
- Whether the existing federation rule can be shared by a second workflow file (ADR 0100 recommends a rule of its own either way).
