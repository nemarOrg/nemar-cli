/**
 * The purge of a dataset's quality views from Cloudflare's cache (`purgeQualityCache`, ADR 0137 decision 7,
 * review of #2383): `Cache-Tag: nemar-dq-<id>` purged by tag after a concealment, an unpublish or a
 * withdrawal, best effort and after the D1 write. The Cloudflare API is a local stand-in named by the
 * `NEMAR_CLOUDFLARE_API_URL` seam; it records what it was sent and answers as it is told. The unpublish
 * path through `applyDatasetVisibility` is pinned in `review-auto-require-paths.test.ts`, whose stand-ins
 * carry a whole visibility flip.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { markAnonymous } from "../src/services/anonymity";
import { purgeCacheTags, purgeQualityCache } from "../src/services/cloudflare";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { logged } from "./helpers/logs";

interface Seen {
  path: string;
  auth: string | null;
  body: unknown;
}

let server: ReturnType<typeof Bun.serve>;
const seen: Seen[] = [];
let answer = 200;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      seen.push({
        path: new URL(req.url).pathname,
        auth: req.headers.get("authorization"),
        body: await req.json(),
      });
      return Response.json({ success: answer === 200 }, { status: answer });
    },
  });
  (globalThis as { NEMAR_CLOUDFLARE_API_URL?: string }).NEMAR_CLOUDFLARE_API_URL =
    `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  (globalThis as { NEMAR_CLOUDFLARE_API_URL?: string }).NEMAR_CLOUDFLARE_API_URL = undefined;
  server.stop(true);
});

beforeEach(() => {
  seen.length = 0;
  answer = 200;
});

const configured = { CLOUDFLARE_API_TOKEN: "test-token", CLOUDFLARE_ZONE_ID: "zone123" };

describe("purgeCacheTags", () => {
  test("posts the tags to the zone's purge endpoint with the token", async () => {
    const r = await purgeCacheTags(configured as Bindings, [
      "nemar-dq-nm000901",
      "nemar-dq-nm000901",
    ]);
    expect(r).toEqual({ ok: true, submitted: 1 });
    expect(seen).toEqual([
      {
        path: "/client/v4/zones/zone123/purge_cache",
        auth: "Bearer test-token",
        body: { tags: ["nemar-dq-nm000901"] },
      },
    ]);
  });

  test("is skipped without the token or the zone, and sends nothing", async () => {
    expect((await purgeCacheTags({} as Bindings, ["nemar-dq-nm000901"])).submitted).toBe(0);
    expect(seen).toEqual([]);
  });
});

describe("purgeQualityCache", () => {
  test("purges the dataset's tag; a refused purge is logged with a fixed word and never thrown", async () => {
    await purgeQualityCache(configured as Bindings, "nm000901", "unpublish");
    expect(seen.map((s) => s.body)).toEqual([{ tags: ["nemar-dq-nm000901"] }]);
    answer = 500;
    const lines = await logged(() =>
      purgeQualityCache(configured as Bindings, "nm000901", "withdraw"),
    );
    expect(lines.filter((l) => l.startsWith("[quality]"))).toEqual([
      "[quality] cache_purge_failed dataset=nm000901 cause=withdraw",
    ]);
  });

  test("an unreachable API is logged and never thrown", async () => {
    (globalThis as { NEMAR_CLOUDFLARE_API_URL?: string }).NEMAR_CLOUDFLARE_API_URL =
      "http://127.0.0.1:9";
    try {
      const lines = await logged(() =>
        purgeQualityCache(configured as Bindings, "nm000902", "conceal"),
      );
      expect(lines).toContain("[quality] cache_purge_failed dataset=nm000902 cause=conceal");
    } finally {
      (globalThis as { NEMAR_CLOUDFLARE_API_URL?: string }).NEMAR_CLOUDFLARE_API_URL =
        `http://127.0.0.1:${server.port}`;
    }
  });
});

describe("a concealment purges the dataset's quality views after its write (MUTATION: drop the purge from markAnonymous)", () => {
  const seed = (db: ReturnType<typeof freshDb>, id: string) =>
    db.run(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox, anonymous)
       VALUES (?, ?, -1, 'active', 'public', 0, 0)`,
      [id, id],
    );

  test("the row is concealed and the tag purged", async () => {
    const db = freshDb();
    seed(db, "nm000903");
    const env = { DB: realD1(db), ...configured } as Bindings;
    const r = await markAnonymous(env, "nm000903");
    expect(r.changed).toBe(true);
    expect(db.query("SELECT anonymous FROM datasets WHERE dataset_id = 'nm000903'").get()).toEqual({
      anonymous: 1,
    });
    expect(seen.map((s) => s.body)).toEqual([{ tags: ["nemar-dq-nm000903"] }]);
  });

  test("a failed purge never undoes or refuses the write", async () => {
    answer = 500;
    const db = freshDb();
    seed(db, "nm000904");
    const env = { DB: realD1(db), ...configured } as Bindings;
    await logged(async () => {
      expect((await markAnonymous(env, "nm000904")).changed).toBe(true);
    });
    expect(db.query("SELECT anonymous FROM datasets WHERE dataset_id = 'nm000904'").get()).toEqual({
      anonymous: 1,
    });
  });
});
