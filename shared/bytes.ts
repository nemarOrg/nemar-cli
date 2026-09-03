/**
 * Byte-size formatters (epic #1225 phase 4, issue #1227).
 *
 * NEMAR had seven independent byte-formatting functions scattered across the
 * CLI and backend, each hand-rolled and each drifting from the others in
 * its own way (the audit that prompted this counted six; a seventh,
 * `formatSize` in src/commands/dataset.ts, turned up during the work and was
 * byte-identical to `formatBytesCli` below the 1 PiB clamp). This module consolidates them into one file. It does NOT
 * consolidate them into one function: the five surviving formats are
 * genuinely different strings for the same byte count (see the table
 * below), each has at least one live consumer today, and the epic's
 * definition of done forbids changing a served response shape or a CLI
 * output format. A single parameterized formatter would still need five
 * call sites passing five different options objects -- this is that, with
 * the options already chosen and named, rather than re-derived at each
 * call site.
 *
 * The decimal outlier -- `backend/src/services/s3.ts`'s decimal/1000
 * `formatBytes`, the outlier this consolidation's audit named -- is
 * deleted outright, not moved here. Its one caller
 * (`enrich-dataset.ts`'s Stage 1a size seed) now calls `formatFileSize`,
 * the canonical binary formatter, instead.
 *
 * ADR 0038 records why this stays a bespoke module rather than adopting a
 * maintained formatting library (pretty-bytes was the sub-issue's original
 * proposal): no maintained option reproduces NEMAR's "SI-looking labels
 * over a 1024 base" spelling or the magnitude-dependent fraction-digit
 * policy below, and `formatFileSize`'s output is contractual --
 * `file_size_formatted` is served on the catalog and pinned by golden
 * tests in this repo.
 *
 * | Function             | Base | Labels                          | Decimal policy                                              | Consumers                                                                                          | Contractual                        |
 * |-----------------------|------|-----------------------------------|----------------------------------------------------------------|--------------------------------------------------------------------------------------------------------|-------------------------------------|
 * | `formatFileSize`      | 1024 | `B KB MB GB TB`                   | none at the base unit; 2 decimals below 100 in-unit; 0 at/above 100 | `catalog.ts` derives the served `file_size_formatted` field from this at read time                     | YES -- the canonical served formatter |
 * | `formatBytesDetailed` | 1024 | bare `"N B"` below 1024, else `KB MB GB TB PB` | 2 decimals below 10 in-unit; 1 below 100; 0 at/above 100 | `data-router.ts`'s served JSON listing (`size_human`) and served `metadata.json` (`data_summary.size_human`) | served, but a DIFFERENT field/precision tier than `formatFileSize` |
 * | `formatBytesCompact`  | 1024 | bare number below 1024, else `K M G T P` (no space) | 1 decimal below 10 in-unit; 0 at/above 10           | `data-router.ts`'s served HTML directory-index size column                                             | served (HTML)                      |
 * | `formatBytesCli`      | 1024 | `B KB MB GB TB`                   | none at the base unit; 1 decimal above                          | CLI progress bar, `formatSpeed`, upload plan/preflight, dataset/admin/sandbox commands                 | no -- terminal output only         |
 * | `formatBytesTrimmed`  | 1024 | `B KB MB GB TB`                   | up to 2 decimals, trailing zeros trimmed                        | `nemar dataset validate`'s text report Summary line (`formatValidationResult`)                         | no -- terminal output only         |
 *
 * Every function above shares the same 1024 base; none of NEMAR's six
 * formatters ever used a 1000 base for anything that stayed. (The deleted
 * `s3.ts` decimal formatter did -- that inconsistency, sitting next to the
 * five binary ones, is exactly the bug this phase retires.)
 */

const BASE = 1024;

/**
 * Shared 1024-base scaling loop: divide `value` by `BASE` while it is still
 * at least `BASE` and unit slots remain, and report how many divisions
 * happened. `formatFileSize`, `formatBytesDetailed` and `formatBytesCompact`
 * each had this identical loop inlined; the only differences between them
 * are their label arrays, whether they pre-divide once before the first
 * check (encoded here by what the caller passes as `value`), and their
 * post-loop decimal-precision policy -- all three stay with their own
 * caller. Callers pass in `value`, not raw untouched bytes, so this helper
 * neither special-cases zero, negative, nor non-finite input; every caller
 * guards those itself, matching what each original function guarded (or
 * did not).
 */
function scaleByBase(value: number, maxIndex: number): { value: number; index: number } {
  let v = value;
  let index = 0;
  while (v >= BASE && index < maxIndex) {
    v /= BASE;
    index++;
  }
  return { value: v, index };
}

/**
 * Shared log-based unit-index lookup used by `formatBytesCli` and
 * `formatBytesTrimmed`, which pick their unit via `floor(log_1024(bytes))`
 * instead of `scaleByBase`'s division loop. Kept as a separate algorithm
 * rather than folded into `scaleByBase`: the two approaches can disagree by
 * a floating-point rounding hair at an exact power-of-1024 boundary, and
 * unifying them risked silently shifting one of these two formatters off
 * its historical (and golden-tested) output. `formatBytesCli` used this exact
 * expression before this module existed; `formatBytesTrimmed`'s original had
 * no `Math.min` clamp, so for that one the clamp is a deliberate fix rather
 * than a faithful port -- see its own note below (#1225 review).
 */
function logUnitIndex(bytes: number, maxIndex: number): number {
  return Math.min(Math.floor(Math.log(bytes) / Math.log(BASE)), maxIndex);
}

/**
 * The canonical served file-size formatter. Binary/1024, labels
 * `B KB MB GB TB` (clamped at TB), no decimals at the base unit, 2 decimals
 * below 100 in the chosen unit and 0 at/above 100.
 *
 * `null`/`undefined`/non-finite/`<= 0` all return `null` -- a served field
 * that is absent rather than a noisy "0 B" or "-5 B" placeholder.
 *
 * Contractual: `backend/src/routes/datasets/catalog.ts`'s
 * `deriveFileSizeFormatted` calls this to derive the served
 * `file_size_formatted` field (both the list and detail branches) at read
 * time from the stored `file_size` column (#1182, migration 0071 --
 * `file_size_formatted` itself is not stored). Moved verbatim from
 * `backend/src/services/dataset-metadata-columns.ts`.
 */
export function formatFileSize(bytes: number | null | undefined): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  const { value: n, index: i } = scaleByBase(bytes, units.length - 1);
  const fixed = i === 0 ? `${n}` : n >= 100 ? n.toFixed(0) : n.toFixed(2);
  return `${fixed} ${units[i]}`;
}

/**
 * Binary/1024, bare `"N B"` below 1024 (no `.toFixed`), else labels
 * `KB MB GB TB PB` (clamped at PB) with precision tiers chosen to keep the
 * string short while preserving resolution for small values:
 *
 *   value < 10   -> 2 decimals  ("1.15 GB",  "9.87 MB")
 *   value < 100  -> 1 decimal   ("99.5 GB",  "12.3 MB")
 *   value >= 100 -> 0 decimals  ("450 MB",   "150 GB")
 *
 * `null` in, `null` out. Negative or non-finite input also returns `null`
 * -- callers receive an absent field rather than a noisy placeholder.
 *
 * Consumers: `backend/src/services/data-router.ts`'s served JSON directory
 * listing (`size_human`) and `buildDatasetMetadata`'s served
 * `data_summary.size_human` in `metadata.json`. Distinct precision tiers
 * from `formatFileSize` -- do not conflate the two served size fields.
 * Moved verbatim from `data-router.ts`'s `formatBytes` (renamed to avoid
 * colliding with `formatBytesCli`).
 */
export function formatBytesDetailed(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < BASE) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  const { value, index: unit } = scaleByBase(bytes / BASE, units.length - 1);
  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${units[unit]}`;
}

/**
 * Binary/1024, compact form with no separating space: the bare number below
 * 1024, else labels `K M G T P` (clamped at P) glued directly to the value.
 * 1 decimal below 10 in the chosen unit, 0 at/above 10. `"?"` for negative
 * or non-finite input, never a rendered `NaN`/`undefined`.
 *
 * Consumer: `backend/src/services/data-router.ts`'s served HTML directory
 * index size column (`renderIndexHtml`). Moved verbatim from
 * `data-router.ts`'s `humanSize` (renamed for the same family-naming
 * convention as the other four).
 */
export function formatBytesCompact(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < BASE) return `${bytes}`;
  const units = ["K", "M", "G", "T", "P"];
  const { value, index: unit } = scaleByBase(bytes / BASE, units.length - 1);
  return `${value.toFixed(value < 10 ? 1 : 0)}${units[unit]}`;
}

/**
 * Binary/1024, labels `B KB MB GB TB` (clamped at TB, index picked via
 * `logUnitIndex`), no decimals at the base unit and 1 decimal above.
 * `0` returns `"0 B"`.
 *
 * Terminal output only, not a served field -- but the epic still forbids
 * changing CLI output format, so its precision tiers are unchanged from
 * the original.
 *
 * Consumers: the CLI download progress bar, `formatSpeed`,
 * `src/lib/upload/{plan,preflight}.ts`, and the `dataset`/`admin`/`sandbox`
 * commands. Moved verbatim from `src/lib/progress.ts`'s `formatBytes`.
 */
export function formatBytesCli(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = logUnitIndex(bytes, units.length - 1);
  const value = bytes / BASE ** i;
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Binary/1024, labels `B KB MB GB TB` (clamped at TB, index picked via
 * `logUnitIndex`), up to 2 decimals with trailing zeros trimmed
 * (`Number.parseFloat` on the fixed string, so `1048576` reads "1 MB", not
 * "1.00 MB"). `0` returns `"0 B"`.
 *
 * Terminal output only, not a served field.
 *
 * FIX (issue #1227 step 3, not a format change): the original
 * `src/lib/bids-validator.ts` copy computed its index with no clamp, so at
 * 1 PiB and above `sizes[i]` was `undefined` and the line read
 * "Size: 1 undefined". This version clamps via `logUnitIndex` like every
 * other formatter here. No input below 1 PiB is affected -- no realistic
 * dataset reaches that size, and the golden tests below 1 PiB are
 * unchanged by this fix.
 *
 * Consumer: `formatValidationResult`'s Summary "Size:" line. Moved (and
 * fixed) from `bids-validator.ts`'s module-private `formatBytes`.
 */
export function formatBytesTrimmed(bytes: number): string {
  if (bytes === 0) return "0 B";
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = logUnitIndex(bytes, sizes.length - 1);
  return `${Number.parseFloat((bytes / BASE ** i).toFixed(2))} ${sizes[i]}`;
}
