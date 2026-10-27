/**
 * The publish gate of an import's finalize, as three functions: the copied objects are verified at
 * their declared sizes (#967), every annexed key the TREE names must have an object (#1396), and
 * the tree's keys are registered at `nemar-s3` and proven from the location log (#1392).
 * `finalizeImport` calls them and owns its exits; an upstream re-pull's register step (ADR 0111)
 * calls the same three, so the two paths cannot drift.
 *
 * Each returns the line finalize prints, word for word as it printed it before these were
 * extracted: the Worker classifies the failures by their markers (`[nemar-data-unavailable]`) and
 * files the import-failure tracker from the text.
 */

import { batchSetKeysPresent } from "./git-annex/transfer.js";
import {
  type ImportManifestItem,
  MIN_DATA_AVAILABILITY,
  annexKeyDeclaredSize,
  dataAvailability,
  isKeyPresentAtDeclaredSize,
  isLocallyUploaded,
  keysWithoutObjects,
} from "./s3-server-copy.js";

/**
 * Marker for "NEMAR's bucket cannot back this dataset's data keys" (#1396).
 *
 * Deliberately NOT the upstream marker. At this point we know one thing: the
 * tree names keys the bucket has no object for. We do NOT know whether the
 * content is gone at source or whether our copy phase simply did not finish,
 * and filing the first without measuring it is the mistake ADR 0064 exists to
 * correct -- nine datasets were filed `upstream_403` that way and six of them
 * were fetchable the whole time.
 *
 * So this marker claims only the shortfall, and carries the availability figure
 * so the tracking issue can be triaged by severity rather than by guess: one key
 * of 65,063 and 935 of 935 are the same sentence without it. `admin fleet
 * content-recovery <id>` is the command that turns it into a verdict about
 * upstream.
 */
export const DATA_AVAILABILITY_MARKER = "[nemar-data-unavailable]";

export interface ManifestVerification {
  /** Items with no object, or an object that is not their declared size. */
  missing: ImportManifestItem[];
  /** Of those, items prepare uploaded from its clone (`origin: "local"`). */
  missingLocal: number;
  /** Of those, items the copy phase copies from upstream. */
  missingUpstream: number;
  /** The failure line, or null when every item is present at its declared size. */
  message: string | null;
}

/**
 * Every manifest item must have its object at its declared size: a key that merely exists but is
 * 0 bytes or truncated (a corrupt leftover from a failed copy, #967) counts as missing, the same
 * as a key that is absent. `existing` is the destination prefix's listing, key -> size.
 */
export function verifyManifestObjects(
  items: readonly ImportManifestItem[],
  existing: Map<string, number>,
): ManifestVerification {
  const missing = items.filter((it) => !isKeyPresentAtDeclaredSize(it.key, existing));
  // Split the remedy by where the bytes were supposed to come from. The copy
  // phase skips locally-uploaded keys by design, so telling an operator to
  // re-run it for one of those sends them round a loop that cannot converge:
  // only a prepare run, which holds the clone, can upload them (#1159).
  const missingLocal = missing.filter((it) => isLocallyUploaded(it)).length;
  const missingUpstream = missing.length - missingLocal;
  if (missing.length === 0) return { missing, missingLocal, missingUpstream, message: null };
  const remedy = [
    missingUpstream > 0
      ? `${missingUpstream} copied from upstream: re-run the copy phase (a shard likely failed or was cancelled)`
      : null,
    missingLocal > 0
      ? `${missingLocal} uploaded by prepare from the clone: re-run PREPARE, not copy -- the copy phase skips these keys by design and their content exists only in a clone`
      : null,
  ]
    .filter(Boolean)
    .join("; ");
  return {
    missing,
    missingLocal,
    missingUpstream,
    message: `${missing.length} of ${items.length} objects missing or wrong size at the destination. ${remedy}.`,
  };
}

export type TreeGate =
  | { ok: true; unsized: string[]; message: string }
  | { ok: false; unbacked: string[]; available: number; message: string };

/**
 * Every annexed key the tree names must have an object (#1396).
 *
 * The manifest is what the copy phase BELIEVED it transferred, and the verify
 * step only asks whether those items landed. A copy phase that built a
 * partial manifest passes it while the tree references keys nothing ever
 * moved: sixteen datasets finalized that way, 12,039 keys with no object in
 * the bucket, and the location log then told every clone NEMAR had them.
 * So the gate is the TREE against the bucket, not the manifest
 * against the bucket, which is ADR 0061's "a dataset with any annexed key
 * the bucket cannot account for is reported and skipped" applied at the one
 * place that can still stop a DOI being minted.
 *
 * **This gate is deliberately stricter than ADR 0064's 90%, and they are not
 * in conflict because they answer different questions.** 0064 decides
 * whether an ALREADY IMPORTED dataset stays listed when the missing content
 * is gone from its source; the threshold is a floor on what a reader can
 * still use. Here nothing is gone: a key with no object means OUR copy did
 * not finish, which is retryable, so the answer is re-run the copy rather
 * than mint a DOI over a 9% hole. Importing to 91% and calling it listable
 * is how #1396 happened.
 *
 * `existing` is the listing of `s3://<bucket>/<datasetId>/objects/`; `manifestItems` is how many
 * items the manifest accounted for, which the failure line reports.
 */
export function treeGate(
  treeKeys: ReadonlySet<string>,
  existing: Map<string, number>,
  at: { bucket: string; datasetId: string; manifestItems: number },
): TreeGate {
  const unbacked = keysWithoutObjects(treeKeys, existing);
  if (unbacked.length > 0) {
    // The ratio, not just the count, because the tracking issue filed from
    // this failure is triaged by severity: one key missing of 65,063 and 935
    // of 935 are the same sentence without it. Both denominators here are
    // DISTINCT KEYS, which is what `treeKeys` holds. Computed by the one
    // function that owns ADR 0064's rule, never inline here, so the zero-key
    // case and the threshold cannot drift between the two. Data only, which
    // is what `treeKeys` already is: metadata is never annexed (ADR 0015).
    const available = dataAvailability({ annexed: [...treeKeys], missingContent: unbacked });
    const belowThreshold =
      available < MIN_DATA_AVAILABILITY
        ? `, below the ${(MIN_DATA_AVAILABILITY * 100).toFixed(0)}% a listed dataset must reach (ADR 0064)`
        : "";
    return {
      ok: false,
      unbacked,
      available,
      message: [
        `${DATA_AVAILABILITY_MARKER} ${(available * 100).toFixed(1)}% of data keys available.`,
        `${unbacked.length} of ${treeKeys.size} annexed key(s) in the tree have no object in s3://${at.bucket}/${at.datasetId}/objects/`,
        `(e.g. ${unbacked.slice(0, 3).join(", ")}).`,
        `That is ${(available * 100).toFixed(1)}% of its data available${belowThreshold}.`,
        `The manifest accounted for ${at.manifestItems}.`,
        "Refusing to register: those keys would be advertised as NEMAR content that no clone can fetch.",
        "Re-run the copy phase, or prepare if the content exists only in a clone.",
        "If the copy phase cannot get them, check whether OpenNeuro still serves them before assuming a NEMAR bug:",
        `\`nemar admin fleet content-recovery ${at.datasetId}\` reports, per key, whether any recorded source is readable.`,
      ].join(" "),
    };
  }
  // A key whose name declares no size is accepted on its name alone, because
  // there is no declared length to check it against (`git:` keys, and a
  // `URL--` key from `addurl --relaxed`). That is #967's hole surviving inside
  // #1396's fix, so it is counted and said out loud rather than folded into
  // the reassuring total.
  const unsized = [...treeKeys].filter((key) => annexKeyDeclaredSize(key) === null);
  return {
    ok: true,
    unsized,
    message:
      unsized.length === 0
        ? `Every one of ${treeKeys.size} annexed key(s) has an object of its declared size`
        : `Every one of ${treeKeys.size} annexed key(s) has an object; ${unsized.length} declare no size and were checked by name only`,
  };
}

/**
 * Register the tree's keys at the `nemar-s3` remote `uuid`, proven from the location log.
 *
 * The TREE's keys, the same set the gate just proved, not the manifest's. A tree key with an
 * object but no manifest entry passed the gate and was then published unregistered: present in
 * the bucket and invisible to every clone. Registration is the mechanism by which clones know a
 * blob is in S3, so a failure leaves the data present but uncloneable, and the caller stops.
 */
export async function registerTreeKeys(
  datasetPath: string,
  keys: readonly string[],
  uuid: string,
): Promise<{ ok: true; registered: number; message: string } | { ok: false; message: string }> {
  const regResult = await batchSetKeysPresent(datasetPath, [...keys], uuid);
  if (regResult.failed > 0) {
    return {
      ok: false,
      message: `${regResult.failed} of ${keys.length} git-annex key registrations are not in the location log (e.g. ${regResult.missing.slice(0, 3).join(", ")}). Aborting before publish — those blobs would be unfindable for clones. Re-run finalize to retry.`,
    };
  }
  return {
    ok: true,
    registered: regResult.success,
    message: `Registered ${regResult.success} files in git-annex`,
  };
}
