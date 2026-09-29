/**
 * News images (#1551): POST /admin/news/media and GET /news/media/:file.
 *
 * Driven through the worker entry (`worker.fetch`), with the NEWS_MEDIA
 * binding backed by Miniflare's local R2 simulator: the R2 implementation
 * `wrangler dev` runs, in a real workerd process, not a hand-written fake.
 * Uploads are read back from that bucket directly, so the stored bytes,
 * key and HTTP metadata are asserted against what R2 actually holds.
 *
 * ONE PATH IS NOT COVERED HERE: `GET /news/media/:file` returning 200 with
 * the image body. Under bun, reading `.body` from an object that Miniflare's
 * Node-side proxy returns throws `DataCloneError: Found invalid value in
 * transferList` (Bun's structuredClone cannot transfer the stream), so the
 * route's `new Response(object.body)` cannot run in this process. Every
 * other branch of that route (the file-name gate, a missing object, the 304
 * revalidation, a missing binding) is covered, and the streaming branch was
 * checked by hand against `wrangler dev` (see the PR).
 *
 * Every refusal of an upload is also checked to have written nothing.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Miniflare } from "miniflare";
import worker from "../src/index";
import { NEWS_MEDIA_MAX_BYTES } from "../src/services/news-media";
import { hashApiKey } from "../src/services/token";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "news-media-admin-key-0123456789abcdef01234567";
const MEMBER_KEY = "news-media-member-key-0123456789abcdef0123456";
const API = "https://api.nemar.org";

const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    p.catch(() => {});
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

let mf: Miniflare;
let bucket: R2Bucket;
let db: Database;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null, { status: 404 }); } }",
    r2Buckets: ["NEWS_MEDIA"],
  });
  bucket = (await mf.getR2Bucket("NEWS_MEDIA")) as unknown as R2Bucket;
});

afterAll(async () => {
  await mf.dispose();
});

async function storedKeys(): Promise<string[]> {
  const listing = await bucket.list({ prefix: "news/" });
  return listing.objects.map((o) => o.key);
}

beforeEach(async () => {
  for (const key of await storedKeys()) await bucket.delete(key);
  db = freshDb();
  for (const [username, role, key] of [
    ["mediaadmin", "admin", ADMIN_KEY],
    ["mediamember", "member", MEMBER_KEY],
  ] as const) {
    db.query(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access)
       VALUES (?, ?, 'x', 'approved', ?, 1, 1)`,
    ).run(username, `${username}@example.org`, role);
    const row = db
      .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
      .get(username);
    db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
      row?.id ?? 0,
      await hashApiKey(key),
      key.slice(0, 8),
    );
  }
});

function env(withBucket = true): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "development",
    ...(withBucket ? { NEWS_MEDIA: bucket } : {}),
  } as unknown as Bindings;
}

function upload(
  body: BodyInit | null,
  contentType: string | null,
  opts: { key?: string; withBucket?: boolean } = {},
): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${opts.key ?? ADMIN_KEY}` };
  if (contentType !== null) headers["Content-Type"] = contentType;
  return worker.fetch(
    new Request(`${API}/admin/news/media`, { method: "POST", headers, body }),
    env(opts.withBucket ?? true),
    ctx,
  );
}

function serve(
  file: string,
  headers: Record<string, string> = {},
  withBucket = true,
): Promise<Response> {
  return worker.fetch(new Request(`${API}/news/media/${file}`, { headers }), env(withBucket), ctx);
}

/** Minimal byte sequences that open with each format's real signature. */
function png(extra = 16): Uint8Array {
  const bytes = new Uint8Array(8 + extra);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.fill(0x42, 8);
  return bytes;
}
const enc = new TextEncoder();
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
const GIF89 = enc.encode("GIF89a\x01\x00\x01\x00\x00\x00\x00;");
const GIF87 = enc.encode("GIF87a\x01\x00\x01\x00\x00\x00\x00;");
const WEBP = new Uint8Array([
  ...enc.encode("RIFF"),
  0x1a,
  0,
  0,
  0,
  ...enc.encode("WEBPVP8 "),
  0,
  0,
]);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A body with no Content-Length, delivered in chunks, so the size cap has
 *  to be enforced while reading rather than from the header. */
function chunkedStream(total: number, chunk = 256 * 1024): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const n = Math.min(chunk, total - sent);
      const part = new Uint8Array(n);
      if (sent === 0) part.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      sent += n;
      controller.enqueue(part);
    },
  });
}

describe("POST /admin/news/media: accepted uploads", () => {
  const cases: [string, Uint8Array, string, string][] = [
    ["PNG", png(), "image/png", "png"],
    ["JPEG", JPEG, "image/jpeg", "jpg"],
    ["GIF89a", GIF89, "image/gif", "gif"],
    ["GIF87a", GIF87, "image/gif", "gif"],
    ["WebP", WEBP, "image/webp", "webp"],
  ];

  for (const [name, bytes, type, ext] of cases) {
    test(`${name} is stored under its sha256 with its type and immutable caching`, async () => {
      const res = await upload(bytes, type);
      expect(res.status).toBe(201);
      const file = `${sha256(bytes)}.${ext}`;
      expect(await res.json()).toEqual({
        url: `/news/media/${file}`,
        content_type: type,
        bytes: bytes.length,
      });

      const head = await bucket.head(`news/${file}`);
      expect(head?.size).toBe(bytes.length);
      expect(head?.httpMetadata?.contentType).toBe(type);
      expect(head?.httpMetadata?.cacheControl).toBe("public, max-age=31536000, immutable");
      const stored = await bucket.get(`news/${file}`);
      expect(new Uint8Array(await (stored as R2ObjectBody).arrayBuffer())).toEqual(bytes);
    });
  }

  test("re-uploading the same bytes is idempotent: same URL, object left as it was", async () => {
    const bytes = png(64);
    const first = (await (await upload(bytes, "image/png")).json()) as { url: string };
    const key = `news/${sha256(bytes)}.png`;
    const uploadedAt = (await bucket.head(key))?.uploaded.getTime();

    await Bun.sleep(20);
    const again = await upload(bytes, "image/png");
    expect(again.status).toBe(201);
    expect(((await again.json()) as { url: string }).url).toBe(first.url);
    expect((await bucket.head(key))?.uploaded.getTime()).toBe(uploadedAt);
    expect(await storedKeys()).toEqual([key]);
  });

  test("Content-Type parameters and case are ignored", async () => {
    expect((await upload(png(1), "IMAGE/PNG")).status).toBe(201);
    expect((await upload(png(2), "image/png; charset=binary")).status).toBe(201);
  });

  test("exactly 5 MiB is accepted", async () => {
    const bytes = png(NEWS_MEDIA_MAX_BYTES - 8);
    expect(bytes.length).toBe(NEWS_MEDIA_MAX_BYTES);
    const res = await upload(bytes, "image/png");
    expect(res.status).toBe(201);
    expect(((await res.json()) as { bytes: number }).bytes).toBe(NEWS_MEDIA_MAX_BYTES);
  });
});

describe("POST /admin/news/media: refusals write nothing", () => {
  test("415 unsupported_media_type for a type that is not one of the four", async () => {
    for (const type of ["text/plain", "image/svg+xml", "image/jpg", "application/octet-stream"]) {
      const res = await upload(png(), type);
      expect(res.status).toBe(415);
      expect(((await res.json()) as { error: string }).error).toBe("unsupported_media_type");
    }
    const none = await upload(png(), null);
    expect(none.status).toBe(415);
    // An inherited property name is not an accepted type either.
    for (const type of ["constructor", "__proto__", "toString"]) {
      expect((await upload(png(), type)).status).toBe(415);
    }
    expect(await storedKeys()).toEqual([]);
  });

  test("413 too_large for a body over 5 MiB (Content-Length sent)", async () => {
    const res = await upload(png(NEWS_MEDIA_MAX_BYTES - 7), "image/png");
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe("too_large");
    expect(await storedKeys()).toEqual([]);
  });

  test("413 too_large for an oversized body sent without Content-Length", async () => {
    const res = await upload(chunkedStream(NEWS_MEDIA_MAX_BYTES + 1), "image/png");
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe("too_large");
    expect(await storedKeys()).toEqual([]);
  });

  test("400 empty_body", async () => {
    for (const body of [new Uint8Array(0), null]) {
      const res = await upload(body, "image/png");
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("empty_body");
    }
    expect(await storedKeys()).toEqual([]);
  });

  test("400 type_mismatch when the magic bytes disagree with the declared type", async () => {
    const cases: [Uint8Array, string][] = [
      [png(), "image/jpeg"],
      [JPEG, "image/png"],
      [GIF89, "image/webp"],
      [WEBP, "image/gif"],
      [enc.encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/png"],
      // Only the first half of the PNG signature.
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), "image/png"],
      // RIFF container that is not WebP (a WAV header).
      [new Uint8Array([...enc.encode("RIFF"), 0, 0, 0, 0, ...enc.encode("WAVE")]), "image/webp"],
      [enc.encode("GIF88a"), "image/gif"],
    ];
    for (const [bytes, type] of cases) {
      const res = await upload(bytes, type);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("type_mismatch");
    }
    expect(await storedKeys()).toEqual([]);
  });

  test("a member is refused before anything is read or written", async () => {
    const res = await upload(png(), "image/png", { key: MEMBER_KEY });
    expect(res.status).toBe(403);
    expect(await storedKeys()).toEqual([]);
  });

  test("503 storage_unavailable when the NEWS_MEDIA binding is missing", async () => {
    const res = await upload(png(), "image/png", { withBucket: false });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("storage_unavailable");
  });
});

describe("GET /news/media/:file", () => {
  test("404 not_found for any name that is not <64 lowercase hex>.<png|jpg|webp|gif>", async () => {
    const hex = "a".repeat(64);
    const names = [
      `${"A".repeat(64)}.png`,
      `${"a".repeat(63)}.png`,
      `${hex}.jpeg`,
      `${hex}.svg`,
      `${hex}.PNG`,
      hex,
      "logo.png",
    ];
    // Each name exists in the bucket, so a 404 here is the name gate
    // refusing it, not the object being absent.
    for (const file of names) await bucket.put(`news/${file}`, png());
    for (const file of names) {
      const res = await serve(file);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });

  test("404 not_found when the object is not in the bucket", async () => {
    const res = await serve(`${"e".repeat(64)}.webp`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  test("304 with the cache headers when If-None-Match names the stored ETag", async () => {
    const bytes = png(32);
    await upload(bytes, "image/png");
    const file = `${sha256(bytes)}.png`;
    const etag = (await bucket.head(`news/${file}`))?.httpEtag;
    expect(etag).toBeTruthy();

    for (const tag of [String(etag), `W/${etag}`]) {
      const res = await serve(file, { "If-None-Match": tag });
      expect(res.status).toBe(304);
      expect(res.headers.get("etag")).toBe(String(etag));
      expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await res.text()).toBe("");
    }
  });

  test("a revalidation for a missing object is still a 404", async () => {
    const res = await serve(`${"f".repeat(64)}.gif`, { "If-None-Match": '"abc"' });
    expect(res.status).toBe(404);
  });

  test("503 storage_unavailable when the NEWS_MEDIA binding is missing", async () => {
    const res = await serve(`${"a".repeat(64)}.png`, {}, false);
    expect(res.status).toBe(503);
  });
});
