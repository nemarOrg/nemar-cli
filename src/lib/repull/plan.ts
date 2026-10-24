/**
 * `nemar admin repull plan <id>`: the read-only plan of an upstream re-pull (ADR 0111, epic #1046
 * phase 5, #1911).
 *
 * The plan compares upstream at `from_tag` (base), upstream at `to_tag` (theirs) and NEMAR's
 * `main` (ours) path by path (`overlay.ts`), and says what N.0.0 would hold, what N.0.1 would
 * replay, which keys a copy would bring into NEMAR's bucket from which pinned upstream version, and
 * what the scrub would read. It writes nothing anywhere but its own scratch directory and the plan
 * file: every subprocess and request goes through `read-only.ts`.
 *
 * It binds the PRE-scrub manifest. The scrubbed new tree cannot be known before the scrub runs, so
 * Phase 6's execution must check that what it copies is a subset of this plan's copy keys plus its
 * own local uploads (an ambiguity of ADR 0111 decision 8, recorded in the phase report).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDead, presentIn, readLocationLogsAt } from "../../../scripts/scrub/git/git-lib.js";
import { parseLedgerText } from "../../../scripts/scrub/ledger.js";
import { isKeyPresentAtDeclaredSize } from "../../../shared/annex-key.js";
import type { CanonicalJsonValue } from "../../../shared/neurobagel/canonical-json.js";
import { type SourceVersionRow, openNeuroSourceId } from "../../../shared/source-snapshot.js";
import { type PinnedSource, parseRemoteLog } from "../content-recovery.js";
import {
  UPSTREAM_BUCKET,
  destinationPrefix,
  readPinnedSources,
} from "../fleet-content-recovery.js";
import { shouldAnnex } from "../git-annex/policy.js";
import { JSON_PATH, RECORDING_PATH, SCANS_TABLE_PATH } from "../import-scrub.js";
import { bumpVersion } from "../semver.js";
import { DESCRIPTION_PATH } from "./description.js";
import {
  PLAN_FILE_VERSION,
  PLAN_SCHEMA,
  type PlanBody,
  type PlanFile,
  planDigest,
} from "./digest.js";
import { type Side, type Target, keyDigest, stripBom } from "./edits.js";
import { type FromTagSource, bareVersion, resolveFromTag } from "./from-tag.js";
import { type PathDecision, overlay } from "./overlay.js";
import {
  type Check,
  annexUuidCheck,
  releasePrCheck,
  sourceCheck,
  toTagCheck,
  versionCheck,
} from "./preflight.js";
import { readOnlyGit } from "./read-only.js";
import {
  BlobStore,
  type Env,
  FetchBudget,
  cloneAt,
  commitAndTree,
  listBucketObjects,
  listTree,
  lsRemote,
  missingBlobs,
  objectFormat,
  originUrl,
  readAnnexUuidMarker,
  readBlobs,
  upstreamUrl,
} from "./sources.js";

export const NEMAR_REMOTE = "nemar-s3";
export const LEDGER_PATH = ".nemar/corrections.jsonl";
export const NEMAR_METADATA_PATH = ".nemar/metadata.json";
export const DEFAULT_MAX_FETCH_BYTES = 5 * 1024 ** 3;
const DATASET_ID_RE = /^[a-z]{2}\d{6}$/;

/** A failure that leaves nothing to plan: the command exits 1. */
export class RepullCannotPlan extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepullCannotPlan";
  }
}

export interface CatalogFacts {
  /** The dataset row from `GET /datasets/:id`; null when it does not exist. */
  dataset: {
    source?: string | null;
    source_id?: string | null;
    concept_doi?: string | null;
  } | null;
  /** `GET /datasets/:id/versions` rows; null when they cannot be read (a dev worker's 404). */
  versions: SourceVersionRow[] | null;
}

export interface PlanOptions {
  datasetId: string;
  toTag?: string;
  fromTag?: string;
  maxFetchBytes?: number;
  keepWorkdir?: boolean;
  /** Where the scratch directory goes; the system temp directory by default. */
  workRoot?: string;
  /** Read for the test bases only (`sources.ts`). */
  env?: Env;
  catalog: CatalogFacts;
  github: { token: string | null; apiBase: string };
  environment: string;
  now?: Date;
  /**
   * Where "NEMAR already holds this key" comes from: the location log (the default), or a listing
   * of the bucket with the ambient AWS credentials (the lead's ruling of 2026-10-23).
   */
  presence?: "location-log" | "bucket-listing";
}

export type PlanOutcome =
  | { planned: false; preflight: Check[]; reason: string; workdir: string | null }
  | { planned: true; file: PlanFile; workdir: string | null };

/** Build the plan. Throws {@link RepullCannotPlan} when the remotes cannot be read. */
export async function planRepull(opts: PlanOptions): Promise<PlanOutcome> {
  const env = opts.env ?? process.env;
  const id = opts.datasetId;
  if (!DATASET_ID_RE.test(id)) throw new RepullCannotPlan(`${id} is not a dataset id`);

  const source = sourceCheck({
    datasetId: id,
    mapped: openNeuroSourceId(id),
    row: opts.catalog.dataset,
  });
  if (!source.ds) {
    return {
      planned: false,
      preflight: [source.check],
      reason: source.check.code ?? "source",
      workdir: null,
    };
  }
  const ds = source.ds;
  const upUrl = upstreamUrl(ds, env);
  const nemarUrl = originUrl(id, env);

  let upRefs: Map<string, string>;
  let nemarRefs: Map<string, string>;
  try {
    upRefs = await lsRemote(upUrl, ["refs/tags/*", "refs/heads/git-annex"], undefined);
    nemarRefs = await lsRemote(
      nemarUrl,
      ["refs/heads/main", "refs/heads/git-annex", "refs/heads/release/*", "refs/tags/v*"],
      undefined,
    );
  } catch (err) {
    throw new RepullCannotPlan(
      `could not list the remotes: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!nemarRefs.has("refs/heads/main") || !nemarRefs.has("refs/heads/git-annex")) {
    throw new RepullCannotPlan(`${id} has no main or no git-annex branch`);
  }
  const mirrorTags = [...upRefs.keys()]
    .filter((r) => r.startsWith("refs/tags/"))
    .map((r) => r.slice("refs/tags/".length));
  const vTags = [...nemarRefs.keys()]
    .filter((r) => r.startsWith("refs/tags/v"))
    .map((r) => r.slice("refs/tags/".length));
  const branches = [...nemarRefs.keys()].filter((r) => r.startsWith("refs/heads/release/"));

  const workdir = mkdtempSync(join(opts.workRoot ?? tmpdir(), `nemar-repull-${id}-`));
  const keep = opts.keepWorkdir === true;
  try {
    const nemar = await cloneAt({
      url: nemarUrl,
      dest: join(workdir, "nemar.git"),
      branch: "main",
      extra: ["refs/heads/git-annex"],
      token: opts.github.token,
    });

    const highestTag = highestVTag(vTags);
    const from = await resolveFromTag({
      rows: opts.catalog.versions,
      highestTag,
      flag: opts.fromTag,
      ds,
      readTagged: async (version) => {
        const ref = `refs/tags/v${version}`;
        if (!nemarRefs.has(ref)) return undefined;
        const f = await readOnlyGit(
          ["fetch", "--quiet", "--depth=1", "--no-tags", "origin", `+${ref}:${ref}`],
          {
            cwd: nemar.path,
            env: nemar.env,
          },
        );
        if (f.exitCode !== 0) throw new RepullCannotPlan(`could not fetch ${ref}`);
        const blob = (await readBlobs(nemar.path, [`${ref}:${DESCRIPTION_PATH}`])).get(
          `${ref}:${DESCRIPTION_PATH}`,
        );
        if (!blob) return undefined;
        try {
          return JSON.parse(stripBom(blob.toString("utf8")));
        } catch {
          return null;
        }
      },
    });
    const to = toTagCheck({ flag: opts.toTag, mirrorTags, fromTag: from.tag });
    const blocking = [from.check, to.check].filter(
      (c) => c.status === "refused" && c.code !== "from-tag-not-recorded",
    );
    if (from.tag === null || to.tag === null || blocking.length > 0) {
      return {
        planned: false,
        preflight: [source.check, from.check, to.check],
        reason: (blocking[0] ?? from.check).code ?? "preflight",
        workdir: keep ? workdir : null,
      };
    }
    const fromTag = from.tag;
    const toTag = to.tag;
    if (!mirrorTags.includes(fromTag)) {
      throw new RepullCannotPlan(`the mirrored tag ${fromTag} is not on the GitHub mirror`);
    }

    const upstreamHasAnnex = upRefs.has("refs/heads/git-annex");
    const upstream = await cloneAt({
      url: upUrl,
      dest: join(workdir, "upstream.git"),
      branch: toTag,
      extra: [
        `refs/tags/${toTag}`,
        `refs/tags/${fromTag}`,
        ...(upstreamHasAnnex ? ["refs/heads/git-annex"] : []),
      ],
    });
    for (const repo of [upstream.path, nemar.path]) {
      if ((await objectFormat(repo)) !== "sha1")
        throw new RepullCannotPlan("only SHA-1 repositories are planned");
    }

    const baseRef = await commitAndTree(upstream.path, `refs/tags/${fromTag}`);
    const theirsRef = await commitAndTree(upstream.path, `refs/tags/${toTag}`);
    const oursRef = await commitAndTree(nemar.path, "refs/heads/main");
    const nemarAnnex = await commitAndTree(nemar.path, "refs/heads/git-annex");
    const upstreamAnnex = upstreamHasAnnex
      ? await commitAndTree(upstream.path, "refs/heads/git-annex")
      : null;

    const [baseTree, theirsTree, oursTree] = await Promise.all([
      listTree(upstream.path, baseRef.commit),
      listTree(upstream.path, theirsRef.commit),
      listTree(nemar.path, oursRef.commit),
    ]);
    const budget = new FetchBudget(opts.maxFetchBytes ?? DEFAULT_MAX_FETCH_BYTES);
    const upStore = new BlobStore(
      upstream,
      await missingBlobs(upstream.path, [baseRef.commit, theirsRef.commit]),
      new Map(),
      budget,
    );
    const nemarStore = new BlobStore(
      nemar,
      await missingBlobs(nemar.path, [oursRef.commit]),
      new Map(),
      budget,
    );

    // Version facts first: the description's merge needs N.0.0.
    const descEntry = oursTree.get(DESCRIPTION_PATH);
    if (descEntry) await nemarStore.load([descEntry.oid]);
    const mainVersion = descEntry ? versionOf(nemarStore.get(descEntry.oid)) : null;
    const versions = versionCheck({ rows: opts.catalog.versions, tags: vTags, mainVersion });
    if (versions.next === null) {
      return {
        planned: false,
        preflight: [source.check, from.check, to.check, versions.check],
        reason: versions.check.code ?? "version",
        workdir: keep ? workdir : null,
      };
    }

    const logs = new Map<string, string>();
    const result = await overlay({
      base: baseTree,
      theirs: theirsTree,
      ours: oursTree,
      upstream: upStore,
      nemar: nemarStore,
      ds,
      toTag,
      nextVersion: versions.next,
      prepareDeadKeys: async (keys) => {
        const texts = await readLocationLogsAt(nemar.path, "git-annex", keys);
        keys.forEach((k, i) => logs.set(k, texts[i] ?? ""));
      },
      deadAtNemar: (key) => isDead(logs.get(key) ?? ""),
    });

    // NEMAR's special remotes.
    const remoteLogSpec = "refs/heads/git-annex:remote.log";
    const remoteLog =
      (await readBlobs(nemar.path, [remoteLogSpec])).get(remoteLogSpec)?.toString("utf8") ?? "";
    const nemarRemotes = [...parseRemoteLog(remoteLog).values()].filter(
      (r) => r.name === NEMAR_REMOTE,
    );
    const nemarUuid = nemarRemotes.length === 1 ? (nemarRemotes[0]?.uuid ?? null) : null;
    const refusals: Array<{ code: string; detail: string }> = [];

    // The copy manifest: the delta paths' target keys NEMAR does not hold and are not dead.
    const keyPaths = new Map<string, string[]>();
    for (const d of result.decisions) {
      if (!d.delta || d.target.kind !== "annex") continue;
      const list = keyPaths.get(d.target.key) ?? [];
      list.push(d.path);
      keyPaths.set(d.target.key, list);
    }
    const missingLogs = [...keyPaths.keys()].filter((k) => !logs.has(k));
    if (missingLogs.length > 0) {
      const texts = await readLocationLogsAt(nemar.path, "git-annex", missingLogs);
      missingLogs.forEach((k, i) => logs.set(k, texts[i] ?? ""));
    }
    // Presence: the location log by default; a listing of the bucket when the administrator asks
    // for one (the log can claim content the bucket never received, #1396). A dead key is judged
    // first: its object can outlive the mark under the governance lock, and is still never copied
    // nor named.
    const nemarRecord = nemarRemotes.length === 1 ? nemarRemotes[0] : undefined;
    const region = nemarRecord
      ? (datacenterOf(remoteLog, nemarRecord.uuid) ?? "us-east-2")
      : "us-east-2";
    const bucketPrefix = nemarRecord?.fileprefix ?? `${id}/objects/`;
    let listing: Map<string, number> | null = null;
    if (opts.presence === "bucket-listing") {
      if (!nemarRecord?.bucket) {
        throw new RepullCannotPlan("nemar-s3 names no bucket, so there is no bucket to list");
      }
      try {
        listing = await listBucketObjects({
          bucket: nemarRecord.bucket,
          region,
          prefix: bucketPrefix,
          env,
        });
      } catch (err) {
        throw new RepullCannotPlan(
          `the bucket listing failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const isHeld = (key: string, log: string): boolean =>
      listing
        ? isKeyPresentAtDeclaredSize(key, listing)
        : (nemarUuid !== null && presentIn(log).has(nemarUuid)) || result.oursKeys.has(key);
    const copyKeys: string[] = [];
    const deadRecordings: string[] = [];
    let held = 0;
    for (const [key, paths] of [...keyPaths].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const log = logs.get(key) ?? "";
      if (isDead(log)) {
        if (paths.every((p) => RECORDING_PATH.test(p))) {
          deadRecordings.push(key);
        } else {
          refusals.push({
            code: "target-names-dead-key",
            detail: `${paths.length} path(s) would name a key NEMAR's git-annex branch marks dead`,
          });
        }
        continue;
      }
      if (isHeld(key, log)) {
        held++;
        continue;
      }
      copyKeys.push(key);
    }
    const pins: Map<string, PinnedSource[]> =
      upstreamHasAnnex && copyKeys.length > 0
        ? await readPinnedSources(upstream.path, copyKeys, "git-annex")
        : new Map();
    const copyItems: CanonicalJsonValue[] = [];
    const unpinned: string[] = [];
    let copyBytes = 0;
    let copyBytesUnknown = 0;
    for (const key of copyKeys) {
      const pin =
        [...(pins.get(key) ?? [])].filter((p) => p.bucket === UPSTREAM_BUCKET).pop() ?? null;
      const size = keyDigest(key)?.size ?? null;
      if (size === null) copyBytesUnknown++;
      else copyBytes += size;
      if (!pin) unpinned.push(key);
      copyItems.push({
        key,
        paths: (keyPaths.get(key) ?? []).sort(),
        size,
        pin: pin ? { bucket: pin.bucket, object: pin.object, version: pin.version } : null,
      });
    }
    const prefix = await destinationPrefix(nemar.path, id, NEMAR_REMOTE, "git-annex");

    // Local uploads: git blobs NEMAR's policy annexes, moved from the executing host.
    const localUploads = result.decisions
      .filter((d) => d.delta && d.target.kind === "annex-from-git")
      .map((d) => {
        const t = d.target as Extract<Target, { kind: "annex-from-git" }>;
        return { path: d.path, oid: t.oid, size: t.size };
      });
    const localBytes = localUploads.reduce((n, u) => n + (u.size ?? 0), 0);
    const localBytesUnknown = localUploads.filter((u) => u.size === null).length;

    // The privacy ledger (ADR 0085).
    const ledger = await readLedger(oursTree, nemarStore);
    const conflicts = result.decisions.filter((d) => d.class === "conflict");
    const corrections = result.decisions.filter((d) => d.class === "correction");
    const unexplained = conflicts.length + corrections.length;
    if (ledger.status === "unreadable") {
      refusals.push({
        code: "ledger-unreadable",
        detail: `${LEDGER_PATH} does not parse as a ledger`,
      });
    } else if (ledger.recordedCorrections > 0 && unexplained > 0) {
      refusals.push({
        code: "ledger-correction-unexplained",
        detail: `the ledger records ${ledger.recordedCorrections} correction(s) and ${unexplained} path(s) are unexplained; a re-pull could revert one, so it refuses with no override`,
      });
    }
    if (result.gitlinks.length > 0) {
      refusals.push({ code: "gitlink", detail: `${result.gitlinks.length} submodule path(s)` });
    }
    const unknownTargets = result.decisions.filter((d) => d.target.kind === "unknown");
    if (unknownTargets.length > 0) {
      refusals.push({
        code: "target-unknown",
        detail: `${unknownTargets.length} path(s) whose N.0.0 content could not be computed`,
      });
    }

    // Preflight checks that read the remotes once more.
    const marker = nemarRecord?.bucket
      ? await readAnnexUuidMarker({ bucket: nemarRecord.bucket, region, prefix: bucketPrefix, env })
      : null;
    const preflight: Check[] = [
      source.check,
      from.check,
      to.check,
      versions.check,
      await releasePrCheck({
        datasetId: id,
        nextVersion: versions.next,
        branches,
        token: opts.github.token,
        apiBase: opts.github.apiBase,
      }),
      annexUuidCheck({ remoteUuids: nemarRemotes.map((r) => r.uuid), marker }),
    ];

    const renames = pairRenames(result.decisions);
    const renamedFrom = new Set(renames.map((r) => r.from));
    const renamedTo = new Set(renames.map((r) => r.to));
    const deltas = result.decisions.filter((d) => d.delta);
    const deletions = result.decisions.filter((d) => d.deleted);
    const oursSide = (d: PathDecision): Side =>
      result.sides.get(d.path)?.ours ?? { kind: "absent" };
    const isAdd = (d: PathDecision) => d.delta && oursSide(d).kind === "absent";
    const recordingsToRead = deltas.filter((d) => RECORDING_PATH.test(d.path));
    const recordingBytes = recordingsToRead.reduce((n, d) => {
      const t = d.target;
      if (t.kind === "annex") return n + (keyDigest(t.key)?.size ?? 0);
      if (t.kind === "annex-from-git") return n + (t.size ?? 0);
      return n;
    }, 0);
    const dataChanging =
      copyKeys.length > 0 ||
      localUploads.length > 0 ||
      [...deltas, ...deletions].some((d) => {
        const o = oursSide(d);
        const t = d.target;
        return (
          o.kind === "annex" ||
          t.kind === "annex" ||
          t.kind === "annex-from-git" ||
          t.kind === "unannex" ||
          shouldAnnex(d.path, 0)
        );
      });
    const bySubtype = (ds: PathDecision[]) => {
      const out: Record<string, number> = {};
      for (const d of ds) out[d.subtype ?? "none"] = (out[d.subtype ?? "none"] ?? 0) + 1;
      return out;
    };
    const descKeys = result.description.keys;
    const counts = {
      added: deltas.filter((d) => isAdd(d) && !renamedTo.has(d.path)).length,
      changed: deltas.filter((d) => !isAdd(d)).length,
      deleted: deletions.filter((d) => !renamedFrom.has(d.path)).length,
      renamed: renames.length,
      delta_paths: deltas.length,
      upstream_changed: result.decisions.filter((d) => d.upstreamChanged).length,
      unexplained,
      corrections: corrections.length,
      corrections_by_subtype: bySubtype(corrections),
      conflicts: conflicts.length,
      conflicts_by_subtype: bySubtype(conflicts),
      description_corrections: descKeys.filter((k) => k.class === "correction").length,
      description_conflicts: descKeys.filter((k) => k.class === "conflict").length,
      copy_items: copyKeys.length,
      copy_bytes: copyBytes,
      copy_bytes_unknown: copyBytesUnknown,
      copy_unpinned: unpinned.length,
      copy_already_held: held,
      local_uploads: localUploads.length,
      local_bytes: localBytes,
      local_bytes_unknown: localBytesUnknown,
      orphan_bytes_max: copyBytes + localBytes + recordingBytes,
      data_changing: dataChanging,
      metadata_only: !dataChanging,
      doi_count: corrections.length > 0 ? 2 : 1,
      fetched_bytes: budget.used,
      fetch_refused: result.fetchRefused,
    };
    const scrubForecast = {
      recordings_to_read: recordingsToRead.length,
      json_files_to_read: deltas.filter(
        (d) =>
          JSON_PATH.test(d.path) && (d.target.kind === "git" || d.target.kind === "description"),
      ).length,
      scans_tables_to_read: deltas.filter(
        (d) => SCANS_TABLE_PATH.test(d.path) && d.target.kind === "git",
      ).length,
      non_sha256e_recordings: recordingsToRead.filter(
        (d) => d.target.kind === "annex" && keyDigest(d.target.key)?.backend !== "SHA256E",
      ).length,
    };
    const lineageHolds =
      result.gitlinks.length === 0 &&
      result.decisions.every((d) => d.explainedBy.base !== null) &&
      result.description.explainedBase;
    const n1 = corrections.length > 0 ? bumpVersion(versions.next, "patch") : null;

    const body: PlanBody = {
      planner: 1,
      dataset: id,
      upstream: {
        ds,
        from_tag: fromTag,
        to_tag: toTag,
        from_tag_source: from.source as FromTagSource,
        from_commit: baseRef.commit,
        from_tree: baseRef.tree,
        to_commit: theirsRef.commit,
        to_tree: theirsRef.tree,
        annex_commit: upstreamAnnex?.commit ?? null,
      },
      nemar: {
        main_commit: oursRef.commit,
        main_tree: oursRef.tree,
        annex_commit: nemarAnnex.commit,
        concept_doi: result.description.conceptDoi,
      },
      versions: { current: versions.current, n0: versions.next, n1 },
      lineage: { holds: lineageHolds, recordable: lineageHolds && from.source !== "flag" },
      paths: result.decisions.map(pathJson),
      renames: renames.map((r) => ({ from: r.from, to: r.to })),
      description: {
        status: result.description.status,
        keys: descKeys.map((k) => ({ ...k })),
        source_datasets: {
          kept: result.description.sourceDatasets.kept,
          added_by_nemar: result.description.sourceDatasets.addedByNemar,
          removed_by_upstream: result.description.sourceDatasets.removedByUpstream,
        },
        merged_json: result.description.mergedJson,
      },
      corrections: corrections.map((d) => ({ path: d.path, group: d.group, subtype: d.subtype })),
      conflicts: conflicts.map((d) => ({ path: d.path, group: d.group, subtype: d.subtype })),
      copy: {
        presence_basis: listing ? "bucket-listing" : "location-log",
        destination_prefix: prefix,
        items: copyItems,
        unpinned,
        dead_recordings: deadRecordings,
      },
      local_uploads: localUploads,
      scrub_forecast: scrubForecast,
      ledger: {
        status: ledger.status,
        lines: ledger.lines,
        recorded_corrections: ledger.recordedCorrections,
      },
      nemar_owned_edits: await nemarOwnedEdits(oursTree, nemarStore, ds, toTag),
      counts,
      refusals,
    };
    const executable =
      preflight.every((c) => c.status === "ok") && unpinned.length === 0 && refusals.length === 0;
    const file: PlanFile = {
      schema: PLAN_SCHEMA,
      version: PLAN_FILE_VERSION,
      digest: planDigest(body),
      created_at: (opts.now ?? new Date()).toISOString(),
      environment: opts.environment,
      preflight,
      executable,
      body,
    };
    return { planned: true, file, workdir: keep ? workdir : null };
  } finally {
    if (!keep) rmSync(workdir, { recursive: true, force: true });
  }
}

function highestVTag(tags: string[]): string | null {
  let best: { tag: string; parts: number[] } | null = null;
  for (const tag of tags) {
    const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
    if (!m) continue;
    const parts = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!best || compareParts(parts, best.parts) > 0) best = { tag, parts };
  }
  return best?.tag ?? null;
}

function compareParts(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

function versionOf(bytes: Buffer | null): string | null {
  if (!bytes) return null;
  try {
    const v = JSON.parse(stripBom(bytes.toString("utf8")));
    return typeof v?.Version === "string" ? bareVersion(v.Version) : null;
  } catch {
    return null;
  }
}

/** `datacenter=` of one remote in `remote.log`, the region git-annex's S3 remote uses. */
function datacenterOf(remoteLog: string, uuid: string): string | null {
  let found: string | null = null;
  for (const line of remoteLog.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] !== uuid) continue;
    const dc = fields.find((f) => f.startsWith("datacenter="));
    if (dc) found = dc.slice("datacenter=".length);
  }
  return found;
}

async function readLedger(
  tree: Map<string, { oid: string }>,
  store: BlobStore,
): Promise<{ status: "absent" | "ok" | "unreadable"; lines: number; recordedCorrections: number }> {
  const entry = tree.get(LEDGER_PATH);
  if (!entry) return { status: "absent", lines: 0, recordedCorrections: 0 };
  await store.load([entry.oid]);
  const bytes = store.get(entry.oid);
  if (!bytes) return { status: "unreadable", lines: 0, recordedCorrections: 0 };
  try {
    const lines = parseLedgerText(bytes.toString("utf8"));
    return {
      status: "ok",
      lines: lines.length,
      recordedCorrections: lines.filter((l) => l.action !== "import-scrubbed").length,
    };
  } catch {
    return { status: "unreadable", lines: 0, recordedCorrections: 0 };
  }
}

/** The one NEMAR-owned file a re-pull rewrites besides the description: `IsIdenticalTo`. */
async function nemarOwnedEdits(
  tree: Map<string, { oid: string }>,
  store: BlobStore,
  ds: string,
  toTag: string,
): Promise<CanonicalJsonValue[]> {
  const entry = tree.get(NEMAR_METADATA_PATH);
  const to = `10.18112/openneuro.${ds}.v${toTag}`;
  let current: string | null = null;
  if (entry) {
    await store.load([entry.oid]);
    try {
      const meta = JSON.parse(store.get(entry.oid)?.toString("utf8") ?? "");
      const rel = Array.isArray(meta?.related_identifiers) ? meta.related_identifiers : [];
      const hit = rel.find((r: { relation_type?: string }) => r?.relation_type === "IsIdenticalTo");
      current = typeof hit?.identifier === "string" ? hit.identifier : null;
    } catch {
      current = null;
    }
  }
  return [{ path: NEMAR_METADATA_PATH, edit: "is-identical-to", from: current, to }];
}

/** Deleted and added paths with the same content are reported as one rename, never decided. */
function pairRenames(decisions: PathDecision[]): Array<{ from: string; to: string }> {
  const idOf = (t: PathDecision["target"]): string | null =>
    t.kind === "annex" ? `A:${t.key}` : t.kind === "git" ? `G:${t.oid}` : null;
  const oursId = (d: PathDecision): string | null =>
    d.ours.startsWith("A:") ? d.ours : d.ours.startsWith("G:") ? `G:${d.ours.split(":")[2]}` : null;
  const added = decisions.filter((d) => d.delta && d.ours === "absent");
  const used = new Set<string>();
  const out: Array<{ from: string; to: string }> = [];
  for (const del of decisions.filter((d) => d.deleted)) {
    const id = oursId(del);
    if (!id) continue;
    const match = added.find((a) => !used.has(a.path) && idOf(a.target) === id);
    if (!match) continue;
    used.add(match.path);
    out.push({ from: del.path, to: match.path });
  }
  return out;
}

function pathJson(d: PathDecision): CanonicalJsonValue {
  return {
    path: d.path,
    group: d.group,
    base: d.base,
    theirs: d.theirs,
    ours: d.ours,
    upstream_changed: d.upstreamChanged,
    explained_by_base: d.explainedBy.base,
    explained_by_theirs: d.explainedBy.theirs,
    class: d.class,
    subtype: d.subtype,
    decision: d.decision,
    target: { ...d.target } as CanonicalJsonValue,
    delta: d.delta,
    deleted: d.deleted,
  };
}
