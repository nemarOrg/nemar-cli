# ADR 0092: Dataset pull requests get a derived verdict from a Worker-gated model review

**Status:** proposed
**Date:** 2026-10-08
**Owner:** Seyed Yahya Shirazi

Follows ADR 0001 (published datasets are PR-only), ADR 0020 (central workflows, callback), ADR 0053
and ADR 0086 (unknown is never clear), ADR 0026 (adequacy judgments stay advisory).

## Context

A pull request to a published dataset is reviewed by an administrator by hand. The required checks
say the BIDS validator passed and the version went up. They do not say whether the change lost
anything, whether the revision is honestly described, or whether the dataset is better afterwards.

Three facts shape any automation here. Every approved user, and on a public dataset every GitHub
user, can open a pull request, from a fork if need be, so the text of a pull request is hostile by
default and each review costs money. A workflow in a dataset repository can be edited on a branch by
anyone with push access, and the federation rule that lets a job use the NEMAR Anthropic account
trusts a repository, so the identity must only ever be minted where an author cannot edit the
workflow. And `neutral` and `skipped` count as passing for a required check on GitHub, so "could not
decide" cannot be expressed with either.

## Decision

**The Worker is the gate, one central workflow is the reviewer, and the verdict is derived.**

- **The trigger is the GitHub App's `pull_request` delivery to the Worker**, for pull requests
  against `main` (not drafts, not bots). No workflow in any dataset repository takes part, so there
  is nothing in a dataset repository to edit and nothing to roll out to ~785 repositories (ADR
  0020). A fork is reviewed exactly like a branch: the job reads `refs/pull/N/head` from the BASE
  repository and never fetches from the fork.
- **The Worker decides whether a review is dispatched, and the claim makes that binding.** It
  records one row per (dataset, pull request, head commit) in `pr_reviews`, so a repeated delivery
  is free. It pauses a contributor who has had more than 5 pull requests rejected AND more than 10
  percent of their decided pull requests rejected (the later of the two thresholds), counted from
  the table, not stored: a pull request counts once, by its latest decided review, so fixing it
  clears it. `pr_review_overrides` lets a maintainer allow or block a contributor outright. A
  stranger gets 3 reviews an hour and 6 a day, a collaborator 20 an hour and 100 a day, and the
  platform 400 a day. The caps are ranked after the insert, so concurrent deliveries cannot all
  slip under them.
- **The workflow claims the review before it spends anything.** The dispatch carries a one-shot
  token the Worker signed for that review. The workflow's first real act is `POST
  /webhooks/pr-review-claim`; the Worker accepts the token once and refuses a commit that is no
  longer the pull request's latest (`superseded`). A dispatch that cannot claim (forged by someone
  who holds a dataset repository's workflow credentials, replayed, or stale) stops before anything
  is installed, minted or sent to a model, ends green and costs nothing. Without the claim the
  caps would bind only reviews the Worker itself dispatched, and the dispatch is an API anyone with
  those credentials can call.
- **The reviewer is `run-pr-review.yml` in `nemarDatasets/.github`**, authored in this repository
  and deployed by whole-file copy like the onboarding workflow. The Anthropic identity is minted
  there and nowhere else, by workload identity federation (`claude-haiku-5-5`, effort `high`). Each
  step holds only what it uses: the step that calls the model has the federated identity and the
  callback token and no GitHub credential, and the read-only token for ONE repository (contents and
  pull requests) reaches only the two steps that read it. The job has no credential that writes to
  GitHub or NEMAR beyond the one-shot callback token, which can post one report for one review.
  Nothing from the pull request is executed: the repository is fetched with `init` and `fetch`,
  never checked out.
- **The callback token is masked before anything can print it.** `nemarDatasets/.github` is public
  and Actions prints a step's `env:` in its header, so a token in job-level env would sit in every
  public log. The first step registers it as a secret with no env of its own, and only the steps that
  use it carry it. A job that fails after the claim reports through a dependency-free `curl` step
  written during validation, so it needs nothing the failure may have been about.
- **The model has no tools and writes little.** It answers three questions (is anything lost or
  broken, does the revision advance, is the dataset materially better) as pass, fail or unknown,
  with findings from a closed list. Untrusted text sits in a per-run, nonce-fenced block. It cannot
  write the evidence block, the version, the model name or a verdict.
- **The verdict is derived** by `verdictOf` from those answers and from facts computed from git. A
  fact overrules the model: no changed file cannot be an improvement, an unchanged version cannot
  advance the revision, a truncated list cannot certify that nothing was lost, and a steering
  attempt fails the review. The report is a closed vocabulary; free text is sanitised to plain words.
- **Every change is accounted for.** The report carries exact per-area counts, the version and
  subject change, how much content the model read, and a file list. The Worker refuses a report whose
  areas do not add up to its file total.
- **Green and red are real; everything else needs a person.** `pass` is a `success` check,
  `fail` a `failure`, and an uncertain, declined, errored or never-reported review is
  `action_required`. The Worker publishes the check-run and one pull-request comment, edited in place
  per commit, and a watchdog republishes a result whose check never reached GitHub. A human still
  approves and merges.
- **The check is not required by any ruleset yet.** Making it required is a separate decision, made
  with the observed false-fail rate in hand, through `nemar admin fleet enforce`.

## Consequences

- An administrator opens a pull request that already says what changed, in counts, and what a
  reviewer found, with a pass or fail beside the BIDS check.
- A model is now red or green on a pull request. That departs from ADR 0026, which keeps adequacy
  judgments advisory, and is acceptable only because the check is not required and a fact can lower
  the model's answer but the model can never raise a fact.
- A contributor can be paused by the tally. The only way back today is a row in
  `pr_review_overrides`, written with `wrangler d1 execute`; an admin command is a follow-up.
- The tally and the rate caps live in D1 on the production Worker. The dev Worker answers only for
  repositories it owns, and the watchdog is production-only.
- Anything that stops a review after it was claimed (a missing org variable, a federation rule that
  does not match this workflow, an unreadable file) shows as a check that needs a person, never as a
  pass. A missing App permission for the comment is the exception: the check still lands, the
  comment's refusal is logged, and the stored verdict is kept.
- The review sees names, counts and the content of a few metadata files, not recordings. It says so.
- Accepted risks, stated so nobody has to rediscover them:
  - **Many new accounts.** The per-author caps and the tally are keyed on the GitHub account id, so
    someone who opens accounts can buy reviews. The platform cap of 400 a day bounds the cost, and
    it is one shared pool: a flood from strangers can starve a trusted contributor of a review that
    day (the check says so, and the pull request is reviewed by hand as it was before).
  - **Padding the tally.** A contributor can open many easy passing pull requests to stay under the
    10 percent threshold. The thresholds are a rate limiter, not a reputation system.
  - **Attribution when a maintainer edits.** The author of record is whoever opened the pull
    request; commits a maintainer pushes to it count against that author.
  - **A model can be wrong in the green direction.** Facts cover what git can establish (nothing
    changed, version not advanced, files or subjects lost, a truncated list); a plausible-looking but
    harmful change in a sidecar value is not one of them. This is why the check is not required.
- A review that ended in an error for a setup reason (a missing organization variable, a federation
  rule that does not match) is not repeated for the same commit, because the row for that commit
  exists. A new push re-runs it. A re-run command belongs with the admin follow-up.

## Alternatives considered

- **The Claude GitHub App or `claude-code-action` in each dataset repository.** Needs a workflow in
  every dataset repository that a collaborator can edit on a branch, a federation rule that trusts
  all of them, an agent with tools in front of hostile text, and a rollout to every repository.
  Rejected. The app can still be installed for `@claude` on pull requests; it is not the gate.
- **A `pull_request` workflow per dataset that calls the central one.** The shims already do this for
  validation. Rejected for a model call: an author controls that workflow's text on their branch.
- **Neutral for "could not decide".** Counts as passing for a required check. Rejected.
- **Let the model return the verdict.** The one field an injected instruction would target.
- **Count every push as a rejection.** Punishes iteration; one bad pull request pushed five times
  would be five strikes.

## Before it is switched on

1. Subscribe the NEMAR App to Pull request events, and grant Pull requests: write (for the comment).
   Until then no event arrives, so the feature is inert whatever `PR_REVIEW_ENABLED` says.
2. Set the four `ANTHROPIC_*` organization variables on `nemarDatasets`, and check the federation
   rule accepts only `repo:nemarDatasets/.github:ref:refs/heads/main` for this workflow.
3. Deploy `run-pr-review.yml`, then add it to the `unit-pure` sparse checkout with
   `NEMAR_PR_REVIEW_WORKFLOW_LIVE` so the parity test stops skipping.
4. Release this change to production, then set `PR_REVIEW_ENABLED=1` on the production Worker. The
   flag stops new reviews only: the watchdog and the republish pass run regardless, so switching it
   off never strands a check that is already in flight.

## Receipts

- Contract and tests: `shared/pr-review.ts`, `test/pr-review.test.ts`.
- Worker: `backend/src/services/pr-review.ts`, `backend/src/routes/callbacks/pr-review.ts`,
  migration 0092, `backend/test/pr-review-flow.test.ts`.
- Job: `scripts/ci/pr-review*.ts`, `.github/dataset-workflows/run-pr-review.yml`,
  `test/pr-review-evidence.test.ts`, `test/pr-review-workflow.test.ts`.
