/**
 * Seeding for the compute read suites (epic #2021 phase D2, #2023): job rows and ledger entries with
 * times the test chooses, written to a real migrated SQLite database.
 *
 * Why not only `createJob`: the read routes are about WHEN things happened (a day boundary, a start
 * eight days ago), and the ledger is append-only with its clock on the database, so a case that needs a
 * specific time writes the row itself. Every row still goes through the real tables, with their CHECKs
 * and the ledger's triggers (which keep the pool totals), so nothing is accepted that production would
 * refuse. The suites that need a job taken through the real lifecycle use `compute-lifecycle-fixture.ts`.
 */

import type { Database } from "bun:sqlite";

let sequence = 0;
const next = () => ++sequence;

/** A job id the table accepts: `job_` and 24 lowercase hex digits. */
export function jobIdFor(n: number = next()): string {
  return `job_${n.toString(16).padStart(24, "0")}`;
}

export interface JobSeed {
  id?: string;
  account_id?: number | null;
  source?: "cli" | "web" | "partner" | "pipeline";
  kind?: "batch" | "interactive";
  state?: string;
  failure_code?: string | null;
  app_id?: string;
  app_version?: string;
  partition?: string;
  pool?: "cpu" | "gpu";
  nodes?: number;
  cores_per_node?: number;
  memory_mb?: number | null;
  gpus?: number;
  minutes?: number;
  /** SQLite times, `YYYY-MM-DD HH:MM:SS`. */
  created_at?: string;
  started_at?: string | null;
  ended_at?: string | null;
  remote_submitted_at?: string | null;
  tapis_synced_at?: string | null;
  tapis_uuid?: string | null;
  slurm_job_id?: string | null;
  charged_milli?: number;
  held_milli?: number;
  cancel_requested_at?: string | null;
  platform_failure?: number;
  flag_unreserved?: number;
  flag_unattributed?: number;
  flag_mismatch?: number;
  flag_overrun?: number;
  tapis_owner?: string | null;
  client_id?: string | null;
}

/** Insert one `compute_jobs` row and return its id. Only the NOT NULL columns have defaults. */
export function insertJob(db: Database, over: JobSeed = {}): string {
  const n = next();
  const id = over.id ?? jobIdFor(n);
  const state = over.state ?? "finished";
  const failureCode = over.failure_code ?? (state === "failed" ? "runtime_error" : null);
  const columns: Record<string, unknown> = {
    id,
    account_id: over.account_id === undefined ? 1 : over.account_id,
    source: over.source ?? "cli",
    kind: over.kind ?? "batch",
    state,
    failure_code: failureCode,
    app_id: over.app_id ?? "nemar-launch",
    app_version: over.app_version ?? "1.0.0",
    spec_digest: n.toString(16).padStart(64, "0"),
    partition: over.partition ?? "shared",
    pool: over.pool ?? "cpu",
    nodes: over.nodes ?? 1,
    cores_per_node: over.cores_per_node ?? 4,
    memory_mb: over.memory_mb === undefined ? null : over.memory_mb,
    gpus: over.gpus ?? 0,
    minutes: over.minutes ?? 60,
    started_at: over.started_at ?? null,
    ended_at: over.ended_at ?? null,
    remote_submitted_at: over.remote_submitted_at ?? null,
    tapis_synced_at: over.tapis_synced_at ?? null,
    tapis_uuid: over.tapis_uuid ?? null,
    slurm_job_id: over.slurm_job_id ?? null,
    charged_milli: over.charged_milli ?? 0,
    held_milli: over.held_milli ?? 0,
    cancel_requested_at: over.cancel_requested_at ?? null,
    platform_failure: over.platform_failure ?? 0,
    flag_unreserved: over.flag_unreserved ?? 0,
    flag_unattributed: over.flag_unattributed ?? 0,
    flag_mismatch: over.flag_mismatch ?? 0,
    flag_overrun: over.flag_overrun ?? 0,
    tapis_owner: over.tapis_owner ?? null,
    client_id: over.client_id ?? null,
  };
  if (over.created_at !== undefined) columns.created_at = over.created_at;
  const names = Object.keys(columns);
  db.query(
    `INSERT INTO compute_jobs (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
  ).run(...(names.map((k) => columns[k]) as never[]));
  return id;
}

/** The id of a pool, made when absent. */
export function poolId(
  db: Database,
  kind: "account" | "platform" | "partner",
  ref: string | number,
  pool: "cpu" | "gpu" = "cpu",
): number {
  db.query(
    "INSERT OR IGNORE INTO compute_pools (holder_kind, holder_ref, pool) VALUES (?, ?, ?)",
  ).run(kind, String(ref), pool);
  return (
    db
      .query<{ id: number }, [string, string, string]>(
        "SELECT id FROM compute_pools WHERE holder_kind = ? AND holder_ref = ? AND pool = ?",
      )
      .get(kind, String(ref), pool) as { id: number }
  ).id;
}

/**
 * A charge written at a time of the test's choosing: the final-settlement `adjust` entry of a job (the
 * entry that carries the job and a charged delta of either sign), named to the platform `people`
 * budget as the table requires. The ledger's triggers apply it to the pool's totals as for any entry.
 */
export function chargeAt(
  db: Database,
  input: { accountId: number; jobId: string; milli: number; at: string; pool?: "cpu" | "gpu" },
): void {
  const pool = input.pool ?? "cpu";
  const budget = poolId(db, "platform", "people", pool);
  db.query(
    `INSERT INTO compute_ledger
       (kind, pool_id, budget_pool_id, charged_delta_milli, job_id, idempotency_key, created_at)
     VALUES ('adjust', ?, ?, ?, ?, ?, ?)`,
  ).run(
    poolId(db, "account", input.accountId, pool),
    budget,
    input.milli,
    input.jobId,
    `seed:final:${input.jobId}:${next()}`,
    input.at,
  );
}

/** An administrator's correction of an account's charge: no job, no budget, either sign. */
export function correctionAt(
  db: Database,
  input: { accountId: number; milli: number; at: string; pool?: "cpu" | "gpu" },
): void {
  db.query(
    `INSERT INTO compute_ledger
       (kind, pool_id, charged_delta_milli, idempotency_key, created_at, actor_user_id)
     VALUES ('adjust', ?, ?, ?, ?, 1)`,
  ).run(
    poolId(db, "account", input.accountId, input.pool ?? "cpu"),
    input.milli,
    `seed:correction:${next()}`,
    input.at,
  );
}

/** SQLite's time text for a millisecond instant. */
export function sqliteAt(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}
