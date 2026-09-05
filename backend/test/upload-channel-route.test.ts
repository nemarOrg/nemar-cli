/**
 * Real route tests for the upload channel (ADR 0040 phase 2, #1252).
 *
 * Sandbox training is a CLI exercise (`nemar sandbox` drives a real
 * create/upload/finalize cycle against a capped throwaway dataset) and has no
 * browser equivalent, so a web upload is gated on the admin grant alone while
 * the CLI keeps both gates. The dangerous way to build that is a
 * client-declared channel — "web" would be the one word a CLI user types to
 * skip training — so the channel is derived from the credential that
 * authenticated the request. These tests drive POST /datasets, the entry point
 * that owns the decision, rather than the pure gate (upload-gate.unit.test.ts).
 *
 * ENVIRONMENT is "production" deliberately: outside production the route
 * forces `sandbox = true` and the real-dataset gate never runs at all, so a
 * non-production test of it could not fail.
 *
 * Real engine: bun:sqlite behind realD1 with every migration applied, real
 * Hono dispatch through authMiddleware (both credential paths), real hashed
 * tokens and real sessions. Nothing external is configured — no GitHub auth,
 * no S3 — so a request that gets PAST the gate dies at the first external
 * boundary with a 500 and never reaches the network. That 500 is the
 * "allowed" signal here, exactly as in upload-gate-message-route.test.ts.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { datasetRoutes } from "../src/routes/datasets";
import { hashApiKey } from "../src/services/token";
import { SANDBOX_TRAINING_ERROR, SERVICE_ACCESS_ERROR } from "../src/services/upload-gate";
import { issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const API_KEY = "channel-key-0123456789abcdef0123456789abcdef";
const CLI_VERSION = "0.9.16";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let userId: number;

function env(): Bindings {
  // "production" so the route honours `sandbox: false`; nothing else in this
  // env is configured, so no external call can succeed.
  return { DB: realD1(db), ENVIRONMENT: "production" } as Bindings;
}

async function seedUser(serviceAccess: 0 | 1, sandboxCompleted: 0 | 1): Promise<number> {
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, role,
                        signup_source, email_verified, service_access, sandbox_completed)
     VALUES ('channeluser', 'channeluser@example.org', 'x', 'channeluser-gh', 'approved',
             'member', 'cli', 1, ?, ?)`,
    [serviceAccess, sandboxCompleted],
  );
  const row = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username = 'channeluser'")
    .get();
  if (!row) throw new Error("seed failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    row.id,
    await hashApiKey(API_KEY),
    API_KEY.slice(0, 8),
  );
  return row.id;
}

/** POST /datasets with the given credential headers, asking for a REAL
 *  (non-sandbox) dataset — the only kind the create gate applies to. */
function createReal(headers: Record<string, string>, name: string): Promise<Response> {
  return app.request(
    "/datasets",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ name, sandbox: false }),
    },
    env(),
  );
}

function cliHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${API_KEY}`, "X-CLI-Version": CLI_VERSION };
}

async function webHeaders(id: number): Promise<Record<string, string>> {
  const { cookieIdRaw } = await issueSession(env(), id, false, null, null, "email_code");
  return { Cookie: `nemar_session=${cookieIdRaw}` };
}

beforeEach(() => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/datasets", datasetRoutes);
});

describe("POST /datasets: the channel comes from the credential", () => {
  test("CLI + upload access + no training -> the sandbox-training 403", async () => {
    userId = await seedUser(1, 0);
    const res = await createReal(cliHeaders(), "cli-untrained");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ...SANDBOX_TRAINING_ERROR });
  });

  test("web + upload access + no training -> allowed past the gate", async () => {
    // The same user, the same row, a different credential. `nemar sandbox`
    // has no browser equivalent, so requiring it here would gate the
    // dashboard on a command the dashboard cannot run.
    userId = await seedUser(1, 0);
    const res = await createReal(await webHeaders(userId), "web-untrained");

    expect(res.status).not.toBe(403);
    // Past the gate the route dies on the unconfigured GitHub auth, which
    // Hono answers as a plain-text 500 -- read as text, not JSON.
    expect(await res.text()).not.toContain(SANDBOX_TRAINING_ERROR.error);
  });

  test("web without upload access -> the service-access 403; the browser is not exempt", async () => {
    userId = await seedUser(0, 0);
    const res = await createReal(await webHeaders(userId), "web-ungranted");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ...SERVICE_ACCESS_ERROR });
  });

  test("CLI with both gates satisfied -> allowed past the gate", async () => {
    userId = await seedUser(1, 1);
    const res = await createReal(cliHeaders(), "cli-trained");
    expect(res.status).not.toBe(403);
  });

  test("a bearer token stays the CLI channel even when a web cookie rides along", async () => {
    // authMiddleware resolves bearer first, so the recorded principal is the
    // token -- and the channel follows the principal, not the presence of a
    // cookie an attacker could attach to a CLI request to skip training.
    userId = await seedUser(1, 0);
    const res = await createReal(
      { ...cliHeaders(), ...(await webHeaders(userId)) },
      "cli-with-cookie",
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ...SANDBOX_TRAINING_ERROR });
  });
});
