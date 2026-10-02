/**
 * The federation eligibility predicate (epic #1586, phase 4; ADR 0084).
 *
 * The predicate is one list of named terms, each with its SQL and its TypeScript
 * form. This file proves three things about it, against the real schema:
 *
 *  1. SQL and TypeScript AGREE: every combination of the facts the terms read goes
 *     through both, and any disagreement fails the test.
 *  2. EACH TERM IS NECESSARY (mutation-style): for every term there is a row that
 *     breaks exactly that term and no other, the real predicate rejects it, and the
 *     predicate with that one term REMOVED accepts it. A term nothing depends on
 *     would leave the mutant rejecting the row too, and fail here.
 *  3. The rows the epic names come out the way the owner decided: `on` mirrors in,
 *     `xx` sandboxes and the reserved `nm0999xx` fixtures out, exemplars in only
 *     outside production, an anonymous deposit never.
 *
 * The predicate is imported, never retyped (.rules/testing.md).
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { RESERVED_FIXTURE_FLOOR, formatDatasetId } from "../src/services/datasetId";
import {
  FEDERATION_TERMS,
  type FederationContext,
  type FederationRow,
  type FederationTermId,
  NEUROBAGEL_ELIGIBLE_ROWS_SQL,
  NEUROBAGEL_ELIGIBLE_SQL,
  NEUROBAGEL_REAL_NM_CEILING,
  NEUROBAGEL_ROW_COLUMNS,
  allowExemplarsFor,
  couldBeFederated,
  eligibleAmong,
  failedFederationTerms,
  federationContext,
  isFederationEligible,
  loadEligibleRow,
  neurobagelEligibleBinds,
} from "../src/services/neurobagel-eligibility";
import { freshDb, realD1 } from "./helpers/d1";
import { seedDatasetRow } from "./helpers/neurobagel-harness";

const PROD: FederationContext = { allowExemplars: false };
const STAGING: FederationContext = { allowExemplars: true };

let db: Database;
beforeEach(() => {
  db = freshDb();
});

/** The rows the real predicate selects, by id. */
async function selected(ctx: FederationContext, sqlOverride?: string): Promise<string[]> {
  const sql =
    sqlOverride ??
    `SELECT d.dataset_id FROM datasets d WHERE ${NEUROBAGEL_ELIGIBLE_SQL} ORDER BY d.dataset_id`;
  const result = await realD1(db)
    .prepare(sql)
    .bind(...neurobagelEligibleBinds(ctx))
    .all<{ dataset_id: string }>();
  return result.results.map((r) => r.dataset_id);
}

/** The predicate with ONE term left out: the mutant. */
function predicateWithout(term: FederationTermId): string {
  return FEDERATION_TERMS.filter((t) => t.id !== term)
    .map((t) => t.sql)
    .join(" AND ");
}

describe("the predicate's shape", () => {
  test("holds exactly one bound parameter, the exemplar flag, and the helper binds it first", () => {
    expect(NEUROBAGEL_ELIGIBLE_SQL.match(/\?/g)).toHaveLength(1);
    expect(neurobagelEligibleBinds(PROD)).toEqual([0]);
    expect(neurobagelEligibleBinds(STAGING)).toEqual([1]);
  });

  test("names every term it ANDs, and each id once", () => {
    const ids = FEDERATION_TERMS.map((t) => t.id);
    expect(ids).toEqual([
      "active",
      "public",
      "not_anonymous",
      "first_published",
      "not_withdrawn",
      "has_version",
      "real_dataset",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of FEDERATION_TERMS) expect(NEUROBAGEL_ELIGIBLE_SQL).toContain(t.sql);
  });

  test("the real-id ceiling is the reserved fixture band's floor, derived and not retyped", () => {
    expect(NEUROBAGEL_REAL_NM_CEILING).toBe(formatDatasetId("nm", RESERVED_FIXTURE_FLOOR));
    expect(NEUROBAGEL_REAL_NM_CEILING).toBe("nm099900");
    expect(NEUROBAGEL_ELIGIBLE_SQL).toContain(`'${NEUROBAGEL_REAL_NM_CEILING}'`);
  });

  test("projects no identity and no DOI column", () => {
    expect(NEUROBAGEL_ROW_COLUMNS).not.toMatch(/concept_doi|owner|authors|enrichment/);
    expect(NEUROBAGEL_ELIGIBLE_ROWS_SQL).not.toMatch(/concept_doi/);
  });
});

/** A row that satisfies every term, as the baseline each mutant departs from. */
const BASE: FederationRow = {
  dataset_id: "nm000500",
  status: "active",
  visibility: "public",
  anonymous: 0,
  first_published_at: "2026-01-02 03:04:05",
  withdrawn_at: null,
  is_sandbox: 0,
  is_exemplar: 0,
  has_version: 1,
};

/** The one row per term that breaks that term and no other. */
const BREAKS: Record<
  FederationTermId,
  { seed: Parameters<typeof seedDatasetRow>[2]; id?: string; withoutTriggers?: boolean }
> = {
  active: { seed: { status: "archived" } },
  public: { seed: { visibility: "private" } },
  // The schema's triggers (migration 0085) make `anonymous = 1` imply
  // `first_published_at IS NULL`, so with them in place `first_published` ALONE
  // would reject an anonymous row and this term would look redundant. It is the
  // SECOND line, not a duplicate: a table rebuild (ADR 0034's migration 0071 was one)
  // drops triggers. So the row that proves it is the one the triggers would have
  // refused, built after dropping them, which is the state a bad migration leaves.
  not_anonymous: {
    seed: { anonymous: 1, firstPublishedAt: "2026-01-02 03:04:05" },
    withoutTriggers: true,
  },
  first_published: { seed: { firstPublishedAt: null } },
  not_withdrawn: { seed: { withdrawnAt: "2026-02-01 00:00:00" } },
  has_version: { seed: { versions: [] } },
  real_dataset: { seed: {}, id: "xx000042" },
};

describe("each term is necessary (mutation-style)", () => {
  for (const term of FEDERATION_TERMS) {
    test(`${term.id}: a row breaking only it is rejected, and accepted once the term is removed`, async () => {
      const broken = BREAKS[term.id];
      const id = broken.id ?? "nm000500";
      seedDatasetRow(db, "nm000501", {}); // a clean control that every variant accepts
      if (broken.withoutTriggers) {
        db.exec("DROP TRIGGER datasets_anonymous_unpublished_ai");
        db.exec("DROP TRIGGER datasets_anonymous_unpublished_au");
      }
      seedDatasetRow(db, id, broken.seed);

      // The real predicate: the control in, the broken row out.
      expect(await selected(STAGING)).toEqual(["nm000501"]);
      expect(await selected(PROD)).toEqual(["nm000501"]);

      // The mutant: the same predicate minus this one term accepts the broken row.
      // If it did not, the term would be doing nothing a test could see.
      const mutant = `SELECT d.dataset_id FROM datasets d WHERE ${predicateWithout(term.id)} ORDER BY d.dataset_id`;
      const accepted = await selected(STAGING, mutant);
      expect(accepted).toContain(id);

      // And the TypeScript form says the same about the same row.
      const row = await realD1(db)
        .prepare(`SELECT ${NEUROBAGEL_ROW_COLUMNS} FROM datasets d WHERE d.dataset_id = ?`)
        .bind(id)
        .first<FederationRow>();
      expect(isFederationEligible(row, STAGING)).toBe(false);
      expect(failedFederationTerms(row, STAGING)).toEqual([term.id]);
      const mutantTs = FEDERATION_TERMS.filter((t) => t.id !== term.id).every((t) =>
        t.holds(row as FederationRow, STAGING),
      );
      expect(mutantTs).toBe(true);
    });
  }

  test("an UNKNOWN anonymous value is not false in TypeScript, and the schema cannot hold one in SQL", async () => {
    // `anonymous` is NOT NULL, so no row can carry an unknown value and `= 0` and
    // `COALESCE(.., 0) = 0` select the same rows today. The TypeScript form still refuses
    // an unknown value (a row object built from a future schema, or a projection that lost
    // the column), so the two stay equally strict if the constraint is ever relaxed.
    seedDatasetRow(db, "nm000504");
    expect(() =>
      db.run("UPDATE datasets SET anonymous = NULL WHERE dataset_id = 'nm000504'"),
    ).toThrow(/NOT NULL constraint failed: datasets\.anonymous/);
    const { row } = await loadEligibleRow(realD1(db), "nm000504", PROD);
    expect(isFederationEligible({ ...(row as FederationRow), anonymous: null }, PROD)).toBe(false);
  });

  test("with the schema's triggers in place an anonymous row fails two terms, which back each other up", async () => {
    // The row the invariant allows: anonymous and NOT first-published.
    seedDatasetRow(db, "nm000502", { anonymous: 1, firstPublishedAt: null });
    const row = (await loadEligibleRow(realD1(db), "nm000502", PROD)).row as FederationRow;
    expect(failedFederationTerms(row, PROD)).toEqual(["not_anonymous", "first_published"]);
    // And the schema really does refuse the row that would separate them.
    expect(() =>
      seedDatasetRow(db, "nm000503", { anonymous: 1, firstPublishedAt: "2026-01-02 03:04:05" }),
    ).toThrow(/anonymous requires first_published_at IS NULL/);
  });

  test("the baseline row satisfies every term in TypeScript", () => {
    expect(isFederationEligible(BASE, PROD)).toBe(true);
    expect(failedFederationTerms(BASE, PROD)).toEqual([]);
  });

  test("a null row, and a NULL anonymous, are not eligible: unknown is not false", () => {
    expect(isFederationEligible(null, PROD)).toBe(false);
    expect(isFederationEligible(undefined, PROD)).toBe(false);
    expect(isFederationEligible({ ...BASE, anonymous: null }, PROD)).toBe(false);
    expect(isFederationEligible({ ...BASE, has_version: null }, PROD)).toBe(false);
  });
});

describe("SQL and TypeScript agree on every combination", () => {
  /** Id classes, each crossed with every fact vector below. `base` is the first number used. */
  const CLASSES = [
    { prefix: "nm", base: 108 }, // a real `nm`
    { prefix: "nm", base: 99900 }, // the reserved fixture band
    { prefix: "on", base: 100 }, // an OpenNeuro mirror
    { prefix: "xx", base: 100 }, // a sandbox
    { prefix: "xx", base: 99900 }, // the exemplar fleet's band
    { prefix: "ds", base: 1 }, // not a NEMAR id at all
  ];
  const published = "2026-01-02 03:04:05";
  const VECTORS: Parameters<typeof seedDatasetRow>[2][] = [
    {},
    { status: "archived" },
    { status: "deleted" },
    { visibility: "private" },
    { anonymous: 1, firstPublishedAt: null },
    { firstPublishedAt: null },
    { withdrawnAt: "2026-02-01 00:00:00" },
    { versions: [] },
    { isSandbox: 1 },
    { isExemplar: 1 },
    { isExemplar: 1, isSandbox: 1 },
    { isExemplar: 1, visibility: "private" },
    { visibility: "private", withdrawnAt: published },
    { anonymous: 1, firstPublishedAt: null, isExemplar: 1, isSandbox: 1 },
  ];

  test("every id class crossed with every fact vector is judged the same by both", async () => {
    let seeded = 0;
    for (const klass of CLASSES) {
      for (const [i, vector] of VECTORS.entries()) {
        seedDatasetRow(db, `${klass.prefix}${String(klass.base + i).padStart(6, "0")}`, vector);
        seeded++;
      }
    }
    expect(seeded).toBe(CLASSES.length * VECTORS.length);

    for (const ctx of [PROD, STAGING]) {
      const bySql = new Set(await selected(ctx));
      const rows = await realD1(db)
        .prepare(`SELECT ${NEUROBAGEL_ROW_COLUMNS} FROM datasets d ORDER BY d.dataset_id`)
        .all<FederationRow>();
      expect(rows.results).toHaveLength(seeded);
      let accepted = 0;
      for (const row of rows.results) {
        const byTs = isFederationEligible(row, ctx);
        if (byTs) accepted++;
        expect(`${row.dataset_id}:${byTs}`).toBe(`${row.dataset_id}:${bySql.has(row.dataset_id)}`);
      }
      // Not vacuous: some rows accepted, most rejected.
      expect(accepted).toBeGreaterThan(0);
      expect(accepted).toBeLessThan(seeded / 2);
    }
  });

  test("exactly the baseline vector of the two real classes is accepted in production", async () => {
    for (const klass of CLASSES) {
      for (const [i, vector] of VECTORS.entries()) {
        seedDatasetRow(db, `${klass.prefix}${String(klass.base + i).padStart(6, "0")}`, vector);
      }
    }
    expect(await selected(PROD)).toEqual(["nm000108", "on000100"]);
    // Outside production the exemplar band's own rows join, whatever else they carry.
    expect(await selected(STAGING)).toEqual(
      ["nm000108", "on000100", "xx099909", "xx099910"].sort(),
    );
  });
});

describe("which datasets are federated", () => {
  const rowsFor = async (ctx: FederationContext) => selected(ctx);

  test("`nm` below the reserved band and `on` mirrors are in; `xx` and `nm0999xx` are out", async () => {
    for (const id of ["nm000108", "nm099899", "on000117", "on099950", "nm000103"]) {
      seedDatasetRow(db, id);
    }
    for (const id of ["xx000042", "xx090001", "nm099900", "nm099950", "nm099999", "ds000117"]) {
      seedDatasetRow(db, id);
    }
    const expected = ["nm000103", "nm000108", "nm099899", "on000117", "on099950"];
    expect(await rowsFor(PROD)).toEqual(expected);
    expect(await rowsFor(STAGING)).toEqual(expected);
  });

  test("an `on` mirror is included by the owner's decision (not just tolerated)", async () => {
    seedDatasetRow(db, "on004166");
    expect(await rowsFor(PROD)).toEqual(["on004166"]);
  });

  test("a sandbox or an exemplar flag on a real id excludes it", async () => {
    seedDatasetRow(db, "nm000200", { isSandbox: 1 });
    seedDatasetRow(db, "nm000201", { isExemplar: 1 });
    seedDatasetRow(db, "on000200", { isSandbox: 1 });
    expect(await rowsFor(PROD)).toEqual([]);
    expect(await rowsFor(STAGING)).toEqual([]);
  });

  test("an exemplar is admitted outside production only, and only in its own band", async () => {
    seedDatasetRow(db, "xx099903", { isExemplar: 1, isSandbox: 1 });
    // The flag on an id outside the band is not enough.
    seedDatasetRow(db, "xx000001", { isExemplar: 1, isSandbox: 1 });
    seedDatasetRow(db, "nm099997", { isExemplar: 1, isSandbox: 1 });
    expect(await rowsFor(PROD)).toEqual([]);
    expect(await rowsFor(STAGING)).toEqual(["xx099903"]);
  });

  test("the standing anonymous deposit is never eligible, on any ground", async () => {
    seedDatasetRow(db, "nm099998", { anonymous: 1, firstPublishedAt: null, isSandbox: 1 });
    expect(await rowsFor(PROD)).toEqual([]);
    expect(await rowsFor(STAGING)).toEqual([]);
    const { row, eligible } = await loadEligibleRow(realD1(db), "nm099998", STAGING);
    expect(eligible).toBe(false);
    expect(failedFederationTerms(row, STAGING)).toEqual(
      expect.arrayContaining(["not_anonymous", "first_published", "real_dataset"]),
    );
  });

  test("a withdrawn dataset is out even though a withdrawal also makes it private", async () => {
    seedDatasetRow(db, "nm000300", { withdrawnAt: "2026-02-01 00:00:00" });
    expect(await rowsFor(PROD)).toEqual([]);
    const row = (await loadEligibleRow(realD1(db), "nm000300", PROD)).row as FederationRow;
    expect(failedFederationTerms(row, PROD)).toEqual(["not_withdrawn"]);
  });
});

describe("the environment binding fails closed", () => {
  test("only a recognized non-production environment admits exemplars", () => {
    expect(allowExemplarsFor({ ENVIRONMENT: "production" })).toBe(false);
    for (const env of ["development", "staging", "test"] as const) {
      expect(allowExemplarsFor({ ENVIRONMENT: env })).toBe(true);
    }
    // Unset or misspelled is production, never "not production".
    expect(allowExemplarsFor({ ENVIRONMENT: undefined as never })).toBe(false);
    expect(allowExemplarsFor({ ENVIRONMENT: "prod" as never })).toBe(false);
    expect(allowExemplarsFor({ ENVIRONMENT: "" as never })).toBe(false);
    expect(federationContext({ ENVIRONMENT: "production" })).toEqual({ allowExemplars: false });
  });
});

describe("couldBeFederated: ids that never are", () => {
  test("by id alone", () => {
    expect(couldBeFederated("nm000108", PROD)).toBe(true);
    expect(couldBeFederated("on000117", PROD)).toBe(true);
    expect(couldBeFederated("nm099900", PROD)).toBe(false);
    expect(couldBeFederated("nm099999", STAGING)).toBe(false);
    expect(couldBeFederated("xx000042", STAGING)).toBe(false);
    expect(couldBeFederated("xx099903", PROD)).toBe(false);
    expect(couldBeFederated("xx099903", STAGING)).toBe(true);
    expect(couldBeFederated("garbage", STAGING)).toBe(false);
  });
});

describe("eligibleAmong re-checks every row the SQL returns", () => {
  test("returns the eligible subset of a list, and nothing for an empty one", async () => {
    seedDatasetRow(db, "nm000108");
    seedDatasetRow(db, "nm000109", { visibility: "private" });
    seedDatasetRow(db, "on000117");
    const d1 = realD1(db);
    expect(
      [...(await eligibleAmong(d1, ["nm000108", "nm000109", "on000117", "nm000999"], PROD))].sort(),
    ).toEqual(["nm000108", "on000117"]);
    expect((await eligibleAmong(d1, [], PROD)).size).toBe(0);
  });
});
