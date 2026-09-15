/**
 * The owner projection stays in one place (#1407, epic #1406).
 *
 * A source-level assertion, in the same shape as the one
 * `test/data-summary-route.test.ts` uses to keep the summary route a
 * passthrough. It exists because of what ADR 0017 already concedes about
 * visibility scoping: "every new list, search, or catalog endpoint inherits
 * the obligation ... getting one wrong reopens the hole." The obligation here
 * is narrower and easier to discharge -- withhold the owner when the dataset
 * is anonymous -- but it has the same failure mode, which is a sixth query
 * added later that spells the join out by hand and quietly names a depositor
 * who paid for concealment.
 *
 * So the rule is a constant in `services/anonymity.ts`, and this test fails if
 * any site selects the raw columns instead of interpolating it. A runtime test
 * cannot catch this: a new endpoint that leaks is new code, and no assertion
 * about the existing endpoints would run against it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { OWNER_GITHUB_SQL, OWNER_USERNAME_SQL } from "../src/services/anonymity";

const SRC = join(import.meta.dir, "..", "src");

/** Every .ts file under backend/src, so a new route cannot opt out by living somewhere new. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** `u.username AS owner_username` and friends, in any spelling SQL allows. */
const RAW_OWNER_USERNAME = /\bu\.username\s+as\s+owner_username\b/i;
const RAW_OWNER_GITHUB = /\bu\.github_username\s+as\s+owner_github\b/i;

/**
 * Sites that resolve the real owner ON PURPOSE, each with the reason.
 *
 * Requirement R5: anonymity is toward the public and never toward the
 * archive. NEMAR has to keep knowing who deposited a dataset -- to mint a DOI
 * with a real curator at publication, to email the owner, to run the
 * publication flow at all -- so an internal read of `users.username` is not a
 * leak, it is the feature. What would be a leak is an ANONYMOUS-facing
 * projection: a list, a search result, a detail payload.
 *
 * The list is explicit rather than a path heuristic so that adding a file to
 * it is a deliberate act with a justification attached, the same shape
 * `test/api-export-surface.unit.test.ts` uses for its post-split additions. A
 * new public endpoint that joins the owner by hand is not on this list and
 * therefore fails.
 */
const DELIBERATE_INTERNAL_READS: Readonly<Record<string, string>> = {
  "routes/datasets/publication.ts":
    "publication request handling; owner-or-admin only, and the request is about the owner",
  "routes/admin/doi.ts": "admin-only DOI minting; the curator must be the real person (ADR 0041)",
  "routes/admin/exemplar.ts": "admin-only exemplar tooling, never an anonymous surface",
  "services/enrich-dataset.ts":
    "resolves the uploader to build DataCite attribution; blinds at the WRITE instead",
  "services/publication-orchestrator.ts": "the publish flow itself, which is where anonymity ends",
};

describe("owner identity is projected through one rule", () => {
  test("no source file spells the owner join out by hand", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = file.slice(SRC.length + 1);
      // The constants themselves contain the column names, by construction.
      if (rel === join("services", "anonymity.ts")) continue;
      if (DELIBERATE_INTERNAL_READS[rel.split(sep).join("/")]) continue;
      const text = readFileSync(file, "utf8");
      if (RAW_OWNER_USERNAME.test(text) || RAW_OWNER_GITHUB.test(text)) {
        offenders.push(rel);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("the rule withholds only when the dataset is anonymous", () => {
    // Pinning the SQL text rather than only its behavior: these strings are
    // interpolated into queries in five places, and a change here is a change
    // to what every one of them discloses.
    expect(OWNER_USERNAME_SQL).toBe(
      "CASE WHEN d.anonymous = 1 THEN NULL ELSE u.username END AS owner_username",
    );
    expect(OWNER_GITHUB_SQL).toBe(
      "CASE WHEN d.anonymous = 1 THEN NULL ELSE u.github_username END AS owner_github",
    );
  });

  test("the catalog's projections use the rule", () => {
    const catalog = readFileSync(join(SRC, "routes", "datasets", "catalog.ts"), "utf8");
    // Five sites today: the FTS-fallback list, the "mine" list, the main list,
    // the source-id lookup, and the detail route. The count is asserted
    // loosely on purpose -- a sixth site is fine, a site that bypasses the
    // rule is not, and the test above is what catches that.
    const uses = catalog.match(/\$\{OWNER_USERNAME_SQL\}/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(5);
    expect(catalog).toContain("${OWNER_GITHUB_SQL}");
  });
});
