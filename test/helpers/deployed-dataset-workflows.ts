/**
 * Where the deployed nemarDatasets/.github workflows are, for the tests that read them.
 *
 * `NEMAR_DATASET_WORKFLOW_LIVE` names the deployed `onboard-openneuro.yml`; CI sets it to the
 * sparse checkout the `unit-pure` job makes (relative values resolve against the repo root).
 * Unset, a sibling checkout of nemarDatasets/.github is looked for instead. Other deployed
 * workflows that are not authored here (`approve-publication.yml`) are read from the same
 * directory, so every test that uses this skips exactly when the onboarding parity test does.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** Set by the `unit-pure` job to the sparse checkout it made. */
export const LIVE_ENV_VAR = "NEMAR_DATASET_WORKFLOW_LIVE";
export const declaredRaw = process.env[LIVE_ENV_VAR];

/** The declared deployed onboarding copy, or null when the variable is unset or blank. */
export const DECLARED_PATH =
  declaredRaw && declaredRaw.trim() !== ""
    ? isAbsolute(declaredRaw)
      ? declaredRaw
      : join(REPO_ROOT, declaredRaw)
    : null;

/**
 * Where a `.github` checkout is likely to sit for a developer.
 *
 * This repo is usually a WORKTREE (`epic-import-observability/`, `skew-fix/`, ...)
 * rather than `nemar-cli/` itself, so the search is relative to the repo root
 * whatever it is called. Only consulted when the variable is unset.
 */
export const SIBLING_CANDIDATES = [
  join(REPO_ROOT, "..", ".github", ".github", "workflows", "onboard-openneuro.yml"),
  join(REPO_ROOT, "..", "dot-github", ".github", "workflows", "onboard-openneuro.yml"),
  join(REPO_ROOT, "..", "..", ".github", ".github", "workflows", "onboard-openneuro.yml"),
];

/** The deployed `onboard-openneuro.yml`, or null when there is no checkout to read. */
export const DEPLOYED_ONBOARD: string | null =
  DECLARED_PATH ?? SIBLING_CANDIDATES.find((p) => existsSync(p)) ?? null;

/** Another deployed workflow, beside the onboarding copy; null exactly when that is null. */
export const deployedWorkflow = (name: string): string | null =>
  DEPLOYED_ONBOARD === null ? null : join(dirname(DEPLOYED_ONBOARD), name);
