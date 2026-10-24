/**
 * Recording the upstream snapshot a dataset version mirrors (epic #1046 phase 2, #1908;
 * ADR 0111, decision 4). The parser is `shared/source-snapshot.ts`; this file is the Worker's
 * half: the one `dataset_versions` INSERT, the read of the tagged description, and the rules
 * for what an insert may and may not conclude.
 *
 * WHERE THE ROW IS WRITTEN. Production runs the central manifest flow
 * (`MANIFEST_VIA_CENTRAL_WORKFLOW`), where the version DOI is minted from the tagged
 * description but the row is inserted later, by `/webhooks/manifest-ready`, which reads no
 * description. So the snapshot cannot ride along from the mint, and the insert reads the file
 * itself (one raw-CDN GET, no REST quota). The admin manifest regeneration path does the same;
 * the three inline paths (the orchestrator's, and the legacy and Zenodo handlers' in
 * `version-doi.ts`) hold or lack a description of their own and use {@link columnsFromDescription}.
 * Every site binds {@link INSERT_DATASET_VERSION_SQL}, and a test keeps it the only INSERT.
 *
 * WHAT AN INSERT MAY CONCLUDE. A row is written NULL/NULL ("never examined") whenever the read
 * did not produce a description: the file is absent, the fetch failed, the token could not be
 * minted, the dataset is not an `on######` mirror. A 404 right after a tag is pushed can be a
 * CDN that has not caught up, so an insert never turns "absent" into `unknown`; only the
 * backfill, an hour later and after a control read, may (`services/upstream-backfill.ts`).
 * `unknown` is recorded only when a description WAS read and does not name a single tag, which
 * is a property of the content (a tagged blob is immutable). Only the sites that read the raw
 * file themselves (A, the manifest-ready callback; B, admin regeneration) and the backfill can
 * see that the file is not JSON, so only they record `unknown` for it. The inline sites C and D
 * go through `readRepoMetadata`, which turns unparseable JSON into its `{ Name }` fallback and
 * a warning, and that is NULL/NULL there ({@link columnsFromDescription}).
 *
 * NOTHING HERE MAY FAIL AN INSERT. The version row is the contract the publication flow waits
 * on, so every function that runs before it answers NULL/NULL instead of throwing, and the whole
 * lookup is bounded by {@link SNAPSHOT_LOOKUP_DEADLINE_MS}. That is the worst-case latency this
 * adds to the manifest-ready callback: 5 seconds, well inside the 30 second `--max-time` the
 * live `generate-manifest.yml` gives the callback's curl (connect timeout 10 seconds). When the
 * deadline wins, the lookup it abandoned keeps running unawaited; it is NOT handed to
 * `waitUntil`, because its answer would be discarded and keeping the isolate alive for it buys
 * nothing, and its own fetch is bounded by {@link RAW_FETCH_TIMEOUT_MS} anyway.
 */

import { toVersionTag } from "../../../shared/contract/version.js";
import {
  type SourceSnapshot,
  openNeuroSourceId,
  sourceSnapshotOf,
} from "../../../shared/source-snapshot.js";
import type { Bindings } from "../types/bindings.js";
import { getDatasetsToken } from "./github-auth.js";
import { GITHUB_RAW_ORIGIN, rawContentUrl } from "./github/shared.js";
import { BIDS_METADATA_UNAVAILABLE, errorMessage } from "./repo-metadata.js";

/**
 * The one INSERT into `dataset_versions`: six columns, the last two the snapshot.
 *
 * `ON CONFLICT (dataset_id, version) DO NOTHING`, not `INSERT OR IGNORE`: a replayed insert for
 * a version that exists is still a silent no-op (the pair is UNIQUE), but `OR IGNORE` would also
 * swallow a CHECK violation, and a snapshot pair the CHECK refuses would then drop the whole row
 * with no error. A refused row must raise, so the manifest-ready callback answers 500 and the job
 * stays retryable.
 */
export const INSERT_DATASET_VERSION_SQL =
  "INSERT INTO dataset_versions (dataset_id, version, doi, provider, source_version, source_version_basis) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (dataset_id, version) DO NOTHING";

/** The two snapshot columns of a `dataset_versions` row. NULL/NULL is "never examined". */
export interface SnapshotColumns {
  source_version: string | null;
  source_version_basis: "doi" | "unknown" | null;
}

export const NOT_EXAMINED: SnapshotColumns = { source_version: null, source_version_basis: null };

/** How long the whole lookup may delay an insert, token mint included. */
export const SNAPSHOT_LOOKUP_DEADLINE_MS = 5000;
/** How long the raw fetch alone may take. */
const RAW_FETCH_TIMEOUT_MS = 4000;
/** The most of a `dataset_description.json` that is read. A real one is a few KiB. */
export const DESCRIPTION_MAX_BYTES = 1024 * 1024;

/** The outcome of reading `dataset_description.json` at a tag: three states, never two. */
export type DescriptionFetch =
  | { kind: "content"; body: string }
  | { kind: "absent" }
  | { kind: "error"; reason: string };

/**
 * `dataset_description.json` at a ref (a tag, or a branch for the control read of the backfill)
 * through the authenticated raw CDN (`org` defaults to nemarDatasets; the upstream staleness
 * report reads OpenNeuro's own organization). Only a 404 is `absent`; any other status, a network
 * failure, a timeout and a body over {@link DESCRIPTION_MAX_BYTES} are `error`, which a caller
 * never folds into a verdict.
 */
export async function fetchDescriptionAtRef(
  env: Pick<Bindings, "GITHUB_RAW_BASE">,
  repo: string,
  ref: string,
  pat: string,
  org?: string,
): Promise<DescriptionFetch> {
  const url = rawContentUrl(
    env.GITHUB_RAW_BASE ?? GITHUB_RAW_ORIGIN,
    repo,
    ref,
    "dataset_description.json",
    org,
  );
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${pat}`, "User-Agent": "NEMAR-API" },
      signal: AbortSignal.timeout(RAW_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return { kind: "error", reason: `fetch failed for ${url}: ${errorMessage(err)}` };
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => {});
    return { kind: "absent" };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return { kind: "error", reason: `HTTP ${response.status} for ${url}` };
  }
  try {
    const body = await readCapped(response, DESCRIPTION_MAX_BYTES);
    if (body === null) {
      return { kind: "error", reason: `body over ${DESCRIPTION_MAX_BYTES} bytes for ${url}` };
    }
    return { kind: "content", body };
  } catch (err) {
    return { kind: "error", reason: `body read failed for ${url}: ${errorMessage(err)}` };
  }
}

/** The text of a response, or null when it is longer than `max` bytes (the rest is not read). */
async function readCapped(response: Response, max: number): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * `dataset_description.json` at the tag of a NEMAR version. The ref is the canonical `vX.Y.Z`
 * tag whether the stored version carries the `v` or not, so a `v1.0.0` row never reads
 * `vv1.0.0`.
 */
export function fetchDescriptionAtTag(
  env: Pick<Bindings, "GITHUB_RAW_BASE">,
  repo: string,
  version: string,
  pat: string,
): Promise<DescriptionFetch> {
  return fetchDescriptionAtRef(env, repo, toVersionTag(version), pat);
}

/**
 * What a fetched description says. Valid JSON goes to the parser; text that is not JSON, or JSON
 * that is not an object, is `unknown` and flagged `unparseable`, because a tagged blob is
 * immutable and a parse failure is therefore a fact about the content, not about the network.
 */
export function snapshotFromDescriptionText(
  sourceId: string,
  text: string,
): { columns: SourceSnapshot; unparseable: boolean } {
  let desc: unknown;
  try {
    // A byte order mark is not part of the JSON; a description saved with one is still a
    // description, and calling it unparseable would record a wrong `unknown`.
    desc = JSON.parse(text.startsWith("\uFEFF") ? text.slice(1) : text);
  } catch {
    return {
      columns: { source_version: null, source_version_basis: "unknown" },
      unparseable: true,
    };
  }
  return { columns: sourceSnapshotOf(desc, sourceId), unparseable: false };
}

/**
 * The snapshot columns for a version row about to be inserted, read from the tagged file. Never
 * throws and never delays the insert past {@link SNAPSHOT_LOOKUP_DEADLINE_MS}; NULL/NULL for
 * everything that is not a description that was read (see the module comment).
 *
 * `opts.repo` and `opts.pat` are for a caller that already holds them. The repository defaults
 * to the dataset id, which is how `nemarDatasets` names every repository.
 */
export async function snapshotColumnsForInsert(
  env: Bindings,
  datasetId: string,
  version: string,
  opts: { repo?: string; pat?: string } = {},
): Promise<SnapshotColumns> {
  const sourceId = openNeuroSourceId(datasetId);
  if (!sourceId) return NOT_EXAMINED;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<SnapshotColumns>((resolve) => {
    timer = setTimeout(() => {
      console.warn(
        `[source-snapshot] lookup for ${datasetId}@${version} exceeded ${SNAPSHOT_LOOKUP_DEADLINE_MS}ms; recording it as not examined`,
      );
      resolve(NOT_EXAMINED);
    }, SNAPSHOT_LOOKUP_DEADLINE_MS);
  });

  const lookup = (async (): Promise<SnapshotColumns> => {
    try {
      const pat = opts.pat ?? (await getDatasetsToken(env));
      const fetched = await fetchDescriptionAtTag(env, opts.repo ?? datasetId, version, pat);
      if (fetched.kind === "error") {
        console.warn(`[source-snapshot] ${datasetId}@${version} not examined: ${fetched.reason}`);
        return NOT_EXAMINED;
      }
      if (fetched.kind === "absent") {
        console.warn(
          `[source-snapshot] ${datasetId}@${version} not examined: dataset_description.json is absent at the tag`,
        );
        return NOT_EXAMINED;
      }
      return snapshotFromDescriptionText(sourceId, fetched.body).columns;
    } catch (err) {
      console.warn(`[source-snapshot] ${datasetId}@${version} not examined: ${errorMessage(err)}`);
      return NOT_EXAMINED;
    }
  })();

  try {
    return await Promise.race([lookup, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The snapshot columns from a description the caller already read, for the inline paths that
 * hold one from `readRepoMetadata`. That function never throws: a failed read degrades to a
 * `{ Name }` fallback plus a `BIDS metadata unavailable` warning, and an absent file degrades to
 * the same fallback with no warning. Neither is a description, so both are NULL/NULL, and so is
 * any dataset that is not an `on######` mirror. Of what is left, only a tag is recorded as
 * known; whatever else it says is `unknown`, which is true of a real description.
 */
export function columnsFromDescription(
  datasetId: string,
  description: Record<string, unknown>,
  warnings: readonly string[],
): SnapshotColumns {
  const sourceId = openNeuroSourceId(datasetId);
  if (!sourceId) return NOT_EXAMINED;
  if (warnings.some((w) => w.startsWith(BIDS_METADATA_UNAVAILABLE))) return NOT_EXAMINED;
  if (Object.keys(description).every((key) => key === "Name")) return NOT_EXAMINED;
  return sourceSnapshotOf(description, sourceId);
}
