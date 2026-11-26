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
 * NOTHING HERE REFUSES A RUN. When there is no index, or it cannot be read, or it does not match, the job is
 * dispatched without one, and its specification records the word (`SERVING_INDEX_ABSENT_REASONS`): the run then
 * declares no view of the serving copy, as it did before this phase, and its derivative is keyed `none`.
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

/** The exact bytes of `<id>/zarr/index.json`: over HTTP through the test seam, otherwise from the bucket. */
async function readIndexBytes(env: Bindings, datasetId: string): Promise<IndexRead> {
  const signal = AbortSignal.timeout(ZARR_SOURCE_INDEX_TIMEOUT_MS);
  let res: Response | null;
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
    }
    const bytes = await readBytesBounded(res, COMPUTE_SERVING_INDEX_MAX_BYTES);
    if (bytes === null) return { ok: false, reason: "index_too_large" };
    if (bytes.byteLength === 0) return { ok: false, reason: "index_unreadable" };
    return { ok: true, bytes };
  } catch {
    return { ok: false, reason: "index_unreadable" };
  }
}

/** The `source_commit` of the index's bytes, or why it has none a run can use. */
function indexSourceCommit(
  bytes: Uint8Array,
):
  | { ok: true; commit: string }
  | { ok: false; reason: "index_unreadable" | "index_commit_unusable" } {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return { ok: false, reason: "index_unreadable" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "index_unreadable" };
  }
  const commit = (value as Record<string, unknown>).source_commit;
  return isSourceCommit(commit)
    ? { ok: true, commit }
    : { ok: false, reason: "index_commit_unusable" };
}

/**
 * Stage the serving index of `datasetId` for a run of the version tagged `tag` (the data-plane tag, `v1.0.2`),
 * or say why none is staged. Never throws: every failure is a word, and a word dispatches the run without an
 * index. The copy is kept BEFORE this answers `staged`, so a specification never names bytes that are not kept.
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
    } catch {
      kept = false;
    }
    if (!kept) return absent("index_not_stored");
    return { staged: true, sha256, size: index.bytes.byteLength, sourceCommit: source.commit };
  } catch (err) {
    // A throw here is a defect, not a service: the error's name (never its message) is for the operator.
    console.error(
      `[serving-index] stage_threw error=${err instanceof Error ? err.name.replace(/[^A-Za-z0-9]/g, "") : "unknown"}`,
    );
    return absent("index_unreadable");
  }
}
