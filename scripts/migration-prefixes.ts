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
 * wrangler reads a migration's number as `parseInt(name.split("_")[0])` but applies in string-sort
 * order, so `00153_b.sql` or `154_x.sql` beside `0153_a.sql` would sort and number apart. Every
 * migration therefore carries exactly four digits and an underscore.
 */
const PREFIX = /^(\d{4})_/;

function sqlFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** `.sql` files in `dir` without an exact four-digit `NNNN_` prefix. */
export function malformedMigrationNames(dir: string): string[] {
  return sqlFiles(dir).filter((f) => !PREFIX.test(f));
}

/**
 * Every four-digit prefix shared by two or more `.sql` files in `dir`, excluding a grandfathered
 * prefix whose files are exactly the grandfathered set. A file without a four-digit prefix is not
 * counted here; {@link malformedMigrationNames} reports it.
 */
export function duplicateMigrationPrefixes(
  dir: string,
  grandfathered: ReadonlyMap<string, readonly string[]> = GRANDFATHERED_PREFIXES,
): DuplicatePrefix[] {
  const byPrefix = new Map<string, string[]>();
  for (const file of sqlFiles(dir)) {
    const prefix = PREFIX.exec(file)?.[1];
    if (prefix === undefined) continue;
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), file]);
  }
  const duplicates: DuplicatePrefix[] = [];
  for (const [prefix, files] of byPrefix) {
    if (files.length < 2) continue;
    const allowed = grandfathered.get(prefix);
    if (allowed && allowed.length === files.length && allowed.every((f) => files.includes(f))) {
      continue;
    }
    duplicates.push({ prefix, files });
  }
  return duplicates;
}

/** One line per problem in `dir`, saying what to do; empty when every migration is numbered once. */
export function migrationPrefixProblems(dir: string): string[] {
  const malformed = malformedMigrationNames(dir);
  return [
    ...(malformed.length > 0
      ? [
          `Migration without a 4-digit NNNN_ prefix: ${malformed.join(", ")}; give it the next number`,
        ]
      : []),
    ...duplicateMigrationPrefixes(dir).map(
      (d) => `Shared migration prefix ${d.prefix}: ${d.files.join(", ")}; renumber the newer file`,
    ),
  ];
}
