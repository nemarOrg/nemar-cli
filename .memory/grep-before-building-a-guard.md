---
name: grep-before-building-a-guard
description: Before adding a guard, helper or test harness, grep for one; nemar-cli usually already has it and mine was weaker
metadata:
  node_type: memory
  type: feedback
---

Twice in nemar-cli #1442 I built something the repo already had, and both times the existing one was better.

- I flagged a D1 bound-parameter ceiling as unguarded and designed headroom in front of it.
  `assertBoundParamBudget` / `MAX_BOUND_PARAMS` already sat inside `buildDatasetFilterClauses`
  (`backend/src/services/dataset-filters.ts`), added after #1193 shipped a faceted search that 500'd
  only on D1. The risk I described could not happen. The cap was still worth having, but for a
  different reason (WHERE the refusal lands), and the doc comment I first wrote taught a wrong model.
- I wrote a "tripwire" D1 binding whose `prepare`/`batch` throw, to prove the tool reached the
  database, and spent six lines of comment arguing it was not a mock. `backend/test/helpers/d1.ts`
  already has `freshDb()` + `realD1()`: every migration applied to in-memory bun:sqlite, production
  SQL, no canned responses. `facet-filters-route.test.ts` already drives this exact filter surface
  through it. Switching let the test assert the rows that came back instead of a boolean.

**Why:** in a repo this old, the question "does a guard for this exist" almost always has a yes, and
the existing one encodes an incident I have not read about. Building a parallel one splits the
invariant across two mechanisms and states a rationale that is wrong about the codebase.

**How to apply:** before writing a guard, a limit, or test scaffolding, grep the service module that
would own it and `backend/test/helpers/`. If a comment has to argue at length that what I wrote is
acceptable, that is the signal a real alternative exists. Related:
[[generate-the-prose-not-just-the-names]], [[make-vs-take-decision-test]], [[retest-a-filed-diagnosis]].
