# ADR 0076: News images live in their own R2 bucket and are served by the Worker

**Status:** accepted
**Date:** 2026-09-29
**Owner:** Seyed Yahya Shirazi

## Context

News posts (#1551) carry a banner image and inline images in their Markdown bodies.
The website serves them same-origin at `/news/media/<file>` by proxying the API,
because its Content Security Policy allows images from `'self'` only (nemarOrg/website#371).

Dataset bytes live in the AWS S3 bucket `nemar`,
and [`.memory/never-proxy-bulk-bytes.md`](../../.memory/never-proxy-bulk-bytes.md) records
that moving them to R2 was considered and rejected while AWS sponsors that bucket,
and that the Worker never proxies bulk bytes.
News images are neither dataset data nor bulk:
a handful of files, at most 5 MiB each, written only by admins.

## Decision

News images are stored in a dedicated Cloudflare R2 bucket bound to the API Worker as `NEWS_MEDIA`
(`nemar-news-media` in production, `nemar-news-media-dev` for `[env.dev]`),
under the content-addressed key `news/<sha256 of the bytes>.<png|jpg|webp|gif>`,
and served by the Worker at `GET /news/media/:file`.
Dataset bytes stay in S3; this does not reopen that decision.

## Consequences

- The image path needs no AWS credentials,
  and none of the S3 bucket's machinery sees these objects:
  its public-by-default policy, its deletion helpers (all keyed by validated dataset ids),
  and the sweeps and scripts that list its top-level prefixes.
- `wrangler dev` simulates the bucket locally,
  and the tests run against Miniflare's R2 simulator rather than a fake.
- Each bucket has to exist before the first deploy that carries its binding, or that deploy fails.
- The Worker carries image bytes.
  That is acceptable only because of the 5 MiB cap (the data plane's brokered-file ceiling is 32 MB)
  and the volume. If news media ever grows to video or large files,
  serve them by redirect or from a public R2 hostname instead of raising the cap.
- `Cache-Control: immutable` is correct only because the key is the hash of the bytes.
  Never write different bytes under an existing key.
- Deleting a post leaves its images in place, since another post may reference the same key.
  An orphan sweep, if one is ever wanted, has to derive references from `news_posts.banner_url`
  and every post body, not from the post being deleted.

## Alternatives considered

- **A `news/` prefix in the S3 dataset bucket**, the first draft of the #1551 contract:
  a signed PUT and a signed GET through aws4fetch.
  It puts non-dataset objects in the bucket every dataset tool lists and polices,
  needs AWS credentials on a public read path, and has no local simulator.
- **A public R2 hostname with no Worker in the read path:**
  it needs a new hostname and a website CSP change,
  and the website's same-origin proxy needs an API route to call either way.

## Receipts

- nemarOrg/nemar-cli#1551 (news posts), nemarOrg/website#371 (the website half).
- Migration `0087_news_posts.sql`; `backend/src/services/news-media.ts`;
  `backend/src/routes/news.ts`; `backend/src/routes/admin/news.ts`.
- `MAX_BROKERED_FILE_BYTES` in `backend/src/routes/data.ts` (the 32 MB ceiling cited above).
