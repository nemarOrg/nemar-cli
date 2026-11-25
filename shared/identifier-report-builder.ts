/**
 * The identifier screen's report, built once for every surface: the publication screen's
 * workflow, the uploader preflight, the fleet scan and local reproduction (A9) all read their
 * recordings and reach their verdict here.
 *
 * {@link readRecordings} reads each recording through the reader the registry names for it, from
 * a {@link RangeSource} the caller opens (a git blob, an S3 object, a local file, a buffer), under
 * that reader's limits. Every file ends one of four ways and is counted so: read completely, read
 * only partly (with a reason), failed, or not read at all (sampled out). {@link classifyDataset}
 * turns the counts into the verdict, and {@link coverageFields} into the report's version-2
 * fields. A thrown error is a failed read, never a clean one; a limit or a timer is a partial
 * read, never a clean one (ADR 0053: unknown is never healthy).
 *
 * Pure of I/O: the caller supplies the sources, the clock and the failure classes.
 */

import {
  type FormatReader,
  LimitExceeded,
  READERS,
  type RangeSource,
  type ReaderId,
  cachedSource,
  companionsOf,
  readerFor,
} from "./identifier-readers";
import {
  DATE_KINDS,
  DIRECT_KINDS,
  EDF_HEADER_BYTES,
  type Finding,
  type FindingKind,
  edfIdentificationText,
} from "./identifier-scan";
import type { DatasetStatus, IncompleteReason, ReaderTally } from "./identifier-screen-report";

// ---------------------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------------------

/** An identifier-severity finding of a kind that names a person or a clinical record. */
export const isDirectFinding = (f: Finding): boolean =>
  f.severity === "identifier" && DIRECT_KINDS.has(f.kind);

/**
 * A calendar date finer than year in a header. Acceptable when nothing links the recording to a
 * person (policy 2026-10-04), so it is reported but never changes whether a dataset is clean.
 */
export const isDateFinding = (f: Finding): boolean => DATE_KINDS.has(f.kind);

export interface ClassifyInput {
  findings: readonly Finding[];
  /** Recording files a registered reader parses, whether or not they were all read. */
  recordings: number;
  /** Recording files read completely. */
  recordingsRead: number;
  /** Recording files in formats no registered reader parses. */
  unscreenedCount: number;
  /** Reasons the scan did not cover everything it could have. */
  incompleteReasons: readonly string[];
}

/**
 * Complete means every recording a reader parses was read completely, every side read succeeded
 * and no sampling cap was hit. It is computed from counts, never inferred from the absence of a
 * recorded failure.
 */
export function isComplete(input: ClassifyInput): boolean {
  return input.recordingsRead === input.recordings && input.incompleteReasons.length === 0;
}

/**
 * The dataset's verdict. A finding already made is never hidden by incompleteness; only a
 * dataset with no finding can be `unchecked`, and `clean` needs a complete read of every
 * recording AND no recording in a format no reader parses.
 */
export function classifyDataset(input: ClassifyInput): DatasetStatus {
  if (input.findings.some(isDirectFinding)) return "direct-identifiers";
  // Any finding that is not just an acceptable date needs a person to look.
  if (input.findings.some((f) => !isDateFinding(f))) return "review";
  if (!isComplete(input)) return "unchecked";
  if (input.recordings > 0 && input.unscreenedCount > 0) return "partially-screened";
  if (input.recordings === 0) return input.unscreenedCount > 0 ? "not-screened" : "no-recordings";
  // Complete, every recording read: clean, noting acceptable dates when there are any.
  return input.findings.length > 0 ? "dates-only" : "clean";
}

// ---------------------------------------------------------------------------------------
// Reading the recordings
// ---------------------------------------------------------------------------------------

/** The subject a path belongs to, for sampling and the distinct-subject count. */
export const subjectOf = (path: string): string => /sub-([^/_]+)/.exec(path)?.[1] ?? "?";

/** What {@link readRecordings} needs to know about one entry. */
export interface RecordingEntry {
  path: string;
  size: number | null;
  /** The reader the storage key names (an annex key's extension), when it says one. */
  reader?: ReaderId;
  /** The storage key says EDF/BDF (kept for entries written before `reader`). */
  edf?: boolean;
}

/**
 * The reader for an entry: the one its storage key names, else the one its path names. Only a
 * registered reader counts.
 */
export function readerForEntry(
  entry: RecordingEntry,
  readers: readonly FormatReader[] = READERS,
): FormatReader | null {
  const byKey = entry.reader ?? (entry.edf === true ? "edf" : undefined);
  const keyed = byKey ? readers.find((r) => r.id === byKey) : undefined;
  return keyed ?? readerFor(entry.path, readers);
}

export interface RecordingReadOptions<E extends RecordingEntry> {
  /** The tree's entries; only those a reader parses are read. */
  entries: readonly E[];
  /** Recordings an earlier commit held that the tree no longer does (ADR 0086). */
  superseded?: readonly E[];
  /** Every path the scan sees, for companion pairing. Defaults to the entries' paths. */
  paths?: readonly string[];
  readers?: readonly FormatReader[];
  /** Opens the bytes of an entry. Reads may throw; a throw is a failed read of that file. */
  open: (entry: E) => RangeSource;
  concurrency: number;
  now: () => number;
  /** Past this, every file not yet started is `partial` with reason `time`. */
  datasetTimeMs: number;
  /** The fixed class of a failed read, for `read_failures`. */
  failureClass: (error: unknown) => string;
  /** An error that ends the whole scan rather than one read (a tripped breaker). */
  isFatal?: (error: unknown) => boolean;
  /** A superseded recording whose object is gone: not counted, and not a failure. */
  isAbsent?: (error: unknown) => boolean;
  /** Which of a reader's files to read; the rest stay unread (counted). Default: all. */
  select?: (reader: FormatReader, entries: readonly E[]) => E[];
}

export interface RecordingsOutcome {
  findings: Finding[];
  /** Per reader: files (absent superseded ones excluded), and how each read ended. */
  tallies: Partial<Record<ReaderId, ReaderTally>>;
  /** Per reader: files selected for reading. */
  selected: Partial<Record<ReaderId, number>>;
  failures: Record<string, number>;
  reasons: Set<IncompleteReason>;
  companionMissing: number;
  /** EDF/BDF only: the statistics the fleet scan has always kept. */
  edf: {
    flaggedFiles: number;
    flaggedKinds: Partial<Record<FindingKind, number>>;
    patientValues: Set<string>;
    flaggedPatientValues: Set<string>;
    codeValues: Set<string>;
    nameValues: Set<string>;
    birthValues: Set<string>;
    subjects: Set<string>;
  };
}

/** A read ran out of its reader's time. */
class ReadTimedOut extends Error {
  constructor() {
    super("time");
    this.name = "ReadTimedOut";
  }
}

function withTimer<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ReadTimedOut()), ms);
  });
  // A read still running when its time is up is abandoned: its result is never committed.
  work.catch(() => undefined);
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Run `fn` over `items`, at most `size` at once; every worker finishes before a throw is rethrown. */
async function pool<T>(items: readonly T[], size: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, size), items.length) }, async () => {
    while (next < items.length) await fn(items[next++] as T);
  });
  const settled = await Promise.allSettled(workers);
  const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
}

/**
 * Read every recording a registered reader parses, and count how each read ended. Findings of a
 * partial read are kept: a finding already made is never hidden.
 */
export async function readRecordings<E extends RecordingEntry>(
  options: RecordingReadOptions<E>,
): Promise<RecordingsOutcome> {
  const readers = options.readers ?? READERS;
  const superseded = new Set<E>(options.superseded ?? []);
  const all = [...options.entries, ...superseded];
  const { missing } = companionsOf(options.paths ?? options.entries.map((e) => e.path), readers);

  const out: RecordingsOutcome = {
    findings: [],
    tallies: {},
    selected: {},
    failures: {},
    reasons: new Set(),
    companionMissing: 0,
    edf: {
      flaggedFiles: 0,
      flaggedKinds: {},
      patientValues: new Set(),
      flaggedPatientValues: new Set(),
      codeValues: new Set(),
      nameValues: new Set(),
      birthValues: new Set(),
      subjects: new Set(),
    },
  };
  const byReader = new Map<FormatReader, E[]>();
  for (const entry of all) {
    const reader = readerForEntry(entry, readers);
    if (!reader) continue;
    byReader.set(reader, [...(byReader.get(reader) ?? []), entry]);
  }
  const work: { entry: E; reader: FormatReader }[] = [];
  for (const [reader, entries] of byReader) {
    const chosen = options.select ? options.select(reader, entries) : entries;
    out.tallies[reader.id] = { files: entries.length, read: 0, partial: 0, failed: 0 };
    out.selected[reader.id] = chosen.length;
    for (const entry of chosen) work.push({ entry, reader });
  }
  const tally = (id: ReaderId) => out.tallies[id] as ReaderTally;
  const fail = (key: string) => {
    out.failures[key] = (out.failures[key] ?? 0) + 1;
  };
  const started = options.now();

  await pool(work, options.concurrency, async ({ entry, reader }) => {
    const t = tally(reader.id);
    if (options.now() - started >= options.datasetTimeMs) {
      t.partial++;
      out.reasons.add("time");
      return;
    }
    const lacking = superseded.has(entry) ? 0 : (missing.get(entry.path) ?? 0);
    let source: ReturnType<typeof cachedSource>;
    let result: Awaited<ReturnType<FormatReader["scan"]>>;
    try {
      source = cachedSource(options.open(entry), reader.limits);
      result = await withTimer(
        reader.scan(source, entry.path, reader.limits),
        reader.limits.timeMs,
      );
    } catch (error) {
      if (options.isFatal?.(error)) throw error;
      if (error instanceof LimitExceeded || error instanceof ReadTimedOut) {
        t.partial++;
        out.reasons.add(error instanceof LimitExceeded ? "limit" : "time");
        out.companionMissing += lacking;
        if (lacking > 0) out.reasons.add("companion-missing");
        return;
      }
      if (superseded.has(entry) && options.isAbsent?.(error)) {
        // Gone from the store, so it leaks nothing: not a recording, and not a failed read.
        t.files--;
        fail(`${reader.id}/superseded-absent`);
        return;
      }
      t.failed++;
      fail(`${reader.id}/${options.failureClass(error)}`);
      return;
    }
    // EDF/BDF statistics, from the header the reader already read (a cache hit, no new read).
    let patient: string | null = null;
    if (reader.id === "edf" && result.coverage === "complete") {
      const head = await source.read(0, EDF_HEADER_BYTES).catch(() => null);
      if (head && head.length >= EDF_HEADER_BYTES) patient = edfIdentificationText(head).patient;
    }
    // Everything below only commits; nothing below can throw.
    for (const f of result.findings) out.findings.push(f);
    if (reader.id === "edf") {
      const e = out.edf;
      if (patient !== null && !result.findings.some((f) => f.kind === "edf-unreadable")) {
        e.patientValues.add(patient);
        const parts = patient.split(/\s+/);
        if (parts.length >= 4) {
          e.codeValues.add(parts[0] as string);
          e.birthValues.add(parts[2] as string);
          e.nameValues.add(parts[3] as string);
        }
      }
      e.subjects.add(subjectOf(entry.path));
      if (result.findings.some((f) => f.severity === "identifier")) {
        e.flaggedFiles++;
        if (patient !== null) e.flaggedPatientValues.add(patient);
      }
      for (const kind of new Set(result.findings.map((f) => f.kind))) {
        e.flaggedKinds[kind] = (e.flaggedKinds[kind] ?? 0) + 1;
      }
    }
    out.companionMissing += lacking;
    if (result.coverage === "complete" && lacking === 0) {
      t.read++;
      return;
    }
    t.partial++;
    if (lacking > 0) out.reasons.add("companion-missing");
    if (result.coverage === "partial" && result.incomplete) out.reasons.add(result.incomplete);
  });

  // A reader other than EDF/BDF whose files did not all get a full or partial read: the EDF/BDF
  // shortfall has its own words (`edf-headers-unread`, `edf-headers-sampled`).
  for (const [id, t] of Object.entries(out.tallies) as [ReaderId, ReaderTally][]) {
    if (id !== "edf" && t.read + t.partial < t.files) out.reasons.add("recordings-unread");
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// The report's version-2 fields
// ---------------------------------------------------------------------------------------

/** The recordings a scan counted, and the ones it read completely. */
export function recordingCounts(outcome: Pick<RecordingsOutcome, "tallies">): {
  recordings: number;
  read: number;
} {
  let recordings = 0;
  let read = 0;
  for (const t of Object.values(outcome.tallies) as ReaderTally[]) {
    recordings += t.files;
    read += t.read;
  }
  return { recordings, read };
}

/** `read_by_format`, `companion_missing` and `readers`, as the report carries them. */
export function coverageFields(
  outcome: Pick<RecordingsOutcome, "tallies" | "companionMissing">,
  readers: readonly FormatReader[] = READERS,
): {
  read_by_format: Partial<Record<ReaderId, ReaderTally>>;
  companion_missing: number;
  readers: Partial<Record<ReaderId, string>>;
} {
  const read_by_format: Partial<Record<ReaderId, ReaderTally>> = {};
  for (const [id, t] of Object.entries(outcome.tallies) as [ReaderId, ReaderTally][]) {
    read_by_format[id] = { ...t };
  }
  const versions: Partial<Record<ReaderId, string>> = {};
  for (const reader of readers) versions[reader.id] = reader.version;
  return { read_by_format, companion_missing: outcome.companionMissing, readers: versions };
}
