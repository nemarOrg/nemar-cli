/**
 * The EEGLAB `.set` reader (publication-queue plan, card A5). A `.set` file is a MAT-file:
 * classic (Level 5, `-v6` or `-v7`) or `-v7.3` (HDF5); the shared MATLAB layer
 * (`mat-generic.ts`) reads both into the same arrays, and the signal (`data`, `icaact`, `times`,
 * ...) is skipped by size, never read. EEGLAB writes the `EEG` structure either as one variable
 * or as one variable per field (`save -struct`); both read the same here.
 *
 * The rules, by EEGLAB field (design review and lead rulings, 2026-11-25):
 *
 * - `subject`: SNIRF's `SubjectID` rule ({@link readSubjectId}): `eeglab-subject-name`
 *   (identifier) for a name-like word of letters only, `eeglab-subject-freetext` (review) for
 *   other text; nothing for a placeholder, the BIDS subject label or a short code.
 * - `filepath`, and every other location field (`isLocationField`, shared by every format:
 *   `chaninfo.filename`, `splinefile`, `dipfit.hdmfile`, `etc.original_mff`, ...): not scanned. They record
 *   where the researcher kept the file and name no participant.
 * - `history`: the person-name rule only ({@link personNameIn}), as `eeglab-history-name`
 *   (review); never the path rule.
 * - The event tables (`event`, `urevent`, `epoch`), every column: the person-name rule only,
 *   as `eeglab-event-name` (review); numeric and code-like values never fire.
 * - Channel labels never fire.
 * - `datfile` (or `data` as text): the `.fdt` file holding the signal, which must sit beside the
 *   `.set` ({@link ReaderResult.needs}); a miss is a missing companion, not a finding. The
 *   `.fdt` is never read.
 * - `BIDS` (the BIDS plugin's copy of the sidecars): the free-text rules without the
 *   person-field rule, since its keys are BIDS's own words (`LongName`).
 * - Everything else (`setname`, `comments`, `etc`, `group`, `condition`, `session`, ...): the
 *   free-text rules (`scanMatText`).
 *
 * In a v7.3 file, cell members and struct-array fields (event types, channel labels) sit
 * behind object references, under `/#refs#`, without their field names: they get the
 * free-text rules (paths and contact details), not the person-name rule.
 */

import type { FormatReader, ReaderResult } from "../identifier-readers";
import { type Finding, isNameLike, shapeOf } from "../identifier-scan";
import type { MatEntry } from "../mat-meta";
import {
  MAT_READER_LIMITS,
  linesOf,
  matResult,
  scanMatText,
  textOf,
  walkMatForReader,
} from "./mat-generic";
import { isLocationField } from "./person-fields";
import { readSubjectId } from "./snirf";
import { pairByName, stem } from "./text-header";

const SET = ".set";
const FDT = ".fdt";

/** EEGLAB's own top-level fields that the field word may name (a closed set). */
const NAMED_FIELDS: ReadonlySet<string> = new Set([
  "setname",
  "filename",
  "comments",
  "group",
  "condition",
  "session",
  "etc",
  "event",
  "urevent",
  "chanlocs",
  "chaninfo",
  "ref",
  "eventdescription",
  "epochdescription",
  "reject",
  "stats",
  "dipfit",
  "BIDS",
]);

/** The event tables: one struct element per event or epoch, one field per column. */
const EVENT_TABLES: ReadonlySet<string> = new Set(["event", "urevent", "epoch"]);

/** The EEGLAB fields an array sits under: the `EEG` variable's name dropped when it has one. */
export function eeglabFields(entry: MatEntry): string[] {
  const f = entry.fields;
  return f[0] === "EEG" && f.length > 1 ? f.slice(1) : f;
}

const startsWith = (fields: readonly string[], prefix: readonly string[]) =>
  prefix.every((p, i) => fields[i] === p);

/** A capitalized word of letters (and `' -`) that the scanner's word test calls name-like. */
const NAME_WORD = /^\p{Lu}[\p{Ll}'-]*\p{Ll}$/u;
const nameWord = (w: string) => NAME_WORD.test(w) && isNameLike(w);

/**
 * The person-name rule for free text that is not a person's field (event types, `history`):
 * two capitalized words in a row that the word test calls name-like, as a given name and a
 * family name are written, outside file paths ({@link withoutPaths}). A single word never fires: event types and commands are words
 * (`square`, `Target`, `pop_epoch`), and the word test calls almost all of them name-like.
 * Returns the matched words, or null.
 */
export function personNameIn(text: string): string | null {
  const words = withoutPaths(text)
    .split(/[^\p{L}'-]+/u)
    .filter((w) => w !== "");
  for (let i = 0; i + 1 < words.length; i++) {
    const a = words[i] as string;
    const b = words[i + 1] as string;
    if (nameWord(a) && nameWord(b)) return `${a} ${b}`;
  }
  return null;
}

/**
 * Text with its file paths taken out: a quoted string holding a `/` or `\\`, and any other run
 * of non-blank characters that does. Folder names on the researcher's machine are not scanned
 * (the `filepath` ruling), so they cannot fire the person-name rule either.
 */
export function withoutPaths(text: string): string {
  return text.replace(/'[^']*[/\\][^']*'|"[^"]*[/\\][^"]*"/g, " ").replace(/\S*[/\\]\S*/g, " ");
}

/** The `.fdt` a `.set` names for its signal, or null when its signal is in the file. */
export function fdtNamed(entries: readonly MatEntry[]): string | null {
  let datfile: string | null = null;
  let data: string | null = null;
  for (const e of entries) {
    if (e.class !== "char") continue;
    const f = eeglabFields(e);
    if (f.length !== 1) continue;
    if (f[0] === "datfile") datfile = textOf(e);
    // Older EEGLAB wrote the file name in `data` itself.
    if (f[0] === "data") data = textOf(e);
  }
  if (datfile) return datfile;
  if (data && /\.(fdt|dat)$/i.test(data)) return data;
  return null;
}

/** The EEGLAB rules over a walk's arrays, for the file at `path`. */
export function scanEeglabEntries(entries: readonly MatEntry[], path: string): Finding[] {
  const out: Finding[] = [];
  let historyFired = false;
  for (const entry of entries) {
    const f = eeglabFields(entry);
    const top = f[0] ?? "";
    // Where the researcher kept a file (`filepath`, `chaninfo.filename`, the spline and dipfit
    // files): never scanned, by the one shared rule.
    if (isLocationField(f[f.length - 1] ?? "")) continue;
    if (f.length === 1 && (top === "datfile" || top === "data")) continue;
    if ((top === "chanlocs" || top === "urchanlocs") && f[1] === "labels") continue;
    if (startsWith(f, ["chaninfo", "nodatchans", "labels"])) continue;
    if (top === "subject" && f.length === 1) {
      if (entry.class !== "char") continue;
      const value = textOf(entry);
      const reading = readSubjectId(value, path);
      if (reading === "none") continue;
      const name = reading === "name";
      out.push({
        kind: name ? "eeglab-subject-name" : "eeglab-subject-freetext",
        severity: name ? "identifier" : "review",
        field: "eeglab.subject",
        shape: shapeOf(value),
      });
      continue;
    }
    if (top === "history" && f.length === 1) {
      if (historyFired || entry.class !== "char") continue;
      const hit = linesOf(entry)
        .map(personNameIn)
        .find((h) => h !== null);
      if (hit) {
        historyFired = true;
        out.push({
          kind: "eeglab-history-name",
          severity: "review",
          field: "eeglab.history",
          shape: shapeOf(hit),
        });
      }
      continue;
    }
    // The event tables' columns (lead rulings: types, then every column): the person-name rule
    // only, never the path or person-field rules; numbers and codes never fire.
    if (EVENT_TABLES.has(top) && f.length >= 2) {
      if (entry.class !== "char") continue;
      const hit = personNameIn(textOf(entry));
      if (hit) {
        out.push({
          kind: "eeglab-event-name",
          severity: "review",
          field: f[1] === "type" && f.length === 2 ? "eeglab.event.type" : "eeglab.event.field",
          shape: shapeOf(hit),
        });
      }
      continue;
    }
    const word =
      top === "#refs#" ? "eeglab.cell" : NAMED_FIELDS.has(top) ? `eeglab.${top}` : "eeglab.field";
    // EEG.BIDS mirrors the dataset's BIDS sidecars and tables, whose keys are BIDS's own words:
    // the identifier-key, path and contact rules, not the person-field rule (lead ruling 5).
    out.push(...scanMatText(entry, word, { personFields: top !== "BIDS" }));
  }
  return out;
}

export const EEGLAB_READER: FormatReader = {
  id: "eeglab",
  extensions: [SET],
  limits: MAT_READER_LIMITS,
  version: "1",
  companions(path, siblings) {
    // The `.fdt` beside a `.set` under its base name is the set's; whether one is needed is
    // the content's to say (`needs`), so a set with its signal inside needs none.
    return pairByName(stem(path, SET), [], [FDT], siblings);
  },
  async scan(src, path, limits): Promise<ReaderResult> {
    const walk = await walkMatForReader(src, limits);
    const result = matResult(scanEeglabEntries(walk.entries, path), walk);
    if (result.coverage === "not-applicable") return result;
    const fdt = fdtNamed(walk.entries);
    return fdt === null ? result : { ...result, needs: [fdt] };
  },
};
