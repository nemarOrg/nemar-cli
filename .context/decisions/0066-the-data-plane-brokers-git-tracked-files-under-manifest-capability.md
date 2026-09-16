# ADR 0066: The data plane brokers git-tracked files, and the manifest is the capability list

**Status:** accepted
**Date:** 2026-09-14
**Owner:** Seyed Yahya Shirazi

## Context

About 88 percent of a dataset's manifest entries are git-tracked metadata, not annexed data:
on `on008701`, 2,802 of 3,201 files, 4.1 MB against 14.0 GB. Those entries carried
`raw.githubusercontent.com` URLs. So a dataset whose repository is private served its
recordings perfectly from S3 and 404'd on every sidecar, README and `participants.tsv`,
which is the half a reader needs to make sense of the other half.

That shape blocked anonymous deposit (epic #1406), where the repository has to stay private
while the dataset stays readable. It was also worth fixing on its own: a citable dataset
whose metadata resolves through a third party's content host has a dependency nobody
recorded, no single place to rate-limit or measure, and URLs that change when that host does.

This ADR records the phase that closed it (#1403, PR #1410). It was written after the fact,
in the phase that depends on it, because ADR 0065 needed something true to cite.

Three measurements shaped it, each taken rather than assumed:

- **The manifest's `checksum` for a git-tracked file IS the git blob SHA.** So the manifest
  already names the object to fetch; nothing new has to be stored.
- **Authenticated `raw.githubusercontent.com` serves a PRIVATE repository** (verified on
  `nm099999`) and spends none of the REST `core` budget. The blobs API spends 5,000 per hour
  per installation, shared with publishing.
- **GitHub answers 404, not 403, for a repository a credential cannot see.** An absent file
  and an unreadable repository are the same response, which is why absence has to be proven
  rather than inferred.

## Decision

**The Worker brokers git-tracked files, and every manifest entry names `data.nemar.org`.**
`buildBytesUrl` returns `${origin}/${id}/${version}/${path}` for every entry, annexed or not,
so one host serves a dataset and the citation path contains no third party.

Five capability rules, settled before the code was written, because each closes a way the
broker could be turned into a confused deputy:

- **The manifest is the capability list.** A request is served only for a path the published
  manifest names. The manifest is built from the dataset's own version document, so the set of
  readable paths is decided by the archive, never by the caller.
- **The repository comes from the dataset row, never from the request.** `dataset.dataset_id`
  resolves the repo. No request field reaches the GitHub call.
- **The visibility gate runs BEFORE the token is used.** Not alongside, not after: the token
  is never spent on a request that has not already passed ADR 0017's check.
- **Cache by request URL, NEVER by blob SHA.** Blob SHAs are content-addressed, so two
  datasets holding an identical file share one, and a SHA-keyed cache hit would serve a
  private dataset's bytes to a caller who passed the gate for a public one.
- **Refuse with 404, never 403.** A 403 distinguishes "exists but forbidden" from "does not
  exist", which is itself the disclosure.

**The raw host first, the blobs API as a bounded fallback.** Raw is read with
`Accept-Encoding: identity` (gzip otherwise makes `Content-Length` the compressed length, 717
against a manifest's 1353) and with no in-request retry, because `githubFetchWithRetry` honors
`Retry-After` and a 429 would sleep 42 seconds inside a request. The fallback is guarded by a
40-hex SHA check and a per-isolate budget, so a pathological dataset cannot drain the
installation's publishing quota.

**Correction, 2026-09-16 (#1419): the length is COUNTED, not read off a header.** The
`Accept-Encoding: identity` request header above does not reach GitHub. The Workers runtime
owns that header, so the raw host gzips anyway and workerd strips `Content-Length` when it
decodes -- which meant the deployed broker emitted no `Content-Length` at all, and the
manifest-vs-upstream size check never ran once in production. The length rule is unchanged;
its enforcement moved. The response now DECLARES the manifest's size and pipes the body
through a counting `TransformStream` that errors the stream if the delivered bytes disagree,
so a truncated file cannot arrive looking complete and a client is never left without a
length. The header check remains as a fast path for the case where upstream's declaration
does survive. Counting rather than buffering keeps the memory flat under the 32 MB ceiling.

**Brokered responses are `max-age=300`, not `immutable`.** The bytes are immutable; the
AUTHORIZATION is not. Nothing purges the edge, per-URL purge caps at 30 URLs and prefix purge
is Enterprise-only, so a long TTL would keep serving a file after the dataset that authorized
it went private.

**Absence is only absence when a token was held.** Because GitHub answers 404 for an
unreadable private repository, `absent` is reported only when a credential was actually
present; a mint failure with credentials configured is a 503, not a 404. Reporting "this file
does not exist" because our own credentials failed would be a lie about someone's data.

## Consequences

Easier: durable URLs, one host to rate-limit and measure, and a private repository no longer
means an unreadable dataset, which is what anonymous deposit is built on.

Harder, and worth stating plainly:

- **The Worker now carries bytes it used to redirect.** Small by measurement, 4.1 MB of git
  content against 14.0 GB annexed on `on008701`, and the largest single git-tracked file
  measured was 53 KB. A 32 MB ceiling is enforced per file. But the volume varies by dataset
  (242 MB on `nm000104`), so this is a bounded cost, not a free one.
- **An edge-cache write for brokered files is deliberately not here.** It has to be designed
  together with purge-on-visibility-change, and a cache that outlives a revocation is the
  failure this ADR's TTL choice is already working around.

## Alternatives considered

- **Redirect to `raw.githubusercontent.com` with a token in the URL.** Leaks the credential to
  the client and to every log between here and GitHub.
- **Blobs API only.** Correct, and it spends a 5,000/hour budget shared with publishing on
  traffic the raw host serves for free.
- **Serve git-tracked files from S3 instead.** Means writing them to S3 on every push, which
  duplicates the repository and adds a consistency problem where there was none.

## Receipts

- Epic #1406, issue #1403, PR #1410; length-counting correction #1419
- ADR 0017 (the visibility gate this runs before the token), ADR 0005 (availability is
  reported; transport failures stay fatal), ADR 0015 (git is metadata, annex is data)
- Rules: `backend/src/services/github/git-file-broker.ts`, `backend/src/routes/data.ts`,
  `backend/src/services/data-router.ts`
- Guards: `backend/test/git-file-broker.test.ts` -- including the differential route tests
  that fail if the visibility gate is deleted
