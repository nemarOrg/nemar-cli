/**
 * From the observer's document to the rows the Worker stores (epic #2005 phase A7, #2012; ADR 0118,
 * decision 8).
 *
 * The observer posts `nemar.observation.v1` (`shared/contract/compute-observation.ts`). The Worker's
 * tables and its settlement are older than that document and are NOT changed by it: this module is the
 * one place the two meet, and it is a pure function with a table of its own (below) that a test pins
 * line by line.
 *
 *   document                                            row
 *   --------                                            ---
 *   partitions.<name>.jobs.PENDING.jobs                 compute_queue_snapshots.pending
 *   partitions.<name>.jobs.RUNNING.jobs                 compute_queue_snapshots.running
 *   accounting.jobs[].job_id                            compute_sacct_rows.slurm_job_id
 *   accounting.jobs[].partition / state                 .partition / .state
 *   accounting.jobs[].elapsed_seconds                   .elapsed_seconds
 *   accounting.jobs[].alloc_tres  node / cpu            .alloc_nodes / .alloc_cpus
 *   accounting.jobs[].alloc_tres  gres/gpu / mem        .alloc_gpus / .alloc_mem_mb (mem in MB, rounded up)
 *   accounting.jobs[].submit / start / end              .submit_time / .start_time / .end_time
 *   (nothing)                                           .charged_milli = NULL
 *
 * `charged_milli` is always NULL: the observer posts no charge, so the settlement prices the allocation
 * with the rate table, as it does for any row without a figure of its own. Everything else in the
 * document (`sources`, `pending_starts`, `balance`, the nodes by state, the pending reasons) is checked
 * and not stored.
 *
 * WHAT IS REFUSED, WHAT IS SKIPPED, WHAT NEVER HAPPENS.
 *  - REFUSED (the post is 400 `invalid_post` and the run is not spent): a document that is not the
 *    document (wrong `schema`, an unknown key, a wrong type), more than 5,000 rows, an allocation item
 *    that `parseAllocTres` cannot read, and a row with elapsed time and no `cpu` item (an allocation
 *    that ran and is not on record is a charge of nothing, which is a guess). A refusal names the path
 *    and a fixed word, never a value the sender wrote.
 *  - SKIPPED and COUNTED (`skipped` in the answer): a partition whose queue was not read (`jobs` is
 *    null: the observer says null, never zero, and so does this), and a row that is valid but that no
 *    table of ours can hold: a job id that is not one Slurm job (a pending array `123_[1-5]`, a list), a
 *    partition, state or elapsed time the observer could not read, or a value past a column's bound.
 *    Such a row is not a job NEMAR submitted as a single Slurm job, and one array on the account must
 *    not stop the rest of the day from settling.
 *  - NEVER: a mode is a dry run. The observer defines two modes, `quick` and `daily`; both are live
 *    observations, and the difference is only that `quick` has no `accounting`, so it stores queue
 *    snapshots and settles whatever earlier rows now can be.
 */

import {
  type ObservationDocument,
  parseAllocTres,
} from "../../../shared/contract/compute-observation.js";
import {
  OBSERVER_ROWS_MAX,
  type ObserverBody,
  ObserverSacctRowSchema,
  ObserverSnapshotSchema,
} from "./compute-observer.js";

export interface MappedObservation {
  body: ObserverBody;
  /** Partitions and accounting rows that were valid and were not stored, and why in the code above. */
  skipped: { partitions: number; jobs: number };
  /** The export lost rows to the observer's 1 MiB bound; the rest are on the next day's export. */
  truncated: boolean;
}

export type MapResult = { ok: true; mapped: MappedObservation } | { ok: false; fields: string[] };

/** A fixed word per refusal: the field's path and one of these, never a value. */
export const OBSERVATION_REFUSALS = {
  tooManyRows: "too_big",
  malformedTres: "malformed_tres",
  missingCpu: "missing_cpu",
} as const;

export function mapObservation(doc: ObservationDocument): MapResult {
  const partitions = Object.entries(doc.partitions);
  const accounting = doc.mode === "daily" ? doc.accounting : null;
  const jobs = accounting?.jobs ?? [];
  if (partitions.length + jobs.length > OBSERVER_ROWS_MAX) {
    return { ok: false, fields: [`body: ${OBSERVATION_REFUSALS.tooManyRows}`] };
  }

  const body: ObserverBody = { snapshots: [], sacct: [] };
  const skipped = { partitions: 0, jobs: 0 };

  for (const [name, partition] of partitions) {
    if (partition.jobs === null) {
      skipped.partitions++;
      continue;
    }
    const snapshot = ObserverSnapshotSchema.safeParse({
      partition: name,
      pending: partition.jobs.PENDING?.jobs ?? 0,
      running: partition.jobs.RUNNING?.jobs ?? 0,
    });
    if (snapshot.success) body.snapshots.push(snapshot.data);
    else skipped.partitions++;
  }

  const refused: string[] = [];
  jobs.forEach((job, index) => {
    const where = `accounting.jobs.${index}.alloc_tres`;
    if (job.partition === null || job.state === null || job.elapsed_seconds === null) {
      skipped.jobs++;
      return;
    }
    // The identity first: a row that is not one Slurm job of ours is skipped before its allocation is read.
    const identity = ObserverSacctRowSchema.safeParse({
      slurm_job_id: job.job_id,
      partition: job.partition,
      state: job.state,
      elapsed_seconds: job.elapsed_seconds,
      alloc_nodes: 0,
      alloc_cpus: 0,
      alloc_gpus: 0,
      alloc_mem_mb: 0,
    });
    if (!identity.success) {
      skipped.jobs++;
      return;
    }
    const tres = parseAllocTres(job.alloc_tres);
    if (!tres.ok) {
      refused.push(`${where}: ${OBSERVATION_REFUSALS.malformedTres}`);
      return;
    }
    const { nodes, cpus, gpus, memMb } = tres.value;
    if (cpus === null && job.elapsed_seconds > 0) {
      refused.push(`${where}: ${OBSERVATION_REFUSALS.missingCpu}`);
      return;
    }
    body.sacct.push({
      ...identity.data,
      alloc_nodes: nodes ?? 0,
      alloc_cpus: cpus ?? 0,
      alloc_gpus: gpus ?? 0,
      alloc_mem_mb: memMb ?? 0,
      submit_time: job.submit,
      start_time: job.start,
      end_time: job.end,
      charged_milli: null,
    });
  });
  if (refused.length > 0) return { ok: false, fields: refused.slice(0, 5) };

  return { ok: true, mapped: { body, skipped, truncated: accounting?.truncated === true } };
}
