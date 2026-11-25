/**
 * CORS for the person's job routes (epic #2021 phase D3, #2024): the website's job page (website#496) sends
 * `Idempotency-Key` and reads `X-Nemar-Truncated` and `Idempotent-Replayed`, so the Worker's CORS middleware
 * allows the first and exposes the others. Through the REAL Worker (`index.ts`), whose middleware is the
 * production one; the preflight is answered before authentication.
 */

import { describe, expect, test } from "bun:test";
import worker from "../src/index";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const env = (): Bindings =>
  ({ DB: realD1(freshDb()), ENVIRONMENT: "production" }) as unknown as Bindings;

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const split = (value: string | null): string[] =>
  (value ?? "").split(",").map((s) => s.trim().toLowerCase());

describe("CORS on the job routes", () => {
  test("a preflight from a NEMAR page allows Idempotency-Key, and POST", async () => {
    const res = await worker.fetch(
      new Request("http://api.test/compute/jobs", {
        method: "OPTIONS",
        headers: {
          Origin: "https://app.nemar.org",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "idempotency-key,content-type,authorization",
        },
      }),
      env(),
      ctx,
    );
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.nemar.org");
    expect(split(res.headers.get("access-control-allow-headers"))).toContain("idempotency-key");
    expect(split(res.headers.get("access-control-allow-methods"))).toContain("post");
  });

  test("a response to a NEMAR page exposes the headers the job page reads, and the older ones stay", async () => {
    const res = await worker.fetch(
      new Request("http://api.test/compute/jobs/job_000000000000000000000000/logs", {
        headers: { Origin: "https://app.nemar.org" },
      }),
      env(),
      ctx,
    );
    expect(res.status).toBe(401);
    const exposed = split(res.headers.get("access-control-expose-headers"));
    for (const name of [
      "x-nemar-truncated",
      "idempotent-replayed",
      "retry-after",
      "x-request-id",
    ]) {
      expect(exposed).toContain(name);
    }
  });

  test("a page that is not a NEMAR surface is allowed nothing", async () => {
    const res = await worker.fetch(
      new Request("http://api.test/compute/jobs", {
        method: "OPTIONS",
        headers: {
          Origin: "https://evil.example",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "idempotency-key",
        },
      }),
      env(),
      ctx,
    );
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
