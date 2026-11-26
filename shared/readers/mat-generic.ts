/**
 * The MATLAB readers' shared layer (publication-queue plan, card A5), and the generic `.mat`
 * reader built on it.
 *
 * - {@link walkMatForReader} reads a MAT-file under the reader contract, whatever its version:
 *   Level 5 (`-v6`, `-v7`) through the MAT walker (`shared/mat-meta.ts`), and `-v7.3` through
 *   the HDF5 walker (`shared/hdf5-meta.ts`, with MATLAB character arrays read as text), its
 *   entries put in the same shape ({@link MatEntry}) so every MATLAB reader applies its rules
 *   once. A v7.3 file's shortfalls are the HDF5 readers' (`hdf5-incomplete.ts`).
 * - {@link scanMatText} is the free-text rules over one array: the HDF5 readers' rules
 *   (`scanEntryText`, card A4: identifier-key fields, person fields, home-directory paths and
 *   contact details, and the numeric identifier-key rule), under the MATLAB kinds. A rule
 *   matches on the array's own field name; a finding carries a fixed field word, never a name
 *   from the file.
 * - The generic reader (`mat`) puts every character array, and every small numeric array under
 *   an identifier-key name, through those rules.
 *
 * A file that is not a MAT-file at all (no Level 5 or v7.3 header, not a Level 4 file, and not
 * cut short inside a MATLAB header) is `not-applicable`. A Level 4 file is `partial`
 * (`unsupported-version`).
 */

import type { Hdf5Entry } from "../hdf5-meta";
import type {
  FormatReader,
  LimitExceeded,
  RangeSource,
  ReaderIncompleteReason,
  ReaderLimits,
  ReaderResult,
} from "../identifier-readers";
import {
  type Finding,
  type FindingKind,
  canonical,
  identifierKeySeverity,
} from "../identifier-scan";
import {
  MAT_HEADER_BYTES,
  MAT_LIMITS,
  type MatClass,
  type MatEntry,
  type MatFormat,
  type MatLimits,
  matFormat,
  walkMat,
} from "../mat-meta";
import { scanEntryText } from "./hdf5-generic";
import { WALK_TIME_SHARE, walkForReader } from "./hdf5-incomplete";
import { isLocationField } from "./person-fields";
import { FREE_TEXT_MAX_CHARS } from "./text-header";

/**
 * The limits of the MATLAB readers. An uncompressed file's large arrays are skipped unread, so
 * the bytes go to struct arrays (EEGLAB event tables run to several MiB); a compressed variable
 * is fetched and inflated as far as the walk needs, up to the 256 MiB inflation cap. The numbers
 * measured for card A5 are in `test/fixtures/mat/README.md`.
 */
export const MAT_READER_LIMITS: ReaderLimits = {
  maxBytes: 64 * 1024 * 1024,
  maxReads: 2000,
  maxInflatedBytes: MAT_LIMITS.maxInflatedBytes,
  timeMs: 180_000,
};

/** A reader's own time ran out while it walked: it keeps what it found, as `partial` (`time`). */
class WalkDeadline extends Error {
  constructor() {
    super("time");
    this.name = "WalkDeadline";
  }
}

/** The registry's refusal past a reader's limits, told by name (a runtime import would cycle). */
function isLimitError(e: unknown): e is LimitExceeded {
  return e instanceof Error && e.name === "LimitExceeded";
}

export interface MatReaderWalk {
  format: MatFormat;
  entries: MatEntry[];
  incomplete?: ReaderIncompleteReason;
}

/** Bytes at the start of a file that say it is a MATLAB file, cut short or not. */
const MATLAB_TEXT = "MATLAB";

/**
 * Read a MAT-file under the reader contract (`walkForReader`'s, for the Level 5 walker):
 *
 * - the source's refusal past the limits ends the walk with what it found (`limit`), and so does
 *   the reader's time share (`time`); any other source failure is rethrown, a failed read;
 * - a walk that read everything is still `partial` when text was listed without being read
 *   ({@link unscannedMat}).
 */
export async function walkMatForReader(
  src: RangeSource & { readonly limited?: boolean },
  limits: ReaderLimits,
  now: () => number = Date.now,
): Promise<MatReaderWalk> {
  const deadline = now() + limits.timeMs * WALK_TIME_SHARE;
  let thrown: unknown;
  const guarded: RangeSource = {
    get size() {
      return src.size;
    },
    async read(offset, length) {
      try {
        if (now() >= deadline) throw new WalkDeadline();
        return await src.read(offset, length);
      } catch (e) {
        thrown ??= e;
        throw e;
      }
    },
  };
  const head = await src.read(0, MAT_HEADER_BYTES);
  const format = matFormat(head);
  if (format === "v4") return { format, entries: [], incomplete: "unsupported-version" };
  if (format === "other") {
    const text = String.fromCharCode(...head.subarray(0, MATLAB_TEXT.length));
    // A MATLAB header cut short is a damaged MAT-file, not another format.
    return text === MATLAB_TEXT || head.length === 0
      ? { format, entries: [], incomplete: "corrupt" }
      : { format, entries: [] };
  }
  if (format === "v7.3") {
    const { walk, incomplete } = await walkForReader(src, limits, now, { matlabChars: true });
    const entries = fromHdf5(walk.entries);
    const reason = incomplete ?? unscannedMat(entries) ?? undefined;
    return reason === undefined ? { format, entries } : { format, entries, incomplete: reason };
  }
  const walkLimits: Partial<MatLimits> = { maxInflatedBytes: limits.maxInflatedBytes };
  const walk = await walkMat(guarded, { limits: walkLimits });
  if (thrown !== undefined) {
    if (isLimitError(thrown) && src.limited === true) {
      return { format, entries: walk.entries, incomplete: "limit" };
    }
    if (thrown instanceof WalkDeadline)
      return { format, entries: walk.entries, incomplete: "time" };
    throw thrown;
  }
  const reason = walk.incomplete ?? unscannedMat(walk.entries) ?? undefined;
  return reason === undefined
    ? { format, entries: walk.entries }
    : { format, entries: walk.entries, incomplete: reason };
}

/**
 * The text a walk listed and no rule read: a character array skipped for its size, a line of
 * text longer than the text rules read ({@link FREE_TEXT_MAX_CHARS}), or a numeric array under
 * an identifier-key name skipped for its size (`limit`); or an array of a class no rule reads
 * (`unsupported-datatype`). The first such array names the reason; null when there is none. A
 * skipped signal under any other name is not text, and does not count (A4's rule); nor does a
 * location field ({@link isLocationField}) or FieldTrip provenance ({@link isProvenance}),
 * which no rule reads.
 */
export function unscannedMat(entries: readonly MatEntry[]): ReaderIncompleteReason | null {
  for (const e of entries) {
    // A field no rule reads cannot leave text unread.
    if (isLocationField(leafName(e)) || isProvenance(e.fields)) continue;
    if (e.skipped === "type") return "unsupported-datatype";
    if (e.skipped === "size") {
      if (e.class === "char") return "limit";
      if (identifierKeySeverity(canonical(leafName(e))) !== null) return "limit";
    }
    if (e.class === "char" && linesOf(e).some((line) => line.length > FREE_TEXT_MAX_CHARS)) {
      return "limit";
    }
  }
  return null;
}

/** The name an array is known by: its struct field, or its variable's name. */
export function leafName(entry: MatEntry): string {
  return entry.fields[entry.fields.length - 1] ?? "";
}

/**
 * A character array's text, line by line: each row, split at line breaks (EEGLAB's `history`
 * is one row of commands, one per line). Trailing blanks of a padded row are dropped.
 */
export function linesOf(entry: MatEntry): string[] {
  if (entry.class !== "char" || !Array.isArray(entry.value)) return [];
  const out: string[] = [];
  for (const row of entry.value as unknown[]) {
    if (typeof row !== "string") continue;
    for (const line of row.split(/\r\n|\r|\n/)) out.push(line.replace(/[\s\0]+$/, ""));
  }
  return out;
}

/** A character array's text as one string, rows joined by spaces. */
export function textOf(entry: MatEntry): string {
  return linesOf(entry).join(" ").trim();
}

const MATLAB_CLASSES: Readonly<Record<string, MatClass>> = {
  cell: "cell",
  struct: "struct",
  char: "char",
  double: "double",
  single: "single",
  int8: "int8",
  uint8: "uint8",
  int16: "int16",
  uint16: "uint16",
  int32: "int32",
  uint32: "uint32",
  int64: "int64",
  uint64: "uint64",
  logical: "uint8",
  function_handle: "function",
};

/**
 * A v7.3 walk's entries as MATLAB arrays. Each dataset is one array, its class taken from its
 * `MATLAB_class` attribute; groups are structs and are not entries. Cell members and struct
 * array fields live under `/#refs#`, behind object references the HDF5 walker does not follow,
 * so they carry the field name `#refs#` alone: the free-text rules still read them, the rules
 * for a named EEGLAB field do not. Sparse, object and function-handle arrays are listed as
 * `skipped: "type"`, which makes the read `unsupported-datatype` ({@link unscannedMat}).
 */
export function fromHdf5(entries: readonly Hdf5Entry[]): MatEntry[] {
  const attrs = new Map<string, Map<string, Hdf5Entry["value"]>>();
  for (const e of entries) {
    if (e.kind !== "attribute") continue;
    const at = attrs.get(e.path) ?? new Map<string, Hdf5Entry["value"]>();
    at.set(e.name, e.value);
    attrs.set(e.path, at);
  }
  const out: MatEntry[] = [];
  for (const e of entries) {
    if (e.kind !== "dataset") continue;
    if (e.dtype === "reference") continue; // a cell or struct array: its members are listed
    const own = attrs.get(e.path);
    const named = own?.get("MATLAB_class");
    const matlab = typeof named === "string" ? named : null;
    const parts = e.path.split("/").filter((p) => p !== "");
    const fields = parts[0] === "#refs#" ? ["#refs#"] : parts;
    const dims = [...(e.shape ?? [])].reverse();
    // MATLAB's shared empty array, referenced by every empty cell member: nothing to read.
    if (matlab === "canonical empty") continue;
    const unsupported =
      own?.has("MATLAB_sparse") === true ||
      own?.has("MATLAB_object_decode") === true ||
      matlab === "function_handle" ||
      (matlab !== null && !(matlab in MATLAB_CLASSES));
    if (unsupported) {
      out.push({ fields, class: "opaque", dims, value: null, skipped: "type" });
      continue;
    }
    const cls: MatClass = matlab === null ? "double" : (MATLAB_CLASSES[matlab] as MatClass);
    if (own?.has("MATLAB_empty") === true) {
      out.push({ fields, class: cls, dims: [0, 0], value: [] });
      continue;
    }
    if (cls === "char") {
      if (e.skipped === "size") {
        out.push({ fields, class: cls, dims, value: null, skipped: "size" });
      } else if (Array.isArray(e.value) && e.value.every((v) => typeof v === "number")) {
        // Read under the numeric rule (its MATLAB_class was stored densely): the code units.
        const text = fromCodes(e.value as number[]);
        out.push({ fields, class: cls, dims, value: [text] });
      } else if (Array.isArray(e.value)) {
        out.push({ fields, class: cls, dims, value: e.value as string[] });
      } else if (typeof e.value === "string") {
        out.push({ fields, class: cls, dims, value: [e.value] });
      }
      continue;
    }
    if (e.skipped === "size") {
      out.push({ fields, class: cls, dims, value: null, skipped: "size" });
      continue;
    }
    const numbers = Array.isArray(e.value) && e.value.every((v) => typeof v === "number");
    out.push({ fields, class: cls, dims, value: numbers ? (e.value as number[]) : null });
  }
  return out;
}

/** FieldTrip's provenance structs: the version, call and toolbox records of a `cfg`. */
const PROVENANCE: ReadonlySet<string> = new Set(["version", "callinfo", "toolbox"]);

/**
 * Is this array FieldTrip provenance: under `cfg.version`, `cfg.callinfo` or `cfg.toolbox` at
 * any depth (lead ruling 7, card A5)? They record where FieldTrip and the analysis ran, as the
 * location fields record where a file was kept. `cfg.previous` is not skipped wholesale: it is
 * an earlier `cfg`, whose own provenance this same rule skips.
 */
export function isProvenance(fields: readonly string[]): boolean {
  return fields.some((f, i) => f === "cfg" && PROVENANCE.has(fields[i + 1] ?? ""));
}

/** Character codes as text, converted in slices so no call takes more arguments than it can. */
export function fromCodes(codes: readonly number[]): string {
  let out = "";
  for (let at = 0; at < codes.length; at += 8192) {
    out += String.fromCharCode(...codes.slice(at, at + 8192));
  }
  return out;
}

/** A field name no rule reads as an identifier key or a person's. */
const NEUTRAL_FIELD = "value";

/** The HDF5 free-text kinds, as their MATLAB twins. */
const MAT_KIND: Partial<Record<FindingKind, FindingKind>> = {
  "hdf5-freetext": "mat-freetext",
  "hdf5-freetext-name": "mat-freetext-name",
  "hdf5-identifier-field": "mat-identifier-field",
};

/**
 * The free-text rules over one array, under the field word `field` (a fixed word such as
 * `eeglab.comments` or `mat.variable`). Character arrays are read line by line
 * ({@link linesOf}); a numeric array is read only under an identifier-key name. With
 * `personFields` false the person-field rule does not apply (EEGLAB's copy of the BIDS sidecars).
 */
export function scanMatText(
  entry: MatEntry,
  field: string,
  options: { personFields?: boolean } = {},
): Finding[] {
  const leaf = leafName(entry);
  // A location field records where the researcher kept a file, and FieldTrip's provenance
  // where its code ran: neither is read (lead rulings).
  if (isLocationField(leaf) || isProvenance(entry.fields)) return [];
  // The name the rules see: the field's own, unless the person-field rule must not apply to it,
  // when a neutral one leaves the identifier-key, path and contact rules.
  const personRule = options.personFields !== false;
  const name = personRule || identifierKeySeverity(canonical(leaf)) !== null ? leaf : NEUTRAL_FIELD;
  let value: Hdf5Entry["value"];
  if (entry.class === "char") {
    const lines = linesOf(entry).filter((l) => l.trim() !== "");
    if (lines.length === 0) return [];
    value = lines;
  } else if (Array.isArray(entry.value) && entry.value.length > 0) {
    value = entry.value as number[];
  } else {
    return [];
  }
  const asHdf5: Hdf5Entry = {
    path: "",
    kind: "dataset",
    name,
    dtype: entry.class === "char" ? "string" : entry.class,
    shape: entry.dims,
    value,
  };
  return scanEntryText(asHdf5, field).map((f) => ({ ...f, kind: MAT_KIND[f.kind] ?? f.kind }));
}

/**
 * One finding per kind and field per file, the first of each standing for the rest, with the
 * count in `count` (lead ruling, card A5): a struct array of thousands of events cannot
 * multiply a finding.
 */
export function foldFindings(findings: readonly Finding[]): Finding[] {
  const byKey = new Map<string, Finding>();
  for (const f of findings) {
    const key = `${f.kind}\u0000${f.field}`;
    const held = byKey.get(key);
    if (held) held.count = (held.count ?? 1) + 1;
    else byKey.set(key, { ...f, count: 1 });
  }
  return [...byKey.values()];
}

/** Build a MATLAB reader's result from its findings and its walk, the findings folded. */
export function matResult(raw: Finding[], walk: MatReaderWalk): ReaderResult {
  if (walk.format === "other" && walk.incomplete === undefined) {
    return { findings: [], coverage: "not-applicable" };
  }
  const findings = foldFindings(raw);
  return walk.incomplete === undefined
    ? { findings, coverage: "complete" }
    : { findings, coverage: "partial", incomplete: walk.incomplete };
}

/** Every array of a generic `.mat` through the free-text rules. */
export function scanMatEntries(entries: readonly MatEntry[]): Finding[] {
  return entries.flatMap((e) => scanMatText(e, "mat.variable"));
}

export const MAT_GENERIC_READER: FormatReader = {
  id: "mat",
  extensions: [".mat"],
  limits: MAT_READER_LIMITS,
  version: "1",
  async scan(src, _path, limits) {
    const walk = await walkMatForReader(src, limits);
    return matResult(scanMatEntries(walk.entries), walk);
  },
};
