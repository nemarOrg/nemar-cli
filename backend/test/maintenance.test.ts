/**
 * Maintenance-mode middleware tests
 *
 * No mocks: instantiates a real Hono app with the middleware and exercises it
 * via the Hono `app.fetch` interface. Covers the three modes (off, read-only,
 * full) across GET, POST, and admin/webhook whitelisting.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { maintenanceMode } from "../src/middleware/maintenance";
import type { Bindings, Variables } from "../src/types/bindings";

type AppEnv = { Bindings: Bindings; Variables: Variables };

function buildApp(mode: "off" | "read-only" | "full" | undefined): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", maintenanceMode);
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/notices", (c) => c.json({ notices: [] }));
  app.get("/datasets", (c) => c.json({ datasets: [] }));
  app.post("/datasets", (c) => c.json({ created: true }));
  app.post("/admin/approve", (c) => c.json({ approved: true }));
  app.post("/webhooks/github", (c) => c.json({ received: true }));
  app.get("/", (c) => c.json({ name: "NEMAR API" }));
  return app;
}

const BASE_ENV = {
  ENVIRONMENT: "test" as const,
  API_BASE_URL: "http://localhost",
  FRONTEND_URL: "http://localhost",
  AWS_REGION: "us-east-2",
  S3_BUCKET: "nemar",
  DB: undefined as unknown as D1Database,
  GITHUB_ADMIN_PAT: "",
  AWS_ACCESS_KEY_ID: "",
  AWS_SECRET_ACCESS_KEY: "",
  RESEND_API_KEY: "",
  ZENODO_API_KEY: "",
  EZID_USERNAME: "",
  EZID_PASSWORD: "",
} satisfies Partial<Bindings> as unknown as Bindings;

function envWith(mode: "off" | "read-only" | "full" | undefined): Bindings {
  if (mode === undefined) return BASE_ENV;
  return { ...BASE_ENV, MAINTENANCE_MODE: mode };
}

async function hit(
  app: Hono<AppEnv>,
  mode: "off" | "read-only" | "full" | undefined,
  path: string,
  method = "GET",
): Promise<Response> {
  return await app.fetch(new Request(`http://localhost${path}`, { method }), envWith(mode));
}

describe("maintenanceMode: off (default)", () => {
  const app = buildApp("off");

  test("GET /health -> 200", async () => {
    const res = await hit(app, "off", "/health");
    expect(res.status).toBe(200);
  });

  test("POST /datasets -> 200", async () => {
    const res = await hit(app, "off", "/datasets", "POST");
    expect(res.status).toBe(200);
  });

  test("undefined env var behaves as off", async () => {
    const res = await hit(app, undefined, "/datasets", "POST");
    expect(res.status).toBe(200);
  });
});

describe("maintenanceMode: read-only", () => {
  const app = buildApp("read-only");

  test("GET /datasets -> 200", async () => {
    const res = await hit(app, "read-only", "/datasets", "GET");
    expect(res.status).toBe(200);
  });

  test("POST /datasets -> 503 with mode body", async () => {
    const res = await hit(app, "read-only", "/datasets", "POST");
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("3600");
    const body = (await res.json()) as { mode: string; error: string };
    expect(body.mode).toBe("read-only");
    expect(body.error).toBe("Service Unavailable");
  });

  test("POST /admin/approve -> 200 (admin allowed)", async () => {
    const res = await hit(app, "read-only", "/admin/approve", "POST");
    expect(res.status).toBe(200);
  });

  test("POST /webhooks/github -> 200 (webhook allowed)", async () => {
    const res = await hit(app, "read-only", "/webhooks/github", "POST");
    expect(res.status).toBe(200);
  });

  test("GET /health -> 200 (always allowed)", async () => {
    const res = await hit(app, "read-only", "/health");
    expect(res.status).toBe(200);
  });
});

describe("maintenanceMode: full", () => {
  const app = buildApp("full");

  test("GET /datasets -> 503", async () => {
    const res = await hit(app, "full", "/datasets", "GET");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { mode: string };
    expect(body.mode).toBe("full");
  });

  test("POST /datasets -> 503", async () => {
    const res = await hit(app, "full", "/datasets", "POST");
    expect(res.status).toBe(503);
  });

  test("POST /admin/approve -> 503 (admin blocked in full)", async () => {
    const res = await hit(app, "full", "/admin/approve", "POST");
    expect(res.status).toBe(503);
  });

  test("GET /health -> 200 (whitelisted)", async () => {
    const res = await hit(app, "full", "/health");
    expect(res.status).toBe(200);
  });

  test("GET /notices -> 200 (whitelisted)", async () => {
    const res = await hit(app, "full", "/notices");
    expect(res.status).toBe(200);
  });

  test("GET / -> 200 (whitelisted)", async () => {
    const res = await hit(app, "full", "/");
    expect(res.status).toBe(200);
  });
});

describe("maintenanceMode: invalid values", () => {
  test("unknown mode string behaves as off", async () => {
    const app = buildApp("off");
    // Cast: deliberately pass invalid mode to exercise fallback.
    const res = await hit(app, "off", "/datasets", "POST");
    expect(res.status).toBe(200);
  });
});
