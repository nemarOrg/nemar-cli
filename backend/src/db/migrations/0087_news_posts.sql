-- Issue #1551: news posts, authored by admins and read on nemar.org/news.
--
-- Modeled on `notices` (0016, 0063, 0064), with three differences: a post
-- is editable (PUT replaces it, bumping updated_at/updated_by), it carries a
-- slug for its public URL, and it can reference images stored in the
-- NEWS_MEDIA R2 bucket under `news/<sha256>.<ext>` (banner_url, and inline
-- in the Markdown body). See ADR 0075.
--
-- Publicly visible means `status = 'published' AND published_at <=
-- datetime('now')`: a published post dated in the future is scheduled and
-- stays hidden until then, and an admin may backdate one.
--
-- published_at is stored in SQLite's own `YYYY-MM-DD HH:MM:SS` form (the
-- service binds it through `datetime(?)`), NOT as the RFC3339 string the
-- API accepts. The visibility filter compares it byte-wise against
-- datetime('now'), and an RFC3339 value's `T` separator sorts after the
-- space, so a same-day comparison would come out wrong: that is exactly
-- the bug migration 0064 repaired for notices.expires_at (#1024). The
-- CHECK below enforces the stored shape, so a hand-written INSERT that
-- skips the normalization fails loudly instead of hiding a post for a day.
-- Its IS NOT NULL half is load-bearing: datetime() of an unparseable string
-- is NULL, and a CHECK that evaluates to NULL passes, so without it a junk
-- value would be stored and the post would simply never appear.
--
-- `media` is reserved as a slug because `/news/media/<file>` is the image
-- path on both the API and the website. The route layer refuses it; the
-- CHECK is the backstop for writes that bypass the route.
--
-- banner_url is NULL or a site-relative `/news/media/<64 hex>.<ext>` path,
-- validated by the route; banner_alt must be non-empty whenever it is set.
--
-- Cloudflare D1 forbids explicit BEGIN/COMMIT (error 7500); the runtime
-- wraps each migration in a transaction already.

CREATE TABLE IF NOT EXISTS news_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE
    CHECK (length(slug) BETWEEN 3 AND 80 AND slug <> 'media'),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'feature'
    CHECK (category IN ('feature', 'data', 'event', 'update')),
  banner_url TEXT,
  banner_alt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published')),
  published_at TEXT NOT NULL
    CHECK (datetime(published_at) IS NOT NULL AND published_at = datetime(published_at)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  CHECK (banner_url IS NULL OR banner_alt <> '')
);

CREATE INDEX IF NOT EXISTS idx_news_posts_status_published
  ON news_posts(status, published_at DESC);
