/**
 * Admin routes: news posts and their images (#1551).
 *
 *   GET    /admin/news          every post, drafts and scheduled included
 *   GET    /admin/news/:id
 *   POST   /admin/news          create            201 | 409 slug_taken
 *   PUT    /admin/news/:id      full replacement  200 | 404 | 409 slug_taken
 *   DELETE /admin/news/:id                        200 | 404
 *   POST   /admin/news/media    raw image body -> { url, content_type, bytes }
 *
 * Validation failures answer with zValidator's default 400 envelope, the
 * same one the notices routes produce.
 */

import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import {
  NEWS_CATEGORIES,
  NEWS_SLUG_MAX,
  NEWS_SLUG_MIN,
  NEWS_SLUG_RE,
  NEWS_STATUSES,
  NewsSlugTakenError,
  type NewsWrite,
  RESERVED_NEWS_SLUGS,
  createNews,
  deleteNews,
  getNewsById,
  listAllNews,
  updateNews,
} from "../../services/news";
import {
  NEWS_BANNER_URL_RE,
  NEWS_MEDIA_MAX_BYTES,
  declaredImageType,
  readBodyCapped,
  sniffImageType,
  storeNewsImage,
} from "../../services/news-media";
import { hasRealUtcOffset } from "./notices";
import type { AdminRouter } from "./shared";

/**
 * `NewsInput`. Title, summary and alt text are trimmed before their length
 * is checked, so whitespace alone never satisfies a required field; the
 * body is checked for non-whitespace content but stored as sent, because
 * leading indentation and trailing spaces are meaningful in Markdown.
 */
export const newsInputSchema = z
  .object({
    slug: z
      .string()
      .min(NEWS_SLUG_MIN)
      .max(NEWS_SLUG_MAX)
      .regex(NEWS_SLUG_RE, "slug must be lowercase letters and digits joined by single hyphens")
      .refine((slug) => !RESERVED_NEWS_SLUGS.has(slug), {
        message: "slug is reserved",
      }),
    title: z.string().trim().min(1).max(140),
    summary: z.string().trim().min(1).max(300),
    body: z
      .string()
      .min(1)
      .max(50000)
      .refine((body) => body.trim().length > 0, { message: "body must not be blank" }),
    category: z.enum(NEWS_CATEGORIES).default("feature"),
    banner_url: z
      .string()
      .regex(NEWS_BANNER_URL_RE, "banner_url must be a /news/media/<sha256>.<ext> path")
      .nullable()
      .default(null),
    banner_alt: z.string().trim().max(300).default(""),
    status: z.enum(NEWS_STATUSES).default("draft"),
    published_at: z
      .string()
      .datetime({ offset: true })
      .refine(hasRealUtcOffset, {
        message: "published_at has an out-of-range UTC offset (valid offsets are -12:00 to +14:00)",
      })
      .optional(),
  })
  .superRefine((input, ctx) => {
    if (input.banner_url !== null && input.banner_alt === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["banner_alt"],
        message: "banner_alt is required when banner_url is set",
      });
    }
  });

type NewsInput = z.infer<typeof newsInputSchema>;

/** An omitted `published_at` means now, on create and on PUT alike. */
function toWrite(input: NewsInput): NewsWrite {
  return { ...input, published_at: input.published_at ?? new Date().toISOString() };
}

/** A positive integer id from the path, or null (which the caller answers 404). */
function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

const NOT_FOUND = { error: "not_found", message: "News post not found" } as const;

function slugTaken(err: NewsSlugTakenError) {
  return { error: "slug_taken", message: err.message } as const;
}

export function registerNewsRoutes(admin: AdminRouter): void {
  admin.get("/news", async (c) => {
    const posts = await listAllNews(c.env.DB);
    return c.json({ posts });
  });

  admin.get("/news/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    const post = id === null ? null : await getNewsById(c.env.DB, id);
    if (!post) return c.json(NOT_FOUND, 404);
    return c.json({ post });
  });

  admin.post("/news", zValidator("json", newsInputSchema), async (c) => {
    const user = c.get("user");
    try {
      const post = await createNews(c.env.DB, toWrite(c.req.valid("json")), user.id);
      return c.json({ post }, 201);
    } catch (err) {
      if (err instanceof NewsSlugTakenError) return c.json(slugTaken(err), 409);
      throw err;
    }
  });

  admin.put("/news/:id", zValidator("json", newsInputSchema), async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json(NOT_FOUND, 404);
    const user = c.get("user");
    try {
      const post = await updateNews(c.env.DB, id, toWrite(c.req.valid("json")), user.id);
      if (!post) return c.json(NOT_FOUND, 404);
      return c.json({ post });
    } catch (err) {
      if (err instanceof NewsSlugTakenError) return c.json(slugTaken(err), 409);
      throw err;
    }
  });

  admin.delete("/news/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    const deleted = id === null ? false : await deleteNews(c.env.DB, id);
    if (!deleted) return c.json(NOT_FOUND, 404);
    return c.json({ ok: true });
  });

  /**
   * Raw body, not multipart: the Content-Type header IS the declared image
   * type. Checks run cheapest first and all of them before anything is
   * written: the declared type (415), the size (413, from Content-Length
   * when sent and again while reading, so a missing or false header cannot
   * get past it), an empty body (400), and the magic bytes against the
   * declared type (400 type_mismatch).
   */
  admin.post("/news/media", async (c) => {
    const declared = declaredImageType(c.req.header("content-type"));
    if (!declared) {
      return c.json(
        {
          error: "unsupported_media_type",
          message: "Content-Type must be image/png, image/jpeg, image/webp or image/gif",
        },
        415,
      );
    }

    const tooLarge = {
      error: "too_large",
      message: `Images are limited to ${NEWS_MEDIA_MAX_BYTES} bytes (5 MiB)`,
    } as const;
    const declaredLength = Number(c.req.header("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > NEWS_MEDIA_MAX_BYTES) {
      return c.json(tooLarge, 413);
    }
    const bytes = await readBodyCapped(c.req.raw, NEWS_MEDIA_MAX_BYTES);
    if (bytes === null) return c.json(tooLarge, 413);
    if (bytes.length === 0) {
      return c.json({ error: "empty_body", message: "The request body is empty" }, 400);
    }

    const sniffed = sniffImageType(bytes);
    if (sniffed !== declared) {
      return c.json(
        {
          error: "type_mismatch",
          message: `Content-Type says ${declared} but the bytes are ${sniffed ?? "not a supported image"}`,
        },
        400,
      );
    }

    const bucket = c.env.NEWS_MEDIA;
    if (!bucket) {
      console.error("[news] NEWS_MEDIA binding is missing; cannot store an upload");
      return c.json(
        { error: "storage_unavailable", message: "Image storage is not configured" },
        503,
      );
    }
    const stored = await storeNewsImage(bucket, bytes, declared);
    return c.json({ url: stored.url, content_type: stored.content_type, bytes: stored.bytes }, 201);
  });
}
