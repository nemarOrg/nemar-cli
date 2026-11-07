/**
 * The shared contract of the person's compute read routes (`shared/contract/compute-user.ts`; epic #2021
 * phase D2, #2023; ADR 0118): like the admin and person responses, every schema must accept and keep a key
 * it does not know, at the top level and in every object below, so a released reader survives the Worker
 * adding one; a malformed answer is refused, not guessed; the file imports no strict compute schema; and
 * its error words each have a status and a sentence. The real routes' output is parsed against these
 * schemas by `backend/test/compute-read-*.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { COMPUTE_REFUSAL_STATUS } from "../shared/compute-state";
import * as user from "../shared/contract/compute-user";

const pool = {
  granted_milli: 100000,
  held_milli: 20000,
  charged_milli: 12500,
  available_milli: 67500,
};

const job = {
  id: "job_0123456789abcdef01234567",
  kind: "batch",
  source: "cli",
  state: "running",
  app_id: "nemar-launch",
  app_version: "1.0.0",
  partition: "shared",
  pool: "cpu",
  resources: { nodes: 1, cores_per_node: 4, memory_mb: null, gpus: 0, minutes: 60 },
  created_at: "2026-11-06 10:00:00",
  started_at: null,
  ended_at: null,
  charged_milli: 0,
  failure_code: null,
  cancel_requested: false,
};

const VALID: Record<string, unknown> = {
  ComputePoolBalanceSchema: pool,
  ComputePartitionLimitSchema: {
    name: "shared",
    pool: "cpu",
    max_nodes: 1,
    max_cores_per_node: 64,
    max_gpus_per_node: 0,
    max_minutes: 2880,
  },
  ComputeQueueEstimateSchema: {
    partition: "shared",
    median_seconds: 252,
    p90_seconds: 3900,
    count: 57,
    window_days: 7,
  },
  ComputeMeResponseSchema: {
    access: {
      state: "active",
      requested_at: "2026-11-01 10:00:00",
      granted_at: "2026-11-02 11:00:00",
      terms_version: "2026-11-draft",
      current_terms_version: "2026-11-draft",
      terms_published: false,
      requests_open: true,
    },
    pools: { cpu: pool, gpu: { ...pool, available_milli: -4000 } },
    frozen: false,
    limits: {
      partitions: [
        {
          name: "shared",
          pool: "cpu",
          max_nodes: 1,
          max_cores_per_node: 64,
          max_gpus_per_node: 0,
          max_minutes: 2880,
        },
      ],
      max_live_jobs: 4,
      results_days: 30,
    },
    queue: [
      { partition: "shared", median_seconds: null, p90_seconds: null, count: 3, window_days: 7 },
    ],
  },
  ComputeUsageRowSchema: {
    day: "2026-11-05",
    app: null,
    partition: "shared",
    source: "cli",
    charged_milli: -2000,
    jobs: 1,
  },
  ComputeUsageResponseSchema: {
    from: "2026-10-08",
    to: "2026-11-06",
    group: ["day", "app"],
    rows: [{ day: "2026-11-05", app: "nemar-launch", charged_milli: 4000, jobs: 2 }],
  },
  ComputeUserJobSchema: job,
  ComputeUserJobsResponseSchema: { jobs: [job], next_after: "2026-11-06T10:00:00_41" },
  ComputeUserJobResponseSchema: { job, stale: true },
  ComputeStatsResponseSchema: {
    from: "2026-10-08",
    to: "2026-11-06",
    by_day_partition_source: [
      { day: "2026-11-05", partition: "shared", source: "cli", charged_milli: 4000, jobs: 2 },
    ],
    active_people: 3,
    jobs_by_outcome: { finished: 9, failed: 1, cancelled: 0 },
  },
};

function withUnknownEverywhere(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return value.map((v) => withUnknownEverywhere(v, depth + 1));
  if (value !== null && typeof value === "object") {
    return {
      ...Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, withUnknownEverywhere(v, depth + 1)]),
      ),
      [`future_key_${depth}`]: { added: "by a newer worker" },
    };
  }
  return value;
}

const schemas = () =>
  Object.entries(user).filter((e): e is [string, z.ZodTypeAny] => e[1] instanceof z.ZodType);

describe("compute-user: every exported schema is open", () => {
  test("every schema it exports is classified here, and nothing here is gone", () => {
    expect(
      schemas()
        .map(([n]) => n)
        .sort(),
    ).toEqual(Object.keys(VALID).sort());
  });

  for (const name of Object.keys(VALID)) {
    test(`${name} accepts the valid document, and the same with an unknown key on every object, kept`, () => {
      const schema = (user as Record<string, unknown>)[name] as z.ZodTypeAny;
      expect(schema.safeParse(VALID[name]).success).toBe(true);
      const extended = withUnknownEverywhere(VALID[name]);
      const parsed = schema.safeParse(extended);
      expect([name, parsed.success]).toEqual([name, true]);
      if (parsed.success) expect(parsed.data).toEqual(extended);
    });
  }

  test("the file declares no closed schema and imports no strict compute schema", () => {
    const text = readFileSync(
      join(import.meta.dir, "..", "shared", "contract", "compute-user.ts"),
      "utf8",
    );
    expect(text.includes(".strict(")).toBe(false);
    expect(/from "\.\/compute(-launch)?\.js"/.test(text)).toBe(false);
  });
});

describe("compute-user: no float and no unknown guess on the wire", () => {
  test("money is an integer: a fraction is refused, and a pool's available may be negative", () => {
    expect(user.ComputePoolBalanceSchema.safeParse({ ...pool, available_milli: -1 }).success).toBe(
      true,
    );
    for (const key of ["granted_milli", "held_milli", "charged_milli", "available_milli"]) {
      expect(user.ComputePoolBalanceSchema.safeParse({ ...pool, [key]: 1.5 }).success).toBe(false);
    }
    expect(user.ComputePoolBalanceSchema.safeParse({ ...pool, granted_milli: -1 }).success).toBe(
      false,
    );
    expect(user.ComputeUserJobSchema.safeParse({ ...job, charged_milli: 0.5 }).success).toBe(false);
    expect(user.ComputeUsageRowSchema.safeParse({ charged_milli: 1.25, jobs: 1 }).success).toBe(
      false,
    );
  });

  test("a malformed answer is refused", () => {
    const me = VALID.ComputeMeResponseSchema as Record<string, unknown>;
    const { access: _a, ...noAccess } = me;
    expect(user.ComputeMeResponseSchema.safeParse(noAccess).success).toBe(false);
    expect(
      user.ComputeUserJobsResponseSchema.safeParse({ jobs: [job], next_after: 3 }).success,
    ).toBe(false);
    expect(user.ComputeUserJobResponseSchema.safeParse({ stale: true }).success).toBe(false);
    expect(
      user.ComputeQueueEstimateSchema.safeParse({
        partition: "shared",
        median_seconds: 1.5,
        p90_seconds: null,
        count: 1,
        window_days: 7,
      }).success,
    ).toBe(false);
  });

  test("a word the Worker may grow is a string, not an enum", () => {
    const grown = { ...job, state: "paused", source: "tablet", partition: "gpu-future" };
    expect(user.ComputeUserJobSchema.safeParse(grown).success).toBe(true);
  });

  test("an addition is optional with no default: a Worker that predates `stale` and `requests_open` still parses", () => {
    const parsed = user.ComputeUserJobResponseSchema.parse({ job });
    expect(parsed.stale).toBeUndefined();
    const me = JSON.parse(JSON.stringify(VALID.ComputeMeResponseSchema)) as {
      access: { requests_open?: boolean };
    };
    me.access.requests_open = undefined;
    const reread = user.ComputeMeResponseSchema.parse(me);
    expect(reread.access.requests_open).toBeUndefined();
  });
});

describe("compute-user: the words", () => {
  test("every error word has a status in 400 to 599 and a sentence (the job words use the job routes' own)", () => {
    expect(user.COMPUTE_USER_ERROR_CODES.sort()).toEqual(
      Object.keys(user.COMPUTE_USER_ERROR_STATUS).sort(),
    );
    for (const code of user.COMPUTE_USER_ERROR_CODES) {
      const status = user.COMPUTE_USER_ERROR_STATUS[code];
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
      const own = code in user.COMPUTE_USER_SENTENCES;
      const shared = code === "job_not_found" || code === "policy_unavailable";
      expect([code, own !== shared]).toEqual([code, true]);
    }
  });

  test("the job words keep the statuses the job routes give them", () => {
    expect(user.COMPUTE_USER_ERROR_STATUS.job_not_found).toBe(COMPUTE_REFUSAL_STATUS.job_not_found);
    expect(user.COMPUTE_USER_ERROR_STATUS.policy_unavailable).toBe(
      COMPUTE_REFUSAL_STATUS.policy_unavailable,
    );
  });

  test("a sentence repeats nothing the caller sent and says what to do or what was wrong", () => {
    for (const sentence of Object.values(user.COMPUTE_USER_SENTENCES)) {
      expect(sentence.length).toBeGreaterThan(10);
      expect(sentence.endsWith(".")).toBe(true);
    }
  });

  test("the bounds are the numbers the design states", () => {
    expect(user.COMPUTE_JOBS_PAGE_MAX).toBe(100);
    expect(user.COMPUTE_JOBS_PAGE_DEFAULT).toBe(25);
    expect([...user.COMPUTE_USAGE_GROUPS]).toEqual(["day", "app", "partition", "source"]);
    expect(user.COMPUTE_WINDOW_MAX_DAYS).toBe(366);
    expect(user.COMPUTE_WINDOW_DEFAULT_DAYS).toBe(30);
    expect(user.COMPUTE_QUEUE_WINDOW_DAYS).toBe(7);
    expect(user.COMPUTE_QUEUE_SAMPLE_CAP).toBe(2000);
    expect(user.COMPUTE_QUEUE_MIN_SAMPLES).toBe(5);
    expect(user.COMPUTE_READ_SCOPE).toBe("compute.read");
    expect(user.COMPUTE_STATS_SCOPE).toBe("compute.stats");
  });
});
