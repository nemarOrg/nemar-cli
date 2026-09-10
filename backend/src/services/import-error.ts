/**
 * The one rule about `import_jobs.last_error` (epic #1306, ADR 0051).
 *
 *   A SPECIFIC error message must never be overwritten by a GENERIC one.
 *
 * The import pipeline writes `last_error` from several places, and only some of
 * them know why the import actually failed:
 *
 *   - The failing job itself knows. `onboard-openneuro.yml`'s prepare leg tees the
 *     CLI output and can post the real message.
 *   - The `report` job does NOT. It is a separate job on a separate runner, so the
 *     tee'd log does not exist for it; all it can post is the roll-up
 *     `terminal: prepare=... copy=... finalize=...`.
 *   - Recovery and the stuck-import sweep do not either. They write status words
 *     (`quarantined: <reason>`, `auto-rollback: <reason>`, `stuck > 6h`) that say
 *     what WE did, not what went wrong.
 *
 * Because the uninformed writers run LAST (the report job needs prepare/copy/finalize
 * to finish; recovery runs after the failure is recorded), the naive
 * last-write-wins would guarantee the least useful message survives. That is
 * exactly what happened: every machine-filed import-failure issue between
 * 2026-07-22 and 2026-09-08 recorded `terminal: prepare=failure copy=failure
 * finalize=failure`, while the real causes -- an expired PAT, a git-annex uuid
 * collision, a branch-protection rule, a rebase conflict -- were only ever visible
 * by opening the Actions log by hand.
 *
 * This was not just a reporting problem. `IMPORT_RETRY_CANDIDATES_QUERY`
 * (services/import-retry.ts) re-selects a QUARANTINED row only when its
 * `last_error` still carries the literal `[openneuro-upstream-inaccessible]`
 * marker. Recovery's own `quarantined: upstream_inaccessible` does not contain
 * that bracketed string, so the recovery path destroyed the marker the retry
 * engine depends on and stranded those rows permanently.
 *
 * The "why" of a recovery decision is not lost by preserving the specific error:
 * `runImportRecovery` already writes the full decision to `audit_log`
 * (`import_quarantined` / `import_rolled_back`), which is the right home for it.
 *
 * Kept free of imports from import-recovery/import-retry on purpose: those modules
 * consume this rule, so a dependency the other way would be a cycle. The rule needs
 * no knowledge of any specific marker -- a marker is simply one kind of specific.
 */

/**
 * Prefixes the pipeline writes when it has no specific cause to report. A message
 * starting with one of these carries only pipeline bookkeeping, never a diagnosis.
 *
 * Keep in sync with the writers:
 *   - `terminal: `      -- onboard-openneuro.yml's `report` job
 *   - `quarantined: `   -- markImportStatus via runImportRecovery
 *   - `auto-rollback: ` -- markImportStatus via runImportRecovery
 *   - `stuck > 6h`      -- the scheduled stuck-import sweep in index.ts
 */
export const GENERIC_IMPORT_ERROR_PREFIXES = [
  "terminal: ",
  "quarantined: ",
  "auto-rollback: ",
  "stuck > 6h",
] as const;

/**
 * True when `message` carries no diagnosis: null, blank, or one of the bookkeeping
 * prefixes above. Absence of information counts as generic, so a NULL from the
 * finalizing callback can never erase a real error.
 */
export function isGenericImportError(message: string | null | undefined): boolean {
  const trimmed = message?.trim();
  if (!trimmed) return true;
  return GENERIC_IMPORT_ERROR_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/**
 * Decide which of two messages `last_error` should end up holding. Pure, and the
 * reference implementation of the rule -- {@link lastErrorAssignmentSql} is the same
 * decision expressed in SQL.
 *
 * A specific incoming message always wins (a later, better diagnosis should
 * replace an earlier one). A generic incoming message wins only when there is
 * nothing specific to protect.
 */
export function resolveImportError(
  stored: string | null | undefined,
  incoming: string | null | undefined,
): string | null {
  if (isGenericImportError(incoming) && !isGenericImportError(stored)) {
    return stored ?? null;
  }
  return incoming ?? null;
}

/** SQL string literal, single quotes escaped. */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * SQLite's bare `TRIM(x)` strips SPACES only, while JS `.trim()` strips all
 * whitespace. Passing the character set explicitly closes that gap, so a message
 * indented with a tab or led by a newline is classified the same on both sides.
 */
function sqlTrimmed(expr: string): string {
  return `TRIM(${expr}, ' ' || char(9) || char(10) || char(11) || char(12) || char(13))`;
}

/**
 * SQL boolean: true when the message at `expr` carries a real diagnosis worth
 * protecting. Only the STORED side needs to be decided in SQL -- every call site
 * already knows its incoming message in TypeScript and can use
 * {@link isGenericImportError} there, which keeps the incoming value bound exactly
 * once instead of once per prefix.
 *
 * This is the SAME rule as {@link isGenericImportError}, so it must reach the same
 * verdict on the same string; `import-error.test.ts` runs both over a shared corpus
 * to keep them honest. Two SQLite defaults would otherwise break that agreement,
 * and both are avoided here rather than papered over:
 *
 *   - `LIKE` is case-INSENSITIVE for ASCII, so `'Terminal: x' LIKE 'terminal: %'`
 *     is true while `"Terminal: x".startsWith("terminal: ")` is false. A prefix
 *     test via `substr(...) != '...'` uses the default BINARY collation and is
 *     case-sensitive, matching JS.
 *   - `LIKE` also gives `%` and `_` wildcard meaning inside the pattern. Comparing
 *     a substring instead removes pattern semantics altogether, so a prefix that
 *     one day contains either character keeps working and needs no escape clause.
 *
 * `substr` counts characters and every prefix is ASCII, so `prefix.length` (UTF-16
 * code units, as `startsWith` compares) is the right length to take.
 */
export function storedErrorIsSpecificSql(expr: string): string {
  const trimmed = sqlTrimmed(expr);
  return [
    `${expr} IS NOT NULL`,
    `${trimmed} != ''`,
    ...GENERIC_IMPORT_ERROR_PREFIXES.map(
      (p) => `substr(${trimmed}, 1, ${p.length}) != ${sqlLiteral(p)}`,
    ),
  ].join("\n                AND ");
}

/**
 * The SQL assignment for `last_error`, given whether the incoming message is
 * generic (decided in TypeScript via {@link isGenericImportError}).
 *
 * - Incoming is specific -> it always wins; the assignment is just the parameter,
 *   so a better later diagnosis replaces an earlier one.
 * - Incoming is generic -> keep the stored message when it is specific.
 *
 * `paramExpr` is the SQL expression for the incoming value (`?` in an UPDATE,
 * `excluded.last_error` in an upsert) and appears at most once.
 */
export function lastErrorAssignmentSql(
  incomingIsGeneric: boolean,
  storedExpr: string,
  paramExpr: string,
): string {
  if (!incomingIsGeneric) return paramExpr;
  return `CASE
              WHEN ${storedErrorIsSpecificSql(storedExpr)}
              THEN ${storedExpr}
              ELSE ${paramExpr} END`;
}
