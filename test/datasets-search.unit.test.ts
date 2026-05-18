/**
 * Unit tests for the dataset list endpoint's search WHERE-clause builder.
 *
 * These tests are deterministic (no DB) and verify which columns the
 * search LIKE pattern is matched against. The integration test in
 * api.test.ts cannot reliably exercise the original bug -- it picks
 * whichever managed dataset is first in the test DB, which may happen
 * to have an id baked into c.search_text. This unit test pins the
 * contract directly: dataset_id (and source_id for managed openneuro
 * mirrors) MUST appear in the LIKE clause regardless of search_text
 * state, and c.id MUST appear for the catalog branch.
 */

import { describe, expect, test } from "bun:test";
import { buildFilterClauses, escapeLikePattern } from "../backend/src/routes/datasets";

describe("buildFilterClauses search clause", () => {
  test("managed branch includes dataset_id and source_id columns", () => {
    const params: (string | number)[] = [];
    const clauses = buildFilterClauses(params, { search: "nm000166", managed: true });
    expect(clauses).toContain("LOWER(d.dataset_id) LIKE ?");
    expect(clauses).toContain("LOWER(COALESCE(d.source_id, '')) LIKE ?");
    expect(clauses).toContain("LOWER(d.name) LIKE ?");
    expect(clauses).toContain("LOWER(d.description) LIKE ?");
    expect(clauses).toContain("LOWER(COALESCE(c.search_text, '')) LIKE ?");
  });

  test("managed branch binds the same lowercased pattern across all five columns", () => {
    const params: (string | number)[] = [];
    buildFilterClauses(params, { search: "NM000166", managed: true });
    expect(params).toEqual([
      "%nm000166%",
      "%nm000166%",
      "%nm000166%",
      "%nm000166%",
      "%nm000166%",
    ]);
  });

  test("catalog branch includes c.id alongside c.search_text", () => {
    const params: (string | number)[] = [];
    const clauses = buildFilterClauses(params, { search: "ds002718", managed: false });
    expect(clauses).toContain("LOWER(c.id) LIKE ?");
    expect(clauses).toContain("LOWER(c.search_text) LIKE ?");
    expect(params).toEqual(["%ds002718%", "%ds002718%"]);
  });

  test("every LIKE predicate carries an ESCAPE clause", () => {
    // SQLite needs ESCAPE on every LIKE that consumes an escaped pattern,
    // otherwise the backslash is treated as a literal and the predicate
    // becomes "match a name containing backslash plus %".
    const managed = buildFilterClauses([], { search: "x", managed: true });
    const catalog = buildFilterClauses([], { search: "x", managed: false });
    // Count LIKE-with-ESCAPE clauses: 5 on managed (id, source_id, name,
    // description, search_text), 2 on catalog (id, search_text). If a LIKE
    // ever ships without ESCAPE, count drops and this test fails loudly.
    expect(managed.split("LIKE ? ESCAPE '\\'").length - 1).toBe(5);
    expect(catalog.split("LIKE ? ESCAPE '\\'").length - 1).toBe(2);
  });

  test("no search returns empty clauses (nothing pushed)", () => {
    const params: (string | number)[] = [];
    const clauses = buildFilterClauses(params, { managed: true });
    expect(clauses).toBe("");
    expect(params).toEqual([]);
  });
});

describe("escapeLikePattern", () => {
  test("escapes % so a literal-percent search doesn't match every row", () => {
    expect(escapeLikePattern("%")).toBe("\\%");
    expect(escapeLikePattern("50%")).toBe("50\\%");
    expect(escapeLikePattern("a%b%c")).toBe("a\\%b\\%c");
  });

  test("escapes _ so a literal-underscore search doesn't match any single char", () => {
    expect(escapeLikePattern("foo_bar")).toBe("foo\\_bar");
  });

  test("escapes backslash so the escape-char itself can be matched literally", () => {
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
  });

  test("leaves ordinary input untouched", () => {
    expect(escapeLikePattern("nm000166")).toBe("nm000166");
    expect(escapeLikePattern("ds002718.v1.0.0")).toBe("ds002718.v1.0.0");
  });
});
