# ADR 0093: Pull requests awaiting approval are managed from one admin command, and an approval is the administrator's own

**Status:** proposed
**Date:** 2026-10-08
**Owner:** Seyed Yahya Shirazi

Follows ADR 0092 (the review this command lists and acts on), ADR 0001 (published datasets are
PR-only), ADR 0053 and ADR 0086 (unknown is never clear).

## Context

ADR 0092 records an automated review of every pull request to `main` of a dataset repository, but an
administrator still has to visit the repositories one at a time to find what is open, and the only
way to restore a contributor the tally has paused is a row written with `wrangler d1 execute`.

Four facts shape the answer. An approval is a person vouching for a change and GitHub records whose;
the Worker can act only as the NEMAR App or with the shared datasets token, and neither is a person.
GitHub knows which pull requests are open and what their checks say, the Worker knows what the review
concluded, and neither alone answers "what is waiting for me". The `nemarDatasets` organisation is
shared by production and dev while their D1 databases are not. And the title and branch name of a
pull request are written by whoever opened it, who may be anyone on a public dataset.

"Awaiting approval" is the maintainer's phrase for the work; ADR 0001 sets
`required_approving_review_count: 0` on a published dataset, so GitHub itself waits on no approval.
The command lists open pull requests and the review of each, and approving is something an
administrator chooses to do.

## Decision

**One command group, `nemar admin pr-reviews`, lists, explains and approves, and its approval is made
by the administrator, from their machine, with their own GitHub login.**

- **The queue is one search joined to the review table.** `GET /admin/pr-reviews` runs the GitHub
  search `org:nemarDatasets is:pr is:open base:main` as a paginated GraphQL query with the datasets
  token, which returns each pull request's head commit, fork, author id and required checks in the
  same call, then joins the reviews in `pr_reviews`. A pull request with no stored review is
  `not_reviewed`, not an error, so the command works with `PR_REVIEW_ENABLED` off. Anything that
  stops the read (a failed later page, a GraphQL `errors` array even with data beside it, a spent
  budget, a GitHub that does not answer) fails the whole read, because a partial queue that looks
  complete is worse than none. A result that cannot be read as a pull request is counted and shown,
  not dropped.
- **A verdict belongs to the commit it read, and the review used is that commit's.** `pr_reviews` has
  one row per commit, and a redelivery of a commit refreshes its `seen_at`: "latest" means the last
  commit seen (ADR 0092), so a force-push back to a reviewed commit makes that commit's review the
  newest. A delivery can still be missed, so the queue and the detail view use the review of the pull
  request's current head whenever one exists, whatever its place in that order, and otherwise show
  the most recently seen review as `not_reviewed` with what it concluded as `stale_verdict`. When the current head cannot be
  established no verdict is asserted at all. The detail view re-derives the verdict from the stored
  report and treats a report that no longer parses as `could_not_decide`, except that a stored `fail`
  stays a `fail`: an unreadable report must never make a rejection easier to approve. The list reads
  the stored column and the detail view reads the report; they agree unless a report is corrupt.
- **The checks shown are the ones the ruleset trusts.** The BIDS column counts only the check run
  posted by the NEMAR App that branch protection pins, because anyone with push access can add a
  workflow job with the same name. A commit status or another App's run does not count. The checks
  read are the head commit's; if the connection returns another commit they are `unknown`.
- **Approval is the administrator's act and does not pass through the Worker.** No Worker code path
  approves, and the Worker holds nothing that belongs to an individual administrator. The tokens it
  does hold (the App and the datasets token) could submit a review, which is why none is ever made
  with them. `approve` takes `GH_TOKEN`, or else the token `gh` holds (asked for with `GH_TOKEN` and
  `GITHUB_TOKEN` removed from its environment, because `gh` itself prefers them to its stored login).
  It refuses the token unless `GET /user` says it belongs to a person, and refuses it if the person is
  not the GitHub login linked to the administrator's NEMAR account. It submits the review with
  `commit_id` set to the head the administrator was shown and checks that GitHub recorded an approval,
  by that login, of that commit. With no usable token it prints the pull request link and the
  `gh pr review --approve` command.
- **The verdict gates the approval without taking the decision.** A pass proceeds. An uncertain,
  undecided, missing or different-commit review shows its reason and asks first; `--yes` skips the
  question, not the reason. A failing review, one still running, or one the NEMAR API could not be
  read for needs `--force`: an unknown verdict is never rendered as "not reviewed", because a stored
  rejection could be hiding behind it. An error from the review read stops the approval unless it is
  one of the two answers that mean the Worker cannot say (`not_owned_here`, `github_unavailable`).
- **A merge is attempted only on request, and is a check, not an enforcement.** `--merge` is
  attempted once, only if GitHub reports the pull request `clean`; it re-asks while GitHub is still
  working the state out, does not wait for pending checks, sends the approved `sha` so GitHub refuses
  a branch that moved, and otherwise stops with the approval standing. An administrator can be a
  bypass actor, so this does not attempt a merge GitHub reports as blocked; the ruleset enforces, and
  this code does not try to defeat it.
- **An outcome that is unknown is said to be unknown.** A write that gets no answer from GitHub may
  have been applied, so it is reported as "outcome unknown, check the pull request", never as a
  refusal.
- **Overrides are keyed by GitHub's numeric id.** `allow`, `block` and `clear` ask GitHub who holds a
  login now, because a login can be renamed and reused. `allow` and `block` need GitHub's answer. The
  login an override stored is used only to `clear` a decision for an account GitHub no longer has or
  cannot answer for, and only when exactly one account stored it. `allow` lifts the tally's pause and
  nothing else: the rate limits still apply. Each change writes an audit row, and the reason is
  reduced to plain words before it is stored.
- **Each Worker lists the datasets it owns.** The dev Worker answers for dev-owned datasets and
  production for the rest, the same fence the webhook applies, so the dev Worker never presents
  production's pull requests as unreviewed and never acts on a production repository.
- **Text a pull request's author controls is reduced twice.** The Worker passes titles through
  `sanitizeNote`, reduces branch names to a conservative character set, builds links from the dataset
  id and number, and never asks for a body. The CLI removes control characters again before printing.

## Consequences

- An administrator sees every open pull request in one table, with the ones they can act on first,
  and approves from the same place under their own name. The `wrangler d1 execute` workaround in ADR
  0092 is retired.
- The approval is recorded by GitHub and nowhere in NEMAR. The Worker never sees it, so there is no
  NEMAR audit row for an approval; the review on the pull request is the record.
- `approve` needs a GitHub login. An administrator whose NEMAR account names none is shown the login
  being used, since nothing can be compared; `--yes` skips the question for them as for anyone.
- The list depends on GitHub's search index, which can trail a new pull request by a minute and
  returns at most 1000 results. The 1000-result cap and the page bound are reported (`truncated`);
  the lag is only in the help text.
- The Worker's GitHub credential (the App's installation or the `GITHUB_ADMIN_PAT` fallback) needs
  read access to pull requests, checks and commit statuses for the GraphQL query. Without it the
  list answers 502 and says why.
- The dev Worker cannot show a production review. `approve` against it treats the verdict as unknown
  and needs `--force`.
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
- **The REST search plus a read and a check lookup per pull request.** Several requests per pull
  request against a token every sweep shares, at a rate GitHub answers with a secondary limit.
  Rejected for one GraphQL search.
- **Merge after approving by default.** ADR 0001 lets an owner merge their own pull request; nothing
  here should make a merge the side effect of a review.
- **Show another commit's pass as a pass with a warning.** A pass about different code is the mistake
  this ADR exists to prevent. Rejected.
- **Use the newest review row for every purpose.** Simpler, and wrong whenever the delivery of a
  force-push back to a reviewed commit was missed: it downgrades a failure to a confirmation.
  Rejected.

## Receipts

- Contract: `shared/contract/pr-review-admin.ts`. Worker: `backend/src/services/pr-review-queue.ts`,
  `backend/src/routes/admin/pr-reviews.ts`. Tests: `backend/test/pr-review-queue.test.ts`.
- Command: `src/commands/admin-pr-reviews.ts`, `src/lib/pr-review-approve.ts`. Tests:
  `test/admin-pr-reviews-cli.test.ts`, `test/pr-review-approve.test.ts`,
  `test/pr-reviews-render.unit.test.ts`.
