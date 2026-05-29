// Runtime feature flags for the backend (#646 dataset-store consolidation).

/**
 * #646 Phase 3 read flag. When "true", the list / search / page-bundle read
 * paths read from the `datasets` source of truth (single-table list, FTS5
 * lexical search, id-only Vectorize + D1 hydration) instead of the
 * nemar_catalog cache. Only the literal "true" enables it; anything else
 * (including undefined, "false", "1", "True") keeps the cache path. Mirrors
 * isCentralManifestWorkflowEnabled in routes/webhooks.ts.
 */
export function isReadFromDatasetsEnabled(env: { READ_FROM_DATASETS?: string }): boolean {
  return env.READ_FROM_DATASETS === "true";
}
