/**
 * News posts (#1551): the public read routes and the admin CRUD routes.
 *
 * Driven through the worker entry (`worker.fetch`), the way Cloudflare calls
 * it, so the mount at `/news` (and `/nemar/news`), the admin router's auth
 * and role middleware, and the global middleware are all the real ones.
 * Real engine: every migration applied to bun:sqlite behind realD1, real
 * hashed API keys. No mocks.
 *
 * The image routes are covered in news-media-routes.test.ts.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import worker from "../src/index";
import { NEWS_PUBLIC_FILTER } from "../src/services/news";
import { hashApiKey } from "../src/services/token";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "news-routes-admin-key-0123456789abcdef0123456";
const EDITOR_KEY = "news-routes-editor-key-0123456789abcdef012345";
const MEMBER_KEY = "news-routes-member-key-0123456789abcdef012345";

const API = "https://api.nemar.org";

const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    p.catch(() => {});
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

let db: Database;
let adminId: number;
let editorId: number;

/** `development` takes the documented rate-limit bypass: `caches.default`
 *  does not exist under bun:test. */
function env(): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "development" } as unknown as Bindings;
}

function call(
  path: string,
  init: { method?: string; key?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.key) headers.Authorization = `Bearer ${init.key}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  return worker.fetch(
    new Request(`${API}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    env(),
    ctx,
  );
}

async function seedActor(username: string, role: "admin" | "member", apiKey: string) {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access)
     VALUES (?, ?, 'x', 'approved', ?, 1, 1)`,
  ).run(username, `${username}@example.org`, role);
  const row = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username);
  if (!row) throw new Error("seed: actor insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    row.id,
    await hashApiKey(apiKey),
    apiKey.slice(0, 8),
  );
  return row.id;
}

/** A complete, valid NewsInput; override what a test is about. */
function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: "first-post",
    title: "First post",
    summary: "A short summary.",
    body: "# Heading\n\nSome **Markdown**.",
    ...overrides,
  };
}

/** A complete PUT body: PUT is a full replacement and requires every field. */
function replaceInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return input({
    category: "feature",
    banner_url: null,
    banner_alt: "",
    status: "draft",
    published_at: "2026-01-01T00:00:00Z",
    ...overrides,
  });
}

async function create(overrides: Record<string, unknown> = {}) {
  const res = await call("/admin/news", { method: "POST", key: ADMIN_KEY, body: input(overrides) });
  if (res.status !== 201) {
    throw new Error(`create failed: ${res.status} ${await res.text()}`);
  }
  return ((await res.json()) as { post: Record<string, unknown> }).post;
}

function rawRow(id: unknown) {
  return db
    .query<Record<string, unknown>, [number]>("SELECT * FROM news_posts WHERE id = ?")
    .get(Number(id));
}

/** Midnight UTC today, as RFC3339: already past (unless the suite runs at
 *  exactly 00:00:00), and on the same date as datetime('now'). */
function midnightTodayIso(): string {
  return `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
}

function isoInHours(hours: number): string {
  return new Date(Date.now() + hours * 3600_000).toISOString();
}

beforeEach(async () => {
  db = freshDb();
  adminId = await seedActor("newsadmin", "admin", ADMIN_KEY);
  editorId = await seedActor("newseditor", "admin", EDITOR_KEY);
  await seedActor("newsmember", "member", MEMBER_KEY);
});

describe("GET /news (public list)", () => {
  test("shows published posts only: drafts and scheduled posts are hidden", async () => {
    await create({ slug: "draft-post", status: "draft", published_at: "2020-01-01T00:00:00Z" });
    await create({ slug: "scheduled-post", status: "published", published_at: isoInHours(2) });
    await create({
      slug: "backdated-post",
      status: "published",
      published_at: "2020-01-01T00:00:00Z",
    });

    const res = await call("/news");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { posts: { slug: string }[]; total_count: number };
    expect(body.posts.map((p) => p.slug)).toEqual(["backdated-post"]);
    expect(body.total_count).toBe(1);
  });

  test("a scheduled post appears once its published_at has passed", async () => {
    const post = await create({ slug: "later", status: "published", published_at: isoInHours(1) });
    expect(((await (await call("/news")).json()) as { posts: unknown[] }).posts).toEqual([]);

    // Time passing, written the way the service writes it.
    db.query("UPDATE news_posts SET published_at = datetime('now', '-1 minute') WHERE id = ?").run(
      Number(post.id),
    );
    const after = (await (await call("/news")).json()) as { posts: { slug: string }[] };
    expect(after.posts.map((p) => p.slug)).toEqual(["later"]);
  });

  test("a post published earlier TODAY is visible (the #1024 same-day comparison)", async () => {
    // The regression this pins: stored as RFC3339, `...T00:00:00Z` compares
    // greater than `datetime('now')` all day long (T sorts after a space),
    // so this post would stay hidden until tomorrow.
    const post = await create({
      slug: "today",
      status: "published",
      published_at: midnightTodayIso(),
    });
    expect(rawRow(post.id)?.published_at).toBe(`${new Date().toISOString().slice(0, 10)} 00:00:00`);
    const list = (await (await call("/news")).json()) as { posts: { slug: string }[] };
    expect(list.posts.map((p) => p.slug)).toEqual(["today"]);
    expect((await call("/news/today")).status).toBe(200);
  });

  test("orders by published_at DESC, then id DESC for posts dated the same second", async () => {
    await create({ slug: "oldest", status: "published", published_at: "2021-01-01T00:00:00Z" });
    await create({ slug: "tie-first", status: "published", published_at: "2023-06-01T12:00:00Z" });
    await create({ slug: "newest", status: "published", published_at: "2024-01-01T00:00:00Z" });
    await create({ slug: "tie-second", status: "published", published_at: "2023-06-01T12:00:00Z" });

    const body = (await (await call("/news")).json()) as { posts: { slug: string }[] };
    expect(body.posts.map((p) => p.slug)).toEqual(["newest", "tie-second", "tie-first", "oldest"]);
  });

  test("cards carry the summary shape: no body, no author ids, RFC3339 UTC timestamps", async () => {
    await create({ slug: "shape", status: "published", published_at: "2022-03-04T05:06:07Z" });
    const body = (await (await call("/news")).json()) as { posts: Record<string, unknown>[] };
    expect(Object.keys(body.posts[0] ?? {}).sort()).toEqual(
      [
        "banner_alt",
        "banner_url",
        "category",
        "created_at",
        "id",
        "published_at",
        "slug",
        "status",
        "summary",
        "title",
        "updated_at",
      ].sort(),
    );
    expect(body.posts[0]?.published_at).toBe("2022-03-04T05:06:07Z");
    expect(String(body.posts[0]?.created_at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  describe("pagination", () => {
    beforeEach(async () => {
      for (let i = 1; i <= 12; i++) {
        const day = String(i).padStart(2, "0");
        await create({
          slug: `post-${day}`,
          status: "published",
          published_at: `2024-01-${day}T00:00:00Z`,
        });
      }
    });

    async function page(query: string) {
      const res = await call(`/news${query}`);
      expect(res.status).toBe(200);
      return (await res.json()) as {
        posts: { slug: string }[];
        total_count: number;
        limit: number;
        offset: number;
      };
    }

    test("defaults to limit 10, offset 0, with the full total_count", async () => {
      const body = await page("");
      expect(body.limit).toBe(10);
      expect(body.offset).toBe(0);
      expect(body.total_count).toBe(12);
      expect(body.posts).toHaveLength(10);
      expect(body.posts[0]?.slug).toBe("post-12");
    });

    test("is short-cached at the edge", async () => {
      const res = await call("/news");
      expect(res.headers.get("cache-control")).toMatch(/^public, max-age=30, s-maxage=300/);
    });

    test("limit and offset select the page", async () => {
      const body = await page("?limit=5&offset=10");
      expect(body.posts.map((p) => p.slug)).toEqual(["post-02", "post-01"]);
      expect(body.total_count).toBe(12);
    });

    test("out-of-range and unparseable values are clamped, never a 400", async () => {
      expect((await page("?limit=0")).limit).toBe(1);
      expect((await page("?limit=-4")).posts).toHaveLength(1);
      expect((await page("?limit=1000")).limit).toBe(50);
      expect((await page("?limit=abc")).limit).toBe(10);
      expect((await page("?offset=-3")).offset).toBe(0);
      expect((await page("?offset=abc")).offset).toBe(0);
      // Past SQLite's 64-bit integer range: D1 would refuse it with a 500.
      expect((await page("?offset=10000000000000000000")).offset).toBe(1_000_000);
      const past = await page("?offset=500");
      expect(past.posts).toEqual([]);
      expect(past.total_count).toBe(12);
    });

    test("more than 50 posts: the cap is what limits the page", async () => {
      for (let i = 13; i <= 60; i++) {
        await create({
          slug: `extra-${i}`,
          status: "published",
          published_at: "2020-01-01T00:00:00Z",
        });
      }
      const body = await page("?limit=999");
      expect(body.limit).toBe(50);
      expect(body.posts).toHaveLength(50);
      expect(body.total_count).toBe(60);
    });
  });

  test("is also served under the legacy /nemar prefix", async () => {
    await create({ slug: "prefixed", status: "published", published_at: "2020-01-01T00:00:00Z" });
    const res = await call("/nemar/news");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { total_count: number }).total_count).toBe(1);
  });
});

describe("GET /news/:slug (public detail)", () => {
  test("returns a visible post with its Markdown body", async () => {
    await create({ slug: "detail", status: "published", published_at: "2020-01-01T00:00:00Z" });
    const res = await call("/news/detail");
    expect(res.status).toBe(200);
    const { post } = (await res.json()) as { post: Record<string, unknown> };
    expect(post.body).toBe("# Heading\n\nSome **Markdown**.");
    expect(post.slug).toBe("detail");
    expect(post).not.toHaveProperty("created_by");
    expect(post).not.toHaveProperty("updated_by");
    expect(res.headers.get("cache-control")).toMatch(/^public, max-age=30, s-maxage=300/);
  });

  test("404s for a missing, draft, or scheduled slug, all with the same body", async () => {
    await create({ slug: "a-draft", status: "draft", published_at: "2020-01-01T00:00:00Z" });
    await create({ slug: "a-scheduled", status: "published", published_at: isoInHours(3) });
    for (const slug of ["no-such-post", "a-draft", "a-scheduled", "media"]) {
      // Never cached: a scheduled post turns from 404 to 200 at its time.
      const res = await call(`/news/${slug}`);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: "not_found", message: "News post not found" });
    }
  });
});

describe("admin routes require an admin", () => {
  test("a member is refused and nothing is written", async () => {
    const res = await call("/admin/news", { method: "POST", key: MEMBER_KEY, body: input() });
    expect(res.status).toBe(403);
    expect(db.query("SELECT COUNT(*) AS n FROM news_posts").get()).toEqual({ n: 0 });
  });

  test("no credentials is a 401", async () => {
    expect((await call("/admin/news")).status).toBe(401);
  });
});

describe("POST /admin/news", () => {
  test("creates a post with the documented defaults and records the author", async () => {
    const before = Date.now();
    const post = await create();
    expect(post).toMatchObject({
      slug: "first-post",
      title: "First post",
      summary: "A short summary.",
      body: "# Heading\n\nSome **Markdown**.",
      category: "feature",
      banner_url: null,
      banner_alt: "",
      status: "draft",
    });
    // published_at defaults to now (second resolution).
    const publishedAt = Date.parse(String(post.published_at));
    expect(publishedAt).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(publishedAt).toBeLessThanOrEqual(Date.now());
    const row = rawRow(post.id);
    expect(row?.created_by).toBe(adminId);
    expect(row?.updated_by).toBe(adminId);
  });

  test("stores published_at normalized to UTC in datetime() form", async () => {
    const post = await create({ published_at: "2026-07-25T14:30:00+02:00" });
    expect(rawRow(post.id)?.published_at).toBe("2026-07-25 12:30:00");
    expect(post.published_at).toBe("2026-07-25T12:30:00Z");

    // The column holds exactly what the visibility filter compares against.
    const visible = db
      .query(`SELECT COUNT(*) AS n FROM news_posts WHERE ${NEWS_PUBLIC_FILTER}`)
      .get() as { n: number };
    expect(visible.n).toBe(0); // still a draft
  });

  test("trims title, summary and banner_alt; keeps the body byte-for-byte", async () => {
    const body = "    indented code\n\ntrailing two spaces  ";
    const post = await create({
      title: "  Padded title  ",
      summary: "\tPadded summary\n",
      body,
      banner_url: `/news/media/${"a".repeat(64)}.png`,
      banner_alt: "  A diagram  ",
    });
    expect(post.title).toBe("Padded title");
    expect(post.summary).toBe("Padded summary");
    expect(post.banner_alt).toBe("A diagram");
    expect(post.body).toBe(body);
  });

  test("409 slug_taken on a duplicate slug", async () => {
    await create({ slug: "taken" });
    const res = await call("/admin/news", {
      method: "POST",
      key: ADMIN_KEY,
      body: input({ slug: "taken", title: "Another" }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("slug_taken");
    expect(db.query("SELECT COUNT(*) AS n FROM news_posts").get()).toEqual({ n: 1 });
  });

  describe("slug rules", () => {
    const valid = ["abc", "a1-b2-c3", "2026-annual-report", "x".repeat(80)];
    const invalid = [
      "ab",
      "x".repeat(81),
      "Has-Caps",
      "double--hyphen",
      "-leading",
      "trailing-",
      "under_score",
      "sp ace",
      "media",
      "",
    ];

    for (const slug of valid) {
      test(`accepts ${JSON.stringify(slug.length > 20 ? `${slug.slice(0, 8)}...(${slug.length})` : slug)}`, async () => {
        const res = await call("/admin/news", {
          method: "POST",
          key: ADMIN_KEY,
          body: input({ slug }),
        });
        expect(res.status).toBe(201);
      });
    }

    for (const slug of invalid) {
      test(`refuses ${JSON.stringify(slug.length > 20 ? `${slug.slice(0, 8)}...(${slug.length})` : slug)}`, async () => {
        const res = await call("/admin/news", {
          method: "POST",
          key: ADMIN_KEY,
          body: input({ slug }),
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as {
          success: boolean;
          error: { issues: { path: string[] }[] };
        };
        expect(body.success).toBe(false);
        expect(body.error.issues.some((i) => i.path[0] === "slug")).toBe(true);
      });
    }
  });

  describe("field validation", () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ["blank title", { title: "   " }, "title"],
      ["141-char title", { title: "t".repeat(141) }, "title"],
      ["empty summary", { summary: "" }, "summary"],
      ["301-char summary", { summary: "s".repeat(301) }, "summary"],
      ["blank body", { body: " \n\t " }, "body"],
      ["50001-char body", { body: "b".repeat(50001) }, "body"],
      ["unknown category", { category: "blog" }, "category"],
      ["unknown status", { status: "archived" }, "status"],
      [
        "banner_url outside /news/media",
        { banner_url: "https://example.org/x.png", banner_alt: "x" },
        "banner_url",
      ],
      [
        "banner_url with a short hash",
        { banner_url: `/news/media/${"a".repeat(63)}.png`, banner_alt: "x" },
        "banner_url",
      ],
      [
        "banner_url with an svg",
        { banner_url: `/news/media/${"a".repeat(64)}.svg`, banner_alt: "x" },
        "banner_url",
      ],
      [
        "banner_url without banner_alt",
        { banner_url: `/news/media/${"b".repeat(64)}.webp` },
        "banner_alt",
      ],
      [
        "banner_url with blank banner_alt",
        { banner_url: `/news/media/${"b".repeat(64)}.webp`, banner_alt: "  " },
        "banner_alt",
      ],
      ["301-char banner_alt", { banner_alt: "a".repeat(301) }, "banner_alt"],
      ["published_at without an offset", { published_at: "2026-07-25T14:30:00" }, "published_at"],
      [
        "published_at with a non-existent offset",
        { published_at: "2026-07-25T14:30:00+15:00" },
        "published_at",
      ],
      ["published_at as a date only", { published_at: "2026-07-25" }, "published_at"],
    ];

    for (const [name, overrides, field] of cases) {
      test(`400 for ${name}`, async () => {
        const res = await call("/admin/news", {
          method: "POST",
          key: ADMIN_KEY,
          body: input(overrides),
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { issues: { path: string[] }[] } };
        expect(body.error.issues.map((i) => i.path[0])).toContain(field);
      });
    }

    test("a banner with alt text is accepted, and null clears it", async () => {
      const banner = `/news/media/${"c".repeat(64)}.jpg`;
      const post = await create({ banner_url: banner, banner_alt: "Poster" });
      expect(post.banner_url).toBe(banner);
      const cleared = await create({ slug: "no-banner", banner_url: null, banner_alt: "" });
      expect(cleared.banner_url).toBeNull();
    });

    describe("published_at year bounds", () => {
      const message = "published_at must be in the years 2000 through 2100";

      function publishedAtMessages(body: unknown): string[] {
        const { issues } = (body as { error: { issues: { path: string[]; message: string }[] } })
          .error;
        return issues.filter((i) => i.path[0] === "published_at").map((i) => i.message);
      }

      // Both pass zod's datetime check. SQLite's datetime() returns NULL for
      // the first (year 10000 once the -12:00 offset is applied), which
      // failed the NOT NULL insert as a 500, and stores the second as year
      // -0001.
      for (const published_at of ["9999-12-31T23:59:59-12:00", "0000-01-01T00:00:00+14:00"]) {
        test(`POST and PUT refuse ${published_at} with a 400 naming the field`, async () => {
          const created = await call("/admin/news", {
            method: "POST",
            key: ADMIN_KEY,
            body: input({ published_at }),
          });
          expect(created.status).toBe(400);
          expect(publishedAtMessages(await created.json())).toEqual([message]);
          expect(db.query("SELECT COUNT(*) AS n FROM news_posts").get()).toEqual({ n: 0 });

          const post = await create();
          const storedBefore = rawRow(post.id)?.published_at;
          const replaced = await call(`/admin/news/${post.id}`, {
            method: "PUT",
            key: ADMIN_KEY,
            body: replaceInput({ published_at }),
          });
          expect(replaced.status).toBe(400);
          expect(publishedAtMessages(await replaced.json())).toEqual([message]);
          expect(rawRow(post.id)?.published_at).toBe(storedBefore);
        });
      }

      test("the years just outside the window are refused", async () => {
        for (const published_at of ["1999-12-31T23:59:59Z", "2101-01-01T00:00:00Z"]) {
          const res = await call("/admin/news", {
            method: "POST",
            key: ADMIN_KEY,
            body: input({ published_at }),
          });
          expect(res.status).toBe(400);
          expect(publishedAtMessages(await res.json())).toEqual([message]);
        }
      });

      test("the edge years are accepted, even when the offset moves them out of it in UTC", async () => {
        const earliest = await create({
          slug: "earliest",
          published_at: "2000-01-01T00:00:00+14:00",
        });
        expect(rawRow(earliest.id)?.published_at).toBe("1999-12-31 10:00:00");
        const latest = await create({ slug: "latest", published_at: "2100-12-31T23:59:59-12:00" });
        expect(rawRow(latest.id)?.published_at).toBe("2101-01-01 11:59:59");
        expect(latest.published_at).toBe("2101-01-01T11:59:59Z");
      });
    });

    test("the validation envelope is the one the notices route produces", async () => {
      const news = await call("/admin/news", { method: "POST", key: ADMIN_KEY, body: {} });
      const notice = await call("/admin/notices", { method: "POST", key: ADMIN_KEY, body: {} });
      expect(news.status).toBe(400);
      expect(notice.status).toBe(400);
      const a = (await news.json()) as { success: boolean; error: { name: string } };
      const b = (await notice.json()) as { success: boolean; error: { name: string } };
      expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
      expect(a.success).toBe(b.success);
      expect(a.error.name).toBe(b.error.name);
    });
  });
});

describe("GET /admin/news and /admin/news/:id", () => {
  test("lists every post, drafts and scheduled included, newest first", async () => {
    await create({ slug: "draft-one", status: "draft", published_at: "2022-01-01T00:00:00Z" });
    await create({ slug: "future-one", status: "published", published_at: isoInHours(24) });
    await create({ slug: "live-one", status: "published", published_at: "2023-01-01T00:00:00Z" });

    const res = await call("/admin/news", { key: ADMIN_KEY });
    expect(res.status).toBe(200);
    const { posts } = (await res.json()) as { posts: { slug: string; body: string }[] };
    expect(posts.map((p) => p.slug)).toEqual(["future-one", "live-one", "draft-one"]);
    // Admin rows are full posts.
    expect(posts[0]?.body).toBe("# Heading\n\nSome **Markdown**.");
  });

  test("fetches one post by id, drafts included", async () => {
    const post = await create({ slug: "by-id", status: "draft" });
    const res = await call(`/admin/news/${post.id}`, { key: ADMIN_KEY });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { post: { slug: string } }).post.slug).toBe("by-id");
  });

  test("404 for an unknown or malformed id", async () => {
    for (const id of ["999", "abc", "0", "-1", "1.5"]) {
      const res = await call(`/admin/news/${id}`, { key: ADMIN_KEY });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe("not_found");
    }
  });
});

describe("PUT /admin/news/:id", () => {
  test("replaces the post, bumps updated_at, and records the editor", async () => {
    const post = await create({ slug: "editable", category: "event", status: "draft" });
    // Age the row so a bump is observable within the same second.
    db.query(
      "UPDATE news_posts SET created_at = '2020-01-01 00:00:00', updated_at = '2020-01-01 00:00:00' WHERE id = ?",
    ).run(Number(post.id));

    const res = await call(`/admin/news/${post.id}`, {
      method: "PUT",
      key: EDITOR_KEY,
      body: replaceInput({
        slug: "edited",
        title: "Edited title",
        category: "data",
        status: "published",
        published_at: "2021-02-03T04:05:06Z",
      }),
    });
    expect(res.status).toBe(200);
    const { post: updated } = (await res.json()) as { post: Record<string, unknown> };
    expect(updated).toMatchObject({
      id: post.id,
      slug: "edited",
      title: "Edited title",
      category: "data",
      status: "published",
      published_at: "2021-02-03T04:05:06Z",
      created_at: "2020-01-01T00:00:00Z",
    });
    expect(updated.updated_at).not.toBe("2020-01-01T00:00:00Z");
    expect(Date.now() - Date.parse(String(updated.updated_at))).toBeLessThan(60_000);

    const row = rawRow(post.id);
    expect(row?.created_by).toBe(adminId);
    expect(row?.updated_by).toBe(editorId);
    expect(row?.published_at).toBe("2021-02-03 04:05:06");
  });

  test("400 for a partial body: an omitted field must not unpublish or re-date the post", async () => {
    const post = await create({
      category: "event",
      status: "published",
      published_at: "2020-01-01T00:00:00Z",
    });
    for (const omitted of ["status", "published_at", "category", "banner_url", "banner_alt"]) {
      const body = replaceInput({ status: "published", published_at: "2020-01-01T00:00:00Z" });
      delete body[omitted];
      const res = await call(`/admin/news/${post.id}`, { method: "PUT", key: ADMIN_KEY, body });
      expect(res.status).toBe(400);
    }
    const res = await call(`/admin/news/${post.id}`, {
      method: "PUT",
      key: ADMIN_KEY,
      body: input({ title: "Only the typo fixed" }),
    });
    expect(res.status).toBe(400);
    const row = rawRow(post.id);
    expect(row?.status).toBe("published");
    expect(row?.published_at).toBe("2020-01-01 00:00:00");
  });

  test("keeping its own slug is not a conflict", async () => {
    const post = await create({ slug: "same-slug" });
    const res = await call(`/admin/news/${post.id}`, {
      method: "PUT",
      key: ADMIN_KEY,
      body: replaceInput({ slug: "same-slug", title: "New title" }),
    });
    expect(res.status).toBe(200);
  });

  test("409 slug_taken when the new slug belongs to another post", async () => {
    await create({ slug: "owner" });
    const other = await create({ slug: "other" });
    const res = await call(`/admin/news/${other.id}`, {
      method: "PUT",
      key: ADMIN_KEY,
      body: replaceInput({ slug: "owner" }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("slug_taken");
    expect(rawRow(other.id)?.slug).toBe("other");
  });

  test("404 for an unknown id, 400 for an invalid body", async () => {
    const missing = await call("/admin/news/424242", {
      method: "PUT",
      key: ADMIN_KEY,
      body: replaceInput(),
    });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toBe("not_found");

    const post = await create();
    const invalid = await call(`/admin/news/${post.id}`, {
      method: "PUT",
      key: ADMIN_KEY,
      body: replaceInput({ slug: "media" }),
    });
    expect(invalid.status).toBe(400);
    expect(rawRow(post.id)?.slug).toBe("first-post");
  });
});

describe("DELETE /admin/news/:id", () => {
  test("deletes the post; a second delete is a 404", async () => {
    const post = await create({ status: "published", published_at: "2020-01-01T00:00:00Z" });
    const res = await call(`/admin/news/${post.id}`, { method: "DELETE", key: ADMIN_KEY });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(rawRow(post.id)).toBeNull();
    expect((await call("/news/first-post")).status).toBe(404);

    const again = await call(`/admin/news/${post.id}`, { method: "DELETE", key: ADMIN_KEY });
    expect(again.status).toBe(404);
  });

  test("404 for a malformed id", async () => {
    expect((await call("/admin/news/abc", { method: "DELETE", key: ADMIN_KEY })).status).toBe(404);
  });
});

describe("audit_log rows for admin writes", () => {
  interface AuditRow {
    user_id: number;
    action: string;
    resource_type: string;
    resource_id: string;
    details: Record<string, unknown>;
  }

  function newsAuditRows(): AuditRow[] {
    return db
      .query<Omit<AuditRow, "details"> & { details: string }, []>(
        `SELECT user_id, action, resource_type, resource_id, details
           FROM audit_log WHERE action LIKE 'news_post_%' ORDER BY id`,
      )
      .all()
      .map((row) => ({ ...row, details: JSON.parse(row.details) as Record<string, unknown> }));
  }

  test("create, update and delete each write one row with the post id, slug and actor", async () => {
    const post = await create({ slug: "audited", published_at: "2026-05-01T09:00:00+02:00" });
    const id = String(post.id);
    expect(newsAuditRows()).toEqual([
      {
        user_id: adminId,
        action: "news_post_created",
        resource_type: "news_post",
        resource_id: id,
        details: {
          id: Number(id),
          slug: "audited",
          status: "draft",
          published_at: "2026-05-01T07:00:00Z",
          actor: "newsadmin",
        },
      },
    ]);

    const put = await call(`/admin/news/${id}`, {
      method: "PUT",
      key: EDITOR_KEY,
      body: replaceInput({
        slug: "audited-renamed",
        status: "published",
        published_at: "2026-05-02T00:00:00Z",
      }),
    });
    expect(put.status).toBe(200);
    // The row describes the post as the update left it.
    expect(newsAuditRows()[1]).toEqual({
      user_id: editorId,
      action: "news_post_updated",
      resource_type: "news_post",
      resource_id: id,
      details: {
        id: Number(id),
        slug: "audited-renamed",
        status: "published",
        published_at: "2026-05-02T00:00:00Z",
        actor: "newseditor",
      },
    });

    expect((await call(`/admin/news/${id}`, { method: "DELETE", key: ADMIN_KEY })).status).toBe(
      200,
    );
    // And the delete's row describes the post it removed.
    expect(newsAuditRows()[2]).toEqual({
      user_id: adminId,
      action: "news_post_deleted",
      resource_type: "news_post",
      resource_id: id,
      details: {
        id: Number(id),
        slug: "audited-renamed",
        status: "published",
        published_at: "2026-05-02T00:00:00Z",
        actor: "newsadmin",
      },
    });
    expect(newsAuditRows()).toHaveLength(3);
  });

  test("a refused or missed write leaves no audit row", async () => {
    const owner = await create({ slug: "owner" });
    const other = await create({ slug: "other" });
    const before = newsAuditRows();
    expect(before.map((r) => r.action)).toEqual(["news_post_created", "news_post_created"]);

    const refused: [string, { method: string; key: string; body?: unknown }, number][] = [
      ["/admin/news", { method: "POST", key: ADMIN_KEY, body: input({ slug: "owner" }) }, 409],
      ["/admin/news", { method: "POST", key: ADMIN_KEY, body: input({ title: " " }) }, 400],
      ["/admin/news", { method: "POST", key: MEMBER_KEY, body: input({ slug: "member" }) }, 403],
      [
        `/admin/news/${other.id}`,
        { method: "PUT", key: ADMIN_KEY, body: replaceInput({ slug: "owner" }) },
        409,
      ],
      ["/admin/news/424242", { method: "PUT", key: ADMIN_KEY, body: replaceInput() }, 404],
      ["/admin/news/424242", { method: "DELETE", key: ADMIN_KEY }, 404],
      [`/admin/news/${owner.id}`, { method: "DELETE", key: MEMBER_KEY }, 403],
    ];
    for (const [path, init, status] of refused) {
      expect((await call(path, init)).status).toBe(status);
    }
    expect(newsAuditRows()).toEqual(before);
  });

  describe("a failed audit insert rolls the write back", () => {
    function breakNewsAudit() {
      db.exec(
        `CREATE TRIGGER news_audit_down BEFORE INSERT ON audit_log
           WHEN NEW.action LIKE 'news_post_%'
         BEGIN SELECT RAISE(ABORT, 'audit_log unavailable'); END`,
      );
    }

    test("create: 500 and no post", async () => {
      breakNewsAudit();
      const res = await call("/admin/news", { method: "POST", key: ADMIN_KEY, body: input() });
      expect(res.status).toBe(500);
      expect(db.query("SELECT COUNT(*) AS n FROM news_posts").get()).toEqual({ n: 0 });
    });

    test("update: 500 and the post unchanged", async () => {
      const post = await create({ slug: "kept", title: "Kept title" });
      breakNewsAudit();
      const res = await call(`/admin/news/${post.id}`, {
        method: "PUT",
        key: ADMIN_KEY,
        body: replaceInput({ slug: "changed", title: "Changed title" }),
      });
      expect(res.status).toBe(500);
      expect(rawRow(post.id)).toMatchObject({ slug: "kept", title: "Kept title" });
    });

    test("delete: 500 and the post still there", async () => {
      const post = await create({ slug: "survivor" });
      breakNewsAudit();
      const res = await call(`/admin/news/${post.id}`, { method: "DELETE", key: ADMIN_KEY });
      expect(res.status).toBe(500);
      expect(rawRow(post.id)?.slug).toBe("survivor");
    });
  });
});

describe("migration 0087 backstops writes that bypass the route", () => {
  function insert(
    published_at: string,
    slug = "direct",
    banner: [string | null, string] = [null, ""],
  ) {
    db.query(
      `INSERT INTO news_posts (slug, title, summary, body, published_at, created_by, banner_url, banner_alt)
       VALUES (?, 't', 's', 'b', ?, ?, ?, ?)`,
    ).run(slug, published_at, adminId, banner[0], banner[1]);
  }

  test("refuses a published_at not in datetime() form", () => {
    expect(() => insert("2026-07-25T12:30:00Z")).toThrow(/CHECK constraint failed/);
    expect(() => insert("2026-07-25 12:30:00")).not.toThrow();
  });

  test("refuses a published_at datetime() cannot read at all", () => {
    // datetime('garbage') is NULL, and a CHECK that evaluates to NULL passes,
    // which is why the constraint also demands IS NOT NULL.
    expect(() => insert("garbage", "junk-date")).toThrow(/CHECK constraint failed/);
  });

  test("refuses the reserved slug and out-of-range lengths", () => {
    expect(() => insert("2026-07-25 12:30:00", "media")).toThrow(/CHECK constraint failed/);
    expect(() => insert("2026-07-25 12:30:00", "ab")).toThrow(/CHECK constraint failed/);
  });

  test("refuses a banner without alt text", () => {
    expect(() => insert("2026-07-25 12:30:00", "bannered", ["/news/media/x.png", ""])).toThrow(
      /CHECK constraint failed/,
    );
  });
});
