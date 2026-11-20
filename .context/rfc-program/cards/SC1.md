# Card SC1: The Store Contract states the version 3 NEMAR profile choices

Status: ready
Tier: lead
Timebox: S, 4 hours; escalate at 8 hours or two failed approaches
Needs: none
Depends: B6 done and O4b done (the version 3 text is tagged `3.0.0-draft.1`); Q29 answered ("Both now", 2026-11-20)
Branch: docs/store-contract-v3-profile
Worktree: /Users/yahya/Documents/git/nemar/docs-worktrees/rfc-store-contract-v3
Plan: /Users/yahya/Documents/git/nemar/nemar-cli-worktrees/rfc-program/.context/rfc-program/plan.md, section 4 (proposal P2)

## Goal

docs.nemar.org's `/platform/zarr/store-contract/` states the choices NEMAR's profile is proposed to make for format version 3,
marked plainly as what NEMAR will do when version 3 rolls out after RFC-0001 is accepted, not as current behavior,
so the Store Contract, which the version 3 text names as authoritative for NEMAR's stores, and the text's NEMAR profile section say the same thing (Q29).

## Context

Q29 (owner, 2026-11-20): the version 3 NEMAR profile choices live in the specification's profile section and in the docs Store Contract now, both.
Read first:
"The NEMAR profile" in `spec/index.md` at tag `3.0.0-draft.1` of nemarOrg/biosig-zarr (`gh api "repos/nemarOrg/biosig-zarr/contents/spec/index.md?ref=3.0.0-draft.1" -H "Accept: application/vnd.github.raw"`), its last list of six bullets;
the owner's rulings D4 to D7, D11 and D12 in `/Users/yahya/Documents/git/nemar/nemar-cli-worktrees/rfc-program/.context/rfc-program/board-log.md` Decisions;
`src/content/docs/platform/zarr/store-contract.md` and `src/content/docs/platform/zarr/format-stability.md` in nemarOrg/docs;
`/Users/yahya/Documents/git/nemar/nemar-cli/.rules/docs-site.md`.
Create the worktree with `git -C /Users/yahya/Documents/git/nemar/docs fetch origin && git -C /Users/yahya/Documents/git/nemar/docs worktree add /Users/yahya/Documents/git/nemar/docs-worktrees/rfc-store-contract-v3 -b docs/store-contract-v3-profile origin/main`, then `bun install`.
The owner merges this PR, or authorizes the manager to merge it, per pull request (runbook, "Never").

## Scope

`src/content/docs/platform/zarr/store-contract.md` only.

## Decided design

Settled:

- A new section, `## Format version 3: what NEMAR will do`, placed just before `## Format version`, opening with a `:::caution` aside that says, in substance:
  these are proposals in NEMAR RFC 0001; NEMAR serves format version 2 today, and nothing in this section describes a store that exists;
  they take effect only when version 3 rolls out, after RFC-0001 is accepted; until then the rest of this page describes what NEMAR serves.
- The section lists the six choices of the specification's NEMAR profile section, each in plain words, in the specification's own order, so the two can be compared line by line:
  1. uniform groups and the `values` of timestamped groups are stored as `int16`, and every signal array declares its missing value (rulings D4 and D6);
  2. a stream with jittered timing is kept as measured, in a timestamped group, and regularized only on request, with the timing error recorded (D5);
  3. an epoched source, which holds only cut trials, is refused for now, and RFC-0001 asks the community about it (D12);
  4. whether NEMAR's writer makes bit-exact copies is decided after measuring how many recordings qualify (D7);
  5. the dataset's `index.json` does not list a timestamped group among a recording's groups until the index schema carries the group's `kind`;
  6. NEMAR keys no derived result on a version 3 store until a second definition of its store content digest exists; the digest is NEMAR's machinery, not part of the format (D11).
- It links the specification's profile section at the tag `3.0.0-draft.1`, `https://github.com/nemarOrg/biosig-zarr/blob/3.0.0-draft.1/spec/index.md#the-nemar-profile`, which exists now; the section is the same at `3.0.0-draft.2`, because card B5 changes no line of it, so the link stays valid and needs no update when that tag is made; and the RFC repository, `https://github.com/nemarOrg/rfcs`; it does not copy the specification's text (one canonical copy).
- It says that every NEMAR reader refuses a store whose `format_version` is above 2 before any version 3 store is served (plan section 3, lead decision 9).
- The Note's first sentence, "The fields below describe current v3 stores", becomes unambiguous: it means Zarr version 3 stores at format version 2, and the edit says so.
- Records are cited by content, not by number: no new bare "ADR" appears (the docs policy-hygiene test bans it on policy pages, and this page follows the same rule for new text).

The implementer may choose: wording, and the order of sentences within the aside.

## Acceptance

`bun run build` exits 0, and `dist/` contains the page for `platform/zarr/store-contract`.
`git diff --name-only origin/main...HEAD` prints only `src/content/docs/platform/zarr/store-contract.md`.
`grep -c "## Format version 3: what NEMAR will do" src/content/docs/platform/zarr/store-contract.md` prints 1.
`grep -c "3.0.0-draft.1/spec/index.md#the-nemar-profile" src/content/docs/platform/zarr/store-contract.md` prints at least 1.
`grep -c "RFC-0001\|RFC 0001" src/content/docs/platform/zarr/store-contract.md` prints at least 1.
`git diff origin/main...HEAD | grep "^+" | grep -c "\bADR\b"` prints 0.
`grep -c "current v3 stores" src/content/docs/platform/zarr/store-contract.md` prints 0.

## Gates

`bun install && bun run build && bun test`, all exiting 0.

## Stop conditions

The profile section at the tag differs from the six bullets above (report the difference; the specification wins and the lead changes this card);
the build's admin-gating or draft-policy check refuses the page;
a choice can only be stated by copying normative text from the specification.

## Report

Your final message is the report, at most 25 lines: PR number (base `main` of nemarOrg/docs) and head commit hash; gates run with their quoted last lines; the new section's first lines, quoted; deviations from this card; questions for the lead and the owner.
