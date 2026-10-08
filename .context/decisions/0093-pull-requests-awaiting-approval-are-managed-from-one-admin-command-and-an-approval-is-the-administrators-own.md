# ADR 0093: Pull requests awaiting approval are managed from one admin command, and an approval is the administrator's own

**Status:** proposed
**Date:** 2026-10-08
**Owner:** Seyed Yahya Shirazi

Follows ADR 0092 (the review this command lists and acts on), ADR 0001 (published datasets are
PR-only), ADR 0053 and ADR 0086 (unknown is never clear).

## Context

ADR 0092 records an automated review of every pull request to `main` of a dataset repository, but an
administrator still has to visit the repositories one at a time to find what is waiting, and the only
way to restore a contributor the tally has paused is a row written with `wrangler d1 execute`.

Four facts shape the answer. An approval is a person vouching for a change and GitHub records whose;
the Worker can act only as the NEMAR App or with the shared datasets token, and neither is a person.
GitHub knows which pull requests are open and what their checks say, the Worker knows what the review
concluded, and neither alone answers "what is waiting for me". The `nemarDatasets` organisation is
shared by production and dev while their D1 databases are not. And the title and branch name of a
pull request are written by whoever opened it, who may be anyone on a public dataset.

## Decision

**One command group, `nemar admin pr-reviews`, lists, explains and approves, and its approval is made
by the administrator, from their machine, with their own GitHub login.**

- **The queue is one search joined to the review table.** `GET /admin/pr-reviews` runs the GitHub
  search `org:nemarDatasets is:pr is:open base:main` as a paginated GraphQL query with the datasets
  token, which returns each pull request's head commit, fork, author id and required checks in the
  same call, then joins the latest `pr_reviews` row per (dataset, pull request). A pull request with
  no row is `not_reviewed`, not an error, so the command works with `PR_REVIEW_ENABLED` off. A GraphQL
  error fails the whole read, because a partial queue that looks complete is worse than none.
- **A verdict belongs to the commit it read.** A review whose `head_sha` is not the pull request's
  current head is shown as `not_reviewed` (with what the older commit got as `stale_verdict`), never as
  a pass. The detail view re-derives the verdict from the stored report and treats a report that no
  longer parses as `could_not_decide`.
- **Approval is the administrator's act and does not pass through the Worker.** `approve` takes the
  token `GH_TOKEN` or `gh auth token` supplies (never `GITHUB_TOKEN`, which in a workflow is the
  Actions bot's), refuses it unless `GET /user` says it belongs to a person and that person is the
  GitHub login linked to the administrator's NEMAR account, and submits the review with `commit_id`
  set to the head the administrator was shown. It then checks that GitHub recorded an approval, by
  that login, of that commit. The Worker holds no credential that could approve and no route does.
  With no usable token it prints the pull request link and the `gh pr review --approve` command.
- **The verdict gates the approval without taking the decision.** A pass proceeds after a
  confirmation. An uncertain, undecided, missing or stale review is confirmed with the reason in
  front of the administrator. A failing review, or one still running, needs `--force`.
- **Nothing merges without `--merge`, and a merge never goes around the ruleset.** It waits for GitHub
  to report the pull request `clean`, sends the approved `sha` so GitHub refuses a branch that moved,
  and stops with the approval standing if the state is anything else. An administrator can be a bypass
  actor, so "my token can merge it" is not evidence that its required checks passed.
- **Overrides are keyed by GitHub's numeric id.** `allow`, `block` and `clear` resolve the login at
  GitHub before a write, because a login can be renamed and reused; the review history is accepted
  only for reading a standing and for clearing a decision already on file. Each change writes an
  audit row, and the reason is reduced to plain words before it is stored.
- **Each Worker lists the datasets it owns.** The dev Worker answers for dev-owned datasets and
  production for the rest, the same fence the webhook applies, so the dev Worker never presents
  production's pull requests as unreviewed and never acts on a production repository.
- **Text a pull request's author controls is reduced twice.** The Worker passes titles through
  `sanitizeNote`, reduces branch names to the characters a git ref uses, builds links from the dataset
  id and number, and never reads a body. The CLI removes control characters again before printing.

## Consequences

- An administrator sees every open pull request in one table, with the ones they can act on first,
  and approves from the same place under their own name. The `wrangler d1 execute` workaround in ADR
  0092 is retired.
- The approval is recorded by GitHub and nowhere in NEMAR. The Worker never sees it, so there is no
  NEMAR audit row for an approval; the review on the pull request is the record.
- `approve` needs a GitHub login. An administrator whose NEMAR account names none is shown the login
  being used and asked to confirm, since nothing can be compared.
- The list depends on GitHub's search index, which can trail a new pull request by a minute and
  returns at most 1000 results; both are said out loud (`truncated`) rather than hidden.
- The Worker's GitHub App needs read access to pull requests and to checks and commit statuses for
  the GraphQL query. Without it the list answers 502 and says why.
- The dev Worker cannot show a production review. `approve` against it proceeds as "not reviewed" and
  says so, since the approval itself does not depend on the Worker.
- A review that errored for a setup reason is still not re-run from here; a re-run command is not part
  of this decision.

## Alternatives considered

- **Approve from the Worker with the App or the datasets token.** Puts the App's name on a judgment a
  person made, and turns the automated review into its own approval. Rejected.
- **Store a GitHub token per administrator in NEMAR.** A user-to-server credential that could approve
  for a person, with its own revocation cascade (AGENTS.md), for a command that runs on that person's
  machine where `gh` already holds the credential. Rejected.
- **Only print `gh pr review --approve`.** Kept as the fallback. It cannot pin the commit, check whose
  token it is, or put the verdict in front of the administrator first.
- **The REST search plus one call per pull request.** About two extra requests per pull request
  against a token every sweep shares, at a rate GitHub answers with a secondary limit. Rejected for one
  GraphQL search.
- **Merge after approving by default.** ADR 0001 lets an owner merge their own pull request; nothing
  here should make a merge the side effect of a review.
- **Show an earlier commit's pass as a pass with a warning.** A pass about different code is the
  mistake this ADR exists to prevent. Rejected.

## Receipts

- Contract: `shared/contract/pr-review-admin.ts`. Worker: `backend/src/services/pr-review-queue.ts`,
  `backend/src/routes/admin/pr-reviews.ts`. Tests: `backend/test/pr-review-queue.test.ts`.
- Command: `src/commands/admin-pr-reviews.ts`, `src/lib/pr-review-approve.ts`. Tests:
  `test/admin-pr-reviews-cli.test.ts`, `test/pr-review-approve.test.ts`.
