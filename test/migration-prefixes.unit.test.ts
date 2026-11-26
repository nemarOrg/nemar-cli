/**
 * Every D1 migration carries exactly four digits and an underscore (`NNNN_`), and
 * no two share a prefix (`scripts/migration-prefixes.ts` says why). The first test
 * holds the real directory; the rest prove the check fails on a duplicate or a
 * malformed name by building one in a temporary directory.
 *
 * Real filesystem, no mocks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { duplicateMigrationPrefixes, migrationPrefixProblems } from "../scripts/migration-prefixes";

const MIGRATIONS_DIR = join(import.meta.dir, "../backend/src/db/migrations");

describe("D1 migration prefixes", () => {
  test("every migration in backend/src/db/migrations has its own four-digit prefix", () => {
    const problems = migrationPrefixProblems(MIGRATIONS_DIR);
    expect(problems, problems.join("\n")).toEqual([]);
  });

  describe("on a copy of the directory", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "nemar-migration-prefixes-"));
      for (const f of readdirSync(MIGRATIONS_DIR)) {
        if (f.endsWith(".sql")) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
      }
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    test("the unchanged copy passes", () => {
      expect(migrationPrefixProblems(dir)).toEqual([]);
    });

    test("a second file on an existing prefix fails, naming both files", () => {
      const last = readdirSync(dir)
        .filter((f) => f.endsWith(".sql"))
        .sort()
        .at(-1) as string;
      const prefix = last.split("_")[0];
      writeFileSync(join(dir, `${prefix}_from_another_branch.sql`), "SELECT 1;\n");
      const files = [`${prefix}_from_another_branch.sql`, last].sort();
      expect(duplicateMigrationPrefixes(dir)).toEqual([{ prefix, files }]);
      expect(migrationPrefixProblems(dir)).toEqual([
        `Shared migration prefix ${prefix}: ${files.join(", ")}; renumber the newer file`,
      ]);
    });

    test("a third file on a grandfathered prefix fails", () => {
      writeFileSync(join(dir, "0003_third.sql"), "SELECT 1;\n");
      const dup = duplicateMigrationPrefixes(dir);
      expect(dup.map((d) => d.prefix)).toEqual(["0003"]);
      expect(dup[0].files).toHaveLength(3);
    });

    test.each([
      ["no numeric prefix", "add_column.sql"],
      ["a five-digit prefix", "00153_b.sql"],
      ["a three-digit prefix", "154_x.sql"],
    ])("a file with %s fails with its own message", (_label, name) => {
      writeFileSync(join(dir, name), "SELECT 1;\n");
      expect(duplicateMigrationPrefixes(dir)).toEqual([]);
      expect(migrationPrefixProblems(dir)).toEqual([
        `Migration without a 4-digit NNNN_ prefix: ${name}; give it the next number`,
      ]);
    });
  });
});
