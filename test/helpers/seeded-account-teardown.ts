/**
 * Best-effort teardown of the accounts a live suite seeds (#1789).
 *
 * The live suites seed a NEW account per run through `POST /admin/test-fixtures/seed-web-user`.
 * Left alone they pile up on staging, so the daily sweep (`backend/src/services/
 * test-account-sweep.ts`) tombstones them a week later. This helper removes them at the end of
 * the suite instead, through the owner-only `DELETE /admin/users/by-id/:id`, the same
 * tombstone the sweep uses.
 *
 * Best effort, on purpose. Without `TEST_OWNER_API_KEY` it does nothing. A failed delete is
 * logged and never fails the suite: the sweep is the backstop for whatever this misses.
 */

import { TEST_CONFIG } from "../setup";

const seededIds: number[] = [];

/** Remember a seeded account's id from the seed route's response body. */
export function rememberSeededAccount(body: unknown): void {
  const id = (body as { user?: { id?: unknown } } | null)?.user?.id;
  if (typeof id === "number" && Number.isInteger(id) && id > 0) seededIds.push(id);
}

/** Tombstone every remembered account. Never throws. Returns how many were deleted. */
export async function deleteSeededAccounts(
  api: string,
  baseHeaders: Record<string, string>,
): Promise<number> {
  const ids = seededIds.splice(0);
  if (ids.length === 0) return 0;
  if (!TEST_CONFIG.ownerApiKey) {
    console.log(
      `[teardown] TEST_OWNER_API_KEY unset; leaving ${ids.length} seeded account(s) for the sweep`,
    );
    return 0;
  }
  let deleted = 0;
  for (const id of ids) {
    try {
      const r = await fetch(`${api}/admin/users/by-id/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${TEST_CONFIG.ownerApiKey}`, ...baseHeaders },
      });
      if (r.status === 200) deleted++;
      else console.warn(`[teardown] delete of seeded account id=${id} returned ${r.status}`);
    } catch (err) {
      console.warn(
        `[teardown] delete of seeded account id=${id} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return deleted;
}
