/**
 * Execute a reviewed re-pull plan, the prepare half: through the `prepared` state (ADR 0111,
 * decisions 2 and 3; epic #1046 phase 6). It runs on the administrator's machine, with the
 * administrator's own GitHub token and ambient AWS credentials; the Worker records each step and
 * checks what it can read itself.
 *
 *   S0  read the plan file, prove it is the reviewed one, plan again from live sources
 *       (`verify-plan.ts`); nothing is written anywhere before this passes;
 *   S1  `POST /admin/repulls`: the record, or the open one for this same plan (`planned`);
 *   S2  a working clone at the base, the delta materialized, scrubbed, uploaded where the scrub
 *       re-keyed or annexed, and synthesized into one commit; the checkpoint saved; then
 *       `planned -> prepared` with the commit, its tree, the copy manifest's digest and counts.
 *
 * It copies nothing from upstream, pushes nothing and opens no pull request: those steps follow
 * `prepared` and are built after it. The uploads it makes are those of the import's own scrub and
 * annex policy, to `<id>/objects/` only.
 *
 * Every step checks its own end state first, so a rerun continues: a row found `prepared` whose
 * working clone still holds its commit is left as it is; one whose clone is gone is restored from
 * the checkpoint, or prepared again, and must give the same tree and commit
 * (`prepare-not-reproducible` otherwise: the row stays, its error set, and abandoning it is the
 * way out). A step that fails records why on the row (`planned -> planned`, or `prepared ->
 * prepared` with the facts it already holds) and refuses; the message names counts, never a path.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  PROVENANCE_PATH,
  PROVENANCE_README_PATH,
} from "../../../../shared/privacy-correction-text.js";
import type { RepullRow, RepullStatus } from "../../../../shared/repull-state.js";
import { getApiUrl } from "../../api/client.js";
import { ApiError } from "../../api/errors.js";
import { createRepull, repullErrorCode, transitionRepull } from "../../api/repull.js";
import { getConfigDir } from "../../config.js";
import { fleetCloneEnv } from "../../fleet-key-registration.js";
import { listAnnexedKeys } from "../../git-annex/transfer.js";
import { NORMALIZE_MAX_BYTES } from "../../import-normalize.js";
import { describeError, httpUpstreamReader } from "../../import-scrub.js";
import { awsCliUpload } from "../../normalize-dataset.js";
import { adminGitHubToken, githubApiBase } from "../../pr-review-approve.js";
import type { PlanBody } from "../digest.js";
import { nemarRemoteOf } from "../plan.js";
import {
  type Env,
  openNeuroGraphqlUrl as openNeuroUrlFromEnv,
  originUrl,
  readRemoteLog,
  upstreamUrl,
} from "../sources.js";
import { copySection, planCounts, planFacts } from "./body.js";
import { readCatalogFacts } from "./catalog.js";
import { commitMaterialized, materializeDelta } from "./materialize.js";
import { heldKeys, scrubDelta } from "./scrub-delta.js";
import { type Entry, readIndex, readTree, rowTime, synthesizeCommit } from "./synthesize.js";
import { ExecuteRefused, peekPlan, readExecutablePlan } from "./verify-plan.js";
import {
  type WorkPaths,
  git,
  privateDir,
  removeTree,
  restoreCheckpoint,
  saveCheckpoint,
  workClone,
  workPaths,
} from "./workdir.js";

export interface ExecuteOptions {
  planPath: string;
  /** Stop after this status; `prepared` (the default) is the furthest this build reaches. */
  until?: RepullStatus;
  /** Keep the planner's scratch clones after the run (the working clone is always kept). */
  keepWorkdir?: boolean;
  /** The bound on bytes this host downloads and uploads for the scrub and the annex policy. */
  normalizeMaxBytes?: number;
  /** The planner's bound on large blobs fetched for its checks. */
  maxFetchBytes?: number;
  /** Test bases and their stand-ins, the token and the API overrides; the process's by default. */
  env?: Env;
  out: (line: string) => void;
}

/** The statuses this build can stop at. */
const REACHABLE: readonly RepullStatus[] = ["planned", "prepared"];

/**
 * Upstream's object endpoint for the scrub's pinned reads: the real one, or a test's stand-in
 * through `NEMAR_REPULL_UPSTREAM_OBJECTS_BASE`, honored only for a loopback http address (the
 * `NEMAR_GITHUB_API_URL` rule); a set value that is not one refuses rather than being ignored.
 */
export function upstreamObjectsBase(env: Env): string | undefined {
  const value = env.NEMAR_REPULL_UPSTREAM_OBJECTS_BASE?.trim();
  if (!value) return undefined;
  try {
    const u = new URL(value);
    if (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) {
      return value.replace(/\/+$/, "");
    }
  } catch {
    // refused below
  }
  throw new ExecuteRefused(
    "test-base-refused",
    "NEMAR_REPULL_UPSTREAM_OBJECTS_BASE is set but is not an http://127.0.0.1, http://localhost or http://[::1] address. It is only for tests, so it is refused rather than ignored.",
  );
}

/** What a preparation produced, as the row records it. */
interface Prepared {
  synthSha: string;
  synthTree: string;
  manifestDigest: string;
  counts: Record<string, number>;
}

/** What every step of one run shares. */
interface RunContext {
  env: Env;
  token: string | null;
  datasetId: string;
  digest: string;
  body: PlanBody;
  paths: WorkPaths;
  plannerDir: string;
  computed: Map<string, Buffer>;
  /** Upstream's object endpoint for pinned reads (a loopback stand-in in tests), else S3's own. */
  objectsBase: string | undefined;
  normalizeMaxBytes: number;
  out: (line: string) => void;
}

function recordRefused(err: unknown): ExecuteRefused {
  const code = repullErrorCode(err);
  return new ExecuteRefused(
    code ?? "record-refused",
    `The NEMAR API refused the record${code ? ` (${code})` : ""}: ${err instanceof Error ? err.message : String(err)}`,
  );
}

/** A failure's words for `last_error`: an {@link ExecuteRefused}'s message, else its class only. */
function errorWords(err: unknown): string {
  if (err instanceof ExecuteRefused) return `[${err.code}] ${err.message}`;
  return `[prepare-failed] The preparation failed: ${describeError(err)}.`;
}

/** Run through `prepared` (or `opts.until`). See the module comment. */
export async function executeRepull(
  opts: ExecuteOptions,
): Promise<{ row: RepullRow; stoppedAt: RepullStatus }> {
  const env = opts.env ?? process.env;
  const until = opts.until ?? "prepared";
  if (!REACHABLE.includes(until)) {
    throw new ExecuteRefused(
      "until-not-built",
      `This build prepares a re-pull through prepared; it does not reach ${until}.`,
    );
  }

  // S0. The reviewed plan, made again from live sources. Nothing is written before it passes; a
  // test override that is set and not a loopback address refuses here, before anything is read.
  const { datasetId, digest } = peekPlan(opts.planPath);
  const apiBase = githubApiBase(env);
  const openNeuroGraphqlUrl = openNeuroUrlFromEnv(env);
  const objectsBase = upstreamObjectsBase(env);
  const token = await adminGitHubToken(env);
  if (!token.ok) opts.out(`No GitHub token (${token.reason}); release-pr will be unchecked.`);
  const catalog = await readCatalogFacts(datasetId);
  const configDir = getConfigDir();
  const paths = workPaths(configDir, datasetId, digest);
  const top = join(configDir, "repull");
  removeTree(paths.plan);
  privateDir(paths.plan, top);
  const computed = new Map<string, Buffer>();
  const verified = await readExecutablePlan(opts.planPath, {
    catalog,
    github: { token: token.ok ? token.token : null, apiBase },
    environment: getApiUrl(),
    env,
    workRoot: paths.plan,
    collect: { computed },
    openNeuroGraphqlUrl,
    ...(opts.maxFetchBytes !== undefined ? { maxFetchBytes: opts.maxFetchBytes } : {}),
  });
  const ctx: RunContext = {
    env,
    token: token.ok ? token.token : null,
    datasetId,
    digest,
    body: verified.live.body,
    paths,
    plannerDir: verified.workdir,
    computed,
    objectsBase,
    normalizeMaxBytes: opts.normalizeMaxBytes ?? NORMALIZE_MAX_BYTES,
    out: opts.out,
  };
  try {
    const facts = planFacts(verified.live.body);
    const baseSha = verified.rebasedOnto ?? facts.mainCommit;
    if (verified.rebasedOnto) {
      opts.out("NEMAR's main moved by .nemar/** only since the plan; executing on the live main.");
    }

    // S1. The record.
    const counts = planCounts(verified.live.body);
    let created: Awaited<ReturnType<typeof createRepull>>;
    try {
      created = await createRepull({
        dataset_id: datasetId,
        upstream_ds: facts.ds,
        from_tag: facts.fromTag,
        to_tag: facts.toTag,
        from_version: facts.fromVersion,
        to_version: facts.toVersion,
        plan_digest: digest,
        planner: facts.planner,
        base_sha: baseSha,
        lineage_recordable: facts.lineageRecordable,
        counts: {
          delta_paths: counts.delta_paths ?? 0,
          unexplained: counts.unexplained ?? 0,
          conflicts: counts.conflicts ?? 0,
          corrections: counts.corrections ?? 0,
        },
      });
    } catch (err) {
      if (err instanceof ApiError) throw recordRefused(err);
      throw err;
    }
    let row = created.repull;
    opts.out(
      created.created
        ? `Recorded re-pull #${row.id} of ${datasetId} (${facts.fromTag} -> ${facts.toTag}), planned.`
        : `Found re-pull #${row.id} of ${datasetId}, ${row.status}.`,
    );
    if (until === "planned" || !REACHABLE.includes(row.status)) {
      if (!REACHABLE.includes(row.status)) {
        opts.out(
          `Re-pull #${row.id} is ${row.status}; this build prepares only, so it stops here.`,
        );
      }
      return { row, stoppedAt: row.status };
    }

    // S2. Prepared.
    privateDir(paths.root, top);
    if (row.status === "planned") {
      row = await prepareFromPlanned(ctx, row, baseSha);
    } else {
      row = await resumePrepared(ctx, row, baseSha);
    }
    return { row, stoppedAt: row.status };
  } finally {
    if (!opts.keepWorkdir) removeTree(paths.plan);
  }
}

/** `planned -> prepared`, recording why on the row when the preparation fails. */
async function prepareFromPlanned(
  ctx: RunContext,
  row: RepullRow,
  baseSha: string,
): Promise<RepullRow> {
  let prepared: Prepared;
  try {
    prepared = await prepareOnce(ctx, row, baseSha);
  } catch (err) {
    await recordError(row, "planned", {}, err);
    throw err;
  }
  const next = await transition(row, "prepared", {
    synth_tree: prepared.synthTree,
    synth_sha: prepared.synthSha,
    manifest_digest: prepared.manifestDigest,
    ...(baseSha !== row.base_sha ? { base_sha: baseSha } : {}),
    counts: prepared.counts,
  });
  ctx.out(`Prepared re-pull #${row.id}: commit ${prepared.synthSha.slice(0, 12)}.`);
  return next;
}

/**
 * A row already `prepared`: on the same base, its working clone (or checkpoint) must hold its
 * commit, or a preparation from scratch must give the same tree and commit; on a base that moved
 * by `.nemar/**` only, it is prepared again there and the self-edge records the new facts.
 */
async function resumePrepared(
  ctx: RunContext,
  row: RepullRow,
  baseSha: string,
): Promise<RepullRow> {
  const recorded = {
    synth_tree: row.synth_tree as string,
    synth_sha: row.synth_sha as string,
    manifest_digest: row.manifest_digest as string,
  };
  if (baseSha !== row.base_sha) {
    let prepared: Prepared;
    try {
      prepared = await prepareOnce(ctx, row, baseSha);
    } catch (err) {
      await recordError(row, "prepared", recorded, err);
      throw err;
    }
    ctx.out(`Re-pull #${row.id} prepared again onto the live main.`);
    return transition(row, "prepared", {
      synth_tree: prepared.synthTree,
      synth_sha: prepared.synthSha,
      manifest_digest: prepared.manifestDigest,
      base_sha: baseSha,
      counts: prepared.counts,
    });
  }
  if (await cloneHolds(ctx.paths.repo, recorded.synth_sha, recorded.synth_tree)) {
    ctx.out(`Re-pull #${row.id} is prepared, and its working clone holds its commit.`);
    if (!existsSync(ctx.paths.bundle))
      await saveCheckpoint(ctx.paths.repo, ctx.paths.bundle, baseSha);
    return row;
  }
  const restored = await restoreCheckpoint({
    dir: ctx.paths.repo,
    bundle: ctx.paths.bundle,
    originUrl: originUrl(ctx.datasetId, ctx.env),
    baseSha,
    token: ctx.token,
    synthSha: recorded.synth_sha,
    synthTree: recorded.synth_tree,
  });
  if (restored) {
    ctx.out(`Re-pull #${row.id} is prepared; its working clone was restored from the checkpoint.`);
    return row;
  }
  let again: Prepared;
  try {
    again = await prepareOnce(ctx, row, baseSha);
  } catch (err) {
    await recordError(row, "prepared", recorded, err);
    throw err;
  }
  if (
    again.synthTree !== recorded.synth_tree ||
    again.synthSha !== recorded.synth_sha ||
    again.manifestDigest !== recorded.manifest_digest
  ) {
    const err = new ExecuteRefused(
      "prepare-not-reproducible",
      "Preparing again from the same plan and base gave another tree or commit than the one recorded; abandon this re-pull and plan again.",
    );
    await recordError(row, "prepared", recorded, err);
    throw err;
  }
  ctx.out(
    `Re-pull #${row.id} is prepared; its working clone was prepared again, to the same commit.`,
  );
  return row;
}

/** True when the working clone's branch is the recorded commit and tree. */
async function cloneHolds(repo: string, synthSha: string, synthTree: string): Promise<boolean> {
  try {
    const head = await git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"], { ok: true });
    const tree = await git(repo, ["rev-parse", "--verify", "--quiet", "HEAD^{tree}"], { ok: true });
    return head.stdout.trim() === synthSha && tree.stdout.trim() === synthTree;
  } catch {
    return false;
  }
}

async function transition(
  row: RepullRow,
  to: RepullStatus,
  fields: Record<string, unknown>,
  error?: string,
): Promise<RepullRow> {
  try {
    return await transitionRepull(row.id, {
      from: row.status,
      to,
      fields,
      ...(error ? { error } : {}),
    });
  } catch (err) {
    if (err instanceof ApiError) throw recordRefused(err);
    throw err;
  }
}

/** Record why a step failed on the row, as a self-edge; a failure to record is not the one reported. */
async function recordError(
  row: RepullRow,
  status: "planned" | "prepared",
  fields: Record<string, unknown>,
  err: unknown,
): Promise<void> {
  try {
    await transitionRepull(row.id, {
      from: status,
      to: status,
      fields,
      error: errorWords(err).slice(0, 2000),
    });
  } catch {
    // The failure itself is what the caller reports; the record stays as it was.
  }
}

/**
 * One preparation from scratch: the working clone at `baseSha`, the delta materialized, scrubbed
 * and uploaded where the scrub needs it, the commit synthesized and checked, and the checkpoint.
 */
async function prepareOnce(ctx: RunContext, row: RepullRow, baseSha: string): Promise<Prepared> {
  const { body, datasetId, paths } = ctx;
  const facts = planFacts(body);
  const repo = await workClone({
    dir: paths.repo,
    originUrl: originUrl(datasetId, ctx.env),
    baseSha,
    token: ctx.token,
  });

  // NEMAR's bucket and the uuid uploads register against: what remote.log names, as the plan read.
  const remote = nemarRemoteOf(await readRemoteLog(repo), datasetId);
  const bucket = remote.record?.bucket;
  if (!remote.uuid || !bucket) {
    throw new ExecuteRefused("no-nemar-s3", "NEMAR's remote.log names no single nemar-s3 bucket.");
  }
  const prefix = `${datasetId}/objects/`;
  if (copySection(body).destinationPrefix !== prefix || remote.prefix !== prefix) {
    throw new ExecuteRefused(
      "destination-prefix",
      `The plan's destination is not ${prefix}, the only prefix a re-pull uploads to.`,
    );
  }
  const upload = awsCliUpload({
    bucket,
    datasetId,
    region: remote.region,
    remoteUuid: remote.uuid,
    workDir: paths.upload,
  });
  const reader = httpUpstreamReader({ baseUrl: ctx.objectsBase });

  // NEMAR's side as it is at the base, before anything is written.
  const baseKeys = await listAnnexedKeys(repo);
  const base = await readTree(repo, baseSha, baseKeys);
  const oursKeys = new Set(baseKeys.values());

  const scratch = join(paths.root, "scratch");
  removeTree(scratch);
  privateDir(scratch, paths.root);
  const mat = await materializeDelta({
    work: repo,
    body,
    upstreamBare: join(ctx.plannerDir, "upstream.git"),
    upstreamEnv: fleetCloneEnv(upstreamUrl(facts.ds, ctx.env), null),
    computed: ctx.computed,
    reader,
    scratch,
  });
  // The scope: every path written or deleted, and the provenance files the scrub annotates when a
  // header changes (they may not be delta paths; the scrub refuses rather than leave them out).
  const scope = new Set(mat.deltaPaths);
  const tracked = await git(repo, [
    "ls-files",
    "-z",
    "--",
    PROVENANCE_PATH,
    PROVENANCE_README_PATH,
  ]);
  for (const p of tracked.stdout.split("\0")) if (p) scope.add(p);
  const now = rowTime(row.created_at);
  await commitMaterialized(repo, baseSha, scope, now);
  const preScrub = new Map<string, Entry>();
  for (const [p, e] of await readIndex(repo)) if (scope.has(p)) preScrub.set(p, e);

  const { scrub, uploaded } = await scrubDelta({
    work: repo,
    datasetId,
    scope,
    body,
    oursKeys,
    annexFromGit: mat.annexFromGit,
    reader,
    upload,
    bucket,
    now,
    maxBytes: ctx.normalizeMaxBytes,
    upstreamBare: join(ctx.plannerDir, "upstream.git"),
  });
  removeTree(scratch);

  const held = heldKeys(body, oursKeys);
  const synth = await synthesizeCommit({
    work: repo,
    baseSha,
    createdAt: row.created_at,
    body,
    digest: ctx.digest,
    scrub,
    uploaded,
    held,
    base,
    expected: mat.expected,
    preScrub,
    scope,
    counts: { written: mat.written, deleted: mat.deleted },
  });
  await saveCheckpoint(repo, paths.bundle, baseSha);

  const sizes = (list: Array<{ size: number | null }>) =>
    list.every((i) => i.size !== null)
      ? { known: true, bytes: list.reduce((n, i) => n + (i.size ?? 0), 0) }
      : { known: false, bytes: 0 };
  const copyBytes = sizes(synth.manifest.items);
  const localBytes = sizes(synth.manifest.local);
  const c = scrub.counts;
  return {
    synthSha: synth.synthSha,
    synthTree: synth.synthTree,
    manifestDigest: synth.manifestDigest,
    counts: {
      delta_paths: mat.deltaPaths.size,
      written: mat.written,
      deleted: mat.deleted,
      annex_copy_items: synth.manifest.items.length,
      ...(copyBytes.known ? { copy_bytes: copyBytes.bytes } : {}),
      local_uploads: synth.manifest.local.length,
      ...(localBytes.known ? { local_upload_bytes: localBytes.bytes } : {}),
      scrubbed_recordings: c.headers_scrubbed,
      dated_recordings: c.headers_dates_normalized,
      scrubbed_json: c.json_files_blanked,
      headers_not_read_nemar_held: c.headers_not_read_nemar_held,
      headers_not_read_no_source: c.headers_not_read_no_source,
    },
  };
}
