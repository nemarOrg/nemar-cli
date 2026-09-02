/**
 * Channel-count + electrode-system classification for the catalog (#854 phase 2,
 * #858), widened in epic #1144 Phase 2b (#1153) with four more `*_eeg.json`
 * sidecar parsers backing neuroschema's `signal_defaults` block. Pure
 * helpers: parse a BIDS `*_channels.tsv` / `*_eeg.json` exemplar and derive
 * the catalog columns added in migration 0054 (`n_channels`,
 * `electrode_system`) and migration 0072 (`sampling_frequency`,
 * `power_line_frequency`, `eeg_reference`, `placement_scheme`). The
 * enrichment path (getBidsTreeStats) samples one exemplar EEG recording and
 * feeds the content here; everything in this module is I/O-free and
 * unit-tested with real-shape inputs.
 */

import { STANDARD_1005_NAMES, STANDARD_1020_NAMES } from "./montage-label-sets.js";

export type ElectrodeSystem = "10-20" | "10-10" | "10-05" | "biosemi" | "egi-geodesic" | "other";

/** Legacy 10-20 names -> their modern 10-10 equivalents (kept in sync with the
 *  website viewer's standard-montage aliases). */
const ALIAS = new Map<string, string>([
  ["T3", "T7"],
  ["T4", "T8"],
  ["T5", "P7"],
  ["T6", "P8"],
]);

/** Classic ~10-20 scalp labels (UPPERCASE, modern spelling) + common refs. A
 *  cap using only these reads as 10-20; intermediate labels bump it to 10-10. */
const CLASSIC_1020 = new Set<string>([
  "FP1",
  "FP2",
  "FPZ",
  "F7",
  "F3",
  "FZ",
  "F4",
  "F8",
  "T7",
  "C3",
  "CZ",
  "C4",
  "T8",
  "P7",
  "P3",
  "PZ",
  "P4",
  "P8",
  "O1",
  "OZ",
  "O2",
  "A1",
  "A2",
  "M1",
  "M2",
]);

const STD_1020 = new Set<string>(STANDARD_1020_NAMES); // 10-10 superset (94)
const STD_1005 = new Set<string>(STANDARD_1005_NAMES); // 10-05, finest (343)

function norm(label: string): string {
  const up = label.trim().toUpperCase();
  return ALIAS.get(up) ?? up;
}

export interface ChannelsTsv {
  /** Total data rows. */
  count: number;
  /** Rows whose `type` is EEG (all rows when there is no `type` column). */
  eegCount: number;
  /** Values of the `name` column, original spelling. */
  labels: string[];
}

/**
 * Parse a BIDS `*_channels.tsv`. Returns null when the content has no header +
 * data or no `name` column (e.g. a git-annex pointer slipped through).
 */
export function parseChannelsTsv(content: string): ChannelsTsv | null {
  const lines = content.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return null;
  const header = lines[0].split("\t").map((h) => h.trim().toLowerCase());
  const nameIdx = header.indexOf("name");
  const typeIdx = header.indexOf("type");
  if (nameIdx === -1) return null;

  const labels: string[] = [];
  let eegCount = 0;
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split("\t");
    const name = (cols[nameIdx] ?? "").trim();
    if (!name) continue;
    labels.push(name);
    if (typeIdx === -1) eegCount++;
    else if ((cols[typeIdx] ?? "").trim().toUpperCase() === "EEG") eegCount++;
  }
  if (labels.length === 0) return null;
  return { count: labels.length, eegCount, labels };
}

/** Read `EEGChannelCount` from a `*_eeg.json` sidecar; null if absent/invalid. */
export function parseEegChannelCount(content: string): number | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
  const v = obj.EEGChannelCount;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Read `SamplingFrequency` (Hz) from a `*_eeg.json` sidecar for
 * `signal_defaults.sampling_frequency` (epic #1144 Phase 2b, #1153). Null on
 * absent/invalid JSON, a non-number, a non-finite value, or <= 0 -- same
 * shape as parseEegChannelCount, deliberately not merged with it: the file's
 * contract is "parse one key, return null on anything invalid" per parser,
 * not one do-everything sidecar reader.
 */
export function parseSamplingFrequency(content: string): number | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
  const v = obj.SamplingFrequency;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Read `PowerLineFrequency` (Hz) from a `*_eeg.json` sidecar for
 * `signal_defaults.power_line_frequency` (epic #1144 Phase 2b, #1153).
 *
 * neuroschema's `inheritable.schema.json` declares this field an ENUM --
 * `[50, 60, null]` -- not a free number. A sidecar can legitimately carry
 * `0`/`"n/a"` (power line filtering not applicable/unknown), a measured
 * value like `59.94`, or a string; every one of those is OUT OF ENUM and
 * must be dropped to null, never clamped or rounded to the nearest of
 * 50/60. Rounding would fabricate a fact ("this dataset was recorded on
 * 60Hz mains") the sidecar never asserted. Nothing runs AJV on the live
 * serving path, so this coercion IS the enforcement.
 */
export function parsePowerLineFrequency(content: string): number | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
  const v = obj.PowerLineFrequency;
  return v === 50 || v === 60 ? v : null;
}

/**
 * Read `RecordingDuration` (seconds) from a `*_eeg.json`/`*_ieeg.json`/
 * `*_meg.json`/`*_emg.json` sidecar for the zarr fidelity sweep (issue
 * #1068, epic #1181 phase 8) -- ground truth for `duration_mismatch`.
 * Same shape as parseSamplingFrequency: null on absent/invalid JSON, a
 * non-number, a non-finite value, or <= 0 (a recording cannot have zero or
 * negative duration).
 */
export function parseRecordingDuration(content: string): number | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
  const v = obj.RecordingDuration;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Reject BIDS's "not applicable" placeholder and blank strings. Shared by
 * the two free-text sidecar parsers below; not exported -- an external
 * caller with a genuinely different placeholder convention should not
 * silently inherit this one.
 */
function nonPlaceholderString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === "n/a") return null;
  return trimmed;
}

/**
 * Read `EEGReference` from a `*_eeg.json` sidecar for
 * `signal_defaults.reference` (epic #1144 Phase 2b, #1153). Only a string
 * value is accepted -- `inheritable.schema.json` types `reference` as
 * string|null, so an array-of-channel-names reference (a shape some BIDS
 * sidecars use) is out of contract and dropped to null rather than joined
 * or coerced.
 */
export function parseEegReference(content: string): string | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
  return nonPlaceholderString(obj.EEGReference);
}

/**
 * Read `EEGPlacementScheme` from a `*_eeg.json` sidecar for
 * `signal_defaults.placement_scheme` (epic #1144 Phase 2b, #1153).
 */
export function parsePlacementScheme(content: string): string | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
  return nonPlaceholderString(obj.EEGPlacementScheme);
}

/**
 * Representative EEG channel count. The measured `channels.tsv` count is
 * authoritative -- a real file can carry channels the sidecar omits, so it wins
 * on disagreement. The `*_eeg.json` `EEGChannelCount` is the fallback when no
 * `channels.tsv` is available; null when neither is.
 */
export function resolveNChannels(sidecar: number | null, tsv: ChannelsTsv | null): number | null {
  if (tsv) return tsv.eegCount > 0 ? tsv.eegCount : tsv.count;
  return sidecar;
}

/**
 * Classify the scalp montage system from EEG channel labels, or null when there
 * are too few labels to decide. Detection order: BioSemi (A-bank, banks A..H)
 * and EGI geodesic (pure `E\d+`, no A-bank) are checked first since their labels
 * collide with the standard set; otherwise the finest standard tier present
 * wins (a fine/half-distance label => 10-05, an intermediate => 10-10, else
 * classic 10-20), and a label set that barely overlaps the standard system is
 * `other`.
 */
export function classifyElectrodeSystem(labels: string[]): ElectrodeSystem | null {
  const up = labels.map((l) => l.trim().toUpperCase()).filter(Boolean);
  if (up.length < 3) return null;

  // A real BioSemi cap is almost entirely bank-labeled (A1..H32). A standard
  // 10-20/10-10 montage only has a few incidental [A-H]-letter labels (F3, F4,
  // C3, C4) plus maybe A1/A2 ear refs, so require the bank labels to DOMINATE,
  // not merely appear -- otherwise a plain 10-20 with an A2 ref classifies as
  // BioSemi (the nm000109 bug).
  const hasABank = up.some((l) => /^A\d{1,2}$/.test(l));
  const bankCount = up.filter((l) => /^[A-H]\d{1,2}$/.test(l)).length;
  if (hasABank && bankCount >= 3 && bankCount >= up.length * 0.6) return "biosemi";

  const eCount = up.filter((l) => /^E\d{1,3}$/.test(l)).length;
  if (eCount >= 3 && !hasABank) return "egi-geodesic";

  const standard = up.map(norm).filter((l) => STD_1005.has(l));
  if (standard.length < Math.max(3, up.length * 0.5)) return "other";
  if (standard.some((l) => !STD_1020.has(l))) return "10-05";
  if (standard.some((l) => !CLASSIC_1020.has(l))) return "10-10";
  return "10-20";
}
