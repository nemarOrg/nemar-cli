---
name: issue-comment-wording-copied-into-five-places
description: a wording error in an issue comment was copied into five places before anyone checked it against the design; verify wording against the design before repeating it
metadata:
  type: feedback
  recorded: 2026-11-04
  revalidate_after: 2027-02-04
---

A sentence in an issue comment (the plan for a phase) said something slightly different from the design it summarised.
It was copied into five places because each copy was taken from the comment rather than from the design.
Found during the compute program (2026-11).

This is the rule in `.rules/documentation.md`, "A claim in a plan is a claim in the code", with another source: not only an approved plan file but an issue comment, which reads like settled fact because it is short.

**What to do:**

- Before repeating a sentence from an issue comment in a brief, a comment, an ADR or a commit message, find the sentence in the design (or the code) it summarises and compare the wording, not only the meaning.
- When it differs, fix the comment at its source first, then copy.
- When a reviewer finds one copy of a wrong sentence, grep for its distinctive words across the change before fixing only that copy.
