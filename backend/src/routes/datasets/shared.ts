/**
 * Shared plumbing for the routes/datasets/* concern files (#906, epic #902).
 *
 * extractRepoName moved verbatim from routes/datasets.ts; the only
 * intentional change is the `export` keyword (it is used by the
 * collaborators, publication, and manifests concern files).
 */

import type { Hono } from "hono";
import type { Bindings, Variables } from "../../types/bindings";

/**
 * The one datasets router every concern file registers onto. A single
 * router instance (rather than mounted sub-routers) keeps routing semantics
 * identical to the pre-split monolithic datasets.ts. Register functions
 * must call datasetRoutes.get/post/... directly; do not mount a sub-app via
 * .route(), which has its own basePath/precedence semantics.
 */
export type DatasetsRouter = Hono<{ Bindings: Bindings; Variables: Variables }>;

/**
 * Extract repository name from github_repo format "org/repo"
 * Returns null if format is invalid
 */
export function extractRepoName(githubRepo: string): string | null {
  if (!githubRepo || !githubRepo.includes("/")) {
    return null;
  }
  const parts = githubRepo.split("/");
  if (parts.length !== 2 || !parts[1]) {
    return null;
  }
  return parts[1];
}
