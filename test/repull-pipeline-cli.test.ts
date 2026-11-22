/**
 * N.0.1 regenerates the iEEG geometry pipeline's files (ADR 0111, the amendment of 2026-11-19; iEEG
 * geometry plan, ruling 28), driven through the real entry point against `repull-pr-world.ts`: the
 * mirror NEMAR holds carries the pipeline's `space-fsaverage` outputs for a subject and the
 * ownership record that lists them (upstream adds a file at one of the owned paths in tag B), NEMAR also edited a sidecar and added a description key (two
 * corrections) and edited `participants.tsv`, which upstream changed too (a conflict); tag B changes
 * the subject's electrodes table and adds a subject. N.0.0 is merged by the real gate; every step of
 * the re-pull is the real CLI and the real Worker routes. GitHub and S3 are stand-ins, and so is the
 * Python package, by `helpers/ieeg-geometry-standin.ts` (the package itself runs in
 * `repull-pipeline-run.test.ts`). No mocks.
 *
 * The properties, each with a test:
 *  - N.0.0 holds none of the pipeline's files; N.0.1 holds the files the pipeline makes from the new
 *    snapshot (the changed input's, the added subject's, the ownership record) and replays the
 *    corrections beside them, and changes nothing else;
 *  - a run that pushed N.0.1 and could not record it is taken up by the next run, which re-derives the
 *    same commit, and refused (`branch-foreign`) when the pipeline's version no longer is the same;
 *  - a pipeline run that fails leaves the previous pipeline files out of N.0.1, records the failure
 *    on the record and its pull request, and holds back neither the corrections nor N.0.1.
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
  w = await startRepullWorld({ fixture: { ieegGeometry: "upstream-wins" } });
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
  if (awsInstalled) await w.restore();
});

const runner = (extra: Record<string, string> = {}) => ({
  NEMAR_IEEG_GEOMETRY_RUNNER: STANDIN,
  ...extra,
});
function resume(extra: string[] = [], env: Record<string, string> = runner()) {
  return w.cli(["repull", "resume", w.fx.datasetId, "--wait-minutes", "0", "--yes", ...extra], env);
}
const show = (rev: string, path: string) => gitIn(w.fx.originRepo, ["show", `${rev}:${path}`]);
const tree = async (rev: string) =>
  (await gitIn(w.fx.originRepo, ["ls-tree", "-r", "--name-only", rev])).split("\n").filter(Boolean);
const rev = async (ref: string) => (await gitIn(w.fx.originRepo, ["rev-parse", ref])).trim();
const counts = () => JSON.parse(w.row().counts as string) as Record<string, number>;
const patchBodyText = () =>
  String(
    w.gh.seen.find(
      (x) => x.method === "POST" && x.path.endsWith("/pulls") && x.body?.head === "release/v2.0.1",
    )?.body?.body,
  );

const OUT = PATHS.ieegOwned;
const SIDECAR = PATHS.ieegOwnedSidecar;
const ADDED_OUT = "sub-03/ieeg/sub-03_space-fsaverage_electrodes.tsv";
const ADDED_SIDECAR = "sub-03/ieeg/sub-03_space-fsaverage_coordsystem.json";
const PIPELINE = [OUT, ADDED_SIDECAR, ADDED_OUT, PATHS.ieegOwnership];

describe.skipIf(!awsInstalled)("N.0.1 and the pipeline's files", () => {
  test("the record counts the pipeline's paths apart from the corrections and the conflict", () => {
    expect(counts()).toMatchObject({ pipeline_owned: 2, corrections: 2, conflicts: 1 });
  });

  test("N.0.0 holds none of the regenerated files; N.0.1 holds what the pipeline makes from the new snapshot, beside the corrections, and upstream's file at an owned path wins", async () => {
    await w.restore(released);
    const mergeN0 = w.row().merge_sha as string;
    expect(await tree(mergeN0)).toEqual(
      expect.not.arrayContaining([OUT, ADDED_OUT, ADDED_SIDECAR]),
    );
    // The ownership record is NEMAR's own, so N.0.0 keeps it as it was.
    expect(await tree(mergeN0)).toContain(PATHS.ieegOwnership);

    const made = await resume(["--keep-upstream"]);
    expect(made.exitCode, made.all).toBe(3);
    expect(made.all).toContain("Regenerated the iEEG geometry pipeline's files: 4 written");
    expect(w.row().status).toBe("patch_synthesized");
    const head = await rev("refs/heads/release/v2.0.1");
    expect(head).toBe(w.row().patch_head_sha as string);
    expect(await rev(`${head}^`)).toBe(w.row().patch_base_sha as string);

    // The new run's outputs, from tag B's tables: a function of the snapshot's input blobs.
    for (const [input, out] of [
      [PATHS.ieegInput, OUT],
      [PATHS.ieegAddedInput, ADDED_OUT],
    ] as const) {
      const blob = await rev(`${mergeN0}:${input}`);
      expect(await show(head, out)).toBe(
        `derived-from\t${blob}\t0.1.1\n${await show(mergeN0, input)}`,
      );
    }
    const record = JSON.parse(await show(head, PATHS.ieegOwnership));
    expect(Object.keys(record.paths).sort()).toEqual([OUT, ADDED_SIDECAR, ADDED_OUT].sort());

    // N.0.1 changes the pipeline's files, the two corrections and the description, nothing else.
    const changed = (
      await gitIn(w.fx.originRepo, ["diff", "--name-only", `${await rev(`${head}^`)}`, head])
    )
      .split("\n")
      .filter(Boolean);
    expect(changed.sort()).toEqual([...PIPELINE, PATHS.sidecar, PATHS.description].sort());
    expect(JSON.parse(await show(head, PATHS.description)).Version).toBe("2.0.1");
    expect(await gitIn(w.fx.originRepo, ["log", "-1", "--format=%b", head])).toContain(
      "iEEG geometry pipeline files written: 4; removed: 0.",
    );
    expect(patchBodyText()).toContain("iEEG geometry pipeline files regenerated");
    expect(counts()).toMatchObject({ pipeline_owned: 2 });
    expect(counts().pipeline_failed).toBeUndefined();
  });

  test("a run that pushed N.0.1 and could not record it is taken up again: the same commit is re-derived", async () => {
    await w.restore(released);
    let armed = false;
    w.setApiHook(async (req) => {
      if (req.method !== "POST" || !new URL(req.url).pathname.endsWith("/transition")) return;
      const b = (await req.json()) as { to?: string };
      if (b.to === "patch_synthesized") armed = true;
    });
    w.setApiOverride((req) => {
      if (!armed || req.method !== "POST") return null;
      armed = false;
      return Response.json({ error: "unavailable" }, { status: 503 });
    });
    const first = await resume(["--keep-upstream"]);
    expect(first.exitCode, first.all).toBe(3);
    expect(w.row().status).toBe("released");
    const pushed = await rev("refs/heads/release/v2.0.1");
    w.setApiHook(null);
    w.setApiOverride(null);

    // Succeeded, then failed: the pushed commit holds files this run cannot reproduce, so it is
    // not N.0.1's to judge foreign; the refusal is retryable and the record stays released.
    for (const env of [{ STANDIN_MODE: "fail" }, { STANDIN_VERSION: "0.2.0" }]) {
      const moved = await resume(["--keep-upstream"], runner(env));
      expect(moved.exitCode, moved.all).toBe(3);
      expect(moved.all).toMatch(/pipeline-unavailable-on-resume|pipeline-regeneration-failed/);
      expect(moved.all).not.toContain("branch-foreign");
      expect(w.row().status).toBe("released");
      expect(await rev("refs/heads/release/v2.0.1")).toBe(pushed);
    }

    const same = await resume(["--keep-upstream"]);
    expect(same.exitCode, same.all).toBe(3);
    expect(same.all).toContain("already this re-pull's N.0.1 commit");
    expect(w.row()).toMatchObject({ status: "patch_synthesized", patch_head_sha: pushed });
  });

  test("a failure to run is retried: nothing is pushed and the record stays released, then it succeeds", async () => {
    await w.restore(released);
    for (const [n, env] of [
      [1, { STANDIN_MODE: "fail" }],
      [2, { NEMAR_IEEG_GEOMETRY_RUNNER: "relative/path" }],
    ] as const) {
      const failed = await resume(["--keep-upstream"], runner(env));
      expect(failed.exitCode, failed.all).toBe(3);
      expect(failed.all).toContain("pipeline-regeneration-failed");
      expect(w.row().status).toBe("released");
      expect(String(w.row().last_error)).toContain("pipeline-regeneration-failed");
      expect(counts().pipeline_attempts).toBe(n);
      expect(await rev("refs/heads/release/v2.0.1").catch(() => "none")).toBe("none");
    }
    // Failed, then succeeded.
    const made = await resume(["--keep-upstream"]);
    expect(made.exitCode, made.all).toBe(3);
    expect(w.row().status).toBe("patch_synthesized");
    expect(await tree(await rev("refs/heads/release/v2.0.1"))).toContain(OUT);
    expect(counts().pipeline_failed).toBeUndefined();
  });

  test("the third failed attempt settles: N.0.1 goes on without the pipeline's files and the failure is counted", async () => {
    await w.restore(released);
    for (const n of [1, 2]) {
      const failed = await resume(["--keep-upstream"], runner({ STANDIN_MODE: "fail" }));
      expect(failed.exitCode, failed.all).toBe(3);
      expect(counts().pipeline_attempts).toBe(n);
    }
    const settled = await resume(["--keep-upstream"], runner({ STANDIN_MODE: "fail" }));
    expect(settled.exitCode, settled.all).toBe(3);
    expect(w.row().status).toBe("patch_synthesized");
    const head = await rev("refs/heads/release/v2.0.1");
    expect(await tree(head)).not.toContain(OUT);
    expect(await show(head, PATHS.sidecar)).toContain("PowerLineFrequency");
    expect(counts()).toMatchObject({ pipeline_failed: 1, pipeline_attempts: 3 });
  });

  test("a check the bridge applies to the result settles at once, whatever the class", async () => {
    for (const [mode, code] of [
      ["not-json", "pipeline-report"],
      ["wrong-commit", "pipeline-report"],
      ["undeclared", "pipeline-undeclared-write"],
      ["big", "pipeline-output-invalid"],
    ] as const) {
      await w.restore(released);
      const made = await resume(["--keep-upstream"], runner({ STANDIN_MODE: mode }));
      expect([mode, made.exitCode, made.all.includes(code)]).toEqual([mode, 3, true]);
      expect(w.row().status).toBe("patch_synthesized");
      expect(await tree(await rev("refs/heads/release/v2.0.1"))).not.toContain(OUT);
      expect(counts()).toMatchObject({ pipeline_failed: 1 });
      expect(counts().pipeline_attempts).toBeUndefined();
    }
  });

  test("a pipeline of another version leaves the previous files out, records it, and still replays the corrections", async () => {
    await w.restore(released);
    const made = await resume(["--keep-upstream"], runner({ STANDIN_VERSION: "0.2.0" }));
    expect(made.exitCode, made.all).toBe(3);
    expect(made.all).toContain("pipeline-version");
    expect(w.row().status).toBe("patch_synthesized");
    const head = await rev("refs/heads/release/v2.0.1");
    const files = await tree(head);
    for (const path of [OUT, ADDED_OUT, ADDED_SIDECAR]) expect(files).not.toContain(path);
    expect(await show(head, PATHS.sidecar)).toContain("PowerLineFrequency");
    expect(await show(head, PATHS.ieegInput)).toContain("1.5");
    expect(counts()).toMatchObject({ pipeline_failed: 1, pipeline_owned: 2 });
    expect(patchBodyText()).toContain("the regeneration failed (pipeline-version)");
  });
});
