-- Compact the two unbounded per-file payloads already stored in D1 (#1189,
-- fixes #1188): rewrite them into the counts-and-pointer summaries the write
-- paths now produce, so no `audit_log` or `datasets` row renders a backup
-- INSERT statement over D1's ~100 KB statement limit. Restoring the hourly
-- backup aborted with SQLITE_TOOBIG on 15 such statements: 11 audit rows
-- whose `details` inlined a full integrity-check `missingKeys`/`zeroByteKeys`
-- key list (largest: 12,397 keys, 1.15 MB), and 4 datasets rows whose
-- `zarr_data_failures` inlined the per-recording failure array (largest: 877
-- entries, 178 KB).
--
-- Counts are DERIVED from the arrays being dropped (json_array_length), not
-- zeroed: the summary must answer "how many" even though "which" now lives in
-- the artifact that owns the detail -- `.nemar/availability-report.json` on
-- the dataset repo for missing content, the published Zarr index's `failures`
-- list (`<dataset>/zarr/index.json` in the serving bucket) for conversion
-- failures. Both are richer than the copies dropped here.
--
-- Each rewrite carries 'compacted_by' = 'migration_0074' so a reader can tell
-- a migrated record from one the write paths produced natively.
--
-- Scoped by payload SHAPE, not by action/status: BOTH integrity key arrays
-- must be present for the audit rewrite (that pair is the
-- DatasetVersionIntegrityResult signature, written by import_verify_forced
-- AND import_reclassified_incomplete), and `zarr_data_failures` must be a
-- top-level JSON array. Rows that are NULL, non-JSON, or already compact
-- match neither predicate and are left byte-identical.
--
-- The CASE wrapper in each WHERE is load-bearing: json_type() throws on
-- malformed JSON rather than returning NULL, and SQLite does not guarantee
-- left-to-right evaluation of AND operands, so `json_valid(x) AND
-- json_type(x, ...)` could still evaluate json_type first. CASE guarantees
-- the json_valid gate runs before any json_type call.
--
-- json(col -> '$.key') rather than json_extract(col, '$.key') for the copied
-- scalar fields: json_extract collapses JSON true/false to 1/0, while `->`
-- returns the JSON subvalue verbatim and json() re-embeds it, so `complete`
-- stays a boolean and a null `version` stays null -- byte-compatible with
-- what JSON.stringify(integrityAuditSummary(...)) writes.
--
-- Naturally idempotent: a rewritten payload no longer carries the arrays, so
-- a re-run matches zero rows.

UPDATE audit_log
SET details = json_object(
  'complete', json(details -> '$.complete'),
  'expectedCount', json(details -> '$.expectedCount'),
  'presentCount', json(details -> '$.presentCount'),
  'bytesPresent', json(details -> '$.bytesPresent'),
  'declaredBytes', json(details -> '$.declaredBytes'),
  'declaredFiles', json(details -> '$.declaredFiles'),
  'version', json(details -> '$.version'),
  'missing_count', json_array_length(details, '$.missingKeys'),
  'zero_byte_count', json_array_length(details, '$.zeroByteKeys'),
  'detail_ref', '.nemar/availability-report.json',
  'compacted_by', 'migration_0074'
)
WHERE CASE
  WHEN details IS NOT NULL AND json_valid(details)
  THEN json_type(details, '$.missingKeys') = 'array'
   AND json_type(details, '$.zeroByteKeys') = 'array'
  ELSE 0
END;

-- No datasets trigger fires here: datasets_fts_au and datasets_embed_dirty_au
-- are UPDATE OF triggers on the search/embedding columns only.
UPDATE datasets
SET zarr_data_failures = json_object(
  'count', json_array_length(zarr_data_failures),
  'detail_ref', 'zarr/index.json',
  'compacted_by', 'migration_0074'
)
WHERE CASE
  WHEN zarr_data_failures IS NOT NULL AND json_valid(zarr_data_failures)
  THEN json_type(zarr_data_failures) = 'array'
  ELSE 0
END;
