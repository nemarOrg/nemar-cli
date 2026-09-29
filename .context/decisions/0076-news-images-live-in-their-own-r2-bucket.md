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
- Every upload writes a `news_media_uploaded` row to `audit_log`
  (resource id the file name, the uploader as the actor) before the object is stored,
  and every post create, update, and delete writes a `news_post_*` row in the same D1 batch as the write.
  Those rows are the only index of what was uploaded and by whom.

## Operations

### Recalling a mistaken image

An image cannot be listed or deleted through the API.
It is public by URL from the moment it is uploaded, even while every post that uses it is a draft,
and it is served with `Cache-Control: public, max-age=31536000, immutable`,
so any cache that fetched it may keep it for a year.
Unpublishing or deleting the post recalls nothing.
To recall one, with the file name from the post or from its `news_media_uploaded` audit row:

1. Delete the object:
   `bunx cfman wrangler --account sccn r2 object delete nemar-news-media/news/<file> --remote`
   (`nemar-news-media-dev` for dev).
   Wrangler 4 runs `r2 object` commands against local storage unless given `--remote`.
2. Purge `https://api.nemar.org/news/media/<file>`
   and the alias `https://api.nemar.org/nemar/news/media/<file>` from the Cloudflare cache.
3. Drop the website's copy.
   The website proxies the image at `/news/media/<file>` and keeps it in its own edge cache (nemarOrg/website#372);
   purge that path on the website's hosts,
   or redeploy the website, which starts a fresh edge-cache namespace (nemarOrg/website#188).
4. Remove the reference from any post that still uses it, or that post renders a broken image.

A browser that already fetched the image keeps it until its own cache expires; nothing server-side reaches it.

### How long a post stays visible after it is unpublished or deleted

The API stops serving it at once: `GET /news/:slug` answers 404 with `Cache-Control: no-store`.
Copies already cached are another matter.
`GET /news` and `GET /news/:slug` send `Cache-Control: public, max-age=30, s-maxage=300, stale-while-revalidate=600`,
so a cache that honors them serves the old list or post as fresh for up to 30 seconds (a browser) or 5 minutes (a shared cache),
and then, under `stale-while-revalidate`, for up to 10 minutes more while it refetches:
at most 15 minutes in all.
The website renders these responses into pages it caches under its own headers (nemarOrg/website#372),
which adds its window to this one; redeploying the website drops its cached pages at once.

### The deploy token needs R2

`wrangler deploy` in `.github/workflows/deploy-backend.yml` authenticates with the `CLOUDFLARE_API_TOKEN` repository secret,
and with an R2 binding in the config it calls the R2 API for the bucket,
so that token needs R2 access on the sccn account.
The first dev deploy after the buckets were created,
run [36610376353](https://github.com/nemarOrg/nemar-cli/actions/runs/36610376353) attempt 1 (started 2026-09-29 18:12Z),
failed at `wrangler deploy` at 18:22Z with `Authentication error [code: 10000]`
on the request to `/accounts/<account>/r2/buckets/nemar-news-media-dev`.
Attempt 2, started at 18:29Z with the same token, succeeded at 18:32Z.
That is consistent with R2 being newly enabled on the account and the enablement still propagating.
If the error comes back on a later deploy, check the token's R2 permission first.

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
- The prod-safety review of nemarOrg/nemar-cli#1553 added the audit rows and the Operations section.
