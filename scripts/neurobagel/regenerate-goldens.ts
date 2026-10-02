/**
 * Rewrite the golden outputs from the captured fixtures.
 *
 *   bun run scripts/neurobagel/regenerate-goldens.ts
 *
 * A golden is the transform's output for a fixture, committed so a change in any
 * byte of any artifact shows up in review.
 * Run this only when the output SHOULD change (a mapping rule, the vocabulary
 * pin, the transform version), then read the diff before committing it.
 * Fixtures the transform refuses (the anonymous negative control) get no golden;
 * the tests assert the refusal instead.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NeurobagelRefusal, buildNeurobagelArtifacts } from "../../shared/neurobagel";
import { GOLDEN_ROOT, fixtureIds, loadFixture } from "./fixtures-io";

rmSync(GOLDEN_ROOT, { recursive: true, force: true });
for (const id of fixtureIds()) {
  try {
    const artifacts = await buildNeurobagelArtifacts(loadFixture(id));
    const dir = join(GOLDEN_ROOT, id);
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(artifacts.files))
      writeFileSync(join(dir, name), text);
    console.log(`golden ${id}`);
  } catch (error) {
    if (!(error instanceof NeurobagelRefusal)) throw error;
    console.log(`no golden for ${id}: refused (${error.code})`);
  }
}
