/**
 * Staging the serving copy's index for a run of the archive (ADR 0141, epic #2324 phase B2b).
 *
 * A recipe that keys the serving index on the archive input (`recipeKeysServingIndex`: nemar-ica on `bids`)
 * reads no store of the serving copy, so it takes each recording's channel group, rate and length from the
 * serving copy's own index, handed to it as a file (`--serving-index`). The run's network is fenced, so the job
 * cannot fetch it: the Worker reads `<id>/zarr/index.json` at dispatch, keeps the exact bytes in the records
 * bucket (`servingIndexKey`, named by their SHA-256), and the job's specification records the digest and size.
 * The launcher fetches the copy with the job token before the fence, checks both, and places it read-only.
 *
 * THE COMMIT MUST MATCH EXACTLY. The index is staged only when its own `source_commit` is the commit of the
 * version's tag. An index built from any other commit is refused (`source_commit_differs`), including one that
 * differs from the tag by metadata only: the Zarr input's `metadata_only` attestation is never asked for here,
 * because the recipe uses a row of the index only when the index's commit is its `--source-commit`, and the
 * commit it is given is the tag's.
 *
 * A FAULT DEFERS, ANYTHING ELSE DISPATCHES WITHOUT (ADR 0141, amended). When GitHub or the index cannot be read,
 * or the copy cannot be kept (`SERVING_INDEX_FAULT_REASONS`), the dispatcher defers the run for up to 24 hours
 * from its first deferral (`compute-pipeline.ts`, `servingIndexForRun`). When the index is absent, built from
 * another commit, too large or not one the recipe can use, the job is dispatched at once without one, and its
 * specification records the word: the run declares no view of the serving copy, and its derivative is keyed
 * `none`. The index's shape is checked here as the recipe checks it (`servingIndexShapeOk`), so a run is never
 * handed an index it would refuse.
 *
 * THE BOUNDS are `checkZarrSource`'s: one GitHub tag lookup (two requests at most, the second only after a 404
 * or 422 without the leading `v`), one index read abandoned after `ZARR_SOURCE_INDEX_TIMEOUT_MS` and read to at
 * most `COMPUTE_SERVING_INDEX_MAX_BYTES` (the recipe's own bound), and one create-only write. The test seam
 * `NEMAR_ZARR_INDEX_BASE` is honored only in a recognized non-production environment, as there.
 */

import { isSourceCommit } from "../../../shared/compute-recipes.js";
import {
  COMPUTE_SERVING_INDEX_MAX_BYTES,
  type ServingIndexAbsentReason,
} from "../../../shared/contract/compute.js";
import { readIJson } from "../../../shared/contract/view-digest.js";
import type { Bindings } from "../types/bindings.js";
import { putServingIndexCopy, sha256Hex } from "./compute-records.js";
import { isNonProductionEnv } from "./environment.js";
import { getZarrIndexResponse } from "./s3.js";
import {
  ZARR_SOURCE_INDEX_TIMEOUT_MS,
  ZARR_SOURCE_LOCAL_USER_AGENT,
  githubAccess,
  tagCommit,
} from "./zarr-source-check.js";

export type StagedServingIndex =
  | {
      staged: true;
      /** The SHA-256 (lowercase hex) of the index's bytes, as kept. */
      sha256: string;
      size: number;
      /** The index's `source_commit`, which is the tag's commit: the run's `--source-commit`. */
      sourceCommit: string;
    }
  | { staged: false; reason: ServingIndexAbsentReason };

const absent = (reason: ServingIndexAbsentReason): StagedServingIndex => ({
  staged: false,
  reason,
});

type IndexRead =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "no_index" | "index_unreadable" | "index_too_large" };

/** The body's bytes, or null when it is longer than `max` (the rest is not read). */
async function readBytesBounded(res: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (res.body === null) return new Uint8Array(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return bytes;
}

/**
 * What the dataset row says of its Zarr serving copy (`zarr-ready` writes it): the conversion's state and its
 * store count. Every consumer of the copy reads it only while `zarr_status = 'ready'` and there is a store (as
 * `zarr-catalog.ts` does). The commit the copy was built from is NOT read from the row (it can be left over
 * from a conversion that has since failed): it is the serving index's own. `resolveRun` reads it for a run of
 * the Zarr input, and the serving index's 403 rule for a run of the archive.
 */
export const ZARR_COPY_SQL =
  "SELECT zarr_status, zarr_store_count FROM datasets WHERE dataset_id = ?1";

/**
 * What a 403 on the index means. The Worker's S3 credentials lack `s3:ListBucket`, so a MISSING object
 * answers 403 too, and a 403 alone cannot tell an absent index from a refused read. The dataset row decides:
 * a copy that is not `ready`, or has no store, has no index to stage (`no_index`, the run goes ahead at once);
 * a `ready` copy with stores should have one, so the 403 is a fault (`index_unreadable`, the run is deferred).
 * A row that cannot be read is a fault too. Granting the credentials `s3:ListBucket` would make S3 answer 404
 * for a missing object; that is the owner's infrastructure change, not this code's.
 */
async function forbiddenReason(
  env: Bindings,
  datasetId: string,
): Promise<"no_index" | "index_unreadable"> {
  try {
    const copy = await env.DB.prepare(ZARR_COPY_SQL).bind(datasetId).first<{
      zarr_status: string | null;
      zarr_store_count: number | null;
    }>();
    return copy?.zarr_status === "ready" && (copy.zarr_store_count ?? 0) > 0
      ? "index_unreadable"
      : "no_index";
  } catch {
    return "index_unreadable";
  }
}

/** The exact bytes of `<id>/zarr/index.json`: over HTTP through the test seam, otherwise from the bucket. */
async function readIndexBytes(env: Bindings, datasetId: string): Promise<IndexRead> {
  const signal = AbortSignal.timeout(ZARR_SOURCE_INDEX_TIMEOUT_MS);
  let res: Response | null | "forbidden";
  try {
    const seam = (globalThis as { NEMAR_ZARR_INDEX_BASE?: string }).NEMAR_ZARR_INDEX_BASE;
    if (seam && isNonProductionEnv(env)) {
      res = await fetch(
        `${seam.replace(/\/+$/, "")}/${encodeURIComponent(datasetId)}/zarr/index.json`,
        {
          method: "GET",
          headers: { Accept: "application/json", "User-Agent": ZARR_SOURCE_LOCAL_USER_AGENT },
          redirect: "manual",
          signal,
        },
      );
      if (res.status === 404) {
        await res.body?.cancel().catch(() => {});
        return { ok: false, reason: "no_index" };
      }
      if (res.status === 403) {
        await res.body?.cancel().catch(() => {});
        return { ok: false, reason: await forbiddenReason(env, datasetId) };
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return { ok: false, reason: "index_unreadable" };
      }
    } else {
      if (
        !env.S3_BUCKET ||
        !env.AWS_REGION ||
        !env.AWS_ACCESS_KEY_ID ||
        !env.AWS_SECRET_ACCESS_KEY
      ) {
        return { ok: false, reason: "index_unreadable" };
      }
      res = await getZarrIndexResponse(
        {
          bucket: env.S3_BUCKET,
          region: env.AWS_REGION,
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        },
        datasetId,
        signal,
      );
      if (res === null) return { ok: false, reason: "no_index" };
      if (res === "forbidden") return { ok: false, reason: await forbiddenReason(env, datasetId) };
    }
    const bytes = await readBytesBounded(res, COMPUTE_SERVING_INDEX_MAX_BYTES);
    if (bytes === null) return { ok: false, reason: "index_too_large" };
    return { ok: true, bytes };
  } catch {
    return { ok: false, reason: "index_unreadable" };
  }
}

/** nemar-process `zarr_input`: `MAX_NAME_LENGTH`, `MAX_DECLARED_CHANNELS`, `MAX_DECLARED_SAMPLES`. */
const MAX_NAME_LENGTH = 1024;
const MAX_DECLARED_CHANNELS = 100_000;
const MAX_DECLARED_SAMPLES = 10 ** 11;
const MAX_STORE_COUNT = 10 ** 9;
const UNSAFE_PATH_CHARACTERS = new Set(["?", "#", "%", "\\"]);

const isWhole = (value: unknown, low: number, high: number): boolean =>
  typeof value === "number" && Number.isInteger(value) && value >= low && value <= high;

/** nemar-process `zarr_input._name`: text of 1 to 1,024 code points with no control character. */
function isName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const points = [...value];
  if (points.length === 0 || points.length > MAX_NAME_LENGTH) return false;
  return points.every((p) => {
    const cp = p.codePointAt(0) as number;
    return cp >= 32 && cp !== 127;
  });
}

/** nemar-process `zarr_input._relative`: a name of plain segments, none empty, none starting with a dot. */
const isRelative = (value: unknown): boolean =>
  isName(value) &&
  !value.split("/").some((segment) => segment === "" || segment.startsWith(".")) &&
  ![...value].some((c) => UNSAFE_PATH_CHARACTERS.has(c));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Whether an index document has the shape the recipe requires before it reads one (nemar-process
 * `zarr_input.validate_document`, rule for rule): `stores` a list and `store_count` a whole number; each store
 * an object with a relative `path` and `zarr` and a list of `groups`; each group an object with a `name`, a
 * text `modality`, a positive finite `rate` and whole `n_channels` and `n_samples` within their bounds. An index
 * the recipe would refuse is never staged (`index_unusable`), so a run is never handed one.
 *
 * One difference remains: JSON has one number type, so an integer-valued float (`3.0`) reads here as the whole
 * number 3 and is accepted, where the recipe's Python reader sees a float and refuses it. The Worker then stages
 * an index the recipe cannot use; the recipe does not end the run over it, and skips the views of the serving
 * copy with `serving_index_unusable`.
 */
export function servingIndexShapeOk(document: unknown): boolean {
  if (!isRecord(document)) return false;
  const stores = document.stores;
  if (!Array.isArray(stores)) return false;
  if (!isWhole(document.store_count, 0, MAX_STORE_COUNT)) return false;
  for (const entry of stores) {
    if (!isRecord(entry)) return false;
    if (!isRelative(entry.path) || !isRelative(entry.zarr)) return false;
    const groups = entry.groups;
    if (!Array.isArray(groups)) return false;
    for (const group of groups) {
      if (!isRecord(group)) return false;
      if (!isName(group.name) || typeof group.modality !== "string") return false;
      const rate = group.rate;
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return false;
      if (!isWhole(group.n_channels, 0, MAX_DECLARED_CHANNELS)) return false;
      if (!isWhole(group.n_samples, 0, MAX_DECLARED_SAMPLES)) return false;
    }
  }
  return true;
}

/**
 * The `source_commit` of the index's bytes, or why a run cannot use it: bytes that are not strict JSON (a byte
 * order mark, not UTF-8, a repeated member name, I-JSON's other refusals: `readIJson`) or not the shape the
 * recipe requires are `index_unusable`; a document with no full commit is `index_commit_unusable`.
 */
function indexSourceCommit(
  bytes: Uint8Array,
):
  | { ok: true; commit: string }
  | { ok: false; reason: "index_unusable" | "index_commit_unusable" } {
  let text: string;
  try {
    // The byte order mark is kept in the text, so `readIJson` refuses it as the recipe's reader does.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "index_unusable" };
  }
  const read = readIJson(text);
  if (!read.ok || !servingIndexShapeOk(read.value)) {
    return { ok: false, reason: "index_unusable" };
  }
  const commit = (read.value as Record<string, unknown>).source_commit;
  return isSourceCommit(commit)
    ? { ok: true, commit }
    : { ok: false, reason: "index_commit_unusable" };
}

/**
 * The words of a staging that may clear on a later attempt (ADR 0141 amendment): GitHub or the index could not
 * be read, or the copy could not be kept. A run is not dispatched on one of them for
 * {@link SERVING_INDEX_DEFER_MINUTES} from its first deferral; every other word dispatches it at once without an
 * index (the index is absent, of another commit, or one the recipe cannot use).
 */
export const SERVING_INDEX_FAULT_REASONS: readonly ServingIndexAbsentReason[] = Object.freeze([
  "github_unreadable",
  "index_unreadable",
  "token_mint_failed",
  "no_github_credentials",
  "index_not_stored",
]);

/** How long a run is deferred on a fault before it is dispatched without the index: 24 hours. */
export const SERVING_INDEX_DEFER_MINUTES = 24 * 60;

export const isServingIndexFault = (reason: ServingIndexAbsentReason): boolean =>
  SERVING_INDEX_FAULT_REASONS.includes(reason);

const errorName = (err: unknown): string =>
  err instanceof Error ? err.name.replace(/[^A-Za-z0-9]/g, "") || "Error" : "unknown";

/**
 * Stage the serving index of `datasetId` for a run of the version tagged `tag` (the data-plane tag, `v1.0.2`),
 * or say why none is staged. Never throws: every failure is a word; a fault (`isServingIndexFault`) defers the
 * run, any other word dispatches it without an index. The copy is kept BEFORE this answers `staged`, so a specification never names bytes that are not kept.
 */
export async function stageServingIndex(
  env: Bindings,
  datasetId: string,
  tag: string,
): Promise<StagedServingIndex> {
  try {
    const access = await githubAccess(env);
    if (!access.ok) return absent(access.reason);
    const [index, tagged] = await Promise.all([
      readIndexBytes(env, datasetId),
      tagCommit(datasetId, tag, access),
    ]);
    if (!tagged.ok) return absent(tagged.reason);
    if (!index.ok) return absent(index.reason);
    const source = indexSourceCommit(index.bytes);
    if (!source.ok) return absent(source.reason);
    // Exactly the tag's commit: never a metadata-only difference (ADR 0141).
    if (source.commit !== tagged.commit) return absent("source_commit_differs");
    const sha256 = await sha256Hex(index.bytes);
    let kept: boolean;
    try {
      kept = await putServingIndexCopy(env, sha256, index.bytes);
    } catch (err) {
      console.error(`[serving-index] copy_put_failed error=${errorName(err)}`);
      return absent("index_not_stored");
    }
    if (!kept) {
      // Other bytes under a content address: never overwritten, and an administrator looks.
      console.error(`[serving-index] copy_conflict sha256=${sha256}`);
      return absent("index_not_stored");
    }
    return { staged: true, sha256, size: index.bytes.byteLength, sourceCommit: source.commit };
  } catch (err) {
    // A throw here is a defect, not a service: the error's name (never its message) is for the operator.
    console.error(`[serving-index] stage_threw error=${errorName(err)}`);
    return absent("index_unreadable");
  }
}
