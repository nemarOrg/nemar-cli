/**
 * The `modality` filter's contract in numbers (#1711), declared once so the
 * backend that enforces it and the surfaces that describe it cannot disagree.
 *
 * The matching itself is SQL and lives in
 * `backend/src/services/dataset-filters.ts`; ADR 0032 (amendment 2026-10-12)
 * records why it is a whole-token match.
 *
 * Zero dependencies, so `src/`, `scripts/` and `backend/` all import it.
 */

/**
 * The most distinct modality tokens one request may name. A request with more
 * is REFUSED, not truncated: a filter that quietly dropped its tail would
 * return a confident-looking list for a question nobody asked.
 *
 * Why a number at all: the value travels in a URL an anonymous caller controls,
 * and the match costs something per wanted token for every row it tests. BIDS
 * defines 14 datatypes and the production vocabulary holds 12, so 32 is wider
 * than any real request.
 */
export const MAX_MODALITY_FILTER_TOKENS = 32;
