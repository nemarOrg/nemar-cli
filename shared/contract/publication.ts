/**
 * Publication wire-shape vocabulary (#1255, epic #1250).
 *
 * The two enums here were each hand-duplicated in a backend module and again
 * in the CLI client, which is how a value gets added on one side only. They
 * follow the same pattern as `zarr_status` / `attestation_*` in dataset.ts:
 * declared once in Zod, consumed as a type by both halves.
 *
 * Zero deps beyond zod (extraction-ready for @nemar/contract).
 */

import { z } from "zod";

/**
 * ORCID iD: four groups of four digits, last character may be X (checksum).
 *
 * ONE definition (#1255 review item 11). It was previously spelled out
 * separately in the CLI, in the signup schema, in the ORCID service, and not
 * at all in the admin test-fixture route, which checked only `max(19)` and so
 * accepted any 19-character string as an iD.
 */
export const ORCID_ID_PATTERN = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

/** Zod form of {@link ORCID_ID_PATTERN}, with the message users see. */
export const orcidIdSchema = z
  .string()
  .regex(ORCID_ID_PATTERN, "ORCID must be in format 0000-0000-0000-000X");

/**
 * What a public ORCID record lookup produced.
 *
 * `no_public_name` and `lookup_failed` are kept apart for the same reason
 * {@link backfillNameOutcomeSchema} keeps them apart: one is a settled fact
 * about the record and the other is a transient failure, and the advice a
 * user needs differs.
 */
export const orcidNameLookupStatusSchema = z.enum(["found", "no_public_name", "lookup_failed"]);
export type OrcidNameLookupStatus = z.infer<typeof orcidNameLookupStatusSchema>;

/**
 * Why a publication request is blocked (`publication_requests.block_reason`).
 *
 * The column itself is free TEXT (migration 0015) and holds legacy values, so
 * this is the vocabulary a CURRENT backend writes, not a database constraint.
 * Readers must therefore degrade gracefully on an unrecognised value rather
 * than narrow to this union and drop the row -- which is exactly what the
 * backend's BLOCK_MESSAGES lookup does (falling back to a generic sentence)
 * and what the website's admin queue does (rendering the raw code).
 */
export const publicationBlockReasonSchema = z.enum([
  "bids_validation_failed",
  "bids_validation_pending",
  "bids_validation_in_progress",
  /** Legacy: the pre-screen stopped blocking in #756. */
  "prescreen_failed",
  "min_requirements_failed",
  /** #1255: the owner has no researcher name, so a DOI cannot cite them. */
  "owner_name_missing",
]);
export type PublicationBlockReason = z.infer<typeof publicationBlockReasonSchema>;

/**
 * Per-user outcome of `POST /admin/users/backfill-names` (#1255).
 *
 * `no_public_name` and `lookup_failed` are deliberately distinct: the first is
 * a settled fact about the ORCID record (the owner must act), the second is a
 * transient infrastructure failure (retry the batch). Collapsing them would
 * tell an operator to chase a user over a 503.
 */
export const backfillNameOutcomeSchema = z.enum([
  "filled",
  "would_fill",
  "no_public_name",
  "lookup_failed",
]);
export type BackfillNameOutcome = z.infer<typeof backfillNameOutcomeSchema>;
