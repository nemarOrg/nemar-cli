/**
 * Publication progress reporting tests (issue #284).
 *
 * Two surfaces covered:
 *  1. `stepIndexFor` — pure helper that maps a step name to its 1-based
 *     position in the canonical orchestrator step list. Falls back to
 *     `stepsCompleted.length + 1` when the step name isn't recognised so
 *     newer server-side steps degrade gracefully on older CLIs.
 *  2. `approvePublication` — emits `onProgress` events on step
 *     transitions and on every s3_lock batch with running locked/total
 *     counters threaded back to the server so it doesn't have to re-count.
 *
 * Backend interaction uses a real Bun.serve fake (no mocks, per project
 * policy) so the request/response contract is exercised end-to-end.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./setup";
import {
  PUBLICATION_STEPS,
  type PublishProgressInfo,
  approvePublication,
  stepIndexFor,
} from "../src/lib/api";
import { setConfig } from "../src/lib/config";

// --------------------------------------------------------------------------
// stepIndexFor — pure helper
// --------------------------------------------------------------------------

describe("stepIndexFor", () => {
  test("returns 1-based index for a known step", () => {
    expect(stepIndexFor("ci_check")).toBe(1);
    expect(stepIndexFor("s3_lock")).toBe(14);
    expect(stepIndexFor("notify_user")).toBe(PUBLICATION_STEPS.length);
  });

  test("falls back to stepsCompleted.length + 1 when step name is unknown", () => {
    // Server might add a step the CLI doesn't know about yet; fall back
    // to where the orchestrator says it is rather than failing.
    expect(stepIndexFor("brand_new_step", ["ci_check", "enrichment_check"])).toBe(3);
  });

  test("falls back to stepsCompleted.length + 1 when step is undefined", () => {
    expect(stepIndexFor(undefined, ["ci_check"])).toBe(2);
    expect(stepIndexFor(undefined, [])).toBe(1);
  });

  test("clamps fallback to step total so out-of-range completion doesn't overflow", () => {
    // If something writes 99 step names to steps_completed (corrupted
    // resume payload), don't render "Step 100/17".
    const overlong = new Array(99).fill("ci_check");
    expect(stepIndexFor(undefined, overlong)).toBe(PUBLICATION_STEPS.length);
  });

  test("PUBLICATION_STEPS list is the expected 17 backend steps", () => {
    // Locks in the contract: the CLI's list must match
    // `allSteps` in backend/src/routes/admin.ts. Update both together.
    expect(PUBLICATION_STEPS).toEqual([
      "ci_check",
      "enrichment_check",
      "repo_public",
      "s3_public_read",
      "tag_protect",
      "doi_create",
      "update_metadata",
      "update_readme",
      "create_tag",
      "create_release",
      "upload_to_zenodo",
      "publish_doi",
      "version_doi",
      "s3_lock",
      "generate_archive",
      "sync_nemar",
      "notify_user",
    ]);
  });
});

// --------------------------------------------------------------------------
// approvePublication onProgress — real Bun.serve fake backend
// --------------------------------------------------------------------------

interface FakeApproveCall {
  body: {
    resume?: boolean;
    sandbox?: boolean;
    s3_lock_continuation_token?: string;
    s3_lock_total?: number;
    skip_ci_check?: boolean;
  };
}

interface FakeApproveServer {
  url: string;
  port: number;
  calls: FakeApproveCall[];
  stop: () => Promise<void>;
}

/**
 * Bring up a tiny HTTP server that records every approve call and
 * responds with a scripted sequence. Mirrors the response contract from
 * `backend/src/routes/admin.ts` so the real request/response shape is
 * exercised, not a hand-rolled mock.
 */
function startFakeApproveServer(
  datasetId: string,
  responses: Array<Record<string, unknown>>,
): FakeApproveServer {
  const calls: FakeApproveCall[] = [];
  let respIdx = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== `/admin/publish/${datasetId}/approve` || req.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      const body = (await req.json()) as FakeApproveCall["body"];
      calls.push({ body });
      const resp = responses[Math.min(respIdx, responses.length - 1)];
      respIdx++;
      return new Response(JSON.stringify(resp), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    port: server.port,
    calls,
    stop: async () => {
      server.stop(true);
    },
  };
}

const DATASET = "nm099284";
let fake: FakeApproveServer | null = null;
const originalTestApiUrl = process.env.TEST_API_URL;

beforeAll(() => {
  // Set an apiKey so request(..., authenticated=true) won't bail before
  // making the call. The fake doesn't validate the token.
  setConfig("apiKey", "test-token-284");
});

beforeEach(() => {
  if (fake) {
    void fake.stop();
    fake = null;
  }
});

afterEach(async () => {
  if (fake) {
    await fake.stop();
    fake = null;
  }
  // Clean up the env var so it doesn't leak into other suites.
  if (originalTestApiUrl === undefined) delete process.env.TEST_API_URL;
  else process.env.TEST_API_URL = originalTestApiUrl;
});

afterAll(() => {
  if (originalTestApiUrl === undefined) delete process.env.TEST_API_URL;
  else process.env.TEST_API_URL = originalTestApiUrl;
});

describe("approvePublication onProgress", () => {
  test("emits a progress event on completion with the final step", async () => {
    fake = startFakeApproveServer(DATASET, [
      {
        message: "Published",
        dataset_id: DATASET,
        status: "published",
        step_results: [
          { step: "ci_check", status: "completed", attempts: 1, duration_ms: 10 },
          { step: "enrichment_check", status: "completed", attempts: 1, duration_ms: 5 },
          { step: "s3_lock", status: "completed", attempts: 1, duration_ms: 100 },
          { step: "notify_user", status: "completed", attempts: 1, duration_ms: 8 },
        ],
        steps_completed: ["ci_check", "enrichment_check", "s3_lock", "notify_user"],
      },
    ]);
    process.env.TEST_API_URL = fake.url;

    const events: PublishProgressInfo[] = [];
    await approvePublication(DATASET, false, false, false, undefined, (info) => {
      events.push(info);
    });

    // The "step" on a non-hasMore response is the *last* completed step,
    // so we see at least one event. The contract is "no progress lost on
    // success"; the final emit must reference the final step.
    expect(events.length).toBeGreaterThanOrEqual(1);
    const last = events[events.length - 1];
    expect(last.step).toBe("notify_user");
    expect(last.stepIndex).toBe(PUBLICATION_STEPS.length);
    expect(last.stepTotal).toBe(PUBLICATION_STEPS.length);
  });

  test("emits s3_lock progress with running locked/total across pages", async () => {
    // Three-page s3_lock stream: 40 + 40 + 20 locked of 100 total.
    fake = startFakeApproveServer(DATASET, [
      {
        message: "S3 lock in progress: 40 locked in this batch",
        step: "s3_lock",
        steps_completed: ["ci_check", "enrichment_check"],
        step_results: [],
        s3_lock_continuation_token: "tok-page-2",
        s3_lock_total: 100,
        s3_lock_batch_count: 40,
        hasMore: true,
      },
      {
        message: "S3 lock in progress: 40 locked in this batch",
        step: "s3_lock",
        steps_completed: ["ci_check", "enrichment_check"],
        step_results: [],
        s3_lock_continuation_token: "tok-page-3",
        s3_lock_total: 100,
        s3_lock_batch_count: 40,
        hasMore: true,
      },
      {
        message: "Published",
        dataset_id: DATASET,
        status: "published",
        step_results: [{ step: "s3_lock", status: "completed", attempts: 1, duration_ms: 300 }],
        steps_completed: [...PUBLICATION_STEPS],
        s3_lock_total: 100,
        s3_lock_batch_count: 20,
      },
    ]);
    process.env.TEST_API_URL = fake.url;

    const events: PublishProgressInfo[] = [];
    await approvePublication(DATASET, false, false, false, undefined, (info) => {
      events.push(info);
    });

    const s3Events = events.filter((e) => e.step === "s3_lock");
    // One event per page response with cumulative locked counters.
    expect(s3Events.length).toBe(3);
    expect(s3Events[0].s3LockLocked).toBe(40);
    expect(s3Events[0].s3LockTotal).toBe(100);
    expect(s3Events[1].s3LockLocked).toBe(80);
    expect(s3Events[2].s3LockLocked).toBe(100);
    // stepIndex stays anchored on the s3_lock position (14/17) the whole
    // time so the spinner doesn't jump backwards as completed steps fall
    // off the steps_completed window.
    for (const e of s3Events) {
      expect(e.stepIndex).toBe(14);
      expect(e.stepTotal).toBe(PUBLICATION_STEPS.length);
    }
  });

  test("threads s3_lock_total back to the server so it doesn't re-count per page", async () => {
    // Server returns total once (on the first response); CLI must echo
    // it on every follow-up request so the orchestrator can skip the
    // counting LIST sweep on subsequent invocations.
    fake = startFakeApproveServer(DATASET, [
      {
        message: "batch 1",
        step: "s3_lock",
        steps_completed: [],
        step_results: [],
        s3_lock_continuation_token: "tok-2",
        s3_lock_total: 4963,
        s3_lock_batch_count: 100,
        hasMore: true,
      },
      {
        message: "batch 2",
        step: "s3_lock",
        steps_completed: [],
        step_results: [],
        s3_lock_total: 4963,
        s3_lock_batch_count: 100,
      },
    ]);
    process.env.TEST_API_URL = fake.url;

    await approvePublication(DATASET, true);

    expect(fake.calls.length).toBe(2);
    // First call: CLI hasn't been told the total yet.
    expect(fake.calls[0].body.s3_lock_total).toBeUndefined();
    expect(fake.calls[0].body.s3_lock_continuation_token).toBeUndefined();
    // Second call: total threaded back so server can skip the count sweep.
    expect(fake.calls[1].body.s3_lock_total).toBe(4963);
    expect(fake.calls[1].body.s3_lock_continuation_token).toBe("tok-2");
  });

  test("calls without onProgress don't throw and still drive pagination", async () => {
    fake = startFakeApproveServer(DATASET, [
      {
        message: "batch 1",
        step: "s3_lock",
        steps_completed: [],
        step_results: [],
        s3_lock_continuation_token: "tok-x",
        s3_lock_total: 50,
        s3_lock_batch_count: 25,
        hasMore: true,
      },
      {
        message: "ok",
        step_results: [],
        s3_lock_total: 50,
        s3_lock_batch_count: 25,
      },
    ]);
    process.env.TEST_API_URL = fake.url;

    // No onProgress argument — must not throw and must still page.
    await approvePublication(DATASET, false);
    expect(fake.calls.length).toBe(2);
  });
});
