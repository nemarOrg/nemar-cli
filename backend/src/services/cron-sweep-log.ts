/**
 * Log-line builder for the cron sweep wrappers (issue #1166, #1167 review).
 *
 * The three `*Cron` wrappers return `null` when their production guard skips a
 * run, so every `scheduled()` call site has to distinguish that from a real
 * result before touching any field. That handling used to live inline inside
 * `scheduled()`'s `.then()` callbacks, where nothing could reach it: no test in
 * this repo invokes the Worker `scheduled()` handler, so deleting the `if (!r)
 * return` guard from a call site left the entire backend suite green.
 *
 * Moving the decision here makes it a pure function with no console and no
 * environment, so the null case can be driven directly. The call sites keep the
 * console calls, which are the part that genuinely needs `scheduled()`.
 */

/** The subset of every sweep result this module reads. Each sweep's own result
 *  type carries more (`populated`, `measured`, `written`, ...); those belong in
 *  the caller's summary string, not here. */
export interface SweepOutcome {
  processed: number;
  remaining: number | null;
  errors: { dataset_id: string; error: string }[];
}

/** What a finished sweep should emit. `info` is null when there is nothing
 *  worth a summary line; `errors` is always every per-dataset failure. */
export interface SweepLogLines {
  info: string | null;
  errors: string[];
}

/**
 * Build the lines for one finished sweep.
 *
 * `r === null` means the wrapper's own `isNonProductionEnv` guard skipped the
 * run and already logged that, so there is nothing to add. This is the case
 * with no coverage before #1167's review: note that the failure it prevents is
 * NOT a "fabricated all-zero summary" -- the `processed > 0 || remaining > 0`
 * gate below already suppresses that -- it is that reading `processed` off
 * `null` throws, and the caller's chained `.catch()` then reports a routine
 * skip as `sweep failed: TypeError`.
 *
 * Per-dataset errors are returned unconditionally, including when `processed`
 * is 0, so a batch that failed every candidate still reports each one.
 */
export function sweepLogLines<T extends SweepOutcome>(
  label: string,
  result: T | null,
  summary: (r: T) => string,
): SweepLogLines {
  if (!result) return { info: null, errors: [] };
  const noteworthy = result.processed > 0 || (result.remaining ?? 0) > 0;
  return {
    info: noteworthy ? summary(result) : null,
    errors: result.errors.map((e) => `[${label}] ${e.dataset_id}: ${e.error}`),
  };
}
