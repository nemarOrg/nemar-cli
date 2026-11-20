# Card B4b: RFC-0001 points at 3.0.0-draft.2

Status: ready
Tier: lead
Timebox: S, 2 hours; escalate at 4 hours or two failed approaches
Needs: none
Depends: B5 merged into `draft/3.0.0`, O4c done (pre-release `3.0.0-draft.2` exists), O4d done (release `2.0.1` exists)
Branch: rfc/0001-biosig-zarr (the open draft PR nemarOrg/rfcs#2; no new branch)
Worktree: /Users/yahya/Documents/git/nemar/rfcs
Plan: /Users/yahya/Documents/git/nemar/nemar-cli-worktrees/rfc-program/.context/rfc-program/plan.md, section 4

## Goal

The RFC-0001 draft (nemarOrg/rfcs#2) names the release that holds the proposed text together with its schemas and vectors, `3.0.0-draft.2`, wherever it now names `3.0.0-draft.1`,
says where the schemas and the conformance suite are,
and states the license of the specification text it quotes,
so the owner opens RFC-0001 on one immutable tag that matches Q10.

## Context

B5a released the version 2 schemas and vectors on `main` as `2.0.1` (Q33, step O4d), and B5 put them and the version 3 ones on `draft/3.0.0` after the tag `3.0.0-draft.1` (08a990b7), so that tag holds the text without them; step O4c tagged `3.0.0-draft.2` on the merged head.
Risk K9: the RFC text is licensed Creative Commons Attribution 4.0 International (CC BY 4.0) (Q6), and the specification text it quotes is under the World Wide Web Consortium (W3C) Software and Document License, whose terms ask for its notice on a copy.
Read first: `text/0001-biosig-zarr.md` and the PR body on the branch head (b49245f2 at C1), and B5's report pasted under "Reports from dependencies".
Run `git -C /Users/yahya/Documents/git/nemar/rfcs fetch origin && git -C /Users/yahya/Documents/git/nemar/rfcs switch rfc/0001-biosig-zarr && git -C /Users/yahya/Documents/git/nemar/rfcs pull --ff-only` before editing.
The PR stays a draft, with `opened_at` null; nobody merges it until the owner opens the RFC.

## Scope

`text/0001-biosig-zarr.md`, the index lines in `README.md` that `rfc-check` regenerates, and the PR body (the opening post).

## Decided design

Settled:

- Every mention of `3.0.0-draft.1` becomes `3.0.0-draft.2`: the comparison link under the title (text line 26), the Summary's "tagged `3.0.0-draft.1` when the RFC opens" (line 56), "Rollout and cost" (line 944, "The `3.0.0-draft.1` text is revised from the comments"), the version 3 row of the table in "History of the format" (line 968), and "References" (line 998); line numbers are at head b49245f2.
- The comparison link's base becomes `2.0.1` (`2.0.1...3.0.0-draft.2`), so it shows only what version 3 proposes, not the version 2 schemas and vectors that `2.0.1` released (Q33); every other mention of `2.0.0` stays, because the quoted text and its line links are the `2.0.0` text, which `2.0.1` does not change.
- The paragraph that says what nemarOrg/biosig-zarr holds when the RFC opens links `schemas/` and `conformance/` at the tag `3.0.0-draft.2`, and says how many vectors there are, from B5's report.
- One sentence in "## Problem", just before the first quotation of the specification (the "Time axis" paragraph, text lines 98 to 101 at b49245f2), says that quoted specification text is under the W3C Software and Document License, with a link to biosig-zarr's `LICENSE.md` at tag `2.0.0`; the license table row at text line 711 is not a quotation and stays as it is.
- The same changes in the PR body where it repeats them.
- No other change to the text.

The implementer may choose: the wording of the two added sentences.

## Acceptance

On the branch, in `/Users/yahya/Documents/git/nemar/rfcs`:
`bun run src/check.ts` exits 0.
`grep -c "3.0.0-draft.2" text/0001-biosig-zarr.md` prints at least 5.
`grep -c "3.0.0-draft.1" text/0001-biosig-zarr.md` prints 0, and `grep -c "compare/2.0.1...3.0.0-draft.2" text/0001-biosig-zarr.md` prints at least 1.
`grep -c "W3C Software and Document License" text/0001-biosig-zarr.md` prints at least 2.
`gh pr view 2 -R nemarOrg/rfcs --json isDraft -q .isDraft` prints `true`, and `gh pr view 2 -R nemarOrg/rfcs --json body -q .body | grep -c "3.0.0-draft.2"` prints at least 1.
`git diff --name-only b49245f2...HEAD` lists only `text/0001-biosig-zarr.md` and `README.md`.

## Gates

`bun install && bun run lint && bun test && bun run src/check.ts`, all exiting 0, and `uvx typos text/` exits 0.

## Stop conditions

`3.0.0-draft.2` does not exist (`gh release view 3.0.0-draft.2 -R nemarOrg/biosig-zarr` fails);
the branch head is not b49245f2 or a descendant of it with only reviewed commits;
a change beyond Scope seems needed.

## Report

Your final message is the report, at most 25 lines: PR number and the new head commit hash; gates run with their quoted last lines; each changed line, briefly; deviations from this card; questions for the owner.
