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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020";
import { LAUNCHER_FAILURE_CODES } from "../shared/compute-state";
import {
  COMPUTE_JOB_ID_RE,
  COMPUTE_POOLS,
  ComputePolicySchema,
  DEFAULT_COMPUTE_POLICY,
  JOB_ENV_ALLOWLIST,
  JOB_RUNTIMES,
  JobSpecSchema,
  LAUNCHER_DIR,
  LAUNCHER_ENV,
  LAUNCHER_FILES,
  LAUNCHER_FILE_NAMES,
  LAUNCHER_OUTPUTS_DIR,
  LAUNCHER_WORK_DIR,
  LauncherProvenanceSchema,
  LauncherResultSchema,
  PARTITIONS,
  PARTITION_NAMES,
  PIPELINES_TAPIS_OWNER,
  RATE_TABLE_V1,
  RESULT_MAX_FILE_BYTES,
  ResultManifestSchema,
  estimateSuMilli,
  formatSu,
  isSafeComputePath,
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

describe("parseSuToMilli and formatSu", () => {
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

  test("the default policy offers exactly the partitions that have a default ceiling", () => {
    const offered = PARTITION_NAMES.filter((p) => PARTITIONS[p].ceiling !== null).sort();
    expect(Object.keys(DEFAULT_COMPUTE_POLICY.ceilings).sort()).toEqual(offered);
    for (const p of offered)
      expect(DEFAULT_COMPUTE_POLICY.ceilings[p] as unknown).toEqual(PARTITIONS[p].ceiling);
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
      spec_digest: HEX_A,
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
      { spec_digest: "short" },
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

const ajv = new Ajv2020({ strict: false, allErrors: true });
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
    [
      "an extra key",
      { url: "https://r2.example.test/b", expires_at: "2026-11-03T12:00:00Z", x: 1 },
      false,
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
    spec_digest: HEX_A,
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
    ["no spec digest", set(PROVENANCE, "spec_digest", undefined), false],
    ["a short spec digest", set(PROVENANCE, "spec_digest", "abc"), false],
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

describe("the JSON Schema file read back against the constants it mirrors", () => {
  const schema = launchSchema as Doc;

  test("it is draft 2020-12, named for the version, and self-contained", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.title).toBe(LAUNCH_SPEC_VERSION);
    expect(typeof schema.$id).toBe("string");
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

  test("every object in it is closed", () => {
    const open: string[] = [];
    const walk = (node: unknown, where: string) => {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${where}[${i}]`));
      if (node && typeof node === "object") {
        const n = node as Doc;
        if (n.type === "object" && n.properties && n.additionalProperties !== false)
          open.push(where);
        for (const [k, v] of Object.entries(n)) walk(v, `${where}.${k}`);
      }
    };
    walk(schema, "$");
    expect(open).toEqual([]);
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
