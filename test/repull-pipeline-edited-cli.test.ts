/**
 * A hand-edited pipeline file is replayed, not regenerated over (ADR 0111, the amendment of
 * 2026-11-19, note 5; iEEG geometry plan, ruling 28): NEMAR edited the pipeline's electrodes table
 * after the ownership record hashed it, so the plan classifies it a correction (the sidecar beside it
 * is untouched and still owned), N.0.1 replays NEMAR's bytes, the pipeline finds the file as NEMAR had
 * it and keeps it, and the ownership record it writes no longer lists it. Driven like
 * `repull-pipeline-clean-cli.test.ts`; the Python package is the stand-in.
 *
 * CI TIER: unit-pure. Hermetic: every server the suite starts or reaches listens on loopback.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";
import { which } from "bun";
import { PATHS, gitIn } from "./helpers/repull-fixture";
import { type RepullWorld, startRepullWorld } from "./helpers/repull-pr-world";
import { toolOrFail } from "./scrub/helpers/require-tools";

setDefaultTimeout(600_000);

const awsInstalled = toolOrFail("aws", which("aws") !== null);
const STANDIN = resolve(import.meta.dir, "helpers/ieeg-geometry-standin.ts");
let w: RepullWorld;

beforeAll(async () => {
  if (!awsInstalled) return;
  w = await startRepullWorld({
    fixture: { ieegGeometry: "hand-edited", noContributorEdits: true },
  });
  const head = w.row().head_sha as string;
  const resume = (extra: string[] = []) =>
    w.cli(["repull", "resume", w.fx.datasetId, "--wait-minutes", "0", "--yes", ...extra], {
      NEMAR_IEEG_GEOMETRY_RUNNER: STANDIN,
    });
  expect((await resume()).exitCode).toBe(3);
  await w.reportScreen(head, "clean");
  expect((await resume()).exitCode).toBe(0);
  const merged = await w.cli(["repull", "merge", w.fx.datasetId, "--yes"]);
  expect(merged.exitCode, merged.all).toBe(0);
  await w.tagMain("2.0.0");
  w.insertVersionRow("2.0.0");
});
afterAll(() => w?.stop());

const show = (rev: string, path: string) => gitIn(w.fx.originRepo, ["show", `${rev}:${path}`]);

describe.skipIf(!awsInstalled)("a hand-edited pipeline file", () => {
  test("N.0.1 replays NEMAR's bytes, regenerates the untouched files, and the record stops listing it", async () => {
    const counts = JSON.parse(w.row().counts as string);
    expect(counts).toMatchObject({ corrections: 1, pipeline_owned: 1 });
    const base = w.row().base_sha as string;
    const made = await w.cli(["repull", "resume", w.fx.datasetId, "--wait-minutes", "0", "--yes"], {
      NEMAR_IEEG_GEOMETRY_RUNNER: STANDIN,
    });
    expect(made.exitCode, made.all).toBe(3);
    const head = (await gitIn(w.fx.originRepo, ["rev-parse", "refs/heads/release/v2.0.1"])).trim();
    // NEMAR's own bytes, as they were on main before the re-pull.
    expect(await show(head, PATHS.ieegOwned)).toBe(await show(base, PATHS.ieegOwned));
    expect(await show(head, PATHS.ieegOwned)).toContain("edited by hand");
    // The untouched sidecar is the pipeline's, from the new snapshot.
    expect(await show(head, PATHS.ieegOwnedSidecar)).toContain("fsaverage");
    const record = JSON.parse(await show(head, PATHS.ieegOwnership));
    expect(Object.keys(record.paths)).not.toContain(PATHS.ieegOwned);
    expect(Object.keys(record.paths)).toContain(PATHS.ieegOwnedSidecar);
  });
});
