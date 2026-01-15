/**
 * Dataset ID generation service
 *
 * Generates centralized sequential IDs in the format nm000XXX
 */

/**
 * Generate the next dataset ID
 *
 * Uses atomic UPDATE RETURNING to ensure uniqueness across concurrent requests.
 */
export async function generateDatasetId(db: D1Database): Promise<string> {
  // Atomic increment and return
  const result = await db
    .prepare(
      `
    UPDATE id_sequence
    SET next_number = next_number + 1
    WHERE prefix = 'nm'
    RETURNING next_number - 1 as current_number
  `
    )
    .first<{ current_number: number }>();

  if (!result) {
    throw new Error("Failed to generate dataset ID: no sequence found");
  }

  // Format as nm000XXX (zero-padded to 6 digits)
  const id = `nm${result.current_number.toString().padStart(6, "0")}`;

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
 */
export function isValidDatasetId(id: string): boolean {
  return /^nm\d{6}$/.test(id);
}
