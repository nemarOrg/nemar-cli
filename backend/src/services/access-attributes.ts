/**
 * The ACCESS gateway-attributes report of every Slurm job (epic #2005 phase A8, #2013; ADR 0118
 * decision 9; design section 9). ACCESS requires a community-account gateway to report the end user of
 * every job: the Slurm job id, the submission time, the resource name and the gateway user, which is
 * the pseudonym NEMAR stores for the account (`compute_gateway_users`; `nemar-pipelines` for NEMAR's own
 * jobs) and never a name, an email or the sign-in subject.
 *
 * This file holds, so far, the one statement that owes a report: the row of `compute_access_reports`
 * (migration 0119) that the lifecycle writes in the SAME BATCH as the job row first showing its Slurm
 * id, so every Slurm job is owed exactly one report and none is owed for a job the scheduler never saw.
 */

/**
 * The report a job owes, made when its row shows a Slurm id. `?1` the job. Run in the batch of the
 * transition that wrote the id (`LIVE_TRANSITION_SQL` and `TERMINAL_TRANSITION_SQL`), after it. The
 * statement reads the JOB ROW and not the record the caller holds, so it makes a row only for a job
 * that has an id NOW, and `OR IGNORE` is what makes a replayed read (the same record again, the next
 * live state, a repair of a terminal row) add nothing and leave a row that has moved on (`attempting`,
 * `sent`, `failed`) exactly as it is. A plain `INSERT` here would throw on the primary key at the
 * second read and roll the transition back with it.
 */
export const ACCESS_REPORT_PENDING_SQL = `INSERT OR IGNORE INTO compute_access_reports (job_id)
  SELECT id FROM compute_jobs WHERE id = ?1 AND slurm_job_id IS NOT NULL`;
