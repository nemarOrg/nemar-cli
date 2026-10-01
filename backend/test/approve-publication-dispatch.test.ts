/**
 * `triggerApprovePublication` (ADR 0080): the dispatch that hands a web
 * approval to the central workflow.
 *
 * Real engine: driven against a `Bun.serve()` stand-in for api.github.com, the
 * same pattern as archive-generation-dispatch.test.ts. No mocks: the shape sent
 * is read straight off the request the stand-in received. What matters is the
 * contract the workflow reads (event type and the four payload keys), that no
 * credential or URL rides in the payload, and that an environment is only ever
 * a name.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import {
  CENTRAL_WORKFLOW_REPO,
  approvalDispatchEnvironment,
  triggerApprovePublication,
} from "../src/services/github/dispatch";

interface Received {
  path: string;
  authorization: string | null;
  body: { event_type: string; client_payload: Record<string, unknown> };
}

let server: Server;
let received: Received[] = [];
let nextStatus = 204;
let nextBody = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      received.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        body: await request.json(),
      });
      return new Response(nextBody || null, { status: nextStatus });
    },
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
  received = [];
  nextStatus = 204;
  nextBody = "";
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  server.stop(true);
});

describe("triggerApprovePublication", () => {
  test("posts approve-publication to the central repo with exactly the contract payload", async () => {
    await triggerApprovePublication("nm000288", 833, false, "production", "ghp_token");

    expect(received).toHaveLength(1);
    expect(received[0].path).toBe(`/repos/${CENTRAL_WORKFLOW_REPO}/dispatches`);
    expect(received[0].authorization).toBe("Bearer ghp_token");
    expect(received[0].body).toEqual({
      event_type: "approve-publication",
      client_payload: {
        dataset_id: "nm000288",
        request_id: 833,
        resume: false,
        environment: "production",
      },
    });
  });

  test("carries resume and the dev environment through", async () => {
    await triggerApprovePublication("nm099999", 7, true, "dev", "t");
    expect(received[0].body.client_payload).toEqual({
      dataset_id: "nm099999",
      request_id: 7,
      resume: true,
      environment: "dev",
    });
  });

  test("puts no credential or URL in the payload", async () => {
    await triggerApprovePublication("nm000288", 833, false, "production", "ghp_secret_value");
    const sent = JSON.stringify(received[0].body);
    expect(sent).not.toContain("ghp_secret_value");
    expect(sent).not.toMatch(/https?:\/\//);
    expect(Object.keys(received[0].body.client_payload).sort()).toEqual([
      "dataset_id",
      "environment",
      "request_id",
      "resume",
    ]);
  });

  test("throws on a non-2xx, naming GitHub's status but never the token", async () => {
    nextStatus = 404;
    nextBody = '{"message":"Not Found"}';
    const err = await triggerApprovePublication("nm000288", 833, false, "production", "ghp_tok")
      .then(() => null)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain("HTTP 404");
    expect(err?.message).toContain("Not Found");
    expect(err?.message).not.toContain("ghp_tok");
  });
});

describe("approvalDispatchEnvironment", () => {
  test("production only for the production Worker, exactly", () => {
    expect(approvalDispatchEnvironment({ ENVIRONMENT: "production" })).toBe("production");
  });

  test("every other value is dev, including an unset or misspelled one", () => {
    for (const value of [
      "development",
      "staging",
      "test",
      "Production",
      " production",
      "",
      undefined,
    ]) {
      expect(approvalDispatchEnvironment({ ENVIRONMENT: value })).toBe("dev");
    }
  });
});
