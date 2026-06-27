import { describe, expect, test } from "bun:test";
import { DELETE_STATEMENTS, toCountSql } from "../scripts/delete-ds-rows";

describe("delete-ds-rows", () => {
  test("deletes child tables before the parent `datasets` row (FK-safe order)", () => {
    const labels = DELETE_STATEMENTS.map((s) => s.label);
    expect(labels[labels.length - 1]).toBe("datasets");
    for (const child of ["dataset_versions", "publication_requests"]) {
      expect(labels.indexOf(child)).toBeLessThan(labels.indexOf("datasets"));
    }
  });

  test("every statement targets only ds-prefixed rows", () => {
    for (const s of DELETE_STATEMENTS) {
      expect(s.sql).toMatch(/LIKE 'ds%'/);
      expect(s.sql.startsWith("DELETE FROM ")).toBe(true);
    }
  });

  test("toCountSql turns a DELETE into the matching COUNT", () => {
    expect(toCountSql("DELETE FROM datasets WHERE dataset_id LIKE 'ds%'")).toBe(
      "SELECT COUNT(*) AS n FROM datasets WHERE dataset_id LIKE 'ds%'",
    );
    expect(toCountSql("DELETE FROM user_s3_permissions WHERE s3_prefix LIKE 'ds%'")).toBe(
      "SELECT COUNT(*) AS n FROM user_s3_permissions WHERE s3_prefix LIKE 'ds%'",
    );
  });
});
