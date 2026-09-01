/**
 * CLI-side half of the declared facet table's correspondence guarantees
 * (epic #1144 phase 4, #1148, plan verification cases 1 and 7).
 * `backend/test/facet-table-correspondence.unit.test.ts` already pins
 * `shared/facets.ts` <-> `backend/src/services/dataset-facets.ts`; this file
 * pins the other side: `shared/facets.ts` <-> the real Commander `Option`
 * objects `list` and `search` register at runtime.
 *
 * Both commands register their facets purely by calling
 * `addFacetOptions(cmd)` (src/lib/facet-options.ts), which walks the live
 * `FACETS` table -- so a facet quietly dropped from the table would also
 * quietly vanish from both commands with nothing here to notice (the
 * "vacuous pass" the backend test's own comment warns about). Test 1 below
 * pins the table's size for exactly that reason: shrinking `FACETS` without
 * updating this pin fails loudly instead of leaving 19 facets everywhere
 * looking complete.
 *
 * Introspects `cmd.options` -- real registered `Option` objects, not source
 * text -- matching the `admin-route-inventory`/`api-export-surface`
 * convention this repo already uses for "does the runtime object actually
 * have what we think it has" checks.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FACETS } from "../shared/facets";
import { datasetCommand } from "../src/commands/dataset";

function findSubcommand(name: string) {
  const cmd = datasetCommand.commands.find((c) => c.name() === name);
  if (!cmd) throw new Error(`no '${name}' subcommand registered on 'dataset'`);
  return cmd;
}

const listCommand = findSubcommand("list");
const searchCommand = findSubcommand("search");

function registeredFlags(cmd: typeof listCommand): string[] {
  return cmd.options.map((o) => o.long).filter((l): l is string => l !== undefined);
}

describe("facet CLI registration: shared/facets.ts <-> list/search commands", () => {
  // Guards the vacuous pass documented above: FACETS shrinking silently
  // would otherwise make every per-facet loop below pass trivially, since
  // both the CLI registration and this test's own loop are driven off the
  // SAME live table. Captured as of #1148 (D2: 20 facets, not the issue's
  // original 13). Update deliberately, in the same commit, if a facet is
  // genuinely added or removed.
  test("the declared facet table has exactly 20 entries", () => {
    expect(FACETS.length).toBe(20);
  });

  test("list registers no fewer options than there are facets (guards a vacuous per-facet loop)", () => {
    expect(listCommand.options.length).toBeGreaterThanOrEqual(FACETS.length);
  });

  test("search registers no fewer options than there are facets (guards a vacuous per-facet loop)", () => {
    expect(searchCommand.options.length).toBeGreaterThanOrEqual(FACETS.length);
  });

  // One test per facet, per command -- not one aggregate "missing = []"
  // assertion -- so that registering a facet on `list` only (this phase's
  // named failure mode) fails exactly the `search` test for that one facet,
  // not every facet at once. Mirrors the "every facet key is its own
  // OR-gate term" idiom in backend/test/facet-table-correspondence.unit.test.ts.
  for (const facet of FACETS) {
    test(`list registers ${facet.flag}`, () => {
      expect(registeredFlags(listCommand)).toContain(facet.flag);
    });

    test(`search registers ${facet.flag}`, () => {
      expect(registeredFlags(searchCommand)).toContain(facet.flag);
    });
  }
});

describe("D4/verification case 7: no duplicated license tier list", () => {
  const SRC = readFileSync(join(import.meta.dir, "..", "src/commands/dataset.ts"), "utf8");

  test("dataset.ts has no VALID_LICENSE_TIERS local constant", () => {
    expect(SRC).not.toContain("VALID_LICENSE_TIERS");
  });

  test("dataset.ts has no literal license-tier array (the duplication cannot come back)", () => {
    // The exact array this phase deleted. A regex (not a plain substring) so
    // reformatting (spacing/line breaks) can't hide a reintroduced copy.
    const literalTierArray =
      /\[\s*"public"\s*,\s*"attribution"\s*,\s*"sharealike"\s*,\s*"noncommercial"\s*,\s*"noderiv"\s*,\s*"unknown"\s*,?\s*\]/;
    expect(SRC).not.toMatch(literalTierArray);
  });

  test("dataset.ts imports LICENSE_TIERS from shared/license-tiers.ts", () => {
    expect(SRC).toContain('from "../../shared/license-tiers.js"');
    expect(SRC).toContain("LICENSE_TIERS");
  });
});
