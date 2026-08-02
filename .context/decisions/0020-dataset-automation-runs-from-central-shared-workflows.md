# ADR 0020: Dataset automation runs from central shared workflows, not per-repo copies

**Status:** accepted
**Date:** 2026-05 (backfilled 2026-07-31)
**Owner:** Seyed Yahya Shirazi

## Context

Each dataset repo originally carried its own copies of the automation workflows (manifest generation, archive build, validation). With hundreds of datasets that meant hundreds of copies of the same file: a fix had to be redeployed to every repo, and repos drifted to whatever version they were created with. Separately, manifest generation walked the repo through the GitHub API one pointer at a time, and Actions minutes billed against the Free-plan tooling org rather than the Team-plan dataset org.

## Decision

Automation lives as **central shared workflows in `nemarDatasets/.github`**, invoked per dataset via `repository_dispatch` with a `client_payload`, and reports back to the Worker over an authenticated callback (`X-Webhook-Token`, an HMAC over `{dataset_id, version, nonce}`). Manifest generation walks the **git tree** instead of calling the API per pointer, so the path makes zero GitHub API calls. Cutovers are staged behind a Worker feature flag (`MANIFEST_VIA_CENTRAL_WORKFLOW`), dev first, then production.

Actions minutes bill against `nemarDatasets` (GitHub Team) rather than the constrained Free-plan tooling org.

## Consequences

- One place to fix a workflow, and every dataset picks it up on its next dispatch. No redeployment, no drift.
- **The blast radius is now repo-wide.** A bad edit reaches all ~785 datasets at once and is discovered whenever a dispatch next happens, not at review time. This is the direct cause of the defects in #1038, and why that repo needed its own CI (#1045).
- Secrets must live at the `nemarDatasets` **org** level with all-repos visibility so both the central `.github` repo and the dataset repos inherit them.
- The Worker no longer does the work inline, so completion is asynchronous and needs callback authentication, idempotency, and a stuck-job story.
- Feature-flagged cutovers mean two code paths coexist during rollout, which must be actively retired rather than left indefinitely.

## Alternatives considered

- **Per-repo workflow copies (the original):** self-contained per dataset, but unmaintainable at scale and drifted silently. Rejected.
- **Do the work inline in the Worker:** no dispatch or callback machinery, but Workers have CPU and wall-clock limits far below what a multi-gigabyte archive needs. Rejected.
- **Keep workflows in `nemarOrg/nemar-cli`:** co-located with the code, but bills Actions against the Free-plan org and puts dataset automation in the tooling repo. Rejected (#564).

## Receipts

- `.context/epic_central_manifest_state.md` — contracts, dispatch payload, callback shape
- #556, #557, #558, #559, #564
- #1045 (the CI this repo needed once it became shared infrastructure)
