/**
 * News posts (#1551): admin-authored articles read on nemar.org/news.
 *
 * Modeled on services/notices.ts, and it inherits that module's timestamp
 * rule: `published_at` is STORED in SQLite's `YYYY-MM-DD HH:MM:SS` form
 * (bound through `datetime(?)`) so the visibility filter's comparison with
 * `datetime('now')` is like-for-like, and every timestamp is PROJECTED as
 * explicit-UTC RFC3339 so no JavaScript reader parses it as local time.
 * See notices.ts's NOTICE_COLUMNS and migration 0064 for the bug (#1024)
 * that rule exists to prevent.
 *
 * The media half (image validation and the R2 bucket) lives in
 * news-media.ts.
 */

import { uniqueViolationColumns } from "./identity";

export const NEWS_CATEGORIES = ["feature", "data", "event", "update"] as const;
export type NewsCategory = (typeof NEWS_CATEGORIES)[number];

export const NEWS_STATUSES = ["draft", "published"] as const;
export type NewsStatus = (typeof NEWS_STATUSES)[number];

/** Lowercase words joined by single hyphens; length is checked separately. */
export const NEWS_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const NEWS_SLUG_MIN = 3;
export const NEWS_SLUG_MAX = 80;

/**
 * Slugs no post may take. `media` collides with `/news/media/<file>`, the
 * image path on both the API and the website. Migration 0087's CHECK
 * repeats it as a backstop for writes that bypass the route.
 */
export const RESERVED_NEWS_SLUGS: ReadonlySet<string> = new Set(["media"]);

/** Public pagination: `GET /news?limit=&offset=`. */
export const NEWS_PAGE_DEFAULT = 10;
export const NEWS_PAGE_MAX = 50;

export interface NewsPostSummary {
  id: number;
  slug: string;
  title: string;
  summary: string;
  category: NewsCategory;
  banner_url: string | null;
  banner_alt: string;
  status: NewsStatus;
  published_at: string;
  created_at: string;
  updated_at: string;
}

export interface NewsPost extends NewsPostSummary {
  body: string;
}

/** What an admin write carries, after the route has validated and defaulted it. */
export interface NewsWrite {
  slug: string;
  title: string;
  summary: string;
  body: string;
  category: NewsCategory;
  banner_url: string | null;
  banner_alt: string;
  status: NewsStatus;
  /** RFC3339 with an offset or `Z`; normalized to UTC storage form on write. */
  published_at: string;
}

/**
 * Card fields, timestamps as explicit-UTC RFC3339. An explicit list rather
 * than `*` so `created_by`/`updated_by` never leave the database through a
 * public route.
 */
export const NEWS_SUMMARY_COLUMNS = `id, slug, title, summary, category, banner_url, banner_alt, status,
       strftime('%Y-%m-%dT%H:%M:%SZ', published_at) AS published_at,
       strftime('%Y-%m-%dT%H:%M:%SZ', created_at) AS created_at,
       strftime('%Y-%m-%dT%H:%M:%SZ', updated_at) AS updated_at`;

export const NEWS_COLUMNS = `${NEWS_SUMMARY_COLUMNS}, body`;

/**
 * "Publicly visible": published, and dated now or earlier. A published post
 * dated in the future is scheduled and appears once its time passes.
 *
 * Correct only because `published_at` is stored in `datetime()` form (the
 * table's CHECK enforces it). Exported so tests assert against this
 * predicate rather than a copy of it.
 */
export const NEWS_PUBLIC_FILTER = "status = 'published' AND published_at <= datetime('now')";

/** Newest first; the id breaks ties between posts dated the same second. */
export const NEWS_ORDER = "published_at DESC, id DESC";

/** Who made an admin write, for its audit row. */
export interface NewsActor {
  id: number;
  username: string | null;
}

export type NewsAuditAction = "news_post_created" | "news_post_updated" | "news_post_deleted";

/** `audit_log.resource_type` of a news write; `resource_id` is the post id. */
export const NEWS_AUDIT_RESOURCE_TYPE = "news_post";

/**
 * The audit row for a news write, queued in the same `db.batch()` as the
 * write, so the two commit or roll back together: a failed audit insert
 * never leaves an unaudited write behind.
 *
 * The row is read from the post itself (INSERT ... SELECT) rather than bound
 * the way `auditLogStatement` binds it, because the values do not all exist
 * when the batch is built. A create's id is assigned by its INSERT, so its
 * audit statement runs after it and finds the row by slug (unique). An
 * update's runs after the UPDATE and a delete's before the DELETE, both by
 * id, so a post that does not exist (a 404) gets no audit row. Details
 * describe the post as the write left it (as it was, for a delete).
 *
 * Same columns as AUDIT_LOG_INSERT_SQL. `details` stays far below
 * AUDIT_DETAILS_MAX_BYTES by construction: every field in it is capped by
 * migration 0087's CHECKs (the slug at 80 characters) or is fixed-width.
 */
function newsAuditStatement(
  db: D1Database,
  action: NewsAuditAction,
  actor: NewsActor,
  post: { id: number } | { slug: string },
): D1PreparedStatement {
  const [column, value] = "id" in post ? ["id", post.id] : ["slug", post.slug];
  return db
    .prepare(
      `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
       SELECT ?, ?, '${NEWS_AUDIT_RESOURCE_TYPE}', CAST(id AS TEXT),
              json_object('id', id, 'slug', slug, 'status', status,
                          'published_at', strftime('%Y-%m-%dT%H:%M:%SZ', published_at),
                          'actor', ?)
         FROM news_posts
        WHERE ${column} = ?`,
    )
    .bind(actor.id, action, actor.username, value);
}

/** Thrown by create/update when another post already has the slug. */
export class NewsSlugTakenError extends Error {
  constructor(readonly slug: string) {
    super(`A news post with slug "${slug}" already exists`);
    this.name = "NewsSlugTakenError";
  }
}

function rethrowSlugTaken(err: unknown, slug: string): never {
  if (uniqueViolationColumns(err).includes("news_posts.slug")) {
    throw new NewsSlugTakenError(slug);
  }
  throw err;
}

export async function listPublicNews(
  db: D1Database,
  page: { limit: number; offset: number },
): Promise<{ posts: NewsPostSummary[]; total_count: number }> {
  const count = await db
    .prepare(`SELECT COUNT(*) AS n FROM news_posts WHERE ${NEWS_PUBLIC_FILTER}`)
    .first<{ n: number }>();
  const rows = await db
    .prepare(
      `SELECT ${NEWS_SUMMARY_COLUMNS}
       FROM news_posts
       WHERE ${NEWS_PUBLIC_FILTER}
       ORDER BY ${NEWS_ORDER}
       LIMIT ? OFFSET ?`,
    )
    .bind(page.limit, page.offset)
    .all<NewsPostSummary>();
  return { posts: rows.results ?? [], total_count: count?.n ?? 0 };
}

/** A publicly visible post by slug, or null (missing, draft, or scheduled). */
export async function getPublicNewsBySlug(db: D1Database, slug: string): Promise<NewsPost | null> {
  return db
    .prepare(`SELECT ${NEWS_COLUMNS} FROM news_posts WHERE slug = ? AND ${NEWS_PUBLIC_FILTER}`)
    .bind(slug)
    .first<NewsPost>();
}

/**
 * Every post, drafts and scheduled included, for the admin view.
 *
 * Full posts, body included, although the admin list page shows no body:
 * the website's admin client (`parseAdminNewsList` in nemarOrg/website's
 * `src/lib/news.ts`, website#372) parses each row as a full post and drops
 * any row without a string body, so returning NEWS_SUMMARY_COLUMNS here
 * would empty that page without an error. Switch to the summary columns
 * only after the website parses this list as summaries.
 */
export async function listAllNews(db: D1Database): Promise<NewsPost[]> {
  const rows = await db
    .prepare(`SELECT ${NEWS_COLUMNS} FROM news_posts ORDER BY ${NEWS_ORDER}`)
    .all<NewsPost>();
  return rows.results ?? [];
}

export async function getNewsById(db: D1Database, id: number): Promise<NewsPost | null> {
  return db
    .prepare(`SELECT ${NEWS_COLUMNS} FROM news_posts WHERE id = ?`)
    .bind(id)
    .first<NewsPost>();
}

/**
 * `published_at` goes through `datetime(?)`: it normalizes any offset (or a
 * `Z`) to UTC in the storage form the visibility filter compares against.
 * `datetime()` returns NULL for input it cannot parse, which the NOT NULL
 * column refuses, so an unparseable value fails the write rather than
 * storing a post that sorts and filters wrongly.
 *
 * Writes a `news_post_created` audit row in the same batch.
 */
export async function createNews(
  db: D1Database,
  data: NewsWrite,
  actor: NewsActor,
): Promise<NewsPost> {
  let results: D1Result<NewsPost>[];
  try {
    results = await db.batch<NewsPost>([
      db
        .prepare(
          `INSERT INTO news_posts
             (slug, title, summary, body, category, banner_url, banner_alt, status,
              published_at, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime(?), ?, ?)
           RETURNING ${NEWS_COLUMNS}`,
        )
        .bind(
          data.slug,
          data.title,
          data.summary,
          data.body,
          data.category,
          data.banner_url,
          data.banner_alt,
          data.status,
          data.published_at,
          actor.id,
          actor.id,
        ),
      newsAuditStatement(db, "news_post_created", actor, { slug: data.slug }),
    ]);
  } catch (err) {
    rethrowSlugTaken(err, data.slug);
  }
  const row = results[0]?.results?.[0];
  if (!row) throw new Error("Failed to create news post");
  return row;
}

/**
 * Full replacement of a post's content. Bumps `updated_at` to now and
 * records the editor in `updated_by`, with a `news_post_updated` audit row
 * in the same batch. Returns null when no post has the id, and then nothing
 * is written, the audit row included.
 */
export async function updateNews(
  db: D1Database,
  id: number,
  data: NewsWrite,
  actor: NewsActor,
): Promise<NewsPost | null> {
  let results: D1Result<NewsPost>[];
  try {
    results = await db.batch<NewsPost>([
      db
        .prepare(
          `UPDATE news_posts
              SET slug = ?, title = ?, summary = ?, body = ?, category = ?,
                  banner_url = ?, banner_alt = ?, status = ?,
                  published_at = datetime(?),
                  updated_at = datetime('now'), updated_by = ?
            WHERE id = ?
            RETURNING ${NEWS_COLUMNS}`,
        )
        .bind(
          data.slug,
          data.title,
          data.summary,
          data.body,
          data.category,
          data.banner_url,
          data.banner_alt,
          data.status,
          data.published_at,
          actor.id,
          id,
        ),
      newsAuditStatement(db, "news_post_updated", actor, { id }),
    ]);
  } catch (err) {
    rethrowSlugTaken(err, data.slug);
  }
  return results[0]?.results?.[0] ?? null;
}

/**
 * Returns true when a row was deleted, with a `news_post_deleted` audit row
 * written in the same batch. Images stay in the bucket.
 */
export async function deleteNews(db: D1Database, id: number, actor: NewsActor): Promise<boolean> {
  const results = await db.batch([
    // Before the DELETE: the audit row is read from the post it removes.
    newsAuditStatement(db, "news_post_deleted", actor, { id }),
    db.prepare("DELETE FROM news_posts WHERE id = ?").bind(id),
  ]);
  return (results[1]?.meta?.changes ?? 0) > 0;
}
