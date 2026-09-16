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

/**
 * Steps an ANONYMOUS release does not run (#1408, epic #1406).
 *
 * An anonymous release makes the DATA public while the depositor stays
 * concealed, so it is the ordinary publication minus every step whose whole
 * effect is to expose identity:
 *
 *   publish_doi      Makes the DOI public and therefore harvested. It is
 *                    marked "permanent and irreversible" in the list above for
 *                    good reason -- DataCite records are snapshotted, so this
 *                    is the one step that could not be undone at acceptance.
 *                    The identifier stays `reserved`, which is what ADR 0065's
 *                    A6 requires and what makes the deposit citable by its
 *                    landing page rather than by a public record.
 *   version_doi      Mints and publishes a per-version DOI, same exposure.
 *   upload_to_zenodo Zenodo's `creators` field is mandatory, so there is no
 *                    unattributed form; `createZenodoConceptDoi` refuses an
 *                    anonymous deposit outright rather than deposit a name.
 *   update_metadata  Writes `DatasetDOI` into `dataset_description.json`,
 *                    which is git-tracked and served publicly by the data
 *                    plane (#1403). Advertising a reserved identifier is what
 *                    the release exists to avoid: a reader, or the depositor
 *                    mid-submission, would cite a DOI that does not resolve.
 *   update_readme    Same identifier, worse placement: a DOI badge on the
 *                    README the dataset page renders, linking to a doi.org URL
 *                    that 404s.
 *
 * Those last two are DEFERRED, not dropped. `doi_create` still runs, so the
 * identifier is reserved for the dataset from the start and the same one is
 * activated at publication (`stepDoiCreate` is guarded by
 * `if (!dataset.concept_doi)`); the publication that ends anonymity runs both
 * steps then, when the DOI is real and the attribution is restored.
 *
 * `repo_public` deliberately STAYS: it is the step that flips the catalog row
 * to public, which an anonymous release needs. It keeps the GitHub repository
 * private via `expectedRepoVisibility`, so the step's name is now narrower
 * than what it does.
 */
export const ANONYMOUS_RELEASE_SKIPPED_STEPS: readonly PublicationStep[] = [
  "update_metadata",
  "update_readme",
  "upload_to_zenodo",
  "publish_doi",
  "version_doi",
] as const;

/** The steps an anonymous release runs, in the same order as a publication. */
export const ANONYMOUS_RELEASE_STEPS: readonly PublicationStep[] = PUBLICATION_STEPS.filter(
  (s) => !ANONYMOUS_RELEASE_SKIPPED_STEPS.includes(s),
);
