/**
 * The compute admin routes' wire contract (epic #2005 phase A2, #2007; ADR 0118,
 * shared/contract/compute-admin.ts): every schema it exports is a RESPONSE the command-line
 * interface (CLI) parses, so every one must accept and keep a key it does not know, at the top
 * level and in every object below, or a released CLI breaks the day the Worker adds one.
 *
 * Checked by behaviour, like the strict compute files are in contract-schemas.test.ts: a document
 * with an unknown key added to EVERY object in it must parse, and come out with the keys still on
 * it. A new export that is not in the table below fails the first test, so it is classified on
 * purpose and not by accident; the words and the constants it exports are not schemas and are
 * checked on their own.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { PIPELINE_CELL_MARKS, PIPELINE_RUN_STATUSES } from "../shared/compute-checkpoints";
import { COMPUTE_RECIPES, PIPELINE_STAMP_STATES } from "../shared/compute-recipes";
import { COMPUTE_REFUSAL_CODES, COMPUTE_REFUSAL_STATUS } from "../shared/compute-state";
import * as admin from "../shared/contract/compute-admin";

const pool = {
  id: 7,
  holder_kind: "account",
  holder_ref: "12",
  pool: "cpu",
  granted_milli: 12500,
  held_milli: 0,
  charged_milli: 0,
  available_milli: 12500,
  frozen: false,
  created_at: "2026-11-04 10:00:00",
  updated_at: "2026-11-04 10:00:00",
};

const entry = {
  id: 3,
  kind: "grant",
  pool_id: 7,
  budget_pool_id: null,
  granted_delta_milli: 12500,
  held_delta_milli: 0,
  charged_delta_milli: 0,
  job_id: null,
  hold_ref: null,
  reason: "admin_grant",
  actor_user_id: 1,
  created_at: "2026-11-04 10:00:00",
};

const job = {
  id: "job_0123456789abcdef01234567",
  account_id: 12,
  source: "cli",
  kind: "batch",
  state: "failed",
  tapis_status: "FAILED",
  failure_code: "launch_failed",
  failure_detail: null,
  platform_failure: true,
  cancel_requested: false,
  cancel_reason: null,
  partition: "shared",
  pool: "cpu",
  held_milli: 4000,
  charged_milli: 2000,
  settled: true,
  flags: ["mismatch"],
  created_at: "2026-11-04 10:00:00",
  submitted_at: "2026-11-04 10:00:05",
  started_at: null,
  ended_at: "2026-11-04 10:30:00",
  tapis_synced_at: "2026-11-04 10:30:01",
  outputs_completed: false,
  results_verified: false,
  results_bytes: null,
  records_copied: true,
};

const pipelineResult = {
  dataset_id: "nm000104",
  ok: true,
  version: "v1.0.0",
  job_id: "job_0123456789abcdef01234567",
  stamp_id: 4,
  attempt: 1,
  submit: "submitted",
};

const pipelineStamp = {
  id: 4,
  dataset_id: "nm000104",
  version: "v1.0.0",
  recipe: "nemar-floor",
  recipe_version: "1.0.0",
  engine: "eegprep@0.5.0",
  attempt: 1,
  state: "dispatched",
  job_id: "job_0123456789abcdef01234567",
  refusal_code: null,
  created_at: "2026-11-05 10:00:00",
  updated_at: "2026-11-05 10:00:00",
};

const hold = {
  id: 3,
  scope: "job",
  ref: "job_0123456789abcdef01234567",
  reason: "legal_request",
  placed_by: 1,
  placed_at: "2026-11-05 10:00:00",
  released_at: null,
};

/** A valid document for each exported schema. */
const pipelineRun = {
  stamp_id: 12,
  dataset_id: "nm000104",
  recipe: "nemar-floor",
  version: "v1.0.0",
  current_version: true,
  recipe_version: "1.0.0-b1",
  engine: "eegprep@0.5.0",
  input: "zarr",
  attempt: 1,
  stamp_state: "succeeded",
  code: null,
  job_id: "job_0123456789abcdef01234567",
  job_state: "finished",
  executor: "runner",
  runner_id: "rnr_0123456789abcdef01234567",
  runner_name: "ws_b",
  checkpoint: "quality",
  reported_at: "2026-11-23 09:00:00",
  reports: 7,
  reconciled: true,
  outcome: "reconciled",
  disagreement: false,
  created_at: "2026-11-23 08:00:00",
  updated_at: "2026-11-23 09:05:00",
};

const pipelineCell = {
  mark: "failed",
  counts: { passed: 3, failed: 1, skipped: 0, total: 4 },
  reconciled: true,
  disagreement: false,
  listed: 1,
};

const pipelineGridRow = {
  dataset_id: "nm000104",
  newest_version: "1.0.0",
  status: "finished",
  run: pipelineRun,
  cells: { import: pipelineCell, stored: { ...pipelineCell, mark: "pending", counts: null } },
};

const pipelineByStatus = {
  not_started: 0,
  waiting: 0,
  running: 0,
  stalled: 0,
  finished: 1,
  failed: 0,
};

const pipelineSummary = {
  recipe: "nemar-floor",
  recipe_version: "1.0.0-b1",
  placeholder: false,
  auto_dispatch: true,
  columns: ["import", "preprocess", "quality", "stored"],
  eligible: 3,
  covered: 1,
  complete: 0,
  covered_any_version: 1,
  by_status: pipelineByStatus,
};

const VALID: Record<string, unknown> = {
  ComputeJobsListResponseSchema: { jobs: [job, job], next_after: 41 },
  ComputeUnmatchedResponseSchema: {
    rows: [
      {
        slurm_job_id: "12345",
        partition: "shared",
        state: "COMPLETED",
        elapsed_seconds: 600,
        alloc_nodes: 1,
        alloc_cpus: 4,
        alloc_gpus: 0,
        charged_milli: null,
        ingested_at: "2026-11-05 03:00:00",
      },
    ],
    total: 1,
  },
  ComputeRecordResponseSchema: {
    job,
    identifiers: { tapis_uuid: "u-1", slurm_job_id: "12345" },
    ledger: [{ id: 1, kind: "hold" }],
    provenance: { image: { digest: "sha256:abc" } },
    provenance_status: "ok",
    manifest: { files: 2, bytes: 100 },
    manifest_status: "ok",
    legal_hold: false,
    retention_until: "2033-11-05 10:00:00",
    launcher_files: ["result.json", "provenance.json"],
  },
  ComputeRecordReadResponseSchema: {
    job_id: "job_0123456789abcdef01234567",
    name: "spec.json",
    kind: "bytes",
    content: { name: "x" },
  },
  ComputeAccountReportResponseSchema: {
    account_id: 12,
    from: "2026-10-01",
    to: "2026-10-31",
    totals: { jobs: 2, charged_milli: 5000 },
    by_pool: { cpu: { jobs: 2, charged_milli: 5000 } },
    // Runner jobs, apart from the service units above (card S6).
    runner_totals: {
      jobs: 3,
      wall_seconds: 420,
      cpu_seconds: 7600,
      core_hours: 2.111,
      reported_jobs: 2,
      partial_jobs: 1,
      unmarked_jobs: 0,
    },
    jobs: [{ id: "job_0123456789abcdef01234567" }],
    truncated: false,
  },
  ComputeRunnersUsageResponseSchema: {
    from: "2026-10-01",
    to: "2026-10-31",
    runners: [
      {
        id: `rnr_${"a".repeat(24)}`,
        name: "lab_a_cpu",
        site: "lab_a",
        trust: "lab",
        revoked: false,
        jobs: 3,
        by_state: { finished: 1, failed: 1, created: 1 },
        wall_seconds: 420,
        cpu_seconds: 7600,
        core_hours: 2.111,
        max_rss_mb: 4096,
        reported_jobs: 2,
        partial_jobs: 1,
        unmarked_jobs: 0,
      },
    ],
    totals: {
      jobs: 3,
      wall_seconds: 420,
      cpu_seconds: 7600,
      core_hours: 2.111,
      reported_jobs: 2,
      partial_jobs: 1,
      unmarked_jobs: 0,
    },
  },
  ComputeAccessReportResponseSchema: {
    quarter: "2026Q4",
    rows: [{ partition: "shared", source: "cli", distinct_users: 2, jobs: 5 }],
    totals: { distinct_users: 2, jobs: 5 },
  },
  ComputeHoldViewSchema: hold,
  ComputeHoldsResponseSchema: { holds: [hold], truncated: false },
  ComputeHoldResponseSchema: { hold },
  ComputeAccessReportsResponseSchema: {
    rows: [
      {
        job_id: "job_0123456789abcdef01234567",
        state: "failed",
        attempts: 1,
        last_error_code: "outcome_unknown",
        next_attempt_at: "2026-11-05 10:00:00",
        sent_at: null,
        created_at: "2026-11-05 09:00:00",
      },
    ],
    failed_by_word: { outcome_unknown: 1 },
    next_after: null,
  },
  ComputeRequeueResponseSchema: {
    ok: true,
    job_id: "job_0123456789abcdef01234567",
    previous: "outcome_unknown",
  },
  ComputeMoveChargeResponseSchema: {
    job_id: "job_0123456789abcdef01234567",
    to_account_id: 5,
    pool: "cpu",
    moved_milli: 2000,
    replayed: false,
  },
  ComputeObserverRunResponseSchema: {
    run_id: "11111111-2222-3333-4444-555555555555",
    token: "x.y",
    expires_in_minutes: 60,
  },
  ComputePipelineCountsSchema: { passed: 3, failed: 1, skipped: 0, total: 4 },
  ComputePipelineRunViewSchema: pipelineRun,
  ComputePipelineCellSchema: pipelineCell,
  ComputePipelineGridRowSchema: pipelineGridRow,
  ComputePipelineRecipeSummarySchema: pipelineSummary,
  ComputePipelineGridResponseSchema: {
    as_of: "2026-11-23 10:00:00",
    stalled_after_seconds: 180,
    recipe: "nemar-floor",
    columns: ["import", "preprocess", "quality", "stored"],
    summary: pipelineSummary,
    matched: { total: 1, by_status: pipelineByStatus },
    facets: {
      recipe_versions: ["1.0.0-b1"],
      runners: [{ id: "rnr_0123456789abcdef01234567", name: "ws_b" }],
    },
    rows: [pipelineGridRow, { ...pipelineGridRow, status: "not_started", run: null }],
    next_after: "nm000104",
  },
  ComputePipelineTrendPointSchema: { at: "2026-11-22", value: 1, total: 4 },
  ComputePipelineCoverageResponseSchema: {
    as_of: "2026-11-23 10:00:00",
    days: 30,
    recipes: [{ ...pipelineSummary, trend: [{ at: "2026-11-22", value: 1, total: 4 }] }],
  },
  ComputePipelineRunDetailResponseSchema: {
    status: "finished",
    newest_version: "1.0.0",
    run: pipelineRun,
    checkpoints: [
      {
        checkpoint: "import",
        mark: "failed",
        counts: { passed: 3, failed: 1, skipped: 0, total: 4 },
        live: null,
        reconciled: true,
        disagreement: false,
        reported_at: "2026-11-23 09:00:00",
        failures: [{ path: "sub-02/eeg/b.edf", code: "load_failed", step: "load" }],
        listed: 1,
        unlisted: 0,
        failures_unreadable: false,
      },
    ],
    listed_codes: [{ checkpoint: "import", code: "load_failed", count: 1 }],
  },
  ComputeRunQualityResponseSchema: {
    stamp_id: 7,
    dataset_id: "nm000104",
    version: "v1.0.0",
    recipe: "nemar-ica",
    recipe_version: "1.0.0",
    input: "bids",
    stamp_state: "succeeded",
    dataset_public: true,
    quality: "canary",
    skip: null,
    derivative: {
      key: "a".repeat(64),
      state: "stored",
      retention: "canary",
      failure: null,
      created_at: "2026-11-20 09:00:00",
      stored_at: "2026-11-20 10:00:00",
      expires_at: "2026-12-20 10:00:00",
      superseded_at: null,
      serving_index: "none",
    },
    recordings: {
      state: "listed",
      succeeded: 1,
      unlisted: 0,
      items: [{ path: "sub-01/eeg/sub-01_task-rest_eeg.edf" }],
      next_after: null,
    },
  },
  ComputePipelineResultSchema: pipelineResult,
  ComputePipelineRoomSchema: { daily_left: 4, live_left: 0, limited_by: "live_cap" },
  ComputePipelineStampViewSchema: pipelineStamp,
  ComputePipelineStatusResponseSchema: { stamps: [pipelineStamp], next_before: null },
  ComputePipelineRunResponseSchema: {
    ok: true,
    dry_run: false,
    recipe: "nemar-floor",
    results: [pipelineResult, { dataset_id: "nm000105", ok: false, code: "live_attempt_exists" }],
    dispatched: 1,
    stopped_by: null,
    estimate_milli_per_job: 48000,
    estimate_milli_total: 96000,
    config: { compute_enabled: true, runtime_image: true, pipelines_account: true },
    would_dispatch: [{ dataset_id: "nm000104", version: "v1.0.0" }],
    blocked: { code: "dataset_not_eligible", blocked_by: ["public"], version: "v1.0.0" },
    blocked_by_term: { public: 3, eeg: 1 },
  },
  ComputeStatusResponseSchema: {
    switches: {
      environment: "production",
      compute_enabled: false,
      pipelines_dispatch_enabled: false,
    },
    tapis: {
      configured: false,
      strategy: null,
      problems: ["TAPIS_AUTH_STRATEGY:missing"],
      token: "unconfigured",
      health: "unconfigured",
    },
    storage: { records_binding: true, results_binding: true, signing_configured: false },
    access: { key_configured: false, resource_name_configured: false },
    runtime_image: { set: true, valid: true, digest: `sha256:${"a".repeat(64)}` },
    prerequisites: {
      callback_secret: true,
      api_base_url: true,
      pipelines_account: false,
      policy_set: true,
      people_pool_granted: true,
      pipelines_pool_granted: false,
    },
    reconciliation: { paused: true },
    attention: { access_reports_failed: 2 },
  },
  ComputePoolViewSchema: pool,
  ComputeLedgerEntryViewSchema: entry,
  ComputePoolsResponseSchema: { pools: [pool, pool], next_after: null },
  ComputeAccountPoolsResponseSchema: { account_id: 12, pools: [pool] },
  ComputePoolWriteResponseSchema: { pool, entry, replayed: false },
  ComputeJobViewSchema: job,
  ComputeJobAdminResponseSchema: { ok: true, outcome: "advanced", submit: "submitted", job },
  ComputePolicyResponseSchema: {
    version: 2,
    is_default: false,
    policy: { defaultGrantMilli: { cpu: 1, gpu: 2 }, registries: ["ghcr.io/team"] },
    set_by: 1,
    note: null,
    created_at: "2026-11-04 10:00:00",
  },
};

/** The same document with an unknown key on every object in it, nested ones and array items too. */
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
  Object.entries(admin).filter((e): e is [string, z.ZodTypeAny] => e[1] instanceof z.ZodType);

describe("compute-admin: every exported schema is open", () => {
  test("every schema it exports is classified here, and nothing here is gone", () => {
    expect(
      schemas()
        .map(([n]) => n)
        .sort(),
    ).toEqual(Object.keys(VALID).sort());
  });

  for (const name of Object.keys(VALID)) {
    test(`${name} accepts the valid document, and the same document with an unknown key on every object`, () => {
      const schema = (admin as Record<string, unknown>)[name] as z.ZodTypeAny;
      const valid = VALID[name];
      expect(schema.safeParse(valid).success).toBe(true);
      const extended = withUnknownEverywhere(valid);
      const parsed = schema.safeParse(extended);
      expect([name, parsed.success]).toEqual([name, true]);
      // Kept, not stripped: a client that learns about a key later needs no schema change.
      if (parsed.success) expect(parsed.data).toEqual(extended);
    });
  }

  test("the behaviour test can tell: a closed schema would refuse the extended document", () => {
    const closed = z.object({ id: z.number() }).strict();
    expect(closed.safeParse(withUnknownEverywhere({ id: 1 })).success).toBe(false);
    const stripping = z.object({ id: z.number() });
    const out = stripping.parse(withUnknownEverywhere({ id: 1 }));
    expect(out).not.toEqual(withUnknownEverywhere({ id: 1 }));
  });

  test("a word the Worker may grow is a string in a response, not an enum", () => {
    const grown = { ...pool, holder_kind: "tenant", pool: "tpu" };
    expect(admin.ComputePoolViewSchema.safeParse(grown).success).toBe(true);
    expect(admin.ComputeLedgerEntryViewSchema.safeParse({ ...entry, kind: "waive" }).success).toBe(
      true,
    );
  });

  test("a status answer from a Worker that predates `runtime_image` still parses, and its absence is kept as absence", () => {
    const old = JSON.parse(JSON.stringify(VALID.ComputeStatusResponseSchema)) as Record<
      string,
      unknown
    >;
    old.runtime_image = undefined;
    const parsed = admin.ComputeStatusResponseSchema.parse(old);
    expect(parsed.runtime_image).toBeUndefined();
    // A malformed one is refused, not guessed.
    expect(
      admin.ComputeStatusResponseSchema.safeParse({ ...old, runtime_image: { set: "yes" } })
        .success,
    ).toBe(false);
  });

  test("an account report and a job view from a Worker that predate the runner report still parse, and a malformed one is refused", () => {
    const old = JSON.parse(JSON.stringify(VALID.ComputeAccountReportResponseSchema)) as Record<
      string,
      unknown
    >;
    old.runner_totals = undefined;
    expect(admin.ComputeAccountReportResponseSchema.parse(old).runner_totals).toBeUndefined();
    expect(
      admin.ComputeAccountReportResponseSchema.safeParse({ ...old, runner_totals: { jobs: "3" } })
        .success,
    ).toBe(false);
    // A Worker that predates the reported and unmarked counts sends the totals without them.
    const counted = JSON.parse(JSON.stringify(VALID.ComputeRunnersUsageResponseSchema)) as {
      runners: Array<Record<string, unknown>>;
      totals: Record<string, unknown>;
    };
    for (const target of [...counted.runners, counted.totals]) {
      target.reported_jobs = undefined;
      target.unmarked_jobs = undefined;
    }
    expect(admin.ComputeRunnersUsageResponseSchema.safeParse(counted).success).toBe(true);
    // The mark is true, false or null; a Worker that predates it sends none.
    const view = JSON.parse(JSON.stringify(VALID.ComputeJobViewSchema)) as Record<string, unknown>;
    expect(admin.ComputeJobViewSchema.parse(view).runner_usage_partial).toBeUndefined();
    for (const mark of [true, false, null]) {
      expect(
        admin.ComputeJobViewSchema.parse({ ...view, runner_usage_partial: mark })
          .runner_usage_partial,
      ).toBe(mark);
    }
    expect(admin.ComputeJobViewSchema.safeParse({ ...view, runner_usage_partial: 1 }).success).toBe(
      false,
    );
  });

  test("a status answer from a Worker that predates `resource_name_configured` still parses, and its absence is kept as absence", () => {
    const old = JSON.parse(JSON.stringify(VALID.ComputeStatusResponseSchema)) as {
      access: Record<string, unknown>;
    };
    old.access.resource_name_configured = undefined;
    const parsed = admin.ComputeStatusResponseSchema.parse(old);
    expect(parsed.access.resource_name_configured).toBeUndefined();
    expect(parsed.access.key_configured).toBe(false);
    // A malformed one is refused, not guessed.
    expect(
      admin.ComputeStatusResponseSchema.safeParse({
        ...old,
        access: { key_configured: true, resource_name_configured: "yes" },
      }).success,
    ).toBe(false);
  });

  test("the pipeline refusal statuses are the ledger's plus the pipeline's own, each declared once", () => {
    const table = admin.COMPUTE_PIPELINE_REFUSAL_STATUS;
    // Every ledger word keeps the status the ledger gives it: nothing is copied and then allowed to drift.
    for (const code of COMPUTE_REFUSAL_CODES) {
      expect([code, table[code]]).toEqual([code, COMPUTE_REFUSAL_STATUS[code]]);
    }
    // The pipeline's own words are not also the ledger's (a status in two places is the drift this prevents).
    for (const code of Object.keys(admin.COMPUTE_PIPELINE_ONLY_REFUSAL_STATUS)) {
      expect([code, (COMPUTE_REFUSAL_CODES as readonly string[]).includes(code)]).toEqual([
        code,
        false,
      ]);
    }
    // `run_failed` is a word a run stops with, so it has a status, and not the 422 a missing one used to get.
    expect(table.run_failed).toBe(500);
    expect(table.registry_drift).toBe(409);
    expect(table.tapis_unconfigured).toBe(503);
    expect(table.daily_cap_reached).toBe(409);
    expect(table.version_not_found).toBe(404);
    expect(Object.keys(table).length).toBe(
      COMPUTE_REFUSAL_CODES.length + Object.keys(admin.COMPUTE_PIPELINE_ONLY_REFUSAL_STATUS).length,
    );
  });

  test("a run's room names what bounded it, from one list; the per-invocation bound is 10", () => {
    expect([...admin.COMPUTE_PIPELINE_LIMITED_BY]).toEqual([
      "limit",
      "per_invocation",
      "daily_cap",
      "live_cap",
      "tenant",
    ]);
    expect(admin.COMPUTE_PIPELINE_RUN_PER_INVOCATION).toBe(10);
    const room = { daily_left: 4, live_left: 0, limited_by: "live_cap" };
    const run = { ok: true, dry_run: false, recipe: "nemar-floor", room };
    expect(admin.ComputePipelineRunResponseSchema.safeParse(run).success).toBe(true);
    // The tenant ceiling's room (issue #2121) is optional and a whole number, so an older Worker still reads.
    const tenantRoom = { daily_left: 4, live_left: 3, tenant_left: 0, limited_by: "tenant" };
    expect(
      admin.ComputePipelineRunResponseSchema.safeParse({ ...run, room: tenantRoom }).success,
    ).toBe(true);
    expect(
      admin.ComputePipelineRunResponseSchema.safeParse({
        ...run,
        room: { ...tenantRoom, tenant_left: "0" },
      }).success,
    ).toBe(false);
    // A response without a room (a named dataset, an older Worker) still reads.
    expect(
      admin.ComputePipelineRunResponseSchema.safeParse({ ok: true, dry_run: true, recipe: "x" })
        .success,
    ).toBe(true);
    expect(
      admin.ComputePipelineRunResponseSchema.safeParse({ ...run, room: { daily_left: "4" } })
        .success,
    ).toBe(false);
  });

  test("the stamp states the CLI filters by are the registry's list, in its order", () => {
    expect([...admin.COMPUTE_PIPELINE_STAMP_STATES]).toEqual([...PIPELINE_STAMP_STATES]);
    expect(admin.COMPUTE_PIPELINE_STAMP_STATES).toBe(PIPELINE_STAMP_STATES);
  });

  test("the file declares no closed schema at all", () => {
    const text = readFileSync(
      join(import.meta.dir, "..", "shared", "contract", "compute-admin.ts"),
      "utf8",
    );
    expect(text.includes(".strict(")).toBe(false);
  });
});

describe("compute-admin: the words and constants", () => {
  test("the platform keys are the two budgets, and the named constants are in them", () => {
    expect([...admin.COMPUTE_PLATFORM_KEYS]).toEqual(["pipelines", "people"]);
    expect(admin.COMPUTE_PIPELINES_BUDGET).toBe("pipelines");
    expect(admin.COMPUTE_PEOPLE_BUDGET).toBe("people");
    for (const k of admin.COMPUTE_PLATFORM_KEYS) expect(admin.isComputePlatformKey(k)).toBe(true);
    for (const k of ["", "People", "tenant", "pipelines ", "__proto__", "toString"]) {
      expect([k, admin.isComputePlatformKey(k)]).toEqual([k, false]);
    }
  });

  test("every error word has a status, and no status is outside 400 to 599", () => {
    expect(Object.keys(admin.COMPUTE_ADMIN_ERROR_STATUS).sort()).toEqual(
      [...admin.COMPUTE_ADMIN_ERROR_CODES].sort(),
    );
    for (const status of Object.values(admin.COMPUTE_ADMIN_ERROR_STATUS)) {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
    expect(admin.COMPUTE_ADMIN_ERROR_STATUS.would_exceed_limit).toBe(409);
  });

  test("one request moves at most 2^40 milli-SU, far below the largest exact total", () => {
    expect(admin.COMPUTE_REQUEST_MILLI_MAX).toBe(2 ** 40);
    expect(admin.COMPUTE_REQUEST_MILLI_MAX).toBeLessThan(Number.MAX_SAFE_INTEGER / 1000);
  });

  test("the header key takes 8 to 100 letters, digits and . _ - and fits the table with its prefix", () => {
    const ok = ["abcdefgh", "k".repeat(100), "a.b_c-d.e", "0123456789"];
    const no = ["abcdefg", "k".repeat(101), "has space", "a:b:c:d:e", "a/b/c/d/e", "ünïcode-key"];
    for (const k of ok) expect([k, admin.COMPUTE_IDEMPOTENCY_KEY_RE.test(k)]).toEqual([k, true]);
    for (const k of no) expect([k, admin.COMPUTE_IDEMPOTENCY_KEY_RE.test(k)]).toEqual([k, false]);
  });
});

describe("the pipeline grid's words and bounds", () => {
  const source = readFileSync(join(import.meta.dir, "../shared/contract/compute-admin.ts"), "utf8");

  test("the grid statuses are `not_started` and then what a run shows", () => {
    expect([...admin.COMPUTE_PIPELINE_GRID_STATUSES]).toEqual([
      "not_started",
      ...PIPELINE_RUN_STATUSES,
    ]);
  });

  test("the cell marks are the marks pipelineCellMark gives", () => {
    expect([...admin.COMPUTE_PIPELINE_CELL_MARKS]).toEqual([...PIPELINE_CELL_MARKS]);
  });

  test("the recipe version pattern takes the registry's versions and refuses others", () => {
    for (const r of COMPUTE_RECIPES) {
      expect(admin.COMPUTE_PIPELINE_RECIPE_VERSION_RE.test(r.version)).toBe(true);
    }
    for (const bad of ["", "1.0 0", "a/b", "x".repeat(65)]) {
      expect(admin.COMPUTE_PIPELINE_RECIPE_VERSION_RE.test(bad)).toBe(false);
    }
  });

  test("the bounds are ordered", () => {
    expect(admin.COMPUTE_PIPELINE_GRID_PAGE_DEFAULT).toBeLessThanOrEqual(
      admin.COMPUTE_PIPELINE_GRID_PAGE_MAX,
    );
    expect(admin.COMPUTE_PIPELINE_TREND_DAYS_DEFAULT).toBeLessThanOrEqual(
      admin.COMPUTE_PIPELINE_TREND_DAYS_MAX,
    );
  });

  test("every word list and bound is a literal the website's drift tests can read from the text", () => {
    for (const name of [
      "COMPUTE_PIPELINE_GRID_STATUSES",
      "COMPUTE_PIPELINE_CELL_MARKS",
      "COMPUTE_PIPELINE_RUN_OUTCOMES",
      "COMPUTE_RUN_QUALITY_STATES",
      "COMPUTE_RUN_QUALITY_RECORDINGS_STATES",
    ]) {
      const m = source.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const;`));
      expect([name, m !== null]).toEqual([name, true]);
      const words = [...(m?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((w) => w[1]);
      expect(words).toEqual([...(admin as unknown as Record<string, readonly string[]>)[name]]);
    }
    for (const name of [
      "COMPUTE_PIPELINE_GRID_PAGE_DEFAULT",
      "COMPUTE_PIPELINE_GRID_PAGE_MAX",
      "COMPUTE_PIPELINE_TREND_DAYS_DEFAULT",
      "COMPUTE_PIPELINE_TREND_DAYS_MAX",
      "COMPUTE_RUN_QUALITY_PAGE_SIZE",
    ]) {
      const m = source.match(new RegExp(`export const ${name} = ([0-9]+);`));
      expect([name, Number(m?.[1])]).toEqual([
        name,
        (admin as unknown as Record<string, number>)[name],
      ]);
    }
  });

  test("a run's quality: a page is 100 recordings, and the stored words are the ones a table is read for", () => {
    expect(admin.COMPUTE_RUN_QUALITY_PAGE_SIZE).toBe(100);
    expect(new Set(admin.COMPUTE_RUN_QUALITY_STATES).size).toBe(
      admin.COMPUTE_RUN_QUALITY_STATES.length,
    );
    expect(admin.COMPUTE_RUN_QUALITY_RECORDINGS_STATES[0]).toBe("listed");
  });

  test("a drill-down of a stamp that does not exist is 404 stamp_not_found", () => {
    expect(admin.COMPUTE_ADMIN_ERROR_STATUS.stamp_not_found).toBe(404);
  });
});
