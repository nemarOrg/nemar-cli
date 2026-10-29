/**
 * The corrective-action ledger: an append-only record of what NEMAR did to a dataset's bytes
 * and when (ADR 0085).
 *
 * It exists because a scrub changes the bytes behind a version and a DOI, and the only thing that
 * keeps that honest is a record that cannot be lost to the same history rewrite. So the same line
 * is written to three places: a file in the dataset repository committed after the rewrite
 * (`.nemar/corrections.jsonl`), an object under the dataset's S3 prefix, and a count with a pointer
 * on the catalog row. This module owns the line: its shape, a guard that keeps a value out of it,
 * and the plain change-log sentence that goes into each corrected version.
 *
 * **A ledger line never holds a value.** Counts are numbers; `verification` is one of a closed list;
 * `scanner` is a code revision and `actor` a GitHub handle, each matched against a strict pattern;
 * unknown fields are refused. Per-file lists are not allowed (ADR 0036): counts and pointers only.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  LEDGER_REPO_PATH,
  MERGE_ACCEPTED_ACTION,
  MERGE_ACCEPTED_VERIFICATION,
  SCANNER_RE,
  SCRUB_LEDGER_ACTIONS,
} from "../../shared/repull-merge-acceptance";
import { DIGEST_RE, SHA_RE } from "../../shared/repull-state";
import { type LedgerEntry, VERSION_TAG } from "./contract";

/** Where the ledger lives in the dataset repository, after the rewrite (one definition, shared). */
export { LEDGER_REPO_PATH, MERGE_ACCEPTED_ACTION, MERGE_ACCEPTED_VERIFICATION };

/** Where it lives in the bucket: next to the dataset's other objects, not under `objects/`. */
export function ledgerS3Key(dataset: string): string {
  return `${dataset}/corrections/ledger.jsonl`;
}

export class LedgerRefused extends Error {
  constructor(readonly field: string) {
    super(`ledger entry refused: ${field}`);
    this.name = "LedgerRefused";
  }
}

const ACTIONS: ReadonlySet<LedgerEntry["action"]> = new Set([
  "plan",
  "headers-scrubbed",
  "files-removed",
  "history-rewritten",
  "locks-applied",
  "manifests-regenerated",
  "old-versions-deleted",
  "published-again",
  // Written by the importer, not by an operator: the tree was scrubbed before its first push, so no
  // version existed yet and `versions` is empty (ADR 0089).
  "import-scrubbed",
  // Written by an upstream re-pull's delta scrub before the commit, so no history holds the
  // original (ADR 0111, decision 9): it holds nothing, and it is not a recorded correction.
  "repull-scrubbed",
  // Written by NEMAR's Worker after an administrator accepted a re-pull's squash merge made
  // without its trailers (ADR 0111, the amendment of 2026-10-29): it names that merge commit, so
  // the fresh-clone proof reads it as the re-pull's own. It changes no byte of the dataset, so it
  // is not a recorded correction either.
  MERGE_ACCEPTED_ACTION,
]);

/**
 * The actions a tool writes itself, in the same commit as the files it scrubbed: the importer's
 * (ADR 0089) and an upstream re-pull's delta scrub (ADR 0111). An operator cannot type them
 * (`ledger-cli.ts` refuses both), a re-pull plan does not count them as recorded corrections,
 * and ADR 0085's fresh-clone proof tolerates their commits under its own rule (`git-lib.ts`).
 */
export const SCRUB_ACTIONS: ReadonlySet<LedgerEntry["action"]> = new Set(SCRUB_LEDGER_ACTIONS);

/**
 * Every action a NEMAR tool writes and no operator may type: the two scrubs' and the Worker's
 * acceptance of a merge made without its trailers. None of them is a recorded correction (ADR
 * 0111, decision 1, as corrected by its Phase 6b amendment and the amendment of 2026-10-29), so a
 * re-pull plan counts every other line and none of these.
 */
export const TOOL_ACTIONS: ReadonlySet<LedgerEntry["action"]> = new Set([
  ...SCRUB_ACTIONS,
  MERGE_ACCEPTED_ACTION,
]);

/** A full commit id and a plan digest, which an acceptance line names: hex only, so neither can carry a value. */
const COMMIT_ID = SHA_RE;
const PLAN_DIGEST = DIGEST_RE;

/**
 * What a verification may say, from a closed list. A free-text field is the one place a stray
 * value could slip in, so there is none: the strongest claim is the longest phrase.
 */
const VERIFICATIONS: ReadonlySet<string> = new Set([
  "none",
  "plan-only",
  "scanner-clean",
  "scanner-clean+payload-identical",
  "scanner-clean+payload-identical+rehash-ok",
  "public-surface-clean",
  "authoritative-listing-empty",
  MERGE_ACCEPTED_VERIFICATION,
]);
/**
 * A verification may end with `+proof-<16 hex>`: the first 16 hex digits of the sha256 of the
 * proof file the line's counts were taken from (deleted.json for `old-versions-deleted`). Hex
 * only, so it can carry no value.
 */
const PROOF_SUFFIX = /\+proof-([0-9a-f]{16})$/;

/** The verification word a deletion line must carry: the authoritative listing, and its proof. */
export const DELETION_VERIFICATION = "authoritative-listing-empty";

/** `identifier-scan@<commit>`: a code revision, never text a person typed (one definition, shared). */
const SCANNER = SCANNER_RE;
/** A GitHub handle: the operator, not a participant. */
const ACTOR = /^[a-z0-9][a-z0-9-]{0,38}$/i;
const DATASET = /^(nm|xx|on)\d{6}$/;
/** A version tag the ledger and the change log take (declared in the contract, which the proof's parser shares). */
export { VERSION_TAG };
const VERSION = VERSION_TAG;

/** Refuse anything that could carry a value, then return the entry unchanged. */
export function validateLedgerEntry(entry: LedgerEntry): LedgerEntry {
  if (entry.version !== 1) throw new LedgerRefused("version");
  if (Number.isNaN(Date.parse(entry.at)) || !/^\d{4}-\d{2}-\d{2}T/.test(entry.at)) {
    throw new LedgerRefused("at");
  }
  if (!DATASET.test(entry.dataset)) throw new LedgerRefused("dataset");
  if (!ACTIONS.has(entry.action)) throw new LedgerRefused("action");
  if (!Array.isArray(entry.versions) || !entry.versions.every((v) => VERSION.test(v))) {
    throw new LedgerRefused("versions");
  }
  const counts = entry.counts as unknown;
  if (typeof counts !== "object" || counts === null || Array.isArray(counts)) {
    throw new LedgerRefused("counts");
  }
  for (const [k, v] of Object.entries(counts)) {
    if (
      !/^[a-z][a-z0-9_]{0,40}$/.test(k) ||
      typeof v !== "number" ||
      !Number.isFinite(v) ||
      v < 0
    ) {
      throw new LedgerRefused("counts");
    }
  }
  if (typeof entry.scanner !== "string" || !SCANNER.test(entry.scanner))
    throw new LedgerRefused("scanner");
  if (typeof entry.verification !== "string") throw new LedgerRefused("verification");
  const proofed = PROOF_SUFFIX.test(entry.verification);
  const base = entry.verification.replace(PROOF_SUFFIX, "");
  if (!VERIFICATIONS.has(base)) throw new LedgerRefused("verification");
  // What deleted the old versions is said only with the proof it was read from, and the proof's
  // claim is said only of that action: neither is a word anyone can type on its own.
  const deletion = entry.action === "old-versions-deleted";
  if (deletion !== (base === DELETION_VERIFICATION) || deletion !== proofed) {
    throw new LedgerRefused("verification");
  }
  // The same pairing for an accepted merge: its word is said only by that action, which says it
  // always, and which alone names a commit and a plan (each exactly, in hex).
  const accepted = entry.action === MERGE_ACCEPTED_ACTION;
  if (accepted !== (entry.verification === MERGE_ACCEPTED_VERIFICATION)) {
    throw new LedgerRefused("verification");
  }
  if (accepted) {
    if (typeof entry.commit !== "string" || !COMMIT_ID.test(entry.commit)) {
      throw new LedgerRefused("commit");
    }
    if (typeof entry.plan !== "string" || !PLAN_DIGEST.test(entry.plan)) {
      throw new LedgerRefused("plan");
    }
    if (entry.versions.length !== 1) throw new LedgerRefused("versions");
  } else if (entry.commit !== undefined || entry.plan !== undefined) {
    throw new LedgerRefused("extra-field");
  }
  if (typeof entry.actor !== "string" || !ACTOR.test(entry.actor)) throw new LedgerRefused("actor");
  const allowed = new Set([
    "version",
    "at",
    "dataset",
    "action",
    "versions",
    "counts",
    "scanner",
    "verification",
    "actor",
    ...(accepted ? ["commit", "plan"] : []),
  ]);
  for (const key of Object.keys(entry))
    if (!allowed.has(key)) throw new LedgerRefused("extra-field");
  return entry;
}

/** One ledger line, validated, without a trailing newline. */
export function ledgerLine(entry: LedgerEntry): string {
  return JSON.stringify(validateLedgerEntry(entry));
}

/** Append a validated line to a local ledger file, creating directories as needed. */
export function appendLedger(path: string, entry: LedgerEntry): string {
  const line = ledgerLine(entry);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${line}\n`);
  return line;
}

/**
 * The entries of a ledger's text, validating every line. A line that fails refuses the whole text.
 * Validation and use take the same string, so what was checked is what is used.
 */
export function parseLedgerText(text: string): LedgerEntry[] {
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => validateLedgerEntry(JSON.parse(l) as LedgerEntry));
}

/** Read a ledger file back, validating every line. A line that fails refuses the whole file. */
export function readLedger(path: string): LedgerEntry[] {
  return parseLedgerText(readFileSync(path, "utf8"));
}

/**
 * The plain sentence for a corrected version's change log. It says THAT a privacy correction was
 * made, to which versions, and nothing about what was removed or why it was there.
 */
export function changeLogEntry(date: string, versions: string[]): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new LedgerRefused("date");
  if (versions.length === 0 || !versions.every((v) => VERSION.test(v))) {
    throw new LedgerRefused("versions");
  }
  const span =
    versions.length === 1
      ? (versions[0] as string)
      : `${versions[0]} to ${versions[versions.length - 1]}`;
  return `${date}: privacy correction. Identification fields in recording file headers were removed in place from ${span}. Version numbers and DOIs are unchanged. See ${LEDGER_REPO_PATH}.`;
}
