/**
 * Ordered publication-orchestrator step list, shared by the backend
 * orchestrator and the CLI's progress display. Single source of truth:
 * the two sides previously kept hand-mirrored copies and drifted (#904).
 *
 * This file has ZERO dependencies so it can be imported from any context.
 */

/**
 * Steps execute in this order; completed steps are skipped on resume.
 */
export const PUBLICATION_STEPS = [
  "ci_check",
  "enrichment_check",
  // Flip S3 public as early as possible (epic #736, Phase 4 / #741): it is the
  // first mutation after the validation gates, so the bucket-policy change has
  // the most time to propagate before create_tag fires generate-archive.
  "s3_public_read",
  "repo_public",
  "tag_protect",
  "doi_create",
  "update_metadata",
  "update_readme",
  "create_tag",
  "create_release",
  "upload_to_zenodo",
  "publish_doi", // Permanent and irreversible!
  "version_doi",
  "s3_lock",
  "sync_nemar",
  "notify_user",
] as const;

export type PublicationStep = (typeof PUBLICATION_STEPS)[number];
