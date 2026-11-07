/**
 * What a person reads about their own compute, and what the partner reads in aggregate (epic #2021
 * phase D2, #2023; ADR 0118, the addendum of this phase). Everything here is a READ of Epic A's tables:
 * the pools through `accountPools` and `availableMilli`, the owner policy through `getPolicy`, the
 * ledger entries and the job index rows as they are. No statement here moves a total, and nothing reads
 * the compute switch: these reads work when compute is off.
 *
 * THE EXPOSURE RULE. A person's views are built from NARROW column lists (`USER_JOB_COLUMNS`, the usage
 * statement's own groups), so a column that is not named cannot reach the wire by a careless spread: no
 * flag (`unreserved`, `unattributed`, `mismatch`, `overrun`), no `platform_failure`, no failure detail,
 * no Slurm or Tapis identifier, no gateway pseudonym, no hold figure, no webhook or launch digest, no
 * identity. A job the caller does not own is not there: every statement below carries the account in its
 * WHERE, and a miss and a stranger's job are the same absence. A job the tenant sweep indexed
 * (`flag_unreserved = 1`) is nobody's to read: it is a partner's job that no reservation covered, charged
 * to the partner's pool and never to the person it was matched to.
 *
 * UNKNOWN IS NEVER ZERO. A read that fails throws; the routes let it be a 500. An account with no pool
 * rows reads all zeros because nothing was granted, which is a fact and not a failure.
 *
 * Days are UTC. A window `[from, to]` is both ends inclusive; the SQL is `created_at >= from 00:00:00 AND
 * created_at < (to + 1 day) 00:00:00`, so an entry at 23:59:59 on `to` is in and one at 00:00:00 the
 * next day is out.
 */

import type { ComputeState } from "../../../shared/compute-state.js";
import {
  COMPUTE_TERMS_PUBLISHED,
  COMPUTE_TERMS_VERSION,
} from "../../../shared/contract/compute-terms.js";
import {
  COMPUTE_JOBS_PAGE_DEFAULT,
  COMPUTE_JOBS_PAGE_MAX,
  COMPUTE_USAGE_GROUPS,
  COMPUTE_WINDOW_DEFAULT_DAYS,
  COMPUTE_WINDOW_MAX_DAYS,
  type ComputeMeResponse,
  type ComputeUsageGroup,
  type ComputeUsageRow,
  type ComputeUserJob,
} from "../../../shared/contract/compute-user.js";
import { COMPUTE_POOLS, PARTITIONS, type PartitionName } from "../../../shared/contract/compute.js";
import type { Bindings } from "../types/bindings.js";
import { termsUnpublished } from "./compute-access.js";
import { accountPools, availableMilli } from "./compute-ledger.js";
import { getPolicy } from "./compute-policy.js";
import { computeQueueEstimates } from "./compute-queue-estimates.js";

const DAY_MS = 86_400_000;

// --- Days and windows ----------------------------------------------------------------------------

/** The milliseconds of a `YYYY-MM-DD` day (UTC midnight), or null for anything else, a non-date included. */
export function parseDay(text: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!Number.isFinite(ms)) return null;
  // `Date.UTC` rolls 2026-02-31 over to March: the day must read back the same.
  return new Date(ms).toISOString().slice(0, 10) === text ? ms : null;
}

const dayText = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A resolved window: the two days, and the half-open SQL bounds in the database's own time text. */
export interface UsageWindow {
  from: string;
  to: string;
  /** `created_at >= start`. */
  start: string;
  /** `created_at < end` (midnight after `to`). */
  end: string;
}

/**
 * The window a request asks for. Both absent: the last 30 days ending today (UTC). Only `to`: the 30
 * days ending there. Only `from`: from there to today. `null` for a bad day, a `from` after `to`, or a
 * window of more than 366 days (both ends counted).
 */
export function resolveWindow(
  query: { from?: string | undefined; to?: string | undefined },
  nowMs: number,
): UsageWindow | null {
  const todayMs = parseDay(dayText(nowMs)) as number;
  let toMs = todayMs;
  if (query.to !== undefined) {
    const parsed = parseDay(query.to);
    if (parsed === null) return null;
    toMs = parsed;
  }
  let fromMs = toMs - (COMPUTE_WINDOW_DEFAULT_DAYS - 1) * DAY_MS;
  if (query.from !== undefined) {
    const parsed = parseDay(query.from);
    if (parsed === null) return null;
    fromMs = parsed;
  }
  if (fromMs > toMs) return null;
  const days = Math.round((toMs - fromMs) / DAY_MS) + 1;
  if (days > COMPUTE_WINDOW_MAX_DAYS) return null;
  return {
    from: dayText(fromMs),
    to: dayText(toMs),
    start: `${dayText(fromMs)} 00:00:00`,
    end: `${dayText(toMs + DAY_MS)} 00:00:00`,
  };
}

/**
 * The groups a `group` parameter names: a comma list of the four words, each once, in the order given
 * (a row lists them in the fixed order of `COMPUTE_USAGE_GROUPS`). `null` for an empty list, an unknown
 * word or a repeat. An absent parameter is the caller's: no grouping, one total.
 */
export function parseGroups(text: string): ComputeUsageGroup[] | null {
  const parts = text.split(",");
  const seen = new Set<string>();
  for (const part of parts) {
    if (!(COMPUTE_USAGE_GROUPS as readonly string[]).includes(part) || seen.has(part)) return null;
    seen.add(part);
  }
  return COMPUTE_USAGE_GROUPS.filter((g) => seen.has(g));
}

// --- Usage ---------------------------------------------------------------------------------------

/** What each group is in SQL: the entry's UTC day, or the job's own word. A column list is never built from input. */
const GROUP_SQL: Readonly<Record<ComputeUsageGroup, string>> = {
  day: "date(e.created_at)",
  app: "j.app_id",
  partition: "j.partition",
  source: "j.source",
};

/** The entries that move a charge: a charge, an overrun, a final settlement or an administrator's correction. */
const CHARGE_ENTRY_SQL = `e.kind IN ('charge', 'overrun', 'adjust', 'refund') AND e.charged_delta_milli <> 0`;

/**
 * The net charge by group, from the ledger. `scope` `account` is one person's pools (`?1` the account id
 * as text, then the window); `platform` is every entry that names a job (the window only). The groups
 * are positional in GROUP BY and ORDER BY, so no alias is parsed. A group whose entries sum to zero has
 * no row. `LEFT JOIN` for a person, so an administrator's correction (no job) is in their total with
 * `null` for app, partition and source; an inner join for the platform, whose rows are all jobs'.
 */
export function usageSql(
  scope: "account" | "platform",
  groups: readonly ComputeUsageGroup[],
): string {
  const from =
    scope === "account"
      ? "compute_ledger e LEFT JOIN compute_jobs j ON j.id = e.job_id"
      : "compute_ledger e JOIN compute_jobs j ON j.id = e.job_id";
  const poolFilter =
    scope === "account"
      ? "e.pool_id IN (SELECT id FROM compute_pools WHERE holder_kind = 'account' AND holder_ref = ?1) AND "
      : "";
  const [startBind, endBind] = scope === "account" ? ["?2", "?3"] : ["?1", "?2"];
  const where = `${poolFilter}${CHARGE_ENTRY_SQL}
     AND e.created_at >= ${startBind} AND e.created_at < ${endBind}`;
  if (groups.length === 0) {
    // One total. An aggregate with no GROUP BY always answers one row, a NULL sum when nothing matched,
    // which the outer test drops: no charge, no row.
    return `SELECT charged_milli, jobs FROM (
      SELECT SUM(e.charged_delta_milli) AS charged_milli, COUNT(DISTINCT e.job_id) AS jobs
        FROM ${from} WHERE ${where}) WHERE charged_milli <> 0`;
  }
  const select = groups.map((g) => `${GROUP_SQL[g]} AS ${g}`);
  const positions = groups.map((_, i) => String(i + 1)).join(", ");
  return `SELECT ${[...select, "SUM(e.charged_delta_milli) AS charged_milli", "COUNT(DISTINCT e.job_id) AS jobs"].join(", ")}
    FROM ${from}
   WHERE ${where}
   GROUP BY ${positions}
  HAVING SUM(e.charged_delta_milli) <> 0
   ORDER BY ${positions}`;
}

type UsageRowRaw = { charged_milli: number; jobs: number } & Partial<
  Record<ComputeUsageGroup, string | null>
>;

function usageRows(raw: UsageRowRaw[], groups: readonly ComputeUsageGroup[]): ComputeUsageRow[] {
  return raw.map((r) => {
    const row: ComputeUsageRow = { charged_milli: r.charged_milli, jobs: r.jobs };
    for (const g of groups) {
      // A day is always a string (the entry has a time); the others are null for a correction.
      if (g === "day") row.day = r.day as string;
      else row[g] = r[g] ?? null;
    }
    return row;
  });
}

/** One person's usage in a window, by the groups named. */
export async function accountUsage(
  db: D1Database,
  accountId: number,
  window: UsageWindow,
  groups: readonly ComputeUsageGroup[],
): Promise<ComputeUsageRow[]> {
  const raw = (
    await db
      .prepare(usageSql("account", groups))
      .bind(String(accountId), window.start, window.end)
      .all<UsageRowRaw>()
  ).results;
  return usageRows(raw, groups);
}

/** Every job's charge in a window by day, partition and source: the partner's aggregate. */
export async function platformUsage(
  db: D1Database,
  window: UsageWindow,
): Promise<
  Array<{ day: string; partition: string; source: string; charged_milli: number; jobs: number }>
> {
  const groups: ComputeUsageGroup[] = ["day", "partition", "source"];
  const raw = (
    await db
      .prepare(usageSql("platform", groups))
      .bind(window.start, window.end)
      .all<UsageRowRaw & { day: string; partition: string; source: string }>()
  ).results;
  return raw.map((r) => ({
    day: r.day,
    partition: r.partition,
    source: r.source,
    charged_milli: r.charged_milli,
    jobs: r.jobs,
  }));
}

/**
 * The people who made a job in a window: distinct accounts, leaving out NEMAR's own pipelines (a service
 * account, not a person) and a job the tenant sweep indexed (nobody's). A count and nothing else.
 */
export const ACTIVE_PEOPLE_SQL = `SELECT COUNT(DISTINCT account_id) AS n FROM compute_jobs
  WHERE created_at >= ?1 AND created_at < ?2
    AND account_id IS NOT NULL AND source <> 'pipeline' AND flag_unreserved = 0`;

/** Jobs made in a window, by terminal state. */
export const JOBS_BY_OUTCOME_SQL = `SELECT state, COUNT(*) AS n FROM compute_jobs
  WHERE created_at >= ?1 AND created_at < ?2 AND state IN ('finished', 'failed', 'cancelled')
  GROUP BY state`;

/** The terminal states, which `JOBS_BY_OUTCOME_SQL` counts and every answer lists, a zero included. */
const TERMINAL_OUTCOMES = ["finished", "failed", "cancelled"] as const;

export async function platformCounts(
  db: D1Database,
  window: UsageWindow,
): Promise<{
  active_people: number;
  jobs_by_outcome: Record<(typeof TERMINAL_OUTCOMES)[number], number>;
}> {
  const people = await db
    .prepare(ACTIVE_PEOPLE_SQL)
    .bind(window.start, window.end)
    .first<{ n: number }>();
  const outcomes = (
    await db
      .prepare(JOBS_BY_OUTCOME_SQL)
      .bind(window.start, window.end)
      .all<{ state: string; n: number }>()
  ).results;
  const jobs_by_outcome = { finished: 0, failed: 0, cancelled: 0 };
  for (const row of outcomes) {
    if ((TERMINAL_OUTCOMES as readonly string[]).includes(row.state)) {
      jobs_by_outcome[row.state as (typeof TERMINAL_OUTCOMES)[number]] = row.n;
    }
  }
  return { active_people: people?.n ?? 0, jobs_by_outcome };
}

// --- Jobs ----------------------------------------------------------------------------------------

/** The columns a person's job view is built from, and no others. */
export interface UserJobColumns {
  id: string;
  kind: string;
  source: string;
  state: string;
  app_id: string;
  app_version: string;
  partition: string;
  pool: string;
  nodes: number;
  cores_per_node: number;
  memory_mb: number | null;
  gpus: number;
  minutes: number;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  charged_milli: number;
  failure_code: string | null;
  cancel_requested_at: string | null;
}

export const USER_JOB_COLUMNS = `id, kind, source, state, app_id, app_version, partition, pool, nodes,
  cores_per_node, memory_mb, gpus, minutes, created_at, started_at, ended_at, charged_milli,
  failure_code, cancel_requested_at`;

/** A job as its person sees it (`ComputeUserJobSchema`). */
export function userJobView(row: UserJobColumns): ComputeUserJob {
  return {
    id: row.id,
    kind: row.kind,
    source: row.source,
    state: row.state,
    app_id: row.app_id,
    app_version: row.app_version,
    partition: row.partition,
    pool: row.pool,
    resources: {
      nodes: row.nodes,
      cores_per_node: row.cores_per_node,
      memory_mb: row.memory_mb,
      gpus: row.gpus,
      minutes: row.minutes,
    },
    created_at: row.created_at,
    started_at: row.started_at,
    ended_at: row.ended_at,
    charged_milli: row.charged_milli,
    failure_code: row.failure_code,
    cancel_requested: row.cancel_requested_at !== null,
  };
}

/** One job of the caller, by id: the account is in the WHERE, so a stranger's job and an absent one are the same absence. */
export const USER_JOB_SQL = `SELECT ${USER_JOB_COLUMNS}, tapis_uuid, tapis_synced_at, submitted_at
  FROM compute_jobs WHERE id = ?1 AND account_id = ?2 AND flag_unreserved = 0`;

export interface UserJobRecord extends UserJobColumns {
  tapis_uuid: string | null;
  tapis_synced_at: string | null;
  submitted_at: string | null;
}

export async function getUserJob(
  db: D1Database,
  accountId: number,
  jobId: string,
): Promise<UserJobRecord | null> {
  return db.prepare(USER_JOB_SQL).bind(jobId, accountId).first<UserJobRecord>();
}

/** A page cursor: the last job's creation time (UTC, with `T`), `|`, and its job id. */
const CURSOR_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})\|(job_[0-9a-f]{24})$/;

export function parseCursor(text: string): { createdAt: string; id: string } | null {
  const match = CURSOR_RE.exec(text);
  if (!match) return null;
  return { createdAt: `${match[1]} ${match[2]}`, id: match[3] as string };
}

const cursorOf = (row: { created_at: string; id: string }) =>
  `${row.created_at.replace(" ", "T")}|${row.id}`;

/**
 * A page of the caller's jobs, newest first: `?1` the account, then (each only when used) `?2` the
 * state, and a cursor's creation time and job id. Ordered by `(created_at, id)`, a total order (the id is
 * the primary key), which is the order of the index `compute_jobs_account_created_id` of migration 0132,
 * so a page never sorts and a cursor continues exactly: a job made between two pages is newer than the
 * cursor and is not in the rest, and no job is shown twice or skipped. The tie-breaker is the job id and
 * not the row number, so the cursor carries nothing about the table beyond a job the caller already has.
 * `limit + 1` rows are read to learn whether there is a next page.
 */
export function jobsPageSql(opts: { state: boolean; cursor: boolean }): string {
  const where = ["account_id = ?1", "flag_unreserved = 0"];
  let n = 1;
  if (opts.state) where.push(`state = ?${++n}`);
  if (opts.cursor) {
    where.push(`(created_at < ?${n + 1} OR (created_at = ?${n + 1} AND id < ?${n + 2}))`);
    n += 2;
  }
  return `SELECT ${USER_JOB_COLUMNS} FROM compute_jobs
   WHERE ${where.join(" AND ")}
   ORDER BY created_at DESC, id DESC LIMIT ?${n + 1}`;
}

export async function listUserJobs(
  db: D1Database,
  accountId: number,
  q: { state?: ComputeState; limit: number; cursor?: { createdAt: string; id: string } },
): Promise<{ jobs: ComputeUserJob[]; next_after: string | null }> {
  const limit = Math.min(Math.max(1, Math.trunc(q.limit)), COMPUTE_JOBS_PAGE_MAX);
  const binds: unknown[] = [accountId];
  if (q.state !== undefined) binds.push(q.state);
  if (q.cursor !== undefined) binds.push(q.cursor.createdAt, q.cursor.id);
  binds.push(limit + 1);
  const rows = (
    await db
      .prepare(jobsPageSql({ state: q.state !== undefined, cursor: q.cursor !== undefined }))
      .bind(...binds)
      .all<UserJobColumns>()
  ).results;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    jobs: page.map(userJobView),
    next_after: rows.length > limit && last !== undefined ? cursorOf(last) : null,
  };
}

export { COMPUTE_JOBS_PAGE_DEFAULT };

// --- Me ------------------------------------------------------------------------------------------

const ACCESS_ROW_SQL = `SELECT compute_access, compute_access_requested_at, compute_access_granted_at,
    compute_terms_version FROM users WHERE id = ?1 AND deleted_at IS NULL`;

interface AccessRow {
  compute_access: string;
  compute_access_requested_at: string | null;
  compute_access_granted_at: string | null;
  compute_terms_version: string | null;
}

/**
 * `GET /compute/me`: the caller's access, pools, limits and queue estimates. `ComputePolicyUnreadable`
 * is left to propagate (the route answers 503 `policy_unavailable`: the limits cannot be stated, and a
 * default is not what the owner set). An account that is not found throws: it was just authenticated.
 */
export async function computeMe(env: Bindings, accountId: number): Promise<ComputeMeResponse> {
  const db = env.DB;
  const access = await db.prepare(ACCESS_ROW_SQL).bind(accountId).first<AccessRow>();
  if (!access) throw new Error("the authenticated account has no row");
  const pools = await accountPools(db, accountId);
  const policy = (await getPolicy(db)).policy;

  const balances = {} as Record<(typeof COMPUTE_POOLS)[number], ComputeMeResponse["pools"]["cpu"]>;
  for (const word of COMPUTE_POOLS) {
    const row = pools.find((p) => p.pool === word);
    balances[word] = {
      granted_milli: row?.granted_milli ?? 0,
      held_milli: row?.held_milli ?? 0,
      charged_milli: row?.charged_milli ?? 0,
      available_milli: row ? availableMilli(row) : 0,
    };
  }

  const offered = (Object.keys(policy.ceilings) as PartitionName[]).filter(
    (name) => policy.ceilings[name] !== undefined,
  );
  const partitions = offered.map((name) => {
    const ceiling = policy.ceilings[name] as NonNullable<(typeof policy.ceilings)[PartitionName]>;
    return {
      name,
      pool: PARTITIONS[name].pool,
      max_nodes: ceiling.maxNodes,
      max_cores_per_node: ceiling.maxCoresPerNode,
      max_gpus_per_node: ceiling.maxGpusPerNode,
      max_minutes: ceiling.maxMinutes,
    };
  });

  return {
    access: {
      state: access.compute_access,
      requested_at: access.compute_access_requested_at,
      granted_at: access.compute_access_granted_at,
      terms_version: access.compute_terms_version,
      current_terms_version: COMPUTE_TERMS_VERSION,
      terms_published: COMPUTE_TERMS_PUBLISHED,
      requests_open: !termsUnpublished(env),
    },
    pools: balances,
    frozen: pools.some((p) => p.frozen === 1),
    limits: {
      partitions,
      max_live_jobs: policy.maxLiveJobsPerPerson,
      results_days: policy.retention.resultsDays,
    },
    queue: await computeQueueEstimates(db, offered),
  };
}
