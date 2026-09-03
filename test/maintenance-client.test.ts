import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { checkHealth } from "../src/lib/api/client";
import { ApiError, MaintenanceError } from "../src/lib/api/errors";

type ServerResponse = {
  status: number;
  body: Record<string, unknown>;
};

let nextResponse: ServerResponse = { status: 200, body: { status: "ok", version: "0" } };
let server: ReturnType<typeof Bun.serve> | undefined;
let previousTestApiUrl: string | undefined;

beforeAll(() => {
  previousTestApiUrl = process.env.TEST_API_URL;
  server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(JSON.stringify(nextResponse.body), {
        status: nextResponse.status,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  process.env.TEST_API_URL = `http://localhost:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  // Guarded restore (#1175): assigning `undefined` to a process.env key
  // coerces to the literal string "undefined" instead of deleting it, which
  // poisoned TEST_API_URL for every test running later in the same `bun
  // test` process (test/ + backend/test/ share one process at the root).
  if (previousTestApiUrl === undefined) delete process.env.TEST_API_URL;
  else process.env.TEST_API_URL = previousTestApiUrl;
});

function setResponse(status: number, body: Record<string, unknown>): void {
  nextResponse = { status, body };
}

describe("MaintenanceError detection", () => {
  test("503 with mode=read-only throws MaintenanceError", async () => {
    setResponse(503, {
      error: "Service Unavailable",
      message: "freeze",
      mode: "read-only",
      eta: null,
    });
    const promise = checkHealth();
    await expect(promise).rejects.toBeInstanceOf(MaintenanceError);
    try {
      await checkHealth();
    } catch (err) {
      const maint = err as MaintenanceError;
      expect(maint.mode).toBe("read-only");
      expect(maint.statusCode).toBe(503);
      expect(maint.message).toBe("freeze");
      expect(maint.eta).toBeNull();
    }
  });

  test("503 with mode=full throws MaintenanceError", async () => {
    setResponse(503, {
      error: "Service Unavailable",
      message: "migration in progress",
      mode: "full",
      eta: "2026-04-18T00:00:00Z",
    });
    try {
      await checkHealth();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MaintenanceError);
      const maint = err as MaintenanceError;
      expect(maint.mode).toBe("full");
      expect(maint.eta).toBe("2026-04-18T00:00:00Z");
    }
  });

  test("503 without mode body falls back to generic ApiError", async () => {
    setResponse(503, { error: "Service Unavailable", message: "upstream timeout" });
    try {
      await checkHealth();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect(err).not.toBeInstanceOf(MaintenanceError);
      expect((err as ApiError).statusCode).toBe(503);
    }
  });

  test("503 with unknown mode falls back to generic ApiError", async () => {
    setResponse(503, { error: "Service Unavailable", message: "???", mode: "partial" });
    try {
      await checkHealth();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect(err).not.toBeInstanceOf(MaintenanceError);
    }
  });

  test("MaintenanceError coerces non-string eta to null", async () => {
    setResponse(503, {
      error: "Service Unavailable",
      message: "freeze",
      mode: "read-only",
      eta: 1234567890,
    });
    try {
      await checkHealth();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MaintenanceError);
      expect((err as MaintenanceError).eta).toBeNull();
    }
  });

  test("MaintenanceError uses default message when body omits one", async () => {
    setResponse(503, { mode: "full" });
    try {
      await checkHealth();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MaintenanceError);
      expect((err as MaintenanceError).message).toBe(
        "NEMAR is in maintenance mode. Please retry shortly.",
      );
    }
  });

  test("200 response passes through", async () => {
    setResponse(200, { status: "ok", version: "0.0.0" });
    const res = await checkHealth();
    expect(res.status).toBe("ok");
  });
});
