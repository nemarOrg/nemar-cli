/**
 * Range-filter grammar shared by the CLI and the backend (epic #1144 phase 3,
 * issue #1147). `a..b` between, `a..` at least, `..b` at most, bare `a` exact.
 * `..` rather than `>`/`<`, because `--subjects >100` is a shell redirect into
 * a file named `100` -- none of these forms need quoting.
 *
 * Zero dependencies, so both `src/` (CLI flag parsing, phase 4) and
 * `backend/` (SQL clause binding) import the SAME parser and cannot disagree
 * about what `100..300` means.
 *
 * THE TRAP this file exists to avoid: `Number.parseFloat("100xyz")` returns
 * `100` (silently accepting garbage), and `Number("")` returns `0` (silently
 * turning "unbounded" into "zero"). Every numeric token here is instead
 * matched against an anchored grammar first, and only the captured digits
 * are ever handed to `Number()`.
 */

/** The unit family a facet's numeric value is denominated in. `number` takes
 *  no unit at all -- a unit suffix on a plain-number facet is a rejection, not
 *  a no-op, so `--subjects 100xyz` fails loudly instead of parsing as `100`. */
export type RangeValueKind = "number" | "bytes" | "duration";

export interface RangeBounds {
  /** Inclusive lower bound, or null when the range is open-ended below (`..b`). */
  min: number | null;
  /** Inclusive upper bound, or null when the range is open-ended above (`a..`). */
  max: number | null;
}

/** Every rejection carries one of these reasons plus a human-readable message,
 *  so a test can assert on WHY a range was rejected, not just that it was. */
export type RangeParseErrorReason =
  | "non-numeric"
  | "non-finite"
  | "negative"
  | "inverted"
  | "unknown-unit"
  | "unit-not-allowed"
  | "malformed";

export class RangeParseError extends Error {
  readonly reason: RangeParseErrorReason;

  constructor(reason: RangeParseErrorReason, message: string) {
    super(message);
    this.name = "RangeParseError";
    this.reason = reason;
  }
}

/** 1024-based, per the issue's `1.5TB` example. Bare (no suffix) means bytes. */
const BYTES_UNITS: Record<string, number> = {
  "": 1,
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
};

/** Bare (no suffix) means seconds. */
const DURATION_UNITS: Record<string, number> = {
  "": 1,
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

/** A plain-number facet accepts only the empty (no-suffix) unit. */
const NUMBER_UNITS: Record<string, number> = { "": 1 };

function unitTableFor(kind: RangeValueKind): Record<string, number> {
  switch (kind) {
    case "bytes":
      return BYTES_UNITS;
    case "duration":
      return DURATION_UNITS;
    case "number":
      return NUMBER_UNITS;
  }
}

/**
 * Anchored grammar: an optional sign, digits, an optional decimal fraction
 * (required for `1.5TB` / `age_min`'s `26.25`), then a unit made of letters
 * only. The sign is captured (not rejected outright) so a negative bound gets
 * its own "negative" error rather than being lumped in with "non-numeric" --
 * `-5..10` and `abc` fail for different, distinctly-reported reasons.
 * Anchored both ends: `1e3` cannot sneak through as "1" + unit "e3", because
 * "3" is not in `[a-z]` and the trailing `$` refuses a partial match.
 */
const BOUND_GRAMMAR = /^(-?\d+(?:\.\d+)?)([a-z]*)$/i;

/** Parse one side of a range (or a bare exact value) for a facet of the given
 *  value kind. Throws {@link RangeParseError} for every invalid form. */
function parseBound(token: string, kind: RangeValueKind): number {
  const match = BOUND_GRAMMAR.exec(token);
  if (!match) {
    throw new RangeParseError("non-numeric", `"${token}" is not a valid number`);
  }
  const [, digits, unitRaw] = match;
  const unit = unitRaw.toLowerCase();
  const value = Number(digits);
  if (!Number.isFinite(value)) {
    throw new RangeParseError("non-finite", `"${token}" is not a finite number`);
  }
  if (value < 0) {
    throw new RangeParseError("negative", `"${token}" must not be negative`);
  }
  if (unit !== "" && kind === "number") {
    throw new RangeParseError(
      "unit-not-allowed",
      `"${token}" has a unit, but this facet takes a plain number`,
    );
  }
  const table = unitTableFor(kind);
  const multiplier = table[unit];
  if (multiplier === undefined) {
    throw new RangeParseError("unknown-unit", `"${unit}" is not a recognized ${kind} unit`);
  }
  return value * multiplier;
}

/**
 * Parse a range expression: `a..b`, `a..`, `..b`, or a bare `a` (exact).
 * Splitting is done on the LITERAL substring `..`, so:
 *  - `1..2..3` has 3 parts, not 2, and is rejected (`malformed`), not
 *    silently truncated to its first two parts.
 *  - bare `..` splits into `["", ""]` -- both sides empty is rejected
 *    (`malformed`), not treated as "unbounded on both ends" (that isn't a
 *    filter at all).
 *  - `..b` / `a..` split into one empty side, which means unbounded on that
 *    side -- NOT zero. This is the other half of the `Number("")` trap: an
 *    empty side is parsed as `null`, never handed to `Number()`.
 */
export function parseRange(raw: string, kind: RangeValueKind): RangeBounds {
  const trimmed = raw.trim();
  if (trimmed.includes("..")) {
    const parts = trimmed.split("..");
    if (parts.length !== 2) {
      throw new RangeParseError("malformed", `"${raw}" must contain at most one ".." separator`);
    }
    const [loRaw, hiRaw] = parts;
    const lo = loRaw.trim();
    const hi = hiRaw.trim();
    if (lo === "" && hi === "") {
      throw new RangeParseError("malformed", `"${raw}" does not specify either bound`);
    }
    const min = lo === "" ? null : parseBound(lo, kind);
    const max = hi === "" ? null : parseBound(hi, kind);
    if (min !== null && max !== null && min > max) {
      throw new RangeParseError("inverted", `"${raw}" is inverted: ${min} is greater than ${max}`);
    }
    return { min, max };
  }
  const exact = parseBound(trimmed, kind);
  return { min: exact, max: exact };
}
