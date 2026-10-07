---
name: dataset-workflow-is-byte-pinned
description: Editing .github/dataset-workflows/onboard-openneuro.yml turns the required unit-pure check red until the same bytes are deployed to nemarDatasets/.github
metadata:
  type: project
---

`.github/dataset-workflows/onboard-openneuro.yml` is authored here and deployed by copying it whole into `nemarDatasets/.github`. `test/dataset-workflow-parity.test.ts` compares the two byte for byte, and in the `unit-pure` job (a required check) `NEMAR_DATASET_WORKFLOW_LIVE` points it at a sparse checkout of the deployed copy, so any edit here fails CI until the org repository carries the same bytes. Verified 2026-10-06 while building ADR 0089: raising the finalize job's `timeout-minutes` in this copy alone would have failed the PR.

**How to apply:** a change that needs the onboard workflow to change ships as a pair, this repository's copy and a PR to `nemarDatasets/.github` merged together, which needs whoever may write that org. When that is not available, make the CLI fit the deployed workflow instead, and pin the assumption with a test: ADR 0089 cuts the screen wait to the deployed 90-minute timeout (`FINALIZE_JOB_TIMEOUT_MS`, pinned in `test/onboard-workflow.test.ts`).
