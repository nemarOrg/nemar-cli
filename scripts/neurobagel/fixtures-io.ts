/**
 * Reads a captured fixture (the documents exactly as the data plane served them)
 * into the transform's input.
 * Shared by the golden regenerator and the tests; the transform itself never
 * reads files.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NeurobagelInput } from "../../shared/neurobagel/input-schema";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where captured fixtures, goldens and recorded oracle output live. */
export const NEUROBAGEL_TEST_ROOT = resolve(HERE, "../../test/neurobagel");
export const FIXTURE_ROOT = join(NEUROBAGEL_TEST_ROOT, "fixtures");
export const GOLDEN_ROOT = join(NEUROBAGEL_TEST_ROOT, "golden");

export function fixtureIds(root: string = FIXTURE_ROOT): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** The transform input for one fixture; an absent file is `null`, as the data plane's 404 means. */
export function loadFixture(id: string, root: string = FIXTURE_ROOT): NeurobagelInput {
  const dir = join(root, id);
  const text = (name: string): string | null =>
    existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : null;
  const metadata = text("metadata.json");
  if (metadata === null) throw new Error(`fixture ${id} has no metadata.json`);
  return {
    expectedDatasetId: id,
    metadata: JSON.parse(metadata),
    participantsTsv: text("participants.tsv"),
    participantsJson: text("participants.json"),
  };
}
