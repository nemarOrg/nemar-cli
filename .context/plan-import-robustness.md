# Plan: Robust unattended OpenNeuro → NEMAR import + remediation

> **Decision recorded:** [ADR 0010 - Imports use server-side S3 copy](decisions/0010-imports-use-server-side-s3-copy.md).
> This document keeps the verified facts and the phase plan.


> **STATUS: HISTORICAL.** Plan behind epic #967, now shipped.
> Current decisions live in [`.context/decisions/`](decisions/README.md); where this document and an ADR disagree, the ADR wins.

Companion to `research-openneuro-import-forensics.md`. Goal: imports of arbitrarily large
OpenNeuro datasets complete **unattended, idempotently, with no orphaned state, no archive
blowups, and downloadable output** — all inside CI (no external server, per decision 2026-06-15).

## Verified facts that drive the design (tested 2026-06-15)

- **Server-side S3 copy works.** `aws s3 cp s3://openneuro.org/<path> s3://nemar/<id>/objects/<key>`
  succeeded cross-account, cross-region (OpenNeuro us-east-1 → NEMAR us-east-2), signed read of the
  public bucket, bytes never touch the runner (747 B test, ETag matched). The old `curl | aws s3 cp -`
  client-stream (import-openneuro.ts:481) is what forced every byte through the 2-core runner and blew
  the 6 h cap on the 9 TB set. The 403 the code comment dodged is NOT a hard block.
- OpenNeuro mirrors the **full dataset tree by path** at `s3://openneuro.org/ds<id>/<path>` (not just
  annex keys) — so we can address sources by path or by annex-key whereis URL.
- `/admin/manifest/dispatch` (admin.ts:6728) re-emits manifest+summary but **requires an existing
  `dataset_versions` row** (404s otherwise). on005385/on005752 have no such row → they need the
  Phase-2 fix or a manual version-row backfill; on007523/on007524 already have the row.
- `generate-manifest.yml` / `generate-records.yml` both accept **`workflow_dispatch`** inputs
  (dataset_id, version, callback_url; manifest has `skip_callback` for manual backfills).

---

## Epic (drive via /project:epic-dev) — 4 phases

### Phase 1 — Server-side, resumable, sharded transfer  (kills the on004395 6 h-cap failure)
- Replace client-stream copy with server-side `s3://openneuro.org → s3://nemar` (verified). Map each
  annex key → OpenNeuro S3 path via `git annex whereis`; copy to `s3://nemar/<id>/objects/<key>`.
- Tune `multipart_chunksize` (~256 MB–1 GB) so multi-GB files don't spawn thousands of part-copies.
- **Resumable + idempotent:** before each copy, `head-object` the dest (skip if present) and/or keep a
  per-dataset copied-keys checkpoint in staging. A re-run resumes; never restarts from zero.
- **Shard** keys into N matrix jobs (defense-in-depth vs the 6 h cap) and add `max-parallel` so parallel
  dataset imports don't starve runners.
- Preflight total bytes + file count to pick chunk size / shard count.
- Per-object fallback to curl-stream only if a specific signed CopyObject 403s (logged, not fatal).
- **Accept:** re-import a multi-TB set (e.g. ds004395) unattended to completion; object count + bytes
  match OpenNeuro.

### Phase 2 — Version-DOI / manifest path that can't time out  (kills the on005385/on005752 failure)
- Root cause: `/webhooks/publish-version-doi` does synchronous file-tree-scaling work (recursive
  `getTreeAtRef` + EZID mint + dispatch) inside the workflow's 60 s curl budget → deterministic fail past
  a few thousand files (file-count-bound, not bytes).
- Return **202 + create the manifest_jobs/version row + dispatch**, then do EZID mint + metadata read off
  the request path (Queue / `waitUntil` / inside the central workflow). Workflow **polls** for completion
  instead of holding a 60 s curl.
- Cheapen metadata read: fetch only the few metadata files via Contents API, not a full recursive tree.
- Reconcile the two version-DOI paths (admin-approve EZID step vs tag-triggered webhook) into one
  idempotent owner; raise workflow `--max-time` + real backoff as belt-and-suspenders.
- **Accept:** publish a 10k-file set; version DOI + manifest + records + `dataset_versions` row all land;
  data plane flips to published; no 60 s timeout.

### Phase 3 — Archive policy: >100 GB → skip, steer to direct download
- Preflight (bytes OR file count) over threshold → set `archive_status='skipped'`(+reason), skip the
  generate-archive dispatch. (4/5 of the batch are >100 GB and none archived anyway.)
- ≤ threshold: add a concurrency group + resumable multipart + higher concurrency, or raise the 60 min cap.
- Website download button reads `archive_status`: ready→zip; skipped/too_large→wget/curl recipe;
  failed→direct download; null→pending. Recipe from manifest `bytes_url` (stable, range-resumable, verified):
  `curl -s data.nemar.org/<id>/<v>/manifest.json | jq -r '.[].bytes_url' > urls.txt && wget -xc -i urls.txt`
- Backfill: mark existing oversized sets 'skipped'; admin sweep to delete any oversized zips.
- **Accept:** a >100 GB publish skips archive + UI shows wget/curl; a <100 GB still gets a zip.

### Phase 4 — Idempotency, rollback, completion tracking, noise
- Per-dataset import state machine (single source of truth: stage, last_error, resume cursor) + admin
  "import status" view.
- Terminal failure → auto-rollback (delete empty repo + partial S3 + D1 row) OR quarantine; no silent orphan.
- Fix duplicate enrichment dispatch + git-push race (single dispatch / concurrency group + rebase-retry).
- **Fix the validate-stage git-annex blind spot (NEW, found 2026-06-15).** The enrichment/validate judge
  reads the repo and reports **"0.0 MB across 0 annexed files"** for annexed datasets, then opens a
  blocking "binary data files not found" issue and pins `pipeline_stage` at `enriched` — even though the
  blobs are in S3 and `generate-manifest` resolves their sizes fine. Confirmed on on007523 (478 GB/642 f
  really present; judge saw 0). This will block ~every large annexed OpenNeuro import from reaching
  `validated`. Fix: feed annex sizes into enrichment (from the version manifest, `git annex info`, or a
  full annex-aware clone) so the judge sees real data volume. on007524 passed only by LLM nondeterminism.
- Make prescreen advisory (not a red CI that masks real failures).
- **Accept:** kill an import mid-flight → clean resume or clean rollback; no duplicate-dispatch failures;
  an annexed dataset with data in S3 reaches `validated`.

---

## Separate remediation track — the 4 already-moved datasets (do now, not in the epic)

| Dataset | Have | Missing | Steps |
|---|---|---|---|
| on007524 (321 GB/545 f) | version row, manifest, records, enrich=validated | downloadable zip | mark `archive_status` skipped (Phase 3 flag); already direct-downloadable. **Lightest.** |
| on007523 (478 GB/642 f) | version row, manifest, records | enrich stuck `enriched`; zip | re-run enrichment → validated (`reindex on007523` / re-dispatch run-enrichment); mark archive skipped |
| on005385 (79 GB/3265 f) | EZID DOI only | **version row, manifest, records**; enrich `enriched`; zip | needs version-row + manifest/records backfill (Phase-2 fix then re-run run-version-doi **preferred** — remediation doubles as fix verification; or manual: insert `dataset_versions` row + `workflow_dispatch` generate-manifest/records); then enrichment; archive skipped |
| on005752 (680 GB/11000 f) | EZID DOI only | **version row, manifest, records**; zip | same backfill as on005385 (enrich already validated) |

Recommendation: do on007523/on007524 now (safe, quick). For on005385/on005752, land Phase 2 first and
re-run their version-DOI so the fix is verified on the exact datasets that exposed it.

**Remediation done 2026-06-15:** on007524 already complete (validated; archive intentionally skipped by
policy). on007523 enrichment re-run cleanly (old push-race gone), but it stays `enriched` — blocked by the
Phase-4 validate-stage git-annex blind spot above (judge sees 0 annexed files). Not forceable from outside;
it clears when that bug is fixed. on007523 is published + direct-downloadable regardless. on005385/on005752
deferred to Phase 2.

## Status
- on004395: deleted by user 2026-06-15 (empty repo + 3.86 TB orphan S3 + D1 row). No cleanup owed.
- Fleet otherwise structurally clean: only orphan was `xx000002` (sandbox leftover, trivial).
