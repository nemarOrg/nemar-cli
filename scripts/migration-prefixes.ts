/**
 * Reject two D1 migrations that share a numeric prefix.
 *
 * `wrangler d1 migrations apply` tracks what it has applied by FILE NAME, not by
 * number, and applies the rest in lexicographic order. Two branches that each add
 * `0150_*.sql` therefore both merge cleanly, both apply, and the order between
 * them is decided by the rest of the file name rather than by anyone's intent;
 * a later migration that assumes one ran first can break on a fresh database.
 * Nothing else notices, so `test/migration-prefixes.unit.test.ts` holds this rule
 * over `backend/src/db/migrations`, and `scripts/d1-migration-check.ts` runs it
 * before replaying anything.
 *
 * Renumber the newer file instead of adding to the allowlist below.
 */

import { readdirSync } from "node:fs";

/**
 * Prefixes that were already shared when this check landed. Both pairs are applied
 * in production under these exact names, so renaming either file would make wrangler
 * apply it again. Each entry lists the exact files; a third file on one of these
 * prefixes still fails.
 */
export const GRANDFATHERED_PREFIXES: ReadonlyMap<string, readonly string[]> = new Map([
  ["0003", ["0003_dataset_collaborators.sql", "0003_user_aws_credentials.sql"]],
  ["0015", ["0015_email_preferences.sql", "0015_publish_block_reason.sql"]],
]);

/** One numeric prefix carried by more than one migration file. */
export interface DuplicatePrefix {
  prefix: string;
  files: string[];
}

/**
 * Every numeric prefix shared by two or more `.sql` files in `dir`, excluding a
 * grandfathered prefix whose files are exactly the grandfathered set. A `.sql` file
 * without a leading `NNNN_` prefix is reported under the prefix `(none)`.
 */
export function duplicateMigrationPrefixes(
  dir: string,
  grandfathered: ReadonlyMap<string, readonly string[]> = GRANDFATHERED_PREFIXES,
): DuplicatePrefix[] {
  const byPrefix = new Map<string, string[]>();
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const prefix = /^(\d+)_/.exec(file)?.[1] ?? "(none)";
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), file]);
  }
  const duplicates: DuplicatePrefix[] = [];
  for (const [prefix, files] of byPrefix) {
    if (prefix === "(none)") {
      duplicates.push({ prefix, files });
      continue;
    }
    if (files.length < 2) continue;
    const allowed = grandfathered.get(prefix);
    if (allowed && allowed.length === files.length && allowed.every((f) => files.includes(f))) {
      continue;
    }
    duplicates.push({ prefix, files });
  }
  return duplicates;
}
