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
 *  - `not-a-mirror`, `anonymous-dataset` (a re-pull takes upstream's authors and README, which
 *    would undo ADR 0065's blind; there is no override), `withdrawn`, `import-in-flight`.
 *  - `version-facts-disagree`: the dataset's own version rows must say what the plan says.
 *  - `repull-in-flight` and `tag-already-pulled`.
 *
 * LINEAGE. Decision 4 reserves the basis word `lineage` for a tree compared with upstream's
 * outside the paths NEMAR owns. When the live plan says the from-version's tree was (and the
 * Worker confirms the row names the same tag, or none), create upgrades that row in the same
 * batch. {@link LINEAGE_WRITE_SQL} is the one statement that writes the word, and a source scan
 * keeps it so.
 */

import { z } from "zod";
import {
  isOpenNeuroTag,
  normalizeUpstreamTag,
  sameUpstreamTag,
} from "../../../shared/openneuro-tag.js";
import {
  DIGEST_RE,
  IMMUTABLE_ONCE_SET,
  MERGE_CLAIM_COLUMNS,
  NEMAR_VERSION_RE,
  REPULL_STATUSES,
  type RepullRow,
  type RepullStatus,
  SCREEN_GATED_STATUSES,
  SHA_RE,
  TERMINAL_STATUSES,
  TRANSITION_FIELDS,
  VERIFIED_ONLY_STATUSES,
  canTransition,
  fieldProblem,
  isRepullStatus,
  nextMajorVersion,
} from "../../../shared/repull-state.js";
import { AUDIT_IF_PREVIOUS_CHANGED_SQL, auditLogParams } from "../db/audit-log.js";
import type { Bindings } from "../types/bindings.js";
import { isValidDatasetId } from "./datasetId.js";
import { resolveImportError } from "./import-error.js";

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
 * The next attempt number for a tag, and how many earlier attempts forbid another. An attempt
 * blocks unless it ended `abandoned`, `failed` or `superseded`, and it blocks even then when a
 * merge was claimed for it: a merge commit is on `main`, so the tag is pulled whatever the row
 * says. A held merge claim blocks too: the merge may have been sent and its answer lost, and a
 * failed row can keep the claim. `COUNT(CASE ...)` is 0 for no rows, never NULL.
 */
export const REPULL_NEXT_ATTEMPT_SQL = `SELECT COALESCE(MAX(attempt), 0) + 1 AS next,
  COUNT(CASE WHEN status NOT IN ('abandoned', 'failed', 'superseded') OR merge_sha IS NOT NULL
    OR merge_claimed_at IS NOT NULL THEN 1 END) AS blocking
  FROM upstream_repulls WHERE dataset_id = ? AND to_tag = ?`;

export const REPULL_INSERT_SQL = `INSERT INTO upstream_repulls
  (dataset_id, upstream_ds, from_tag, to_tag, attempt, from_version, to_version, plan_digest,
   planner, origin, actor_user_id, status, base_sha, counts)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'administrator', ?, 'planned', ?, ?)`;

/** What create needs from the dataset row and from the import that may be running on it. */
export const CREATE_FACTS_SQL = `SELECT d.source AS source, d.source_id AS source_id,
  d.anonymous AS anonymous, d.withdrawn_at AS withdrawn_at, ij.status AS import_status
  FROM datasets d LEFT JOIN import_jobs ij ON ij.dataset_id = d.dataset_id
  WHERE d.dataset_id = ?`;

export const VERSION_FACTS_SQL =
  "SELECT version, source_version, source_version_basis FROM dataset_versions WHERE dataset_id = ?";

/**
 * The one writer of the basis word `lineage`. `?1` the tag, `?2` the dataset, `?3` the version in
 * its bare spelling; rows spell a version `1.0.0` or `v1.0.0`, so both are matched. It writes
 * only a row that was never examined (NULL/NULL) or that already names this same tag by `doi` or
 * `lineage`; a row recorded `unknown`, or naming another tag, is never overwritten.
 */
export const LINEAGE_WRITE_SQL = `UPDATE dataset_versions SET source_version = ?1, source_version_basis = 'lineage'
 WHERE dataset_id = ?2 AND version IN (?3, 'v' || ?3)
   AND ((source_version_basis IS NULL AND source_version IS NULL)
        OR (source_version_basis IN ('doi', 'lineage') AND source_version = ?1))`;

/**
 * The audit row of a create: `?1` the actor, `?2` the details JSON, `?3` 1 when the statement
 * before it was the lineage write (so `changes()` is its count). It reads `last_insert_rowid()`
 * for the row's id, which the lineage UPDATE in between does not move.
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
    const problem = fieldProblem("counts", value, { to_version: "", patch_version: null });
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  })
  .transform((value) => value as Record<string, number>);

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
  })
  .strict()
  .superRefine((body, ctx) => {
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
    error: z.string().max(2000).optional(),
  })
  .strict();

export type TransitionBody = z.infer<typeof transitionSchema>;

// ----------------------------------------------------------------------------
// Rows
// ----------------------------------------------------------------------------

export type RepullRefusal = {
  status: 400 | 403 | 404 | 409;
  code: string;
  message: string;
  /** The row a conflict is about, when naming it helps the caller (never a secret). */
  row?: RepullRow;
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
  const limit = Math.min(Math.max(q.limit ?? 25, 1), 50);
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
  if (env.ENVIRONMENT === "production" || datasetId.startsWith("xx")) return null;
  return {
    status: 403,
    code: "env-fence",
    message:
      "Outside production only an xx dataset is re-pulled, because the nemarDatasets organization is shared with production.",
  };
}

const IN_FLIGHT_IMPORT = new Set(["preparing", "copying", "finalizing"]);

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

export async function createRepull(
  env: Bindings,
  admin: { id: number },
  input: CreateRepullBody,
): Promise<{ row: RepullRow; created: boolean } | RepullRefusal> {
  const body: CreateRepullBody = {
    ...input,
    from_tag: normalizeUpstreamTag(input.from_tag),
    to_tag: normalizeUpstreamTag(input.to_tag),
  };
  const db = env.DB;

  const fence = envFenceRefusal(env, body.dataset_id);
  if (fence) return fence;

  const [factsRes, versionsRes, openRes] = await db.batch([
    db.prepare(CREATE_FACTS_SQL).bind(body.dataset_id),
    db.prepare(VERSION_FACTS_SQL).bind(body.dataset_id),
    db.prepare(REPULL_OPEN_FOR_DATASET_SQL).bind(body.dataset_id),
  ]);
  const facts = (
    factsRes?.results as
      | Array<{
          source: string | null;
          source_id: string | null;
          anonymous: number;
          withdrawn_at: string | null;
          import_status: string | null;
        }>
      | undefined
  )?.[0];
  if (!facts) {
    return { status: 404, code: "not-found", message: `No dataset ${body.dataset_id}.` };
  }
  if (facts.source !== "openneuro" || facts.source_id !== body.upstream_ds) {
    return {
      status: 409,
      code: "not-a-mirror",
      message: `${body.dataset_id} is not recorded as a mirror of ${body.upstream_ds}.`,
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
    return { status: 409, code: "withdrawn", message: `${body.dataset_id} is withdrawn.` };
  }
  if (facts.import_status !== null && IN_FLIGHT_IMPORT.has(facts.import_status)) {
    return {
      status: 409,
      code: "import-in-flight",
      message: `An import of ${body.dataset_id} is ${facts.import_status}; wait for it to finish.`,
    };
  }

  const open = (openRes?.results as RawRow[] | undefined)?.[0];
  const sameOpen = (raw: RawRow | undefined) =>
    raw !== undefined && raw.to_tag === body.to_tag && raw.plan_digest === body.plan_digest;
  // An open record for this very plan is returned before the version rows are consulted: once
  // N.0.0 is merged and tagged the highest version is no longer the plan's `from_version`, and a
  // rerun must still find its record.
  if (open) {
    const row = parseRow(open);
    if (sameOpen(open)) return { row, created: false };
    return inFlight(row);
  }

  const problem = versionFactsProblem(
    (versionsRes?.results ?? []) as VersionFactRow[],
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

  let inserted: number;
  try {
    const results = await db.batch(statements);
    inserted = Number(results[0]?.meta?.last_row_id);
  } catch (err) {
    if (!looksUnique(err)) throw err;
    // A concurrent create won the dataset's one open slot (or the attempt number) between the
    // read above and this write, and the batch rolled back. Answer from what is there now.
    const now = (await db
      .prepare(REPULL_OPEN_FOR_DATASET_SQL)
      .bind(body.dataset_id)
      .first<RawRow>()) as RawRow | null;
    if (!now) throw err;
    const row = parseRow(now);
    return sameOpen(now) ? { row, created: false } : inFlight(row);
  }
  const row = await getRepull(db, inserted);
  if (!row) throw new Error(`upstream_repulls row ${inserted} was not readable after its insert`);
  return { row, created: true };
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

/**
 * Move a row along one edge. Every check that can be made without a second system is made here:
 * the edge, the states a caller may not state, the columns and their shapes, what is immutable
 * once set, and a held merge claim. Then one compare-and-set: the update applies only to a row
 * still at `from`, so two writers cannot both take the same step.
 *
 * `last_error` goes through {@link resolveImportError} (ADR 0051): a specific message is never
 * overwritten by a generic one. A transition that sends no `error` leaves it alone.
 */
export async function transitionRepull(
  env: Bindings,
  admin: { id: number },
  id: number,
  t: { from: RepullStatus; to: RepullStatus; fields?: Record<string, unknown>; error?: string },
): Promise<{ row: RepullRow } | RepullRefusal> {
  const db = env.DB;
  const row = await getRepull(db, id);
  if (!row) return { status: 404, code: "not-found", message: `No re-pull #${id}.` };

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
  if ((VERIFIED_ONLY_STATUSES as readonly string[]).includes(t.to)) {
    return {
      status: 409,
      code: "use-verified-route",
      message: `${t.to} is written only by the route that reads GitHub and the version row itself.`,
      row,
    };
  }
  if ((SCREEN_GATED_STATUSES as readonly string[]).includes(t.to)) {
    return {
      status: 409,
      code: "screen-not-built",
      message: `${t.to} needs the identifier screen bound to the row, which this route cannot state.`,
      row,
    };
  }
  const claimColumn = (MERGE_CLAIM_COLUMNS as Record<string, keyof RepullRow>)[t.to];
  if (claimColumn && row[claimColumn] !== null) {
    return {
      status: 409,
      code: "merge-claim-held",
      message: `A merge was claimed for re-pull #${id}; read GitHub before closing it, because the pull request may have merged.`,
      row,
    };
  }

  const spec = TRANSITION_FIELDS[t.to];
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
  for (const key of spec.must) {
    if (fields[key] === undefined || fields[key] === null) {
      return {
        status: 400,
        code: "field-missing",
        message: `An edge into ${t.to} must set ${key}.`,
      };
    }
  }
  if (t.to === "failed" && !t.error?.trim()) {
    return { status: 400, code: "field-missing", message: "An edge into failed must say why." };
  }
  for (const [key, value] of Object.entries(fields)) {
    const problem = fieldProblem(key, value, row, fields);
    if (problem) return { status: 400, code: "field-invalid", message: problem };
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

  // Column names below come from TRANSITION_FIELDS, checked against `may` above: never a request.
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
  if (t.error !== undefined) {
    sets.push("last_error = ?");
    binds.push(resolveImportError(row.last_error, t.error));
  }
  sets.push("updated_at = datetime('now')");
  sets.push(
    `terminal_at = ${(TERMINAL_STATUSES as readonly string[]).includes(t.to) ? "datetime('now')" : "NULL"}`,
  );

  const update = db
    .prepare(`UPDATE upstream_repulls SET ${sets.join(", ")} WHERE id = ? AND status = ?`)
    .bind(...binds, id, t.from);
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
      }),
    }),
  );
  const results = await db.batch([update, audit]);

  const after = await getRepull(db, id);
  if (!after) throw new Error(`upstream_repulls row ${id} vanished during a transition`);
  if ((results[0]?.meta?.changes ?? 0) === 0) {
    return {
      status: 409,
      code: "stale-status",
      message: `Re-pull #${id} moved before this write; it is ${after.status}.`,
      row: after,
    };
  }
  return { row: after };
}
