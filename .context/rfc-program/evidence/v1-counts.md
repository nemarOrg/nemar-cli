# V1: counts that RFC-0002 needs, measured read-only

Measured 2026-11-20 against production (`nemar-db`) and the public Application Programming Interface (API) at `https://api.nemar.org/datasets`, on top of nemar-cli `dev` at `065794d9`.
Every production call was a read: `SELECT` statements through `bunx cfman wrangler --account sccn d1 execute nemar-db --remote --json --command "<SQL>" -c wrangler-sccn.toml` (run from `backend/`), GitHub `GET` requests through `gh api`, the public API through `curl`, and `nemar admin upstream-status --json`.
No write was made and no live dataset or re-pull switch was touched.
Abbreviations, defined once: Digital Object Identifier (DOI), Hierarchical Event Descriptors (HED), Request for Comment (RFC), Architecture Decision Record (ADR), pull request (PR), Cloudflare's SQLite database service (D1).

All raw outputs are beside this file in `evidence/v1/`.
A `.raw` file is the unedited wrangler output (a banner line, then the JSON array).
The D1 queries were run through `d1-select.sh NAME "SQL"`, which refuses any statement that does not start with `SELECT` or `WITH`; `NAME` is the raw file's stem.
Numbers marked "computed" are sums or differences of measured numbers; the arithmetic is shown.

## 0. Schema check (the card's confirmation step)

The table and column names in the research note are correct.
`dataset_versions` has `dataset_id`, `version`, `doi` (declared `NOT NULL`, so `doi IS NOT NULL` is every row), `created_at`, `ezid_status`, `source_version` and `source_version_basis` (migrations `0026`, `0060`, `0104`; production `sqlite_master` shows the same).
Version strings carry no `v` prefix in D1 (`1.0.0`); the git tag and the public API's `latest_version` add it (`v1.0.0`).

| Check | Result | Command and raw file |
|---|---|---|
| Table definition in production | matches migrations | `SELECT sql FROM sqlite_master WHERE name IN ('dataset_versions')` -> `q0-schema.raw` |
| Version rows with a first character other than `1` or `2` | 0 (1,618 start with `1`, 10 with `2`); no row has a null DOI | `SELECT substr(version,1,1) ... GROUP BY first_char` -> `q0-version-shapes.raw` |
| Version rows whose dataset row is missing | 0 | `q1c-version-rows-without-dataset.raw` |
| All DOIs share one prefix | `10.82901/` on all 1,628 rows | `q1e-doi-shape.raw` |

Command: `SELECT sql FROM sqlite_master WHERE name IN ('dataset_versions')`, run through `d1-select.sh`.
Raw output: .context/rfc-program/evidence/v1/q0-schema.raw
Raw output: .context/rfc-program/evidence/v1/q0-version-shapes.raw
Raw output: .context/rfc-program/evidence/v1/q1c-version-rows-without-dataset.raw
Raw output: .context/rfc-program/evidence/v1/q1e-doi-shape.raw

## 1. Version DOIs in total, and by prefix

Command: `SELECT substr(dataset_id,1,2) AS prefix, count(*) FROM dataset_versions WHERE doi IS NOT NULL GROUP BY prefix`, run through `d1-select.sh`.
Raw output: .context/rfc-program/evidence/v1/q1-doi-by-prefix.json
Raw output: .context/rfc-program/evidence/v1/q1b-versions-by-prefix-visibility.raw
Raw output: .context/rfc-program/evidence/v1/q1d-ezid-status.raw
Raw output: .context/rfc-program/evidence/v1/q5b-api-latest-version.txt

| Prefix | Version DOIs |
|---|---|
| `nm` | 1,014 |
| `on` | 614 |
| `xx` | 0 (no `xx` dataset has a version row) |
| Total | 1,628 (computed: 1,014 + 614) |

Split by visibility, `SELECT substr(v.dataset_id,1,2), d.visibility, d.source, count(*), count(DISTINCT v.dataset_id) FROM dataset_versions v JOIN datasets d ... GROUP BY ...` -> `q1b-versions-by-prefix-visibility.raw`:

| Prefix | Visibility | Version DOIs | Datasets with a version row |
|---|---|---|---|
| `nm` | public | 1,011 | 327 |
| `nm` | private | 3 | 2 |
| `on` | public | 607 | 582 |
| `on` | private | 7 | 7 |

Cross-check against the public API, `curl 'https://api.nemar.org/datasets?limit=100&offset=N'` for `N` = 0, 100, ..., 900 -> `api-datasets-offset-N.json`, summarized by `api-crosscheck.ts` -> `q5b-api-latest-version.txt`: 910 public datasets (583 `on`, 327 `nm`), 909 with a DOI.
D1 holds 327 + 582 = 909 public datasets with version rows (computed), which matches the 909 with a DOI; the 910th public `on` dataset has no version row.
The version DOI total in production, 1,628, includes 10 rows (3 `nm`, 7 `on`) on private datasets.
Of the 1,628 DOIs, 13 have a DataCite status other than the default: 6 `public` and 7 `unavailable` (`SELECT ezid_status, count(*) ... GROUP BY ezid_status` -> `q1d-ezid-status.raw`); the other 1,615 are null.

## 2. Datasets by number of versions, and mirrors by highest major

Command: `SELECT prefix, nv, count(*) FROM (SELECT substr(dataset_id,1,2) AS prefix, dataset_id, count(*) AS nv FROM dataset_versions GROUP BY dataset_id) GROUP BY prefix, nv`, run through `d1-select.sh`.
Raw output: .context/rfc-program/evidence/v1/q2a-versions-per-dataset.raw
Raw output: .context/rfc-program/evidence/v1/q2b-highest-major-by-prefix.raw
Raw output: .context/rfc-program/evidence/v1/q2c-version-strings.raw
Raw output: .context/rfc-program/evidence/v1/q4c-repull-records.raw
All datasets with version rows, public and private.

| Versions per dataset | `nm` datasets | `on` datasets (mirrors) |
|---|---|---|
| 1 | 61 | 565 |
| 2 | 29 | 23 |
| 3 | 125 | 1 |
| 4 | 62 | 0 |
| 5 | 44 | 0 |
| 6 | 5 | 0 |
| 7 | 2 | 0 |
| 8 | 1 | 0 |
| Datasets with at least two versions (computed) | 268 | 24 |
| Datasets in total (computed) | 329 | 589 |

The rows sum to the DOI totals in section 1: `nm` 61 + 58 + 375 + 248 + 220 + 30 + 14 + 8 = 1,014; `on` 565 + 46 + 3 = 614.

Mirrors by highest major number, `SELECT prefix, hi, count(*) FROM (SELECT ..., max(CAST(substr(version,1,instr(version,'.')-1) AS INTEGER)) AS hi FROM dataset_versions GROUP BY dataset_id) GROUP BY prefix, hi` -> `q2b-highest-major-by-prefix.raw`:

| Highest major | `on` mirrors | `nm` datasets |
|---|---|---|
| 1 | 584 | 324 |
| 2 | 5 | 5 |
| 3 or higher | 0 | 0 |

The five `on` datasets at major 2 are on000117, on003061, on003645, on003739 and on004362, the five completed re-pulls (`q4c-repull-records.raw`: `SELECT ... FROM upstream_repulls WHERE status IN (...)`, all `administrator` origin, all `complete`, all `1.0.0` to `2.0.0`).
The five `nm` datasets at major 2 are nm000103 to nm000107 (public API `latest_version`, `q5b-api-latest-version.txt`).

Version strings in use, `SELECT substr(dataset_id,1,2), version, count(*) ... GROUP BY 1,2` -> `q2c-version-strings.raw`:
`nm` versions run `1.0.0` to `1.0.8`, then `1.1.0` to `1.1.4`, `1.2.0`, `1.2.1` and `2.0.0` (24 rows with a minor above 0, computed);
`on` versions are `1.0.0` (589), `1.0.1` (7), `1.0.2` (11), `1.0.3` (2) and `2.0.0` (5).
No version string has more than three parts and none carries a pre-release or build suffix.

Public API cross-check of "latest version above `1.0.0`" (`q5b-api-latest-version.txt`): 280 `nm` and 24 `on` (the research note recorded 280 and 25; the `on` count is 24 today).
The 280 `nm` figure exceeds the 268 `nm` datasets with two or more versions because 12 `nm` datasets have a single version row that is not `1.0.0` (computed: 280 - 268; for example nm000220 starts at `1.0.1`).
The 24 `on` figure equals the 24 `on` datasets with two or more versions.

## 3. Mirror versions that are `N.0.0` with a recorded `source_version`, and mirrors with no known upstream tag

A mirror version is `N.0.0` with a recorded `source_version` (ADR 0111).
Command: `SELECT substr(dataset_id,1,2), source_version_basis, source_version IS NOT NULL, version LIKE '%.0.0', count(*) ... GROUP BY ...`, run through `d1-select.sh`.
Raw output: .context/rfc-program/evidence/v1/q3a-source-version-basis.raw
Raw output: .context/rfc-program/evidence/v1/q3b-mirrors-by-state.raw
Raw output: .context/rfc-program/evidence/v1/q3c-source-version-sample.raw
Raw output: .context/rfc-program/evidence/v1/q3e-null-basis-mirrors.raw
Raw output: .context/rfc-program/evidence/v1/q3f-withdrawn-mirrors.raw

| Group | Version rows |
|---|---|
| `on`, `N.0.0`, recorded tag, basis `doi` | 522 |
| `on`, `N.0.0`, recorded tag, basis `lineage` | 22 |
| `on`, `N.0.0` with a recorded `source_version` (computed: 522 + 22) | 544 |
| `on`, `N.0.0`, basis `unknown` (no tag) | 44 |
| `on`, `N.0.0`, never examined (null and null) | 6 |
| `on`, not `N.0.0`, recorded tag (all basis `doi`) | 19 |
| `on`, not `N.0.0`, basis `unknown` | 1 |
| `nm`, `N.0.0` (259 at `1.0.0`, 5 at `2.0.0`), no tag | 264 |
| `nm`, not `N.0.0`, no tag | 750 |

The 544 mirror versions belong to 539 mirrors; 44 mirrors have only `unknown` rows and 6 have never been examined (`q3b-mirrors-by-state.raw`: 539 + 44 + 6 = 589 mirrors with a version row, computed).
Sample of the recorded pairs (60 rows): `q3c-source-version-sample.raw`.

One finding for the RFC: 19 non-`N.0.0` mirror versions (NEMAR's own `1.0.x` corrections) also carry a recorded `source_version`, the upstream tag they derive from.
The documented rule "a mirror is `N.0.0` with a recorded `source_version`" therefore tests both conditions, and `source_version` alone does not identify a mirror version.

Mirrors with no known upstream tag are measured by a second command.
Command: `nemar admin upstream-status --json` (production, read-only).
Raw output: .context/rfc-program/evidence/v1/q3d-upstream-status.json
The command exited with status 2 and the document says `"complete": false` with `"could_not_see": ["2 mirror(s) could not be compared with OpenNeuro"]`, so two mirrors were not compared; the other 619 were.
621 mirrors were examined (6 withdrawn mirrors are outside that population).

| State | Mirrors |
|---|---|
| `current` (at upstream's latest snapshot) | 459 |
| `stale_ready` | 50 |
| `stale_unverified` | 1 |
| `mirror_lag` | 1 |
| `anomaly` | 5 |
| `unchecked` | 2 |
| `in_progress` | 12 |
| `parked` | 47 |
| `unknown` (version names no single upstream tag) | 41 |
| `unpublished` | 3 |
| `not_examined` | 0 |

Mirrors with no recorded upstream tag (`recorded.tag` is null), computed from `q3d-upstream-status.json` rows: 81 of 621, of which 44 are public and 37 are not.
They are 41 `unknown`, 2 `parked` with basis `unknown`, 35 `parked` with no recorded version, and 3 `unpublished` with no recorded version.
In D1, 44 mirrors have only `unknown` rows and 6 have never been examined (`q3b-mirrors-by-state.raw`).
The 6 never examined are exactly the 6 withdrawn mirrors, which the status command leaves out (`q3e-null-basis-mirrors.raw`, `q3f-withdrawn-mirrors.raw`: `SELECT ... WHERE ... withdrawn_at IS NOT NULL`).
The 81 are therefore 43 mirrors with basis `unknown` plus 38 mirrors with no version row (computed: 41 + 2 + 35 + 3 = 81); D1 counts 44 where the status command counts 43, a difference of one that I did not reconcile.
On 2026-10-29, 568 of 611 mirrors were `not_examined`; today none is, so the backfill has run.

## 4. Origins of a sample of versions

Command: `bun run .context/rfc-program/evidence/v1/sample-and-fetch.ts` (draws the sample with seed 20261120, then runs `gh api repos/nemarDatasets/ID/commits/vX.Y.Z` and `gh api repos/nemarDatasets/ID/commits/SHA/pulls` for each sampled version), followed by `classify.ts`.
Raw output: .context/rfc-program/evidence/v1/q4a-multiversion-datasets.raw
Raw output: .context/rfc-program/evidence/v1/q4b-sample-github-raw.json
Raw output: .context/rfc-program/evidence/v1/q4c-nopr-commits.json
Raw output: .context/rfc-program/evidence/v1/q4d-merge-message-pr-check.json
Raw output: .context/rfc-program/evidence/v1/q4e-range-prs.json
Raw output: .context/rfc-program/evidence/v1/q4f-classification.json
Raw output: .context/rfc-program/evidence/v1/q4f-classification-summary.json
Raw output: .context/rfc-program/evidence/v1/q4f-classification.tsv

Method.
Pool: public, non-anonymous datasets with more than one version row in D1 (`q4a-multiversion-datasets.raw`: `SELECT v.dataset_id, d.visibility, ..., v.version, v.created_at, v.source_version, v.source_version_basis FROM dataset_versions v JOIN datasets d ... WHERE v.dataset_id IN (SELECT dataset_id FROM dataset_versions GROUP BY dataset_id HAVING count(*)>1)`), intersected with the public API list.
The one anonymous public dataset is excluded (ADR 0065), and no name in the sample is shown for an anonymous dataset.
Pool sizes: 267 `nm` and 24 `on`.
Draw: seed 20261120 (the dispatch date), the `mulberry32` generator, a Fisher-Yates shuffle of the sorted id list, `nm` drawn first, the first 15 of each prefix kept (`sample-and-fetch.ts`).
Sample: nm000146, nm000169, nm000191, nm000197, nm000199, nm000220, nm000229, nm000240, nm000319, nm000346, nm000390, nm000446, nm000465, nm000472, nm000476; on000117, on002578, on002778, on003061, on003078, on003190, on003343, on003739, on004362, on004850, on005262, on005574, on007315, on007327, on007473.
Only 24 `on` datasets qualify and 15 were drawn, so the `on` sample is 62 percent of its pool (computed: 15 / 24); the `nm` sample is 6 percent of its pool (computed: 15 / 267).
Each version row was resolved to its tagged commit with `gh api repos/nemarDatasets/ID/commits/vX.Y.Z`, then to pull requests with `gh api repos/nemarDatasets/ID/commits/SHA/pulls` (`q4b-sample-github-raw.json`, 0 request errors).
For tagged commits with no pull request, `gh api repos/.../commits/SHA` recorded what GitHub authenticates (`q4c-nopr-commits.json`, via `nopr-commits.ts`), and `gh api repos/.../pulls/N` checked the pull request a merge message names (`q4d-merge-message-pr-check.json`).
Roles and ownership come from D1 reads of `users`, `datasets` and `dataset_collaborators`, returning only GitHub usernames and roles: `q4d-owners.raw`, `q4e-collaborators.raw`, `q4f-author-roles.raw`, `q4g-nemar-roles.raw` (role counts: 3 `admin`, 3 `owner`, 114 `member`); re-pull records from `q4c-repull-records.raw`.

Classification rules (research note B6, applied in `classify.ts`):
`source` when the pull request's author is the dataset's owner or a collaborator NEMAR granted (D1), or the version is a re-pull's `N.0.0` found in `upstream_repulls`;
`nemar` when the author has the `owner` or `admin` role on NEMAR and is not the dataset's owner;
`community` for any other authenticated GitHub user;
`unknown` when no pull request is linked to the tagged commit, never guessed.
Two judgments the lead should know about.
For a mirror (`on`), the source is upstream, so the NEMAR import account that owns the dataset is not counted as the source; applying the literal B6 and open-decision-10 wording ("an administrator who owns a dataset counts as its source") instead moves 3 mirror versions (2 `nemar`, 1 `community`) to `source`; both columns are in `q4f-classification.tsv`.
The first row of each sampled dataset (30 rows, 29 of them with no pull request) is the initial publication, not a change, and is excluded from the class counts.

Result for the 54 later versions (38 `nm`, 16 `on`; `q4f-classification.json`, `q4f-classification-summary.json`):

| Class | `nm` later versions | `on` later versions | Total |
|---|---|---|---|
| source | 21 | 4 | 25 |
| nemar | 4 | 2 | 6 |
| community | 1 | 9 | 10 |
| unknown | 12 | 1 | 13 |
| Total | 38 | 16 | 54 |

The four mirror `source` rows are re-pull `N.0.0` versions (on000117, on003061, on003739, on004362), each matching an `upstream_repulls` record and its pull request number; three carry the `Upstream-Snapshot` trailer and on000117 does not.
The nine mirror `community` rows are pull requests by accounts that hold the NEMAR `member` role and are not the dataset's owner: six by AmanJaiswal1503 and three by bruAristimunha.
One of the six (on007315) is by a collaborator NEMAR granted on that dataset, which the mirror rule above does not count as source.
For the `nm` sample the owner of all 15 datasets is one depositor account.
In the whole public list, 310 of 327 `nm` datasets belong to that one account (`api-datasets-offset-N.json`, `owner_username`), so the `nm` `source` count mostly says "this one bulk depositor"; the `nm` sample cannot speak for the other 17 `nm` datasets.

### A finding that changes a premise in research note B6

B6 states that one merged pull request is one version and that a version has exactly one producing pull request.
In the sample that holds for 41 of the 54 later versions (26 `nm`, 15 `on`: the tagged commit has a linked pull request).
For 13 later versions (12 `nm`, 1 `on`) the tag points at a commit that has no pull request, and the pull request that carried the change was merged earlier:

| Tagged commit with no pull request | Versions | Notes |
|---|---|---|
| Automated "Update NEMAR metadata (pipeline: validated or enriched) [skip ci]" commit, no GitHub account linked, unsigned | 11 | the tag moved to the pipeline commit that followed a pull request merge |
| "Merge pull request #N" commit by the depositor, committer `web-flow`, unsigned | 2 | the named pull request exists and is merged, but its merge commit differs from the tagged commit (`q4d-merge-message-pr-check.json`: `sha_matches` false for both) |

Counting the merged pull requests whose merge commit lies between the previous version's tag and this one (`range-prs.ts` -> `q4e-range-prs.json`, a secondary measure that is not the card's rule), 9 of those 13 versions contain exactly one such pull request (8 by the owner, 1 by a community account) and 4 contain none.
So a tag-commit-to-pull-request lookup (`commits/{sha}/pulls`), the rule B6 proposes, leaves 13 of 54 later versions (24 percent, computed) `unknown`; a range lookup would classify 9 of them and leave 4 `unknown` (7 percent, computed: 4 / 54).
Commit author fields are not authenticated, and none of the 42 sampled tagged commits without a pull request (29 initial and 13 later) was signed (`verified` false, reason `unsigned`, `q4c-nopr-commits.json`), so a signature cannot stand in for the missing link.

## 5. Datasets reporting HED, re-measured from the public API

Command: `curl 'https://api.nemar.org/datasets?limit=100&offset=N'` for `N` = 0, 100, ..., 900, summarized by `sample-and-fetch.ts` (`has_hed` equal to 1).
Raw output: .context/rfc-program/evidence/v1/q5-hed-and-totals.json
Raw output: .context/rfc-program/evidence/v1/api-datasets-offset-0.json

| Prefix | Public datasets | Reporting HED |
|---|---|---|
| `nm` | 327 | 184 |
| `on` | 583 | 38 |
| Total | 910 | 222 (computed: 184 + 38) |

This matches the research note (222: 38 `on`, 184 `nm`).
One public dataset is anonymous (`q5-hed-and-totals.json`).

## Waiting on the owner

Nothing.
No read was refused.
`nemar admin upstream-status` ran as the signed-in administrator and exited with status 2 only because two mirrors could not be compared with OpenNeuro (section 3).

## Deviations from the card

- The card's worktree command names `origin/feature/rfc-program`, which was not yet pushed when the work started; the branch was created from the local `feature/rfc-program` at `bcb6ac46`, before the integration branch was pushed.
  The PR now targets `feature/rfc-program`, and that branch has been merged into this one.
- The card allows one script; five small Bun scripts and one shell helper are saved (`sample-and-fetch.ts`, `nopr-commits.ts`, `range-prs.ts`, `classify.ts`, `api-crosscheck.ts`, `d1-select.sh`) so each number can be reproduced.
  The manager accepted this deviation; the scripts stay inside the card's Scope.
- The D1 count (44 mirrors with only `unknown` rows) and the status command's count (43 mirrors with basis `unknown`) differ by one and are left unreconciled (section 3).
