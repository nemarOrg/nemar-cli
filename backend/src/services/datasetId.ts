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

// Test dataset IDs excluded from the gap-filling candidate pool.
// nm099999 would otherwise contribute candidate 100000 (99999+1).
const EXCLUDED_IDS = new Set(["nm099999"]);

/**
 * Find the lowest unused number for a given prefix.
 *
 * Generates candidate numbers (start, plus each existing_number+1) and picks
 * the smallest one not already taken. No recursion, so no SQLite depth limit.
 */
async function findLowestUnusedNumber(db: D1Database, prefix: string): Promise<number | null> {
  const start = START_NUMBER[prefix] ?? 1;
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
    if (candidate < start || candidate > MAX_NUMBER) continue;
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
 */
export async function generateDatasetId(db: D1Database, sandbox = false): Promise<string> {
  const prefix = sandbox ? "xx" : "nm";
  const n = await findLowestUnusedNumber(db, prefix);

  if (n === null) {
    throw new Error(
      `Failed to generate dataset ID for prefix '${prefix}': all IDs from ${START_NUMBER[prefix] ?? 1} to ${MAX_NUMBER} are allocated`,
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
