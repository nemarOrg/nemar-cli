/**
 * N.0.1 for a mirror whose only NEMAR paths are the iEEG geometry pipeline's (ADR 0111, the
 * amendment of 2026-11-19; iEEG geometry plan, ruling 28), driven through the real entry point
 * against `repull-pr-world.ts` like `repull-pipeline-cli.test.ts`, but with no correction and no
 * conflict: the plan states zero of both (`pipeline-owned` is neither), so nothing waits for an
 * administrator's decision.
 *
 * The properties, each with a test:
 *  - N.0.1 is made with no correction and no `--keep-upstream`: it holds what the pipeline makes
 *    from the new snapshot and nothing else;
 *  - a pipeline that changes nothing makes no N.0.1: the record completes;
 *  - a pipeline that fails, with nothing else to replay, completes the record without N.0.1 and
 *    keeps the failure on it.
 *
 * CI TIER: unit-pure. Hermetic: every server the suite starts or reaches listens on loopback.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { resolve } from "node:path";
import { which } from "bun";
import { PATHS, gitIn } from "./helpers/repull-fixture";
import { type RepullWorld, type WorldPoint, startRepullWorld } from "./helpers/repull-pr-world";
import { toolOrFail } from "./scrub/helpers/require-tools";

setDefaultTimeout(600_000);

const awsInstalled = toolOrFail("aws", which("aws") !== null);
const STANDIN = resolve(import.meta.dir, "helpers/ieeg-geometry-standin.ts");

let w: RepullWorld;
let released: WorldPoint;

beforeAll(async () => {
  if (!awsInstalled) return;
  w = await startRepullWorld({
    fixture: { ieegGeometry: true, noContributorEdits: true },
  });
  const head = w.row().head_sha as string;
  expect((await resume()).exitCode).toBe(3);
  await w.reportScreen(head, "clean");
  expect((await resume()).exitCode).toBe(0);
  const merged = await w.cli(["repull", "merge", w.fx.datasetId, "--yes"]);
  expect(merged.exitCode, merged.all).toBe(0);
  await w.tagMain("2.0.0");
  w.insertVersionRow("2.0.0");
  released = await w.save();
});
afterAll(() => w?.stop());
beforeEach(async () => {
  if (awsInstalled) await w.restore(released);
});

const runner = (extra: Record<string, string> = {}) => ({
  NEMAR_IEEG_GEOMETRY_RUNNER: STANDIN,
  ...extra,
});
function resume(extra: string[] = [], env: Record<string, string> = runner()) {
  return w.cli(["repull", "resume", w.fx.datasetId, "--wait-minutes", "0", "--yes", ...extra], env);
}
const show = (rev: string, path: string) => gitIn(w.fx.originRepo, ["show", `${rev}:${path}`]);
const rev = async (ref: string) => (await gitIn(w.fx.originRepo, ["rev-parse", ref])).trim();
const counts = () => JSON.parse(w.row().counts as string) as Record<string, number>;
const hasRef = async (ref: string) =>
  (await gitIn(w.fx.originRepo, ["for-each-ref", "--format=%(refname)", ref])).trim() !== "";

const OUT = PATHS.ieegOwned;
const SIDECAR = PATHS.ieegOwnedSidecar;
const ADDED_OUT = "sub-03/ieeg/sub-03_space-fsaverage_electrodes.tsv";
const ADDED_SIDECAR = "sub-03/ieeg/sub-03_space-fsaverage_coordsystem.json";

describe.skipIf(!awsInstalled)("N.0.1 with only the pipeline's files", () => {
  test("the plan states no correction and no conflict, and the record counts the pipeline's paths", () => {
    expect(counts()).toMatchObject({
      pipeline_owned: 2,
      corrections: 0,
      conflicts: 0,
      unexplained: 0,
    });
  });

  test("N.0.1 is made without a decision, and holds the pipeline's files and nothing else", async () => {
    const mergeN0 = w.row().merge_sha as string;
    const made = await resume();
    expect(made.exitCode, made.all).toBe(3);
    expect(w.row().status).toBe("patch_synthesized");
    const head = await rev("refs/heads/release/v2.0.1");
    const changed = (await gitIn(w.fx.originRepo, ["diff", "--name-only", mergeN0, head]))
      .split("\n")
      .filter(Boolean);
    expect(changed.sort()).toEqual(
      [OUT, SIDECAR, ADDED_OUT, ADDED_SIDECAR, PATHS.ieegOwnership, PATHS.description].sort(),
    );
    const record = JSON.parse(await show(head, PATHS.ieegOwnership));
    expect(Object.keys(record.paths).sort()).toEqual(
      [ADDED_OUT, ADDED_SIDECAR, OUT, SIDECAR].sort(),
    );
    expect(counts().pipeline_failed).toBeUndefined();
  });

  test("a pipeline that changes nothing makes no N.0.1: the record completes", async () => {
    const made = await resume([], runner({ STANDIN_MODE: "noop" }));
    expect(made.exitCode, made.all).toBe(0);
    expect(made.all).toContain("are as the new snapshot leaves them");
    expect(w.row().status).toBe("complete");
    expect(await hasRef("refs/heads/release/v2.0.1")).toBe(false);
    expect(counts().pipeline_failed).toBeUndefined();
  });

  test("a pipeline that fails stays retryable: the record stays released and nothing is pushed", async () => {
    const made = await resume([], runner({ STANDIN_MODE: "fail" }));
    expect(made.exitCode, made.all).toBe(3);
    expect(made.all).toContain("pipeline-regeneration-failed");
    expect(w.row().status).toBe("released");
    expect(await hasRef("refs/heads/release/v2.0.1")).toBe(false);
    expect(counts().pipeline_failed).toBeUndefined();
    // The next run, where the pipeline works, makes N.0.1.
    const again = await resume();
    expect(again.exitCode, again.all).toBe(3);
    expect(w.row().status).toBe("patch_synthesized");
  });

  test("a pipeline of another version completes the record with the failure counted, visible in status", async () => {
    const wrong = await resume([], runner({ STANDIN_VERSION: "0.2.0" }));
    expect(wrong.exitCode, wrong.all).toBe(0);
    expect(wrong.all).toContain("pipeline-version");
    expect(counts().pipeline_failed).toBe(1);
    expect(w.row().status).toBe("complete");
  });
});
