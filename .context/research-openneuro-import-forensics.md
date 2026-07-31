# OpenNeuro → NEMAR Import: Forensic Review (2026-06-15)

> **Related decision:** [ADR 0010 - Imports use server-side S3 copy](decisions/0010-imports-use-server-side-s3-copy.md).

Batch imported 2026-06-14: **on004395, on007523, on007524, on005385, on005752**
(OpenNeuro ds004395 PEERS, ds007523/4 Little Prince MEG, ds005385 Dortmund EEG, ds005752 NIMH).

**Headline: 0 of 5 completed cleanly.** Each failed at a *different* stage, and every
failure left orphaned state because the pipeline has no rollback/resume/idempotency.
What was experienced as "rate limits" was, on the evidence, mostly **deterministic
timeouts** (a 6-hour runner cap, a 60-second curl budget, a 60-minute archive cap) plus
a duplicate-dispatch race — not GitHub abuse limiting.

## Ground-truth state (D1 + S3 + Actions, verified)

| Dataset | S3 size | Files | BIDS | Enrich | Version-DOI CI | Zenodo | manifest/records | Archive | Net |
|---|---|---|---|---|---|---|---|---|---|
| on004395 | **3.86 TB partial** (5160/6494, ~9 TB full) | — | — | — | n/a | — | — | — | **private D1 row + empty repo + 3.86 TB orphan S3**; onboard job killed at 6 h |
| on007524 | 321 GB | 545 | pass | validated | **OK** | yes | yes | **MISSING** (60-min cancel) | published, no zip |
| on007523 | 478 GB | 642 | pass | **stuck "enriched"** | **OK** | yes | yes | **MISSING** (60-min cancel) | published, no zip |
| on005385 | 79.5 GB | 3265 | pass | **stuck "enriched"** | **FAIL (60 s timeout)** | no | **no** | none | DOI minted but data-plane "Version not published" |
| on005752 | 680 GB | 11000 | pass | validated | **FAIL (60 s timeout)** | no | **no** | none | DOI minted but data-plane "Version not published" |

- `archive_status = NULL` for all five. **No dataset in the batch has a downloadable zip.**
- All four "published" rows are `public` with live EZID DOIs; `publication_requests.status='published'`.
  - `steps_completed` for **on005385/on005752 omits `version_doi`**; on007523/on007524 include it.
  - on005385 + on007523 carry `block_reason='prescreen_failed'` yet published anyway (prescreen is advisory).

## Root causes (distinct, evidence-cited)

### 1. on004395 (9 TB) — 6-hour GitHub-hosted runner hard cap, no resume
`onboard-openneuro.yml` job: `runs-on: ubuntu-latest`, **no `timeout-minutes`** (→ GitHub's 6 h ceiling),
`strategy.matrix` with **no `max-parallel`**. Log: copy of 6494 files started `07:14:39`, killed
`13:13:42` = **359 min** ("The operation was canceled"). The S3-to-S3 copy (`curl … | aws s3 cp`,
8-way) cannot move ~9 TB in 6 h. Because the copy never finished: no git push (repo `diskUsage=0`),
no CI, no publish. **No cleanup ran** (grep of the workflow shows no `failure()`/cleanup/rollback step),
so it left: a `private` D1 row, an empty GitHub repo, and **3.86 TB of half-copied objects** in
`s3://nemar/on004395/objects/`. Public API returns "not found" because private datasets are hidden.

### 2. on005385 + on005752 — "version-DOI CI fails every time, even manual": deterministic 60 s Worker timeout, file-count-bound
`run-version-doi.yml` "Publish Version DOI" step: `curl --connect-timeout 10 --max-time 60`, **2 attempts**,
to `POST api.nemar.org/webhooks/publish-version-doi`. Both attempts logged
`curl (28) Operation timed out after 60002 ms … HTTP 0`. The handler
(`backend/src/routes/webhooks.ts:247` → `handleEzidVersionDoi`) does **synchronous, file-tree-scaling
work before responding**: `readRepoMetadata(... vX.Y.Z)` (recursive git tree at the tag via
`getTreeAtRef`, `github.ts:2083`) + EZID mint + central manifest dispatch.
- The two failures have **3265 and 11000 files**; the two successes have **545 and 642 files**.
- **on005385 is only 79.5 GB but failed** → the wall is **file count, not bytes**. The Worker exceeds
  60 s for thousands of pointer files; it will fail on every re-run (deterministic), matching the report.
- Consequence: no Zenodo, no `version/` manifest or records.json on S3 → data plane reports
  "Version not published" and `records.json` 404s, so even direct-download is incomplete for these two.

### 3. on007523 + on007524 archives — 60-minute archive cap + slow streaming throughput
`run-generate-archive.yml`: `timeout-minutes: 60`, no concurrency group, no size guard. The on007523
archive ran `08:32:32→09:32:47` (60 min) and was cancelled at **Progress 600/2508 (~24%)** —
~10 files/min for multi-GB MEG files. So **archive generation times out at 60 min for mid-size
datasets too**, not just the 9 TB one. Both dispatched archive jobs were cancelled; the other two
never dispatched (their version-DOI failed first).

### 4. Duplicate enrichment dispatch racing on git push
Actions show paired `Run Enrichment` runs ~2 s apart, one succeeding, one failing with
`Action-side metadata commit could not be pushed after 3 attempts; D1 cache is ahead of the repo`.
Two near-simultaneous enrichment runs contend on the non-fast-forward push of `.nemar/metadata.json`;
the loser fails. Plausibly why on007523/on005385 are stuck at `enriched` (never reached `validated`).

### 5. Cross-cutting: no transaction, no resume, no completion tracking, two DOI paths
- Import is a **fan-out of fire-and-forget dispatches** with tight curl budgets and no end-to-end status.
  CLI/orchestrator exit codes do not reflect true terminal state (see `publication_orchestrator_quirks`).
- **Two version-DOI code paths disagree**: the admin-approve orchestrator's `version_doi` step (EZID) vs
  the tag-triggered `run-version-doi.yml` webhook (Zenodo + data-plane publish + manifest/records dispatch).
  Result: `latest_version_doi` set while the data plane says "not published".
- Prescreen failures surface as red CI but are advisory → noise that masks real failures.
- **Zenodo** can't take a 680 GB record anyway (per-file/record caps); streaming a huge release.zip into the
  Worker request is itself a Worker-time blowup source.

## The ">100 GB: no archive, use direct download" proposal — supported by the data

4 of 5 are >100 GB (321/478/680 GB, 3.86 TB+); only on005385 (79.5 GB) is under. **None got an archive
regardless** — the zip path already fails for all of them. Formalizing the policy matches reality.

**Direct download is already viable and is the better UX for large data:**
- `data.nemar.org/<id>/<version>/manifest.json` lists every file with `path`, `size`, `sha256`, and a
  **stable `bytes_url`** = `https://data.nemar.org/<id>/<version>/<path>` (verified). It is **not** a baked-in
  presigned URL and it **honors HTTP range** (verified `206` on a 1 KB range) → fully `wget -c` / `curl -C -`
  resumable and parallelizable. Recipe:
  `curl -s data.nemar.org/<id>/<v>/manifest.json | jq -r '.[].bytes_url' > urls.txt && wget -xc -i urls.txt`
- Gap: the manifest/records index is **missing for exactly the datasets where version-DOI failed**
  (on005385/on005752). The direct-download story depends on completing manifest/records emission, which
  is the same Worker-timeout fix as root cause #2.

## Weak points to address before unattended automation

- **A. Move/parallelize/resume the data transfer.** Don't run multi-TB copies in a 6 h GitHub runner.
  Options: self-hosted/long-lived runner or Hallu; **server-side S3 copy** (avoid streaming bytes through
  the runner); **shard the matrix + checkpoint copied keys** so re-runs resume; size/file-count preflight to
  pick strategy + per-shard timeout. Add `max-parallel` so concurrent imports don't starve each other.
- **B. Make version-DOI publish async + cheap.** Validate-and-202 then do tree-read/EZID/dispatch in
  `waitUntil`/a Queue consumer; workflow **polls** for completion (like `manifest-ready`) instead of a 60 s
  synchronous curl. And cut per-request cost: read the few metadata files via Contents API instead of a full
  recursive tree of thousands of pointers. (Raising `--max-time` alone is a band-aid.)
- **C. Implement the >100 GB archive policy.** Preflight on total bytes **and** file count; if over, set
  `archive_status='skipped'/'too_large'`, skip the job, surface wget/curl. For ≤ threshold, add a concurrency
  group, raise the cap, and use resumable multipart with higher concurrency. Backfill: mark the 4 big ones
  `skipped` and delete any oversized zips (none exist yet here).
- **D. Finish the direct-download UX.** Generate a copy-paste recipe / tiny downloader per dataset; website
  download button reads `archive_status` and switches zip ↔ "wget/curl (large dataset)"; regenerate
  manifest/records for on005385/on005752 once #2 is fixed.
- **E. Idempotency + rollback + status.** Every stage idempotent and resumable; one source of truth for
  per-dataset stage; on terminal failure auto-rollback (delete empty repo + partial S3 + D1 row) or quarantine
  for admin. Add an import-status view.
- **F. Fix duplicate enrichment dispatch + push race** (single dispatch; or serialize commits via concurrency
  group + rebase-retry).
- **G. Reconcile the two version-DOI paths** into one owner; the other idempotent and gated on it.
- **H. Decouple Zenodo for big datasets** (tie to the >100 GB policy; EZID is canonical). Removes a major
  Worker-time/upload-cap failure source.

## Immediate remediation for these 5

- **on004395:** decide — re-import on a non-capped, resumable runner, OR delete empty repo + 3.86 TB orphan
  S3 + private D1 row. It currently costs storage for zero value.
- **on005385, on005752:** re-drive version-DOI completion via a path that doesn't hit the 60 s timeout, so
  manifest + records get emitted and the data plane flips to published; skip Zenodo + archive per policy.
- **on007523, on007524:** already direct-downloadable; set `archive_status='skipped'` (UI → wget/curl) and
  re-run on007523 enrichment to reach `validated`.

## Key file references
- `nemarDatasets/.github` (canonical local: `~/Documents/git/nemar/nemarDatasets-github`):
  `onboard-openneuro.yml` (no timeout, matrix no max-parallel), `run-version-doi.yml:156` (60 s curl ×2),
  `run-generate-archive.yml:54` (60-min cap, no size guard).
- `nemar-cli/backend/src/routes/webhooks.ts:247` `/publish-version-doi` → `handleEzidVersionDoi`
  (sync tree read + EZID + dispatch); `services/github.ts:2083` `getTreeAtRef`.
- `nemar-cli/src/lib/import-openneuro.ts` (CLI copy logic invoked inside the onboard job).
