/**
 * Public news routes (#1551), mounted at `/news` on the `api` app (so also
 * at `/nemar/news`). No authentication: only publicly visible posts are
 * reachable here (see NEWS_PUBLIC_FILTER); drafts and scheduled posts are
 * read through the admin routes.
 *
 *   GET /news?limit=&offset=   cards, newest first
 *   GET /news/media/:file      an image from the NEWS_MEDIA bucket
 *   GET /news/:slug            one post, with its Markdown body
 *
 * The website fetches all three server-side and serves the images from its
 * own origin, so the Cross-Origin-Resource-Policy: same-origin header the
 * global secureHeaders() adds does not get in its way.
 */

import { Hono } from "hono";
import {
  NEWS_PAGE_DEFAULT,
  NEWS_PAGE_MAX,
  getPublicNewsBySlug,
  listPublicNews,
} from "../services/news";
import {
  NEWS_MEDIA_CACHE_CONTROL,
  NEWS_MEDIA_PREFIX,
  contentTypeForFile,
  singleIfNoneMatch,
} from "../services/news-media";
import type { Bindings, Variables } from "../types/bindings";

export const newsRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/**
 * `limit` and `offset` never fail a request: a missing or unparseable value
 * takes the default, and an out-of-range one is clamped (limit 1..50,
 * offset >= 0). Same shape as GET /datasets.
 */
export function parseNewsPage(
  rawLimit: string | undefined,
  rawOffset: string | undefined,
): { limit: number; offset: number } {
  const limit = Number.parseInt(rawLimit ?? "", 10);
  const offset = Number.parseInt(rawOffset ?? "", 10);
  return {
    limit: Math.min(Math.max(Number.isNaN(limit) ? NEWS_PAGE_DEFAULT : limit, 1), NEWS_PAGE_MAX),
    offset: Math.max(Number.isNaN(offset) ? 0 : offset, 0),
  };
}

/** R2 returns metadata without a body when an `onlyIf` condition fails. */
function hasBody(object: R2Object | R2ObjectBody): object is R2ObjectBody {
  return "body" in object;
}

newsRoutes.get("/", async (c) => {
  const page = parseNewsPage(c.req.query("limit"), c.req.query("offset"));
  const { posts, total_count } = await listPublicNews(c.env.DB, page);
  return c.json({ posts, total_count, limit: page.limit, offset: page.offset });
});

/**
 * Registered before `/:slug` for readability only: the two patterns have
 * different segment counts, so neither can shadow the other. `media` is a
 * reserved slug, so `GET /news/media` itself is an ordinary 404 below.
 */
newsRoutes.get("/media/:file", async (c) => {
  const file = c.req.param("file");
  const fallbackType = contentTypeForFile(file);
  if (!fallbackType) return c.json({ error: "not_found" }, 404);

  const bucket = c.env.NEWS_MEDIA;
  if (!bucket) {
    console.error("[news] NEWS_MEDIA binding is missing; cannot serve", file);
    return c.json(
      { error: "storage_unavailable", message: "Image storage is not configured" },
      503,
    );
  }

  // One round trip either way: with a matching If-None-Match, R2 answers
  // with the object's metadata and no body, which becomes a 304.
  const etag = singleIfNoneMatch(c.req.header("if-none-match"));
  const key = `${NEWS_MEDIA_PREFIX}${file}`;
  const object = etag
    ? await bucket.get(key, { onlyIf: { etagDoesNotMatch: etag } })
    : await bucket.get(key);
  if (!object) return c.json({ error: "not_found" }, 404);

  const headers = new Headers({
    "Cache-Control": NEWS_MEDIA_CACHE_CONTROL,
    ETag: object.httpEtag,
    "X-Content-Type-Options": "nosniff",
  });
  if (!hasBody(object)) {
    return new Response(null, { status: 304, headers });
  }
  headers.set("Content-Type", object.httpMetadata?.contentType ?? fallbackType);
  return new Response(object.body, { status: 200, headers });
});

newsRoutes.get("/:slug", async (c) => {
  const post = await getPublicNewsBySlug(c.env.DB, c.req.param("slug"));
  if (!post) {
    return c.json({ error: "not_found", message: "News post not found" }, 404);
  }
  return c.json({ post });
});
