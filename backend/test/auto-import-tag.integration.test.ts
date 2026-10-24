/**
 * The auto-import pins its dispatch to the tag discovery found (epic #1046 Phase 3, ADR 0111
 * decision 10), end to end: the real `autoImportTick`, the real OpenNeuro GraphQL scan, the
 * production schema in SQLite, and a local stand-in for GitHub's dispatch endpoint (the
 * `NEMAR_GITHUB_API_URL` override the other GitHub-facing suites use). Only the destination of the
 * dispatch moves; nothing reaches GitHub.
 *
 * Integration tier (`*.integration.test.ts`): it reads openneuro.org, which is outside this
 * repository's control, so it runs where a transient outage retries instead of gating.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { isOpenNeuroTag } from "../../shared/openneuro-tag";
import { autoImportTick } from "../src/services/auto-import";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const OPENNEURO_GRAPHQL = "https://openneuro.org/crn/graphql";

let server: ReturnType<typeof Bun.serve>;
const dispatches: Array<{ path: string; body: Record<string, unknown> }> = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname.endsWith("/dispatches")) {
        dispatches.push({
          path: url.pathname,
          body: (await req.json()) as Record<string, unknown>,
        });
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  server.stop(true);
});

async function latestTagOf(id: string): Promise<string | null> {
  const res = await fetch(OPENNEURO_GRAPHQL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: "query($id: ID!){ dataset(id: $id){ latestSnapshot { tag } } }",
      variables: { id },
    }),
  });
  const json = (await res.json()) as {
    data?: { dataset?: { latestSnapshot?: { tag?: string } } };
  };
  return json.data?.dataset?.latestSnapshot?.tag ?? null;
}

describe("autoImportTick dispatches at the discovered tag", () => {
  test("the dispatch payload and the audit row carry the tag OpenNeuro reports as latest", async () => {
    const db = freshDb();
    const env = {
      DB: realD1(db),
      ENVIRONMENT: "production",
      AUTO_IMPORT_ENABLED: "true",
      GITHUB_ADMIN_PAT: "test-pat",
    } as unknown as Bindings;

    await autoImportTick(env);

    expect(dispatches).toHaveLength(1);
    const payload = dispatches[0]?.body.client_payload as Record<string, string>;
    expect(dispatches[0]?.body.event_type).toBe("onboard-openneuro");
    const id = payload.openneuro_ids;
    expect(id).toMatch(/^ds\d{6}$/);
    // Discovery keeps only datasets with a snapshot summary, so the pick has a tag.
    expect(isOpenNeuroTag(payload.openneuro_tag)).toBe(true);

    const audit = db
      .query(
        "SELECT details FROM audit_log WHERE action = 'auto_import_dispatch' ORDER BY id DESC LIMIT 1",
      )
      .get() as { details: string };
    expect(JSON.parse(audit.details).tag).toBe(payload.openneuro_tag);

    // The same tag OpenNeuro names now, read independently of the scan. A snapshot published
    // between the two reads would differ; that is a minutes-wide race, retried by the tier.
    expect(await latestTagOf(id)).toBe(payload.openneuro_tag);
  }, 180_000);
});
