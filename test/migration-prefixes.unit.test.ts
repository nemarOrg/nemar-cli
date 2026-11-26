/**
 * No two D1 migrations may share a numeric prefix (`scripts/migration-prefixes.ts`
 * says why). The first test holds the real directory; the rest prove the check
 * fails on a duplicate by building one in a temporary directory.
 *
 * Real filesystem, no mocks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { duplicateMigrationPrefixes } from "../scripts/migration-prefixes";

const MIGRATIONS_DIR = join(import.meta.dir, "../backend/src/db/migrations");

describe("D1 migration prefixes", () => {
  test("no two migrations in backend/src/db/migrations share a numeric prefix", () => {
    const duplicates = duplicateMigrationPrefixes(MIGRATIONS_DIR);
    expect(
      duplicates,
      `Renumber the newer file: ${duplicates.map((d) => d.files.join(" + ")).join("; ")}`,
    ).toEqual([]);
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
      expect(duplicateMigrationPrefixes(dir)).toEqual([]);
    });

    test("a second file on an existing prefix fails, naming both files", () => {
      const last = readdirSync(dir)
        .filter((f) => f.endsWith(".sql"))
        .sort()
        .at(-1) as string;
      const prefix = last.split("_")[0];
      writeFileSync(join(dir, `${prefix}_from_another_branch.sql`), "SELECT 1;\n");
      expect(duplicateMigrationPrefixes(dir)).toEqual([
        { prefix, files: [`${prefix}_from_another_branch.sql`, last].sort() },
      ]);
    });

    test("a third file on a grandfathered prefix fails", () => {
      writeFileSync(join(dir, "0003_third.sql"), "SELECT 1;\n");
      const dup = duplicateMigrationPrefixes(dir);
      expect(dup.map((d) => d.prefix)).toEqual(["0003"]);
      expect(dup[0].files).toHaveLength(3);
    });

    test("a file with no numeric prefix fails", () => {
      writeFileSync(join(dir, "add_column.sql"), "SELECT 1;\n");
      expect(duplicateMigrationPrefixes(dir)).toEqual([
        { prefix: "(none)", files: ["add_column.sql"] },
      ]);
    });
  });
});
