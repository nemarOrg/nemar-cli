# ADR 0046: Cross-repo parity compares pre-release branches, never `main`

**Status:** accepted
**Date:** 2026-09-06
**Owner:** Seyed Yahya Shirazi

## Context

The account copy shown to a user exists twice:
`shared/contract/account-copy.ts` here,
and `src/lib/account-copy.ts` in `nemarOrg/website`.
The two repos share no package,
so the website's copy is a transcription rather than an import,
and a transcription with nothing watching it is a fork with a delay.
Both repos therefore sparse-check out the counterpart's file in CI
and fail if a shared key disagrees
(nemar-cli's `website parity` test, the website's `account-copy-drift` test).

Which ref to check out is the whole question.
The gate first paired `staging` with `dev` for ordinary PRs
but pinned `main` for a PR whose base is `main`,
reasoning that a released copy should be compared against a released contract.
That pairing deadlocks a coordinated release, symmetrically:
this repo's `dev` -> `main` PR compares its new contract against the website's
`main`, which has not promoted yet,
while the website's `staging` -> `main` PR compares its new copy against OUR
`main`, which has not promoted yet either.
Both required checks go red and neither promotion can merge to unblock the other.
It is not a first-release bootstrap problem; it recurs on every release that
touches the copy.

## Decision

Both repos always check out the counterpart's **pre-release** branch
(`staging` from the website, `dev` from nemar-cli),
whatever branch the pull request targets.

## Consequences

The deadlock cannot recur, and the gate stays non-vacuous:
every copy change reaches `dev` or `staging` through a PR,
and that PR is checked against the counterpart's live pre-release branch.
A promotion PR re-checks the exact pair about to ship together,
which is the question actually worth asking at release time.

What is given up is a `main`-versus-`main` comparison,
which turns out to assert nothing:
once both sides promote, each `main` equals its pre-release branch,
so the check is already covered.
The one state it would have caught is a half-finished release,
where one repo promoted and the other did not.
That window is transient and deliberate,
it is owned by the release order rather than by a copy gate,
and a red parity check during it would block the very promotion that closes it.

Ordinary feature PRs keep a real obligation:
a copy change in one repo must land on the counterpart's pre-release branch
first, or the PR that introduces it goes red.
That was already true before this ADR and is unchanged by it.

## Alternatives considered

- **Fall back to the pre-release branch only when the file is absent from
  `main`.** Fixes the first release and nothing after it: on later releases the
  file exists on `main` but carries the previous release's strings, so the
  comparison fails on content instead of absence, which is a worse failure
  because it looks like real drift.
- **Merge one side with the red check overridden.** Restores the deadlock every
  release, and spends an admin override on a gate that was correct to fire.
- **Drop the strict mode and let a missing counterpart skip.** This is exactly
  the silent pass that website#311 and #1268 were written to remove.
- **Publish the contract as a shared package both repos depend on.** The right
  long-term answer and it removes the transcription entirely, but it needs a
  publishing pipeline and a version-skew policy of its own; it does not belong
  in a release-unblocking change.

## Receipts

- ADR 0045 — the CLI and the web say one thing about an account.
- nemar-cli #1268 (phase 8) introduced the parity test; website#311 its mirror.
- Deadlock observed 2026-09-06 on nemar-cli #1276 and website#314,
  the v0.9.16 / v0.2.8 promotion of epic #1250.
- Reported as #1277; fixed by #1278 here and website#315.
