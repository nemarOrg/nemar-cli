# Changelog

What each release actually changed, for someone deciding whether to upgrade or trying to
explain a behavior change after the fact.

**Why this file exists.** The GitHub Release for every tag is generated from merged pull
request titles (`--generate-notes`, in `.github/workflows/auto-tag.yml`), which is accurate
and routinely misleading. Work that lands as one epic merge collapses into a single bullet,
and that bullet carries the epic's name rather than the name of the thing that changed; a
security fix found mid-epic gets no bullet at all. So the generated list stays the index of
what merged, and this file says what it meant.

Newest first. Dates are the tag's publication date, UTC. Backfilled from 0.9.16 onward;
earlier releases are described only by their generated notes.

## Unreleased

### Added

- **`nemar dataset download` no longer needs git-annex.** A missing git-annex used to be a hard
  exit, which is a poor answer to "I just want the files" when the data plane already serves
  every byte over plain HTTPS. The command now falls back to an HTTP download, announced rather
  than silent, and `--http` asks for it outright. One request to
  `<api>/data/<id>/<version>/manifest.json` returns every file's path, size, checksum and byte
  URL; a bounded worker pool (`-j`, default 4) fetches the selection. A file already on disk at
  its declared size is skipped, so an interrupted transfer resumes by re-running the command,
  and widening `--subjects`/`--tasks`/`--datatypes` later only fetches what is new. The BIDS
  filters mean exactly what they mean on the git-annex path, because both are derived from one
  declaration in `src/lib/bids-filter.ts` rather than two matchers that could disagree; dataset
  metadata is never filtered out, so what lands is still a readable BIDS root. What you get is a
  file snapshot, not a repository: there is no `.git`, so `nemar dataset commit`/`push`/`update`
  do not operate on it, and the command says so. `--update` and `--prune` are refused on this
  path rather than silently doing nothing. Useful well beyond the missing-git-annex case:
  containers, HPC login nodes and CI runners where installing git-annex is impractical.

- **`nemar admin docs <path...>` reads documentation pages, including the gated ones, without
  a browser.** `nemarOrg/docs` is private at source and `docs.nemar.org` is the retrieval
  surface, so a checkout is no longer how anyone opens an operations runbook. The command
  trades the stored API key at `POST /auth/docs/cli-session` for a fifteen-minute, read-only,
  documentation-scoped session and sends only that onward, so the long-lived key never reaches
  the documentation host or its logs. Pages come back as Markdown on stdout and diagnostics on
  stderr, so `nemar admin docs cli/commands > page.md` yields the page. Pass several paths at
  once: they share one session, which matters because the mint sits in the strict per-address
  rate-limit bucket. There is deliberately no flag that prints the session value, since a
  credential on stdout is one in a shell history.

### Fixed

- **Rate limits now apply to the `/nemar` spelling of every route.** The API is mounted twice,
  at `/` and at `/nemar`, and the limiter matched paths against the full request path, so the
  strict per-address floor on the authentication routes (`/auth/login`, `/auth/code/request`,
  `/auth/keys`, the device-flow routes) matched nothing when the prefix was used and those
  requests fell to the general bucket. Both spellings are bucketed alike now. Low impact in
  practice, since Cloudflare's own per-address ceilings and the per-email limit on code
  requests both still applied, and this API is read-only for anyone without a key; recorded
  because it is a real change in how those routes are throttled.

- **An OpenNeuro import no longer leaves motion recordings in the git repository, and
  NEMAR's annex policy now actually governs an imported dataset.** Two separate holes,
  both closed in the import's prepare phase (#1159, ADR 0060). First, a `_motion.tsv`
  under OpenNeuro's ~1 MB bar arrived as a plain git blob and stayed one -- 893 of them,
  675 MB, in `ds007788` alone; those files are now annexed and their content uploaded
  from the clone, and an import that cannot upload them fails instead of publishing a
  pointer with nothing behind it. Second, and previously unnoticed: upstream ships a
  `.gitattributes` whose `annex.largefiles` setting **outranks** the one
  `configureLargefiles` writes, so ADR 0031's policy had no effect on any imported
  repository -- the next motion file added to one would have repeated the original bug.
  The inherited attribute is now replaced by NEMAR's own expression, which the import
  writes and then reads back before continuing: stripping alone would have been worse
  than leaving it, because with `annex.largefiles` set nowhere git-annex annexes
  everything, including the metadata a clone has to be able to read. This is a forward
  fix, so an imported repository does not shrink -- upstream's blobs stay in the
  history it came with. The 600 imported datasets that still carry upstream's
  attributes are tracked in #1374, and `on007788`'s own data migration in #1159.
- **`nemar admin annex-normalize <id>` applies the same fix to a dataset that already
  exists**, which is how `on007788`'s 893 git-resident recordings and the imported
  fleet get migrated. It is a forward fix by construction: a published version
  manifest addresses a git-resident file by its tag-pinned `raw.githubusercontent.com`
  URL, so history is never rewritten and those URLs keep resolving. `--dry-run`
  reports the plan; a clone left dirty by an interrupted attempt is refused rather
  than mistaken for a dataset with nothing left to migrate.
- **A dataset migration no longer hands git-annex a temporary key without its session
  token** (#1380). `normalize-dataset.ts` enabled the S3 remote with credentials minted
  for the dataset and then let the transfer inherit the environment, where there were
  none: git-annex fell back to the key and secret `enableremote` had cached, signed
  without the session token that makes them valid, and S3 refused every request with a
  bare 403 -- which was mistaken for the API's S3 identity not reaching imported
  (`on######`) prefixes. It does reach them: the identity covers the bucket and the
  per-request session policy is what narrows it, verified by HEAD on the same object
  with the same credentials returning 200 with the token and 403 without. The
  credentials are now threaded to the transfer; the branch that obtains them is the
  branch that states how the bytes move, so there is no default left to forget; a
  temporary key with no session token is refused before any transfer is attempted; and
  the migration probes the prefix before annexing anything, so a refusal costs one HEAD
  rather than an hour. `nemar admin s3 credential-check <id>` reports the same probe on
  demand. A dataset with no data to move now needs no credentials at all, and a policy
  that changed only the git-annex branch is pushed rather than left local.
- **A migration is no longer declared done on a check that cannot fail meaningfully**
  (#1380, #1392). The step that confirmed the uploaded content was
  `git annex fsck --from nemar-s3`, which is the one question git-annex cannot answer
  here: `enableremote` caches the key and secret with nowhere to put the session token,
  so fsck signs without one and S3 returns 403 -- the same 403 it returns for an object
  that is not there. A red result therefore did not mean the content was missing, and a
  green one would not have meant it was present. `on006979`'s migration is what surfaced
  it: the PDF was in the bucket and the location log recorded it, and the run still
  reported `fsck: 1 failed`. The check is now a HEAD carrying the credentials that moved
  the bytes, `absent` and `unconfirmed` are kept apart rather than collapsed, and it runs
  **before** the push instead of after -- a tree naming keys whose content never arrived
  is what stranded `on003490` and `on005121` behind a permanent DOI, and the clone is
  still re-runnable right up until it is pushed. For a remote whose credentials git-annex
  does hold in full, the verifier reads the location log after fsck has pruned it, since
  fsck only checks claims that were already made and an upload that moved nothing makes
  none.
- **The per-user IAM provisioning that STS replaced is gone from the backend** rather
  than sitting there with no callers (#1380). `generateS3PolicyDocument`,
  `generateAdminS3PolicyDocument`, `createIamUser`, `createAccessKey`, `putUserPolicy`
  and `generateIamUsername` had no call site outside their own module; the two
  generators are why #1380 was first read as an identity-policy gap, since they look
  like the code that would write one and nothing runs them. Revocation stays: an
  account provisioned under the old scheme still carries an `aws_iam_username` in D1
  and an IAM user in the account, and deleting it has to take both away.

## 0.10.3 - 2026-09-10

### Security

- **The admin documentation was publicly readable, and is now gated.** Every page under
  `docs.nemar.org/admin/*` answered 200 to an anonymous request, and all twelve were listed
  in the public sitemap. The Cloudflare Access application believed to be protecting them
  covers that Pages project's preview deployments only and never covered the production
  hostname. Those pages now sit behind NEMAR's own ORCID-backed session with an admin-role
  check, handed to the documentation host through a sixty-second one-time code, so
  `users.role` in D1 stays the single source of truth for who is an admin (ADR 0056,
  #1345, #1355). Nothing confidential was exposed: procedures and identifiers in a public
  repository, never credential values.

### Fixed

- **Web sessions authenticated past their expiry, by up to a day.**
  `web_sessions.expires_at` was written as a JavaScript ISO string while every reader
  compares it against SQLite's `datetime('now')`. SQLite compares them as text, and byte 11
  decides it, so an expiry bearing the same calendar date as the comparison always won.
  Writes are SQL-side now, and migration 0084 rewrites the rows already stored. **If you
  were signed in to nemar.org you may be signed out when this deploys**; sign in again.
- **Revoking or demoting an account did not reach its browser credentials.** The session row
  survived, inert while the account was revoked, and a later re-approval handed it back to
  whichever browser still held the cookie. A revoke now clears every session and grant; a
  demotion clears the documentation credential and deliberately leaves the ordinary
  dashboard session alone, since a demoted account is still a legitimate user.
- **A documentation session could authenticate the management API.** Both credential scopes
  live in one table, and one of the two readers of it lacked the scope predicate. Caught in
  review, never deployed.
- **The import workflow's failure reporters posted nothing at all when the log held no
  failure marker.** Actions runs a `run:` step under `bash -e`, and the reporters add
  `pipefail`, so a `grep` that found nothing killed the step before its named fallback: an
  out-of-memory kill, an evicted runner or a cancellation reported the stage roll-up that
  this work replaced. Fixed in both copies of the workflow (#1366,
  `nemarDatasets/.github#116`).
- **The reconcile reported "no import row" for datasets that had one.** Row existence was
  derived from the unresolved slice rather than from the table, so an issue whose import had
  since completed or rolled back was named as untracked, and the human remedy for that
  finding then suppresses the issue from the report permanently (#1363).

### Changed

- **Signing out of nemar.org also ends the account's documentation sessions**, on every
  device, and destroys any outstanding one-time grant, in a single transaction (#1361).
- **Every unrouted path on `api.nemar.org` now answers with the JSON 404 body**
  `{"error":"Not Found","message":"Route <METHOD> <path> not found"}` instead of plain text.
  Route-level 404s are unchanged. Hono's `route()` copies a sub-app's routes and not its
  notFound handler, so the JSON body had only ever been served by the `data.nemar.org` fork.
- The role-change audit record gains `docs_sessions_revoked`.

### Added

- **The import pipeline records the real failure instead of a stage roll-up**, and classifies
  it, so an expired token no longer reads the same as a diverged branch (#1351).
- **`nemar admin import-issue-triage` reconciles failures against their tracking issues** and
  reports disagreement in both directions. Report-only: it files nothing (ADR 0055, #1353).
- `nemar admin import-coverage` and `import-weekly` no longer suggest filing a bug when they
  exit non-zero. Those exit codes are the verdict, and they have not changed (#1358).

### Migrations

`0083_docs_sessions` (a metadata-only `ADD COLUMN` with a CHECK, a partial index, and the
`docs_grants` table) and `0084_web_session_expiry_format` (one idempotent in-place `UPDATE`
over `web_sessions`). Both additive.

### Deploy coupling

`nemarOrg/docs#32` and `nemarOrg/website#328` depend on this release and must ship after it.
Before it, the documentation middleware maps an unrouted `verify` to a 503 on every
`/admin/*` page, and the website's authorize page reads the unrouted 404 as "not an admin"
and sends a real admin to `/404`.

### Known limitation

This release fixes the JavaScript-timestamp-versus-SQL-datetime comparison for web sessions
only. The same pattern remains in `auth_codes` and `orcid_link_intents`, so an emailed
sign-in code's ten-minute window is currently longer in practice than advertised; the codes
are still single-use and attempt-capped. Tracked in #1359.

## 0.10.2 - 2026-09-10

**The import pipeline reports its own health** (epic #1337). Before this, a failed OpenNeuro
import was visible only to whoever went looking in D1.

### Added

- The real failure reason is captured and classified rather than recorded as the stage that
  was running (#1325).
- Recovered imports close their own tracking issues, issues whose cause has changed are
  relabeled, and a burst rolls up into one issue instead of flooding the tracker (#1328,
  ADR 0052).
- A coverage sweep, so the pipeline reports its own silence: nothing arriving is only good
  news if there was work to do (#1331, ADR 0053).
- A weekly summary issue that arrives whether or not anything is wrong (#1333, ADR 0054).

### Fixed

- **Tests could sign in to production.** The default test target was the production API, so a
  test run authenticated against real accounts. It is the dev worker now (#1343).
- `nemar auth login -k ""` no longer stores an empty key (#1343).
- The `iam-removal` suite skips instead of failing when it has no live target (#1348).
- Two false failures in the MCP verification script (#1335).

### Changed

- CORS accepts the website's Pages preview hostnames, so a preview deployment can call the
  API (#1347).

## 0.10.1 - 2026-09-09

**The NEMAR MCP server** (epic #1065): agents reach the catalog through a typed tool surface
at `mcp.nemar.org` rather than by scraping the API.

### Added

- Host fork and discovery tools: `search_datasets`, `describe_dataset` (#1323).
- Recording tools: `list_recordings`, `get_events`, `render_overview` (#1326).
- A `read_window` recipe with a capped taste of the data, so a client can sample a recording
  without downloading it (#1327).
- A Python client verification, so the contract is exercised by something that is not this
  repository (#1330, ADR 0050).

### Changed

- ADR 0049 supersedes 0025 on compute locality (#1292).

## 0.10.0 - 2026-09-08

**ORCID-first CLI sign-in and service accounts** (epic #1272). A terminal cannot receive an
OAuth redirect, so `nemar auth login` now uses the device authorization grant (RFC 8628),
the pattern `gh auth login` uses.

### Added

- The backend device authorization flow, with the key minted only when the CLI collects it,
  never when the browser confirms (#1287, ADR 0047).
- `nemar auth login` and `signup` on that flow, with `-k`/`--key` kept as the explicit
  paste-a-key fallback for a headless host (#1289).
- Named API keys, one row per machine, so a new sign-in never revokes another machine's key,
  and `nemar auth keys` to manage them (#1287).
- Account kinds: `person`, `service`, `test`, set only by an owner and never inferred
  (#1290, ADR 0048).

### Fixed

- Admin notifications are gated to production, so a non-production job cannot email real
  people (#1305).
- The dev worker's email allow-list holds exact addresses as a secret, with no domain
  wildcards (#1319).
- Three live-tier device-flow test failures (#1301), and stale premises in the passwordless
  live tests (#1317).

### Changed

- OpenNeuro auto-import re-enabled on production (#1308).

## 0.9.16 - 2026-09-07

**Account tiers, upload access, and identity parity** (epic #1250). `verified` becomes a real
tier that needs no administrator, and upload access becomes a thing you ask for once.

### Added

- `verified` is the base tier: browse, dashboard, settings and sandbox need no admin
  (#1262, ADR 0040).
- Upload access is requested once, by the person who wants it, and each missing field is
  named in a typed refusal (#1265, ADR 0042).
- CLI self-service for identity fields, and CLI/web parity for what an account is told about
  itself (#1269, #1270, ADR 0045).
- `nemar --debug` writes a diagnostic bundle (#1257).
- Real-name DOI attribution (#1260).

### Changed

- Approval grants upload access rather than acting as the gate on everything (#1258).
- Identity uniqueness: an ORCID iD, an email or a GitHub handle backs at most one live
  account (#1264, ADR 0043).
- An unverified ORCID blocks the upload-access request (#1273).
