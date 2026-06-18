# Research: D1 backup, restore & local-run harness (#655)

Origin: issue #655 (Arnaud) — "Cloudflare database could be hacked or corrupted. We should
back it up regularly." Expanded scope per user: a **private** repo that backs up the CF D1
database hourly via a **GitHub Actions cron**, restorable, and good enough to **run the
Worker locally** as a fallback to remote CF deployment with minimal change.

## Decisions (locked with user 2026-06-18)

- **Repo:** new PRIVATE repo `nemarOrg/nemar-db-backup` (nemar-cli is PUBLIC — dumps contain
  user emails + argon2 password hashes, cannot live here).
- **Scope:** prod D1 `nemar-db` only (dev is disposable). Vectorize is derived (id-only,
  rebuildable via reindex) and Analytics Engine is telemetry — neither is backed up.
- **At rest:** plaintext `.sql` in the private repo (git delta-compresses hourly snapshots;
  one-command local run). No encryption layer.
- **Cadence:** hourly cron. Git history = point-in-time recovery (commit only when changed).
- **Include run-local harness** now (load latest backup into local miniflare D1 + `wrangler dev`).

## Empirical findings (verified against live SCCN account, dev D1)

### CF D1 resources
- `nemar-db` (prod, id `009b1a44-a385-4ecf-812d-ec8341587cb5`)
- `nemar-db-dev` (dev mirror, id `017d8f4e-...`)
- No R2/KV bound. Vectorize `nemar-dataset-index` (derived). Analytics Engine (telemetry).
- D1 is the ONLY stateful resource worth backing up.

### The FTS5 export blocker + the bypass (the crux)
- `wrangler d1 export` (full, `--no-schema`, AND `--no-data`) all FAIL server-side:
  `D1 Export error: cannot export databases with Virtual Tables (fts5)`. This is a
  Cloudflare API refusal, not a wrangler flag issue. The old migration-0031/0033 runbook
  (DROP datasets_fts, export, recreate) is UNUSABLE for a live backup.
- **Bypass that works:** `wrangler d1 export <db> --remote --table <name>` (allowlist a single
  real table) SUCCEEDS. `--table` takes ONE value per call (no multi-flag, no comma list), so
  the backup script exports each real table in its own call and concatenates.
- `--table <t> --no-schema` gives clean data-only dumps (header `PRAGMA defer_foreign_keys=TRUE;`
  then `INSERT INTO "<t>" (...) VALUES(...);`). Per-table export emits **no triggers** and uses
  `CREATE TABLE IF NOT EXISTS`.

### Table inventory (dev; prod is the same schema)
- **Real app tables (17), data + schema captured:** access_requests, audit_log, auth_codes,
  broadcast_emails, catalog_sync_log, dataset_collaborators, dataset_versions, datasets,
  id_sequence, import_jobs, manifest_jobs, notices, publication_requests, tokens,
  user_s3_permissions, users, web_sessions
- **`d1_migrations`** — keep (schema version marker so a restored DB doesn't re-run migrations).
- **`sqlite_sequence`** — MUST preserve. `AUTOINCREMENT` is used (0001, 0003, 0005, 0007, 0016,
  0017, 0018, 0021, ...). Loading rows with explicit ids auto-bumps the counter to max(id), but
  the high-water mark after deletes is only faithful if sqlite_sequence is captured.
- **`_cf_KV`** — Cloudflare-internal D1 table; EXCLUDE.
- **`datasets_fts`** — virtual (fts5); recreate from schema. Shadow tables
  `datasets_fts_data/_idx/_docsize/_config` — EXCLUDE from both schema and data (auto-managed
  by the virtual table).

### Security posture of the dump
- NO plaintext secrets: API tokens stored as `api_key_hash`; AWS creds as
  `aws_access_key_id_encrypted`/`aws_secret_access_key_encrypted` (app-level ciphertext).
- Sensitive content = user **emails (PII)** + **argon2 password hashes**. Hence: private repo
  mandatory, encryption optional.

### Restore target capability
- Local `sqlite3` 3.51.0 has fts5 compiled in → a plain-sqlite restore works, not only
  miniflare/D1-local. So `CREATE VIRTUAL TABLE ... USING fts5` in schema.sql is safe locally.

## Architecture (proposed; phases below)

```
nemar-db-backup/                      (PRIVATE, nemarOrg)
  .github/workflows/backup.yml        hourly cron -> scripts/backup.sh -> commit if changed
  scripts/
    lib.sh                            wrangler wrapper + real-table enumeration (excludes
                                      _cf_*, sqlite_*, d1_migrations?, datasets_fts*)
    backup.sh                         capture schema.sql (sqlite_master, filtered) +
                                      data.sql (per-table --no-schema, concatenated) +
                                      manifest.json (ts, per-table row counts, schema sha)
                                      + self-verify (load into temp sqlite, compare counts)
    restore-remote.sh                 DANGER-guarded restore into a D1 (disaster recovery)
    run-local.sh                      load latest backup into local D1 + `wrangler dev`
  backups/nemar-db/{schema.sql,data.sql,manifest.json}
  README.md                           restore + local-run + secrets + security notes
```

- **Schema capture:** `SELECT sql FROM sqlite_master WHERE sql NOT NULL AND name NOT LIKE
  'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT IN (shadow tables) ORDER BY type
  (table, index, trigger)`. Includes `CREATE VIRTUAL TABLE datasets_fts` + all triggers.
- **Restore order:** schema.sql (tables+indexes+FTS+triggers) then data.sql. Inserting into
  `datasets` fires the FTS AFTER-INSERT trigger → FTS self-populates (no explicit rebuild).
  Wrap in `PRAGMA foreign_keys=OFF; BEGIN; ... COMMIT;` for FK-order safety on plain sqlite.
- **Secrets (manual, user adds to repo):** `CLOUDFLARE_API_TOKEN` (needs D1:Edit; export uses
  the polling export API), `CLOUDFLARE_ACCOUNT_ID=da8d7a2a8680dab01592bbbc6f67f12c` (SCCN).

## Phasing (epic)
1. Core backup script + self-verifying round-trip (schema+data+manifest, local-tested).
2. GitHub Actions hourly cron + commit-if-changed + repo scaffolding (README, .gitignore).
3. Restore (disaster recovery) + run-local harness + docs.
(Each phase: plan -> implement -> PR -> /review-pr -> squash-merge into epic branch.)
