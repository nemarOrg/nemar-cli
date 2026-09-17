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
 * `version_doi` is NOT in this list, and the reason is worth stating because
 * it was until #1447. It mints a per-version DOI, which for a concealed
 * deposit must not resolve, so dropping the whole step looked correct. But the
 * same step is the ONLY thing that dispatches the central manifest job, whose
 * callback inserts the `dataset_versions` row; skipping it left every
 * anonymous release with no manifest and no version, the data plane answering
 * "Version not published" for a dataset the release had just made public, and
 * the dataset missing from the catalog listing. The step now runs and mints
 * the identifier RESERVED (`createEzidVersionDoi`'s `reserveOnly`), which is
 * the same state `doi_create` leaves the concept DOI in: registered, not
 * advertised, not harvested, and completed by the publication that ends the
 * anonymity. `latest_version_doi` stays NULL, because that column means the
 * version DOI that is published.
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
] as const;

/** The steps an anonymous release runs, in the same order as a publication. */
export const ANONYMOUS_RELEASE_STEPS: readonly PublicationStep[] = PUBLICATION_STEPS.filter(
  (s) => !ANONYMOUS_RELEASE_SKIPPED_STEPS.includes(s),
);

/**
 * The steps an approval will actually run, given whether the pending request
 * asked for an anonymous release.
 *
 * One rule, so the CLI cannot describe a different publication from the one the
 * backend performs. Before #1447 the approve confirmation and
 * `nemar dataset publish status` both rendered `PUBLICATION_STEPS`
 * unconditionally, so an admin approving an anonymous release was shown a
 * 16-step plan including "Publish DOI (irreversible)" and "Make repo public",
 * and then watched it stop at 11 of 16 forever -- 11 because the skip list held
 * five steps when that was measured; it holds four now that `version_doi` is
 * back. Neither line is what happens: the repository stays private and no
 * identifier is published. The live progress
 * renderer had it right, because the backend tells it the real step set.
 */
export function stepsForRelease(anonymous: boolean): readonly PublicationStep[] {
  return anonymous ? ANONYMOUS_RELEASE_STEPS : PUBLICATION_STEPS;
}

/**
 * Human labels for the step list, as a total map so adding a step to
 * `PUBLICATION_STEPS` without labeling it is a compile error. The alternative,
 * a positional literal, is what the approve banner used: a hand-numbered
 * two-column block that had to be re-typed whenever the step list changed and
 * silently described the wrong publication when it was not.
 */
export const PUBLICATION_STEP_LABELS: Record<PublicationStep, string> = {
  ci_check: "Check CI",
  enrichment_check: "Enrichment check",
  s3_public_read: "S3 public read",
  repo_public: "Make catalog row public",
  tag_protect: "Tag protection",
  doi_create: "Create DOI",
  update_metadata: "Update metadata",
  update_readme: "Update README",
  create_tag: "Create version tag",
  create_release: "Create GitHub release",
  upload_to_zenodo: "Upload to Zenodo (no-op)",
  publish_doi: "Publish DOI (irreversible)",
  version_doi: "Version DOI + manifest",
  s3_lock: "S3 Object Lock",
  sync_nemar: "Sync NEMAR (no-op)",
  notify_user: "Notify user",
};
