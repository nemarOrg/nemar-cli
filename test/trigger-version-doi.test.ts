/**
 * Unit tests for `triggerVersionDoiRun` — the helper that POSTs
 * `repository_dispatch[run-version-doi]` to nemarDatasets/.github.
 *
 * Mirrors trigger-enrichment.test.ts (Phase 1) one-for-one. Phase 2 of
 * epic #601 / sub-issue #606.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./setup";
import { triggerVersionDoiRun } from "../backend/src/services/github";
import { type FakeGithubServer, startFakeGithub } from "./helpers/fetch-counter";

const DISPATCH_PATH = "/repos/nemarDatasets/.github/dispatches";

let fake: FakeGithubServer;
let nextResponse: () => Response = () => new Response(null, { status: 204 });

function setGithubApiOverride(url: string | undefined): void {
  if (url === undefined) {
    delete (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL;
  } else {
    (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = url;
  }
}

beforeAll(() => {
  fake = startFakeGithub({
    [`POST ${DISPATCH_PATH}`]: () => nextResponse(),
  });
  setGithubApiOverride(fake.url);
});

afterAll(() => {
  fake.stop();
  setGithubApiOverride(undefined);
});

beforeEach(() => {
  fake.reset();
  nextResponse = () => new Response(null, { status: 204 });
});

describe("triggerVersionDoiRun", () => {
  test("POSTs the correct event_type and client_payload shape", async () => {
    await triggerVersionDoiRun("nm099999", "v1.0.0", "test-pat");

    expect(fake.calls.length).toBe(1);
    const call = fake.calls[0];
    expect(call.method).toBe("POST");
    expect(call.path).toBe(DISPATCH_PATH);

    const body = JSON.parse(call.body ?? "{}") as {
      event_type: string;
      client_payload: { dataset_id: string; tag: string };
    };
    expect(body.event_type).toBe("run-version-doi");
    expect(body.client_payload).toEqual({
      dataset_id: "nm099999",
      tag: "v1.0.0",
    });
  });

  test("propagates pre-release tags verbatim", async () => {
    await triggerVersionDoiRun("on002778", "v2.0.0-rc1", "test-pat");

    const body = JSON.parse(fake.calls[0].body ?? "{}") as {
      client_payload: { dataset_id: string; tag: string };
    };
    expect(body.client_payload).toEqual({
      dataset_id: "on002778",
      tag: "v2.0.0-rc1",
    });
  });

  test("throws with HTTP status + body on non-2xx", async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ message: "Validation Failed" }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      });

    let caught: unknown;
    try {
      await triggerVersionDoiRun("nm099999", "v1.0.0", "test-pat");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const msg = (caught as Error).message;
    expect(msg).toContain("HTTP 422");
    expect(msg).toContain("Validation Failed");
  });

  test("sends the pat as Bearer in the Authorization header", async () => {
    let seenAuth: string | null = null;
    const captureFake = startFakeGithub({
      [`POST ${DISPATCH_PATH}`]: (req) => {
        seenAuth = req.headers.get("Authorization");
        return new Response(null, { status: 204 });
      },
    });
    setGithubApiOverride(captureFake.url);
    try {
      await triggerVersionDoiRun("nm099999", "v1.0.0", "phase2-token");
      expect(seenAuth).toBe("Bearer phase2-token");
    } finally {
      captureFake.stop();
      setGithubApiOverride(fake.url);
    }
  });
});
