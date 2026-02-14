/**
 * Dataset ID generation service
 *
 * Generates IDs that reuse gaps from deleted datasets:
 * - nm000XXX for regular datasets (starting at 108)
 * - xx000XXX for sandbox datasets (starting at 1)
 */

// First allocatable number for each prefix
const START_NUMBER: Record<string, number> = { nm: 108, xx: 1 };

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
  const start = START_NUMBER[prefix] ?? 1;
  const likePattern = `${prefix}%`;

  // Find the lowest unused number by looking for gaps in existing dataset IDs.
  // This generates a sequence from start..max+1 and picks the first number
  // not present in the datasets table.
  const result = await db
    .prepare(
      `
    WITH RECURSIVE seq(n) AS (
      SELECT ?2
      UNION ALL
      SELECT n + 1 FROM seq
      WHERE n <= (
        SELECT COALESCE(MAX(CAST(SUBSTR(dataset_id, 3) AS INTEGER)), ?2)
        FROM datasets WHERE dataset_id LIKE ?1
      )
    )
    SELECT n FROM seq
    WHERE ?3 || SUBSTR('000000', 1, 6 - LENGTH(CAST(n AS TEXT))) || CAST(n AS TEXT)
      NOT IN (SELECT dataset_id FROM datasets WHERE dataset_id LIKE ?1)
    LIMIT 1
  `,
    )
    .bind(likePattern, start, prefix)
    .first<{ n: number }>();

  if (!result) {
    throw new Error(`Failed to generate dataset ID for prefix '${prefix}'`);
  }

  const id = `${prefix}${result.n.toString().padStart(6, "0")}`;
  return id;
}

/**
 * Get the next number that would be allocated (without allocating it)
 */
export async function getCurrentSequence(db: D1Database): Promise<number> {
  const result = await db
    .prepare(
      `
    WITH RECURSIVE seq(n) AS (
      SELECT 108
      UNION ALL
      SELECT n + 1 FROM seq
      WHERE n <= (
        SELECT COALESCE(MAX(CAST(SUBSTR(dataset_id, 3) AS INTEGER)), 108)
        FROM datasets WHERE dataset_id LIKE 'nm%'
      )
    )
    SELECT n FROM seq
    WHERE 'nm' || SUBSTR('000000', 1, 6 - LENGTH(CAST(n AS TEXT))) || CAST(n AS TEXT)
      NOT IN (SELECT dataset_id FROM datasets WHERE dataset_id LIKE 'nm%')
    LIMIT 1
  `,
    )
    .first<{ n: number }>();

  return result?.n ?? 108;
}

/**
 * Check if a dataset ID is valid format
 * Accepts both nm000XXX (regular) and xx000XXX (sandbox) formats
 */
export function isValidDatasetId(id: string): boolean {
  return /^(nm|xx)\d{6}$/.test(id);
}

/**
 * Check if a dataset ID is a sandbox dataset
 */
export function isSandboxDatasetId(id: string): boolean {
  return id.startsWith("xx");
}
