/**
 * The revision of the identifier rules an import ran under, for its ledger line (ADR 0089).
 *
 * A ledger line names the scanner that decided what was removed (`identifier-scan@<hex>`, ADR
 * 0085). The ledger CLI takes the last commit that touched the rule files, from a checkout; the
 * importer runs from the published package, where there is no checkout and no commit to name. So
 * the importer names the rules by their CONTENT: the first 16 hex digits of the sha256 over the
 * rule files' paths and bytes, which changes exactly when the rules do.
 *
 * Imported with `with { type: "macro" }`: Bun runs this at bundle (and transpile) time and inlines
 * the string, so the published CLI carries the digest of the sources it was built from and never
 * reads a file at run time.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The files whose rules decide what the import's scrub changes, repo-relative. */
export const SCANNER_RULE_SOURCES = [
  "shared/identifier-scan.ts",
  "shared/identifier-scrub.ts",
] as const;

/** The digest over {@link SCANNER_RULE_SOURCES}, read from the repository this file sits in. */
export function scannerRulesDigest(): string {
  const root = join(import.meta.dir, "..", "..");
  const hash = createHash("sha256");
  for (const rel of SCANNER_RULE_SOURCES) {
    hash.update(`${rel}\0`);
    hash.update(readFileSync(join(root, rel)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}
