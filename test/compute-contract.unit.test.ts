/**
 * The compute contract (epic #2005, phase A1 #2006; ADR 0118): the job specification, the
 * partition and rate tables, the owner policy, the launcher's file shapes, and the launch
 * specification with its JSON Schema.
 *
 * Money is integer thousandths of an Expanse service unit (SU) everywhere, so the arithmetic below
 * is asserted on whole numbers, and each rule the issue names (the 128, the minimum, the round-up,
 * the 800) has a case that fails if that one number changes.
 *
 * The JSON Schema `shared/contract/compute-launch.schema.json` is shared byte for byte with
 * `nemarOrg/nemar-process`, so it is held to the zod schema two ways: structurally (its keys,
 * required lists and enumerations are read back against the constants they mirror) and by a
 * differential corpus (every document is judged by Ajv and by zod, each with its expected verdict
 * written beside it, so two schemas that agree on a wrong answer still fail).
 *
 * Nothing here has been recorded from a real tenant: the rate table, the `debug` ceilings and the
 * preempt basis are the design's, unconfirmed with SDSC (design section 12, question 5).
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020";
import { LAUNCHER_FAILURE_CODES } from "../shared/compute-state";
import {
  COMPUTE_JOB_ID_RE,
  COMPUTE_MAX_OUTPUT_FILES,
  COMPUTE_PATH_SEGMENT,
  COMPUTE_POOLS,
  ComputeCeilingSchema,
  ComputeClientCapsSchema,
  ComputePolicySchema,
  DEFAULT_COMPUTE_POLICY,
  JOB_ENV_ALLOWLIST,
  JOB_RUNTIMES,
  type JobSpec,
  JobSpecSchema,
  LAUNCHER_DIR,
  LAUNCHER_ENV,
  LAUNCHER_FILES,
  LAUNCHER_FILE_NAMES,
  LAUNCHER_OUTPUTS_DIR,
  LAUNCHER_WORK_DIR,
  LAUNCH_VARIABLE_BYTES_MAX,
  LauncherProvenanceSchema,
  LauncherResultSchema,
  PARTITIONS,
  PARTITION_NAMES,
  PIPELINES_TAPIS_OWNER,
  type PartitionName,
  RATE_TABLE_V1,
  RECORDS_RESULT_MANIFEST_FILE,
  RESULT_MAX_FILE_BYTES,
  ResultManifestSchema,
  estimateSuMilli,
  formatSu,
  isSafeComputePath,
  launchStringBytes,
  launchVariableBytes,
  parseSuToMilli,
  suMilliFor,
} from "../shared/contract/compute";
import {
  BundleResponseSchema,
  LAUNCH_RUNTIMES,
  LAUNCH_SPEC_MAX_BYTES,
  LAUNCH_SPEC_VERSION,
  LaunchSpecSchema,
  OutputsRequestSchema,
  OutputsResponseSchema,
  encodeLaunchSpec,
  launchSpecFits,
  resultsLauncherKey,
  resultsOutputKey,
} from "../shared/contract/compute-launch";
import launchSchema from "../shared/contract/compute-launch.schema.json";
import * as contractIndex from "../shared/contract/index";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const JOB_ID = "job_0123456789abcdef01234567";

// --- Money -------------------------------------------------------------------------------------

describe("the rate table", () => {
  test("the constants the design names are pinned", () => {
    // A change to any of these is a change to what NEMAR charges; it fails here first.
    expect(RATE_TABLE_V1).toEqual({
      version: 1,
      milliPerSu: 1000,
      cpuNodeCores: 128,
      gpuNodeGpus: 4,
      memoryMbPerCoreUnit: 2048,
      memoryMbPerGpuUnit: 94208,
      preemptNumerator: 800,
      preemptDenominator: 1000,
      minChargeMilli: 1000,
    });
  });

  test("nine partitions, in two pools", () => {
    expect([...PARTITION_NAMES].sort() as string[]).toEqual(
      [
        "shared",
        "compute",
        "debug",
        "large-shared",
        "preempt",
        "gpu-shared",
        "gpu",
        "gpu-debug",
        "gpu-preempt",
      ].sort(),
    );
    expect([...COMPUTE_POOLS]).toEqual(["cpu", "gpu"]);
    const cpu = PARTITION_NAMES.filter((p) => PARTITIONS[p].pool === "cpu").sort();
    const gpu = PARTITION_NAMES.filter((p) => PARTITIONS[p].pool === "gpu").sort();
    expect(cpu).toEqual(["compute", "debug", "large-shared", "preempt", "shared"]);
    expect(gpu).toEqual(["gpu", "gpu-debug", "gpu-preempt", "gpu-shared"]);
  });
});

describe("estimateSuMilli and suMilliFor", () => {
  test("one whole compute node for an hour is 128000", () => {
    expect(estimateSuMilli({ partition: "compute", nodes: 1, minutes: 60 })).toBe(128000);
    expect(suMilliFor("compute", { nodes: 1 }, 3600)).toBe(128000);
  });

  test("whole nodes multiply, and cores and memory do not matter on a whole-node partition", () => {
    expect(suMilliFor("compute", { nodes: 2 }, 3600)).toBe(256000);
    expect(suMilliFor("compute", { nodes: 1, cores: 1, memory_mb: 1 }, 3600)).toBe(128000);
  });

  test("a 30-second shared job is the 1000 minimum", () => {
    expect(suMilliFor("shared", { nodes: 1, cores: 1 }, 30)).toBe(1000);
    expect(suMilliFor("shared", { nodes: 1, cores: 1 }, 1)).toBe(1000);
    expect(suMilliFor("shared", { nodes: 1, cores: 1 }, 0)).toBe(1000);
  });

  test("a job that costs more than the minimum is not raised to it", () => {
    expect(suMilliFor("shared", { nodes: 1, cores: 64 }, 3600)).toBe(64000);
    expect(estimateSuMilli({ partition: "shared", nodes: 1, cores: 8, minutes: 120 })).toBe(16000);
  });

  test("a charge rounds up to the next thousandth", () => {
    // 1000 milli-SU an hour for 3601 seconds is 1000.277...: the next whole thousandth is 1001.
    expect(suMilliFor("shared", { nodes: 1, cores: 1 }, 3600)).toBe(1000);
    expect(suMilliFor("shared", { nodes: 1, cores: 1 }, 3601)).toBe(1001);
    // 8000 milli-SU an hour for 1 second over an hour: 8002.22 rounds to 8003.
    expect(suMilliFor("shared", { nodes: 1, cores: 8 }, 3601)).toBe(8003);
  });

  test("a gpu node for 2 hours is 8000, whatever GPUs were asked for", () => {
    expect(estimateSuMilli({ partition: "gpu", nodes: 1, gpus: 4, minutes: 120 })).toBe(8000);
    expect(estimateSuMilli({ partition: "gpu", nodes: 1, gpus: 1, minutes: 120 })).toBe(8000);
  });

  test("shared takes the larger of cores and memory over 2 GB", () => {
    // 1 core with 16 GB: memory is 8 core-units, so 8000 an hour, not 1000.
    expect(suMilliFor("shared", { nodes: 1, cores: 1, memory_mb: 16384 }, 3600)).toBe(8000);
    // 8 cores with 8 GB: cores win.
    expect(suMilliFor("shared", { nodes: 1, cores: 8, memory_mb: 8192 }, 3600)).toBe(8000);
    // A memory request that is not a whole unit rounds the unit up: 2049 MB is 2 units.
    expect(suMilliFor("shared", { nodes: 1, cores: 1, memory_mb: 2049 }, 3600)).toBe(1001);
    expect(suMilliFor("shared", { nodes: 1, cores: 1, memory_mb: 2048 }, 3600)).toBe(1000);
  });

  test("debug and large-shared use the shared formula", () => {
    for (const p of ["debug", "large-shared"] as const) {
      expect(suMilliFor(p, { nodes: 1, cores: 8 }, 3600), p).toBe(8000);
      expect(suMilliFor(p, { nodes: 1, cores: 1, memory_mb: 16384 }, 3600), p).toBe(8000);
    }
  });

  test("gpu-shared takes the larger of GPUs and memory over 92 GB", () => {
    expect(suMilliFor("gpu-shared", { nodes: 1, gpus: 1 }, 3600)).toBe(1000);
    expect(suMilliFor("gpu-shared", { nodes: 1, gpus: 3 }, 3600)).toBe(3000);
    // 184 GB is two 92 GB units, so two GPUs' worth for one GPU.
    expect(suMilliFor("gpu-shared", { nodes: 1, gpus: 1, memory_mb: 188416 }, 3600)).toBe(2000);
    expect(suMilliFor("gpu-shared", { nodes: 1, gpus: 1, memory_mb: 94209 }, 3600)).toBe(1001);
    expect(suMilliFor("gpu-debug", { nodes: 1, gpus: 2 }, 1800)).toBe(1000);
  });

  test("per-node rates multiply by nodes", () => {
    expect(suMilliFor("shared", { nodes: 2, cores: 4 }, 3600)).toBe(8000);
    expect(suMilliFor("gpu-shared", { nodes: 2, gpus: 2 }, 3600)).toBe(4000);
  });

  test("preempt partitions multiply the final amount by 0.8 once", () => {
    expect(suMilliFor("preempt", { nodes: 1, cores: 100 }, 3600)).toBe(80000);
    expect(suMilliFor("gpu-preempt", { nodes: 1, gpus: 4 }, 3600)).toBe(3200);
    // Not 0.64: applied once, not in the rate and again in the amount.
    expect(suMilliFor("preempt", { nodes: 1, cores: 128 }, 3600)).toBe(102400);
  });

  test("a preempt charge is rounded up once, not once for the base and again for the 0.8", () => {
    // 1 core for 4504 s: 1251.11 milli-SU, times 0.8 is 1000.89, which rounds up to 1001.
    // Rounding the base first (1252) and then the 0.8 (1001.6) would give 1002.
    expect(suMilliFor("preempt", { nodes: 1, cores: 1 }, 4504)).toBe(1001);
    expect(suMilliFor("preempt", { nodes: 1, cores: 1 }, 4508)).toBe(1002);
  });

  test("a preempt charge still never falls under the 1000 minimum", () => {
    expect(suMilliFor("preempt", { nodes: 1, cores: 1 }, 60)).toBe(1000);
    expect(suMilliFor("gpu-preempt", { nodes: 1, gpus: 1 }, 1)).toBe(1000);
  });

  test("estimateSuMilli is suMilliFor over the requested minutes", () => {
    const spec = { partition: "gpu-shared", nodes: 1, gpus: 2, minutes: 90 } as const;
    expect(estimateSuMilli(spec)).toBe(suMilliFor("gpu-shared", spec, 90 * 60));
    expect(estimateSuMilli(spec)).toBe(3000);
  });

  test("a whole compute pass: 2 whole nodes for the 48-hour ceiling", () => {
    expect(estimateSuMilli({ partition: "compute", nodes: 2, minutes: 2880 })).toBe(12_288_000);
  });

  test("the answer is always a safe integer", () => {
    const v = suMilliFor("compute", { nodes: 64 }, 7 * 24 * 3600);
    expect(Number.isSafeInteger(v)).toBe(true);
    expect(v).toBe(64 * 128000 * 7 * 24);
  });

  test("an amount too large to hold exactly is refused, not rounded by a double", () => {
    // 2^40 nodes for 2^30 seconds is far past 2^53 milli-SU.
    expect(() => suMilliFor("compute", { nodes: 2 ** 40 }, 2 ** 30)).toThrow(RangeError);
  });

  test("an input that is not a whole count is refused, not rounded", () => {
    expect(() => suMilliFor("shared", { nodes: 1, cores: 1 }, -1)).toThrow(RangeError);
    expect(() => suMilliFor("shared", { nodes: 1, cores: 1 }, 1.5)).toThrow(RangeError);
    expect(() => suMilliFor("shared", { nodes: 1, cores: 1 }, Number.NaN)).toThrow(RangeError);
    expect(() => suMilliFor("shared", { nodes: 0, cores: 1 }, 10)).toThrow(RangeError);
    expect(() => suMilliFor("shared", { nodes: 1, cores: 1.5 }, 10)).toThrow(RangeError);
    expect(() => suMilliFor("shared", { nodes: 1, cores: -1 }, 10)).toThrow(RangeError);
    expect(() => suMilliFor("gpu", { nodes: 1, gpus: 0.5 }, 10)).toThrow(RangeError);
    expect(() =>
      suMilliFor("shared", { nodes: 1, memory_mb: Number.POSITIVE_INFINITY }, 10),
    ).toThrow(RangeError);
    expect(() => suMilliFor("nonsense" as "shared", { nodes: 1, cores: 1 }, 10)).toThrow(
      RangeError,
    );
  });
});

describe("preempt rounding: one exact round-up, then the minimum", () => {
  test("4501, 9001 and 13501 seconds on one preempt core", () => {
    // 1000 milli-SU an hour times 0.8: 4501 s is 1000.2222..., 9001 s is 2000.2222..., 13501 s is
    // 3000.2222.... Each rounds UP to 1001, 2001, 3001. Rounding the base first (1251) and then
    // truncating the 0.8 gives 1000 for the first: the mutant this case exists to catch.
    expect(suMilliFor("preempt", { nodes: 1, cores: 1 }, 4501)).toBe(1001);
    expect(suMilliFor("preempt", { nodes: 1, cores: 1 }, 9001)).toBe(2001);
    expect(suMilliFor("preempt", { nodes: 1, cores: 1 }, 13501)).toBe(3001);
  });

  test("the same on one GPU of gpu-preempt", () => {
    expect(suMilliFor("gpu-preempt", { nodes: 1, gpus: 1 }, 4501)).toBe(1001);
    expect(suMilliFor("gpu-preempt", { nodes: 1, gpus: 1 }, 9001)).toBe(2001);
    expect(suMilliFor("gpu-preempt", { nodes: 1, gpus: 1 }, 13501)).toBe(3001);
    expect(suMilliFor("gpu-preempt", { nodes: 2, gpus: 2 }, 4501)).toBe(
      suMilliFor("preempt", { nodes: 2, cores: 2 }, 4501),
    );
  });

  test("the minimum is applied after the factor: a short preempt job costs 1000, not 800", () => {
    expect(suMilliFor("preempt", { nodes: 1, cores: 1 }, 3600)).toBe(1000);
    expect(suMilliFor("preempt", { nodes: 1, cores: 1 }, 1)).toBe(1000);
    // 3600 s at 800/1000 of 1000 is exactly 800, under the minimum; 4500 s is exactly 1000.
    expect(suMilliFor("preempt", { nodes: 1, cores: 1 }, 4500)).toBe(1000);
    expect(suMilliFor("preempt", { nodes: 1, cores: 1 }, 4499)).toBe(1000);
    expect(suMilliFor("preempt", { nodes: 1, cores: 1 }, 4502)).toBe(1001);
  });

  /** ceil(rate * seconds * num / (3600 * den)), then the 1000 floor, by long division. */
  function exact(ratePerHour: number, seconds: number, num: number, den: number): number {
    const n = BigInt(ratePerHour) * BigInt(seconds) * BigInt(num);
    const d = 3600n * BigInt(den);
    const q = n / d;
    const amount = n % d === 0n ? q : q + 1n;
    return Number(amount < 1000n ? 1000n : amount);
  }

  test("every second from 0 to 20000, against an exact rational computed separately", () => {
    for (const [partition, resources, rate] of [
      ["preempt", { nodes: 1, cores: 1 }, 1000],
      ["preempt", { nodes: 1, cores: 3 }, 3000],
      ["preempt", { nodes: 2, cores: 7 }, 14000],
      ["gpu-preempt", { nodes: 1, gpus: 1 }, 1000],
      ["gpu-preempt", { nodes: 2, gpus: 3 }, 6000],
    ] as const) {
      for (let s = 0; s <= 20000; s++) {
        const got = suMilliFor(partition, resources, s);
        const want = exact(rate, s, 800, 1000);
        if (got !== want)
          throw new Error(`${partition} ${JSON.stringify(resources)} ${s}s: ${got} !== ${want}`);
      }
    }
  });

  test("a non-preempt partition is the same loop with the factor 1", () => {
    for (let s = 0; s <= 8000; s += 7) {
      expect(suMilliFor("shared", { nodes: 1, cores: 5 }, s), String(s)).toBe(exact(5000, s, 1, 1));
    }
  });
});

describe("a rate needs something to charge", () => {
  test("a per-core partition with neither cores nor memory is refused, not priced at the minimum", () => {
    expect(() => suMilliFor("shared", { nodes: 1 }, 7200)).toThrow(RangeError);
    expect(() => suMilliFor("shared", { nodes: 1, cores: 0, memory_mb: 0 }, 7200)).toThrow(
      RangeError,
    );
    expect(() => suMilliFor("debug", { nodes: 1 }, 600)).toThrow(RangeError);
    expect(() => suMilliFor("large-shared", { nodes: 1 }, 600)).toThrow(RangeError);
    expect(() => suMilliFor("preempt", { nodes: 1 }, 600)).toThrow(RangeError);
  });

  test("a per-GPU partition with neither GPUs nor memory is refused", () => {
    expect(() => estimateSuMilli({ partition: "gpu-shared", nodes: 1, minutes: 2880 })).toThrow(
      RangeError,
    );
    expect(() => suMilliFor("gpu-debug", { nodes: 1, gpus: 0, memory_mb: 0 }, 60)).toThrow(
      RangeError,
    );
    expect(() => suMilliFor("gpu-preempt", { nodes: 1 }, 60)).toThrow(RangeError);
  });

  test("either driver alone is enough", () => {
    expect(suMilliFor("shared", { nodes: 1, memory_mb: 4096 }, 3600)).toBe(2000);
    expect(suMilliFor("shared", { nodes: 1, cores: 2 }, 3600)).toBe(2000);
    expect(suMilliFor("gpu-shared", { nodes: 1, memory_mb: 94208 }, 3600)).toBe(1000);
    expect(suMilliFor("gpu-shared", { nodes: 1, gpus: 2 }, 3600)).toBe(2000);
  });

  test("a whole-node partition needs no driver, because the node is the charge", () => {
    expect(suMilliFor("compute", { nodes: 1 }, 3600)).toBe(128000);
    expect(suMilliFor("gpu", { nodes: 1 }, 3600)).toBe(4000);
  });
});

describe("a partition name is an own key, not anything on Object.prototype", () => {
  test("suMilliFor refuses a name that is not a partition, including inherited ones", () => {
    for (const name of ["toString", "__proto__", "constructor", "hasOwnProperty", "valueOf", ""]) {
      expect(() => suMilliFor(name as never, { nodes: 1, cores: 1 }, 10), name).toThrow(RangeError);
    }
    expect(() =>
      estimateSuMilli({ partition: "toString" as never, nodes: 1, cores: 1, minutes: 1 }),
    ).toThrow(RangeError);
  });
});

describe("parseSuToMilli and formatSu", () => {
  test("a value that is not text is refused, not coerced", () => {
    // A number 12 would match the pattern as the string "12" if it were not guarded.
    for (const value of [12, 12.5, 0, null, undefined, {}, [], ["12"], true]) {
      expect(parseSuToMilli(value as never), String(value)).toBeNull();
    }
  });

  test("12.5 SU is 12500", () => {
    expect(parseSuToMilli("12.5")).toBe(12500);
  });

  test("whole numbers, up to three decimals, and zero", () => {
    expect(parseSuToMilli("12")).toBe(12000);
    expect(parseSuToMilli("0")).toBe(0);
    expect(parseSuToMilli("0.001")).toBe(1);
    expect(parseSuToMilli("12.345")).toBe(12345);
    expect(parseSuToMilli("1000000")).toBe(1_000_000_000);
    expect(parseSuToMilli("007.50")).toBe(7500);
  });

  test("four decimals are refused, even when the last is zero", () => {
    expect(parseSuToMilli("1.2345")).toBeNull();
    expect(parseSuToMilli("12.5000")).toBeNull();
    expect(parseSuToMilli("0.0001")).toBeNull();
  });

  test("negatives and signs are refused", () => {
    expect(parseSuToMilli("-1")).toBeNull();
    expect(parseSuToMilli("-0.5")).toBeNull();
    expect(parseSuToMilli("-0")).toBeNull();
    expect(parseSuToMilli("+1")).toBeNull();
  });

  test("anything that is not a plain decimal is refused", () => {
    for (const bad of [
      "",
      ".",
      ".5",
      "5.",
      "1e3",
      "1,5",
      " 1",
      "1 ",
      "1\n",
      "0x10",
      "NaN",
      "Infinity",
      "1_000",
      "twelve",
    ]) {
      expect(parseSuToMilli(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  test("a value too large to hold exactly is refused", () => {
    expect(parseSuToMilli("9007199254740")).toBe(9_007_199_254_740_000);
    expect(parseSuToMilli("9007199254741")).toBeNull();
    expect(parseSuToMilli("99999999999999999999")).toBeNull();
  });

  test("formatSu writes the shortest exact decimal", () => {
    expect(formatSu(12500)).toBe("12.5");
    expect(formatSu(12000)).toBe("12");
    expect(formatSu(1)).toBe("0.001");
    expect(formatSu(0)).toBe("0");
    expect(formatSu(123456)).toBe("123.456");
    expect(formatSu(10)).toBe("0.01");
    expect(formatSu(-500)).toBe("-0.5");
    expect(formatSu(-1234)).toBe("-1.234");
  });

  test("the two agree on every figure that parses", () => {
    for (const milli of [0, 1, 9, 10, 99, 100, 999, 1000, 1001, 12500, 123456, 987654321]) {
      expect(parseSuToMilli(formatSu(milli)), String(milli)).toBe(milli);
    }
  });

  test("formatSu refuses a figure that is not a whole number of thousandths", () => {
    expect(() => formatSu(1.5)).toThrow(RangeError);
    expect(() => formatSu(Number.NaN)).toThrow(RangeError);
    expect(() => formatSu(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

// --- Partitions and policy ---------------------------------------------------------------------

/**
 * The six partitions offered to people and their default per-job ceilings (design section 5):
 * 1 node of up to 64 cores in `shared`, 2 whole nodes in `compute`, 1 node of up to 3 GPUs in
 * `gpu-shared`, 1 whole node of 4 GPUs in `gpu`, 48 hours (2880 minutes) for each of those four
 * and 30 minutes for the two debug partitions. The `debug` node count and the 40 cores of a GPU
 * node are unconfirmed (design section 12, question 5).
 */
const LITERAL_CEILINGS = {
  shared: { maxNodes: 1, maxCoresPerNode: 64, maxGpusPerNode: 0, maxMinutes: 2880 },
  compute: { maxNodes: 2, maxCoresPerNode: 128, maxGpusPerNode: 0, maxMinutes: 2880 },
  debug: { maxNodes: 2, maxCoresPerNode: 128, maxGpusPerNode: 0, maxMinutes: 30 },
  "gpu-shared": { maxNodes: 1, maxCoresPerNode: 40, maxGpusPerNode: 3, maxMinutes: 2880 },
  gpu: { maxNodes: 1, maxCoresPerNode: 40, maxGpusPerNode: 4, maxMinutes: 2880 },
  "gpu-debug": { maxNodes: 1, maxCoresPerNode: 40, maxGpusPerNode: 4, maxMinutes: 30 },
} as const;

describe("partitions and their default ceilings (design section 5)", () => {
  test("the four partitions offered with a 48-hour ceiling", () => {
    expect(PARTITIONS.shared.ceiling).toEqual({
      maxNodes: 1,
      maxCoresPerNode: 64,
      maxGpusPerNode: 0,
      maxMinutes: 2880,
    });
    expect(PARTITIONS.compute.ceiling).toMatchObject({ maxNodes: 2, maxMinutes: 2880 });
    expect(PARTITIONS["gpu-shared"].ceiling).toMatchObject({
      maxNodes: 1,
      maxGpusPerNode: 3,
      maxMinutes: 2880,
    });
    expect(PARTITIONS.gpu.ceiling).toMatchObject({
      maxNodes: 1,
      maxGpusPerNode: 4,
      maxMinutes: 2880,
    });
  });

  test("debug partitions are offered for 30 minutes", () => {
    expect(PARTITIONS.debug.ceiling?.maxMinutes).toBe(30);
    expect(PARTITIONS["gpu-debug"].ceiling?.maxMinutes).toBe(30);
  });

  test("large-shared and the preempt partitions are not offered to people", () => {
    for (const p of ["large-shared", "preempt", "gpu-preempt"] as const) {
      expect(PARTITIONS[p].ceiling, p).toBeNull();
    }
  });

  test("a CPU partition never offers a GPU and a GPU partition always does", () => {
    for (const p of PARTITION_NAMES) {
      const c = PARTITIONS[p].ceiling;
      if (!c) continue;
      if (PARTITIONS[p].pool === "cpu") expect(c.maxGpusPerNode, p).toBe(0);
      else expect(c.maxGpusPerNode, p).toBeGreaterThan(0);
    }
  });

  test("every default ceiling field of the six offered partitions, against literals", () => {
    // Written out, not read from PARTITIONS: a changed number must change this test too.
    expect(Object.keys(LITERAL_CEILINGS).sort()).toEqual([
      "compute",
      "debug",
      "gpu",
      "gpu-debug",
      "gpu-shared",
      "shared",
    ]);
    for (const [name, ceiling] of Object.entries(LITERAL_CEILINGS)) {
      expect(PARTITIONS[name as PartitionName].ceiling as unknown, name).toEqual(ceiling);
    }
    for (const name of ["large-shared", "preempt", "gpu-preempt"] as const) {
      expect(PARTITIONS[name].ceiling, name).toBeNull();
    }
  });

  test("the default policy offers exactly those six, with those ceilings", () => {
    expect(DEFAULT_COMPUTE_POLICY.ceilings as unknown).toEqual(LITERAL_CEILINGS);
  });
});

describe("the whole default policy, against literals", () => {
  test("every field of DEFAULT_COMPUTE_POLICY", () => {
    expect(DEFAULT_COMPUTE_POLICY as unknown).toEqual({
      defaultGrantMilli: { cpu: 0, gpu: 0 },
      renewal: { enabled: false, everyDays: null },
      ceilings: LITERAL_CEILINGS,
      maxLiveJobsPerPerson: 4,
      pipelines: { dailyJobCap: 50, maxLiveJobs: { cpu: 8, gpu: 4 } },
      clients: {},
      reservationWaitMinutes: 30,
      retention: { recordsYears: 7, logsDays: 365, resultsDays: 30 },
      resultLimits: {
        maxJobBytes: 21474836480,
        maxFiles: 5000,
        maxStoredBytesPerPerson: 53687091200,
        maxStoredBytesTotal: 1099511627776,
      },
      settle: { toleranceMilli: 1000, tolerancePercent: 5 },
      registries: [],
      bundleLimits: { maxTotalBytes: 104857600, maxFiles: 2000, maxFileBytes: 26214400 },
    });
  });
});

describe("the owner policy", () => {
  test("DEFAULT_COMPUTE_POLICY parses under its own schema, unchanged", () => {
    const parsed = ComputePolicySchema.parse(DEFAULT_COMPUTE_POLICY);
    expect(parsed).toEqual(DEFAULT_COMPUTE_POLICY);
    expect(ComputePolicySchema.parse(JSON.parse(JSON.stringify(DEFAULT_COMPUTE_POLICY)))).toEqual(
      DEFAULT_COMPUTE_POLICY,
    );
  });

  test("the values the design and the phase issue fix", () => {
    expect(DEFAULT_COMPUTE_POLICY.defaultGrantMilli).toEqual({ cpu: 0, gpu: 0 });
    expect(DEFAULT_COMPUTE_POLICY.reservationWaitMinutes).toBe(30);
    expect(DEFAULT_COMPUTE_POLICY.retention).toEqual({
      recordsYears: 7,
      logsDays: 365,
      resultsDays: 30,
    });
    expect(DEFAULT_COMPUTE_POLICY.resultLimits).toEqual({
      maxJobBytes: 20 * 1024 ** 3,
      maxFiles: 5000,
      maxStoredBytesPerPerson: 50 * 1024 ** 3,
      maxStoredBytesTotal: 1024 ** 4,
    });
  });

  test("the defaults the phase issue names but does not give a number for", () => {
    // Initial values chosen in phase A1; the owner adjusts them with `policy set`. Everything that
    // lets work start is closed or small: no grant, no registry, no client, a few jobs.
    expect(DEFAULT_COMPUTE_POLICY.renewal).toEqual({ enabled: false, everyDays: null });
    expect(DEFAULT_COMPUTE_POLICY.maxLiveJobsPerPerson).toBe(4);
    expect(DEFAULT_COMPUTE_POLICY.pipelines).toEqual({
      dailyJobCap: 50,
      maxLiveJobs: { cpu: 8, gpu: 4 },
    });
    expect(DEFAULT_COMPUTE_POLICY.clients).toEqual({});
    expect(DEFAULT_COMPUTE_POLICY.registries).toEqual([]);
    expect(DEFAULT_COMPUTE_POLICY.settle).toEqual({ toleranceMilli: 1000, tolerancePercent: 5 });
    expect(DEFAULT_COMPUTE_POLICY.bundleLimits).toEqual({
      maxTotalBytes: 100 * 1024 ** 2,
      maxFiles: 2000,
      maxFileBytes: 25 * 1024 ** 2,
    });
  });

  test("RESULT_MAX_FILE_BYTES is 5 GB, under what one presigned PUT accepts", () => {
    expect(RESULT_MAX_FILE_BYTES).toBe(5_000_000_000);
    expect(RESULT_MAX_FILE_BYTES).toBeLessThan(5 * 1024 ** 3);
  });

  test("the default is frozen, so no caller can change it for everyone", () => {
    const mutate = () => {
      (DEFAULT_COMPUTE_POLICY as { maxLiveJobsPerPerson: number }).maxLiveJobsPerPerson = 99;
    };
    expect(mutate).toThrow();
    expect(() => {
      (DEFAULT_COMPUTE_POLICY.retention as { resultsDays: number }).resultsDays = 1;
    }).toThrow();
    expect(() => {
      (DEFAULT_COMPUTE_POLICY.ceilings.shared as { maxNodes: number }).maxNodes = 9;
    }).toThrow();
    expect(DEFAULT_COMPUTE_POLICY.maxLiveJobsPerPerson).toBe(4);
  });

  const policyClone = () =>
    // biome-ignore lint/suspicious/noExplicitAny: a test document is walked by path
    JSON.parse(JSON.stringify(DEFAULT_COMPUTE_POLICY)) as Record<string, any>;
  const refused = (p: unknown) => ComputePolicySchema.safeParse(p).success === false;

  test("an unknown key is refused at the top and at every level", () => {
    const top = policyClone();
    top.surprise = 1;
    expect(refused(top)).toBe(true);
    for (const key of [
      "defaultGrantMilli",
      "renewal",
      "pipelines",
      "retention",
      "resultLimits",
      "settle",
      "bundleLimits",
    ]) {
      const p = policyClone();
      p[key].surprise = 1;
      expect(refused(p), key).toBe(true);
    }
    const p = policyClone();
    p.pipelines.maxLiveJobs.surprise = 1;
    expect(refused(p)).toBe(true);
    const q = policyClone();
    q.ceilings.shared.surprise = 1;
    expect(refused(q)).toBe(true);
  });

  test("every key is required", () => {
    for (const key of Object.keys(DEFAULT_COMPUTE_POLICY)) {
      const p = policyClone();
      delete p[key];
      expect(refused(p), key).toBe(true);
    }
  });

  test("results are kept at least 14 days", () => {
    const ok = policyClone();
    ok.retention.resultsDays = 14;
    expect(refused(ok)).toBe(false);
    const bad = policyClone();
    bad.retention.resultsDays = 13;
    expect(refused(bad)).toBe(true);
  });

  test("a figure must be a whole non-negative number", () => {
    for (const [path, value] of [
      ["defaultGrantMilli.cpu", -1],
      ["defaultGrantMilli.gpu", 1.5],
      ["maxLiveJobsPerPerson", -1],
      ["maxLiveJobsPerPerson", 2.5],
      ["pipelines.dailyJobCap", -1],
      ["pipelines.maxLiveJobs.gpu", 0.5],
      ["reservationWaitMinutes", 0],
      ["retention.recordsYears", 0],
      ["retention.logsDays", -1],
      ["resultLimits.maxFiles", 0],
      ["resultLimits.maxJobBytes", 1e30],
      ["settle.tolerancePercent", 101],
      ["settle.toleranceMilli", -1],
      ["bundleLimits.maxFiles", 0],
    ] as const) {
      const p = policyClone();
      const parts = path.split(".");
      let cur = p;
      for (const part of parts.slice(0, -1)) cur = cur[part];
      cur[parts[parts.length - 1]] = value;
      expect(refused(p), `${path}=${value}`).toBe(true);
    }
  });

  test("a ceiling is whole, positive where it must be, and only for a known partition", () => {
    const p = policyClone();
    p.ceilings.shared.maxNodes = 0;
    expect(refused(p)).toBe(true);
    const q = policyClone();
    q.ceilings.shared.maxMinutes = 0;
    expect(refused(q)).toBe(true);
    const r = policyClone();
    r.ceilings.nonsense = { maxNodes: 1, maxCoresPerNode: 1, maxGpusPerNode: 0, maxMinutes: 1 };
    expect(refused(r)).toBe(true);
    // A partition NEMAR does not offer by default can be offered by adding a ceiling.
    const s = policyClone();
    s.ceilings["large-shared"] = {
      maxNodes: 1,
      maxCoresPerNode: 128,
      maxGpusPerNode: 0,
      maxMinutes: 1440,
    };
    expect(refused(s)).toBe(false);
    // Dropping one withdraws it.
    const t = policyClone();
    // biome-ignore lint/performance/noDelete: absence of the key is the case under test
    delete t.ceilings.compute;
    expect(refused(t)).toBe(false);
  });

  test("renewal that is on must say how often", () => {
    const on = policyClone();
    on.renewal = { enabled: true, everyDays: 90 };
    expect(refused(on)).toBe(false);
    const bad = policyClone();
    bad.renewal = { enabled: true, everyDays: null };
    expect(refused(bad)).toBe(true);
    const zero = policyClone();
    zero.renewal = { enabled: true, everyDays: 0 };
    expect(refused(zero)).toBe(true);
  });

  test("clients are keyed by a plain client id and carry whole caps", () => {
    const ok = policyClone();
    ok.clients = { partner_site: { maxOpenReservations: 10, maxReservedMilliPerDay: 500000 } };
    expect(refused(ok)).toBe(false);
    const badKey = policyClone();
    badKey.clients = { "has space": { maxOpenReservations: 1, maxReservedMilliPerDay: 1 } };
    expect(refused(badKey)).toBe(true);
    const badCap = policyClone();
    badCap.clients = { c: { maxOpenReservations: -1, maxReservedMilliPerDay: 1 } };
    expect(refused(badCap)).toBe(true);
    const extra = policyClone();
    extra.clients = { c: { maxOpenReservations: 1, maxReservedMilliPerDay: 1, more: 1 } };
    expect(refused(extra)).toBe(true);
  });

  test("a registry is a host with an optional port and path", () => {
    const ok = policyClone();
    ok.registries = ["ghcr.io", "registry.example.test:5000/team"];
    expect(refused(ok)).toBe(false);
    for (const bad of ["", "https://ghcr.io", "ghcr.io/Team", "a b", "ghcr.io/../x"]) {
      const p = policyClone();
      p.registries = [bad];
      expect(refused(p), bad).toBe(true);
    }
  });
});

// --- The job specification ---------------------------------------------------------------------

const SPEC = {
  name: "eeg-floor",
  runtime: "python",
  entry: "run.py",
  bundle: { size: 1234, sha256: HEX_A },
  datasets: [{ id: "nm000104", version: "1.0.2" }],
  partition: "shared",
  minutes: 120,
} as const;

const specRefused = (s: unknown) => JobSpecSchema.safeParse(s).success === false;
const specWith = (patch: Record<string, unknown>) => ({ ...SPEC, ...patch });
const specWithout = (key: string) => {
  const { [key]: _drop, ...rest } = SPEC as Record<string, unknown>;
  return rest;
};

describe("the job specification", () => {
  test("a minimal Python job parses, with every default written out", () => {
    expect(JobSpecSchema.parse(SPEC)).toEqual({
      name: "eeg-floor",
      runtime: "python",
      entry: "run.py",
      args: [],
      bundle: { size: 1234, sha256: HEX_A },
      datasets: [{ id: "nm000104", version: "1.0.2" }],
      partition: "shared",
      nodes: 1,
      cores: 1,
      gpus: 0,
      minutes: 120,
      output_dir: "outputs",
      env: {},
    });
  });

  test("the three runtimes", () => {
    expect([...JOB_RUNTIMES]).toEqual(["python", "matlab", "image"]);
    // MATLAB is a valid specification; a route refuses it as `runtime_unavailable` until it is licensed.
    expect(specRefused(specWith({ runtime: "matlab" }))).toBe(false);
    expect(specRefused(specWith({ runtime: "julia" }))).toBe(true);
  });

  test("an unknown key is refused", () => {
    expect(specRefused(specWith({ surprise: 1 }))).toBe(true);
    expect(
      specRefused(specWith({ bundle: { size: 1, sha256: HEX_A, url: "https://x.test" } })),
    ).toBe(true);
    expect(specRefused(specWith({ datasets: [{ id: "nm000104", version: "1", x: 1 }] }))).toBe(
      true,
    );
  });

  test("an environment name off the allowlist is refused", () => {
    for (const name of [
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "PATH",
      "HOME",
      "PYTHONPATH",
      "PYTHONSTARTUP",
      "NEMAR_LAUNCH_SPEC",
      "NEMAR_OUT",
      "omp_num_threads",
      "",
    ]) {
      expect(specRefused(specWith({ env: { [name]: "1" } })), name).toBe(true);
    }
  });

  test("every allowlisted environment name is accepted", () => {
    for (const name of JOB_ENV_ALLOWLIST) {
      expect(specRefused(specWith({ env: { [name]: "4" } })), name).toBe(false);
    }
    expect(JobSpecSchema.parse(specWith({ env: { OMP_NUM_THREADS: "4" } })).env).toEqual({
      OMP_NUM_THREADS: "4",
    });
  });

  test("the allowlist is thread counts and determinism, never a path or a loader", () => {
    expect([...JOB_ENV_ALLOWLIST]).toEqual([
      "OMP_NUM_THREADS",
      "MKL_NUM_THREADS",
      "OPENBLAS_NUM_THREADS",
      "NUMEXPR_NUM_THREADS",
      "PYTHONHASHSEED",
      "MPLBACKEND",
    ]);
    for (const name of JOB_ENV_ALLOWLIST) expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  test("an environment value is short printable text", () => {
    expect(specRefused(specWith({ env: { OMP_NUM_THREADS: "4\n5" } }))).toBe(true);
    expect(specRefused(specWith({ env: { OMP_NUM_THREADS: "x".repeat(257) } }))).toBe(true);
    expect(specRefused(specWith({ env: { OMP_NUM_THREADS: "x".repeat(256) } }))).toBe(false);
    expect(specRefused(specWith({ env: { OMP_NUM_THREADS: 4 } }))).toBe(true);
    expect(specRefused(specWith({ env: { MPLBACKEND: "Agg" } }))).toBe(false);
  });

  test("an entry is a relative path inside the bundle", () => {
    for (const bad of [
      "/run.py",
      "../run.py",
      "a/../run.py",
      "a//b.py",
      "a\\b.py",
      "",
      "./run.py",
      "a/.",
    ]) {
      expect(specRefused(specWith({ entry: bad })), bad).toBe(true);
    }
    expect(specRefused(specWith({ entry: "src/analysis/run.py" }))).toBe(false);
    expect(specRefused(specWith({ entry: `${"a/".repeat(120)}x.py` }))).toBe(true);
  });

  test("an entry and a command are one or the other", () => {
    expect(specRefused(specWith({ command: ["python", "run.py"] }))).toBe(true);
    // Neither, and no recipe: nothing to run.
    expect(specRefused(specWithout("entry"))).toBe(true);
  });

  test("an entry needs the bundle that holds it", () => {
    expect(specRefused(specWithout("bundle"))).toBe(true);
  });

  test("an image job names a digest-pinned image and a command", () => {
    const image = `docker://ghcr.io/example/tool@sha256:${HEX_B}`;
    const job = {
      name: "tool",
      runtime: "image",
      image,
      command: ["tool", "--in", "/data"],
      partition: "shared",
      minutes: 30,
    };
    expect(specRefused(job)).toBe(false);
    // A tag is not a pin.
    expect(specRefused({ ...job, image: "docker://ghcr.io/example/tool:latest" })).toBe(true);
    expect(specRefused({ ...job, image: `ghcr.io/example/tool@sha256:${"c".repeat(63)}` })).toBe(
      true,
    );
    expect(specRefused({ ...job, image: `ghcr.io/example/tool@sha256:${HEX_B}` })).toBe(false);
    // The runtime and the image go together.
    const { image: _i, ...noImage } = job;
    expect(specRefused(noImage)).toBe(true);
    expect(specRefused(specWith({ image }))).toBe(true);
    // A command may travel with a bundle or without one.
    expect(specRefused({ ...job, bundle: { size: 9, sha256: HEX_A } })).toBe(false);
  });

  test("at most 20 datasets", () => {
    const some = (n: number) =>
      Array.from({ length: n }, () => ({ id: "nm000104", version: "1.0.2" }));
    expect(specRefused(specWith({ datasets: some(20) }))).toBe(false);
    expect(specRefused(specWith({ datasets: some(21) }))).toBe(true);
  });

  test("an image reference with no digest at all is not a pin", () => {
    const job = {
      name: "tool",
      runtime: "image",
      command: ["tool"],
      partition: "shared",
      minutes: 30,
    };
    expect(specRefused({ ...job, image: "docker://ghcr.io/example/tool" })).toBe(true);
    expect(specRefused({ ...job, image: "ghcr.io/example/tool@sha256:" })).toBe(true);
    expect(specRefused({ ...job, image: `ghcr.io/example/tool@sha256:${"B".repeat(64)}` })).toBe(
      true,
    );
  });

  test("a recipe job needs no entry, command or bundle", () => {
    const recipe = {
      name: "floor-nm000104",
      runtime: "python",
      recipe: "nemar-floor",
      datasets: [{ id: "nm000104", version: "1.0.2" }],
      partition: "shared",
      minutes: 60,
    };
    expect(specRefused(recipe)).toBe(false);
    expect(specRefused({ ...recipe, recipe: "Nemar Floor" })).toBe(true);
    expect(specRefused({ ...recipe, recipe: "" })).toBe(true);
  });

  test("a dataset is an id, a version and optional include patterns", () => {
    for (const bad of [
      { id: "nm00010", version: "1" },
      { id: "NM000104", version: "1" },
      { id: "nm000104", version: "" },
      { id: "nm000104", version: "../1" },
      { id: "nm000104" },
      { version: "1" },
    ]) {
      expect(specRefused(specWith({ datasets: [bad] })), JSON.stringify(bad)).toBe(true);
    }
    expect(specRefused(specWith({ datasets: [{ id: "ds002718", version: "1.0.5" }] }))).toBe(false);
    expect(
      specRefused(
        specWith({
          datasets: [{ id: "nm000104", version: "1.0.2", include: ["sub-01/**/*.set"] }],
        }),
      ),
    ).toBe(false);
  });

  test("an include pattern never leaves the dataset", () => {
    for (const bad of ["/etc/passwd", "../x", "a/../../x", "a\\b", "", "a\nb"]) {
      const datasets = [{ id: "nm000104", version: "1.0.2", include: [bad] }];
      expect(specRefused(specWith({ datasets })), JSON.stringify(bad)).toBe(true);
    }
  });

  test("resources are whole numbers inside sane bounds", () => {
    for (const patch of [
      { partition: "nonsense" },
      { minutes: 0 },
      { minutes: 1.5 },
      { minutes: 10081 },
      { nodes: 0 },
      { cores: 0 },
      { cores: 8.5 },
      { gpus: -1 },
      { memory_mb: 0 },
      { memory_mb: -5 },
    ]) {
      expect(specRefused(specWith(patch)), JSON.stringify(patch)).toBe(true);
    }
    expect(specRefused(specWith({ memory_mb: 16384, cores: 8, nodes: 2, gpus: 0 }))).toBe(false);
  });

  test("a GPU partition needs at least one GPU and a CPU partition takes none", () => {
    for (const partition of ["gpu-shared", "gpu", "gpu-debug", "gpu-preempt"]) {
      expect(specRefused(specWith({ partition })), `${partition} with the default 0 GPUs`).toBe(
        true,
      );
      expect(specRefused(specWith({ partition, gpus: 0 })), partition).toBe(true);
      expect(specRefused(specWith({ partition, gpus: 1 })), `${partition} with 1`).toBe(false);
      expect(specRefused(specWith({ partition, gpus: 4 })), `${partition} with 4`).toBe(false);
    }
    for (const partition of ["shared", "compute", "debug", "large-shared", "preempt"]) {
      expect(specRefused(specWith({ partition })), `${partition} with the default`).toBe(false);
      expect(specRefused(specWith({ partition, gpus: 1 })), `${partition} with 1 GPU`).toBe(true);
    }
    const issue = JobSpecSchema.safeParse(specWith({ partition: "gpu-shared" }));
    expect(issue.success).toBe(false);
    if (!issue.success) expect(issue.error.issues.map((i) => i.path.join("."))).toEqual(["gpus"]);
  });

  test("a partition name that is only an inherited key is refused", () => {
    for (const partition of ["toString", "__proto__", "constructor", "hasOwnProperty"]) {
      expect(specRefused(specWith({ partition })), partition).toBe(true);
    }
  });

  test("memory is at most 16777216 MB (16 TiB)", () => {
    expect(specRefused(specWith({ memory_mb: 16_777_216 }))).toBe(false);
    expect(specRefused(specWith({ memory_mb: 16_777_217 }))).toBe(true);
    expect(specRefused(specWith({ memory_mb: 1 }))).toBe(false);
  });

  test("the output directory is `outputs`, which the launcher's layout fixes", () => {
    expect(JobSpecSchema.parse(SPEC).output_dir).toBe("outputs");
    expect(specRefused(specWith({ output_dir: "results" }))).toBe(true);
  });

  test("a name is short and plain", () => {
    for (const bad of ["", " lead", "x".repeat(81), "a\nb", "a/b", "a;b"]) {
      expect(specRefused(specWith({ name: bad })), JSON.stringify(bad)).toBe(true);
    }
    expect(specRefused(specWith({ name: "EEG floor, run 1.2" }))).toBe(true);
    expect(specRefused(specWith({ name: "EEG floor run 1.2" }))).toBe(false);
  });

  test("arguments are bounded strings", () => {
    expect(specRefused(specWith({ args: ["--fast", "x".repeat(1024)] }))).toBe(false);
    expect(specRefused(specWith({ args: ["x".repeat(1025)] }))).toBe(true);
    expect(specRefused(specWith({ args: Array.from({ length: 65 }, () => "a") }))).toBe(true);
    expect(specRefused(specWith({ args: [1] }))).toBe(true);
  });

  test("a bundle digest is lowercase hex and its size is positive", () => {
    expect(specRefused(specWith({ bundle: { size: 1, sha256: "A".repeat(64) } }))).toBe(true);
    expect(specRefused(specWith({ bundle: { size: 1, sha256: "a".repeat(63) } }))).toBe(true);
    expect(specRefused(specWith({ bundle: { size: 0, sha256: HEX_A } }))).toBe(true);
    expect(specRefused(specWith({ bundle: { sha256: HEX_A } }))).toBe(true);
  });

  test("a specification survives a JSON round trip unchanged", () => {
    const once = JobSpecSchema.parse(SPEC);
    expect(JobSpecSchema.parse(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });
});

describe("isSafeComputePath", () => {
  test("accepts ordinary relative paths and refuses every escape", () => {
    for (const ok of ["a", "a/b", "a b/c.d", "sub-01/eeg/x.set", "..a", "a..b", ".hidden"]) {
      expect(isSafeComputePath(ok), ok).toBe(true);
    }
    for (const bad of [
      "",
      "/a",
      "a/",
      "a//b",
      ".",
      "..",
      "../a",
      "a/..",
      "a/../b",
      "./a",
      "a/./b",
      "a\\b",
      "a\u0000b",
      "a\nb",
      "a\u007fb",
    ]) {
      expect(isSafeComputePath(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(isSafeComputePath("a".repeat(512))).toBe(true);
    expect(isSafeComputePath("a".repeat(513))).toBe(false);
    expect(isSafeComputePath("a".repeat(11), 10)).toBe(false);
  });
});

// --- The launcher's files ----------------------------------------------------------------------

describe("the launcher contract", () => {
  test("the records bucket keeps the launcher's manifest under its own name", () => {
    expect(RECORDS_RESULT_MANIFEST_FILE).toBe("result-manifest.json");
    expect(LAUNCHER_FILES.manifest).toBe("manifest.json");
    // The launcher's failure code lives in result.json; there is no separate failure file.
    expect((LAUNCHER_FILE_NAMES as readonly string[]).includes(RECORDS_RESULT_MANIFEST_FILE)).toBe(
      false,
    );
    for (const rel of [
      "../shared/compute-state.ts",
      "../shared/contract/compute.ts",
      "../shared/contract/compute-launch.ts",
      "../shared/contract/compute-launch.schema.json",
    ]) {
      expect(readFileSync(join(import.meta.dir, rel), "utf8").includes("failure.json"), rel).toBe(
        false,
      );
    }
  });

  test("one path-segment grammar and one output-file bound serve the whole contract", () => {
    expect(COMPUTE_MAX_OUTPUT_FILES).toBe(100_000);
    const segment = new RegExp(`^${COMPUTE_PATH_SEGMENT}$`);
    for (const ok of ["a", "a b", "..a", "é"]) expect(segment.test(ok), ok).toBe(true);
    for (const bad of ["", "a/b", "a\\b", "a\u0001", "a\u007f", "a\n"]) {
      expect(segment.test(bad), JSON.stringify(bad)).toBe(false);
    }
    // A path built from the segment grammar is exactly isSafeComputePath's.
    const built = new RegExp(`^(?:${COMPUTE_PATH_SEGMENT}/)*${COMPUTE_PATH_SEGMENT}$`);
    for (const p of ["a", "a/b", "a//b", "/a", "a/", "a\\b", ""]) {
      expect(built.test(p), JSON.stringify(p)).toBe(isSafeComputePath(p));
    }
  });

  test("names and layout the launcher and the Worker agree on", () => {
    expect(PIPELINES_TAPIS_OWNER).toBe("nemar-pipelines");
    expect(LAUNCHER_WORK_DIR).toBe("work");
    expect(LAUNCHER_OUTPUTS_DIR).toBe("work/outputs");
    expect(LAUNCHER_DIR).toBe("launcher");
    expect(LAUNCHER_FILES).toEqual({
      result: "result.json",
      provenance: "provenance.json",
      manifest: "manifest.json",
      log: "launcher.log",
    });
    expect([...LAUNCHER_FILE_NAMES]).toEqual([
      "result.json",
      "provenance.json",
      "manifest.json",
      "launcher.log",
    ]);
    expect(LAUNCHER_ENV).toEqual({
      SPEC: "NEMAR_LAUNCH_SPEC",
      OUT: "NEMAR_OUT",
      LOCAL_DATASETS_ROOT: "NEMAR_LOCAL_DATASETS_ROOT",
      HOST_PYTHON: "NEMAR_HOST_PYTHON",
    });
  });

  test("the launcher's environment names are never on the allowlist for a job", () => {
    for (const name of Object.values(LAUNCHER_ENV)) {
      expect((JOB_ENV_ALLOWLIST as readonly string[]).includes(name), name).toBe(false);
    }
  });

  test("a job id is job_ and 24 lowercase hex", () => {
    expect(COMPUTE_JOB_ID_RE.test(JOB_ID)).toBe(true);
    for (const bad of [
      "",
      "job_",
      "job_0123456789abcdef0123456",
      "job_0123456789abcdef012345678",
      "job_0123456789ABCDEF01234567",
      "Job_0123456789abcdef01234567",
      "job-0123456789abcdef01234567",
      "job_0123456789abcdef01234567\n",
      "../job_0123456789abcdef01234567",
    ]) {
      expect(COMPUTE_JOB_ID_RE.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  test("result.json: the failure code and its exit number go together", () => {
    const ok = {
      job_id: JOB_ID,
      failure_code: null,
      detail: null,
      exit_number: 0,
      entry_exit_code: 0,
    };
    expect(LauncherResultSchema.safeParse(ok).success).toBe(true);
    LAUNCHER_FAILURE_CODES.forEach((code, i) => {
      const doc = {
        job_id: JOB_ID,
        failure_code: code,
        detail: null,
        exit_number: 10 + i,
        entry_exit_code: code === "runtime_error" ? 3 : null,
      };
      expect(LauncherResultSchema.safeParse(doc).success, code).toBe(true);
      expect(
        LauncherResultSchema.safeParse({ ...doc, exit_number: 10 + ((i + 1) % 7) }).success,
        code,
      ).toBe(false);
      expect(LauncherResultSchema.safeParse({ ...doc, exit_number: 0 }).success, code).toBe(false);
    });
    expect(LauncherResultSchema.safeParse({ ...ok, exit_number: 10 }).success).toBe(false);
    expect(LauncherResultSchema.safeParse({ ...ok, failure_code: "tapis_error" }).success).toBe(
      false,
    );
    expect(LauncherResultSchema.safeParse({ ...ok, detail: "Bad Detail" }).success).toBe(false);
    expect(LauncherResultSchema.safeParse({ ...ok, detail: "unsupported_runtime" }).success).toBe(
      true,
    );
    expect(LauncherResultSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });

  test("manifest.json lists every output with its size and sha256", () => {
    const doc = {
      job_id: JOB_ID,
      files: [
        { path: "a.txt", size: 0, sha256: HEX_A },
        { path: "sub/b.bin", size: 12, sha256: HEX_B },
      ],
    };
    expect(ResultManifestSchema.safeParse(doc).success).toBe(true);
    expect(ResultManifestSchema.safeParse({ ...doc, files: [] }).success).toBe(true);
    for (const bad of [
      { path: "../a", size: 1, sha256: HEX_A },
      { path: "/a", size: 1, sha256: HEX_A },
      { path: "a", size: -1, sha256: HEX_A },
      { path: "a", size: 1.5, sha256: HEX_A },
      { path: "a", size: 1, sha256: "A".repeat(64) },
      { path: "a", size: 1 },
      { path: "a", size: 1, sha256: HEX_A, extra: 1 },
    ]) {
      expect(
        ResultManifestSchema.safeParse({ ...doc, files: [bad] }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });

  test("provenance.json carries what the launcher recorded, from outside the container", () => {
    const doc = {
      job_id: JOB_ID,
      launch_spec_digest: HEX_A,
      bundle_digest: HEX_B,
      image: { uri: "docker://ghcr.io/example/runtime", digest: `sha256:${HEX_B}` },
      runtime_version: "3.12.3",
      staging: [{ id: "nm000104", version: "1.0.2", mode: "download", files: 12, bytes: 3456 }],
      timings: { code_fetch: 1.5, staging: 30, run: 600.25, upload: 4 },
      slurm_job_id: "1234567",
      entry_exit_code: 0,
    };
    expect(LauncherProvenanceSchema.safeParse(doc).success).toBe(true);
    expect(
      LauncherProvenanceSchema.safeParse({
        ...doc,
        bundle_digest: null,
        slurm_job_id: null,
        entry_exit_code: null,
      }).success,
    ).toBe(true);
    for (const patch of [
      { launch_spec_digest: "short" },
      { image: { uri: "x", digest: HEX_B } },
      { staging: [{ id: "nm000104", version: "1", mode: "magic", files: 1, bytes: 1 }] },
      { timings: { "Bad Phase": 1 } },
      { timings: { run: -1 } },
      { extra: 1 },
    ]) {
      expect(
        LauncherProvenanceSchema.safeParse({ ...doc, ...patch }).success,
        JSON.stringify(patch),
      ).toBe(false);
    }
  });
});

describe("the contract index", () => {
  test("re-exports the compute contract", () => {
    expect(contractIndex.JobSpecSchema).toBe(JobSpecSchema);
    expect(contractIndex.ComputePolicySchema).toBe(ComputePolicySchema);
    expect(contractIndex.suMilliFor).toBe(suMilliFor);
  });
});

// --- The launch specification and its JSON Schema ----------------------------------------------

const LAUNCH = {
  job_id: JOB_ID,
  runtime: "python",
  entry: "run.py",
  args: ["--fast"],
  bundle: { sha256: HEX_A, size: 1234 },
  datasets: [{ id: "nm000104", version: "1.0.2" }],
  api_base: "https://api.example.test",
  image: {
    uri: `docker://ghcr.io/example/runtime@sha256:${HEX_B}`,
    digest: `sha256:${HEX_B}`,
    sif: "runtime.sif",
  },
  env: { OMP_NUM_THREADS: "4" },
  resources: { gpus: 0 },
  limits: { max_files: 38000, max_total_bytes: 1073741824 },
  job_token: "t".repeat(43),
};

// biome-ignore lint/suspicious/noExplicitAny: a test document is walked by path
type Doc = Record<string, any>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
/** A copy of `base` with the value at `path` replaced, or removed when `value` is undefined. */
function set(base: Doc, path: string, value: unknown): Doc {
  const doc = clone(base);
  const parts = path.split(".");
  let cur = doc;
  for (const part of parts.slice(0, -1)) cur = cur[part];
  const last = parts[parts.length - 1];
  if (value === undefined) delete cur[last];
  else cur[last] = value;
  return doc;
}

// Strict, so a mistyped keyword in the schema throws when it compiles instead of being ignored.
// `strictRequired` stays off: the schema's `required` lists name properties declared in a branch.
const AJV_OPTIONS = { strict: true, strictRequired: false, allErrors: true } as const;
const ajv = new Ajv2020(AJV_OPTIONS);
ajv.addSchema(launchSchema);
const SCHEMA_ID = (launchSchema as { $id: string }).$id;
const validateRoot = ajv.getSchema(SCHEMA_ID);
if (!validateRoot) throw new Error("the launch schema did not compile");
function defValidator(name: string) {
  const validate = ajv.getSchema(`${SCHEMA_ID}#/$defs/${name}`);
  if (!validate) throw new Error(`no $defs/${name} in the launch schema`);
  return validate;
}

/** One document, judged by the JSON Schema and by zod, with the verdict it must get from both. */
type Case = readonly [label: string, doc: unknown, valid: boolean];

function agree(
  cases: readonly Case[],
  ajvValidate: (d: unknown) => boolean,
  zodValidate: (d: unknown) => boolean,
) {
  expect(cases.some(([, , valid]) => valid)).toBe(true);
  expect(cases.some(([, , valid]) => !valid)).toBe(true);
  for (const [label, doc, valid] of cases) {
    expect(ajvValidate(doc), `JSON Schema: ${label}`).toBe(valid);
    expect(zodValidate(doc), `zod: ${label}`).toBe(valid);
  }
}

const LAUNCH_CASES: readonly Case[] = [
  ["the base document", LAUNCH, true],
  [
    "a command with no bundle",
    {
      ...set(set(LAUNCH, "entry", undefined), "bundle", undefined),
      command: ["tool", "--in", "/data"],
    },
    true,
  ],
  ["a command with a bundle", { ...set(LAUNCH, "entry", undefined), command: ["tool"] }, true],
  ["runtime image", set(LAUNCH, "runtime", "image"), true],
  ["no datasets", set(LAUNCH, "datasets", []), true],
  ["no args", set(LAUNCH, "args", []), true],
  ["no env", set(LAUNCH, "env", {}), true],
  [
    "an include pattern",
    set(LAUNCH, "datasets", [{ id: "nm000104", version: "1.0.2", include: ["sub-01/**/*.set"] }]),
    true,
  ],
  ["gpus 4", set(LAUNCH, "resources.gpus", 4), true],
  ["http api_base", set(LAUNCH, "api_base", "http://127.0.0.1:8787"), true],
  ["api_base with a path", set(LAUNCH, "api_base", "https://api.example.test/nemar"), true],
  ["a hex job token", set(LAUNCH, "job_token", "ab".repeat(32)), true],
  ["a nested entry", set(LAUNCH, "entry", "src/analysis/run.py"), true],
  ["an entry of 240 characters", set(LAUNCH, "entry", `${"a".repeat(237)}.py`), true],
  ["a sif in a directory", set(LAUNCH, "image.sif", "images/runtime-1.2.sif"), true],

  ["an unknown top-level key", { ...LAUNCH, upload: {} }, false],
  // A trailing newline is the one input `$` lets Python's `re` accept and JavaScript's refuse; the
  // schema ends its patterns with `(?![\s\S])` so every engine agrees.
  ["an entry with a trailing newline", set(LAUNCH, "entry", "run.py\n"), false],
  ["an env value with a trailing newline", set(LAUNCH, "env", { OMP_NUM_THREADS: "4\n" }), false],
  ["a job token with a trailing newline", set(LAUNCH, "job_token", `${"t".repeat(43)}\n`), false],
  ["a job id with a trailing newline", set(LAUNCH, "job_id", `${JOB_ID}\n`), false],
  ["a bundle digest with a trailing newline", set(LAUNCH, "bundle.sha256", `${HEX_A}\n`), false],
  [
    "an api_base with a trailing newline",
    set(LAUNCH, "api_base", "https://api.example.test\n"),
    false,
  ],
  [
    "a dataset id with a trailing newline",
    set(LAUNCH, "datasets", [{ id: "nm000104\n", version: "1" }]),
    false,
  ],
  ["a sif with a trailing newline", set(LAUNCH, "image.sif", "runtime.sif\n"), false],
  ["a bundle url", set(LAUNCH, "bundle.url", "https://x.test/b.tar.gz"), false],
  ["an unknown image key", set(LAUNCH, "image.extra", 1), false],
  ["an unknown limits key", set(LAUNCH, "limits.extra", 1), false],
  ["an unknown resources key", set(LAUNCH, "resources.cores", 4), false],
  [
    "an unknown dataset key",
    set(LAUNCH, "datasets", [{ id: "nm000104", version: "1", x: 1 }]),
    false,
  ],
  ["runtime matlab", set(LAUNCH, "runtime", "matlab"), false],
  ["runtime unknown", set(LAUNCH, "runtime", "julia"), false],
  ["both entry and command", { ...LAUNCH, command: ["tool"] }, false],
  ["neither entry nor command", set(set(LAUNCH, "entry", undefined), "bundle", undefined), false],
  ["an entry without a bundle", set(LAUNCH, "bundle", undefined), false],
  [
    "an empty command",
    { ...set(set(LAUNCH, "entry", undefined), "bundle", undefined), command: [] },
    false,
  ],
  ["an entry that climbs", set(LAUNCH, "entry", "../run.py"), false],
  ["an absolute entry", set(LAUNCH, "entry", "/run.py"), false],
  ["an entry with a backslash", set(LAUNCH, "entry", "a\\b.py"), false],
  ["an entry with a dot segment", set(LAUNCH, "entry", "a/./b.py"), false],
  ["an empty entry", set(LAUNCH, "entry", ""), false],
  ["an entry of 241 characters", set(LAUNCH, "entry", `${"a".repeat(238)}.py`), false],
  ["a sif with a space", set(LAUNCH, "image.sif", "runtime image.sif"), false],
  ["a sif with a backslash", set(LAUNCH, "image.sif", "a\\b.sif"), false],
  ["an empty sif", set(LAUNCH, "image.sif", ""), false],
  ["a sif of 257 characters", set(LAUNCH, "image.sif", "s".repeat(257)), false],
  ["a bundle digest in capitals", set(LAUNCH, "bundle.sha256", "A".repeat(64)), false],
  ["a short bundle digest", set(LAUNCH, "bundle.sha256", "a".repeat(63)), false],
  ["a zero-size bundle", set(LAUNCH, "bundle.size", 0), false],
  ["a fractional bundle size", set(LAUNCH, "bundle.size", 1.5), false],
  ["a job id with no prefix", set(LAUNCH, "job_id", "0123456789abcdef01234567"), false],
  ["a job id with capitals", set(LAUNCH, "job_id", "job_0123456789ABCDEF01234567"), false],
  ["an env name off the allowlist", set(LAUNCH, "env", { LD_PRELOAD: "x" }), false],
  ["an env name in lower case", set(LAUNCH, "env", { omp_num_threads: "4" }), false],
  ["an env value with a newline", set(LAUNCH, "env", { OMP_NUM_THREADS: "4\n5" }), false],
  [
    "an env value of 257 characters",
    set(LAUNCH, "env", { OMP_NUM_THREADS: "x".repeat(257) }),
    false,
  ],
  ["an env value that is a number", set(LAUNCH, "env", { OMP_NUM_THREADS: 4 }), false],
  ["negative gpus", set(LAUNCH, "resources.gpus", -1), false],
  ["fractional gpus", set(LAUNCH, "resources.gpus", 1.5), false],
  ["too many gpus", set(LAUNCH, "resources.gpus", 9), false],
  ["zero max_files", set(LAUNCH, "limits.max_files", 0), false],
  ["zero max_total_bytes", set(LAUNCH, "limits.max_total_bytes", 0), false],
  ["no limits", set(LAUNCH, "limits", undefined), false],
  ["no job token", set(LAUNCH, "job_token", undefined), false],
  ["a short job token", set(LAUNCH, "job_token", "short"), false],
  [
    "a job token with a space",
    set(LAUNCH, "job_token", `${"t".repeat(20)} ${"t".repeat(20)}`),
    false,
  ],
  ["an api_base that is not http", set(LAUNCH, "api_base", "ftp://api.example.test"), false],
  ["an api_base with a query", set(LAUNCH, "api_base", "https://api.example.test/?a=1"), false],
  ["an api_base with a space", set(LAUNCH, "api_base", "https://api.example.test/a b"), false],
  ["no api_base", set(LAUNCH, "api_base", undefined), false],
  ["no image", set(LAUNCH, "image", undefined), false],
  ["an unpinned image digest", set(LAUNCH, "image.digest", HEX_B), false],
  ["an image uri with a space", set(LAUNCH, "image.uri", "docker://a b"), false],
  [
    "an image uri with no prefix",
    set(
      LAUNCH,
      "image.uri",
      "ghcr.io/example/runtime@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ),
    true,
  ],
  [
    "an image uri with a port",
    set(
      LAUNCH,
      "image.uri",
      "registry.example.test:5000/team/tool@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ),
    true,
  ],
  [
    "an image uri with a dotted, dashed path",
    set(
      LAUNCH,
      "image.uri",
      "docker://ghcr.io/a-b/c_d.e@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ),
    true,
  ],
  [
    "an image uri with a leading dash",
    set(
      LAUNCH,
      "image.uri",
      "-docker://ghcr.io/example/runtime@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ),
    false,
  ],
  ["an image uri that is an option", set(LAUNCH, "image.uri", "--rm"), false],
  [
    "an image uri with a leading dash in the host",
    set(
      LAUNCH,
      "image.uri",
      "docker://-ghcr.io/example/runtime@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ),
    false,
  ],
  [
    "an image uri with a tag and no digest",
    set(LAUNCH, "image.uri", "docker://ghcr.io/example/runtime:latest"),
    false,
  ],
  [
    "an image uri with no digest",
    set(LAUNCH, "image.uri", "docker://ghcr.io/example/runtime"),
    false,
  ],
  [
    "an image uri with a short digest",
    set(
      LAUNCH,
      "image.uri",
      "docker://ghcr.io/example/runtime@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ),
    false,
  ],
  [
    "an image uri with a capital in the path",
    set(LAUNCH, "image.uri", `docker://ghcr.io/Example/runtime@sha256:${"b".repeat(64)}`),
    false,
  ],
  [
    "an image uri in capitals",
    set(
      LAUNCH,
      "image.uri",
      "docker://GHCR.io/example/runtime@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ),
    false,
  ],
  [
    "an image uri with a control character",
    set(
      LAUNCH,
      "image.uri",
      "docker://ghcr.io/exam\u0001ple/runtime@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ),
    false,
  ],
  [
    "an image uri with a newline in it",
    set(
      LAUNCH,
      "image.uri",
      "docker://ghcr.io/exam\nple/runtime@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ),
    false,
  ],
  [
    "an image uri with a trailing newline",
    set(
      LAUNCH,
      "image.uri",
      "docker://ghcr.io/example/runtime@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n",
    ),
    false,
  ],
  [
    "an image uri that is only a host",
    set(
      LAUNCH,
      "image.uri",
      "ghcr.io@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ),
    false,
  ],
  [
    "an image uri with a query",
    set(
      LAUNCH,
      "image.uri",
      "docker://ghcr.io/example/runtime?x=1@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ),
    false,
  ],
  [
    "a sif in a directory with dots and plus",
    set(LAUNCH, "image.sif", "images/rt-1.2+b.sif"),
    true,
  ],
  ["a sif that starts with a dot", set(LAUNCH, "image.sif", ".hidden.sif"), true],
  ["a sif that starts with a dash", set(LAUNCH, "image.sif", "-runtime.sif"), false],
  ["a sif that is only a dash", set(LAUNCH, "image.sif", "-"), false],
  ["a sif with a dash after the start", set(LAUNCH, "image.sif", "a-b.sif"), true],
  ["a sif in a directory that starts with a dash", set(LAUNCH, "image.sif", "dir/-x.sif"), true],
  ["an absolute sif", set(LAUNCH, "image.sif", "/opt/rt.sif"), false],
  ["a sif that climbs", set(LAUNCH, "image.sif", "../rt.sif"), false],
  ["a sif that climbs from inside", set(LAUNCH, "image.sif", "a/../rt.sif"), false],
  ["a sif that is a dot segment", set(LAUNCH, "image.sif", "a/./rt.sif"), false],
  ["a sif that is only two dots", set(LAUNCH, "image.sif", ".."), false],
  ["a sif with an empty segment", set(LAUNCH, "image.sif", "a//rt.sif"), false],
  ["a sif with a trailing slash", set(LAUNCH, "image.sif", "images/"), false],
  ["a sif with a control character", set(LAUNCH, "image.sif", "a\u0001b.sif"), false],
  ["a sif with a newline in it", set(LAUNCH, "image.sif", "a\nb.sif"), false],
  ["a sif with a DEL", set(LAUNCH, "image.sif", "a\u007fb.sif"), false],
  ["a sif with a backslash", set(LAUNCH, "image.sif", "a\\b.sif"), false],
  ["a sif with non-ASCII", set(LAUNCH, "image.sif", "caf\u00e9.sif"), false],
  ["no sif", set(LAUNCH, "image.sif", undefined), false],
  ["no args key", set(LAUNCH, "args", undefined), false],
  ["no datasets key", set(LAUNCH, "datasets", undefined), false],
  ["no env key", set(LAUNCH, "env", undefined), false],
  ["no resources key", set(LAUNCH, "resources", undefined), false],
  ["a dataset id in capitals", set(LAUNCH, "datasets", [{ id: "NM000104", version: "1" }]), false],
  ["a dataset with no version", set(LAUNCH, "datasets", [{ id: "nm000104" }]), false],
  [
    "an include that climbs",
    set(LAUNCH, "datasets", [{ id: "nm000104", version: "1", include: ["../x"] }]),
    false,
  ],
  [
    "an absolute include",
    set(LAUNCH, "datasets", [{ id: "nm000104", version: "1", include: ["/x"] }]),
    false,
  ],
  [
    "more than 20 datasets",
    set(
      LAUNCH,
      "datasets",
      Array.from({ length: 21 }, () => ({ id: "nm000104", version: "1" })),
    ),
    false,
  ],
  [
    "more than 64 args",
    set(
      LAUNCH,
      "args",
      Array.from({ length: 65 }, () => "a"),
    ),
    false,
  ],
  ["an arg over 1024 characters", set(LAUNCH, "args", ["x".repeat(1025)]), false],
  ["not an object", [LAUNCH], false],
  ["null", null, false],
];

describe("the launch specification", () => {
  test("the version is nemar.launch-spec.v1 and the runtimes are python and image", () => {
    expect(LAUNCH_SPEC_VERSION).toBe("nemar.launch-spec.v1");
    expect([...LAUNCH_RUNTIMES]).toEqual(["python", "image"]);
    expect(LAUNCH_SPEC_MAX_BYTES).toBe(64 * 1024);
    expect(LAUNCHER_ENV.SPEC).toBe("NEMAR_LAUNCH_SPEC");
  });

  test("zod and the JSON Schema give every document the same, expected, verdict", () => {
    agree(
      LAUNCH_CASES,
      (d) => validateRoot(d) as boolean,
      (d) => LaunchSpecSchema.safeParse(d).success,
    );
  });

  test("encodeLaunchSpec writes JSON the schema accepts, within 64 KiB", () => {
    const text = encodeLaunchSpec(LAUNCH);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(LAUNCH_SPEC_MAX_BYTES);
    expect(validateRoot(JSON.parse(text))).toBe(true);
    expect(LaunchSpecSchema.parse(JSON.parse(text)) as unknown).toEqual(LAUNCH);
  });

  test("encodeLaunchSpec refuses a document that is not valid", () => {
    expect(() => encodeLaunchSpec({ ...LAUNCH, upload: {} })).toThrow();
    expect(() => encodeLaunchSpec(set(LAUNCH, "runtime", "matlab"))).toThrow();
  });

  test("encodeLaunchSpec names the failing key and never echoes a value or the token", () => {
    const token = "SECRETTOKENVALUE0123456789";
    const bad = { ...set(LAUNCH, "runtime", "matlab"), job_token: token };
    let message = "";
    try {
      encodeLaunchSpec(bad);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("runtime");
    expect(message).not.toContain(token);
    expect(message).not.toContain("matlab");
  });

  test("encodeLaunchSpec writes ASCII-only JSON: every unit from U+007F up is a lowercase escape", () => {
    const tricky = [
      "caf\u00e9",
      "\u007f",
      "\u0080",
      "\u00ff",
      "\u2028\u2029",
      "\uffff",
      "\ud83d\ude00",
      "\ud800",
      'tab\there "quoted" back\\slash \u0001',
      "plain ~ tilde",
    ];
    const text = encodeLaunchSpec(set(LAUNCH, "args", tricky));
    expect(/^[\x20-\x7e]*$/.test(text)).toBe(true);
    // Lowercase hex, four digits, a surrogate pair as two escapes, DEL as an escape too.
    expect(text).toContain("caf\\u00e9");
    expect(text).toContain("\\u007f");
    expect(text).toContain("\\ud83d\\ude00");
    expect(text).toContain("\\u2028\\u2029");
    expect(text).toContain("\\uffff");
    expect(/\\u[0-9a-f]{0,3}[A-F]/.test(text)).toBe(false);
    // Nothing is lost: the text parses back to the same arguments.
    expect(JSON.parse(text).args).toEqual(tricky);
  });

  test("the 64 KiB cap is checked after escaping, because a non-ASCII character costs six bytes", () => {
    // 12 arguments of 1024 e-acute are about 12 K characters (24 KiB as UTF-8) and 72 KiB once
    // escaped. A check on the raw text would let it through.
    const wide = set(
      LAUNCH,
      "args",
      Array.from({ length: 12 }, () => "\u00e9".repeat(1024)),
    );
    expect(LaunchSpecSchema.safeParse(wide).success).toBe(true);
    expect(JSON.stringify(wide).length).toBeLessThan(LAUNCH_SPEC_MAX_BYTES);
    expect(() => encodeLaunchSpec(wide)).toThrow(RangeError);
    const plain = set(
      LAUNCH,
      "args",
      Array.from({ length: 12 }, () => "e".repeat(1024)),
    );
    expect(encodeLaunchSpec(plain).length).toBeLessThan(LAUNCH_SPEC_MAX_BYTES);
  });

  test("a document of exactly 65536 bytes is accepted and one byte more is refused", () => {
    const withTail = (m: number) =>
      set(LAUNCH, "args", [...Array.from({ length: 63 }, () => "x".repeat(1024)), "x".repeat(m)]);
    const m = LAUNCH_SPEC_MAX_BYTES - encodeLaunchSpec(withTail(0)).length;
    expect(m).toBeGreaterThan(0);
    expect(m).toBeLessThan(1024);
    expect(encodeLaunchSpec(withTail(m)).length).toBe(LAUNCH_SPEC_MAX_BYTES);
    expect(() => encodeLaunchSpec(withTail(m + 1))).toThrow(RangeError);
  });

  test("encodeLaunchSpec refuses a document over 64 KiB", () => {
    // 64 arguments of 1024 characters are 64 KiB before any other key is counted.
    const big = set(
      LAUNCH,
      "args",
      Array.from({ length: 64 }, () => "x".repeat(1024)),
    );
    expect(LaunchSpecSchema.safeParse(big).success).toBe(true);
    expect(() => encodeLaunchSpec(big)).toThrow(RangeError);
  });
});

describe("a valid job specification always fits the launch specification", () => {
  const E = "\u00e9";
  const baseJob = (extra: Record<string, unknown>) => ({ ...SPEC, ...extra });

  test("launchStringBytes is exactly what encodeLaunchSpec spends on a string", () => {
    const empty = encodeLaunchSpec(set(LAUNCH, "args", [])).length;
    const strings = [
      "",
      "plain",
      '"',
      "\\",
      "\b\t\n\f\r",
      "\u0000\u0001\u001f",
      "\u007f",
      E,
      "\u{1F600}",
      "\ud800",
      "\udc00",
      `a${E}"\\\n~`,
      E.repeat(50),
    ];
    for (let c = 0; c < 0x100; c++) strings.push(String.fromCharCode(c));
    for (const text of strings) {
      const spent = encodeLaunchSpec(set(LAUNCH, "args", [text])).length - empty;
      expect(launchStringBytes(text), JSON.stringify(text)).toBe(spent);
    }
  });

  test("launchVariableBytes counts the entry, command, arguments, patterns and environment", () => {
    expect(launchVariableBytes({})).toBe(0);
    expect(launchVariableBytes({ entry: "run.py" })).toBe(8 + 1);
    expect(launchVariableBytes({ command: ["a", "bc"] })).toBe(3 + 1 + 4 + 1);
    expect(launchVariableBytes({ args: ["x"] })).toBe(3 + 1);
    expect(
      launchVariableBytes({ datasets: [{ include: ["a/*"] }, {}, { include: ["b", "c"] }] }),
    ).toBe(5 + 1 + 3 + 1 + 3 + 1);
    expect(launchVariableBytes({ env: { OMP_NUM_THREADS: "4", MPLBACKEND: undefined } })).toBe(
      17 + 3 + 2,
    );
    expect(launchVariableBytes({ args: [E] })).toBe(2 + 6 + 1);
  });

  test("the bound sits exactly at 48 KiB: one byte over is refused with an issue on the document", () => {
    expect(LAUNCH_VARIABLE_BYTES_MAX).toBe(49_152);
    const full = Array.from({ length: 47 }, () => "x".repeat(1024));
    const tailFor = (bytes: number) => {
      const used = launchVariableBytes({ entry: "run.py", args: full });
      return "x".repeat(bytes - used - 3);
    };
    const at = baseJob({ args: [...full, tailFor(LAUNCH_VARIABLE_BYTES_MAX)] });
    expect(launchVariableBytes(at as never)).toBe(LAUNCH_VARIABLE_BYTES_MAX);
    expect(JobSpecSchema.safeParse(at).success).toBe(true);
    const over = baseJob({ args: [...full, tailFor(LAUNCH_VARIABLE_BYTES_MAX + 1)] });
    expect(launchVariableBytes(over as never)).toBe(LAUNCH_VARIABLE_BYTES_MAX + 1);
    const refused = JobSpecSchema.safeParse(over);
    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.error.issues).toHaveLength(1);
      expect(refused.error.issues[0].path).toEqual([]);
      expect(refused.error.issues[0].message).not.toContain("xxxx");
    }
  });

  test("an escape-heavy specification is over the bound long before it is long", () => {
    // 6000 characters of e-acute are 36 KB; 9000 are 54 KB and are refused, though under 10 KB raw.
    const some = Array.from({ length: 6 }, () => E.repeat(1000));
    expect(specRefused(baseJob({ args: some }))).toBe(false);
    const more = Array.from({ length: 9 }, () => E.repeat(1000));
    expect(specRefused(baseJob({ args: more }))).toBe(true);
    // The same 9000 plain characters are well inside it.
    expect(specRefused(baseJob({ args: Array.from({ length: 9 }, () => "e".repeat(1000)) }))).toBe(
      false,
    );
  });

  /** The largest n for which build(n) is a valid job specification, by bisection. */
  function largest(
    build: (n: number) => Record<string, unknown>,
    hi: number,
  ): Record<string, unknown> {
    let lo = 0;
    let top = hi;
    if (JobSpecSchema.safeParse(build(top)).success) return build(top);
    while (top - lo > 1) {
      const mid = Math.floor((lo + top) / 2);
      if (JobSpecSchema.safeParse(build(mid)).success) lo = mid;
      else top = mid;
    }
    return build(lo);
  }
  /** n e-acute characters over elements of at most `per` characters. */
  const spread = (n: number, per: number): string[] => {
    const out: string[] = [];
    for (let left = n; left > 0; left -= per) out.push(E.repeat(Math.min(per, left)));
    return out;
  };

  /** What a Worker would send, at its worst, written here apart from launchSpecFits. */
  function workerWorstDoc(job: JobSpec): Record<string, unknown> {
    const hex = "f".repeat(64);
    const ref = `docker://ghcr.io/${"a".repeat(423)}@sha256:${hex}`;
    expect(ref.length).toBe(512);
    return {
      job_id: `job_${"f".repeat(24)}`,
      runtime: job.runtime === "image" ? "image" : "python",
      ...(job.entry !== undefined ? { entry: job.entry } : { command: job.command ?? ["x"] }),
      args: job.args,
      bundle: { sha256: hex, size: Number.MAX_SAFE_INTEGER },
      datasets: job.datasets.map((d) => ({ ...d })),
      api_base: `https://${"a".repeat(504)}`,
      image: { uri: ref, digest: `sha256:${hex}`, sif: "s".repeat(256) },
      env: job.env,
      resources: { gpus: job.gpus },
      limits: { max_files: 1_000_000, max_total_bytes: Number.MAX_SAFE_INTEGER },
      job_token: "t".repeat(256),
    };
  }
  const workerWorstCase = (job: JobSpec): string => encodeLaunchSpec(workerWorstDoc(job));

  const twentyDatasets = Array.from({ length: 20 }, (_, i) => ({
    id: `nm0001${String(i).padStart(2, "0")}`,
    version: `v${"9".repeat(63)}`,
  }));
  const imageRef = `docker://ghcr.io/${"a".repeat(423)}@sha256:${"b".repeat(64)}`;

  const WORST: Array<[string, Record<string, unknown>]> = [
    [
      "the arguments, full of e-acute",
      largest((n) => baseJob({ args: spread(n, 1024) }), 64 * 1024),
    ],
    [
      "the arguments, full of quotes",
      largest(
        (n) =>
          baseJob({
            args: Array.from({ length: Math.ceil(n / 1024) }, () => '"'.repeat(1024)).slice(0, 64),
          }),
        64 * 1024,
      ),
    ],
    [
      "the command of an image job",
      largest(
        (n) => ({
          name: "tool",
          runtime: "image",
          image: imageRef,
          command: spread(n, 1024).slice(0, 64),
          partition: "shared",
          minutes: 30,
        }),
        64 * 1024,
      ),
    ],
    [
      "the include patterns of twenty datasets",
      largest(
        (n) =>
          baseJob({
            datasets: twentyDatasets.map((d, i) => ({
              ...d,
              include: i === 0 ? spread(n, 256).slice(0, 64) : [],
            })),
          }),
        64 * 256,
      ),
    ],
    [
      "twenty datasets, every one with a full set of patterns",
      largest(
        (n) =>
          baseJob({
            datasets: twentyDatasets.map((d) => ({ ...d, include: spread(n, 256).slice(0, 64) })),
          }),
        64 * 256,
      ),
    ],
    ["the entry", baseJob({ entry: E.repeat(240), datasets: twentyDatasets })],
    [
      "every environment value, of quotes",
      baseJob({
        datasets: twentyDatasets,
        env: Object.fromEntries(JOB_ENV_ALLOWLIST.map((k) => [k, '"'.repeat(256)])),
      }),
    ],
    [
      "a bit of everything at once",
      largest(
        (n) =>
          baseJob({
            entry: E.repeat(240),
            datasets: twentyDatasets.map((d, i) => ({
              ...d,
              include: i < 3 ? spread(n, 256).slice(0, 64) : [],
            })),
            args: spread(n, 1024).slice(0, 64),
            env: Object.fromEntries(JOB_ENV_ALLOWLIST.map((k) => [k, '"'.repeat(256)])),
          }),
        64 * 256,
      ),
    ],
  ];

  test("each worst-case valid specification fits, with a kilobyte to spare", () => {
    expect(WORST.length).toBe(8);
    for (const [label, doc] of WORST) {
      const parsed = JobSpecSchema.parse(doc);
      expect(launchVariableBytes(parsed), label).toBeLessThanOrEqual(LAUNCH_VARIABLE_BYTES_MAX);
      expect(launchSpecFits(parsed), label).toBe(true);
      const size = workerWorstCase(parsed).length;
      expect(size, label).toBeLessThanOrEqual(LAUNCH_SPEC_MAX_BYTES - 1024);
    }
  });

  test("the bisected ones really are at the edge, so the worst case is the worst case", () => {
    for (const [label, doc] of WORST) {
      if (!label.includes("full of") && !label.includes("command") && !label.includes("patterns"))
        continue;
      const parsed = JobSpecSchema.parse(doc);
      expect(launchVariableBytes(parsed), label).toBeGreaterThan(LAUNCH_VARIABLE_BYTES_MAX - 6200);
    }
  });

  test("launchSpecFits is false for a specification that skipped the schema and is too large", () => {
    const parsed = JobSpecSchema.parse(SPEC);
    expect(launchSpecFits(parsed)).toBe(true);
    const big = { ...parsed, args: Array.from({ length: 64 }, () => "x".repeat(1024)) };
    expect(launchSpecFits(big)).toBe(false);
    const wide = { ...parsed, args: Array.from({ length: 12 }, () => E.repeat(1024)) };
    expect(launchSpecFits(wide)).toBe(false);
    // Anything the launch specification would refuse is also a no.
    expect(launchSpecFits({ ...parsed, gpus: 99 })).toBe(false);
    expect(launchSpecFits({ ...parsed, entry: "../x" })).toBe(false);
  });

  test("launchSpecFits takes every Worker field at its worst case, and counts every job field", () => {
    // A specification that carries something in every field launchSpecFits has to read.
    const job = JobSpecSchema.parse({
      ...SPEC,
      entry: "analysis/main_pipeline_with_a_long_name.py",
      env: { OMP_NUM_THREADS: "4" },
      datasets: [{ id: "nm000104", version: "1.0.2", include: ["sub-01/**/*.set", "sub-02/*"] }],
    });
    /** The same document with small Worker fields, as LAUNCH has them. */
    const smallDoc = (j: JobSpec): Record<string, unknown> => ({
      job_id: JOB_ID,
      runtime: "python",
      entry: j.entry,
      args: j.args,
      bundle: { sha256: HEX_A, size: 1234 },
      datasets: j.datasets.map((d) => ({ ...d })),
      api_base: "https://api.example.test",
      image: {
        uri: `docker://ghcr.io/example/runtime@sha256:${HEX_B}`,
        digest: `sha256:${HEX_B}`,
        sif: "runtime.sif",
      },
      env: j.env,
      resources: { gpus: j.gpus },
      limits: { max_files: 38000, max_total_bytes: 1073741824 },
      job_token: "t".repeat(43),
    });
    // What the Worker's own fields add when they are at their worst: the 512-character api_base and
    // image reference, the 256-character sif and token, the largest bundle and limits.
    const plainLength = (doc: Record<string, unknown>) => JSON.stringify(doc).length; // ASCII only
    const smallWorker = (j: JobSpec) => ({ length: plainLength(smallDoc(j)) });
    const extra = workerWorstCase(job).length - smallWorker(job).length;
    expect(extra).toBeGreaterThan(1000);
    // Arguments no valid specification may carry, sized so the small document is 20 bytes inside
    // the cap and the worst-case one 20 bytes over it. Dropping ANY one field of the Worker's, or
    // of the job's, from launchSpecFits' document would make it fit, so each must be there.
    const target = LAUNCH_SPEC_MAX_BYTES - extra + 20;
    let args: string[] | null = null;
    for (let n = 0; n <= 63 && args === null; n++) {
      const full = Array.from({ length: n }, () => "x".repeat(1024));
      const tail = target - smallWorker({ ...job, args: [...full, ""] }).length;
      if (tail >= 0 && tail <= 1024) args = [...full, "x".repeat(tail)];
    }
    if (args === null) throw new Error("no arguments reach the target");
    expect(smallWorker({ ...job, args }).length).toBe(target);
    expect(plainLength(workerWorstDoc({ ...job, args }))).toBe(LAUNCH_SPEC_MAX_BYTES + 20);
    expect(launchSpecFits({ ...job, args })).toBe(false);
    // And 21 bytes fewer, it fits.
    const lessTail = args.slice(0, -1).concat("x".repeat(args[args.length - 1].length - 21));
    expect(workerWorstCase({ ...job, args: lessTail }).length).toBe(LAUNCH_SPEC_MAX_BYTES - 1);
    expect(launchSpecFits({ ...job, args: lessTail })).toBe(true);
  });

  test("launchSpecFits copes with every shape of job: entry, command, recipe, matlab and image", () => {
    const hex = "b".repeat(64);
    const jobs = [
      SPEC,
      {
        name: "t",
        runtime: "image",
        image: `ghcr.io/e/t@sha256:${hex}`,
        command: ["t"],
        partition: "shared",
        minutes: 5,
      },
      {
        name: "r",
        runtime: "python",
        recipe: "nemar-floor",
        datasets: [{ id: "nm000104", version: "1" }],
        partition: "shared",
        minutes: 5,
      },
      { ...SPEC, runtime: "matlab" },
    ];
    for (const job of jobs)
      expect(launchSpecFits(JobSpecSchema.parse(job)), String(job.runtime)).toBe(true);
  });
});

describe("the golden vector nemar-process checks its launcher against", () => {
  // One fixed launch specification with a non-ASCII character, a double quote and a space in its
  // arguments, the exact text encodeLaunchSpec writes for it and the SHA-256 of that text, all as
  // literals. The launcher hashes the raw bytes of NEMAR_LAUNCH_SPEC before it parses them, so it
  // must report GOLDEN_SHA256 for GOLDEN_TEXT and parse the text back to GOLDEN_SPEC.
  const GOLDEN_SPEC = {
    job_id: "job_0123456789abcdef01234567",
    runtime: "python",
    entry: "run.py",
    args: ["--label", 'caf\u00e9 "q" \u{1F600}'],
    bundle: { sha256: "a".repeat(64), size: 1234 },
    datasets: [{ id: "nm000104", version: "1.0.2" }],
    api_base: "https://api.example.test",
    image: {
      uri: `docker://ghcr.io/example/runtime@sha256:${"b".repeat(64)}`,
      digest: `sha256:${"b".repeat(64)}`,
      sif: "runtime.sif",
    },
    env: { OMP_NUM_THREADS: "4" },
    resources: { gpus: 0 },
    limits: { max_files: 38000, max_total_bytes: 1073741824 },
    job_token: "t".repeat(43),
  };
  const GOLDEN_TEXT = String.raw`{"job_id":"job_0123456789abcdef01234567","runtime":"python","entry":"run.py","args":["--label","caf\u00e9 \"q\" \ud83d\ude00"],"bundle":{"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":1234},"datasets":[{"id":"nm000104","version":"1.0.2"}],"api_base":"https://api.example.test","image":{"uri":"docker://ghcr.io/example/runtime@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","sif":"runtime.sif"},"env":{"OMP_NUM_THREADS":"4"},"resources":{"gpus":0},"limits":{"max_files":38000,"max_total_bytes":1073741824},"job_token":"ttttttttttttttttttttttttttttttttttttttttttt"}`;
  const GOLDEN_SHA256 = "68ef4653b8745eebf16427cd87a01e6d672b8062f8bfef819fcd1d745f0e346a";

  test("encodeLaunchSpec writes exactly the golden text", () => {
    expect(encodeLaunchSpec(GOLDEN_SPEC)).toBe(GOLDEN_TEXT);
    expect(GOLDEN_TEXT.length).toBe(708);
  });

  test("the golden text hashes to the golden digest, and parses back to the specification", () => {
    expect(createHash("sha256").update(GOLDEN_TEXT, "ascii").digest("hex")).toBe(GOLDEN_SHA256);
    expect(JSON.parse(GOLDEN_TEXT)).toEqual(GOLDEN_SPEC);
    expect(/^[\x20-\x7e]*$/.test(GOLDEN_TEXT)).toBe(true);
    expect(validateRoot(JSON.parse(GOLDEN_TEXT))).toBe(true);
  });

  test("the text carries the three awkward characters as the schema says", () => {
    expect(GOLDEN_TEXT).toContain(String.raw`caf\u00e9 \"q\" \ud83d\ude00`);
  });
});

describe("the results bucket layout", () => {
  test("outputs and launcher files live under jobs/<id>/", () => {
    expect(resultsOutputKey(JOB_ID, "a/b.txt")).toBe(`jobs/${JOB_ID}/outputs/a/b.txt`);
    for (const name of LAUNCHER_FILE_NAMES) {
      expect(resultsLauncherKey(JOB_ID, name)).toBe(`jobs/${JOB_ID}/launcher/${name}`);
    }
  });

  test("a key is never built from a path that escapes or a job id that is not one", () => {
    expect(() => resultsOutputKey(JOB_ID, "../x")).toThrow();
    expect(() => resultsOutputKey(JOB_ID, "/x")).toThrow();
    expect(() => resultsOutputKey("job_x", "a")).toThrow();
    expect(() => resultsOutputKey("../job_0123456789abcdef01234567", "a")).toThrow();
    expect(() => resultsLauncherKey(JOB_ID, "other.json" as "result.json")).toThrow();
    expect(() => resultsLauncherKey("nope", "result.json")).toThrow();
  });
});

describe("the route shapes in the schema's $defs", () => {
  const BUNDLE_CASES: readonly Case[] = [
    [
      "a bundle response",
      { url: "https://r2.example.test/b?X-Sig=1", expires_at: "2026-11-03T12:00:00Z" },
      true,
    ],
    [
      "fractional seconds",
      { url: "https://r2.example.test/b", expires_at: "2026-11-03T12:00:00.250Z" },
      true,
    ],
    ["no url", { expires_at: "2026-11-03T12:00:00Z" }, false],
    ["no expiry", { url: "https://r2.example.test/b" }, false],
    [
      "a url that is not http",
      { url: "file:///etc/passwd", expires_at: "2026-11-03T12:00:00Z" },
      false,
    ],
    [
      "an expiry that is not UTC",
      { url: "https://r2.example.test/b", expires_at: "2026-11-03T12:00:00+01:00" },
      false,
    ],
    [
      "an expiry that is a date",
      { url: "https://r2.example.test/b", expires_at: "2026-11-03" },
      false,
    ],
    // A response is open: a launcher that runs for 48 hours must survive the Worker adding a key.
    [
      "an extra key",
      { url: "https://r2.example.test/b", expires_at: "2026-11-03T12:00:00Z", x: 1 },
      true,
    ],
    [
      "an extra key of any shape",
      {
        url: "https://r2.example.test/b",
        expires_at: "2026-11-03T12:00:00Z",
        retry_after: { seconds: 5 },
        notes: ["a"],
      },
      true,
    ],
  ];

  const LAUNCHER_LIST = LAUNCHER_FILE_NAMES.map((name) => ({ name, size: 10 }));
  const OUTPUTS_REQUEST = {
    outputs: [{ path: "a/b.txt", size: 3, sha256: HEX_A }],
    launcher: LAUNCHER_LIST,
  };
  const REQUEST_CASES: readonly Case[] = [
    ["an outputs request", OUTPUTS_REQUEST, true],
    ["no outputs", { ...OUTPUTS_REQUEST, outputs: [] }, true],
    [
      "an output that climbs",
      set(OUTPUTS_REQUEST, "outputs", [{ path: "../a", size: 1, sha256: HEX_A }]),
      false,
    ],
    [
      "an absolute output",
      set(OUTPUTS_REQUEST, "outputs", [{ path: "/a", size: 1, sha256: HEX_A }]),
      false,
    ],
    [
      "a negative size",
      set(OUTPUTS_REQUEST, "outputs", [{ path: "a", size: -1, sha256: HEX_A }]),
      false,
    ],
    [
      "a bad digest",
      set(OUTPUTS_REQUEST, "outputs", [{ path: "a", size: 1, sha256: "Z".repeat(64) }]),
      false,
    ],
    ["an output key left out", set(OUTPUTS_REQUEST, "outputs", [{ path: "a", size: 1 }]), false],
    ["three launcher files", { ...OUTPUTS_REQUEST, launcher: LAUNCHER_LIST.slice(0, 3) }, false],
    [
      "a repeated launcher file",
      { ...OUTPUTS_REQUEST, launcher: [...LAUNCHER_LIST.slice(0, 3), LAUNCHER_LIST[0]] },
      false,
    ],
    // Four entries that leave out exactly one of the four names, whichever it is.
    ...LAUNCHER_LIST.map(
      (left, i): Case => [
        `four launcher entries that leave out ${left.name}`,
        {
          ...OUTPUTS_REQUEST,
          launcher: LAUNCHER_LIST.filter((_, j) => j !== i).concat(LAUNCHER_LIST[(i + 1) % 4]),
        },
        false,
      ],
    ),
    [
      "the four launcher files in another order",
      { ...OUTPUTS_REQUEST, launcher: [...LAUNCHER_LIST].reverse() },
      true,
    ],
    [
      "an unknown launcher file",
      {
        ...OUTPUTS_REQUEST,
        launcher: [...LAUNCHER_LIST.slice(0, 3), { name: "other.json", size: 1 }],
      },
      false,
    ],
    [
      "a negative launcher size",
      {
        ...OUTPUTS_REQUEST,
        launcher: [...LAUNCHER_LIST.slice(0, 3), { name: "launcher.log", size: -1 }],
      },
      false,
    ],
    ["no launcher list", { outputs: [] }, false],
    ["an extra key", { ...OUTPUTS_REQUEST, extra: 1 }, false],
    [
      "five launcher files, one repeated",
      { ...OUTPUTS_REQUEST, launcher: [...LAUNCHER_LIST, LAUNCHER_LIST[0]] },
      false,
    ],
    [
      "100000 outputs",
      {
        ...OUTPUTS_REQUEST,
        outputs: Array.from({ length: 100_000 }, () => ({ path: "f", size: 1, sha256: HEX_A })),
      },
      true,
    ],
    [
      "100001 outputs",
      {
        ...OUTPUTS_REQUEST,
        outputs: Array.from({ length: 100_001 }, () => ({ path: "f", size: 1, sha256: HEX_A })),
      },
      false,
    ],
  ];

  const RESPONSE_CASES: readonly Case[] = [
    [
      "an outputs response",
      {
        uploads: [
          { path: "outputs/a/b.txt", url: "https://r2.example.test/o" },
          { path: "launcher/result.json", url: "https://r2.example.test/r" },
          { path: "launcher/launcher.log", url: "https://r2.example.test/l" },
        ],
        expires_at: "2026-11-03T13:00:00Z",
      },
      true,
    ],
    ["no uploads", { uploads: [], expires_at: "2026-11-03T13:00:00Z" }, true],
    [
      "an extra key at the top",
      { uploads: [], expires_at: "2026-11-03T13:00:00Z", request_id: "r1" },
      true,
    ],
    [
      "an extra key in an upload",
      {
        uploads: [{ path: "outputs/a", url: "https://r2.example.test/o", headers: { a: "b" } }],
        expires_at: "2026-11-03T13:00:00Z",
      },
      true,
    ],
    [
      "an upload that lacks a required key, whatever else it has",
      { uploads: [{ path: "outputs/a", note: 1 }], expires_at: "2026-11-03T13:00:00Z" },
      false,
    ],
    [
      "a path under neither directory",
      {
        uploads: [{ path: "other/a", url: "https://r2.example.test/o" }],
        expires_at: "2026-11-03T13:00:00Z",
      },
      false,
    ],
    [
      "a path that climbs",
      {
        uploads: [{ path: "outputs/../a", url: "https://r2.example.test/o" }],
        expires_at: "2026-11-03T13:00:00Z",
      },
      false,
    ],
    ...[
      ["a control character in an output path", "outputs/a\u0001b"],
      ["a newline in an output path", "outputs/a\nb"],
      ["a DEL in an output path", "outputs/a\u007fb"],
      ["a backslash in an output path", "outputs/a\\b"],
      ["a trailing newline on an output path", "outputs/a\n"],
      ["an empty segment in an output path", "outputs/a//b"],
      ["a dot segment in an output path", "outputs/a/./b"],
      ["a trailing slash on an output path", "outputs/a/"],
      ["no file after outputs/", "outputs/"],
      ["a control character in a launcher path", "launcher/res\u0000ult.json"],
      ["a trailing newline on a launcher path", "launcher/result.json\n"],
      ["a launcher file in a sub-directory", "launcher/sub/result.json"],
      ["a launcher file with a different dot", "launcher/resultxjson"],
    ].map(
      ([label, path]): Case => [
        label,
        {
          uploads: [{ path, url: "https://r2.example.test/o" }],
          expires_at: "2026-11-03T13:00:00Z",
        },
        false,
      ],
    ),
    [
      "a non-ASCII output path",
      {
        uploads: [{ path: "outputs/caf\u00e9/a", url: "https://r2.example.test/o" }],
        expires_at: "2026-11-03T13:00:00Z",
      },
      true,
    ],
    [
      "a dotted file name that is not a dot segment",
      {
        uploads: [{ path: "outputs/..a/b..", url: "https://r2.example.test/o" }],
        expires_at: "2026-11-03T13:00:00Z",
      },
      true,
    ],
    [
      "an unknown launcher file",
      {
        uploads: [{ path: "launcher/other.json", url: "https://r2.example.test/o" }],
        expires_at: "2026-11-03T13:00:00Z",
      },
      false,
    ],
    [
      "a url that is not http",
      { uploads: [{ path: "outputs/a", url: "gopher://x" }], expires_at: "2026-11-03T13:00:00Z" },
      false,
    ],
    ["no expiry", { uploads: [] }, false],
  ];

  test("the bundle response", () => {
    agree(
      BUNDLE_CASES,
      (d) => defValidator("bundle_response")(d) as boolean,
      (d) => BundleResponseSchema.safeParse(d).success,
    );
  });

  test("the outputs request", () => {
    agree(
      REQUEST_CASES,
      (d) => defValidator("outputs_request")(d) as boolean,
      (d) => OutputsRequestSchema.safeParse(d).success,
    );
  });

  test("the outputs response", () => {
    agree(
      RESPONSE_CASES,
      (d) => defValidator("outputs_response")(d) as boolean,
      (d) => OutputsResponseSchema.safeParse(d).success,
    );
  });
});

describe("the launcher's own documents in the schema's $defs", () => {
  const RESULT_OK = {
    job_id: JOB_ID,
    failure_code: null,
    detail: null,
    exit_number: 0,
    entry_exit_code: 0,
  };
  const RESULT_CASES: Case[] = [
    ["success", RESULT_OK, true],
    [
      "a runtime error with the entry's own exit code",
      { ...RESULT_OK, failure_code: "runtime_error", exit_number: 13, entry_exit_code: 3 },
      true,
    ],
    [
      "a code with a detail",
      { ...RESULT_OK, failure_code: "runtime_error", detail: "terminated", exit_number: 13 },
      true,
    ],
    ["a success that exits 10", { ...RESULT_OK, exit_number: 10 }, false],
    ["a failure that exits 0", { ...RESULT_OK, failure_code: "time_limit" }, false],
    [
      "a code with another code's exit number",
      { ...RESULT_OK, failure_code: "time_limit", exit_number: 14 },
      false,
    ],
    [
      "a platform code the launcher never writes",
      { ...RESULT_OK, failure_code: "tapis_error", exit_number: 10 },
      false,
    ],
    ["a detail that is not a word", { ...RESULT_OK, detail: "Not A Word" }, false],
    ["an extra key", { ...RESULT_OK, extra: 1 }, false],
    ["the largest entry exit code", { ...RESULT_OK, entry_exit_code: 255 }, true],
    ["a signal-style entry exit code", { ...RESULT_OK, entry_exit_code: -9 }, true],
    ["an entry exit code of 256", { ...RESULT_OK, entry_exit_code: 256 }, false],
    ["an entry exit code of -256", { ...RESULT_OK, entry_exit_code: -256 }, false],
    ["a fractional entry exit code", { ...RESULT_OK, entry_exit_code: 1.5 }, false],
    [
      "a missing detail",
      { job_id: JOB_ID, failure_code: null, exit_number: 0, entry_exit_code: 0 },
      false,
    ],
  ];
  for (const [i, code] of LAUNCHER_FAILURE_CODES.entries()) {
    RESULT_CASES.push([
      `${code} exits ${10 + i}`,
      { ...RESULT_OK, failure_code: code, exit_number: 10 + i },
      true,
    ]);
    RESULT_CASES.push([
      `${code} does not exit ${10 + ((i + 1) % LAUNCHER_FAILURE_CODES.length)}`,
      {
        ...RESULT_OK,
        failure_code: code,
        exit_number: 10 + ((i + 1) % LAUNCHER_FAILURE_CODES.length),
      },
      false,
    ]);
  }

  const MANIFEST_CASES: readonly Case[] = [
    ["a manifest", { job_id: JOB_ID, files: [{ path: "a", size: 1, sha256: HEX_A }] }, true],
    ["an empty manifest", { job_id: JOB_ID, files: [] }, true],
    [
      "a path that climbs",
      { job_id: JOB_ID, files: [{ path: "../a", size: 1, sha256: HEX_A }] },
      false,
    ],
    ["no job id", { files: [] }, false],
    [
      "an extra file key",
      { job_id: JOB_ID, files: [{ path: "a", size: 1, sha256: HEX_A, x: 1 }] },
      false,
    ],
  ];

  const PROVENANCE = {
    job_id: JOB_ID,
    launch_spec_digest: HEX_A,
    bundle_digest: null,
    image: { uri: "docker://ghcr.io/example/runtime", digest: `sha256:${HEX_B}` },
    runtime_version: "3.12.3",
    staging: [{ id: "nm000104", version: "1.0.2", mode: "bind", files: 12, bytes: 3456 }],
    timings: { run: 600.25 },
    slurm_job_id: "1234567",
    entry_exit_code: 0,
  };
  const PROVENANCE_CASES: readonly Case[] = [
    ["provenance", PROVENANCE, true],
    ["a bundle digest", set(PROVENANCE, "bundle_digest", HEX_B), true],
    ["no slurm id", set(PROVENANCE, "slurm_job_id", null), true],
    ["no launch spec digest", set(PROVENANCE, "launch_spec_digest", undefined), false],
    ["a short launch spec digest", set(PROVENANCE, "launch_spec_digest", "abc"), false],
    ["an image digest with no algorithm", set(PROVENANCE, "image.digest", HEX_B), false],
    [
      "an unknown staging mode",
      set(PROVENANCE, "staging", [
        { id: "nm000104", version: "1", mode: "magic", files: 1, bytes: 1 },
      ]),
      false,
    ],
    ["a negative timing", set(PROVENANCE, "timings", { run: -1 }), false],
    [
      "16 phases",
      set(
        PROVENANCE,
        "timings",
        Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`phase_${i}`, 1])),
      ),
      true,
    ],
    [
      "17 phases",
      set(
        PROVENANCE,
        "timings",
        Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`phase_${i}`, 1])),
      ),
      false,
    ],
    ["a timing named with a space", set(PROVENANCE, "timings", { "a b": 1 }), false],
    ["an extra key", { ...PROVENANCE, extra: 1 }, false],
  ];

  test("result.json", () => {
    agree(
      RESULT_CASES,
      (d) => defValidator("result")(d) as boolean,
      (d) => LauncherResultSchema.safeParse(d).success,
    );
  });

  test("manifest.json", () => {
    agree(
      MANIFEST_CASES,
      (d) => defValidator("manifest")(d) as boolean,
      (d) => ResultManifestSchema.safeParse(d).success,
    );
  });

  test("provenance.json", () => {
    agree(
      PROVENANCE_CASES,
      (d) => defValidator("provenance")(d) as boolean,
      (d) => LauncherProvenanceSchema.safeParse(d).success,
    );
  });
});

// --- Every bound, from one table ---------------------------------------------------------------

type BoundTarget =
  | "root"
  | "bundle_response"
  | "outputs_request"
  | "outputs_response"
  | "result"
  | "manifest"
  | "provenance";

interface Bound {
  label: string;
  target: BoundTarget;
  /** A "max" is valid at `at` and invalid at `at + 1`; a "min" is valid at `at` and invalid at `at - 1`. */
  kind: "max" | "min";
  at: number;
  /** A document in which the quantity under test is `n` and everything else is valid. */
  build: (n: number) => unknown;
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const HASH = "a".repeat(64);
const TS = "2026-11-03T13:00:00Z";
const UPLOAD = { path: "outputs/a", url: "https://r2.example.test/o" };
const OUTPUT = { path: "a", size: 1, sha256: HASH };
const STAGING = { id: "nm000104", version: "1.0.2", mode: "bind", files: 1, bytes: 1 };
const REQUEST_BASE = {
  outputs: [OUTPUT],
  launcher: LAUNCHER_FILE_NAMES.map((name) => ({ name, size: 1 })),
};
const RESULT_BASE = {
  job_id: JOB_ID,
  failure_code: null,
  detail: null,
  exit_number: 0,
  entry_exit_code: 0,
};
const MANIFEST_BASE = { job_id: JOB_ID, files: [OUTPUT] };
const PROVENANCE_BASE = {
  job_id: JOB_ID,
  launch_spec_digest: HASH,
  bundle_digest: null,
  image: { uri: "docker://ghcr.io/example/runtime", digest: `sha256:${HASH}` },
  runtime_version: "3.12.3",
  staging: [STAGING],
  timings: { run: 1 },
  slurm_job_id: null,
  entry_exit_code: null,
};
/** A command-only launch specification: no entry and no bundle, so `command` can be varied. */
const COMMAND_BASE = {
  ...set(set(LAUNCH, "entry", undefined), "bundle", undefined),
  command: ["c"],
};
/** A digest-pinned image reference of exactly `n` characters. */
const imageRef = (n: number) => `docker://ghcr.io/${"a".repeat(n - 89)}@sha256:${HASH}`;

/**
 * The one table of every numeric and length bound in the launch schema, as literals. The corpus
 * below is generated from it and judged by Ajv (on the byte-shared JSON Schema) and by zod, so a
 * bound that drifts in either one, or in both, fails here on the very pair that straddles it.
 */
const MAIN_BOUNDS: readonly Bound[] = [
  // The launch specification
  {
    label: "entry length",
    target: "root",
    kind: "max",
    at: 240,
    build: (n) => set(LAUNCH, "entry", `${"a".repeat(n - 3)}.py`),
  },
  {
    label: "command items",
    target: "root",
    kind: "max",
    at: 64,
    build: (n) => ({ ...COMMAND_BASE, command: Array(n).fill("c") }),
  },
  {
    label: "command items, at least",
    target: "root",
    kind: "min",
    at: 1,
    build: (n) => ({ ...COMMAND_BASE, command: Array(n).fill("c") }),
  },
  {
    label: "command item length",
    target: "root",
    kind: "max",
    at: 1024,
    build: (n) => ({ ...COMMAND_BASE, command: ["c".repeat(n)] }),
  },
  {
    label: "command item length, at least",
    target: "root",
    kind: "min",
    at: 1,
    build: (n) => ({ ...COMMAND_BASE, command: ["c".repeat(n)] }),
  },
  {
    label: "arguments",
    target: "root",
    kind: "max",
    at: 64,
    build: (n) => set(LAUNCH, "args", Array(n).fill("a")),
  },
  {
    label: "argument length",
    target: "root",
    kind: "max",
    at: 1024,
    build: (n) => set(LAUNCH, "args", ["a".repeat(n)]),
  },
  {
    label: "datasets",
    target: "root",
    kind: "max",
    at: 20,
    build: (n) => set(LAUNCH, "datasets", Array(n).fill({ id: "nm000104", version: "1" })),
  },
  {
    label: "include patterns",
    target: "root",
    kind: "max",
    at: 64,
    build: (n) =>
      set(LAUNCH, "datasets", [{ id: "nm000104", version: "1", include: Array(n).fill("a") }]),
  },
  {
    label: "include pattern length",
    target: "root",
    kind: "max",
    at: 256,
    build: (n) =>
      set(LAUNCH, "datasets", [{ id: "nm000104", version: "1", include: ["a".repeat(n)] }]),
  },
  {
    label: "include pattern length, at least",
    target: "root",
    kind: "min",
    at: 1,
    build: (n) =>
      set(LAUNCH, "datasets", [{ id: "nm000104", version: "1", include: ["a".repeat(n)] }]),
  },
  {
    label: "dataset version length",
    target: "root",
    kind: "max",
    at: 64,
    build: (n) => set(LAUNCH, "datasets", [{ id: "nm000104", version: "1".repeat(n) }]),
  },
  {
    label: "dataset version length, at least",
    target: "root",
    kind: "min",
    at: 1,
    build: (n) => set(LAUNCH, "datasets", [{ id: "nm000104", version: "1".repeat(n) }]),
  },
  {
    label: "api_base length",
    target: "root",
    kind: "max",
    at: 512,
    build: (n) => set(LAUNCH, "api_base", `https://${"a".repeat(n - 8)}`),
  },
  {
    label: "job_token length, at least",
    target: "root",
    kind: "min",
    at: 16,
    build: (n) => set(LAUNCH, "job_token", "t".repeat(n)),
  },
  {
    label: "job_token length",
    target: "root",
    kind: "max",
    at: 256,
    build: (n) => set(LAUNCH, "job_token", "t".repeat(n)),
  },
  {
    label: "image uri length",
    target: "root",
    kind: "max",
    at: 512,
    build: (n) => set(LAUNCH, "image.uri", imageRef(n)),
  },
  {
    label: "image sif length",
    target: "root",
    kind: "max",
    at: 256,
    build: (n) => set(LAUNCH, "image.sif", "s".repeat(n)),
  },
  {
    label: "image sif length, at least",
    target: "root",
    kind: "min",
    at: 1,
    build: (n) => set(LAUNCH, "image.sif", "s".repeat(n)),
  },
  {
    label: "env value length",
    target: "root",
    kind: "max",
    at: 256,
    build: (n) => set(LAUNCH, "env", { OMP_NUM_THREADS: "x".repeat(n) }),
  },
  {
    label: "gpus",
    target: "root",
    kind: "max",
    at: 8,
    build: (n) => set(LAUNCH, "resources.gpus", n),
  },
  {
    label: "gpus, at least",
    target: "root",
    kind: "min",
    at: 0,
    build: (n) => set(LAUNCH, "resources.gpus", n),
  },
  {
    label: "max_files",
    target: "root",
    kind: "max",
    at: 1_000_000,
    build: (n) => set(LAUNCH, "limits.max_files", n),
  },
  {
    label: "max_files, at least",
    target: "root",
    kind: "min",
    at: 1,
    build: (n) => set(LAUNCH, "limits.max_files", n),
  },
  {
    label: "max_total_bytes",
    target: "root",
    kind: "max",
    at: MAX_SAFE,
    build: (n) => set(LAUNCH, "limits.max_total_bytes", n),
  },
  {
    label: "max_total_bytes, at least",
    target: "root",
    kind: "min",
    at: 1,
    build: (n) => set(LAUNCH, "limits.max_total_bytes", n),
  },
  {
    label: "bundle size",
    target: "root",
    kind: "max",
    at: MAX_SAFE,
    build: (n) => set(LAUNCH, "bundle.size", n),
  },
  {
    label: "bundle size, at least",
    target: "root",
    kind: "min",
    at: 1,
    build: (n) => set(LAUNCH, "bundle.size", n),
  },
  // The bundle response
  {
    label: "bundle url length",
    target: "bundle_response",
    kind: "max",
    at: 4096,
    build: (n) => ({ url: `https://${"a".repeat(n - 8)}`, expires_at: TS }),
  },
  // The outputs request
  {
    label: "outputs listed",
    target: "outputs_request",
    kind: "max",
    at: 100_000,
    build: (n) => ({ ...REQUEST_BASE, outputs: Array(n).fill(OUTPUT) }),
  },
  {
    label: "output path length",
    target: "outputs_request",
    kind: "max",
    at: 512,
    build: (n) => ({ ...REQUEST_BASE, outputs: [{ ...OUTPUT, path: "a".repeat(n) }] }),
  },
  {
    label: "output size",
    target: "outputs_request",
    kind: "max",
    at: MAX_SAFE,
    build: (n) => ({ ...REQUEST_BASE, outputs: [{ ...OUTPUT, size: n }] }),
  },
  {
    label: "output size, at least",
    target: "outputs_request",
    kind: "min",
    at: 0,
    build: (n) => ({ ...REQUEST_BASE, outputs: [{ ...OUTPUT, size: n }] }),
  },
  {
    label: "launcher file size",
    target: "outputs_request",
    kind: "max",
    at: MAX_SAFE,
    build: (n) => ({
      ...REQUEST_BASE,
      launcher: REQUEST_BASE.launcher.map((f, i) => (i === 0 ? { ...f, size: n } : f)),
    }),
  },
  // The outputs response
  {
    label: "uploads",
    target: "outputs_response",
    kind: "max",
    at: 100_004,
    build: (n) => ({ uploads: Array(n).fill(UPLOAD), expires_at: TS }),
  },
  {
    label: "upload path length",
    target: "outputs_response",
    kind: "max",
    at: 600,
    build: (n) => ({
      uploads: [{ ...UPLOAD, path: `outputs/${"a".repeat(n - 8)}` }],
      expires_at: TS,
    }),
  },
  {
    label: "upload url length",
    target: "outputs_response",
    kind: "max",
    at: 4096,
    build: (n) => ({
      uploads: [{ ...UPLOAD, url: `https://${"a".repeat(n - 8)}` }],
      expires_at: TS,
    }),
  },
  // result.json
  {
    label: "result detail length",
    target: "result",
    kind: "max",
    at: 64,
    build: (n) => ({ ...RESULT_BASE, detail: "a".repeat(n) }),
  },
  {
    label: "result detail length, at least",
    target: "result",
    kind: "min",
    at: 1,
    build: (n) => ({ ...RESULT_BASE, detail: "a".repeat(n) }),
  },
  {
    label: "entry exit code",
    target: "result",
    kind: "max",
    at: 255,
    build: (n) => ({ ...RESULT_BASE, entry_exit_code: n }),
  },
  {
    label: "entry exit code, at least",
    target: "result",
    kind: "min",
    at: -255,
    build: (n) => ({ ...RESULT_BASE, entry_exit_code: n }),
  },
  // manifest.json
  {
    label: "manifest files",
    target: "manifest",
    kind: "max",
    at: 100_000,
    build: (n) => ({ ...MANIFEST_BASE, files: Array(n).fill(OUTPUT) }),
  },
  {
    label: "manifest path length",
    target: "manifest",
    kind: "max",
    at: 512,
    build: (n) => ({ ...MANIFEST_BASE, files: [{ ...OUTPUT, path: "a".repeat(n) }] }),
  },
  {
    label: "manifest size",
    target: "manifest",
    kind: "max",
    at: MAX_SAFE,
    build: (n) => ({ ...MANIFEST_BASE, files: [{ ...OUTPUT, size: n }] }),
  },
  // provenance.json
  {
    label: "staging records",
    target: "provenance",
    kind: "max",
    at: 20,
    build: (n) => ({ ...PROVENANCE_BASE, staging: Array(n).fill(STAGING) }),
  },
  {
    label: "staging files",
    target: "provenance",
    kind: "max",
    at: MAX_SAFE,
    build: (n) => ({ ...PROVENANCE_BASE, staging: [{ ...STAGING, files: n }] }),
  },
  {
    label: "staging bytes",
    target: "provenance",
    kind: "max",
    at: MAX_SAFE,
    build: (n) => ({ ...PROVENANCE_BASE, staging: [{ ...STAGING, bytes: n }] }),
  },
  {
    label: "staging version length",
    target: "provenance",
    kind: "max",
    at: 64,
    build: (n) => ({ ...PROVENANCE_BASE, staging: [{ ...STAGING, version: "1".repeat(n) }] }),
  },
  {
    label: "timings",
    target: "provenance",
    kind: "max",
    at: 16,
    build: (n) => ({
      ...PROVENANCE_BASE,
      timings: Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, 1])),
    }),
  },
  {
    label: "timing key length",
    target: "provenance",
    kind: "max",
    at: 64,
    build: (n) => ({ ...PROVENANCE_BASE, timings: { [`k${"a".repeat(n - 1)}`]: 1 } }),
  },
  {
    label: "slurm_job_id length",
    target: "provenance",
    kind: "max",
    at: 64,
    build: (n) => ({ ...PROVENANCE_BASE, slurm_job_id: "1".repeat(n) }),
  },
  {
    label: "slurm_job_id length, at least",
    target: "provenance",
    kind: "min",
    at: 1,
    build: (n) => ({ ...PROVENANCE_BASE, slurm_job_id: "1".repeat(n) }),
  },
  {
    label: "runtime_version length",
    target: "provenance",
    kind: "max",
    at: 128,
    build: (n) => ({ ...PROVENANCE_BASE, runtime_version: "v".repeat(n) }),
  },
  {
    label: "runtime_version length, at least",
    target: "provenance",
    kind: "min",
    at: 1,
    build: (n) => ({ ...PROVENANCE_BASE, runtime_version: "v".repeat(n) }),
  },
  {
    label: "provenance image uri length",
    target: "provenance",
    kind: "max",
    at: 512,
    build: (n) => ({ ...PROVENANCE_BASE, image: { ...PROVENANCE_BASE.image, uri: "u".repeat(n) } }),
  },
  {
    label: "provenance entry exit code",
    target: "provenance",
    kind: "max",
    at: 255,
    build: (n) => ({ ...PROVENANCE_BASE, entry_exit_code: n }),
  },
  {
    label: "provenance entry exit code, at least",
    target: "provenance",
    kind: "min",
    at: -255,
    build: (n) => ({ ...PROVENANCE_BASE, entry_exit_code: n }),
  },
];

/** The bounds a mutation of each quantifier or keyword in the schema turned out to need. */
const EXTRA_BOUNDS: readonly Bound[] = [
  {
    label: "entry length, at least",
    target: "root",
    kind: "min",
    at: 1,
    build: (n) => set(LAUNCH, "entry", "a".repeat(n)),
  },
  // Every allowlisted environment name has its own entry in the schema, so each one is a bound.
  ...JOB_ENV_ALLOWLIST.map(
    (name): Bound => ({
      label: `env value length (${name})`,
      target: "root",
      kind: "max",
      at: 256,
      build: (n) => set(LAUNCH, "env", { [name]: "x".repeat(n) }),
    }),
  ),
  {
    label: "image uri port digits",
    target: "root",
    kind: "max",
    at: 5,
    build: (n) =>
      set(LAUNCH, "image.uri", `registry.example.test:${"1".repeat(n)}/team/tool@sha256:${HASH}`),
  },
  {
    label: "image uri port digits, at least",
    target: "root",
    kind: "min",
    at: 1,
    build: (n) =>
      set(LAUNCH, "image.uri", `registry.example.test:${"1".repeat(n)}/team/tool@sha256:${HASH}`),
  },
  {
    label: "launcher file size, at least",
    target: "outputs_request",
    kind: "min",
    at: 0,
    build: (n) => ({
      ...REQUEST_BASE,
      launcher: REQUEST_BASE.launcher.map((f, i) => (i === 0 ? { ...f, size: n } : f)),
    }),
  },
  {
    label: "manifest size, at least",
    target: "manifest",
    kind: "min",
    at: 0,
    build: (n) => ({ ...MANIFEST_BASE, files: [{ ...OUTPUT, size: n }] }),
  },
  {
    label: "staging files, at least",
    target: "provenance",
    kind: "min",
    at: 0,
    build: (n) => ({ ...PROVENANCE_BASE, staging: [{ ...STAGING, files: n }] }),
  },
  {
    label: "staging bytes, at least",
    target: "provenance",
    kind: "min",
    at: 0,
    build: (n) => ({ ...PROVENANCE_BASE, staging: [{ ...STAGING, bytes: n }] }),
  },
  {
    label: "staging version length, at least",
    target: "provenance",
    kind: "min",
    at: 1,
    build: (n) => ({ ...PROVENANCE_BASE, staging: [{ ...STAGING, version: "1".repeat(n) }] }),
  },
  {
    label: "timing seconds, at least",
    target: "provenance",
    kind: "min",
    at: 0,
    build: (n) => ({ ...PROVENANCE_BASE, timings: { run: n } }),
  },
  {
    label: "timing key length, at least",
    target: "provenance",
    kind: "min",
    at: 1,
    build: (n) => ({ ...PROVENANCE_BASE, timings: { ["k".repeat(n)]: 1 } }),
  },
  {
    label: "provenance image uri length, at least",
    target: "provenance",
    kind: "min",
    at: 1,
    build: (n) => ({ ...PROVENANCE_BASE, image: { ...PROVENANCE_BASE.image, uri: "u".repeat(n) } }),
  },
];

const BOUNDS: readonly Bound[] = [...MAIN_BOUNDS, ...EXTRA_BOUNDS];

const zodFor: Record<BoundTarget, (doc: unknown) => boolean> = {
  root: (d) => LaunchSpecSchema.safeParse(d).success,
  bundle_response: (d) => BundleResponseSchema.safeParse(d).success,
  outputs_request: (d) => OutputsRequestSchema.safeParse(d).success,
  outputs_response: (d) => OutputsResponseSchema.safeParse(d).success,
  result: (d) => LauncherResultSchema.safeParse(d).success,
  manifest: (d) => ResultManifestSchema.safeParse(d).success,
  provenance: (d) => LauncherProvenanceSchema.safeParse(d).success,
};
const ajvFor = (target: BoundTarget): ((doc: unknown) => boolean) =>
  target === "root" ? (d) => validateRoot(d) as boolean : (d) => defValidator(target)(d) as boolean;

describe("every numeric and length bound, from one table, on both sides of its edge", () => {
  test("the table covers every kind of document and is not small", () => {
    expect(BOUNDS.length).toBeGreaterThanOrEqual(70);
    expect(new Set(BOUNDS.map((b) => b.target))).toEqual(
      new Set([
        "root",
        "bundle_response",
        "outputs_request",
        "outputs_response",
        "result",
        "manifest",
        "provenance",
      ]),
    );
    expect(new Set(BOUNDS.map((b) => b.label)).size).toBe(BOUNDS.length);
    expect(BOUNDS.filter((b) => b.kind === "min").length).toBeGreaterThanOrEqual(15);
  });

  test("the base documents the builders vary are themselves valid", () => {
    expect(validateRoot(COMMAND_BASE)).toBe(true);
    expect(LaunchSpecSchema.safeParse(COMMAND_BASE).success).toBe(true);
    for (const [target, doc] of [
      ["outputs_request", REQUEST_BASE],
      ["result", RESULT_BASE],
      ["manifest", MANIFEST_BASE],
      ["provenance", PROVENANCE_BASE],
    ] as const) {
      expect(ajvFor(target)(doc), target).toBe(true);
      expect(zodFor[target](doc), target).toBe(true);
    }
  });

  for (const bound of BOUNDS) {
    test(`${bound.target}: ${bound.label} is ${bound.at} ${bound.kind === "max" ? "at most" : "at least"}`, () => {
      const inside = bound.build(bound.at);
      const outside = bound.build(bound.kind === "max" ? bound.at + 1 : bound.at - 1);
      expect(ajvFor(bound.target)(inside), "JSON Schema, at the limit").toBe(true);
      expect(zodFor[bound.target](inside), "zod, at the limit").toBe(true);
      expect(ajvFor(bound.target)(outside), "JSON Schema, one past").toBe(false);
      expect(zodFor[bound.target](outside), "zod, one past").toBe(false);
    });
  }
});

// --- The same, for what only zod holds: the job specification and the owner policy ----------------

interface ZodBound {
  label: string;
  kind: "max" | "min";
  at: number;
  ok: (doc: unknown) => boolean;
  build: (n: number) => unknown;
}

/** The rows for one number that may be bounded below and above, both ends from one place. */
function numeric(
  label: string,
  ok: (doc: unknown) => boolean,
  build: (n: number) => unknown,
  min: number | null,
  max: number | null,
): ZodBound[] {
  const rows: ZodBound[] = [];
  if (min !== null) rows.push({ label: `${label}, at least`, kind: "min", at: min, ok, build });
  if (max !== null) rows.push({ label, kind: "max", at: max, ok, build });
  return rows;
}

const jobOk = (d: unknown) => JobSpecSchema.safeParse(d).success;
const policyOk = (d: unknown) => ComputePolicySchema.safeParse(d).success;
const POLICY = JSON.parse(JSON.stringify(DEFAULT_COMPUTE_POLICY)) as Doc;
const policyWith = (path: string, value: unknown) => set(POLICY, path, value);
const imageJob = (extra: Record<string, unknown>) => ({
  name: "tool",
  runtime: "image",
  command: ["tool"],
  partition: "shared",
  minutes: 30,
  ...extra,
});
const recipeJob = (recipe: string) => ({
  name: "floor",
  runtime: "python",
  recipe,
  datasets: [{ id: "nm000104", version: "1" }],
  partition: "shared",
  minutes: 60,
});
const ceilingOk = (d: unknown) => ComputeCeilingSchema.safeParse(d).success;
const CEILING = { maxNodes: 1, maxCoresPerNode: 1, maxGpusPerNode: 0, maxMinutes: 1 };
const capsOk = (d: unknown) => ComputeClientCapsSchema.safeParse(d).success;

const ZOD_BOUNDS: readonly ZodBound[] = [
  // The job specification
  ...numeric("name length", jobOk, (n) => specWith({ name: "a".repeat(n) }), 1, 80),
  ...numeric("nodes", jobOk, (n) => specWith({ nodes: n }), 1, 64),
  ...numeric("cores", jobOk, (n) => specWith({ cores: n }), 1, 256),
  ...numeric("gpus on a CPU partition", jobOk, (n) => specWith({ gpus: n }), 0, null),
  ...numeric(
    "gpus on a GPU partition",
    jobOk,
    (n) => specWith({ partition: "gpu", gpus: n }),
    1,
    8,
  ),
  ...numeric("minutes", jobOk, (n) => specWith({ minutes: n }), 1, 10080),
  ...numeric("memory_mb", jobOk, (n) => specWith({ memory_mb: n }), 1, 16_777_216),
  ...numeric("entry length", jobOk, (n) => specWith({ entry: "a".repeat(n) }), 1, null),
  ...numeric(
    "entry length, with a suffix",
    jobOk,
    (n) => specWith({ entry: `${"a".repeat(n - 3)}.py` }),
    null,
    240,
  ),
  ...numeric(
    "bundle size",
    jobOk,
    (n) => specWith({ bundle: { size: n, sha256: HEX_A } }),
    1,
    MAX_SAFE,
  ),
  ...numeric("arguments", jobOk, (n) => specWith({ args: Array(n).fill("a") }), null, 64),
  ...numeric("argument length", jobOk, (n) => specWith({ args: ["a".repeat(n)] }), null, 1024),
  ...numeric(
    "command items",
    jobOk,
    (n) => imageJob({ image: imageRef(512), command: Array(n).fill("c") }),
    1,
    64,
  ),
  ...numeric(
    "command item length",
    jobOk,
    (n) => imageJob({ image: imageRef(512), command: ["c".repeat(n)] }),
    1,
    1024,
  ),
  ...numeric("image length", jobOk, (n) => imageJob({ image: imageRef(n) }), null, 512),
  ...numeric("recipe length", jobOk, (n) => recipeJob("a".repeat(n)), 1, 64),
  ...numeric(
    "datasets",
    jobOk,
    (n) => specWith({ datasets: Array(n).fill({ id: "nm000104", version: "1" }) }),
    null,
    20,
  ),
  ...numeric(
    "dataset version length",
    jobOk,
    (n) => specWith({ datasets: [{ id: "nm000104", version: "1".repeat(n) }] }),
    1,
    64,
  ),
  ...numeric(
    "include patterns",
    jobOk,
    (n) => specWith({ datasets: [{ id: "nm000104", version: "1", include: Array(n).fill("a") }] }),
    null,
    64,
  ),
  ...numeric(
    "include pattern length",
    jobOk,
    (n) => specWith({ datasets: [{ id: "nm000104", version: "1", include: ["a".repeat(n)] }] }),
    1,
    256,
  ),
  ...JOB_ENV_ALLOWLIST.flatMap((name) =>
    numeric(
      `env value length (${name})`,
      jobOk,
      (n) => specWith({ env: { [name]: "x".repeat(n) } }),
      null,
      256,
    ),
  ),
  // A ceiling and a client's caps
  ...numeric("ceiling maxNodes", ceilingOk, (n) => ({ ...CEILING, maxNodes: n }), 1, 64),
  ...numeric(
    "ceiling maxCoresPerNode",
    ceilingOk,
    (n) => ({ ...CEILING, maxCoresPerNode: n }),
    0,
    256,
  ),
  ...numeric("ceiling maxGpusPerNode", ceilingOk, (n) => ({ ...CEILING, maxGpusPerNode: n }), 0, 8),
  ...numeric("ceiling maxMinutes", ceilingOk, (n) => ({ ...CEILING, maxMinutes: n }), 1, 10080),
  ...numeric(
    "client maxOpenReservations",
    capsOk,
    (n) => ({ maxOpenReservations: n, maxReservedMilliPerDay: 1 }),
    0,
    100_000,
  ),
  ...numeric(
    "client maxReservedMilliPerDay",
    capsOk,
    (n) => ({ maxOpenReservations: 1, maxReservedMilliPerDay: n }),
    0,
    MAX_SAFE,
  ),
  // The owner policy
  ...numeric(
    "default grant, cpu",
    policyOk,
    (n) => policyWith("defaultGrantMilli.cpu", n),
    0,
    MAX_SAFE,
  ),
  ...numeric(
    "default grant, gpu",
    policyOk,
    (n) => policyWith("defaultGrantMilli.gpu", n),
    0,
    MAX_SAFE,
  ),
  ...numeric(
    "renewal every days",
    policyOk,
    (n) => policyWith("renewal", { enabled: true, everyDays: n }),
    1,
    366,
  ),
  ...numeric(
    "maxLiveJobsPerPerson",
    policyOk,
    (n) => policyWith("maxLiveJobsPerPerson", n),
    0,
    1000,
  ),
  ...numeric(
    "pipelines dailyJobCap",
    policyOk,
    (n) => policyWith("pipelines.dailyJobCap", n),
    0,
    100_000,
  ),
  ...numeric(
    "pipelines live cpu",
    policyOk,
    (n) => policyWith("pipelines.maxLiveJobs.cpu", n),
    0,
    1000,
  ),
  ...numeric(
    "pipelines live gpu",
    policyOk,
    (n) => policyWith("pipelines.maxLiveJobs.gpu", n),
    0,
    1000,
  ),
  ...numeric(
    "reservationWaitMinutes",
    policyOk,
    (n) => policyWith("reservationWaitMinutes", n),
    1,
    1440,
  ),
  ...numeric(
    "retention recordsYears",
    policyOk,
    (n) => policyWith("retention.recordsYears", n),
    1,
    30,
  ),
  ...numeric("retention logsDays", policyOk, (n) => policyWith("retention.logsDays", n), 1, 3650),
  ...numeric(
    "retention resultsDays",
    policyOk,
    (n) => policyWith("retention.resultsDays", n),
    14,
    365,
  ),
  ...numeric(
    "resultLimits maxJobBytes",
    policyOk,
    (n) => policyWith("resultLimits.maxJobBytes", n),
    1,
    MAX_SAFE,
  ),
  ...numeric(
    "resultLimits maxFiles",
    policyOk,
    (n) => policyWith("resultLimits.maxFiles", n),
    1,
    100_000,
  ),
  ...numeric(
    "resultLimits maxStoredBytesPerPerson",
    policyOk,
    (n) => policyWith("resultLimits.maxStoredBytesPerPerson", n),
    1,
    MAX_SAFE,
  ),
  ...numeric(
    "resultLimits maxStoredBytesTotal",
    policyOk,
    (n) => policyWith("resultLimits.maxStoredBytesTotal", n),
    1,
    MAX_SAFE,
  ),
  ...numeric(
    "settle toleranceMilli",
    policyOk,
    (n) => policyWith("settle.toleranceMilli", n),
    0,
    MAX_SAFE,
  ),
  ...numeric(
    "settle tolerancePercent",
    policyOk,
    (n) => policyWith("settle.tolerancePercent", n),
    0,
    100,
  ),
  ...numeric(
    "bundleLimits maxTotalBytes",
    policyOk,
    (n) => policyWith("bundleLimits.maxTotalBytes", n),
    1,
    MAX_SAFE,
  ),
  ...numeric(
    "bundleLimits maxFiles",
    policyOk,
    (n) => policyWith("bundleLimits.maxFiles", n),
    1,
    100_000,
  ),
  ...numeric(
    "bundleLimits maxFileBytes",
    policyOk,
    (n) => policyWith("bundleLimits.maxFileBytes", n),
    1,
    MAX_SAFE,
  ),
  ...numeric(
    "registries",
    policyOk,
    (n) => policyWith("registries", Array(n).fill("ghcr.io")),
    null,
    64,
  ),
  ...numeric("registry length", policyOk, (n) => policyWith("registries", ["a".repeat(n)]), 1, 255),
  ...numeric(
    "registry port digits",
    policyOk,
    (n) => policyWith("registries", [`ghcr.io:${"1".repeat(n)}`]),
    1,
    5,
  ),
  ...numeric(
    "client id length",
    policyOk,
    (n) =>
      policyWith("clients", {
        ["c".repeat(n)]: { maxOpenReservations: 1, maxReservedMilliPerDay: 1 },
      }),
    1,
    64,
  ),
];

describe("every bound of the job specification and the owner policy, from one table", () => {
  test("the table is large and its builders produce valid documents at the base", () => {
    expect(ZOD_BOUNDS.length).toBeGreaterThanOrEqual(95);
    expect(new Set(ZOD_BOUNDS.map((b) => b.label)).size).toBe(ZOD_BOUNDS.length);
    expect(jobOk(SPEC)).toBe(true);
    expect(policyOk(POLICY)).toBe(true);
    expect(ceilingOk(CEILING)).toBe(true);
    expect(capsOk({ maxOpenReservations: 1, maxReservedMilliPerDay: 1 })).toBe(true);
  });

  for (const bound of ZOD_BOUNDS) {
    test(`${bound.label} is ${bound.at} ${bound.kind === "max" ? "at most" : "at least"}`, () => {
      expect(bound.ok(bound.build(bound.at)), "at the limit").toBe(true);
      expect(
        bound.ok(bound.build(bound.kind === "max" ? bound.at + 1 : bound.at - 1)),
        "one past",
      ).toBe(false);
    });
  }
});

describe("the schema compiles strictly, so a mistyped keyword cannot hide", () => {
  test("a mistyped keyword makes strict compilation throw", () => {
    const broken = JSON.parse(JSON.stringify(launchSchema));
    broken.$id = "https://example.test/broken.json";
    broken.properties.entry.maxLenght = 240;
    expect(() => new Ajv2020(AJV_OPTIONS).compile(broken)).toThrow(/unknown keyword/);
    // The real schema, compiled afresh the same way, does not.
    const again = JSON.parse(JSON.stringify(launchSchema));
    expect(() => new Ajv2020(AJV_OPTIONS).compile(again)).not.toThrow();
  });

  test("the default (non-strict) options would have let it through", () => {
    const broken = JSON.parse(JSON.stringify(launchSchema));
    broken.$id = "https://example.test/broken-lenient.json";
    broken.properties.entry.maxLenght = 240;
    expect(() => new Ajv2020({ strict: false }).compile(broken)).not.toThrow();
  });
});

describe("the JSON Schema file read back against the constants it mirrors", () => {
  const schema = launchSchema as Doc;

  test("it is draft 2020-12, named for the version, and self-contained", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.title).toBe(LAUNCH_SPEC_VERSION);
    expect(typeof schema.$id).toBe("string");
    // The API serves a schema only under its own name (`backend/src/routes/schemas.ts`). An id on
    // the API host that is not served would be an address that resolves to nothing, so this one
    // follows the form of the repository's schemas that are not served: the file's GitHub address.
    const served = [
      ...readFileSync(join(import.meta.dir, "../backend/src/routes/schemas.ts"), "utf8").matchAll(
        /^\s+"([a-z0-9.-]+\.json)":/gm,
      ),
    ].map((m) => m[1]);
    expect(served.length).toBeGreaterThan(0);
    const id = new URL(schema.$id);
    if (id.hostname === "api.nemar.org") {
      expect(served).toContain(id.pathname.replace("/schemas/", ""));
    }
    expect(schema.$id).toBe(
      "https://github.com/nemarOrg/nemar-cli/shared/contract/compute-launch.schema.json",
    );
    const refs: string[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
          if (k === "$ref") refs.push(String(v));
          else walk(v);
        }
      }
    };
    walk(schema);
    for (const ref of refs) expect(ref.startsWith("#/$defs/"), ref).toBe(true);
    for (const ref of refs) expect(schema.$defs[ref.slice("#/$defs/".length)], ref).toBeDefined();
  });

  test("its keys and required list are the launch specification's", () => {
    const keys = [
      "job_id",
      "runtime",
      "entry",
      "command",
      "args",
      "bundle",
      "datasets",
      "api_base",
      "image",
      "env",
      "resources",
      "limits",
      "job_token",
    ];
    expect(Object.keys(schema.properties).sort()).toEqual([...keys].sort());
    expect(schema.additionalProperties).toBe(false);
    expect([...schema.required].sort()).toEqual(
      keys.filter((k) => !["entry", "command", "bundle"].includes(k)).sort(),
    );
    expect(Object.keys(LaunchSpecSchema.innerType().shape).sort()).toEqual([...keys].sort());
  });

  test("its enumerations are the constants'", () => {
    expect(schema.properties.runtime.enum).toEqual([...LAUNCH_RUNTIMES]);
    expect(Object.keys(schema.properties.env.properties)).toEqual([...JOB_ENV_ALLOWLIST]);
    expect(schema.properties.env.additionalProperties).toBe(false);
    const result = schema.$defs.result;
    expect(result.properties.failure_code.enum).toEqual([...LAUNCHER_FAILURE_CODES, null]);
    expect(result.properties.exit_number.enum).toEqual([0, 10, 11, 12, 13, 14, 15, 16]);
    expect(schema.$defs.outputs_request.properties.launcher.items.properties.name.enum).toEqual([
      ...LAUNCHER_FILE_NAMES,
    ]);
    expect(Object.keys(schema.$defs).sort()).toEqual(
      [
        "bundle_response",
        "manifest",
        "outputs_request",
        "outputs_response",
        "provenance",
        "result",
      ].sort(),
    );
  });

  test("no pattern that must match ends in `$`, which Python lets match before a trailing newline", () => {
    // A pattern under `not` only ever refuses more with `$`, so only the positive ones matter.
    const open: string[] = [];
    const walk = (node: unknown, where: string, underNot: boolean) => {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${where}[${i}]`, underNot));
      if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
          if (k === "pattern" && typeof v === "string") {
            if (!underNot && !v.endsWith("(?![\\s\\S])")) open.push(`${where}.pattern`);
          } else {
            walk(v, `${where}.${k}`, underNot || k === "not");
          }
        }
      }
    };
    walk(schema, "$", false);
    expect(open).toEqual([]);
    // A guard against a vacuous pass: the walk did reach patterns.
    expect(JSON.stringify(schema).split('"pattern"').length).toBeGreaterThan(30);
  });

  // The three objects a launcher only ever READS: the two responses and each upload in the second.
  const OPEN_BY_DESIGN = [
    "$.$defs.bundle_response",
    "$.$defs.outputs_response",
    "$.$defs.outputs_response.properties.uploads.items",
  ];

  test("every object in it is closed, except the three a launcher only reads", () => {
    const open: string[] = [];
    const walk = (node: unknown, where: string) => {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${where}[${i}]`));
      if (node && typeof node === "object") {
        const n = node as Doc;
        if (n.type === "object" && n.properties && n.additionalProperties !== false)
          open.push(where);
        // A `contains`, `if`, `then` or `not` subschema is a test applied to a document, not an
        // object a document is made of.
        for (const [k, v] of Object.entries(n)) {
          if (["contains", "if", "then", "not"].includes(k)) continue;
          walk(v, `${where}.${k}`);
        }
      }
    };
    walk(schema, "$");
    expect(open.sort()).toEqual([...OPEN_BY_DESIGN].sort());
  });

  test("the three open objects say so, and none of them forbids an unknown key", () => {
    const at = (path: string): Doc =>
      path
        .split(".")
        .slice(1)
        .reduce<Doc>((node, key) => node[key], schema);
    for (const path of OPEN_BY_DESIGN) {
      const node = at(path);
      expect(node.additionalProperties, path).toBeUndefined();
      expect(String(node.description), path).toMatch(/ignores unknown keys/);
    }
    // And no closed definition is among them: the requests and documents stay strict.
    for (const name of ["outputs_request", "result", "manifest", "provenance"]) {
      expect(schema.$defs[name].additionalProperties, name).toBe(false);
    }
  });
});

describe("the contract records what the launcher owes it", () => {
  test("the clean environment requirement is written where the contract is", () => {
    const text = readFileSync(
      join(import.meta.dir, "../shared/contract/compute-launch.ts"),
      "utf8",
    );
    expect(text).toContain("CLEAN ENVIRONMENT");
    expect(text).toContain("--cleanenv");
    expect(text).toContain("NEMAR_LAUNCH_SPEC");
    expect(text).toContain("job_token");
  });
});

describe("the modules' imports", () => {
  const importsOf = (rel: string): string[] => {
    const src = readFileSync(join(import.meta.dir, rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const found = [...src.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(src).not.toMatch(/\brequire\s*\(/);
    expect(src).not.toMatch(/\bimport\s*\(/);
    expect(src).not.toMatch(/^\s*import\s+["']/m);
    return found.sort();
  };

  test("the contract imports only zod and the state module", () => {
    expect(importsOf("../shared/contract/compute.ts")).toEqual(["../compute-state.js", "zod"]);
  });

  test("the launch contract adds only the contract itself", () => {
    expect(importsOf("../shared/contract/compute-launch.ts")).toEqual(["./compute.js", "zod"]);
  });
});
