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
 *     `xx` ids (sandboxes and the exemplar fleet, in any environment) and the reserved
 *     `nm0999xx` fixtures out, an anonymous deposit never.
 *
 * The predicate is imported, never retyped (.rules/testing.md).
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { RESERVED_FIXTURE_FLOOR, formatDatasetId } from "../src/services/datasetId";
import {
  FEDERATION_TERMS,
  type FederationRow,
  type FederationTermId,
  NEUROBAGEL_ELIGIBLE_SQL,
  NEUROBAGEL_REAL_NM_CEILING,
  NEUROBAGEL_ROW_COLUMNS,
  couldBeFederated,
  eligibleAmong,
  failedFederationTerms,
  isFederationEligible,
  loadEligibleRow,
} from "../src/services/neurobagel-eligibility";
import { NEUROBAGEL_PLAN_ROWS_SQL } from "../src/services/neurobagel-plan";
import { freshDb, realD1 } from "./helpers/d1";
import { seedDatasetRow } from "./helpers/neurobagel-harness";

let db: Database;
beforeEach(() => {
  db = freshDb();
});

/** The rows the real predicate selects, by id. */
async function selected(sqlOverride?: string): Promise<string[]> {
  const sql =
    sqlOverride ??
    `SELECT d.dataset_id FROM datasets d WHERE ${NEUROBAGEL_ELIGIBLE_SQL} ORDER BY d.dataset_id`;
  const result = await realD1(db).prepare(sql).all<{ dataset_id: string }>();
  return result.results.map((r) => r.dataset_id);
}

/** The predicate with ONE term left out: the mutant. */
function predicateWithout(term: FederationTermId): string {
  return FEDERATION_TERMS.filter((t) => t.id !== term)
    .map((t) => t.sql)
    .join(" AND ");
}

describe("the predicate's shape", () => {
  test("binds no parameter: every id a term names is a literal, so the predicate has no environment input", () => {
    expect(NEUROBAGEL_ELIGIBLE_SQL.match(/\?/g)).toBeNull();
    // The pure form takes the row and nothing else.
    expect(isFederationEligible.length).toBe(1);
    for (const t of FEDERATION_TERMS) expect(t.holds.length).toBe(1);
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
    // The plan's wider projection reads the DOI only through the anonymity blind.
    expect(NEUROBAGEL_PLAN_ROWS_SQL).not.toMatch(/\bd\.concept_doi\b(?!\s*END)/);
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
      expect(await selected()).toEqual(["nm000501"]);

      // The mutant: the same predicate minus this one term accepts the broken row.
      // If it did not, the term would be doing nothing a test could see.
      const mutant = `SELECT d.dataset_id FROM datasets d WHERE ${predicateWithout(term.id)} ORDER BY d.dataset_id`;
      const accepted = await selected(mutant);
      expect(accepted).toContain(id);

      // And the TypeScript form says the same about the same row.
      const row = await realD1(db)
        .prepare(`SELECT ${NEUROBAGEL_ROW_COLUMNS} FROM datasets d WHERE d.dataset_id = ?`)
        .bind(id)
        .first<FederationRow>();
      expect(isFederationEligible(row)).toBe(false);
      expect(failedFederationTerms(row)).toEqual([term.id]);
      const mutantTs = FEDERATION_TERMS.filter((t) => t.id !== term.id).every((t) =>
        t.holds(row as FederationRow),
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
    const { row } = await loadEligibleRow(realD1(db), "nm000504");
    expect(isFederationEligible({ ...(row as FederationRow), anonymous: null })).toBe(false);
  });

  test("with the schema's triggers in place an anonymous row fails two terms, which back each other up", async () => {
    // The row the invariant allows: anonymous and NOT first-published.
    seedDatasetRow(db, "nm000502", { anonymous: 1, firstPublishedAt: null });
    const row = (await loadEligibleRow(realD1(db), "nm000502")).row as FederationRow;
    expect(failedFederationTerms(row)).toEqual(["not_anonymous", "first_published"]);
    // And the schema really does refuse the row that would separate them.
    expect(() =>
      seedDatasetRow(db, "nm000503", { anonymous: 1, firstPublishedAt: "2026-01-02 03:04:05" }),
    ).toThrow(/anonymous requires first_published_at IS NULL/);
  });

  test("the baseline row satisfies every term in TypeScript", () => {
    expect(isFederationEligible(BASE)).toBe(true);
    expect(failedFederationTerms(BASE)).toEqual([]);
  });

  test("a null row, and a NULL anonymous, are not eligible: unknown is not false", () => {
    expect(isFederationEligible(null)).toBe(false);
    expect(isFederationEligible(undefined)).toBe(false);
    expect(isFederationEligible({ ...BASE, anonymous: null })).toBe(false);
    expect(isFederationEligible({ ...BASE, has_version: null })).toBe(false);
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

    const bySql = new Set(await selected());
    const rows = await realD1(db)
      .prepare(`SELECT ${NEUROBAGEL_ROW_COLUMNS} FROM datasets d ORDER BY d.dataset_id`)
      .all<FederationRow>();
    expect(rows.results).toHaveLength(seeded);
    let accepted = 0;
    for (const row of rows.results) {
      const byTs = isFederationEligible(row);
      if (byTs) accepted++;
      expect(`${row.dataset_id}:${byTs}`).toBe(`${row.dataset_id}:${bySql.has(row.dataset_id)}`);
    }
    // Not vacuous: some rows accepted, most rejected.
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThan(seeded / 2);
  });

  test("exactly the baseline vector of the two real classes is accepted", async () => {
    for (const klass of CLASSES) {
      for (const [i, vector] of VECTORS.entries()) {
        seedDatasetRow(db, `${klass.prefix}${String(klass.base + i).padStart(6, "0")}`, vector);
      }
    }
    // Nothing in the `xx` classes, the exemplar band's included, is eligible.
    expect(await selected()).toEqual(["nm000108", "on000100"]);
  });
});

describe("which datasets are federated", () => {
  const rowsFor = async () => selected();

  test("`nm` below the reserved band and `on` mirrors are in; `xx` and `nm0999xx` are out", async () => {
    for (const id of ["nm000108", "nm099899", "on000117", "on099950", "nm000103"]) {
      seedDatasetRow(db, id);
    }
    for (const id of ["xx000042", "xx090001", "nm099900", "nm099950", "nm099999", "ds000117"]) {
      seedDatasetRow(db, id);
    }
    const expected = ["nm000103", "nm000108", "nm099899", "on000117", "on099950"];
    expect(await rowsFor()).toEqual(expected);
  });

  test("an `on` mirror is included by the owner's decision (not just tolerated)", async () => {
    seedDatasetRow(db, "on004166");
    expect(await rowsFor()).toEqual(["on004166"]);
  });

  test("a sandbox or an exemplar flag on a real id excludes it", async () => {
    seedDatasetRow(db, "nm000200", { isSandbox: 1 });
    seedDatasetRow(db, "nm000201", { isExemplar: 1 });
    seedDatasetRow(db, "on000200", { isSandbox: 1 });
    expect(await rowsFor()).toEqual([]);
  });

  test("an `xx` id is never eligible, in any environment, whatever else it carries", async () => {
    // The exemplar fleet (`xx0999NN`, `is_exemplar = 1`) and a sandbox row: every other term
    // holds for both, so only the id decides. The store and the index schema hold `nm` and
    // `on` ids, so admitting one would rewrite it on every run and never index it.
    seedDatasetRow(db, "xx099903", { isExemplar: 1, isSandbox: 1 });
    seedDatasetRow(db, "xx099910", { isExemplar: 1 });
    seedDatasetRow(db, "xx000001", { isSandbox: 1 });
    seedDatasetRow(db, "xx000002", { isExemplar: 0, isSandbox: 0 });
    seedDatasetRow(db, "nm099997", { isExemplar: 1, isSandbox: 1 });
    expect(await rowsFor()).toEqual([]);
    const d1 = realD1(db);
    for (const id of ["xx099903", "xx099910", "xx000001", "xx000002", "nm099997"]) {
      const { row, eligible } = await loadEligibleRow(d1, id);
      expect(eligible).toBe(false);
      expect(failedFederationTerms(row)).toEqual(["real_dataset"]);
      expect(couldBeFederated(id)).toBe(false);
    }
    expect((await eligibleAmong(d1, ["xx099903", "xx000001", "xx000002"])).size).toBe(0);
    // The predicate takes no environment, so there is no setting under which this changes.
    expect(isFederationEligible.length).toBe(1);
  });

  test("the standing anonymous deposit is never eligible, on any ground", async () => {
    seedDatasetRow(db, "nm099998", { anonymous: 1, firstPublishedAt: null, isSandbox: 1 });
    expect(await rowsFor()).toEqual([]);
    const { row, eligible } = await loadEligibleRow(realD1(db), "nm099998");
    expect(eligible).toBe(false);
    expect(failedFederationTerms(row)).toEqual(
      expect.arrayContaining(["not_anonymous", "first_published", "real_dataset"]),
    );
  });

  test("a withdrawn dataset is out even though a withdrawal also makes it private", async () => {
    seedDatasetRow(db, "nm000300", { withdrawnAt: "2026-02-01 00:00:00" });
    expect(await rowsFor()).toEqual([]);
    const row = (await loadEligibleRow(realD1(db), "nm000300")).row as FederationRow;
    expect(failedFederationTerms(row)).toEqual(["not_withdrawn"]);
  });
});

describe("couldBeFederated: ids that never are", () => {
  test("by id alone", () => {
    expect(couldBeFederated("nm000108")).toBe(true);
    expect(couldBeFederated("on000117")).toBe(true);
    expect(couldBeFederated("nm099900")).toBe(false);
    expect(couldBeFederated("nm099999")).toBe(false);
    expect(couldBeFederated("xx000042")).toBe(false);
    expect(couldBeFederated("xx099903")).toBe(false);
    expect(couldBeFederated("garbage")).toBe(false);
  });
});

describe("eligibleAmong re-checks every row the SQL returns", () => {
  test("returns the eligible subset of a list, and nothing for an empty one", async () => {
    seedDatasetRow(db, "nm000108");
    seedDatasetRow(db, "nm000109", { visibility: "private" });
    seedDatasetRow(db, "on000117");
    const d1 = realD1(db);
    expect(
      [...(await eligibleAmong(d1, ["nm000108", "nm000109", "on000117", "nm000999"]))].sort(),
    ).toEqual(["nm000108", "on000117"]);
    expect((await eligibleAmong(d1, [])).size).toBe(0);
  });
});
