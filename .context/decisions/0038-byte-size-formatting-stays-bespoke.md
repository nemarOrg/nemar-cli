# ADR 0038: Byte-size formatting stays bespoke; pretty-bytes is declined

**Status:** accepted
**Date:** 2026-09-03
**Owner:** Seyed Yahya Shirazi

## Context

The offload audit (`.context/research-make-vs-take-audit.md`, candidate 2) found NEMAR's byte
formatting hand-rolled six times across the CLI and backend (a seventh,
`formatSize` in `src/commands/dataset.ts`, turned up during the work), one of them (`services/s3.ts`)
disagreeing with the other five on unit base (decimal/1000 vs. binary/1024) — a bug a code
comment already warned editors away from. The audit's proposed fix was to adopt `pretty-bytes`
(sindresorhus, near-ubiquitous, zero deps) as a single replacement.

Probing `pretty-bytes` 7.1.2 against the six formats NEMAR actually emits found it reproduces
none of them. Its binary mode emits IEC labels over base 1024: `prettyBytes(1536, {binary:
true})` is `"1.5 KiB"` and `prettyBytes(24000000000, {binary: true})` is `"22.4 GiB"`, where
NEMAR serves SI-looking labels over the same base 1024: `"1.50 KB"` and `"22.35 GB"`. Its decimal
mode emits a lowercase `kB` over base 1000: `prettyBytes(1536)` is `"1.54 kB"`. And it has no way
to express the magnitude-dependent fraction-digit policy NEMAR's canonical formatter uses (two
decimals below 100 in the chosen unit, zero at or above): even `{minimumFractionDigits: 2,
maximumFractionDigits: 2}` still produces `"22.35 GiB"`, not `"22.35 GB"` — the label spelling is
not an option `pretty-bytes` exposes.

This is load-bearing, not cosmetic. `backend/src/services/dataset-metadata-columns.ts`'s
`formatFileSize` (moved to `shared/bytes.ts` by this same PR) derives the served
`file_size_formatted` catalog field at read time, and `test/data-route.unit.test.ts` pins two
served-response size strings by literal value. The epic this phase belongs to (#1225) forbids
changing a served response shape or a CLI output format. Adopting `pretty-bytes` as specified
would mean either breaking that contract (shipping IEC labels the frontend and any API consumer
do not expect) or post-processing its output string back into NEMAR's spelling after the fact —
which is strictly worse than not adopting it: a dependency plus a translation layer, in place of
no dependency and a translation layer.

## Decision

Byte-size formatting stays bespoke. `pretty-bytes` (and, by the same reasoning, any other
maintained formatting library probed against this contract) is declined as a replacement for
NEMAR's byte formatters. The six existing implementations are consolidated into one module,
`shared/bytes.ts`, with five surviving named functions (the decimal/1000 outlier is deleted
outright, not preserved, and the seventh was byte-identical to a survivor) and a shared private scaling helper so the `1024` base
appears once. This is the audit's "replace" verdict overturned to "consolidate, keep bespoke,"
per ADR 0037: a keep verdict, recorded, is as valuable as a replace verdict.

The general constraint, so the next audit does not have to re-derive it from this one instance:
**a presentation-formatting library is only takeable when the output it is takeable for is not
already a contract.** A library that owns the string spelling (its labels, its base, its decimal
policy) is a reasonable take for output nothing downstream parses or pins. It stops being a
reasonable take the moment the exact string is served on an API response, matched by a test
assertion, or otherwise something a consumer outside this repo may already depend on byte-for-
byte — because adopting the library then means either an incompatible library upgrade path
forever, or a translation shim that erases the dependency's only benefit (owning the string).
`formatFileSize`'s output is exactly that case.

## Consequences

`shared/bytes.ts` is now the one place byte formatting lives; a new call site imports one of its
five functions rather than writing a sixth. The module's header comment carries a table of all
five (base, labels, decimal policy, consumers, contractual or not) specifically so a future
audit can evaluate a replacement candidate against the real contract in one place, instead of
re-deriving it by reading six call sites again.

This keeps a small amount of hand-rolled scaling-loop code alive that a library could in
principle own. That cost is accepted: the five functions' combined body is under 90 lines, well
under the audit's own "S" effort estimate for touching this area at all, and the decimal/1000 bug
the audit actually cared about is fixed by this same change (the outlier formatter is deleted,
not preserved) — independent of the pretty-bytes question.

The unresolved question this ADR does NOT settle: whether NEMAR's five surviving formats should
someday collapse toward fewer distinct strings for the same byte count (today five formats exist
for historical reasons, not because five are needed). That is a product decision about response
shape, out of scope for a refactor phase that is contractually forbidden from changing any served
string.

## Alternatives considered

- **Adopt `pretty-bytes`, translate its output to NEMAR's spelling at each call site:** rejected
  — a dependency plus a string-rewriting shim is more code and more failure surface than the
  bespoke formatter it would replace, for zero behavioral gain.
- **Adopt `pretty-bytes` for the four non-contractual (CLI/HTML-only) formatters and keep
  `formatFileSize` bespoke:** rejected as inconsistent policy for no real gain — it still leaves
  a bespoke formatter in the codebase (so the audit's "six copies, one bug" complaint is not
  actually retired), while adding a dependency that reproduces none of the four remaining
  formats either (same IEC-label and decimal-policy mismatches apply to `formatBytesCompact` and
  `formatBytesDetailed` as to `formatFileSize`).
- **Leave the six copies as-is, only fix the decimal/1000 bug in place:** rejected — it repeats
  the license-parser mistake ADR 0037 names: a bug fixed once in six copies is a bug five more
  edits away from recurring. Consolidating into one module was already the more valuable half of
  the audit's finding.

## Receipts

- `.context/research-make-vs-take-audit.md`, candidate 2 (byte-size formatting), annotated with
  this verdict.
- Measured `pretty-bytes` 7.1.2 output cited above, from the phase 4 implementation brief on
  issue #1227 (epic #1225 phase 4): `prettyBytes(1536, {binary: true})` → `"1.5 KiB"`;
  `prettyBytes(24000000000, {binary: true})` → `"22.4 GiB"`; `prettyBytes(1536)` → `"1.54 kB"`.
- This PR: the formatter consolidation into `shared/bytes.ts`, the golden tests pinning all five
  surviving formats, and the `s3.ts` decimal formatter's deletion (`enrich-dataset.ts` switches
  its one call site to `formatFileSize`). The deleted decimal formatter's own output is NOT
  pinned by a test: nothing calls it any more, so there is no surface to pin it through. Its
  migrated call site is covered instead, by the `<sizes>` rows in `test/datacite.test.ts` --
  `formatFileSize` returns null where the deleted one returned a string, and that call site now
  omits the field rather than publishing a stringified null (#1225 review).
- ADR 0037 (make versus take is decided explicitly, in both directions) — this ADR is exactly the
  "keep" half that ADR 0037's Decision section says must be recorded with equal weight to a
  "replace" verdict.
- `backend/src/routes/datasets/catalog.ts`'s `deriveFileSizeFormatted` and the served
  `file_size_formatted` contract field (`shared/contract/dataset.ts`) — the concrete contract
  this decision protects.
