/**
 * The record of an upstream re-pull: create it, read it, move it along its edges (epic #1046
 * phase 6, #1912; ADR 0111, decisions 3 and 6).
 *
 * The table is `upstream_repulls` (migration 0105); the states and the only edges between them are
 * `shared/repull-state.ts`. This file is the Worker's half. It records and refuses; it never
 * copies, pushes, opens a pull request or sends mail. Execution runs on an administrator's
 * machine and reports each step here, and the Worker checks what it can read itself.
 *
 * FENCES, in the order create applies them, each a refusal code the route returns:
 *  - `env-fence`: outside production only an `xx` dataset is re-pulled, because the
 *    `nemarDatasets` organization is shared between production and dev (decision 6). The test is
 *    "ENVIRONMENT is exactly `production`", not "is not a known non-production value", so an
 *    unset or misspelled binding refuses an `on` dataset.
 *  - `not-found`, `not-a-mirror`, `anonymous-dataset` (a re-pull takes upstream's authors and
 *    README, which would undo ADR 0065's blind; there is no override), `withdrawn`,
 *    `import-in-flight`.
 *  - an open record: for this very plan, and a caller of the record's own origin, it is returned
 *    (200) before anything below, so a rerun finds it after N.0.0 is tagged; for any other plan
 *    or origin it is `repull-in-flight`.
 *  - `merge-unreconciled`: any record of the dataset that holds a merge claim or a merge sha and
 *    is not finished (`complete`, or `patch_declined` after a released N.0.0) blocks every new
 *    record, because a merge may be on `main` with its row not saying so.
 *  - `version-facts-disagree`: the dataset's own version rows must say what the plan says.
 *  - `tag-already-pulled`.
 * These run at create. A transition re-checks the environment fence on every edge, and the
 * mirror, anonymity, withdrawn and import fences on every step toward a merge: dispatching the
 * screen, the edges into the gates-clear states and the claim to merge.
 *
 * THE SCREEN AND THE CAP (ADR 0111, decisions 6 and 7). The edges into `gates_clear` and
 * `patch_gates_clear` are taken only while the identifier screen bound to the row
 * (`upstream-repull-screen.ts`) passes for the recorded head, and the claim to merge only while
 * it passes for the claimed head and the day's merge cap (`REPULL_DAILY_MERGE_CAP`) has a unit
 * left. Before either, the Worker reads the live pull request on GitHub: open, unmerged, aimed at
 * `main`, its head the sha being gated or claimed. Each re-asserts the screen's verdict in the
 * statement that writes; the claim also re-asserts the cap and that the dataset is neither
 * anonymous nor withdrawn, so those are atomic with it, while the mirror and import fences and
 * the live head are read first. A refusal writes nothing (ADR 0099).
 *
 * THE AUTOMATIC CREATE (ADR 0111, decision 6). A create that carries `dispatch_id` and
 * `dispatch_token` is a dispatched run's, and is the only way a record is written with
 * `origin = 'automatic'`. Before the fences above, in order: exact production
 * (`auto-production-only`), the open switch (`auto-repull-off`), an `on` dataset
 * (`auto-on-only`); then the dispatch (`upstream-repull-dispatch.ts`: it exists, is live, its token
 * is the Worker's, and it names this dataset, `ds` and both tags); then the plan: this planner
 * (`auto-planner-version`), zero unexplained paths, conflicts and corrections, each stated
 * (`auto-not-clean-plan`), and a copy of stated size within the bound (`auto-copy-too-large`). The
 * insert links the dispatch to its record in the same batch.
 *
 * `lineage_recordable` is an administrator's assertion: the Worker has no evidence of it (it holds
 * neither tree), so it is recorded in the audit row and nothing here verifies it.
 *
 * LINEAGE. Decision 4 reserves the basis word `lineage` for a tree compared with upstream's
 * outside the paths NEMAR owns. When the plan asserts that of the from-version's tree (and the
 * Worker confirms the row names the same tag, or none), create upgrades that row in the same
 * batch, one way: `doi` becomes `lineage` and nothing writes it back. {@link LINEAGE_WRITE_SQL}
 * is the one statement that writes the word, and a source scan keeps it so.
 *
 * NO MAIL. Nothing here or in the routes imports a mail service, and a source scan keeps it so.
 */

import { z } from "zod";
import {
  isOpenNeuroTag,
  normalizeUpstreamTag,
  sameUpstreamTag,
} from "../../../shared/openneuro-tag.js";
import {
  ACKNOWLEDGMENT_MAX_LENGTH,
  ACKNOWLEDGMENT_MIN_LENGTH,
} from "../../../shared/publication-limits.js";
import {
  AUTO_MAX_COPY_BYTES,
  CLEARING_SELF_EDGES,
  CURRENT_PLANNER_VERSION,
  DIGEST_RE,
  DISPATCH_TOKEN_RE,
  type DispatchRow,
  IMMUTABLE_ONCE_SET,
  MERGE_CLAIM_COLUMNS,
  NEMAR_VERSION_RE,
  PULL_REQUEST_COLUMNS,
  REPULL_PULL_REQUESTS,
  REPULL_STATUSES,
  type RepullPullRequest,
  type RepullRow,
  type RepullStatus,
  SHA_RE,
  TERMINAL_STATUSES,
  VERIFIED_ONLY_STATUSES,
  WORKER_COUNT_KEYS,
  canTransition,
  fieldProblem,
  fieldsFor,
  isRepullStatus,
  isTerminal,
  nextMajorVersion,
  pullRequestOfGatesStatus,
} from "../../../shared/repull-state.js";
import { AUDIT_IF_PREVIOUS_CHANGED_SQL, auditLogParams } from "../db/audit-log.js";
import type { Bindings } from "../types/bindings.js";
import { isValidDatasetId } from "./datasetId.js";
import { isScreenExempt, readStoredReport } from "./identifier-screen-stored.js";
import { resolveImportError } from "./import-error.js";
import {
  type CapReading,
  REPULL_CAP_MAX,
  autoRepullEnabled,
  isExactProduction,
  repullMergeCap,
} from "./repull-switches.js";
import {
  DISPATCH_LINK_BY_KEY_SQL,
  DISPATCH_LINK_SQL,
  verifyAutomaticDispatch,
} from "./upstream-repull-dispatch.js";
import { liveHeadRefusal } from "./upstream-repull-github.js";
import {
  type RepullScreenGate,
  type RepullScreenStart,
  type RepullScreenView,
  type SqlGuard,
  acknowledgeRepullScreenRow,
  listRepullScreenRows,
  readRepullScreen,
  repullScreenGate,
  repullScreenView,
  startRepullScreen,
} from "./upstream-repull-screen.js";

// ----------------------------------------------------------------------------
// SQL. Exported so a test runs the statement the route runs, never a copy.
// ----------------------------------------------------------------------------

const TERMINAL_LIST = TERMINAL_STATUSES.map((s) => `'${s}'`).join(", ");

export const REPULL_BY_ID_SQL = "SELECT * FROM upstream_repulls WHERE id = ?";

/** The one open row of a dataset, if any (the partial unique index allows at most one). */
export const REPULL_OPEN_FOR_DATASET_SQL = `SELECT * FROM upstream_repulls WHERE dataset_id = ? AND status NOT IN (${TERMINAL_LIST})`;

/**
 * Keyset on `id DESC`. `?1` dataset or NULL, `?2` 1 for open rows only, `?3` the last id seen or
 * NULL, `?4` the page size. Never an `IN (...)` list: D1 binds at most 100 parameters.
 */
export const REPULL_LIST_SQL = `SELECT * FROM upstream_repulls
  WHERE (?1 IS NULL OR dataset_id = ?1)
    AND (?2 = 0 OR status NOT IN (${TERMINAL_LIST}))
    AND (?3 IS NULL OR id < ?3)
  ORDER BY id DESC LIMIT ?4`;

/**
 * The next attempt number for a tag, and how many earlier attempts forbid another: any that did
 * not end `abandoned`, `failed` or `superseded`, and any that holds a merge sha (a `failed` row
 * that was merged and tagged is exempt from {@link MERGE_UNRECONCILED_SQL} but still pulled the
 * tag). A failed or abandoned attempt that holds a claim is caught earlier, for the whole
 * dataset, by {@link MERGE_UNRECONCILED_SQL}.
 * `COUNT(CASE ...)` is 0 for no rows, never NULL.
 */
export const REPULL_NEXT_ATTEMPT_SQL = `SELECT COALESCE(MAX(attempt), 0) + 1 AS next,
  COUNT(CASE WHEN status NOT IN ('abandoned', 'failed', 'superseded')
    OR merge_sha IS NOT NULL THEN 1 END) AS blocking
  FROM upstream_repulls WHERE dataset_id = ? AND to_tag = ?`;

/**
 * A record of the dataset, in any status, that holds a merge claim or a merge sha for either pull
 * request and is not finished. `complete` is finished, and so is `patch_declined`: it is only
 * reachable from a released N.0.0 and is refused while the patch claim is held. A `failed` row
 * that has a tag sha and no patch claim or patch merge is finished too: N.0.0 is merged and
 * tagged, so the merge is reconciled (the tag itself is held by {@link REPULL_NEXT_ATTEMPT_SQL}).
 * A row that holds a claim or a merge sha but no tag sha (a lost merge answer, a merge with no
 * tag yet), or any patch claim or patch merge, is not finished whatever its status: the merge
 * may be on `main` with nothing saying so, and a second major would be a second DOI. Reconciling
 * those is Phase 6f's.
 */
export const MERGE_UNRECONCILED_SQL = `SELECT id, to_tag, status FROM upstream_repulls
  WHERE dataset_id = ? AND status NOT IN ('complete', 'patch_declined')
    AND (merge_claimed_at IS NOT NULL OR merge_sha IS NOT NULL
         OR patch_merge_claimed_at IS NOT NULL OR patch_merge_sha IS NOT NULL)
    AND NOT (status = 'failed' AND tag_sha IS NOT NULL
             AND patch_merge_claimed_at IS NULL AND patch_merge_sha IS NULL)
  ORDER BY id LIMIT 1`;

export const REPULL_BY_ATTEMPT_SQL =
  "SELECT * FROM upstream_repulls WHERE dataset_id = ? AND to_tag = ? AND attempt = ?";

/** The page size of a list, and the most a caller may ask for. */
export const REPULL_PAGE_DEFAULT = 25;
export const REPULL_PAGE_MAX = 50;

/**
 * The insert of a new record. `origin` is bound, never stated by a request: the service binds
 * `automatic` only for a create that presented a live, Worker-signed dispatch, and `administrator`
 * for every other.
 */
export const REPULL_INSERT_SQL = `INSERT INTO upstream_repulls
  (dataset_id, upstream_ds, from_tag, to_tag, attempt, from_version, to_version, plan_digest,
   planner, origin, actor_user_id, status, base_sha, counts)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)`;

/** What create needs from the dataset row and from the import that may be running on it. */
export const CREATE_FACTS_SQL = `SELECT d.source AS source, d.source_id AS source_id,
  d.anonymous AS anonymous, d.withdrawn_at AS withdrawn_at, ij.status AS import_status
  FROM datasets d LEFT JOIN import_jobs ij ON ij.dataset_id = d.dataset_id
  WHERE d.dataset_id = ?`;

export const VERSION_FACTS_SQL =
  "SELECT version, source_version, source_version_basis FROM dataset_versions WHERE dataset_id = ?";

/**
 * The one writer of the basis word `lineage`. `?1` the tag (bare), `?2` the dataset, `?3` the
 * version in its bare spelling. Rows spell a version `1.0.0` or `v1.0.0` and a tag `1.0.0` or
 * `v1.0.0`, so both spellings of each are matched, as the facts check does with
 * `sameUpstreamTag`; the tag is written bare. It writes only a row that was never examined
 * (NULL/NULL) or that already names this same tag by `doi` or `lineage`; a row recorded
 * `unknown`, or naming another tag, is never overwritten. The upgrade is one way.
 */
export const LINEAGE_WRITE_SQL = `UPDATE dataset_versions SET source_version = ?1, source_version_basis = 'lineage'
 WHERE dataset_id = ?2 AND version IN (?3, 'v' || ?3)
   AND ((source_version_basis IS NULL AND source_version IS NULL)
        OR (source_version_basis IN ('doi', 'lineage') AND source_version IN (?1, 'v' || ?1)))`;

/**
 * The audit row of a create: `?1` the actor, `?2` the details JSON, `?3` 1 when the statement
 * before it was the lineage write (so `changes()` is its count). It reads `last_insert_rowid()`
 * for the row's id, which the lineage UPDATE in between does not move; the response does not
 * rely on it, it looks the row up by `(dataset_id, to_tag, attempt)`.
 */
export const AUDIT_CREATED_SQL = `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
  SELECT ?1, 'repull_created', 'upstream_repull', CAST(last_insert_rowid() AS TEXT),
    json_set(?2, '$.lineage_rows', CASE WHEN ?3 = 1 THEN changes() ELSE 0 END)`;

// ----------------------------------------------------------------------------
// Request bodies
// ----------------------------------------------------------------------------

const countsSchema = z
  .record(z.string(), z.unknown())
  .superRefine((value, ctx) => {
    const problem =
      fieldProblem("counts", value, { to_version: "", patch_version: null }) ??
      workerCountProblem(value);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  })
  .transform((value) => value as Record<string, number>);

/** A count only the Worker writes, named in a request; null when there is none. */
function workerCountProblem(counts: unknown): string | null {
  if (typeof counts !== "object" || counts === null) return null;
  const named = Object.keys(counts).find((k) =>
    (WORKER_COUNT_KEYS as readonly string[]).includes(k),
  );
  return named
    ? `counts.${named} is written only by the Worker, from what it read on GitHub`
    : null;
}

export const createRepullSchema = z
  .object({
    dataset_id: z.string().refine(isValidDatasetId, "not a dataset id"),
    upstream_ds: z.string().regex(/^ds\d{6}$/, "upstream_ds must look like ds004362"),
    from_tag: z.string().refine(isOpenNeuroTag, "not an OpenNeuro tag"),
    to_tag: z.string().refine(isOpenNeuroTag, "not an OpenNeuro tag"),
    from_version: z.string().regex(NEMAR_VERSION_RE, "from_version must be N.N.N"),
    to_version: z.string().regex(NEMAR_VERSION_RE, "to_version must be N.N.N"),
    plan_digest: z.string().regex(DIGEST_RE, "plan_digest must be sha256: and 64 hex digits"),
    planner: z.number().int().min(1).max(1000),
    base_sha: z.string().regex(SHA_RE, "base_sha must be a 40-character lowercase hex id"),
    lineage_recordable: z.boolean(),
    counts: countsSchema.default({}),
    // The automatic path: the dispatch the run was sent, and its token. Both or neither; `origin`
    // is not in the schema, so no caller states it (a create with a live, Worker-signed dispatch
    // is automatic, and every other is the administrator's).
    dispatch_id: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    dispatch_token: z
      .string()
      .regex(DISPATCH_TOKEN_RE, "dispatch_token must be the token the dispatch was sent")
      .optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if ((body.dispatch_id === undefined) !== (body.dispatch_token === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["dispatch_token"],
        message: "dispatch_id and dispatch_token are sent together or not at all",
      });
    }
    if (body.to_version !== nextMajorVersion(body.from_version)) {
      ctx.addIssue({
        code: "custom",
        path: ["to_version"],
        message: "to_version must be the next major of from_version",
      });
    }
    if (sameUpstreamTag(body.from_tag, body.to_tag)) {
      ctx.addIssue({
        code: "custom",
        path: ["to_tag"],
        message: "to_tag must differ from from_tag",
      });
    }
  });

export type CreateRepullBody = z.infer<typeof createRepullSchema>;

export const transitionSchema = z
  .object({
    from: z.enum(REPULL_STATUSES),
    to: z.enum(REPULL_STATUSES),
    fields: z.record(z.string(), z.unknown()).default({}),
    // Never blank: `last_error` must not hold an empty string (ADR 0051 compares against it).
    error: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

export type TransitionBody = z.infer<typeof transitionSchema>;

// ----------------------------------------------------------------------------
// Rows
// ----------------------------------------------------------------------------

export type RepullRefusal = {
  status: 400 | 401 | 403 | 404 | 409 | 429 | 502 | 503;
  code: string;
  message: string;
  /** The row a conflict is about, when naming it helps the caller (never a secret). */
  row?: RepullRow;
  /** The screen a refusal is about, as the API shows it. */
  screen?: RepullScreenView;
  /** The merge cap in force and today's claims, on a refusal by the cap. */
  merge_cap?: MergeCapState;
};

export function isRefusal(value: unknown): value is RepullRefusal {
  return typeof value === "object" && value !== null && "code" in value && "status" in value;
}

type RawRow = Omit<RepullRow, "counts"> & { counts: string };

function parseRow(raw: RawRow): RepullRow {
  let counts: Record<string, number> = {};
  try {
    const parsed: unknown = JSON.parse(raw.counts);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      counts = parsed as Record<string, number>;
    }
  } catch {
    // json_valid(counts) is a CHECK, so this cannot happen; an unreadable value reads as empty.
  }
  return { ...raw, counts };
}

export async function getRepull(db: D1Database, id: number): Promise<RepullRow | null> {
  const raw = await db.prepare(REPULL_BY_ID_SQL).bind(id).first<RawRow>();
  return raw ? parseRow(raw) : null;
}

export async function listRepulls(
  db: D1Database,
  q: { dataset?: string; open?: boolean; after?: number; limit?: number },
): Promise<RepullRow[]> {
  const limit = Math.min(Math.max(q.limit ?? REPULL_PAGE_DEFAULT, 1), REPULL_PAGE_MAX);
  const { results } = await db
    .prepare(REPULL_LIST_SQL)
    .bind(q.dataset ?? null, q.open ? 1 : 0, q.after ?? null, limit)
    .all<RawRow>();
  return results.map(parseRow);
}

// ----------------------------------------------------------------------------
// Fences and facts
// ----------------------------------------------------------------------------

/**
 * Outside production only an `xx` dataset is re-pulled (ADR 0111, decision 6). Exactly
 * `production` lifts the fence; an unset, misspelled or unknown value does not, so a binding that
 * went missing can never admit an `on` dataset.
 */
export function envFenceRefusal(
  env: Pick<Bindings, "ENVIRONMENT">,
  datasetId: string,
): RepullRefusal | null {
  if (isExactProduction(env) || datasetId.startsWith("xx")) return null;
  return {
    status: 403,
    code: "env-fence",
    message:
      "Outside production only an xx dataset is re-pulled, because the nemarDatasets organization is shared with production.",
  };
}

const IN_FLIGHT_IMPORT = new Set(["preparing", "copying", "finalizing"]);

interface DatasetFacts {
  source: string | null;
  source_id: string | null;
  anonymous: number;
  withdrawn_at: string | null;
  import_status: string | null;
}

/**
 * The dataset fences, from the dataset row and its import: a mirror of `upstreamDs`, not
 * anonymous (a re-pull takes upstream's authors and README, which would undo ADR 0065's blind;
 * there is no override), not withdrawn, and no import preparing, copying or finalizing. Create
 * applies them first; a step toward a merge applies them again, because any of them can change
 * while a re-pull is open.
 */
function datasetFactsRefusal(
  facts: DatasetFacts,
  datasetId: string,
  upstreamDs: string,
): RepullRefusal | null {
  if (facts.source !== "openneuro" || facts.source_id !== upstreamDs) {
    return {
      status: 409,
      code: "not-a-mirror",
      message: `${datasetId} is not recorded as a mirror of ${upstreamDs}.`,
    };
  }
  if (facts.anonymous === 1) {
    return {
      status: 409,
      code: "anonymous-dataset",
      message:
        "An anonymous dataset is never re-pulled: the re-pull takes upstream's authors and README, which would undo the blind.",
    };
  }
  if (facts.withdrawn_at !== null) {
    return { status: 409, code: "withdrawn", message: `${datasetId} is withdrawn.` };
  }
  if (facts.import_status !== null && IN_FLIGHT_IMPORT.has(facts.import_status)) {
    return {
      status: 409,
      code: "import-in-flight",
      message: `An import of ${datasetId} is ${facts.import_status}; wait for it to finish.`,
    };
  }
  return null;
}

/** The dataset fences, read fresh, for a step toward a merge. */
export async function datasetFenceRefusal(
  db: D1Database,
  row: Pick<RepullRow, "dataset_id" | "upstream_ds">,
): Promise<RepullRefusal | null> {
  const facts = await db.prepare(CREATE_FACTS_SQL).bind(row.dataset_id).first<DatasetFacts>();
  if (!facts) return { status: 404, code: "not-found", message: `No dataset ${row.dataset_id}.` };
  return datasetFactsRefusal(facts, row.dataset_id, row.upstream_ds);
}

// ----------------------------------------------------------------------------
// The daily merge cap (ADR 0111, decision 6)
// ----------------------------------------------------------------------------

export interface MergeCapState extends CapReading {
  /** Claims made today (UTC), N.0.0's and N.0.1's together. */
  used: number;
}

/**
 * Today's claims to merge, both pull requests together, in a fixed UTC day on D1's own clock
 * (ADR 0099: a fixed window). The claim times are `datetime('now')`, so a day's claims are the
 * ones at or after `date('now')` and before the next day; the partial indexes on both columns
 * serve the two ranges. A released claim no longer counts: it was never sent.
 */
const MERGE_CLAIMS_TODAY_EXPR = `(SELECT COUNT(*) FROM upstream_repulls
    WHERE merge_claimed_at >= date('now') AND merge_claimed_at < date('now', '+1 day'))
  + (SELECT COUNT(*) FROM upstream_repulls
    WHERE patch_merge_claimed_at >= date('now') AND patch_merge_claimed_at < date('now', '+1 day'))`;

export const MERGE_CLAIMS_TODAY_SQL = `SELECT ${MERGE_CLAIMS_TODAY_EXPR} AS used`;

/** The condition the claim's own UPDATE carries, `?` the cap: so the count and the claim are one statement. */
export const MERGE_CAP_GUARD_SQL = `(${MERGE_CLAIMS_TODAY_EXPR}) < ?`;

/**
 * The two dataset fences the claim re-asserts in its own statement (`?` the dataset): neither
 * anonymous nor withdrawn. The mirror and import fences are read before it.
 */
export const CLAIM_DATASET_GUARD_SQL =
  "EXISTS (SELECT 1 FROM datasets WHERE dataset_id = ? AND anonymous = 0 AND withdrawn_at IS NULL)";

export async function mergeClaimsToday(db: D1Database): Promise<number> {
  return (await db.prepare(MERGE_CLAIMS_TODAY_SQL).first<{ used: number }>())?.used ?? 0;
}

function mergeCapRefusal(cap: CapReading, used: number): RepullRefusal {
  const merge_cap: MergeCapState = { ...cap, used };
  if (cap.source === "unreadable") {
    // Attention, not a quiet zero: the owner set the binding and it does not read.
    console.error(
      "[upstream-repull] REPULL_DAILY_MERGE_CAP is set but unreadable; it reads 0 and no re-pull merges",
    );
    return {
      status: 429,
      code: "merge-cap-unreadable",
      message: `REPULL_DAILY_MERGE_CAP is set but is not a whole number from 0 to ${REPULL_CAP_MAX}, so it reads 0 and no re-pull is merged until it is corrected.`,
      merge_cap,
    };
  }
  return {
    status: 429,
    code: "merge-cap",
    message:
      cap.value === 0
        ? "REPULL_DAILY_MERGE_CAP is 0: no re-pull is merged."
        : `Today's re-pull merges are used (${used} of ${cap.value}, UTC day); a merge mints a DOI that cannot be withdrawn, so this one waits for tomorrow.`,
    merge_cap,
  };
}

interface VersionFactRow {
  version: string;
  source_version: string | null;
  source_version_basis: string | null;
}

const bare = (version: string) => (version.startsWith("v") ? version.slice(1) : version);

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((p) => Number.parseInt(p, 10));
  const pb = b.split(".").map((p) => Number.parseInt(p, 10));
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] as number) - (pb[i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Why the dataset's own version rows do not match the plan, or null when they do. The highest
 * version (both spellings, by number) must be the plan's `from_version`, and every row at it must
 * name `from_tag` by `doi` or `lineage`, or have never been examined while the plan establishes
 * the lineage itself. A row recorded `unknown` is never re-pulled (ADR 0111, decision 4).
 */
export function versionFactsProblem(
  rows: readonly VersionFactRow[],
  fromVersion: string,
  fromTag: string,
  lineageRecordable: boolean,
): string | null {
  const versions = rows.filter((r) => NEMAR_VERSION_RE.test(bare(r.version)));
  if (versions.length === 0) return "the dataset has no version row";
  let top = bare((versions[0] as VersionFactRow).version);
  for (const r of versions) if (compareVersions(bare(r.version), top) > 0) top = bare(r.version);
  if (top !== fromVersion) {
    return `the highest version is ${top}, and the plan starts from ${fromVersion}`;
  }
  for (const r of versions.filter((v) => bare(v.version) === top)) {
    const basis = r.source_version_basis;
    if (r.source_version === null && basis === null) {
      if (!lineageRecordable) {
        return `version ${r.version} records no upstream tag and the plan cannot establish one`;
      }
      continue;
    }
    if (
      r.source_version !== null &&
      (basis === "doi" || basis === "lineage") &&
      sameUpstreamTag(r.source_version, fromTag)
    ) {
      continue;
    }
    return `version ${r.version} records ${
      r.source_version === null ? `an ${basis ?? "unrecorded"} tag` : `tag ${r.source_version}`
    }, and the plan starts from ${fromTag}`;
  }
  return null;
}

const looksUnique = (err: unknown) => /UNIQUE constraint failed/i.test(String(err));

// ----------------------------------------------------------------------------
// Create
// ----------------------------------------------------------------------------

export interface CreateResult {
  row: RepullRow;
  created: boolean;
  /** Version rows the lineage write upgraded; 0 when the plan did not assert it, or nothing matched. */
  lineage_rows: number;
}

export async function createRepull(
  env: Bindings,
  admin: { id: number },
  input: CreateRepullBody,
): Promise<CreateResult | RepullRefusal> {
  const body: CreateRepullBody = {
    ...input,
    from_tag: normalizeUpstreamTag(input.from_tag),
    to_tag: normalizeUpstreamTag(input.to_tag),
  };
  const automatic = body.dispatch_id !== undefined;
  if (automatic) {
    const refused = automaticEnvRefusal(env, body);
    if (refused) return refused;
  }
  const fence = envFenceRefusal(env, body.dataset_id);
  if (fence) return fence;
  try {
    return await createChecked(env, admin, body);
  } catch (err) {
    if (!looksUnique(err)) throw err;
  }
  // A concurrent create won the dataset's one open slot (or the attempt number) between the reads
  // and the write, and the batch rolled back. Read everything again once: the winner may still be
  // open (answer from it) or may already have gone terminal (the next attempt is then free, or
  // the tag is pulled). A second collision is a real fault and raises. An automatic create reads
  // its dispatch again too: the winner may have linked it.
  return createChecked(env, admin, body);
}

/**
 * What an automatic create needs before anything is read (ADR 0111, decision 6): exact production,
 * the open switch on (so switching it off stops a run before its first write), and an `on`
 * dataset (the `nemarDatasets` organization is shared with dev, and an `xx` re-pull takes the
 * administrator's path only).
 */
function automaticEnvRefusal(env: Bindings, body: CreateRepullBody): RepullRefusal | null {
  if (!isExactProduction(env)) {
    return {
      status: 403,
      code: "auto-production-only",
      message: "An automatic re-pull is recorded only by the production Worker.",
    };
  }
  if (!autoRepullEnabled(env)) {
    return {
      status: 409,
      code: "auto-repull-off",
      message: "AUTO_REPULL_ENABLED is off, so no automatic re-pull is recorded.",
    };
  }
  if (!/^on\d{6}$/.test(body.dataset_id)) {
    return {
      status: 403,
      code: "auto-on-only",
      message: "Only an on mirror is re-pulled automatically.",
    };
  }
  return null;
}

/**
 * What an automatic create's plan must be (ADR 0111, decision 6, "the automatic path takes only a
 * plan with zero unexplained paths"): made by this planner, with `unexplained`, `conflicts` and
 * `corrections` each stated and 0 (a count left out is not 0), and a copy whose size is stated and
 * within {@link AUTO_MAX_COPY_BYTES}. The administrator's path has none of these bounds.
 */
function automaticPlanRefusal(body: CreateRepullBody): RepullRefusal | null {
  if (body.planner !== CURRENT_PLANNER_VERSION) {
    return {
      status: 409,
      code: "auto-planner-version",
      message: `An automatic re-pull takes only a plan of planner ${CURRENT_PLANNER_VERSION}.`,
    };
  }
  const counts = body.counts as Record<string, number | undefined>;
  if (["unexplained", "conflicts", "corrections"].some((k) => counts[k] !== 0)) {
    return {
      status: 409,
      code: "auto-not-clean-plan",
      message:
        "An automatic re-pull takes only a plan that states zero unexplained paths, zero conflicts and zero corrections.",
    };
  }
  const bytes = counts.copy_bytes;
  if (bytes === undefined || bytes > AUTO_MAX_COPY_BYTES) {
    return {
      status: 409,
      code: "auto-copy-too-large",
      message: `An automatic re-pull takes only a plan whose copy size is stated and at most ${AUTO_MAX_COPY_BYTES} bytes.`,
    };
  }
  return null;
}

/** The dispatch checks (an automatic create only), then {@link createOnce}. */
async function createChecked(
  env: Bindings,
  admin: { id: number },
  body: CreateRepullBody,
): Promise<CreateResult | RepullRefusal> {
  if (body.dispatch_id === undefined || body.dispatch_token === undefined) {
    return createOnce(env, admin, body, null);
  }
  const verified = await verifyAutomaticDispatch(env, {
    dispatchId: body.dispatch_id,
    token: body.dispatch_token,
    datasetId: body.dataset_id,
    upstreamDs: body.upstream_ds,
    fromTag: body.from_tag,
    toTag: body.to_tag,
  });
  if (isRefusal(verified)) return verified;
  const plan = automaticPlanRefusal(body);
  if (plan) return plan;
  return createOnce(env, admin, body, verified.dispatch);
}

async function createOnce(
  env: Bindings,
  admin: { id: number },
  body: CreateRepullBody,
  dispatch: DispatchRow | null,
): Promise<CreateResult | RepullRefusal> {
  const db = env.DB;
  const [factsRes, versionsRes, openRes, unreconciledRes] = await db.batch([
    db.prepare(CREATE_FACTS_SQL).bind(body.dataset_id),
    db.prepare(VERSION_FACTS_SQL).bind(body.dataset_id),
    db.prepare(REPULL_OPEN_FOR_DATASET_SQL).bind(body.dataset_id),
    db.prepare(MERGE_UNRECONCILED_SQL).bind(body.dataset_id),
  ]);
  const facts = (factsRes?.results as DatasetFacts[] | undefined)?.[0];
  if (!facts) {
    return { status: 404, code: "not-found", message: `No dataset ${body.dataset_id}.` };
  }
  const fenced = datasetFactsRefusal(facts, body.dataset_id, body.upstream_ds);
  if (fenced) return fenced;

  // An open record for this very plan is returned before the version rows are consulted: once
  // N.0.0 is merged and tagged the highest version is no longer the plan's `from_version`, and a
  // rerun must still find its record.
  // It is returned only to a caller of the same origin: an administrator's create never takes
  // over a record a dispatched run is working on, and a run never takes over an administrator's.
  // A dispatch that names its re-pull (a resume, or one its own create already recorded) takes
  // only that record.
  const origin = dispatch ? "automatic" : "administrator";
  const open = (openRes?.results as RawRow[] | undefined)?.[0];
  if (open) {
    const row = parseRow(open);
    if (
      open.to_tag === body.to_tag &&
      open.plan_digest === body.plan_digest &&
      open.origin === origin &&
      (dispatch?.repull_id ?? open.id) === open.id
    ) {
      if (dispatch && dispatch.repull_id === null) {
        await db.prepare(DISPATCH_LINK_SQL).bind(open.id, dispatch.id).run();
      }
      return { row, created: false, lineage_rows: 0 };
    }
    return inFlight(row);
  }
  if (dispatch && dispatch.repull_id !== null) {
    return {
      status: 409,
      code: "dispatch-mismatch",
      message: `Re-pull dispatch #${dispatch.id} continues re-pull #${dispatch.repull_id}, which is no longer open; it creates no other record.`,
    };
  }

  const stuck = (
    unreconciledRes?.results as Array<{ id: number; to_tag: string; status: string }>
  )?.[0];
  if (stuck) {
    return {
      status: 409,
      code: "merge-unreconciled",
      message: `Re-pull #${stuck.id} of ${body.dataset_id} (${stuck.to_tag}, ${stuck.status}) holds a merge claim or a merge, and nothing has reconciled it with GitHub; a new re-pull would risk a second major.`,
    };
  }

  const versionRows = (versionsRes?.results ?? []) as VersionFactRow[];
  const problem = versionFactsProblem(
    versionRows,
    body.from_version,
    body.from_tag,
    body.lineage_recordable,
  );
  if (problem) {
    return {
      status: 409,
      code: "version-facts-disagree",
      message: `The dataset's version rows disagree with the plan: ${problem}.`,
    };
  }

  const attempt = await db
    .prepare(REPULL_NEXT_ATTEMPT_SQL)
    .bind(body.dataset_id, body.to_tag)
    .first<{ next: number; blocking: number }>();
  if (!attempt || attempt.blocking > 0) {
    return {
      status: 409,
      code: "tag-already-pulled",
      message: `An earlier re-pull of ${body.dataset_id} to ${body.to_tag} is open or reached its merge.`,
    };
  }

  const details = JSON.stringify({
    dataset_id: body.dataset_id,
    from_tag: body.from_tag,
    to_tag: body.to_tag,
    from_version: body.from_version,
    to_version: body.to_version,
    attempt: attempt.next,
    plan_digest: body.plan_digest,
    lineage_recordable: body.lineage_recordable,
    origin,
    ...(dispatch ? { dispatch_id: dispatch.id } : {}),
    // The basis the from-version row(s) held before any upgrade: the upgrade is one way.
    prior_basis: versionRows
      .filter((r) => bare(r.version) === body.from_version)
      .map((r) => r.source_version_basis ?? "unexamined"),
  });
  const statements = [
    db
      .prepare(REPULL_INSERT_SQL)
      .bind(
        body.dataset_id,
        body.upstream_ds,
        body.from_tag,
        body.to_tag,
        attempt.next,
        body.from_version,
        body.to_version,
        body.plan_digest,
        body.planner,
        origin,
        admin.id,
        body.base_sha,
        JSON.stringify(body.counts),
      ),
  ];
  if (body.lineage_recordable) {
    statements.push(
      db.prepare(LINEAGE_WRITE_SQL).bind(body.from_tag, body.dataset_id, body.from_version),
    );
  }
  statements.push(
    db.prepare(AUDIT_CREATED_SQL).bind(admin.id, details, body.lineage_recordable ? 1 : 0),
  );
  // Last, so the audit row above reads the insert's id and the lineage write's count unmoved.
  if (dispatch) {
    statements.push(
      db
        .prepare(DISPATCH_LINK_BY_KEY_SQL)
        .bind(body.dataset_id, body.to_tag, attempt.next, dispatch.id),
    );
  }

  const results = await db.batch(statements);
  const lineageRows = body.lineage_recordable ? (results[1]?.meta?.changes ?? 0) : 0;
  const raw = await db
    .prepare(REPULL_BY_ATTEMPT_SQL)
    .bind(body.dataset_id, body.to_tag, attempt.next)
    .first<RawRow>();
  if (!raw) {
    throw new Error(
      `upstream_repulls ${body.dataset_id} ${body.to_tag} attempt ${attempt.next} was not readable after its insert`,
    );
  }
  return { row: parseRow(raw), created: true, lineage_rows: lineageRows };
}

function inFlight(row: RepullRow): RepullRefusal {
  return {
    status: 409,
    code: "repull-in-flight",
    message: `A re-pull of ${row.dataset_id} to ${row.to_tag} (#${row.id}) is ${row.status}; finish or abandon it first.`,
    row,
  };
}

// ----------------------------------------------------------------------------
// Transition
// ----------------------------------------------------------------------------

/** The two self-edges that record a claim to merge, and the pull request each claims for. */
const CLAIM_EDGES: Readonly<Partial<Record<RepullStatus, RepullPullRequest>>> = {
  gates_clear: "n0",
  patch_gates_clear: "n1",
};

/** Not for a request: what an internal caller of {@link prepareTransition} may do. */
export interface TransitionOptions {
  /**
   * The caller read GitHub or the version row itself (`upstream-repull-verified.ts`), so it may
   * write the states and counts a request cannot state. Never set from a request body.
   */
  verified?: boolean;
  /** What the audit row records beside the edge: what the caller read, never a path or a key. */
  auditDetails?: Record<string, unknown>;
}

/** A transition checked and built, not yet run. */
export interface PreparedTransition {
  row: RepullRow;
  update: D1PreparedStatement;
  audit: D1PreparedStatement;
  /**
   * Why the update matched nothing when the row itself had not moved: one of the conditions it
   * carries beyond the compare-and-set (the screen's verdict, the day's merge cap) failed.
   */
  guardRefusal?: () => Promise<RepullRefusal>;
}

function screenRefusal(
  gate: Extract<RepullScreenGate, { ok: false }>,
  row: RepullRow,
): RepullRefusal {
  return {
    status: 409,
    code: "screen-not-clear",
    message: `${gate.message} (gate: ${gate.gate})`,
    row,
  };
}

function screenChanged(row: RepullRow): RepullRefusal {
  return {
    status: 409,
    code: "screen-changed",
    message: `The identifier screen of re-pull #${row.id} changed while this write was checked; read it again.`,
    row,
  };
}

/**
 * Move a row along one edge. Every check that can be made without a second system is made here:
 * the edge, the states a caller may not state, the columns and their shapes, what is immutable
 * once set, and a held merge claim. Then one compare-and-set on the row's status AND revision as
 * they were read: the update applies only to that exact version of the row, so of two writers that
 * read the same row only one applies, even when both repeat the same status. That also makes the
 * checks above sound against other transitions: nothing they read can have been changed by one
 * by the time the update applies, so the immutable columns and a claim set after the read need no
 * separate guard in the statement. The loser is told the row has moved (`stale-status`) and
 * nothing is written. That holds for transitions only: deleting the dataset deletes the record
 * without touching its revision, and a row gone by then answers 404.
 *
 * Two kinds of edge read a second table, and re-assert what they read in the same statement:
 *  - into `gates_clear` or `patch_gates_clear`: the gates sha must be the recorded head, the
 *    dataset fences must hold, and the identifier screen bound to the row must pass for that head
 *    (ADR 0111, decision 7); the statement re-checks the screen's verdict;
 *  - the claim to merge (the self-edge on either): the dataset fences, the screen for the claimed
 *    head, and a unit of the day's merge cap, counted in the statement that claims it, so two
 *    claims racing for the last unit cannot both win (ADR 0111, decision 6; ADR 0099). The
 *    screen's verdict, the cap and the dataset being neither anonymous nor withdrawn are in the
 *    claim's own statement; the mirror and import fences are a read before it.
 * Both read the live pull request on GitHub first (`liveHeadRefusal`): the caller's word for the
 * head is not taken.
 *
 * `last_error` goes through {@link resolveImportError} (ADR 0051): a specific message is never
 * overwritten by a generic one, and a blank one is refused. An edge into a different, non-terminal
 * status clears the stored error, because the step it describes has since succeeded; an edge that
 * repeats a status, or ends the row, keeps it unless a new one is sent.
 */
export async function transitionRepull(
  env: Bindings,
  admin: { id: number },
  id: number,
  t: { from: RepullStatus; to: RepullStatus; fields?: Record<string, unknown>; error?: string },
): Promise<{ row: RepullRow } | RepullRefusal> {
  const row = await getRepull(env.DB, id);
  if (!row) return { status: 404, code: "not-found", message: `No re-pull #${id}.` };
  const prepared = await prepareTransition(env, admin, row, t);
  if (isRefusal(prepared)) return prepared;
  const done = await commitTransition(env.DB, prepared);
  return isRefusal(done) ? done : { row: done.row };
}

/**
 * The checks of {@link transitionRepull} and the statements it runs, without running them, so a
 * caller that must write more in the same batch (`upstream-repull-verified.ts`) shares every check.
 */
export async function prepareTransition(
  env: Bindings,
  admin: { id: number },
  row: RepullRow,
  t: { from: RepullStatus; to: RepullStatus; fields?: Record<string, unknown>; error?: string },
  opts: TransitionOptions = {},
): Promise<PreparedTransition | RepullRefusal> {
  const db = env.DB;
  const id = row.id;

  const fence = envFenceRefusal(env, row.dataset_id);
  if (fence) return fence;

  if (row.status !== t.from) {
    return {
      status: 409,
      code: "stale-status",
      message: `Re-pull #${id} is ${row.status}, not ${t.from}.`,
      row,
    };
  }
  if (!isRepullStatus(t.to) || !canTransition(t.from, t.to)) {
    return {
      status: 409,
      code: "bad-transition",
      message: `A re-pull cannot go from ${t.from} to ${t.to}.`,
      row,
    };
  }
  const repeats = t.from === t.to;
  if (!repeats && !opts.verified && (VERIFIED_ONLY_STATUSES as readonly string[]).includes(t.to)) {
    return {
      status: 409,
      code: "use-verified-route",
      message: `${t.to} is written only by the route that reads GitHub and the version row itself.`,
      row,
    };
  }
  const claimColumn = (MERGE_CLAIM_COLUMNS as Record<string, keyof RepullRow>)[t.to];
  if (claimColumn && row[claimColumn] !== null) {
    return {
      status: 409,
      code: "merge-claim-held",
      message: `A merge was claimed for re-pull #${id}; read GitHub before closing the pull request or moving its head, because it may have merged.`,
      row,
    };
  }
  const claimPr = repeats ? CLAIM_EDGES[t.to] : undefined;
  const claim = claimPr ? PULL_REQUEST_COLUMNS[claimPr] : undefined;
  if (claim && row[claim.claimedAt] !== null) {
    return {
      status: 409,
      code: "merge-claim-held",
      message: `A merge is already claimed for re-pull #${id}.`,
      row,
    };
  }

  const spec = fieldsFor(t.from, t.to);
  const fields = t.fields ?? {};
  for (const key of Object.keys(fields)) {
    if (!spec.may.includes(key)) {
      return {
        status: 400,
        code: "field-not-allowed",
        message: `${key} cannot be set by an edge into ${t.to}.`,
      };
    }
  }
  if (!opts.verified) {
    const named = workerCountProblem(fields.counts);
    if (named) return { status: 400, code: "field-not-allowed", message: named };
  }
  for (const key of spec.must) {
    if (fields[key] === undefined || fields[key] === null) {
      return {
        status: 400,
        code: "field-missing",
        message: `An edge into ${t.to} must set ${key}.`,
      };
    }
  }
  if (t.error !== undefined && !t.error.trim()) {
    return { status: 400, code: "field-invalid", message: "error must not be blank." };
  }
  if (spec.requiresError && !t.error) {
    return { status: 400, code: "field-missing", message: `This edge into ${t.to} must say why.` };
  }
  for (const [key, value] of Object.entries(fields)) {
    const problem = fieldProblem(key, value, row, fields);
    if (problem) return { status: 400, code: "field-invalid", message: problem };
  }
  if (claim && fields[claim.claimSha] !== row[claim.gates]) {
    return {
      status: 400,
      code: "field-invalid",
      message: `${claim.claimSha} must be the screened head, ${claim.gates}.`,
    };
  }
  for (const key of IMMUTABLE_ONCE_SET) {
    const stored = row[key];
    if (key in fields && stored !== null && stored !== fields[key]) {
      return {
        status: 409,
        code: "immutable-field",
        message: `${key} is already set on re-pull #${id} and does not change.`,
        row,
      };
    }
  }

  // The edges that read the screen (and, for a claim, the cap) and re-assert it when they write.
  const guards: SqlGuard[] = [];
  let guardRefusal: PreparedTransition["guardRefusal"];
  const gatedPr = repeats ? null : pullRequestOfGatesStatus(t.to);
  const screenedPr = gatedPr ?? claimPr ?? null;
  if (screenedPr !== null) {
    const cols = PULL_REQUEST_COLUMNS[screenedPr];
    const sha = (gatedPr ? fields[cols.gates] : fields[cols.claimSha]) as string;
    if (gatedPr && sha !== row[cols.head]) {
      return {
        status: 400,
        code: "field-invalid",
        message: `${cols.gates} must be the recorded head, ${cols.head}: the screen is read on the commit the row names.`,
      };
    }
    const fenced = await datasetFenceRefusal(db, row);
    if (fenced) return { ...fenced, row };
    const gate = await repullScreenGate(db, {
      datasetId: row.dataset_id,
      repullId: id,
      pr: screenedPr,
      sha,
      actorId: admin.id,
    });
    if (!gate.ok) return screenRefusal(gate, row);
    if (!gate.exempt) guards.push(gate.guard);
    guardRefusal = async () => screenChanged(row);
  }
  if (claim) {
    const cap = repullMergeCap(env);
    if (cap.value === 0) return { ...mergeCapRefusal(cap, await mergeClaimsToday(db)), row };
    guards.push({ sql: MERGE_CAP_GUARD_SQL, binds: [cap.value] });
    // Two of the dataset fences ride in the claim's own statement; the other two were read above.
    guards.push({ sql: CLAIM_DATASET_GUARD_SQL, binds: [row.dataset_id] });
    guardRefusal = async () => {
      const used = await mergeClaimsToday(db);
      if (used >= cap.value) return { ...mergeCapRefusal(cap, used), row };
      const fenced = await datasetFenceRefusal(db, row);
      return fenced ? { ...fenced, row } : screenChanged(row);
    };
  }
  if (screenedPr !== null) {
    // GitHub's head, not the caller's: read last, so every refusal that needs no network comes first.
    const cols = PULL_REQUEST_COLUMNS[screenedPr];
    const sha = (gatedPr ? fields[cols.gates] : fields[cols.claimSha]) as string;
    const moved = await liveHeadRefusal(env, row, screenedPr, sha);
    if (moved) return moved;
  }

  // Column names below come from the edge's field list, checked against `may` above: never a request.
  const sets: string[] = ["status = ?"];
  const binds: unknown[] = [t.to];
  for (const key of Object.keys(fields)) {
    if (key === "counts") {
      sets.push("counts = json_patch(counts, ?)");
      binds.push(JSON.stringify(fields.counts));
    } else {
      sets.push(`${key} = ?`);
      binds.push(fields[key]);
    }
  }
  for (const key of spec.reset) if (!(key in fields)) sets.push(`${key} = NULL`);
  // The Worker's own clock, never a request's: see SELF_EDGE_FIELDS.
  for (const key of spec.stamp ?? []) sets.push(`${key} = datetime('now')`);
  const forward = !repeats && !isTerminal(t.to);
  // A self-edge that records its whole stage again says the step it repeats succeeded, so with no
  // error of its own it clears the stale one, as a step that moved on does. Any other repeat, or an
  // edge into a terminal status, keeps it.
  const restated = repeats && (CLEARING_SELF_EDGES as readonly string[]).includes(t.to);
  if (t.error !== undefined) {
    sets.push("last_error = ?");
    binds.push(resolveImportError(forward ? null : row.last_error, t.error));
  } else if (forward || restated) {
    sets.push("last_error = NULL");
  }
  sets.push("revision = revision + 1");
  sets.push("updated_at = datetime('now')");
  sets.push(`terminal_at = ${isTerminal(t.to) ? "datetime('now')" : "NULL"}`);
  const where = ["id = ?", "status = ?", "revision = ?", ...guards.map((g) => g.sql)];

  const update = db
    .prepare(`UPDATE upstream_repulls SET ${sets.join(", ")} WHERE ${where.join(" AND ")}`)
    .bind(...binds, id, t.from, row.revision, ...guards.flatMap((g) => g.binds));
  const audit = db.prepare(AUDIT_IF_PREVIOUS_CHANGED_SQL).bind(
    ...auditLogParams({
      userId: admin.id,
      action: "repull_transition",
      resourceType: "upstream_repull",
      resourceId: String(id),
      details: JSON.stringify({
        dataset_id: row.dataset_id,
        from: t.from,
        to: t.to,
        fields: Object.keys(fields),
        ...opts.auditDetails,
      }),
    }),
  );
  return { row, update, audit, guardRefusal };
}

/**
 * Run a prepared transition, after `before` in the same batch. `before` must be guarded on the
 * row as it was read (its status and revision), so that it applies exactly when the update does:
 * a batch is one transaction, and the update is the only statement in it that moves the row.
 */
export async function commitTransition(
  db: D1Database,
  prepared: PreparedTransition,
  before: D1PreparedStatement[] = [],
): Promise<{ row: RepullRow; results: D1Result[] } | RepullRefusal> {
  const { row } = prepared;
  const results = await db.batch([...before, prepared.update, prepared.audit]);
  const after = await getRepull(db, row.id);
  if (!after) {
    // Deleting a dataset deletes its records without touching the revision, so the row can be
    // gone between the read above and here.
    return { status: 404, code: "not-found", message: `Re-pull #${row.id} was deleted.` };
  }
  if ((results[before.length]?.meta?.changes ?? 0) === 0) {
    if (prepared.guardRefusal && after.status === row.status && after.revision === row.revision) {
      return prepared.guardRefusal();
    }
    return {
      status: 409,
      code: "stale-status",
      message: `Re-pull #${row.id} moved before this write; it is ${after.status}.`,
      row: after,
    };
  }
  return { row: after, results };
}

// ----------------------------------------------------------------------------
// The screen, as the routes reach it
// ----------------------------------------------------------------------------

export const screenTargetSchema = z
  .object({
    pr: z.enum(REPULL_PULL_REQUESTS),
    sha: z.string().regex(SHA_RE, "sha must be a 40-character lowercase hex id"),
  })
  .strict();

export type ScreenTarget = z.infer<typeof screenTargetSchema>;

export const acknowledgeScreenSchema = z
  .object({
    pr: z.enum(REPULL_PULL_REQUESTS),
    sha: z.string().regex(SHA_RE, "sha must be a 40-character lowercase hex id"),
    // The publication path's rule for a reason (ADR 0086), one definition for both.
    reason: z
      .string()
      .trim()
      .min(
        ACKNOWLEDGMENT_MIN_LENGTH,
        `The acknowledgment needs a reason of at least ${ACKNOWLEDGMENT_MIN_LENGTH} characters`,
      )
      .max(
        ACKNOWLEDGMENT_MAX_LENGTH,
        `The acknowledgment is limited to ${ACKNOWLEDGMENT_MAX_LENGTH} characters`,
      ),
  })
  .strict();

export type AcknowledgeScreenBody = z.infer<typeof acknowledgeScreenSchema>;

/**
 * Dispatch the identifier screen of the recorded head of one of the re-pull's pull requests, while
 * that pull request is open and before its gates are clear (`pr_open` for N.0.0,
 * `patch_synthesized` for N.0.1). The environment and dataset fences apply: outside production
 * only an `xx` dataset reaches here, and an `xx` dataset is not screened (ADR 0086), so a
 * non-production Worker never dispatches a screen.
 */
export async function dispatchRepullScreen(
  env: Bindings,
  admin: { id: number },
  id: number,
  body: ScreenTarget,
): Promise<{ outcome: Exclude<RepullScreenStart, { kind: "moved" }> } | RepullRefusal> {
  const db = env.DB;
  const row = await getRepull(db, id);
  if (!row) return { status: 404, code: "not-found", message: `No re-pull #${id}.` };
  const fence = envFenceRefusal(env, row.dataset_id);
  if (fence) return fence;
  const cols = PULL_REQUEST_COLUMNS[body.pr];
  if (row.status !== cols.open) {
    return {
      status: 409,
      code: "not-screenable",
      message: `The ${body.pr} pull request is screened while the re-pull is ${cols.open}; re-pull #${id} is ${row.status}.`,
      row,
    };
  }
  if (row[cols.head] !== body.sha) {
    return {
      status: 409,
      code: "not-the-head",
      message: `The screen is dispatched for the recorded head (${cols.head}); ${body.sha.slice(0, 12)} is not it.`,
      row,
    };
  }
  const fenced = await datasetFenceRefusal(db, row);
  if (fenced) return { ...fenced, row };
  const outcome = await startRepullScreen(env, row, body.pr, body.sha, admin.id);
  if (outcome.kind === "moved") {
    const after = (await getRepull(db, id)) ?? row;
    return {
      status: 409,
      code: "stale-status",
      message: `Re-pull #${id} moved before the screen was recorded; it is ${after.status}.`,
      row: after,
    };
  }
  return { outcome };
}

/**
 * Record an administrator's reason on a screen that asks for one (ADR 0086), for that screen's
 * commit only. A direct identifier cannot be acknowledged, and neither can a screen with no
 * verdict, or one whose report does not name its commit.
 */
export async function acknowledgeRepullScreen(
  env: Bindings,
  admin: { id: number },
  id: number,
  body: AcknowledgeScreenBody,
): Promise<{ screen: RepullScreenView } | RepullRefusal> {
  const db = env.DB;
  const row = await getRepull(db, id);
  if (!row) return { status: 404, code: "not-found", message: `No re-pull #${id}.` };
  const fence = envFenceRefusal(env, row.dataset_id);
  if (fence) return fence;
  if (isTerminal(row.status)) {
    return {
      status: 409,
      code: "bad-transition",
      message: `Re-pull #${id} is ${row.status}; nothing about it is acknowledged any more.`,
      row,
    };
  }
  if (isScreenExempt(row.dataset_id)) {
    return {
      status: 409,
      code: "screen-exempt",
      message: "An xx dataset is not screened, so there is nothing to acknowledge.",
      row,
    };
  }
  const screen = await readRepullScreen(db, id, body.pr, body.sha);
  if (!screen) {
    return {
      status: 404,
      code: "screen-not-found",
      message: `No identifier screen of commit ${body.sha.slice(0, 12)} is recorded for re-pull #${id}.`,
    };
  }
  const view = repullScreenView(screen);
  if (screen.ack_at !== null) {
    return {
      status: 409,
      code: "already-acknowledged",
      message: `This screen was acknowledged by administrator #${screen.ack_by} at ${screen.ack_at}; an acknowledgment is recorded once, and it counts only for that administrator.`,
      row,
      screen: view,
    };
  }
  if (view.gate !== "acknowledge" || readStoredReport(screen.report)?.head !== body.sha) {
    return {
      status: 409,
      code: view.gate === "blocks" ? "screen-blocks" : "screen-not-acknowledgeable",
      message:
        view.gate === "blocks"
          ? `${view.headline}. A direct identifier cannot be acknowledged.`
          : `${view.headline}. Only a screen that asks for a person can be acknowledged, and this one does not (gate: ${view.gate}).`,
      row,
      screen: view,
    };
  }
  const recorded = await acknowledgeRepullScreenRow(db, {
    row: screen,
    datasetId: row.dataset_id,
    adminUserId: admin.id,
    reason: body.reason,
  });
  const after = await readRepullScreen(db, id, body.pr, body.sha);
  if (!recorded || !after) {
    if (after?.ack_at) {
      return {
        status: 409,
        code: "already-acknowledged",
        message: `This screen was acknowledged by administrator #${after.ack_by} at ${after.ack_at} while this request was checked.`,
        row,
        screen: repullScreenView(after),
      };
    }
    return { ...screenChanged(row), ...(after ? { screen: repullScreenView(after) } : {}) };
  }
  return { screen: repullScreenView(after) };
}

/** The screens of a re-pull, newest first; an `xx` dataset is exempt and has none. */
export async function listRepullScreens(
  db: D1Database,
  id: number,
): Promise<{ exempt: boolean; screens: RepullScreenView[] } | RepullRefusal> {
  const row = await getRepull(db, id);
  if (!row) return { status: 404, code: "not-found", message: `No re-pull #${id}.` };
  const exempt = isScreenExempt(row.dataset_id);
  const screens = exempt ? [] : (await listRepullScreenRows(db, id)).map(repullScreenView);
  return { exempt, screens };
}
