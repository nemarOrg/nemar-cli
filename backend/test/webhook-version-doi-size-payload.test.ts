/**
 * A pushed version tag's run-version-doi dispatch carries the dataset's
 * declared size (#1514, review finding #1).
 *
 * `routes/webhooks/github.ts` already reads the dataset row (for the
 * anonymity check) right before calling `triggerVersionDoiRun`; this test
 * proves that read was widened to include `file_size`/`total_files` and that
 * those values actually reach the dispatch payload, end to end through the
 * real route -- not just that `triggerVersionDoiRun` forwards options it is
 * handed (that half is covered, in isolation, by
 * archive-generation-dispatch.test.ts).
 *
 * This is the FIRST-PUBLISH path (a `v*` tag push), which is what actually
 * built nm000284's incident window: the dispatch fires before the
 * `dataset_versions` row this same webhook mints even exists, so the
 * version manifest 404s and the preflight had nothing but its own fail-open
 * to fall back on. Carrying the row's size here means the preflight's
 * dispatch-payload tier (nemarDatasets/.github#121) now has something to
 * use on exactly this path.
 *
 * Real Hono app, real WebCrypto HMAC, real bun:sqlite with every migration,
 * and a `Bun.serve()` stand-in for api.github.com (no mocks) -- same
 * pattern as webhook-version-doi-anonymous.test.ts, but carried through to
 * an actual successful dispatch instead of stopping at the anonymity gate.
 *
 * Dev-range (`xx09`) dataset ids, for the same reason
 * webhook-version-doi-anonymous.test.ts uses them: the worker refuses to
 * dispatch for a prod-range (`nm`) repo on a non-production worker
 * (`prod_range_repo_on_dev_worker`, epic #923) before any of this runs. The
 * size numbers still reproduce nm000284's actual shape; only the id differs.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { registerGithubWebhookRoutes } from "../src/routes/webhooks/github";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const SECRET = "test-webhook-secret";

async function sign(body: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return `sha256=${Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

function seed(
  db: Database,
  datasetId: string,
  d: { file_size?: number | null; total_files?: number | null },
): void {
  db.run(
    `INSERT INTO users (id, username, email, password_hash, status, role, email_verified)
     VALUES (11, 'tagger', 'tagger@example.org', 'x', 'approved', 'member', 1)
     ON CONFLICT(id) DO NOTHING`,
  );
  db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox,
                           github_repo, anonymous, concept_doi, file_size, total_files)
     VALUES (?, 'A sufficiently descriptive dataset title', 11, 'active', 'public', 0, ?, 0, ?, ?, ?)`,
  ).run(
    datasetId,
    `nemarDatasets/${datasetId}`,
    "10.82901/reserved-test",
    d.file_size ?? null,
    d.total_files ?? null,
  );
}

/** A `v*` tag push, the shape `nemar dataset release` produces. */
function tagPush(datasetId: string) {
  return {
    ref: "refs/tags/v1.0.1",
    deleted: false,
    repository: { name: datasetId, owner: { login: "nemarDatasets" } },
    commits: [],
  };
}

let server: Server;
let dispatches: Array<{ path: string; body: unknown }> = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      dispatches.push({ path: url.pathname, body: await request.json() });
      return new Response(null, { status: 204 });
    },
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
  dispatches = [];
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  server.stop(true);
});

interface VersionDoiDispatchBody {
  event_type: string;
  client_payload: {
    dataset_id: string;
    tag: string;
    total_bytes?: number;
    total_files?: number;
  };
}

async function post(db: Database, payload: unknown): Promise<Response> {
  const app = new Hono<{ Bindings: Bindings }>();
  registerGithubWebhookRoutes(app);
  const body = JSON.stringify(payload);
  const req = new Request("http://localhost/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-GitHub-Event": "push",
      "X-GitHub-Delivery": "size-payload-test",
      "X-Hub-Signature-256": await sign(body, SECRET),
    },
    body,
  });
  const ctx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return app.fetch(
    req,
    {
      GITHUB_WEBHOOK_SECRET: SECRET,
      ENVIRONMENT: "test",
      GITHUB_ADMIN_PAT: "test-token",
      DB: realD1(db),
    } as Bindings,
    ctx,
  );
}

describe("a pushed version tag's run-version-doi dispatch carries the row's size (#1514)", () => {
  test("file_size/total_files reach the client_payload", async () => {
    const db = freshDb();
    seed(db, "xx090284", { file_size: 550_239_019_072, total_files: 14_922 });

    const res = await post(db, tagPush("xx090284"));
    expect(res.status).toBe(200);

    expect(dispatches).toHaveLength(1);
    const body = dispatches[0].body as VersionDoiDispatchBody;
    expect(body.event_type).toBe("run-version-doi");
    expect(body.client_payload.dataset_id).toBe("xx090284");
    expect(body.client_payload.tag).toBe("v1.0.1");
    expect(body.client_payload.total_bytes).toBe(550_239_019_072);
    expect(body.client_payload.total_files).toBe(14_922);
  });

  test("a row with no declared size yet omits the fields rather than sending null/0", async () => {
    const db = freshDb();
    seed(db, "xx090285", {});

    const res = await post(db, tagPush("xx090285"));
    expect(res.status).toBe(200);

    expect(dispatches).toHaveLength(1);
    const body = dispatches[0].body as VersionDoiDispatchBody;
    expect("total_bytes" in body.client_payload).toBe(false);
    expect("total_files" in body.client_payload).toBe(false);
  });

  test("a genuinely empty dataset (file_size: 0, total_files: 0) sends numeric zero, not omitted (NIT, #1514 review)", async () => {
    // `?? null` / `?? undefined` only treat null/undefined as "absent"; a
    // real 0 must survive both hops (the row read in github.ts, then
    // triggerVersionDoiRun's own `??`) as the number 0, not be conflated
    // with "no declared size yet" and dropped.
    const db = freshDb();
    seed(db, "xx090288", { file_size: 0, total_files: 0 });

    const res = await post(db, tagPush("xx090288"));
    expect(res.status).toBe(200);

    expect(dispatches).toHaveLength(1);
    const body = dispatches[0].body as VersionDoiDispatchBody;
    expect("total_bytes" in body.client_payload).toBe(true);
    expect("total_files" in body.client_payload).toBe(true);
    expect(body.client_payload.total_bytes).toBe(0);
    expect(body.client_payload.total_files).toBe(0);
  });
});
