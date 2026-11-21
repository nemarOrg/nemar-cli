# Card B4c: RFC-0001 points at 3.0.0-draft.3, with the independence notice

Status: ready
Tier: lead
Timebox: S, 2 hours; escalate at 4 hours or two failed approaches
Needs: none
Depends: O4f done (pre-release `3.0.0-draft.3` exists), O4e done (release `2.0.2` exists), B4b done; Q39 to Q42 answered
Branch: rfc/0001-biosig-zarr (the open draft PR nemarOrg/rfcs#2; no new branch)
Worktree: /Users/yahya/Documents/git/nemar/rfcs
Plan: /Users/yahya/Documents/git/nemar/nemar-cli-worktrees/rfc-program/.context/rfc-program/plan.md, sections 2 and 4

## Goal

The RFC-0001 draft (nemarOrg/rfcs#2) names `3.0.0-draft.3` wherever it now names `3.0.0-draft.2`, compares against `2.0.2`,
carries the quoted-text notice with the holder "the biosig-zarr contributors",
and nowhere calls biosig-zarr NEMAR's or NEMAR its decider,
while every owner decision in `plan.md` section 2 keeps its force,
so the owner opens RFC-0001 on the tag that carries the independence (Q37/Q38).

## Context

The owner decided on 2026-11-20 (Q37/Q38) that biosig-zarr is independent of the Neuroelectromagnetic Data Archive and Tools Resource (NEMAR); cards B7 and B7b applied it, released as `2.0.2` and tagged `3.0.0-draft.3`.
B4b's review (one Sonnet reviewer, clean) held two suggestions for this card: name the RFC's own license, Creative Commons Attribution 4.0 International (CC BY 4.0) (Q6), at the notice (text line 100), and use a bare "W3C" at text line 717, where the abbreviation is already defined.
RFC-0001 stays "NEMAR RFC 0001" in nemarOrg/rfcs (Q40, option A), and NEMAR keeps its voice where it speaks as the archive that serves the stores and proposes the change ("we", "our stores", "NEMAR's profile"): an implementer may propose and may describe its own profile.
What changes is every line that makes the format, its packing rules or its decisions NEMAR's.
Read first: `text/0001-biosig-zarr.md` and the PR body at head 72098ada, the B7 and B7b reports pasted under "Reports from dependencies" (they give ADR 0005's file name), and the owner answers Q39 to Q42 pasted under "Owner answers".
Run `git -C /Users/yahya/Documents/git/nemar/rfcs fetch origin && git -C /Users/yahya/Documents/git/nemar/rfcs switch rfc/0001-biosig-zarr && git -C /Users/yahya/Documents/git/nemar/rfcs pull --ff-only` before editing.
The PR stays a draft, with `opened_at` null; nobody merges it until the owner opens the RFC.

## Scope

`text/0001-biosig-zarr.md`, the index lines in `README.md` that `rfc-check` regenerates, and the PR body (the opening post).

## Decided design

Settled (text line numbers at head 72098ada):

- **The tag.** Every `3.0.0-draft.2` becomes `3.0.0-draft.3` (lines 26, 56, 81, 82, 453, 950, 974 and 1004), and both comparison links become `2.0.2...3.0.0-draft.3` (lines 26 and 1004), so they show only what version 3 proposes.
  The quotations and their line links stay on tag `2.0.0`: `2.0.2` does not change `spec/index.md`.
  The vector count on lines 81 and 82 stays 20 unless B7b's report says otherwise.
- **The notice, lines 100 and 101**, exactly:

  ```text
  Quoted specification text in this RFC is Copyright (c) 2026 the biosig-zarr contributors and is under the World Wide Web Consortium (W3C) Software and Document License, not under this RFC's own license, Creative Commons Attribution 4.0 International (CC BY 4.0);
  the copyright notice and the text of the W3C Software and Document License are in [`LICENSE.md` at tag `2.0.2`](https://github.com/nemarOrg/biosig-zarr/blob/2.0.2/LICENSE.md), a release whose specification text is the `2.0.0` text unchanged.
  ```

- **Line 717**: "the World Wide Web Consortium (W3C) Software and Document License" becomes "the W3C Software and Document License".
- **After line 95** (end of "A store needs a contract that outlives one implementation"), one sentence:
  since 2026-11-20 the specification is independent of NEMAR; the copyright holder of its text is the biosig-zarr contributors, its editor decides under its `GOVERNANCE.md` (link at tag `2.0.2`), and NEMAR is where the text was first published and its first implementer (link to biosig-zarr ADR 0005 at tag `2.0.2`).
- **"Decided, and out of scope for comment"**: line 718 reads "the `.bzx` packing rules are the specification's own, not a dependency on OME-Zarr RFC-9", with its record unchanged (nemar-cli ADR 0131, Decisions 1 and 2);
  and one new row after it: "The specification is independent of NEMAR: the copyright holder of its text is the biosig-zarr contributors, its editor decides under its `GOVERNANCE.md`, and NEMAR is the text's origin and its first implementer." with the record "biosig-zarr ADR 0005; release `2.0.2`."
- **Line 510**: "This is decided (NEMAR, 2026-11-20)" becomes "This is decided (the specification's editor, 2026-11-20)"; the rule itself (every version 3 reader MUST read version 2 stores, Q28) is unchanged and stays closed.
- **Line 682**: "under NEMAR's own packing rules" becomes "under its own packing rules".
- **Lines 809 and 814**, in "Relation to OME-Zarr RFC-9": "Our packing rules are our own text" becomes "The packing rules are the specification's own text", and "NEMAR owns every future change to the packing rules" becomes "the specification carries every future change to the packing rules itself".
  Line 810, "We see that independence as an advantage.", stays word for word (owner decision 5: RFC-9 is prior art, not a dependency, and the RFC states that independence as an advantage).
- **Line 919**: "the owner of the NEMAR platform decides" becomes: the specification's editor decides, as its `GOVERNANCE.md` says, and is today also the owner who decides an organization RFC under `PROCESS.md`; the window and clock clauses of the line stay.
- **Line 951**, the release DOI, by the answer to Q42:
  option A: "The release gets a Digital Object Identifier (DOI) issued through nemar-doi, NEMAR's planned DOI service, which registers it and does not own it.";
  option B: "The release gets a Digital Object Identifier (DOI) from Zenodo, which archives the tagged release.";
  option C: "No Digital Object Identifier (DOI) is planned before the first beta release."
- **"History of the format"**: one row after line 973: `2, independent` | 2026-11-20 | "No change to stores or to the text. The specification became independent of NEMAR, with the biosig-zarr contributors as the copyright holder, and was released as `2.0.2`." | "biosig-zarr ADR 0005; release `2.0.2`."
- **"Change log"**: one line for 2026-11-20: points at `3.0.0-draft.3`, and the specification is independent of NEMAR (biosig-zarr ADR 0005).
- **The PR body**: the same tag, comparison, notice and DOI changes where it repeats them, and one line in its revision list for B4c; its history lines for B4 and B4b stay.
- Not changed: the title "NEMAR RFC 0001" and line 256 ("separate from NEMAR's RFCs"), because the venue is nemarOrg/rfcs (Q40, option A); every "NEMAR's profile", "NEMAR's readers", "NEMAR's own download command", "NEMAR's own code" and "NEMAR's content digest" line (the implementer); lines 42 and 964 (the origin); and every other line.

The implementer may choose: the wording of every sentence not given exactly above.

## Acceptance

On the branch, in `/Users/yahya/Documents/git/nemar/rfcs`, with `F=text/0001-biosig-zarr.md`:
`bun run src/check.ts` exits 0.
`grep -c "3.0.0-draft.3" $F` prints at least 8; `grep -c -E "3\.0\.0-draft\.[12]" $F` prints 0.
`grep -c "compare/2.0.2...3.0.0-draft.3" $F` prints 2, and `grep -c "compare/2.0.1" $F` prints 0.
`grep -c "Copyright (c) 2026 the biosig-zarr contributors" $F` prints 1, and `grep -c "NEMAR contributors" $F` prints 0.
`grep -c "Creative Commons Attribution 4.0 International (CC BY 4.0)" $F` prints 1, and `grep -c "World Wide Web Consortium (W3C)" $F` prints 1.
`grep -c "blob/2.0.2/LICENSE.md" $F` prints 1, and `grep -c "ADR 0005" $F` prints at least 3.
`grep -c -E "NEMAR.s own packing|Our packing rules|NEMAR owns|decided \(NEMAR|owner of the NEMAR platform decides" $F` prints 0.
`grep -c "We see that independence as an advantage." $F` prints 1.
For the Q42 answer: option A, `grep -c "nemar-doi" $F` prints 1; option B, `grep -c "Zenodo" $F` prints at least 1; option C, `grep -c "before the first beta release" $F` prints 1.
`gh pr view 2 -R nemarOrg/rfcs --json isDraft -q .isDraft` prints `true`;
`gh pr view 2 -R nemarOrg/rfcs --json body -q .body | grep -c "3.0.0-draft.3"` prints at least 1, and the same with `"NEMAR contributors"` prints 0.
`git diff --name-only 72098ada...HEAD` lists only `text/0001-biosig-zarr.md` and `README.md`.

## Gates

`bun install && bun run lint && bun test && bun run src/check.ts`, all exiting 0, and `uvx typos text/` exits 0.

## Stop conditions

`3.0.0-draft.3` or `2.0.2` does not exist (`gh release view 3.0.0-draft.3 -R nemarOrg/biosig-zarr` or `gh release view 2.0.2 -R nemarOrg/biosig-zarr` fails);
ADR 0005 is not at tag `2.0.2` under the file name B7's report gives;
the branch head is not 72098ada or a descendant of it with only reviewed commits;
an answer to Q39 or Q40 is not option A;
a change seems to weaken an owner decision in `plan.md` section 2, or to need a change beyond Scope.

## Report

Your final message is the report, at most 25 lines: PR number and the new head commit hash; gates run with their quoted last lines; each changed line, briefly; deviations from this card; questions for the owner.
