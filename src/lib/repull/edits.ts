/**
 * NEMAR's standard edits, as the re-pull planner recognizes and re-applies them (ADR 0111,
 * decision 1).
 *
 * A standard edit is a function NEMAR applies to upstream's bytes, never a text merge. The planner
 * calls each one itself, on the bytes it reads, and compares: a path whose NEMAR side is exactly
 * what one of these functions makes of upstream's side is "explained". The functions are the ones
 * the importer and the publish step run, imported from where they live. The two edits a text
 * pattern finds (the `CHANGES` sentence here, the README badge in `overlay.ts`) are rebuilt with
 * the function that writes them and compared byte for byte, so a near spelling is not explained:
 *
 * - moving a git-held file NEMAR's policy calls data into the annex (`shouldAnnex`, ADR 0060), and
 *   un-annexing root metadata upstream annexed (`isNeverAnnexedMetadata`);
 * - the import scrub of a git-held EDF or BDF header (`importHeaderPatch`, ADR 0089, with or
 *   without ADR 0091's dates), and a scrubbed annexed recording, recognized by the dead mark NEMAR's
 *   git-annex branch records for the upstream key;
 * - the JSON blank and the scans-table dates (`blankIdentifierJsonKeys`,
 *   `normalizeScansTableDates`), and the provenance file's sentence and README note;
 * - the `.gitattributes` strip (`stripLargefilesAttributes`) and the `.bidsignore` line;
 * - the ADR 0085 privacy sentence appended to `CHANGES`, re-applied as a ledger edit (ADR 0111's
 *   Phase 5 amendment: `CHANGES` is upstream-owned except that sentence);
 * - the placeholder `participants.tsv` the enrichment commits when upstream ships none
 *   (`buildPlaceholderParticipantsTsv` over `enumerateBidsSubjects`), a function of the tree's
 *   subjects rather than of any upstream file.
 *
 * The README family and `dataset_description.json` are compared as units elsewhere
 * (`overlay.ts`, `description.ts`).
 */

import { createHash } from "node:crypto";
import { changeLogEntry } from "../../../scripts/scrub/ledger.js";
import { EDF_HEADER_BYTES } from "../../../shared/identifier-scan.js";
import {
  JsonBlankUnverified,
  blankIdentifierJsonKeys,
  importHeaderPatch,
  normalizeScansTableDates,
} from "../../../shared/identifier-scrub.js";
import {
  PROVENANCE_NOTE_KEY,
  PROVENANCE_PATH,
  PROVENANCE_README_PATH,
  type ProvenanceChange,
  provenanceReadmeNote,
} from "../../../shared/privacy-correction-text.js";
import {
  NEMAR_BIDSIGNORE_ENTRY,
  withBidsignoreEntry,
} from "../../../shared/standard-edits/bidsignore.js";
import {
  buildPlaceholderParticipantsTsv,
  enumerateBidsSubjects,
} from "../../../shared/standard-edits/participants.js";
import { isNeverAnnexedMetadata, shouldAnnex } from "../git-annex/policy.js";
import { stripLargefilesAttributes } from "../import-normalize.js";
import {
  JSON_PATH,
  MAX_JSON_BYTES,
  MAX_SCANS_TABLE_BYTES,
  RECORDING_PATH,
  SCANS_TABLE_PATH,
} from "../import-scrub.js";

// ---------------------------------------------------------------------------------------
// Annex keys
// ---------------------------------------------------------------------------------------

/** Hash width (hex) and node digest name for each backend family the planner can verify. */
const BACKENDS: Record<string, { algorithm: string; width: number }> = {
  SHA256: { algorithm: "sha256", width: 64 },
  SHA512: { algorithm: "sha512", width: 128 },
  SHA1: { algorithm: "sha1", width: 40 },
  MD5: { algorithm: "md5", width: 32 },
};

export interface KeyDigest {
  /** The backend as the key spells it (`SHA256E`, `MD5`, ...). */
  backend: string;
  size: number | null;
  /** The content hash, lowercase hex; null for a backend the planner cannot verify. */
  hex: string | null;
  algorithm: string | null;
}

/**
 * A key's backend, declared size and hash. The hash is fixed-width by backend and NOT delimited
 * from an `E` backend's extension (`...cc31COR-001` ends in a name with no dot), so the width is
 * what is read, as `parseAnnexKey` in `content-recovery.ts` reads it.
 */
export function keyDigest(key: string): KeyDigest | null {
  const m = /^([A-Z0-9]+)((?:-[a-zA-Z]\d+)*)--(.+)$/.exec(key);
  if (!m) return null;
  const backend = m[1] as string;
  const size = /-s(\d+)/.exec(m[2] as string);
  const family = backend.endsWith("E") ? backend.slice(0, -1) : backend;
  const known = BACKENDS[family];
  const rest = m[3] as string;
  const hex =
    known && rest.length >= known.width && /^[0-9a-f]+$/i.test(rest.slice(0, known.width))
      ? rest.slice(0, known.width).toLowerCase()
      : null;
  return {
    backend,
    size: size ? Number(size[1]) : null,
    hex,
    algorithm: hex ? (known?.algorithm ?? null) : null,
  };
}

/** True when `bytes` are the content `key` names: its declared size and its hash both match. */
export function keyMatchesBytes(key: string, bytes: Uint8Array): boolean {
  const d = keyDigest(key);
  if (!d?.hex || !d.algorithm) return false;
  if (d.size !== null && d.size !== bytes.length) return false;
  return createHash(d.algorithm).update(bytes).digest("hex") === d.hex;
}

/** The key git-annex names in an annex symlink target or a pointer file, or null. */
export function annexKeyOfEntry(mode: string, content: Uint8Array): string | null {
  const text = Buffer.from(content).toString("latin1");
  if (mode === "120000") {
    // `../../.git/annex/objects/Xx/Yy/KEY/KEY`: the last two segments are the key twice.
    const parts = text.trim().split("/");
    const key = parts[parts.length - 1];
    if (!text.includes("/annex/objects/") || !key || parts[parts.length - 2] !== key) return null;
    return keyDigest(key) ? key : null;
  }
  // A pointer file is one line, `/annex/objects/KEY`, at most 32 KiB.
  if (content.length > 32 * 1024) return null;
  const m = /^\/annex\/objects\/([^\s/]+)\n?$/.exec(text);
  return m && keyDigest(m[1] as string) ? (m[1] as string) : null;
}

/** git's blob id (SHA-1) for `bytes`, as `git hash-object` computes it without writing. */
export function gitBlobOid(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------------------
// Sides
// ---------------------------------------------------------------------------------------

/** One side of one path, as the planner reads it. */
export type Side =
  | { kind: "absent" }
  | { kind: "annex"; key: string; mode: string; oid: string }
  | { kind: "git"; mode: string; oid: string; size: number | null; bytes: Buffer | null };

/** The identity the three-way rule compares: symlink and pointer forms of one key are equal. */
export function identity(side: Side): string {
  if (side.kind === "absent") return "absent";
  if (side.kind === "annex") return `A:${side.key}`;
  return `G:${side.mode}:${side.oid}`;
}

export const ABSENT: Side = { kind: "absent" };

/** The final component of a path. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function isRootPath(path: string): boolean {
  return !path.includes("/");
}

// ---------------------------------------------------------------------------------------
// CHANGES: the ADR 0085 privacy sentence, re-applied as a ledger edit
// ---------------------------------------------------------------------------------------

/**
 * The `changeLogEntry` sentence as ADR 0085's git plan appends it (`\n<sentence>\n`), with the date
 * and the version span captured. Matched, then rebuilt with `changeLogEntry` itself and compared,
 * so only a sentence the ledger module would write counts.
 */
const CHANGES_SENTENCE =
  /\n(\d{4}-\d{2}-\d{2}): privacy correction\. Identification fields in recording file headers were removed in place from (\S+(?: to \S+)?)\. Version numbers and DOIs are unchanged\. See \.nemar\/corrections\.jsonl\.\n$/;

/**
 * Split NEMAR's `CHANGES` into upstream's text and the privacy sentences appended to it, newest
 * last. With no sentence appended, `prefix` is the whole text and `sentences` is empty.
 */
export function splitChangesSentences(text: string): { prefix: string; sentences: string[] } {
  const sentences: string[] = [];
  let rest = text;
  for (;;) {
    const m = CHANGES_SENTENCE.exec(rest);
    if (!m) break;
    const span = m[2] as string;
    const versions = span.includes(" to ") ? span.split(" to ") : [span];
    let rebuilt: string;
    try {
      rebuilt = `\n${changeLogEntry(m[1] as string, versions)}\n`;
    } catch {
      break;
    }
    if (!rest.endsWith(rebuilt)) break;
    sentences.unshift(rebuilt);
    rest = rest.slice(0, rest.length - rebuilt.length);
  }
  return { prefix: rest, sentences };
}

// ---------------------------------------------------------------------------------------
// The provenance README's note
// ---------------------------------------------------------------------------------------

const PROVENANCE_CHANGES: ProvenanceChange[] = [
  "scrubbed-in-place",
  "files-removed",
  "both",
  "dates-set",
  "scrubbed-and-dates-set",
];

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every note `provenanceReadmeNote` can write, with its date as a pattern. */
const README_NOTES = PROVENANCE_CHANGES.map(
  (change) =>
    new RegExp(
      `${escapeRegex(provenanceReadmeNote("@@DATE@@", change)).replace("@@DATE@@", "\\d{4}-\\d{2}-\\d{2}")}$`,
    ),
);

/** Strip one or more trailing provenance notes (and the newline the importer adds before one). */
function stripReadmeNotes(text: string): string | null {
  let rest = text;
  let stripped = false;
  for (;;) {
    const hit = README_NOTES.map((re) => re.exec(rest)).find((m) => m !== null);
    if (!hit) break;
    rest = rest.slice(0, hit.index);
    stripped = true;
  }
  if (!stripped) return null;
  return rest;
}

// ---------------------------------------------------------------------------------------
// The generated participants.tsv
// ---------------------------------------------------------------------------------------

/** Where the enrichment writes its placeholder: the root, in BIDS's exact lowercase spelling. */
export const PARTICIPANTS_PATH = "participants.tsv";

/**
 * The placeholder `participants.tsv` the enrichment commits for a tree with these paths and none
 * of its own (`ensureParticipantsTsv`), or null when the tree has no `sub-*` directory, where the
 * enrichment writes nothing.
 */
export function generatedParticipants(paths: Iterable<string>): Buffer | null {
  const subjects = enumerateBidsSubjects([...paths].map((path) => ({ path })));
  return subjects.length === 0 ? null : Buffer.from(buildPlaceholderParticipantsTsv(subjects));
}

// ---------------------------------------------------------------------------------------
// Explaining one path
// ---------------------------------------------------------------------------------------

/** The name of the standard edit that explains a NEMAR side, for the plan file. */
export type EditName =
  | "identical"
  | "annexed-from-git"
  | "scrubbed-git-held"
  | "scrubbed-key"
  | "root-metadata-unannexed"
  | "gitattributes-stripped"
  | "bidsignore-entry"
  | "changes-ledger-sentence"
  | "json-blanked"
  | "provenance-note"
  | "provenance-readme-note"
  | "scans-dates"
  | "participants-generated";

/** What the overlay knows that a recognizer needs beyond the two sides' bytes. */
export interface ExplainContext {
  /** True when NEMAR's git-annex branch marks this key dead. */
  isDeadAtNemar(key: string): boolean;
  /**
   * The placeholder `participants.tsv` the enrichment would generate for the upstream tree the
   * side being explained comes from ({@link generatedParticipants}); null or absent when that
   * tree has no subjects, and then nothing is explained by it.
   */
  generatedParticipants?: Buffer | null;
}

/**
 * A DOI as a badge or a description names it, without `doi:` or a resolver, trimmed; null for a
 * value that is not a non-empty string, so a comparison with a missing DOI never matches.
 */
export function bareDoi(doi: string | null | undefined): string | null {
  if (typeof doi !== "string" || doi.trim() === "") return null;
  return doi
    .trim()
    .replace(/^doi:/i, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
}

/** Text without a leading byte-order mark, which `JSON.parse` refuses. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function decoded(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function equalBytes(a: Uint8Array | undefined | null, b: Uint8Array | null): boolean {
  return !!a && !!b && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

function blankOf(bytes: Buffer): Buffer {
  try {
    const r = blankIdentifierJsonKeys(bytes);
    return r.status === "blanked" && r.bytes ? Buffer.from(r.bytes) : bytes;
  } catch (err) {
    if (err instanceof JsonBlankUnverified) return bytes;
    throw err;
  }
}

function parseObject(bytes: Buffer): Record<string, unknown> | null {
  const text = decoded(bytes);
  if (text === null) return null;
  try {
    const v = JSON.parse(stripBom(text));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Order-insensitive JSON equality on parsed values (object keys sorted). */
export function canonicalValue(value: unknown): string {
  if (value === undefined) return "undefined";
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, (v as Record<string, unknown>)[k]]),
        )
      : v,
  );
}

/**
 * The patched content of a git-held recording, as the import scrub leaves it, for each date
 * setting the scrub may have run with (a first import sets dates; a re-import does not). Null when
 * the scrub would leave the header alone.
 */
function patchedRecordings(bytes: Buffer): Buffer[] {
  const out: Buffer[] = [];
  if (bytes.length < EDF_HEADER_BYTES) return out;
  for (const dates of [true, false]) {
    let patch: ReturnType<typeof importHeaderPatch>;
    try {
      patch = importHeaderPatch(bytes.subarray(0, EDF_HEADER_BYTES), dates);
    } catch {
      continue;
    }
    if (!patch.ok || (!patch.change.scrub && !patch.change.dates)) continue;
    const patched = Buffer.from(bytes);
    patched.set(patch.header.subarray(0, EDF_HEADER_BYTES), 0);
    out.push(patched);
  }
  return out;
}

/**
 * The standard edit that makes `ours` from `x` (upstream's side at one tag) at `path`, or null.
 * `x.bytes` and `ours.bytes` are null when the blob was not read (missing past the bound); a
 * recognizer that needs bytes it does not have answers null, which counts the path unexplained.
 */
export function explainEdit(
  path: string,
  x: Side,
  ours: Side,
  ctx: ExplainContext,
): EditName | null {
  if (identity(x) === identity(ours)) return "identical";
  const name = baseName(path);
  const root = isRootPath(path);

  if (x.kind === "git" && ours.kind === "annex") {
    if (!x.bytes) return null;
    if (shouldAnnex(path, x.bytes.length) && keyMatchesBytes(ours.key, x.bytes)) {
      return "annexed-from-git";
    }
    if (RECORDING_PATH.test(path) && keyDigest(ours.key)?.backend === "SHA256E") {
      for (const patched of patchedRecordings(x.bytes)) {
        if (keyMatchesBytes(ours.key, patched)) return "scrubbed-git-held";
      }
    }
    return null;
  }

  if (x.kind === "annex" && ours.kind === "annex") {
    // The scrub (and ADR 0085's annex-registry) retires the key it replaces by marking it dead in
    // NEMAR's git-annex branch, and a header patch never changes a file's size.
    const before = keyDigest(x.key)?.size ?? null;
    const after = keyDigest(ours.key)?.size ?? null;
    // An unknown size is not the same size: a key that declares none proves nothing about it.
    const sameSize = before !== null && after !== null && before === after;
    return ctx.isDeadAtNemar(x.key) && sameSize ? "scrubbed-key" : null;
  }

  if (x.kind === "annex" && ours.kind === "git") {
    if (!root || !isNeverAnnexedMetadata(name) || !ours.bytes) return null;
    if (keyMatchesBytes(x.key, ours.bytes)) return "root-metadata-unannexed";
    if (name === "CHANGES") {
      const text = decoded(ours.bytes);
      const split = text === null ? null : splitChangesSentences(text);
      if (
        split &&
        split.sentences.length > 0 &&
        keyMatchesBytes(x.key, Buffer.from(split.prefix))
      ) {
        return "changes-ledger-sentence";
      }
    }
    return null;
  }

  if (x.kind === "absent" && ours.kind === "git" && root && ours.bytes) {
    if (path === PARTICIPANTS_PATH) {
      // Generated only where upstream ships none, and only this exact content: a placeholder NEMAR
      // or a contributor then edited is NEMAR's own change.
      return equalBytes(ctx.generatedParticipants, ours.bytes) ? "participants-generated" : null;
    }
    if (name === ".bidsignore") {
      return equalBytes(
        Buffer.from(withBidsignoreEntry("", NEMAR_BIDSIGNORE_ENTRY).content),
        ours.bytes,
      )
        ? "bidsignore-entry"
        : null;
    }
    if (name === "CHANGES") {
      const text = decoded(ours.bytes);
      const split = text === null ? null : splitChangesSentences(text);
      return split && split.sentences.length > 0 && split.prefix === ""
        ? "changes-ledger-sentence"
        : null;
    }
    return null;
  }

  if (x.kind !== "git" || ours.kind !== "git") return null;
  // A mode change with the same content is not something any standard edit makes.
  if (x.oid === ours.oid || !x.bytes || !ours.bytes) return null;
  const xb = x.bytes;
  const ob = ours.bytes;

  if (name === ".gitattributes") {
    const text = decoded(xb);
    if (text !== null && equalBytes(Buffer.from(stripLargefilesAttributes(text).content), ob)) {
      return "gitattributes-stripped";
    }
    return null;
  }
  if (root && name === ".bidsignore") {
    const text = decoded(xb);
    return text !== null &&
      equalBytes(Buffer.from(withBidsignoreEntry(text, NEMAR_BIDSIGNORE_ENTRY).content), ob)
      ? "bidsignore-entry"
      : null;
  }
  if (root && name === "CHANGES") {
    const text = decoded(ob);
    const split = text === null ? null : splitChangesSentences(text);
    return split && split.sentences.length > 0 && equalBytes(Buffer.from(split.prefix), xb)
      ? "changes-ledger-sentence"
      : null;
  }
  if (path === PROVENANCE_PATH) {
    const theirs = [parseObject(xb), parseObject(blankOf(xb))];
    const mine = parseObject(ob);
    if (mine && PROVENANCE_NOTE_KEY in mine) {
      const { [PROVENANCE_NOTE_KEY]: _note, ...rest } = mine;
      if (theirs.some((t) => t && canonicalValue(t) === canonicalValue(rest)))
        return "provenance-note";
    }
  }
  if (path === PROVENANCE_README_PATH) {
    const mine = decoded(ob);
    const upstream = decoded(xb);
    const before = mine === null ? null : stripReadmeNotes(mine);
    if (upstream !== null && before !== null) {
      if (
        before === upstream ||
        (before.endsWith("\n") && before.slice(0, -1) === upstream && !upstream.endsWith("\n"))
      ) {
        return "provenance-readme-note";
      }
    }
    return null;
  }
  if (JSON_PATH.test(path) && xb.length <= MAX_JSON_BYTES) {
    if (equalBytes(blankOf(xb), ob)) return "json-blanked";
  }
  if (SCANS_TABLE_PATH.test(path) && xb.length <= MAX_SCANS_TABLE_BYTES) {
    try {
      const r = normalizeScansTableDates(xb);
      if (r.status === "normalized" && equalBytes(r.bytes ?? null, ob)) return "scans-dates";
    } catch {
      // A table whose result cannot be proven keeps its dates, as the import leaves it.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// The edits as the new tree gets them
// ---------------------------------------------------------------------------------------

/** What N.0.0 holds at one path before the scrub (the plan's `T(theirs)`). */
export type Target =
  | { kind: "absent" }
  | { kind: "annex"; key: string }
  /** A git blob NEMAR's policy annexes: its key is computed when the plan is executed. */
  | { kind: "annex-from-git"; oid: string; size: number | null }
  /** Root metadata upstream annexed, which the import keeps in git: un-annexed at execution. */
  | {
      kind: "unannex";
      key: string;
      /** ADR 0085 sentences appended to the un-annexed text (`CHANGES` only). */
      append?: string[];
    }
  | { kind: "git"; mode: string; oid: string; computed?: string }
  | { kind: "description" }
  /** The planner could not compute the target (bytes it could not read); never executable. */
  | { kind: "unknown"; reason: string };

/**
 * `T(x)` for an ordinary path (not the README family, not the description). `sentences` are the
 * ADR 0085 privacy sentences NEMAR's `CHANGES` carries, re-applied to upstream's `CHANGES`.
 * `oursHasBidsignore` says NEMAR holds a `.bidsignore` with its line, so an upstream without one
 * still gets it. `generatedParticipants` is given only when NEMAR's `participants.tsv` is the
 * enrichment's placeholder: it is the placeholder of `x`'s own tree, so an upstream without the
 * file gets the one its subjects make (null when that tree has none, and the file goes).
 */
export function targetOf(
  path: string,
  x: Side,
  opts: { sentences: string[]; oursHasBidsignore: boolean; generatedParticipants?: Buffer | null },
): Target {
  const name = baseName(path);
  const root = isRootPath(path);
  if (x.kind === "absent") {
    if (path === PARTICIPANTS_PATH && opts.generatedParticipants) {
      return computed("100644", opts.generatedParticipants, "participants-generated");
    }
    if (root && name === ".bidsignore" && opts.oursHasBidsignore) {
      return computed(
        "100644",
        withBidsignoreEntry("", NEMAR_BIDSIGNORE_ENTRY).content,
        "bidsignore-entry",
      );
    }
    if (root && name === "CHANGES" && opts.sentences.length > 0) {
      return computed("100644", opts.sentences.join(""), "changes-ledger-sentence");
    }
    return { kind: "absent" };
  }
  if (x.kind === "annex") {
    if (root && isNeverAnnexedMetadata(name)) {
      // CHANGES keeps its ADR 0085 sentences whether upstream holds it in git or in the annex.
      return name === "CHANGES" && opts.sentences.length > 0
        ? { kind: "unannex", key: x.key, append: [...opts.sentences] }
        : { kind: "unannex", key: x.key };
    }
    return { kind: "annex", key: x.key };
  }
  const size = x.bytes?.length ?? x.size;
  if (name === ".gitattributes") {
    const text = x.bytes ? decoded(x.bytes) : null;
    if (text === null) return { kind: "unknown", reason: "gitattributes-unread" };
    return computed(x.mode, stripLargefilesAttributes(text).content, "gitattributes-stripped");
  }
  if (root && name === ".bidsignore") {
    const text = x.bytes ? decoded(x.bytes) : null;
    if (text === null) return { kind: "unknown", reason: "bidsignore-unread" };
    return computed(
      x.mode,
      withBidsignoreEntry(text, NEMAR_BIDSIGNORE_ENTRY).content,
      "bidsignore-entry",
    );
  }
  if (root && name === "CHANGES" && opts.sentences.length > 0) {
    if (!x.bytes) return { kind: "unknown", reason: "changes-unread" };
    return computed(
      x.mode,
      Buffer.concat([x.bytes, Buffer.from(opts.sentences.join(""))]),
      "changes-ledger-sentence",
    );
  }
  // A size of 1 MiB or more is the only thing a missing blob says about itself, and it is enough:
  // the policy's size rule is a threshold far below it.
  if (shouldAnnex(path, size ?? 1024 * 1024)) {
    return { kind: "annex-from-git", oid: x.oid, size: size ?? null };
  }
  return { kind: "git", mode: x.mode, oid: x.oid };
}

function computed(mode: string, content: string | Buffer, edit: EditName): Target {
  const bytes = typeof content === "string" ? Buffer.from(content) : content;
  return { kind: "git", mode, oid: gitBlobOid(bytes), computed: edit };
}

/** True when `target` is exactly what `ours` already holds. */
export function targetEqualsOurs(target: Target, ours: Side): boolean {
  if (target.kind === "absent") return ours.kind === "absent";
  if (target.kind === "annex") return ours.kind === "annex" && ours.key === target.key;
  if (target.kind === "git")
    return ours.kind === "git" && ours.oid === target.oid && ours.mode === target.mode;
  return false;
}
