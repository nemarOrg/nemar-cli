# Card B7b: draft/3.0.0 takes 2.0.2 in and drops NEMAR as decider

Status: ready
Tier: lead
Timebox: S, 3 hours; escalate at 6 hours or two failed approaches
Needs: none
Depends: B7 merged into `main` and O4e done (release `2.0.2` exists on B7's merge commit); Q39 to Q42 answered (see "Owner answers")
Branch: feature/b7b-independence-draft (base `draft/3.0.0`)
Worktree: /Users/yahya/Documents/git/nemar/biosig-zarr-worktrees/b7b
Plan: /Users/yahya/Documents/git/nemar/nemar-cli-worktrees/rfc-program/.context/rfc-program/plan.md, sections 2 (item 11), 4 and 5 (O4f)

## Goal

`draft/3.0.0` in nemarOrg/biosig-zarr holds everything `2.0.2` released (card B7), with its conflicts resolved,
and its draft-only text names the Neuroelectromagnetic Data Archive and Tools Resource (NEMAR) only as the text's origin, its first implementer and profile, and the host and RFC venue (Q40, Q41),
with no normative change to the proposal, ready to be tagged `3.0.0-draft.3` (step O4f).

## Context

The owner decided on 2026-11-20 (Q37/Q38) that biosig-zarr is independent of NEMAR; card B7 applied it on `main`, released as `2.0.2`.
`draft/3.0.0` was at ac6e3124 (B5's merge, tagged `3.0.0-draft.2`) when this card was written, and `main` at 3bd184a9 was already merged into it.
Read first: card B7 (`/Users/yahya/Documents/git/nemar/nemar-cli-worktrees/rfc-program/.context/rfc-program/cards/B7.md`), whose classes, `ALLOW` and `FORBID` this card reuses; B7's report, pasted under "Reports from dependencies"; and the owner answers Q39 to Q42, under "Owner answers" at the end of this card.
Then run `git -C /Users/yahya/Documents/git/nemar/biosig-zarr grep -n -i nemar origin/draft/3.0.0 -- spec schemas CHANGELOG.md conformance/README.md`.
Create the worktree with
`git -C /Users/yahya/Documents/git/nemar/biosig-zarr fetch origin --tags && git -C /Users/yahya/Documents/git/nemar/biosig-zarr worktree add /Users/yahya/Documents/git/nemar/biosig-zarr-worktrees/b7b -b feature/b7b-independence-draft origin/draft/3.0.0`,
then `bun install`.
Never check out a branch in the clone itself.
Every commit is signed off (`git commit -s`; the merge with `git merge --signoff`), Developer Certificate of Origin (Q8).
NEMAR profile sections stay: a profile may name its implementer.

## Scope

On the branch, in nemarOrg/biosig-zarr:
the merge of tag `2.0.2` (`git merge --no-ff --signoff 2.0.2`), with its conflict resolutions;
then `spec/index.md` lines 4, 8, 51 and 1150 (line numbers at ac6e3124), `CHANGELOG.md` (one new entry) and `spec/version-history.md` (rows).
Nothing else; no change to `schemas/`, `conformance/` or `tools/` beyond what the merge brings, and none is expected.

## Decided design

Settled:

- **The merge.** Merge the tag `2.0.2`, not `origin/main` (they are the same commit if nothing landed after O4e; if they differ, merge the tag).
  Expected conflicts are only `CHANGELOG.md` and `spec/version-history.md`.
  In `CHANGELOG.md`, newest first: the new `3.0.0-draft.3` entry, then `3.0.0-draft.2`, `3.0.0-draft.1`, `2.0.2`, `2.0.1`, `2.0.0`, each kept word for word as it is on its own branch (the draft entries are the history of published tags).
  In `spec/version-history.md`, keep both sides' rows: the format version rows from the draft, and every release row (`2.0.0`, `2.0.1`, `2.0.2`, `3.0.0-draft.1`), then add rows for `3.0.0-draft.2` and `3.0.0-draft.3`.
- **`spec/index.md` line 4** becomes, on one line: `> This document is the text proposed by the Request for Comments (RFC) RFC-0001, in [nemarOrg/rfcs](https://github.com/nemarOrg/rfcs).`
  (The text is proposed by the RFC, not by NEMAR.)
- **`spec/index.md` line 8**: "> For stores served by NEMAR," becomes "> For stores served by the Neuroelectromagnetic Data Archive and Tools Resource (NEMAR),", on one line, because line 4 no longer defines NEMAR and line 8 is now its first use.
- **`spec/index.md` line 51**: "separate from NEMAR's RFC process" becomes "separate from the Requests for Comments in nemarOrg/rfcs", on the same line.
- **`spec/index.md` line 1150**: "The packing rules are NEMAR's own." becomes "The packing rules are this specification's own."
  The next lines (RFC-9 is prior art, not a dependency, and later changes to RFC-9 do not change these rules) stay word for word: the owner decision 5 of 2026-11-20 (independence from RFC-9) is unchanged, and only the holder of the rules changes, by Q37/Q38.
- **Allowed, unchanged** (class 4 of card B7): lines 9 and 10 (the Store Contract binds NEMAR's served stores), 21, 118, 139 and 140, 632, 977 to 979, 1052 and `schemas/v3/defs.schema.json` (`nemar:sss`, a profile token), 1078 to 1084, the whole section "The NEMAR profile" (1111 to 1140), 1188, 1372, 1413, 1418, 1471, `conformance/README.md` (the venue), and `tools/vectors/build.py` (the address of its code).
- **Line count:** each reworded line stays one line, so `spec/index.md` keeps its line count and every line link into `3.0.0-draft.2` lands on the same text in `3.0.0-draft.3`.
- **`CHANGELOG.md` entry** `## Unreleased: 3.0.0-draft.3` on top: `2.0.2` merged in (independence, holder, ADR 0005); the four `spec/index.md` lines; "No normative change from `3.0.0-draft.2`."

The implementer may choose: the wording of the changelog entry and of the two version-history rows.

## Acceptance

In `/Users/yahya/Documents/git/nemar/biosig-zarr-worktrees/b7b`, with `ALLOW` and `FORBID` set exactly as in card B7's Acceptance, plus `nemar:sss|NEMAR.s version 2 stores|NEMAR.s writer|NEMAR.s dataset index` appended to `ALLOW`, each of these prints nothing:

```bash
git grep -n -i nemar HEAD -- . ':(exclude)conformance/stores' ':(exclude).context/decisions/000[1-5]-*' ':(exclude)CHANGELOG.md' ':(exclude)conformance/SOURCES.md' ':(exclude)tools' ':(exclude)_typos.toml' ':(exclude)package.json' | grep -v -E "$ALLOW"
git grep -n -E "$FORBID" HEAD -- . ':(exclude).context/decisions/000[1-4]-*' ':(exclude)CHANGELOG.md'
git diff 3.0.0-draft.2...HEAD -- CHANGELOG.md | grep '^+' | grep -E "$FORBID"
git diff --name-only 2.0.2 HEAD -- LICENSE.md GOVERNANCE.md README.md CONTRIBUTING.md CITATION.cff AGENTS.md .rules .context/decisions
git diff --name-only 3.0.0-draft.2 HEAD -- schemas conformance tools
git log --no-merges --format='%h %(trailers:key=Signed-off-by,separator=%x2C )' origin/draft/3.0.0..HEAD | grep -v 'Signed-off-by:'
git log --first-parent --merges --format='%h %(trailers:key=Signed-off-by,separator=%x2C )' origin/draft/3.0.0..HEAD | grep -v 'Signed-off-by:'
```

And:
`git merge-base --is-ancestor 2.0.2 HEAD` exits 0;
`test "$(git show 3.0.0-draft.2:spec/index.md | wc -l)" = "$(wc -l < spec/index.md)"` exits 0;
`git diff 3.0.0-draft.2 HEAD -- spec/index.md | grep -c '^[-+][^-+]'` prints 8 (four lines out, four in, at lines 4, 8, 51 and 1150);
`grep -n "Neuroelectromagnetic Data Archive and Tools Resource (NEMAR)" spec/index.md | head -1 | cut -d: -f1` prints 8, and `grep -n NEMAR spec/index.md | head -1 | cut -d: -f1` prints 8 (case-sensitive, so `nemarOrg/rfcs` on line 4 does not count);
`grep -c "^## Unreleased: 3.0.0-draft.3" CHANGELOG.md` prints 1;
`grep -c "^Copyright (c) 2026 the biosig-zarr contributors\.$" LICENSE.md` prints 1.
The PR's checks (`gh pr checks PR -R nemarOrg/biosig-zarr`, with the PR number) all pass, including `links` and the conformance workflow.

## Gates

`uvx typos . && bun install && bun run lint && bun run check:schemas && bun test tools`, all exiting 0;
and `uv run --project tools/vectors --locked pytest tools/vectors -q` exits 0.

## Stop conditions

`2.0.2` does not exist (`gh release view 2.0.2 -R nemarOrg/biosig-zarr` fails);
`origin/draft/3.0.0` has moved past ac6e3124 with commits this card does not know;
the merge conflicts in a file other than `CHANGELOG.md` and `spec/version-history.md`;
a NEMAR mention in draft-only text fits none of card B7's classes;
any change would alter what a conforming writer or reader must do;
the answers under "Owner answers" differ from what this card states (the lead rewrites the card).

## Report

Your final message is the report, at most 25 lines: PR number and head commit hash; the merge commit hash; gates and acceptance commands run, with their quoted last lines; each conflict and its resolution; the four changed `spec/index.md` lines as merged; deviations from this card; questions for the owner; patch notes for B4c (anything RFC-0001 quotes or links that moved).

## Owner answers

Answered 2026-11-20 (owner, relayed by the manager): Q39 A, the editor is Seyed Yahya Shirazi in a personal capacity, and the rewording is ruled editorial;
Q40 A, the venue stays nemarOrg/rfcs, the specification's editor decides, and RFC-0001 stays "NEMAR RFC 0001";
Q41 A, the repository stays in nemarOrg, as hosting only;
Q42 A, release DOIs are issued through nemar-doi as a registration service (Q14 stands).
