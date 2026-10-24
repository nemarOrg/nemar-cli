/**
 * What only GitHub and the version row can say about a re-pull: that its pull request merged, that
 * its version was released, and that a claim to merge was never sent (epic #1046 phase 6, #1912;
 * ADR 0111, decisions 2, 3 and 6).
 *
 * `merged`, `released` and their N.0.1 twins are facts, not steps a caller reports, so the
 * transition route refuses them (`use-verified-route`) and these functions write them after
 * reading the facts themselves, with the Worker's own GitHub credential:
 *  - merged: GitHub says the recorded pull request (its number, its release branch, aimed at
 *    `main`) is merged. The merge commit is GitHub's. A merge with no claim from a NEMAR tool, or
 *    at a head other than the screened one, is still recorded, because it happened and a second
 *    major would be a second DOI; it is counted (`merged_outside_tool`, `merged_unscreened_head`)
 *    so the record says so. The cap binds NEMAR's tools only (ADR 0111, Consequences).
 *  - released: the version row exists with a DOI, the tag `v<version>` names the commit the
 *    caller reports, and that commit contains the merge. In the same batch, and only when the
 *    edge applies: the version's lineage when the caller verified the tagged tree (N.0.0 only,
 *    decision 4), and the dataset's hed, channel-montage, data and availability stamps are
 *    re-armed (decision 2), so each sweep reads the new version again.
 *  - a claim is released only when the caller says the merge was not sent or was refused, and
 *    GitHub says the pull request is not merged: an unknown outcome keeps the claim, so a lost
 *    answer is resolved from GitHub and never repeated blind.
 *
 * Every write here goes through the transition's own checks and compare-and-set
 * (`prepareTransition`, `commitTransition`), and nothing here mails anyone.
 */

import { z } from "zod";
import {
  PULL_REQUEST_COLUMNS,
  REPULL_PULL_REQUESTS,
  type RepullPullRequest,
  type RepullRow,
  SHA_RE,
} from "../../../shared/repull-state.js";
import { AUDIT_IF_PREVIOUS_CHANGED_SQL, auditLogParams } from "../db/audit-log.js";
import type { Bindings } from "../types/bindings.js";
import { getDatasetsTokenWithRefresher } from "./github-auth.js";
import { GITHUB_API, ORG_NAME, ghHeaders } from "./github/shared.js";
import { githubFetchWithRetry } from "./github/transport.js";
import {
  AVAILABILITY_REPORT_AT_PATH,
  CHANNEL_MONTAGE_CHECKED_AT_PATH,
  DATA_CHECKED_AT_PATH,
  HED_CHECKED_AT_PATH,
} from "./sweep-stamps.js";
import {
  LINEAGE_WRITE_SQL,
  type RepullRefusal,
  commitTransition,
  envFenceRefusal,
  getRepull,
  isRefusal,
  prepareTransition,
} from "./upstream-repull.js";

/** How long one GitHub read may take, so an administrator's request is answered. */
export const VERIFIED_READ_TIMEOUT_MS = 10_000;

// ----------------------------------------------------------------------------
// SQL
// ----------------------------------------------------------------------------

/** The row as it was read, numbered after the statement's own parameters. */
const ROW_AS_READ = (first: number) =>
  `EXISTS (SELECT 1 FROM upstream_repulls WHERE id = ?${first} AND status = ?${first + 1} AND revision = ?${first + 2})`;

/**
 * {@link LINEAGE_WRITE_SQL} (`?1` tag, `?2` dataset, `?3` version), applied only while the re-pull
 * row is as it was read (`?4` id, `?5` status, `?6` revision): it runs in the release's batch
 * before the transition, which is the only statement there that moves the row, so it applies
 * exactly when the transition does.
 */
export const LINEAGE_AT_RELEASE_SQL = `${LINEAGE_WRITE_SQL}
   AND ${ROW_AS_READ(4)}`;

/**
 * Re-arm the four sweeps of the one dataset a release changed (`?1` dataset; `?2` to `?4` the
 * row as it was read). Removing a marker is the whole of re-queueing: each sweep's candidates are
 * the datasets without it. The values the sweeps wrote stay until each sweep overwrites them.
 */
export const STAMPS_REARM_SQL = `UPDATE datasets
   SET sweep_stamps = json_remove(sweep_stamps, '${HED_CHECKED_AT_PATH}',
     '${CHANNEL_MONTAGE_CHECKED_AT_PATH}', '${DATA_CHECKED_AT_PATH}', '${AVAILABILITY_REPORT_AT_PATH}')
 WHERE dataset_id = ?1 AND sweep_stamps IS NOT NULL AND ${ROW_AS_READ(2)}`;

/**
 * Whether the version was minted: a version row with a DOI, in either spelling of the version.
 * Only that it exists is read; the identifier itself goes into no response and no audit row.
 */
export const RELEASED_VERSION_SQL = `SELECT 1 AS minted FROM dataset_versions
  WHERE dataset_id = ? AND version IN (?, 'v' || ?) AND doi IS NOT NULL AND doi <> '' LIMIT 1`;

// ----------------------------------------------------------------------------
// Request bodies
// ----------------------------------------------------------------------------

const sha = z.string().regex(SHA_RE, "must be a 40-character lowercase hex id");

export const releaseClaimSchema = z
  .object({
    pr: z.enum(REPULL_PULL_REQUESTS),
    sha,
    // `unknown` is not here on purpose: a merge whose answer was lost may have happened.
    outcome: z.enum(["not_sent", "refused"]),
  })
  .strict();

export const mergedSchema = z.object({ pr: z.enum(REPULL_PULL_REQUESTS) }).strict();

export const releasedSchema = z
  .object({
    pr: z.enum(REPULL_PULL_REQUESTS),
    tag_sha: sha,
    /** The caller compared the tagged tree with the synthesized one outside NEMAR's paths. */
    tree_verified: z.boolean(),
  })
  .strict();

// ----------------------------------------------------------------------------
// GitHub reads
// ----------------------------------------------------------------------------

type Read = { ok: true; status: number; body: unknown } | { ok: false; refusal: RepullRefusal };

function unreadable(what: string, why: string): RepullRefusal {
  return {
    status: 502,
    code: "github-unreadable",
    message: `GitHub could not be read (${what}: ${why}), so nothing was recorded.`,
  };
}

/** One GET against the dataset's repository. A 404 or 422 is an answer; every other failure is a refusal. */
async function githubRead(env: Bindings, datasetId: string, path: string): Promise<Read> {
  let res: Response;
  try {
    const { token, refresh } = await getDatasetsTokenWithRefresher(env);
    res = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${datasetId}${path}`,
      { headers: ghHeaders(token), signal: AbortSignal.timeout(VERIFIED_READ_TIMEOUT_MS) },
      { kind: "interactive", maxAttempts: 2, refreshTokenOn401: refresh },
    );
  } catch (err) {
    const why = err instanceof Error ? err.name : "error";
    console.error(`[upstream-repull] GitHub read of ${datasetId}${path} failed (${why})`);
    return { ok: false, refusal: unreadable(path, "no answer") };
  }
  if (res.status === 404 || res.status === 422) return { ok: true, status: res.status, body: null };
  if (!res.ok) {
    console.error(`[upstream-repull] GitHub answered HTTP ${res.status} for ${datasetId}${path}`);
    return { ok: false, refusal: unreadable(path, `HTTP ${res.status}`) };
  }
  const body = (await res.json().catch(() => null)) as unknown;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, refusal: unreadable(path, "an answer that is not an object") };
  }
  return { ok: true, status: res.status, body };
}

interface PullRequestFacts {
  merged: boolean;
  mergeCommitSha: string | null;
  headSha: string;
  headRef: string;
  baseRef: string;
}

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/** The fields of GitHub's pull request this reads, each checked for its shape; null when one is off. */
function pullRequestFacts(body: unknown): PullRequestFacts | null {
  if (!isObject(body) || !isObject(body.head) || !isObject(body.base)) return null;
  const { merged, merge_commit_sha: mergeCommitSha } = body;
  const headSha = body.head.sha;
  const headRef = body.head.ref;
  const baseRef = body.base.ref;
  if (typeof merged !== "boolean") return null;
  if (typeof headSha !== "string" || !SHA_RE.test(headSha)) return null;
  if (typeof headRef !== "string" || typeof baseRef !== "string") return null;
  return {
    merged,
    mergeCommitSha:
      typeof mergeCommitSha === "string" && SHA_RE.test(mergeCommitSha) ? mergeCommitSha : null,
    headSha,
    headRef,
    baseRef,
  };
}

/** The recorded pull request, read from GitHub, and checked to be the one the row names. */
async function readRecordedPullRequest(
  env: Bindings,
  row: RepullRow,
  pr: RepullPullRequest,
): Promise<{ ok: true; facts: PullRequestFacts } | { ok: false; refusal: RepullRefusal }> {
  const cols = PULL_REQUEST_COLUMNS[pr];
  const number = row[cols.number];
  const read = await githubRead(env, row.dataset_id, `/pulls/${number}`);
  if (!read.ok) return read;
  if (read.status !== 200) {
    return {
      ok: false,
      refusal: {
        status: 409,
        code: "pull-request-missing",
        message: `GitHub has no pull request #${number} on ${row.dataset_id} (or the Worker's token cannot see it).`,
        row,
      },
    };
  }
  const facts = pullRequestFacts(read.body);
  if (!facts) return { ok: false, refusal: unreadable(`pull request #${number}`, "its shape") };
  if (facts.headRef !== row[cols.branch] || facts.baseRef !== "main") {
    return {
      ok: false,
      refusal: {
        status: 409,
        code: "pull-request-mismatch",
        message: `Pull request #${number} is ${facts.headRef} into ${facts.baseRef}, not the recorded ${row[cols.branch]} into main.`,
        row,
      },
    };
  }
  return { ok: true, facts };
}

// ----------------------------------------------------------------------------
// The claim, released
// ----------------------------------------------------------------------------

/**
 * Clear a claim to merge that was never sent, or that GitHub refused, so its unit of the day's cap
 * is free again. Only while the row is still at its gates-clear status with the claim naming
 * `sha`, and only when GitHub says the pull request is not merged: a merged one is recorded with
 * `merged`, and a claim whose outcome is unknown is never released.
 */
export async function releaseMergeClaim(
  env: Bindings,
  admin: { id: number },
  id: number,
  body: z.infer<typeof releaseClaimSchema>,
): Promise<{ row: RepullRow } | RepullRefusal> {
  const db = env.DB;
  const row = await getRepull(db, id);
  if (!row) return { status: 404, code: "not-found", message: `No re-pull #${id}.` };
  const fence = envFenceRefusal(env, row.dataset_id);
  if (fence) return fence;
  const cols = PULL_REQUEST_COLUMNS[body.pr];
  if (row.status !== cols.gatesClear || row[cols.claimSha] === null) {
    return {
      status: 409,
      code: "no-claim",
      message: `Re-pull #${id} holds no claim to merge its ${body.pr} pull request (it is ${row.status}).`,
      row,
    };
  }
  if (row[cols.claimSha] !== body.sha) {
    return {
      status: 409,
      code: "claim-mismatch",
      message: `The claim names ${String(row[cols.claimSha]).slice(0, 12)}, not ${body.sha.slice(0, 12)}.`,
      row,
    };
  }
  const read = await readRecordedPullRequest(env, row, body.pr);
  if (!read.ok) return read.refusal;
  if (read.facts.merged) {
    return {
      status: 409,
      code: "pull-request-merged",
      message: `GitHub says pull request #${row[cols.number]} is merged, so the claim stands; record the merge instead.`,
      row,
    };
  }
  // Column names are this module's constants, never a request's.
  const results = await db.batch([
    db
      .prepare(
        `UPDATE upstream_repulls
            SET ${cols.claimedAt} = NULL, ${cols.claimSha} = NULL,
                revision = revision + 1, updated_at = datetime('now')
          WHERE id = ? AND status = ? AND revision = ? AND ${cols.claimSha} = ?
            AND ${cols.mergeSha} IS NULL`,
      )
      .bind(id, row.status, row.revision, body.sha),
    db.prepare(AUDIT_IF_PREVIOUS_CHANGED_SQL).bind(
      ...auditLogParams({
        userId: admin.id,
        action: "repull_merge_claim_released",
        resourceType: "upstream_repull",
        resourceId: String(id),
        details: JSON.stringify({
          dataset_id: row.dataset_id,
          pr: body.pr,
          sha: body.sha,
          outcome: body.outcome,
          claimed_at: row[cols.claimedAt],
        }),
      }),
    ),
  ]);
  const after = await getRepull(db, id);
  if (!after) return { status: 404, code: "not-found", message: `Re-pull #${id} was deleted.` };
  if ((results[0]?.meta?.changes ?? 0) === 0) {
    return {
      status: 409,
      code: "stale-status",
      message: `Re-pull #${id} moved before the claim was released; it is ${after.status}.`,
      row: after,
    };
  }
  return { row: after };
}

// ----------------------------------------------------------------------------
// Merged
// ----------------------------------------------------------------------------

export interface MergedResult {
  row: RepullRow;
  merged_outside_tool: boolean;
  merged_unscreened_head: boolean;
}

/**
 * Record that the recorded pull request merged, from GitHub's own answer: `gates_clear` to
 * `merged` (or the N.0.1 twin) with GitHub's merge commit.
 */
export async function recordRepullMerged(
  env: Bindings,
  admin: { id: number },
  id: number,
  body: z.infer<typeof mergedSchema>,
): Promise<MergedResult | RepullRefusal> {
  const db = env.DB;
  const row = await getRepull(db, id);
  if (!row) return { status: 404, code: "not-found", message: `No re-pull #${id}.` };
  const fence = envFenceRefusal(env, row.dataset_id);
  if (fence) return fence;
  const cols = PULL_REQUEST_COLUMNS[body.pr];
  if (row.status !== cols.gatesClear) {
    return {
      status: 409,
      code: "bad-transition",
      message: `A merge of the ${body.pr} pull request is recorded from ${cols.gatesClear}; re-pull #${id} is ${row.status}.`,
      row,
    };
  }
  const read = await readRecordedPullRequest(env, row, body.pr);
  if (!read.ok) return read.refusal;
  const { facts } = read;
  if (!facts.merged) {
    return {
      status: 409,
      code: "not-merged",
      message: `GitHub says pull request #${row[cols.number]} is not merged.`,
      row,
    };
  }
  if (facts.mergeCommitSha === null) {
    return unreadable(`pull request #${row[cols.number]}`, "a merge with no merge commit");
  }
  const claimSha = row[cols.claimSha];
  const outsideTool = claimSha === null || facts.headSha !== claimSha;
  const unscreenedHead = facts.headSha !== row[cols.gates];
  const counts: Record<string, number> = {};
  if (outsideTool) counts.merged_outside_tool = 1;
  if (unscreenedHead) counts.merged_unscreened_head = 1;
  const prepared = await prepareTransition(
    env,
    admin,
    row,
    {
      from: cols.gatesClear,
      to: cols.merged,
      fields: {
        [cols.mergeSha]: facts.mergeCommitSha,
        ...(Object.keys(counts).length > 0 ? { counts } : {}),
      },
    },
    {
      verified: true,
      auditDetails: {
        merged_head: facts.headSha,
        merged_outside_tool: outsideTool,
        merged_unscreened_head: unscreenedHead,
      },
    },
  );
  if (isRefusal(prepared)) return prepared;
  const done = await commitTransition(db, prepared);
  if (isRefusal(done)) return done;
  if (outsideTool || unscreenedHead) {
    console.warn(
      `[upstream-repull] ${row.dataset_id} re-pull ${id} ${body.pr}: merged${outsideTool ? " outside a NEMAR tool" : ""}${unscreenedHead ? " at a head other than the screened one" : ""}`,
    );
  }
  return {
    row: done.row,
    merged_outside_tool: outsideTool,
    merged_unscreened_head: unscreenedHead,
  };
}

// ----------------------------------------------------------------------------
// Released
// ----------------------------------------------------------------------------

export interface ReleasedResult {
  row: RepullRow;
  /** Version rows the lineage write upgraded: 0 unless N.0.0's tagged tree was verified. */
  lineage_rows: number;
  /** 1 when the dataset's four sweep stamps were re-armed, 0 when it had none to remove. */
  stamps_rearmed: number;
}

/**
 * Record that the merged version was released: `merged` to `released` (or the N.0.1 twin) once
 * the version row exists with a DOI and the tag names the reported commit, which contains the
 * merge. The lineage write (N.0.0, tree verified) and the stamp re-arm ride in the same batch and
 * apply exactly when the transition does.
 */
export async function recordRepullReleased(
  env: Bindings,
  admin: { id: number },
  id: number,
  body: z.infer<typeof releasedSchema>,
): Promise<ReleasedResult | RepullRefusal> {
  const db = env.DB;
  const row = await getRepull(db, id);
  if (!row) return { status: 404, code: "not-found", message: `No re-pull #${id}.` };
  const fence = envFenceRefusal(env, row.dataset_id);
  if (fence) return fence;
  const cols = PULL_REQUEST_COLUMNS[body.pr];
  if (row.status !== cols.merged) {
    return {
      status: 409,
      code: "bad-transition",
      message: `A release of the ${body.pr} pull request is recorded from ${cols.merged}; re-pull #${id} is ${row.status}.`,
      row,
    };
  }
  const version = row[cols.version] as string;
  const mergeSha = row[cols.mergeSha] as string;
  const versionRow = await db
    .prepare(RELEASED_VERSION_SQL)
    .bind(row.dataset_id, version, version)
    .first<{ minted: number }>();
  if (!versionRow) {
    return {
      status: 409,
      code: "not-released",
      message: `${row.dataset_id} has no version ${version} with a DOI yet; the release is recorded once the version is minted.`,
      row,
    };
  }
  const tag = `v${version}`;
  const tagRead = await githubRead(env, row.dataset_id, `/commits/tags/${encodeURIComponent(tag)}`);
  if (!tagRead.ok) return tagRead.refusal;
  const tagged = isObject(tagRead.body) ? tagRead.body.sha : null;
  if (tagRead.status !== 200 || typeof tagged !== "string" || !SHA_RE.test(tagged)) {
    return {
      status: 409,
      code: "tag-missing",
      message: `${row.dataset_id} has no tag ${tag} that GitHub resolves to a commit.`,
      row,
    };
  }
  if (tagged !== body.tag_sha) {
    return {
      status: 409,
      code: "tag-mismatch",
      message: `Tag ${tag} names ${tagged.slice(0, 12)}, not ${body.tag_sha.slice(0, 12)}.`,
      row,
    };
  }
  const compare = await githubRead(env, row.dataset_id, `/compare/${mergeSha}...${tagged}`);
  if (!compare.ok) return compare.refusal;
  const relation = isObject(compare.body) ? compare.body.status : null;
  if (relation !== "identical" && relation !== "ahead") {
    return {
      status: 409,
      code: "tag-mismatch",
      message: `Tag ${tag} (${tagged.slice(0, 12)}) does not contain the merge ${mergeSha.slice(0, 12)}.`,
      row,
    };
  }

  const prepared = await prepareTransition(
    env,
    admin,
    row,
    { from: cols.merged, to: cols.released, fields: { [cols.tagSha]: tagged } },
    {
      verified: true,
      auditDetails: { version, tag_sha: tagged, tree_verified: body.tree_verified },
    },
  );
  if (isRefusal(prepared)) return prepared;
  const asRead = [row.id, row.status, row.revision];
  // Lineage is N.0.0's only: N.0.1 carries NEMAR's corrections, so its tree is not upstream's.
  const lineage = body.pr === "n0" && body.tree_verified;
  const before = [
    ...(lineage
      ? [db.prepare(LINEAGE_AT_RELEASE_SQL).bind(row.to_tag, row.dataset_id, version, ...asRead)]
      : []),
    db.prepare(STAMPS_REARM_SQL).bind(row.dataset_id, ...asRead),
  ];
  const done = await commitTransition(db, prepared, before);
  if (isRefusal(done)) return done;
  return {
    row: done.row,
    lineage_rows: lineage ? (done.results[0]?.meta?.changes ?? 0) : 0,
    stamps_rearmed: done.results[lineage ? 1 : 0]?.meta?.changes ?? 0,
  };
}
