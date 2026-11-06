---
name: full-suite-80-minutes-and-three-baseline-failures
description: the full `bun test` takes about 80 minutes under load and has three known baseline failures on a developer machine, so a red full run is not by itself a regression and the full run is not a per-phase gate
metadata:
  type: project
  recorded: 2026-11-04
  revalidate_after: 2027-01-04
---

Measured on a developer machine under load, 2026-11-04: the full `bun test` from the repository root takes about 80 minutes.
An earlier entry (`.memory/bun-test-shared-process-root-and-backend.md`) recorded about 207 seconds in 2026-09; the suite has grown many times over since, so do not plan around the old figure.

Three failures are expected on such a machine, and none is caused by the change under test:

1. **`account-copy-parity`**, which compares the account copy and profile-gap files with a sibling `website` checkout (ADR 0045); it fails against that checkout on a developer machine.
2. **A test with a 5 second timeout** that is too tight when the machine is loaded.
3. **42 existing biome errors in untouched files**, reported by `bunx biome check backend/src shared src test`.
   `bun run lint` checks `src/` only, so it does not show them.

**What to do:**

- Do not run the full suite per phase, fix or review round; run the targeted set and the quick gates (`.rules/testing.md`, "Test cost"), and leave the full run to the epic -> `dev` CI run.
- Compare a red full run against these three before calling anything a regression; for biome, run it on the touched files only.
- If the baseline changes (a failure is fixed or a fourth appears), update this entry with the date.
