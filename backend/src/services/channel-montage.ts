/**
 * Channel-count + electrode-system classification for the catalog (#854 phase 2,
 * #858). Pure helpers: parse a BIDS `*_channels.tsv` / `*_eeg.json` exemplar and
 * derive the two catalog columns added in migration 0054 (`n_channels`,
 * `electrode_system`). The enrichment path (getBidsTreeStats) samples one
 * exemplar EEG recording and feeds the content here; everything in this module
 * is I/O-free and unit-tested with real-shape inputs.
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

  const hasABank = up.some((l) => /^A\d{1,2}$/.test(l));
  if (hasABank && up.filter((l) => /^[A-H]\d{1,2}$/.test(l)).length >= 3) return "biosemi";

  const eCount = up.filter((l) => /^E\d{1,3}$/.test(l)).length;
  if (eCount >= 3 && !hasABank) return "egi-geodesic";

  const standard = up.map(norm).filter((l) => STD_1005.has(l));
  if (standard.length < Math.max(3, up.length * 0.5)) return "other";
  if (standard.some((l) => !STD_1020.has(l))) return "10-05";
  if (standard.some((l) => !CLASSIC_1020.has(l))) return "10-10";
  return "10-20";
}
