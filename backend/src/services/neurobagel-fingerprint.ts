/**
 * Fingerprints of a dataset's Neurobagel artifact set (epic #1586, phase 4).
 *
 * The fingerprint is DERIVED, never a column (ADR 0034): it is a hash of everything
 * the artifacts depend on, stored only as R2 custom metadata on the artifacts it
 * describes. Two runs over unchanged inputs compute the same value and the writer
 * writes nothing.
 *
 * Three layers, because the cheap ones let a run find work without doing it:
 *
 *   signature    D1 only, one query for ALL eligible datasets: the row's name,
 *                subject count, license, the LENGTH of its enrichment document,
 *                its latest version, the transform version, the pinned vocabulary,
 *                the curation entry's hash. A mismatch means "probably stale".
 *   row fp       D1 only, one dataset: the same fields, but with a hash of the
 *                whole enrichment document instead of its length.
 *   fingerprint  the row fingerprint plus the manifest's ETag (one S3 HEAD): the
 *                value that decides whether anything is rewritten.
 *
 * Inputs the transform reads, and where they come from: `metadata.json` (the
 * row's name, license, subject count, enrichment authors and keywords, concept DOI
 * blinded for an anonymous deposit, the latest version, and the BIDS index that is
 * a digest of the manifest), `participants.tsv` and `participants.json` (git-tracked
 * files named by the manifest). A manifest is rewritten in place, so its ETag
 * moves whenever any of those files can have.
 *
 * What the fingerprint cannot see: a change of the data plane's own metadata
 * builder (a new field, a corrected digest) leaves every ETag and row as it was.
 * `WRITER_REVISION` is the manual knob for that, and the admin `regenerate` route
 * has `force`. Say so here rather than let the next reader assume it is automatic.
 */

import { canonicalJson } from "../../../shared/neurobagel/canonical-json.js";
import { NEUROBAGEL_TRANSFORM_VERSION } from "../../../shared/neurobagel/version.js";
import { VOCAB } from "../../../shared/neurobagel/vocab.js";
import { sha256OfBytes } from "./neurobagel-store.js";

/**
 * Bump when HOW the writer gathers or stores changes what a dataset's artifacts
 * hold for the same row and manifest (for example, a change to the data plane's
 * `metadata.json` builder that the transform reads). It marks every dataset stale.
 */
export const NEUROBAGEL_WRITER_REVISION = 1;

/** What the transform and the pinned vocabulary contribute, the same for every dataset. */
export interface TransformIdentity {
  writer: number;
  transform: number;
  vocab_communities: string;
  vocab_bagel: string;
}

export function transformIdentity(): TransformIdentity {
  return {
    writer: NEUROBAGEL_WRITER_REVISION,
    transform: NEUROBAGEL_TRANSFORM_VERSION,
    vocab_communities: VOCAB.pins.communities.commit,
    vocab_bagel: VOCAB.bagel_version,
  };
}

/** The D1 fields every layer is built from. `concept_doi` is ONLY the blinded projection. */
export interface RowFingerprintFields {
  dataset_id: string;
  name: string | null;
  subject_count: number | null;
  license: string | null;
  /** `CASE WHEN d.anonymous = 1 THEN NULL ELSE d.concept_doi END` (CONCEPT_DOI_SQL). */
  concept_doi: string | null;
  latest_version: string | null;
}

/** Hex SHA-256 of a string's UTF-8 bytes: the store's one digest, over text. */
export function sha256Hex(text: string): Promise<string> {
  return sha256OfBytes(new TextEncoder().encode(text));
}

type Json = Parameters<typeof canonicalJson>[0];

function canonical(value: unknown): string {
  return canonicalJson(value as Json);
}

/** Cheap signature: every eligible dataset in one query, no enrichment document read. */
export async function cheapSignature(
  row: RowFingerprintFields,
  enrichmentLength: number,
  curationHash: string | null,
  identity: TransformIdentity = transformIdentity(),
): Promise<string> {
  return `sha256:${await sha256Hex(
    canonical({
      fields: row,
      enrichment_length: enrichmentLength,
      curation: curationHash,
      identity,
    }),
  )}`;
}

/** Row fingerprint: one dataset, the whole enrichment document hashed. */
export async function rowFingerprint(
  row: RowFingerprintFields,
  enrichmentSha256: string,
  curationHash: string | null,
  identity: TransformIdentity = transformIdentity(),
): Promise<string> {
  return `sha256:${await sha256Hex(
    canonical({
      fields: row,
      enrichment_sha256: enrichmentSha256,
      curation: curationHash,
      identity,
    }),
  )}`;
}

/** The fingerprint that decides a rewrite: the row fingerprint plus the manifest's ETag. */
export async function inputFingerprint(rowFp: string, manifestEtag: string): Promise<string> {
  return `sha256:${await sha256Hex(canonical({ row: rowFp, manifest_etag: manifestEtag }))}`;
}
