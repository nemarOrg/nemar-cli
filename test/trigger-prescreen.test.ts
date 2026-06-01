/**
 * Unit tests for `triggerPrescreenRun` — the helper that POSTs
 * `repository_dispatch[run-prescreen]` to nemarDatasets/.github (issue #666).
 *
 * Mirrors trigger-enrichment.test.ts: a Bun.serve fake GitHub fixture
 * captures the outbound POST, the helper is called directly, and the test
 * asserts request URL + body shape + error propagation. No mocking of fetch.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./setup";
import { type FakeGithubServer, startFakeGithub } from "./helpers/fetch-counter";
import { triggerPrescreenRun } from "../backend/src/services/github";

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

describe("triggerPrescreenRun", () => {
  test("POSTs the correct event_type and client_payload shape", async () => {
    await triggerPrescreenRun(
      "nm099999",
      "main",
      4242,
      "deadbeef".repeat(8),
      "https://api.nemar.org/webhooks/prescreen-result",
      "test-pat",
    );

    expect(fake.calls.length).toBe(1);
    const call = fake.calls[0];
    expect(call.method).toBe("POST");
    expect(call.path).toBe(DISPATCH_PATH);

    const body = JSON.parse(call.body ?? "{}") as {
      event_type: string;
      client_payload: {
        dataset_id: string;
        ref: string;
        request_id: number;
        callback_token: string;
        callback_url: string;
      };
    };
    expect(body.event_type).toBe("run-prescreen");
    expect(body.client_payload).toEqual({
      dataset_id: "nm099999",
      ref: "main",
      request_id: 4242,
      callback_token: "deadbeef".repeat(8),
      callback_url: "https://api.nemar.org/webhooks/prescreen-result",
    });
  });

  test("passes a non-default ref through the payload", async () => {
    await triggerPrescreenRun("on002778", "release/v1.0.0", 9, "tok", "https://x/cb", "test-pat");
    const body = JSON.parse(fake.calls[0].body ?? "{}") as {
      client_payload: { ref: string; request_id: number };
    };
    expect(body.client_payload.ref).toBe("release/v1.0.0");
    expect(body.client_payload.request_id).toBe(9);
  });

  test("throws on a non-2xx dispatch response (does not swallow)", async () => {
    nextResponse = () => new Response("nope", { status: 422 });
    expect(
      triggerPrescreenRun("nm099999", "main", 1, "tok", "https://x/cb", "test-pat"),
    ).rejects.toThrow(/Failed to trigger prescreen run: HTTP 422/);
  });
});
