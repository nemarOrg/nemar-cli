/**
 * Reads a captured fixture (the documents exactly as the data plane served them)
 * into the transform's input.
 * Shared by the golden regenerator and the tests; the transform itself never
 * reads files.
 *
 * The input carries the dataset's entry from the committed `curation.json` when it has one, as
 * the writer will pass it, so a golden is the output of the production path.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCuration } from "../../shared/neurobagel/curation";
import type { CurationFile } from "../../shared/neurobagel/curation-types";
import type { NeurobagelInput } from "../../shared/neurobagel/input-schema";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where captured fixtures, goldens and recorded oracle output live. */
export const NEUROBAGEL_TEST_ROOT = resolve(HERE, "../../test/neurobagel");
export const FIXTURE_ROOT = join(NEUROBAGEL_TEST_ROOT, "fixtures");
export const GOLDEN_ROOT = join(NEUROBAGEL_TEST_ROOT, "golden");
/** The reviewed curation file the writer will read. */
export const CURATION_PATH = resolve(HERE, "../../shared/neurobagel/curation.json");

let committedCuration: CurationFile | null = null;
/** The committed `curation.json`, loaded strictly (a bad file throws `CurationError`). */
export function loadCuration(): CurationFile {
  // A review dated after today cannot have happened, so the loader is given today's date (it has no
  // clock of its own).
  committedCuration ??= parseCuration(readFileSync(CURATION_PATH, "utf8"), {
    today: new Date().toISOString().slice(0, 10),
  });
  return committedCuration;
}

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
    curation: loadCuration().entries.get(id) ?? null,
  };
}
