/**
 * Unit tests for `triggerEnrichmentRun` — the helper that POSTs
 * `repository_dispatch[run-enrichment]` to nemarDatasets/.github.
 *
 * Mirrors the structure used by other GitHub-API tests in this repo: a
 * Bun.serve fake GitHub fixture captures outbound POSTs, the helper is
 * called directly, and the test asserts request URL + body shape +
 * error propagation. No mocking of fetch.
 *
 * Phase 1 of epic #601 (sub-issue #602).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./setup";
import { type FakeGithubServer, startFakeGithub } from "./helpers/fetch-counter";
import { triggerEnrichmentRun } from "../backend/src/services/github";

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

describe("triggerEnrichmentRun", () => {
  test("POSTs the correct event_type and client_payload shape", async () => {
    await triggerEnrichmentRun("nm099999", "main", false, "test-pat");

    expect(fake.calls.length).toBe(1);
    const call = fake.calls[0];
    expect(call.method).toBe("POST");
    expect(call.path).toBe(DISPATCH_PATH);

    const body = JSON.parse(call.body ?? "{}") as {
      event_type: string;
      client_payload: { dataset_id: string; ref: string; force: boolean };
    };
    expect(body.event_type).toBe("run-enrichment");
    expect(body.client_payload).toEqual({
      dataset_id: "nm099999",
      ref: "main",
      force: false,
    });
  });

  test("propagates force=true and a release ref through the payload", async () => {
    await triggerEnrichmentRun("on002778", "release/v1.0.0", true, "test-pat");

    const body = JSON.parse(fake.calls[0].body ?? "{}") as {
      client_payload: { dataset_id: string; ref: string; force: boolean };
    };
    expect(body.client_payload).toEqual({
      dataset_id: "on002778",
      ref: "release/v1.0.0",
      force: true,
    });
  });

  test("throws with HTTP status + body when GitHub returns non-2xx", async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });

    let caught: unknown;
    try {
      await triggerEnrichmentRun("nm000999", "main", false, "test-pat");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const msg = (caught as Error).message;
    expect(msg).toContain("HTTP 404");
    expect(msg).toContain("Not Found");
  });

  test("sends the pat as Bearer in the Authorization header", async () => {
    let seenAuth: string | null = null;
    nextResponse = () => new Response(null, { status: 204 });
    fake.reset();
    // Swap the handler to record the auth header for this call.
    const original = fake.server.fetch;
    void original;
    await triggerEnrichmentRun("nm099999", "main", false, "custom-token-xyz");
    // The fixture records body but not headers; re-derive the header by
    // overriding the handler. Re-do with a one-shot interceptor.
    nextResponse = () => {
      seenAuth = "captured-elsewhere";
      return new Response(null, { status: 204 });
    };
    // Use a new fake to capture headers. Simpler: do it inline.
    const captureFake = startFakeGithub({
      [`POST ${DISPATCH_PATH}`]: (req) => {
        seenAuth = req.headers.get("Authorization");
        return new Response(null, { status: 204 });
      },
    });
    setGithubApiOverride(captureFake.url);
    try {
      await triggerEnrichmentRun("nm099999", "main", false, "custom-token-xyz");
      expect(seenAuth).toBe("Bearer custom-token-xyz");
    } finally {
      captureFake.stop();
      setGithubApiOverride(fake.url);
    }
  });
});
