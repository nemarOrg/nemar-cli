/**
 * Dataset ID generation service
 *
 * Generates IDs that reuse gaps from deleted datasets:
 * - nm000XXX for regular datasets (starting at 108)
 * - xx000XXX for sandbox datasets (starting at 1)
 * - on000XXX for OpenNeuro-sourced datasets (assigned by import, not auto-generated)
 */

// First allocatable number for each prefix
const START_NUMBER: Record<string, number> = { nm: 108, xx: 1, on: 1 };

// Maximum allocatable number (6-digit zero-padded IDs: 000001-099999).
// IDs above this (e.g. nm100000) break the expected nm000XXX convention.
const MAX_NUMBER = 99999;

// Dev/test staging (epic #923) partitions the sandbox (xx) space so the shared
// nemarDatasets GitHub org never has repo-name collisions between prod-created
// and dev/test-created sandbox datasets: prod allocates xx000001-xx089999
// (SANDBOX_ID_CEILING="89999"), dev/test allocates xx090001-xx099999
// (SANDBOX_ID_FLOOR="90001"). The partition lives INSIDE the 6-digit/<=99999
// cap on purpose so isValidDatasetId and every prod webhook/data/zarr gate keep
// their exact semantics (xx900001 would fail validation everywhere).
//
// DEV_SANDBOX_RANGE_RE identifies a dev/test-range repo by id shape alone
// (env-independent): xx09NNNN == xx090000-xx099999, which covers the whole dev
// band (floor 90001) and the exemplar sub-band (xx099900+). The prod webhook
// receiver uses it to refuse dispatching enrichment/zarr/DOI runs against
// staging repos, whose callbacks would 404 on prod (see routes/webhooks/github).
export const DEV_SANDBOX_RANGE_RE = /^xx09\d{4}$/;

/** True when a dataset id belongs to the dev/test sandbox partition (xx09NNNN). */
export function isDevRangeDatasetId(id: string): boolean {
  return DEV_SANDBOX_RANGE_RE.test(id);
}

// The dev partition splits again: xx090001-xx099899 is the EPHEMERAL band that
// the dev cleanup cron may delete, and xx099900-xx099999 is the curated
// exemplar fleet, which is never auto-deleted. Bounds are half-open
// [START, END) and safe to compare as strings because ids are fixed-width
// zero-padded (epic #923 Phase 7).
export const DEV_EPHEMERAL_BAND_START = "xx090001";
export const DEV_EPHEMERAL_BAND_END = "xx099900";

/**
 * True when a dataset id is in the dev EPHEMERAL sandbox band, i.e. the only
 * ids the non-production cleanup cron is allowed to delete. Excludes the
 * exemplar fleet (xx099900+) and prod's sandbox band (<= xx089999).
 */
export function isDevEphemeralSandboxId(id: string): boolean {
  return (
    DEV_SANDBOX_RANGE_RE.test(id) && id >= DEV_EPHEMERAL_BAND_START && id < DEV_EPHEMERAL_BAND_END
  );
}

// Test dataset IDs excluded from the gap-filling candidate pool.
// nm099999 would otherwise contribute candidate 100000 (99999+1).
const EXCLUDED_IDS = new Set(["nm099999"]);

/**
 * Resolve the effective [start, max] allocation window for a prefix.
 *
 * An explicit floor never drops below the prefix's natural start; an explicit
 * ceiling never exceeds the 6-digit cap. A non-finite bound (NaN/Infinity/
 * missing) is treated as absent, so the invariant "a bad bound can only narrow
 * within [start, MAX_NUMBER], never mint an out-of-convention id" holds at this
 * layer regardless of caller discipline. Single source of truth for both the
 * allocator loop and the exhaustion error message.
 */
function resolveRange(
  prefix: string,
  opts?: { start?: number; max?: number },
): { start: number; max: number } {
  const natural = START_NUMBER[prefix] ?? 1;
  const s = opts?.start;
  const m = opts?.max;
  const start = typeof s === "number" && Number.isFinite(s) ? Math.max(natural, s) : natural;
  const max = typeof m === "number" && Number.isFinite(m) ? Math.min(MAX_NUMBER, m) : MAX_NUMBER;
  return { start, max };
}

/**
 * Find the lowest unused number for a given prefix.
 *
 * Generates candidate numbers (start, plus each existing_number+1) and picks
 * the smallest one not already taken. No recursion, so no SQLite depth limit.
 */
async function findLowestUnusedNumber(
  db: D1Database,
  prefix: string,
  opts?: { start?: number; max?: number },
): Promise<number | null> {
  const { start, max } = resolveRange(prefix, opts);
  const likePattern = `${prefix}%`;

  // Two-step approach to avoid D1 parameter binding issues with complex queries
  // Step 1: Get all candidate numbers
  const candidatesResult = await db
    .prepare(
      `SELECT CAST(SUBSTR(dataset_id, 3) AS INTEGER) + 1 AS candidate
       FROM datasets WHERE dataset_id LIKE ?`,
    )
    .bind(likePattern)
    .all<{ candidate: number }>();

  const existingIds = new Set(
    (
      await db
        .prepare("SELECT dataset_id FROM datasets WHERE dataset_id LIKE ?")
        .bind(likePattern)
        .all<{ dataset_id: string }>()
    ).results.map((r) => r.dataset_id),
  );

  // Step 2: Find the lowest unused candidate in JS
  const candidates = new Set([start, ...candidatesResult.results.map((r) => r.candidate)]);
  let minUnused: number | null = null;

  for (const candidate of candidates) {
    if (candidate < start || candidate > max) continue;
    const id = `${prefix}${candidate.toString().padStart(6, "0")}`;
    if (EXCLUDED_IDS.has(id)) continue;
    if (!existingIds.has(id)) {
      if (minUnused === null || candidate < minUnused) {
        minUnused = candidate;
      }
    }
  }

  return minUnused;
}

/**
 * Generate the next dataset ID by finding the lowest unused number.
 *
 * Queries existing datasets to find gaps from deletions, reusing freed IDs
 * before allocating new ones.
 *
 * @param db - D1 database instance
 * @param sandbox - If true, generates xx000XXX sandbox ID instead of nm000XXX
 * @param opts - Optional sandbox range partition (epic #923). `sandboxIdFloor`
 *   raises the lowest allocatable xx number (dev/test set 90001); `sandboxIdCeiling`
 *   lowers the highest (prod sets 89999). Ignored for the nm prefix. Both clamp to
 *   the natural [start, MAX_NUMBER] bounds, so a bad value only narrows the range.
 */
export async function generateDatasetId(
  db: D1Database,
  sandbox = false,
  opts?: { sandboxIdFloor?: number; sandboxIdCeiling?: number },
): Promise<string> {
  const prefix = sandbox ? "xx" : "nm";
  const range = sandbox ? { start: opts?.sandboxIdFloor, max: opts?.sandboxIdCeiling } : undefined;
  const n = await findLowestUnusedNumber(db, prefix, range);

  if (n === null) {
    const { start: lo, max: hi } = resolveRange(prefix, range);
    throw new Error(
      `Failed to generate dataset ID for prefix '${prefix}': all IDs from ${lo} to ${hi} are allocated`,
    );
  }

  return `${prefix}${n.toString().padStart(6, "0")}`;
}

/**
 * Get the next number that would be allocated (without allocating it)
 */
export async function getCurrentSequence(db: D1Database): Promise<number> {
  return (await findLowestUnusedNumber(db, "nm")) ?? 108;
}

/**
 * Check if a dataset ID is valid format
 * Accepts nm000XXX (regular), xx000XXX (sandbox), and on000XXX (OpenNeuro) formats
 */
export function isValidDatasetId(id: string): boolean {
  if (!/^(nm|xx|on)\d{6}$/.test(id)) return false;
  // Enforce upper bound: numeric part must be <= 99999 (i.e. 0-padded to 6 digits)
  const num = Number.parseInt(id.slice(2), 10);
  return num <= MAX_NUMBER;
}

/**
 * Check if a dataset ID is a sandbox dataset
 */
export function isSandboxDatasetId(id: string): boolean {
  return id.startsWith("xx");
}
