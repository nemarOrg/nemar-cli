/**
 * CLI-side facet flag registration and parsing (epic #1144 phase 4, #1148).
 *
 * `shared/facets.ts` is the single declared vocabulary of 20 filterable
 * columns (key, CLI flag, wire query param, value kind, enum members). This
 * module is the other half: it walks that table to register one Commander
 * option per facet on whatever command it's given (`addFacetOptions`, D1),
 * and turns the resulting parsed CLI options back into wire-ready query
 * parameters (`buildFacetParams`) -- validating every range and enum value
 * before the caller makes any network call (D3).
 *
 * Range facets (number/bytes/duration) go through `shared/range.ts`'s
 * `parseRange`, the same grammar the backend re-parses server-side; the
 * parsed bounds are re-serialised to a canonical, unit-free `min..max`
 * string for the wire (D3). Client-side parsing is a fast local rejection,
 * not a substitute for the backend's own (still-authoritative) validation.
 *
 * Enum facets (`--source openneuro,nemar`) keep Phase 3's comma-separated OR
 * semantics, which Commander's `.choices()` cannot express -- it validates a
 * single value against a single list, and these take a list (D2). Tokens are
 * validated by hand against `enumValues` instead, naming the bad token and
 * the valid set, mirroring the shape of the backend's own
 * `FacetEnumParseError` (dataset-facets.ts) but raised client-side.
 *
 * Per `src/lib/cli-output.ts`'s header comment, lib code does not call
 * `process.exit` -- that stays owned by the command action in
 * `src/commands/dataset.ts`, which catches what this module throws.
 */

import { Option } from "commander";
import type { Command } from "commander";
import { FACETS, type FacetDefinition } from "../../shared/facets.js";
import { type RangeValueKind, parseRange } from "../../shared/range.js";

/** Accepted range grammar, echoed on every rejection so the fix is visible
 *  without a trip to the docs. Mirrors shared/range.ts's own forms. */
export const RANGE_FORMS_HELP =
  "Accepted forms: a..b (between), a.. (at least), ..b (at most), or a bare number (exact).";

/** Thrown by {@link buildFacetParams} when a comma-separated enum facet gets
 *  a token outside its declared vocabulary. Client-side counterpart of the
 *  backend's `FacetEnumParseError` -- same shape of mistake, caught before
 *  any request is made instead of after a 400 round trip. */
export class FacetEnumCliError extends Error {
  constructor(
    readonly facet: FacetDefinition,
    readonly badTokens: readonly string[],
  ) {
    super(
      `Invalid value${badTokens.length > 1 ? "s" : ""} for ${facet.flag}: ` +
        `${badTokens.map((t) => `"${t}"`).join(", ")} -- must be one of: ${(facet.enumValues ?? []).join(", ")}`,
    );
    this.name = "FacetEnumCliError";
  }
}

/** The Commander value-placeholder for a facet's flag -- purely descriptive
 *  (shown in `--help`); Commander does no type coercion from it. */
function placeholderFor(facet: FacetDefinition): string {
  switch (facet.valueKind) {
    case "enum":
      return "<values>";
    case "text":
      return "<text>";
    case "version":
      return "<version>";
    default:
      return "<range>";
  }
}

function describeFacet(facet: FacetDefinition): string {
  const unit = facet.unit ? ` (${facet.unit})` : "";
  switch (facet.valueKind) {
    case "enum":
      return `${facet.label} -- comma-separated, one or more of: ${(facet.enumValues ?? []).join(", ")}`;
    case "number":
      return `${facet.label}${unit} -- range (e.g. 10..50, 10.., ..50, or 10)`;
    // Byte and duration facets accept unit suffixes (shared/range.ts), and the
    // bare form means the base unit -- bytes and seconds. Showing only
    // `10..50` here nudged users toward typing raw byte and second counts for
    // --size and --duration, which is the difference between `--duration 100h`
    // and `--duration 360000` (#1169 review).
    case "bytes":
      return `${facet.label}${unit} -- range with optional units (e.g. 10gb..2tb, 500mb.., ..1gb; bare = bytes)`;
    case "duration":
      return `${facet.label}${unit} -- range with optional units (e.g. 30m..2h, 100h.., ..90s; bare = seconds)`;
    case "text":
      return `${facet.label} -- substring match`;
    case "version":
      return `${facet.label} -- exact or prefix match`;
  }
}

/**
 * Register one Commander option per declared facet on `cmd` (D1). `list` and
 * `search` both call this so the two commands cannot drift on which of the
 * 20 facets they accept -- `test/facet-cli-correspondence.unit.test.ts`
 * introspects the real `Option` objects on both to enforce it.
 */
export function addFacetOptions<T extends Command>(cmd: T): T {
  for (const facet of FACETS) {
    cmd.addOption(new Option(`${facet.flag} ${placeholderFor(facet)}`, describeFacet(facet)));
  }
  return cmd;
}

/** The exact camelCase property Commander stores a facet's value under,
 *  computed the same way Commander itself does it (`Option#attributeName`,
 *  the same method `cmd.opts()` uses internally) so this can never drift
 *  from what the parsed options object actually contains. */
function optionKey(facet: FacetDefinition): string {
  return new Option(facet.flag).attributeName();
}

/** Re-serialise parsed bounds to the canonical, unit-free wire form (D3): an
 *  exact value collapses to a bare number, an open side stays empty rather
 *  than becoming `0` (the same trap `shared/range.ts` guards against on the
 *  parse side). */
function serializeBounds(min: number | null, max: number | null): string {
  if (min !== null && max !== null && min === max) return String(min);
  return `${min ?? ""}..${max ?? ""}`;
}

/** One facet's parsed CLI value, re-serialised to its wire form. Throws
 *  {@link RangeParseError} (shared/range.ts) or {@link FacetEnumCliError} on
 *  an invalid value. */
function wireValueFor(facet: FacetDefinition, raw: string): string {
  switch (facet.valueKind) {
    case "number":
    case "bytes":
    case "duration": {
      const bounds = parseRange(raw, facet.valueKind as RangeValueKind);
      return serializeBounds(bounds.min, bounds.max);
    }
    case "enum": {
      const allowed = new Set(facet.enumValues ?? []);
      const tokens = raw
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t !== "");
      const badTokens = [...new Set(tokens.filter((t) => !allowed.has(t)))];
      if (badTokens.length > 0) throw new FacetEnumCliError(facet, badTokens);
      return tokens.join(",");
    }
    case "text":
    case "version":
      return raw;
  }
}

/**
 * Turn a command's parsed options (`cmd.opts()`) into the facet query
 * params to send on the wire, e.g. `{ subjects: "10..50", source:
 * "openneuro" }`. Only facets the user actually set are included. Every
 * range and enum value is validated here, client-side, before the caller
 * does anything network-bound (D3) -- a typo like `--subjects 100xyz` costs
 * a local rejection, not a round trip. Throws {@link RangeParseError} or
 * {@link FacetEnumCliError} on the first invalid value; the caller (the
 * command action, which owns `process.exit`) is expected to catch either.
 */
export function buildFacetParams(options: Record<string, unknown>): Record<string, string> {
  const params: Record<string, string> = {};
  for (const facet of FACETS) {
    const raw = options[optionKey(facet)];
    if (raw === undefined || raw === null || raw === "") continue;
    params[facet.queryParam] = wireValueFor(facet, String(raw));
  }
  return params;
}

/**
 * The stderr note for `excluded_unknown` / `excluded_unknown_by_facet` (D5,
 * revised in epic #1144 phase 4, #1148). Phase 3 deferred per-facet
 * attribution on the premise that it needed one query per facet -- that was
 * wrong, the backend computes the breakdown in the SAME widened-count query
 * via conditional aggregation (`buildExcludedUnknownBreakdownSql`), and the
 * vague "a filtered field is unknown" fallback for two-or-more facets it
 * forced is gone: every facet that excluded at least one row is now named,
 * with its own count, in `shared/facets.ts`'s declared table order. A single
 * active facet degrades naturally to one entry.
 *
 * The breakdown is informational, not a partition of the total -- a dataset
 * unknown in two active facets adds 1 to the total and 1 to EACH of its two
 * buckets, so the buckets can sum to more than `excludedUnknown` -- and the
 * second line says so explicitly rather than leaving a reader to assume the
 * numbers add up.
 */
export function formatExcludedUnknownNote(
  excludedUnknown: number,
  byFacet: Record<string, number>,
): string {
  const breakdown = FACETS.filter((f) => (byFacet[f.key] ?? 0) > 0)
    .map((f) => `${f.key} ${byFacet[f.key]}`)
    .join(", ");
  return `note: ${excludedUnknown} datasets excluded for unknown values - ${breakdown}\n      (a dataset can be unknown in more than one field; --include-unknown keeps them)`;
}
