/**
 * Admin routes: news posts and their images (#1551).
 *
 *   GET    /admin/news          every post, drafts and scheduled included
 *   GET    /admin/news/:id
 *   POST   /admin/news          create            201 | 409 slug_taken
 *   PUT    /admin/news/:id      full replacement, every field required
 *                                                  200 | 400 | 404 | 409 slug_taken
 *   DELETE /admin/news/:id                        200 | 404
 *   POST   /admin/news/media    raw image body -> { url, content_type, bytes }
 *
 * Every create, update and delete writes an audit_log row in the same D1
 * batch as the write (services/news.ts, newsAuditStatement), so a failed
 * audit insert fails the request with nothing written. An image upload
 * writes a `news_media_uploaded` row before its R2 put (see storeNewsImage).
 *
 * Validation failures answer with zValidator's default 400 envelope, the
 * same one the notices routes produce.
 */

import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import { z } from "zod";

import { auditLogStatement } from "../../db/audit-log";
import {
  NEWS_CATEGORIES,
  NEWS_SLUG_MAX,
  NEWS_SLUG_MIN,
  NEWS_SLUG_RE,
  NEWS_STATUSES,
  type NewsActor,
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
import type { Bindings, Variables } from "../../types/bindings";
import { hasRealUtcOffset } from "./notices";
import type { AdminRouter } from "./shared";

/**
 * The fields every write carries. Title, summary and alt text are trimmed
 * before their length is checked, so whitespace alone never satisfies a
 * required field; the body is checked for non-whitespace content but stored
 * as sent, because leading indentation and trailing spaces are meaningful in
 * Markdown.
 */
const slugField = z
  .string()
  .min(NEWS_SLUG_MIN)
  .max(NEWS_SLUG_MAX)
  .regex(NEWS_SLUG_RE, "slug must be lowercase letters and digits joined by single hyphens")
  .refine((slug) => !RESERVED_NEWS_SLUGS.has(slug), {
    message: "slug is reserved",
  });
const bannerUrlField = z
  .string()
  .regex(NEWS_BANNER_URL_RE, "banner_url must be a /news/media/<sha256>.<ext> path")
  .nullable();
const bannerAltField = z.string().trim().max(300);

/**
 * The years a post may be dated in, as written (before the offset is
 * applied). zod accepts any four-digit year, but SQLite's `datetime()` reads
 * only years 0000 through 9999 once the offset has moved the time to UTC:
 * `9999-12-31T23:59:59-12:00` is year 10000 in UTC, so `datetime()` returns
 * NULL and the NOT NULL insert fails as a 500, and
 * `0000-01-01T00:00:00+14:00` is stored as year -0001. A real post is dated
 * well inside this window, and an offset moves the UTC time by less than a
 * day, so a date inside it always stays readable.
 */
export const NEWS_PUBLISHED_YEAR_MIN = 2000;
export const NEWS_PUBLISHED_YEAR_MAX = 2100;

function hasPublishableYear(value: string): boolean {
  const year = Number(value.slice(0, 4));
  return year >= NEWS_PUBLISHED_YEAR_MIN && year <= NEWS_PUBLISHED_YEAR_MAX;
}

const publishedAtField = z
  .string()
  .datetime({ offset: true })
  .refine(hasRealUtcOffset, {
    message: "published_at has an out-of-range UTC offset (valid offsets are -12:00 to +14:00)",
  })
  .refine(hasPublishableYear, {
    message: `published_at must be in the years ${NEWS_PUBLISHED_YEAR_MIN} through ${NEWS_PUBLISHED_YEAR_MAX}`,
  });

const contentFields = {
  slug: slugField,
  title: z.string().trim().min(1).max(140),
  summary: z.string().trim().min(1).max(300),
  body: z
    .string()
    .min(1)
    .max(50000)
    .refine((body) => body.trim().length > 0, { message: "body must not be blank" }),
};

function requireBannerAlt(
  input: { banner_url: string | null; banner_alt: string },
  ctx: z.RefinementCtx,
): void {
  if (input.banner_url !== null && input.banner_alt === "") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["banner_alt"],
      message: "banner_alt is required when banner_url is set",
    });
  }
}

/** `NewsInput` for POST: optional fields take their defaults. */
export const newsInputSchema = z
  .object({
    ...contentFields,
    category: z.enum(NEWS_CATEGORIES).default("feature"),
    banner_url: bannerUrlField.default(null),
    banner_alt: bannerAltField.default(""),
    status: z.enum(NEWS_STATUSES).default("draft"),
    published_at: publishedAtField.optional(),
  })
  .superRefine(requireBannerAlt);

/**
 * `NewsInput` for PUT, a full replacement: every field is required. With
 * POST's defaults, a client that sent only the text it meant to fix would
 * silently unpublish the post (`status` back to draft), re-date it to now,
 * and drop its banner. Refusing the partial body is the safe answer.
 */
export const newsReplaceSchema = z
  .object({
    ...contentFields,
    category: z.enum(NEWS_CATEGORIES),
    banner_url: bannerUrlField,
    banner_alt: bannerAltField,
    status: z.enum(NEWS_STATUSES),
    published_at: publishedAtField,
  })
  .superRefine(requireBannerAlt);

type NewsInput = z.infer<typeof newsInputSchema> | z.infer<typeof newsReplaceSchema>;

/** An omitted `published_at` (possible on create only) means now. */
function toWrite(input: NewsInput): NewsWrite {
  return { ...input, published_at: input.published_at ?? new Date().toISOString() };
}

/** The signed-in admin, as the audit rows record them. */
function actorOf(c: Context<{ Bindings: Bindings; Variables: Variables }>): NewsActor {
  const user = c.get("user");
  return { id: user.id, username: user.username ?? null };
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
    try {
      const post = await createNews(c.env.DB, toWrite(c.req.valid("json")), actorOf(c));
      return c.json({ post }, 201);
    } catch (err) {
      if (err instanceof NewsSlugTakenError) return c.json(slugTaken(err), 409);
      throw err;
    }
  });

  admin.put("/news/:id", zValidator("json", newsReplaceSchema), async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json(NOT_FOUND, 404);
    try {
      const post = await updateNews(c.env.DB, id, toWrite(c.req.valid("json")), actorOf(c));
      if (!post) return c.json(NOT_FOUND, 404);
      return c.json({ post });
    } catch (err) {
      if (err instanceof NewsSlugTakenError) return c.json(slugTaken(err), 409);
      throw err;
    }
  });

  admin.delete("/news/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    const deleted = id === null ? false : await deleteNews(c.env.DB, id, actorOf(c));
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
    // Audited because an upload publishes: the object is readable by anyone
    // with its URL from this moment, whether or not a post ever uses it.
    const actor = actorOf(c);
    const stored = await storeNewsImage(bucket, bytes, declared, (image, alreadyStored) =>
      auditLogStatement(c.env.DB, {
        userId: actor.id,
        action: "news_media_uploaded",
        resourceType: "news_media",
        resourceId: image.file,
        details: JSON.stringify({
          url: image.url,
          content_type: image.content_type,
          bytes: image.bytes,
          already_stored: alreadyStored,
          actor: actor.username,
        }),
      }).run(),
    );
    return c.json({ url: stored.url, content_type: stored.content_type, bytes: stored.bytes }, 201);
  });
}
