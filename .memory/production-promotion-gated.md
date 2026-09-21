---
name: production-promotion-gated
description: As of 2026-09-17 both NEMAR and OSA production pushes are deliberately held until other sessions' work consolidates and OSA issue 360 lands
metadata:
  node_type: memory
  type: project
---

Yahya is holding BOTH production promotions until two conditions are met:
1. the work from other parallel sessions is consolidated on `nemar-cli`, and
2. OSA's move to the Claude Platform on AWS (OSA issue #360) completes.

Then nemar-cli `dev` -> `main` and OSA's release go together.

Queued behind that gate:
- **nemar-cli**: `0.10.4` -> `0.10.5`, and the queue keeps growing. It was 4 PRs (#1428, #1429,
  #1439, #1442), taking the MCP `search_datasets` surface from 6 parameters to 33, capped at 20
  per call. Since 2026-09-17 it also carries epic #1430 (#1446: the anonymous fixture moves to a
  reserved `nm` id and the id map becomes a rule) and phase 5 (#1448).
  Two consequences of the hold that are easy to misread as bugs:
  (a) production still runs the OLD webhook fence (`isDevRangeDatasetId`, `xx09NNNN` only), so
  every push to `nemarDatasets/nm099998` lands on the PROD worker, is not mirrored to dev, and
  dispatches a doomed enrichment run for a dataset prod has no row for. Expected until the
  promotion, not a sign the fixture is broken.
  (b) #1447's fix (an anonymous release keeps its manifest) is dev-only until then, so a real
  anonymous deposit in PRODUCTION still lands with no manifest and no `dataset_versions` row.
- **OSA #370**: rewrite the NEMAR assistant config for that surface. MUST ship WITH the nemar-cli
  promotion, never before or after: the prompt currently teaches the 6 filters production serves,
  and either half alone recreates the `modality_filter` class of bug from one side.
- **OSA #380** (merged to `develop` 2026-09-17): release images. Its effect starts only once it is
  on `main`, because GitHub reads a workflow's triggers from the default branch. The next release
  bootstraps it by itself, and is the first to publish versioned images and move `:latest`.

Until that release, production OSA serves the `0.8.9.dev0` image while `main` says `0.8.9`, and
`gh workflow run docker-build.yml --ref v0.8.9` cannot fix it (422: the trigger is not on `main`
yet, and the v0.8.9 tag's own workflow gates `:latest` on `is_default_branch`, false for a tag).

**Why:** "promote when in good product shape" is a deliberate sequencing choice, not an oversight;
do not offer to promote either side before both conditions hold.

**How to apply:** check #360 and the state of `nemar-cli` `dev` before proposing any production
push. Related: [[osa-nemar-assistant-state]], [[release-pr-needs-own-review]],
[[osa-checkout-parked-on-feature-branch]].
