/**
 * The serving index a run of the archive is handed (ADR 0141, epic #2324 phase B2b): what a job's
 * specification records of it, what the launch specification carries, where the launcher places it, the
 * arguments that hand it to the recipe, and the word a launcher fails with when the copy is not the one named.
 */

import { describe, expect, test } from "bun:test";
import {
  RECIPE_SERVING_INDEX_FLAG,
  RECIPE_SOURCE_COMMIT_FLAG,
  findRecipe,
  recipeArguments,
  recipeServingIndexArguments,
} from "../shared/compute-recipes";
import {
  LAUNCHER_DETAILS,
  PLATFORM_LAUNCHER_DETAILS,
  isPlatformFailure,
} from "../shared/compute-state";
import {
  COMPUTE_DATASET_ID_RE,
  COMPUTE_SERVING_INDEX_MAX_BYTES,
  JobSpecSchema,
  SERVING_INDEX_ABSENT_REASONS,
} from "../shared/contract/compute";
import {
  LAUNCH_SPEC_VERSION,
  LaunchSpecSchema,
  SERVING_INDEX_CONTAINER_DIR,
  SERVING_INDEX_CONTAINER_PATH,
  SERVING_INDEX_MAX_BYTES,
  ServingIndexResponseSchema,
  encodeLaunchSpec,
  launchSpecFits,
} from "../shared/contract/compute-launch";
import launchSchema from "../shared/contract/compute-launch.schema.json";

const HEX = "c".repeat(64);
const COMMIT = "d".repeat(40);
const IMAGE = `docker://ghcr.io/nemarorg/nemar-python@sha256:${"e".repeat(64)}`;

/** A recipe job of the archive, as the dispatcher writes it, with `serving_index` set as given. */
function recipeJob(servingIndex: unknown, extra: Record<string, unknown> = {}) {
  return {
    name: "nemar-ica nm000104 v1.0.2",
    runtime: "image",
    image: IMAGE,
    recipe: "nemar-ica",
    command: ["nemar-recipe", "run", "nemar-ica"],
    args: recipeArguments({ datasetId: "nm000104", tag: "v1.0.2", imageDigest: `sha256:${HEX}` }),
    datasets: [{ id: "nm000104", version: "v1.0.2" }],
    partition: "gpu-shared",
    gpus: 1,
    minutes: 720,
    ...(servingIndex === undefined ? {} : { serving_index: servingIndex }),
    ...extra,
  };
}

describe("what a job's specification records of the serving index", () => {
  test("a recipe job records the staged digest and size, or the word for why none was staged", () => {
    expect(JobSpecSchema.safeParse(recipeJob({ sha256: HEX, size: 812 })).success).toBe(true);
    for (const reason of SERVING_INDEX_ABSENT_REASONS) {
      expect(JobSpecSchema.safeParse(recipeJob({ reason })).success, reason).toBe(true);
    }
    expect(JobSpecSchema.safeParse(recipeJob(undefined)).success).toBe(true);
  });

  test("the words are fixed, and the bound is the recipe's own 64 MiB", () => {
    expect([...SERVING_INDEX_ABSENT_REASONS]).toEqual([
      "no_index",
      "index_unreadable",
      "index_too_large",
      "index_commit_unusable",
      "index_unusable",
      "source_commit_differs",
      "tag_absent",
      "github_unreadable",
      "no_github_credentials",
      "token_mint_failed",
      "index_not_stored",
    ]);
    expect(COMPUTE_SERVING_INDEX_MAX_BYTES).toBe(64 * 1024 * 1024);
    expect(SERVING_INDEX_MAX_BYTES).toBe(COMPUTE_SERVING_INDEX_MAX_BYTES);
  });

  test("a job that is not a recipe's is refused a serving index, naming the field", () => {
    const person = {
      name: "mine",
      runtime: "python",
      entry: "run.py",
      bundle: { size: 10, sha256: HEX },
      partition: "shared",
      minutes: 10,
    };
    expect(JobSpecSchema.safeParse(person).success).toBe(true);
    const refused = JobSpecSchema.safeParse({ ...person, serving_index: { sha256: HEX, size: 1 } });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((i) => i.path.join("."))).toContain("serving_index");
  });

  test("anything else under the field is refused", () => {
    for (const value of [
      { sha256: HEX, size: 0 },
      { sha256: HEX, size: COMPUTE_SERVING_INDEX_MAX_BYTES + 1 },
      { sha256: HEX },
      { sha256: "C".repeat(64), size: 1 },
      { sha256: HEX, size: 1, reason: "no_index" },
      { reason: "metadata_only" },
      { reason: "no_index", size: 1 },
      {},
      "none",
      null,
    ]) {
      expect(JobSpecSchema.safeParse(recipeJob(value)).success, JSON.stringify(value)).toBe(false);
    }
  });
});

describe("the launch specification carries a staged index and nothing of an absent one", () => {
  const launch = {
    job_id: "job_0123456789abcdef01234567",
    runtime: "image",
    command: ["nemar-recipe", "run", "nemar-ica"],
    args: [],
    datasets: [{ id: "nm000104", version: "v1.0.2" }],
    api_base: "https://api.example.test",
    image: { uri: IMAGE, digest: `sha256:${"e".repeat(64)}`, sif: `${"e".repeat(64)}.sif` },
    env: {},
    resources: { gpus: 1 },
    limits: { max_files: 38000, max_total_bytes: 1073741824 },
    job_token: "t".repeat(43),
  };

  test("version 2 adds the member after the bundle, and a document without it keeps its bytes", () => {
    expect(LAUNCH_SPEC_VERSION).toBe("nemar.launch-spec.v2");
    const without = encodeLaunchSpec(launch);
    expect(without).not.toContain("serving_index");
    const withIndex = encodeLaunchSpec({ ...launch, serving_index: { sha256: HEX, size: 812 } });
    expect(withIndex).toContain(
      `"args":[],"serving_index":{"sha256":"${HEX}","size":812},"datasets"`,
    );
    expect(
      LaunchSpecSchema.safeParse({ ...launch, serving_index: { reason: "no_index" } }).success,
    ).toBe(false);
  });

  test("the schema's bound on the size is the contract's", () => {
    const property = launchSchema.properties.serving_index;
    expect(property.properties.size.maximum).toBe(SERVING_INDEX_MAX_BYTES);
    expect(property.required).toEqual(["sha256", "size"]);
    expect(property.additionalProperties).toBe(false);
  });

  test("a recipe job with a staged index fits, its worst case counted", () => {
    const job = JobSpecSchema.parse(recipeJob({ sha256: HEX, size: 812 }));
    expect(launchSpecFits(job)).toBe(true);
  });

  test("the serving index response is open, as the bundle response is", () => {
    const answer = {
      url: "https://r2.example.test/s",
      expires_at: "2026-11-25T12:00:00Z",
      extra: 1,
    };
    expect(ServingIndexResponseSchema.safeParse(answer).success).toBe(true);
    expect(
      ServingIndexResponseSchema.safeParse({ url: "ftp://x", expires_at: answer.expires_at })
        .success,
    ).toBe(false);
  });
});

describe("where the launcher places the index, and the arguments that hand it to the recipe", () => {
  test("the file is index.json in a directory beside the datasets that no dataset id can name", () => {
    expect(SERVING_INDEX_CONTAINER_DIR).toBe("/data/serving-index");
    expect(SERVING_INDEX_CONTAINER_PATH).toBe("/data/serving-index/index.json");
    expect(COMPUTE_DATASET_ID_RE.test("serving-index")).toBe(false);
  });

  test("the arguments are the flag, the path, and the tag's commit as --source-commit", () => {
    expect(
      recipeServingIndexArguments({ path: SERVING_INDEX_CONTAINER_PATH, sourceCommit: COMMIT }),
    ).toEqual([
      RECIPE_SERVING_INDEX_FLAG,
      SERVING_INDEX_CONTAINER_PATH,
      RECIPE_SOURCE_COMMIT_FLAG,
      COMMIT,
    ]);
    expect(RECIPE_SERVING_INDEX_FLAG).toBe("--serving-index");
    expect(RECIPE_SOURCE_COMMIT_FLAG).toBe("--source-commit");
    expect(() => recipeServingIndexArguments({ path: "index.json", sourceCommit: COMMIT })).toThrow(
      RangeError,
    );
    expect(() =>
      recipeServingIndexArguments({ path: SERVING_INDEX_CONTAINER_PATH, sourceCommit: "abc" }),
    ).toThrow(RangeError);
  });

  test("nemar-ica is no longer a placeholder, and runs on Tapis only, where the serving index is staged", () => {
    const ica = findRecipe("nemar-ica");
    expect(ica?.placeholder).toBe(false);
    expect(ica?.executors).toEqual(["tapis"]);
  });
});

describe("a staged copy that is not the one named fails the job with one word, the platform's", () => {
  test("serving_index_mismatch is a dataset_fetch_failed detail and the platform's", () => {
    expect(LAUNCHER_DETAILS.dataset_fetch_failed).toContain("serving_index_mismatch");
    expect(PLATFORM_LAUNCHER_DETAILS).toContain("serving_index_mismatch");
    expect(isPlatformFailure("dataset_fetch_failed", "serving_index_mismatch")).toBe(true);
  });
});
