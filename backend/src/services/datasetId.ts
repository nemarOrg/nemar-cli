/**
 * Dataset ID generation service
 *
 * Generates centralized sequential IDs:
 * - nm000XXX for regular datasets
 * - xx000XXX for sandbox datasets
 */

/**
 * Generate the next dataset ID
 *
 * Uses atomic UPDATE RETURNING to ensure uniqueness across concurrent requests.
 *
 * @param db - D1 database instance
 * @param sandbox - If true, generates xx000XXX sandbox ID instead of nm000XXX
 */
export async function generateDatasetId(db: D1Database, sandbox = false): Promise<string> {
  const prefix = sandbox ? "xx" : "nm";

  // Atomic increment and return
  const result = await db
    .prepare(
      `
    UPDATE id_sequence
    SET next_number = next_number + 1
    WHERE prefix = ?
    RETURNING next_number - 1 as current_number
  `
    )
    .bind(prefix)
    .first<{ current_number: number }>();

  if (!result) {
    throw new Error(`Failed to generate dataset ID: no sequence found for prefix '${prefix}'`);
  }

  // Format as XX000XXX (zero-padded to 6 digits)
  const id = `${prefix}${result.current_number.toString().padStart(6, "0")}`;

  return id;
}

/**
 * Get the current sequence value without incrementing
 */
export async function getCurrentSequence(db: D1Database): Promise<number> {
  const result = await db
    .prepare("SELECT next_number FROM id_sequence WHERE prefix = 'nm'")
    .first<{ next_number: number }>();

  return result?.next_number ?? 108;
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
