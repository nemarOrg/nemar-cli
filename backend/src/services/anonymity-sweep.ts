/**
 * Anonymity, re-checked on a schedule (#1409, epic #1406).
 *
 * Phases 1-3 made every writer NEMAR controls withhold the depositor of an
 * anonymous deposit. That is a set of claims, and a claim nothing re-reads is
 * one that stops being true quietly: a projection that loses its
 * `AND anonymous = 0`, an admin `UPDATE` that clears `enrichment_json` without
 * re-blinding, a repository flipped public by hand. Each is silent today, and
 * each discloses a person.
 *
 * This sweep answers TWO different questions and must never let one answer
 * stand in for the other:
 *
 * **Invariants NEMAR owns.** The repository is private, `datasets.authors`
 * holds the blinded label, `enrichment_json` carries none of the blinded keys,
 * `first_published_at` is NULL, the EZID record is `reserved` with no curator,
 * and the public projections withhold the owner. A violation here is a NEMAR
 * bug and is reported as `severity: "invariant"`.
 *
 * **What the depositor left in their own files.** `dataset_description.json`,
 * README, `participants.tsv` and the rest are git-tracked, are the depositor's
 * to write, and are served publicly from the data plane (#1403). NEMAR cannot
 * blind them, so findings here are `severity: "deposit"` and are addressed to
 * the depositor rather than to an operator.
 *
 * **WHY THE FILE CHECKS ARE DETERMINISTIC.** They do not try to decide whether
 * a string is a person's name, which is the hard problem and the one a model
 * would be needed for. They ask a much narrower question with an exact answer:
 * does this file contain THE DEPOSITOR -- whose real name, username, GitHub
 * handle, email and ORCID iD are all in the `users` row NEMAR is concealing?
 * Plus two patterns that are identifying regardless of who wrote them: any
 * ORCID iD, and any email address. No classifier, no false-positive budget, and
 * a finding a depositor can act on without arguing with it. An advisory
 * model-guided pass over free text is a reasonable SECOND layer (the pre-screen
 * machinery of #666 is its natural home); it is not a substitute for this one.
 *
 * **It reports; it never repairs.** A dataset that has already leaked cannot be
 * un-leaked by flipping a flag, and a sweep that silently "fixed" things would
 * destroy the evidence that the guarantee had failed. The durable record is an
 * `audit_log` row; the depositor and the admins are told by email. It files NO
 * GitHub issue, unlike every other escalating sweep here: the `nemarDatasets`
 * org is public-facing and shared, so filing the finding would publish it.
 *
 * **What it cannot check is reported, never assumed clean** (ADR 0005, ADR
 * 0054). Identity inside the recordings themselves -- EDF/BDF
 * recording-identification, EEGLAB `EEG.comments`, FIFF subject fields -- lives
 * in annexed binaries that a Worker will not pull gigabytes to read. That is
 * ALWAYS in `unchecked`, on every run, for every dataset.
 *
 * **Reading a PRIVATE repository, cheaply.** The manifest (`getManifest`, one
 * S3 GET, signed-falls-back for a private dataset) already names every
 * git-tracked path and carries its git blob SHA, so no tree walk is needed.
 * Bytes come from `fetchGitTrackedFile` on the authenticated raw host, which
 * serves a private repository and spends none of the shared 5,000/hr GitHub
 * `core` budget (ADR 0064). That function's `absent` is honest only because a
 * token is held -- anonymous raw answers 404 for a private repo and for a
 * missing file alike, which is exactly the distinction this sweep must not get
 * wrong.
 *
 * Holding that token is "GitHub work against the shared `nemarDatasets` org",
 * so the cron entry is PRODUCTION-ONLY by default (AGENTS.md) and the name is
 * deliberately absent from `DEV_CRON_ALLOWLIST`. The sweep function itself is
 * unguarded so the admin route still works on staging;
 * `runAnonymitySweepCron` carries the fence.
 */

import { auditLogStatement } from "../db/audit-log.js";
import type { Bindings } from "../types/bindings.js";
import {
  ANONYMOUS_AUTHORS_LABEL,
  BLINDED_METADATA_KEYS,
  OWNER_GITHUB_SQL,
  OWNER_USERNAME_SQL,
} from "./anonymity.js";
import { isNonProductionEnv } from "./environment.js";
import { getDatasetsToken } from "./github-auth.js";
import { fetchGitTrackedFile } from "./github/git-file-broker.js";
import { GITHUB_API, ORG_NAME } from "./github/shared.js";
import { isPlaceholderAuthor } from "./submission-minimums.js";
import {
  ANONYMITY_ATTEMPTED_AT_PATH,
  ANONYMITY_CHECKED_AT_PATH,
  ANONYMITY_FINDINGS_PATH,
  ANONYMITY_STATUS_PATH,
  ANONYMITY_UNCHECKED_PATH,
} from "./sweep-stamps.js";

/** How many datasets one pass will look at, unless the caller says otherwise. */
export const ANONYMITY_SWEEP_DEFAULT = 10;
/** Ceiling the service clamps to, whatever a caller or query string asks for. */
export const ANONYMITY_SWEEP_MAX = 25;

/**
 * Git-tracked files one dataset's scan will read, at most.
 *
 * A dataset can have thousands of git-tracked files (2,802 of 3,201 on
 * `on008701`), and reading all of them would turn a bounded sweep into an
 * unbounded one. The selection is nearest-first by relevance
 * (`selectDepositFiles`), and anything past the cap is REPORTED as unchecked
 * rather than silently skipped -- a scan that read 40 of 3,000 files and said
 * "no findings" would be making a claim it had not earned.
 */
export const ANONYMITY_MAX_DEPOSIT_FILES = 40;

/** Largest git-tracked file this scan will read. Bigger ones are unchecked. */
export const ANONYMITY_MAX_FILE_BYTES = 512 * 1024;

/** Sweep-wide fetch ceiling, so one pathological dataset cannot starve the run. */
export const ANONYMITY_SWEEP_WIDE_BUDGET = 400;

/**
 * The verdict.
 *
 * `findings` rather than `failed`: this sweep reports NEMAR's own broken
 * invariants and the depositor's own un-blinded files under one verdict, and
 * only the first is a NEMAR bug. A word that implies "we broke it" would
 * misdirect the person who has to act.
 */
export type AnonymityVerdict = "verified" | "findings" | "unverifiable";

/** Whose problem a finding is. */
export type AnonymitySeverity = "invariant" | "deposit";

/**
 * Scope limits this sweep DECLARES rather than measures.
 *
 * Both are permanent statements about what was never in scope, not reports of
 * something that went wrong on this run, so they appear in `unchecked` on a
 * clean dataset and do not withhold `verified`. Everything else in `unchecked`
 * is a gap that opened on this run, and any one of them makes the verdict
 * `unverifiable`.
 *
 * Keeping them in `unchecked` rather than dropping them is the point: a reader
 * of a `verified` verdict is told, every time, the two things it does not
 * cover.
 */
export const ANONYMITY_DECLARED_SCOPE_LIMITS: readonly string[] = [
  // Identity inside the recordings themselves: EDF/BDF recording-identification
  // fields, EEGLAB `EEG.comments`, FIFF subject blocks. Annexed binaries, and a
  // Worker will not pull gigabytes to read them.
  "signal_headers",
  // Sub-directory sidecars. Thousands per dataset, acquisition parameters
  // rather than prose. Deliberately out of scope, which is a different
  // statement from "the 40-file budget ran out" -- that one is
  // `deposit_files_beyond_budget`, and it IS a gap.
  "deposit_subdirectory_files",
];

export interface AnonymityFinding {
  /** Stable id, so a reader can branch on it without parsing prose. */
  check: string;
  severity: AnonymitySeverity;
  /**
   * One sentence naming what was found and where.
   *
   * NEVER the matched text. This is stored in `sweep_stamps` and mailed, and
   * both of those are read by surfaces built to display a dataset's metadata;
   * a leak quoted into one of them is a leak. The depositor knows their own
   * name -- they do not need it read back to them to find it.
   */
  detail: string;
  /** The git-tracked path, for a `deposit` finding. */
  file?: string;
}

export interface AnonymityDatasetResult {
  dataset_id: string;
  status: AnonymityVerdict;
  findings: AnonymityFinding[];
  /** Check ids this run could not evaluate. Never empty: see `signal_headers`. */
  unchecked: string[];
  /** Git-tracked files actually read, and how many the manifest listed. */
  files_scanned: number;
  files_listed: number;
}

export interface AnonymitySweepResult {
  processed: number;
  verified: number;
  with_findings: number;
  unverifiable: number;
  results: AnonymityDatasetResult[];
  errors: { dataset_id: string; error: string }[];
  /** Candidates still owing a pass, or null when the count query itself failed. */
  remaining: number | null;
  budget_exhausted: boolean;
  /**
   * Notifications that did not reach someone.
   *
   * For a finding, the mail IS the depositor's copy, so a delivery failure is
   * a result of the run and not a detail of it: the CLI exits non-zero on a
   * non-empty list, and the admin route reports it.
   */
  mail_failures: { dataset_id: string; recipient: string; error: string }[];
}

/**
 * Who this dataset is concealing, and the strings that would give them away.
 *
 * Assembled from the `users` row rather than guessed from the files. That is
 * what makes the deposit checks deterministic: the question is not "is this a
 * name" but "is this THE depositor", and NEMAR knows the answer exactly.
 */
interface OwnerIdentity {
  /** Whole-word, case-insensitive tokens: names, username, GitHub handle. */
  tokens: string[];
  /** Matched literally and case-insensitively. */
  literals: string[];
}

/**
 * Candidates: every anonymous deposit not attempted in the last 20 hours.
 *
 * There is no "changed since" component, unlike the fidelity sweep's commit
 * comparison, because there is no commit to compare against: a projection
 * regression, a hand-flipped repository and an EZID status change all happen
 * with the dataset row untouched. Re-checking on a cadence is the only
 * predicate that catches those, and the candidate pool is small enough
 * (anonymous deposits are rare and short-lived) that a daily full pass is
 * cheap.
 *
 * 20 hours rather than 24 so a daily cron that drifts by a few minutes does not
 * skip a day. Ordered never-attempted-first, then oldest attempt, for the
 * reason `ZARR_FIDELITY_SWEEP_ATTEMPT_SQL` documents: a dataset that errors
 * every time must cost one slot per cycle, not the whole batch.
 */
export const ANONYMITY_SWEEP_CANDIDATE_SQL = `SELECT d.dataset_id, d.github_repo, d.authors,
          d.enrichment_json, d.first_published_at, d.concept_doi, d.is_sandbox,
          u.username AS owner_username, u.github_username AS owner_github,
          u.given_name AS owner_given_name, u.family_name AS owner_family_name,
          u.email AS owner_email, u.orcid AS owner_orcid,
          json_extract(d.sweep_stamps, '${ANONYMITY_FINDINGS_PATH}') AS previous_findings
     FROM datasets d
     JOIN users u ON d.owner_user_id = u.id
    WHERE d.status = 'active'
      AND d.anonymous = 1
      AND (
        json_extract(d.sweep_stamps, '${ANONYMITY_ATTEMPTED_AT_PATH}') IS NULL
        OR json_extract(d.sweep_stamps, '${ANONYMITY_ATTEMPTED_AT_PATH}') < datetime('now', '-20 hours')
      )
    ORDER BY json_extract(d.sweep_stamps, '${ANONYMITY_ATTEMPTED_AT_PATH}') IS NOT NULL,
             json_extract(d.sweep_stamps, '${ANONYMITY_ATTEMPTED_AT_PATH}') ASC,
             d.dataset_id
    LIMIT ?`;

/**
 * The same predicate as a count, so a caller can page a batch loop.
 *
 * The `JOIN users` is load-bearing and not decoration: the candidate query has
 * it, so a dataset whose owner row is missing is never RETURNED. Counting it
 * anyway would leave `remaining` permanently above zero and a batch loop
 * driven by it would not terminate.
 */
export const ANONYMITY_SWEEP_REMAINING_SQL = `SELECT COUNT(*) AS n
     FROM datasets d
     JOIN users u ON d.owner_user_id = u.id
    WHERE d.status = 'active'
      AND d.anonymous = 1
      AND (
        json_extract(d.sweep_stamps, '${ANONYMITY_ATTEMPTED_AT_PATH}') IS NULL
        OR json_extract(d.sweep_stamps, '${ANONYMITY_ATTEMPTED_AT_PATH}') < datetime('now', '-20 hours')
      )`;

/**
 * The verdict write. `COALESCE(sweep_stamps, '{}')` because `json_set(NULL, …)`
 * returns NULL and discards the write silently (ADR 0035). `json(?)` wraps the
 * two array parameters so they land as nested JSON rather than escaped strings.
 *
 * Writes ONLY `sweep_stamps` (ADR 0034): no other `datasets` column changes, on
 * any verdict. In particular it does NOT clear `anonymous` -- this sweep
 * reports, it does not repair.
 *
 * Bind order: status, findings-json, unchecked-json, dataset_id.
 */
export const ANONYMITY_SWEEP_STAMP_SQL = `UPDATE datasets
   SET sweep_stamps = json_set(
     COALESCE(sweep_stamps, '{}'),
     '${ANONYMITY_CHECKED_AT_PATH}', datetime('now'),
     '${ANONYMITY_STATUS_PATH}', ?,
     '${ANONYMITY_FINDINGS_PATH}', json(?),
     '${ANONYMITY_UNCHECKED_PATH}', json(?)
   )
   WHERE dataset_id = ? AND anonymous = 1`;

/** Stamped on every outcome, including the ones that reach no verdict. */
export const ANONYMITY_SWEEP_ATTEMPT_SQL = `UPDATE datasets
   SET sweep_stamps = json_set(
     COALESCE(sweep_stamps, '{}'),
     '${ANONYMITY_ATTEMPTED_AT_PATH}', datetime('now')
   )
   WHERE dataset_id = ?`;

/**
 * Re-arm every anonymous deposit for the next pass.
 *
 * Removes the verdict AND the attempt stamp, because leaving the attempt would
 * keep the row out of the candidate window for another 20 hours -- a `--reset`
 * that does not take effect until tomorrow is not a reset.
 */
export const ANONYMITY_SWEEP_RESET_SQL = `UPDATE datasets
   SET sweep_stamps = json_remove(
     COALESCE(sweep_stamps, '{}'),
     '${ANONYMITY_STATUS_PATH}',
     '${ANONYMITY_CHECKED_AT_PATH}',
     '${ANONYMITY_FINDINGS_PATH}',
     '${ANONYMITY_UNCHECKED_PATH}',
     '${ANONYMITY_ATTEMPTED_AT_PATH}'
   )
   WHERE anonymous = 1`;

/** The row the candidate query returns. */
interface AnonymityCandidate {
  dataset_id: string;
  github_repo: string | null;
  authors: string | null;
  enrichment_json: string | null;
  first_published_at: string | null;
  concept_doi: string | null;
  is_sandbox: number | null;
  owner_username: string | null;
  owner_github: string | null;
  owner_given_name: string | null;
  owner_family_name: string | null;
  owner_email: string | null;
  owner_orcid: string | null;
  /** Last run's findings, so an unchanged set is not re-mailed every day. */
  previous_findings: string | null;
}

/**
 * An ORCID iD anywhere in a body of text.
 *
 * `ORCID_ID_PATTERN` in `shared/contract/publication.ts` is anchored, because
 * its job is validating a field. This one scans, so it is the same shape
 * unanchored with word boundaries. Kept as its own constant rather than
 * un-anchoring the contract's at the call site: an anchored pattern silently
 * becomes a scanning one if someone strips `^`/`$`, and that is a change to
 * what the CONTRACT accepts.
 */
const ORCID_IN_TEXT = /\b\d{4}-\d{4}-\d{4}-\d{3}[\dXx]\b/;

/** An email address in free text. Deliberately loose; a false positive here costs a sentence. */
const EMAIL_IN_TEXT = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;

/** A git-annex pointer file's body: the key, not the content it stands for. */
const ANNEX_POINTER_BODY = /^\s*\/annex\/objects\//;

/**
 * Shortest owner token this will search for.
 *
 * A two- or three-character surname, username or handle matches inside ordinary
 * words and BIDS keywords, and a finding a depositor cannot reproduce is worse
 * than no finding: they stop reading the next one. Four is long enough that a
 * whole-word match is evidence.
 */
const MIN_OWNER_TOKEN_LENGTH = 4;

/**
 * Files worth reading, in priority order.
 *
 * Root-level BIDS metadata plus the two free-text files, then any other
 * root-level `.json`/`.tsv`. Sub-directory sidecars are not scanned: they hold
 * acquisition parameters rather than prose, there are thousands of them, and
 * the budget is better spent on the files a person actually wrote.
 */
const PRIORITY_DEPOSIT_FILES = [
  "dataset_description.json",
  "README",
  "README.md",
  "README.txt",
  "README.rst",
  "CHANGES",
  "CHANGES.md",
  "participants.tsv",
  "participants.json",
  "samples.tsv",
  "samples.json",
  ".nemar/metadata.json",
];

/** The one file in the list above that NEMAR writes rather than the depositor. */
const NEMAR_METADATA_PATH = ".nemar/metadata.json";

/**
 * Which withheld fields a parsed metadata document still carries.
 *
 * One rule, two documents: the D1 enrichment cache and the repository's
 * committed `.nemar/metadata.json` are written by the same pipeline and blinded
 * by the same list, so they are judged by the same function rather than by two
 * copies that can drift.
 */
function presentBlindedKeys(document: Record<string, unknown>): string[] {
  return BLINDED_METADATA_KEYS.filter((key) => {
    const value = document[key];
    if (value === undefined || value === null) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object") return Object.keys(value as object).length > 0;
    return true;
  });
}

/** Extensions this will read as text. Anything else is bytes we cannot judge. */
const TEXTUAL_EXTENSIONS = [".json", ".tsv", ".txt", ".md", ".rst", ".csv", ".bib", ".cff"];

function isTextualPath(path: string): boolean {
  const lower = path.toLowerCase();
  if (PRIORITY_DEPOSIT_FILES.some((p) => p.toLowerCase() === lower)) return true;
  return TEXTUAL_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Which git-tracked files this run will read, priority first, bounded.
 *
 * Exported for its own test: the ordering IS the guarantee that a budget of 40
 * still reads `dataset_description.json` on a dataset with 3,000 files.
 */
export function inScopeDepositFiles(paths: readonly string[]): string[] {
  const available = new Set(paths);
  const chosen: string[] = [];
  for (const candidate of PRIORITY_DEPOSIT_FILES) {
    if (available.has(candidate)) chosen.push(candidate);
  }
  const rest = paths
    .filter((p) => !chosen.includes(p) && !p.includes("/") && isTextualPath(p))
    .sort();
  return [...chosen, ...rest];
}

export function selectDepositFiles(paths: readonly string[], limit: number): string[] {
  return inScopeDepositFiles(paths).slice(0, limit);
}

/**
 * The strings that would identify THIS dataset's depositor.
 *
 * Exported so a test can assert the filtering rules directly -- the short-token
 * rule especially, which is the difference between a finding and noise.
 */
export function ownerIdentityOf(row: {
  owner_username: string | null;
  owner_github: string | null;
  owner_given_name: string | null;
  owner_family_name: string | null;
  owner_email: string | null;
  owner_orcid: string | null;
}): OwnerIdentity {
  const tokens = [row.owner_given_name, row.owner_family_name, row.owner_username, row.owner_github]
    .map((v) => (v ?? "").trim())
    .filter((v) => v.length >= MIN_OWNER_TOKEN_LENGTH);
  const literals = [row.owner_email, row.owner_orcid]
    .map((v) => (v ?? "").trim())
    .filter((v) => v.length > 0);
  return { tokens: [...new Set(tokens)], literals: [...new Set(literals)] };
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does this text name the depositor? Whole-word for tokens, literal for the rest. */
export function textNamesOwner(text: string, owner: OwnerIdentity): boolean {
  for (const literal of owner.literals) {
    if (text.toLowerCase().includes(literal.toLowerCase())) return true;
  }
  for (const token of owner.tokens) {
    if (new RegExp(`\\b${escapeRegExp(token)}\\b`, "i").test(text)) return true;
  }
  return false;
}

/** A per-dataset scan, before it becomes a verdict. */
interface Scan {
  findings: AnonymityFinding[];
  unchecked: string[];
  filesScanned: number;
  filesListed: number;
}

/**
 * The invariants NEMAR owns that are answerable from the dataset row alone.
 *
 * Pure, so the rules are testable without a database, a token or a network.
 */
export function checkRowInvariants(row: {
  authors: string | null;
  enrichment_json: string | null;
  first_published_at: string | null;
}): { findings: AnonymityFinding[]; unchecked: string[] } {
  const findings: AnonymityFinding[] = [];
  const unchecked: string[] = [];

  // The catalog's author list. NULL is fine -- it names nobody, which is the
  // property under test; enrichment simply may not have run. What is NOT fine
  // is a non-empty value that is not the blinded label, because the only writer
  // of this column blinds it (`writeDatasetCatalogFields`), so anything else
  // arrived by a path that does not know about anonymity.
  const authors = (row.authors ?? "").trim();
  if (authors.length > 0 && authors !== ANONYMOUS_AUTHORS_LABEL) {
    findings.push({
      check: "authors_not_blinded",
      severity: "invariant",
      detail:
        "The catalog's author list is not the blinded label, so the dataset page, the search index and `nemar dataset list --author` are all showing it.",
    });
  }

  // The cached enrichment document, which `GET /datasets/:id` serves raw.
  if (row.enrichment_json) {
    let parsed: Record<string, unknown> | null = null;
    try {
      const value: unknown = JSON.parse(row.enrichment_json);
      parsed =
        typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
    } catch {
      // A document this sweep cannot parse is a document it cannot clear. The
      // question is not whether the JSON is well formed -- it is whether the
      // bytes `GET /datasets/:id` serves still name the depositor, and a
      // truncated or trailing-comma'd blob can carry the name perfectly well.
      // Reporting nothing here would answer "clean" about the one cached
      // document NEMAR itself owns.
      parsed = null;
      unchecked.push("enrichment_not_blinded");
    }
    if (parsed) {
      const present = presentBlindedKeys(parsed);
      if (present.length > 0) {
        findings.push({
          check: "enrichment_not_blinded",
          severity: "invariant",
          detail: `The cached enrichment document still carries ${present.length} withheld field(s) (${present.join(", ")}), and GET /datasets/:id serves that document raw.`,
        });
      }
    }
  }

  // Migration 0085's triggers refuse a row that is simultaneously anonymous and
  // published. If one exists, a write reached the table around them.
  if (row.first_published_at) {
    findings.push({
      check: "published_while_anonymous",
      severity: "invariant",
      detail:
        "This dataset is marked anonymous AND carries a first-publication stamp, which migration 0085's triggers are supposed to make impossible. Anonymity after publication is not something NEMAR can deliver.",
    });
  }

  return { findings, unchecked };
}

/**
 * The owner-withholding SQL, re-run as a check rather than trusted.
 *
 * Uses the very fragments the catalog projections interpolate
 * (`OWNER_USERNAME_SQL`, `OWNER_GITHUB_SQL`), so this asks the question the
 * real routes ask. A test that built its own `CASE WHEN` here would be
 * checking a copy.
 */
export const ANONYMITY_OWNER_PROJECTION_SQL = `SELECT ${OWNER_USERNAME_SQL}, ${OWNER_GITHUB_SQL}
   FROM datasets d JOIN users u ON d.owner_user_id = u.id
   WHERE d.dataset_id = ?`;

/**
 * Non-placeholder entries in a `dataset_description.json` person field.
 *
 * `readable` is the difference between "this field names nobody" and "this
 * field is in a shape I could not interpret". Both used to return an empty
 * array, which reads as clean; the second is a gap, and BIDS files in the wild
 * carry both of the shapes that produce it -- a bare string (`"Authors": "Jane
 * Coauthor"`) and an array of objects (`[{"name": "Jane Coauthor"}]`). The
 * bare string is interpretable, so it is read as a single entry rather than
 * discarded; anything else is reported.
 */
export function namedEntriesIn(
  description: Record<string, unknown>,
  field: string,
  isPlaceholder: (value: string) => boolean,
): { named: string[]; readable: boolean } {
  const raw = description[field];
  if (raw === undefined || raw === null) return { named: [], readable: true };
  const entries = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(entries)) return { named: [], readable: false };
  const strings = entries.filter((v): v is string => typeof v === "string");
  const readable = strings.length === entries.length;
  const named = strings
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
    .filter((v) => !isPlaceholder(v));
  return { named, readable };
}

/**
 * Scan one git-tracked text file for the three deterministic patterns.
 *
 * Returns findings, never the matched text (see `AnonymityFinding.detail`).
 * `dataset_description.json` gets the structured check as well; every other
 * file gets the free-text ones.
 */
export function scanDepositFile(
  path: string,
  text: string,
  owner: OwnerIdentity,
  isPlaceholder: (value: string) => boolean,
): { findings: AnonymityFinding[]; unchecked: string[] } {
  const findings: AnonymityFinding[] = [];
  const unchecked: string[] = [];

  if (path === "dataset_description.json" || path === NEMAR_METADATA_PATH) {
    let document: Record<string, unknown> | null = null;
    try {
      const value: unknown = JSON.parse(text);
      document =
        typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
    } catch {
      document = null;
    }
    if (!document) {
      // A hand-edited BIDS file with a trailing comma is ordinary, and the
      // free-text checks below still run over the raw bytes. What is lost is
      // the structured one: a CO-AUTHOR's name, which no free-text rule can
      // find because the sweep only knows the depositor's own identity.
      unchecked.push(`description_structured:${path}`);
    } else if (path === NEMAR_METADATA_PATH) {
      // NEMAR writes and blinds this file, so a withheld key surviving here is
      // NEMAR's bug, not the depositor's -- same rule and same severity as the
      // cached enrichment document in `checkRowInvariants`.
      const present = presentBlindedKeys(document);
      if (present.length > 0) {
        findings.push({
          check: "repo_metadata_not_blinded",
          severity: "invariant",
          file: path,
          detail: `The repository's committed .nemar/metadata.json still carries ${present.length} withheld field(s) (${present.join(", ")}). NEMAR writes this file, so a fresh enrichment commit is what replaces it.`,
        });
      }
    } else {
      // Authors is the field the publication gate already enforces at request
      // time. Re-checked here because the gate runs ONCE, at the request, and
      // a depositor can commit to `main` freely while their repository is still
      // private -- which is exactly the window this deposit lives in.
      for (const field of ["Authors", "Funding", "Acknowledgements"]) {
        const { named, readable } = namedEntriesIn(document, field, isPlaceholder);
        if (!readable) {
          unchecked.push(`description_field:${field}`);
          continue;
        }
        if (named.length > 0) {
          findings.push({
            check: `description_${field.toLowerCase()}_named`,
            severity: "deposit",
            file: path,
            detail: `${field} in dataset_description.json has ${named.length} entry/entries that name someone. This file is part of the dataset and is served publicly, so NEMAR cannot conceal what it says.`,
          });
        }
      }
    }
  }

  if (ORCID_IN_TEXT.test(text)) {
    findings.push({
      check: "orcid_in_deposit",
      severity: "deposit",
      file: path,
      detail: `${path} contains an ORCID iD. An ORCID iD is a permanent global identifier: one of them de-anonymizes an entire author list in a single lookup.`,
    });
  }

  if (textNamesOwner(text, owner)) {
    findings.push({
      check: "depositor_named_in_deposit",
      severity: "deposit",
      file: path,
      detail: `${path} contains your own name, username, GitHub handle or email address.`,
    });
  } else if (EMAIL_IN_TEXT.test(text)) {
    // Reported only when it is NOT already covered by the line above, so a
    // depositor sees one finding per file rather than two for one string.
    findings.push({
      check: "email_in_deposit",
      severity: "deposit",
      file: path,
      detail: `${path} contains an email address.`,
    });
  }

  return { findings, unchecked };
}

/** The network boundaries, as one object, so a test substitutes them all at once. */
export interface AnonymitySweepSeams {
  /** `fetch` for the GitHub REST call that reads repository visibility. */
  fetchGithubImpl?: typeof fetch;
  /**
   * Raw content host for the file broker. A test points this at a local
   * server, the way `git-file-broker.test.ts` does; the broker takes a base
   * URL rather than a `fetch`, so there is no impl seam to pass.
   */
  rawBase?: string;
  /** Reads the EZID record. Substituted rather than pointed at a base URL,
   *  because `ezid.ts` resolves its host from a module-level global. */
  getIdentifierImpl?: (
    identifier: string,
    isSandbox: boolean,
  ) => Promise<{ status: string; dataciteXml?: string }>;
  /**
   * The owner-withholding SQL to re-run, overriding
   * `ANONYMITY_OWNER_PROJECTION_SQL`.
   *
   * A seam because the real projection blinds on `d.anonymous = 1`, which IS
   * the candidate predicate -- so no seedable row can make it leak, and the
   * check had no positive case at all. A test supplies a deliberately
   * un-blinded projection to prove the finding fires, and one that matches no
   * row to prove a failed check reports `unchecked` rather than a disclosure.
   */
  ownerProjectionSql?: string;
  /** Reads a published Zarr index; `null` means the dataset has none. */
  fetchZarrIndexImpl?: (datasetId: string) => Promise<string | null>;
  /**
   * Lists the repository's git-tracked files at `main`.
   *
   * The repository tree rather than the published version manifest, and the
   * difference matters: an anonymous release skips `version_doi`, so no
   * `dataset_versions` row and no published manifest exists for exactly the
   * datasets this sweep is for. `main` is also the right ref on its own terms
   * -- a concealed deposit's files keep changing there while its repository is
   * private, because restoring attribution is a direct commit.
   *
   * `null` means the listing could not be obtained, which the caller reports as
   * unchecked rather than as "no files".
   */
  listGitFilesImpl?: (
    repo: string,
  ) => Promise<{ path: string; sha: string; size?: number; mode?: string }[] | null>;
}

/**
 * Is this dataset's GitHub repository private, as an anonymous deposit's must be?
 *
 * Returns `null` when the question could not be answered, which the caller
 * records as `unchecked` rather than as "private" -- the whole point of the
 * tri-state (ADR 0005).
 */
async function repoIsPrivate(
  repo: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<boolean | null> {
  try {
    const res = await fetchImpl(`${GITHUB_API()}/repos/${ORG_NAME}/${repo}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { private?: boolean };
    return typeof body.private === "boolean" ? body.private : null;
  } catch {
    return null;
  }
}

/**
 * One dataset's scan.
 *
 * Every check contributes findings, `unchecked`, or both. A check that could
 * not run NEVER contributes a clean result: that is the difference between "we
 * looked and it is fine" and "we could not look", and collapsing the two is how
 * a verification sweep becomes a rubber stamp.
 */
async function scanDataset(
  env: Bindings,
  row: AnonymityCandidate,
  token: string | null,
  seams: AnonymitySweepSeams,
  isPlaceholder: (value: string) => boolean,
  budget: { remaining: number },
): Promise<Scan> {
  const rowCheck = checkRowInvariants(row);
  const findings: AnonymityFinding[] = [...rowCheck.findings];
  // ALWAYS present, on every run, for every dataset: identity inside the
  // recordings themselves is in annexed binaries this sweep does not read.
  const unchecked = ["signal_headers", ...rowCheck.unchecked];
  const owner = ownerIdentityOf(row);

  // --- the projections, re-run rather than trusted -------------------------
  try {
    const projected = await env.DB.prepare(
      seams.ownerProjectionSql ?? ANONYMITY_OWNER_PROJECTION_SQL,
    )
      .bind(row.dataset_id)
      .first<{ owner_username: string | null; owner_github: string | null }>();
    if (!projected) {
      // No row means the question could not be asked, not that it was answered
      // badly. Raising the finding here would mail the depositor and every
      // admin an urgent "your identity is exposed" for a check that never ran.
      unchecked.push("owner_projected");
    } else if (projected.owner_username !== null || projected.owner_github !== null) {
      findings.push({
        check: "owner_projected",
        severity: "invariant",
        detail:
          "The catalog's owner projection is returning a username or GitHub handle for this dataset. Those are joined from `users` at read time, so no writer can withhold them; the projection is the only thing that can.",
      });
    }
  } catch {
    unchecked.push("owner_projected");
  }

  // --- the repository ------------------------------------------------------
  const repo = row.github_repo?.split("/")[1] ?? null;
  if (!repo) {
    unchecked.push("repo_private");
  } else if (!token) {
    unchecked.push("repo_private");
  } else {
    const isPrivate = await repoIsPrivate(repo, token, seams.fetchGithubImpl ?? fetch);
    if (isPrivate === null) unchecked.push("repo_private");
    else if (!isPrivate) {
      findings.push({
        check: "repo_public",
        severity: "invariant",
        detail:
          "The GitHub repository is PUBLIC. That publishes the whole git history: commit author names and email addresses, the git-annex description recorded at init, and every contributor on the repository page.",
      });
    }
  }

  // --- the identifier ------------------------------------------------------
  if (!row.concept_doi) {
    // No identifier is not a gap: a deposit may simply have none yet.
  } else if (!seams.getIdentifierImpl) {
    unchecked.push("doi_reserved");
  } else {
    try {
      const record = await seams.getIdentifierImpl(row.concept_doi, row.is_sandbox === 1);
      if (record.status !== "reserved") {
        findings.push({
          check: "doi_not_reserved",
          severity: "invariant",
          detail: `The DOI record is "${record.status}", not "reserved". A reserved identifier is registered but not advertised and does not resolve; anything else is harvested by DataCite and cannot be recalled.`,
        });
      }
      if (record.dataciteXml && textNamesOwner(record.dataciteXml, owner)) {
        findings.push({
          check: "doi_names_depositor",
          severity: "invariant",
          detail:
            "The DataCite document registered for this DOI names the depositor. ADR 0041's rule for a concealed deposit is that a DOI cites a real name or nobody at all.",
        });
      }
    } catch {
      unchecked.push("doi_reserved");
    }
  }

  // --- the published Zarr documents ---------------------------------------
  if (!seams.fetchZarrIndexImpl) {
    unchecked.push("zarr_index");
  } else {
    try {
      const index = await seams.fetchZarrIndexImpl(row.dataset_id);
      // `null` is a determined fact, not a gap: most datasets have no store.
      if (index !== null && (textNamesOwner(index, owner) || ORCID_IN_TEXT.test(index))) {
        findings.push({
          check: "zarr_index_names_depositor",
          severity: "invariant",
          detail:
            "The published Zarr index names the depositor. It is served from public S3 at zarr.nemar.org and carries a dataset-level citation built from the catalog row.",
        });
      }
    } catch {
      unchecked.push("zarr_index");
    }
  }

  // --- the depositor's own files ------------------------------------------
  let filesScanned = 0;
  let filesListed = 0;
  const listing =
    repo && token && seams.listGitFilesImpl
      ? await seams.listGitFilesImpl(repo).catch((err) => {
          // Logged rather than only counted: `deposit_files` says the tree
          // could not be listed, and the reason (401 vs 404 vs rate limit vs
          // network) is the only thing that tells an operator whether to fix a
          // token or wait.
          console.error(
            `[anonymity-sweep] ${row.dataset_id}: could not list the repository tree:`,
            err instanceof Error ? err.message : err,
          );
          return null;
        })
      : null;
  // An empty array is NOT an empty repository. Every dataset repository has at
  // least `dataset_description.json`, so a zero-entry listing means the listing
  // failed in a way that did not throw -- a tree response with no `tree` key, a
  // token scoped so the tree comes back empty, or a future refactor returning
  // `[]` instead of raising. Treating it as "nothing to check" would stamp
  // `verified` on a repository nobody read.
  if (!listing || listing.length === 0 || !repo || !token) {
    unchecked.push("deposit_files");
  } else {
    const bySha = new Map(listing.map((f) => [f.path, f]));
    filesListed = listing.length;
    const inScope = inScopeDepositFiles(listing.map((f) => f.path));
    const selected = inScope.slice(0, ANONYMITY_MAX_DEPOSIT_FILES);
    if (inScope.length < filesListed) {
      unchecked.push("deposit_subdirectory_files");
    }
    for (const path of selected) {
      if (budget.remaining <= 0) {
        unchecked.push("deposit_files_budget");
        break;
      }
      const entry = bySha.get(path);
      const blobSha = entry?.sha ?? "";
      // A missing size is unknown, not zero: reading it anyway would let one
      // tree entry with no `size` pull an unbounded body into a Worker.
      if (entry?.size === undefined || entry.size > ANONYMITY_MAX_FILE_BYTES) {
        unchecked.push(`deposit_file_too_large:${path}`);
        continue;
      }
      // A git-annex pointer is a symlink (mode 120000) or a small file whose
      // body is an `/annex/objects/...` key, not the content. Scanning it finds
      // nothing and would count as a clean read of a file nobody looked inside
      // -- ADR 0060's inherited-`.gitattributes` case puts ordinary BIDS
      // metadata in exactly this shape.
      if (entry.mode === "120000") {
        unchecked.push(`deposit_file_annexed:${path}`);
        continue;
      }
      budget.remaining -= 1;
      const fetched = await fetchGitTrackedFile({
        repo,
        // The manifest is pinned to a published version tag, but an anonymous
        // deposit's files change on `main` while its repository is private --
        // restoring attribution is a direct commit, because ADR 0001's
        // pull-request rule has not bitten yet. `main` is what a reader of the
        // data plane would get today, so it is what this has to judge.
        ref: "main",
        path,
        blobSha,
        token,
        rawBase: seams.rawBase,
      }).catch(() => null);
      if (!fetched || fetched.kind === "unavailable") {
        unchecked.push(`deposit_file_unreadable:${path}`);
        continue;
      }
      if (fetched.kind === "absent") {
        // Honest absence, because a token was held. The manifest named a file
        // the repository no longer has; that is a manifest problem, not a leak.
        continue;
      }
      const text = fetched.body ? await new Response(fetched.body).text().catch(() => null) : null;
      if (text === null) {
        unchecked.push(`deposit_file_unreadable:${path}`);
        continue;
      }
      if (ANNEX_POINTER_BODY.test(text)) {
        unchecked.push(`deposit_file_annexed:${path}`);
        continue;
      }
      filesScanned += 1;
      try {
        const scanned = scanDepositFile(path, text, owner, isPlaceholder);
        findings.push(...scanned.findings);
        unchecked.push(...scanned.unchecked);
      } catch (err) {
        // One pathological file must not discard the findings already collected
        // for this dataset, including the invariant ones from the row and the
        // repository checks. Report the file and keep going.
        console.error(
          `[anonymity-sweep] ${row.dataset_id}: scanning ${path} threw:`,
          err instanceof Error ? err.message : err,
        );
        unchecked.push(`deposit_file_unreadable:${path}`);
      }
    }
    // Compares like with like: the in-scope set against what the budget let
    // through. Comparing against `filesListed` counted every blob in the tree,
    // so any dataset with a sub-directory -- that is, every BIDS dataset --
    // reported a budget overrun it had not had and could never reach
    // `verified`.
    if (inScope.length > selected.length) {
      unchecked.push("deposit_files_beyond_budget");
    }
  }

  return { findings, unchecked, filesScanned, filesListed };
}

/**
 * Run one bounded pass.
 *
 * Throws only if the candidate query itself fails. A per-dataset failure lands
 * in `errors` and stamps NO verdict, but the row is not untouched: the attempt
 * stamp is written before the scan begins, deliberately, so a dataset that
 * fails every time costs one slot per cycle instead of holding the front of
 * the queue forever. It becomes a candidate again when that stamp ages out.
 *
 * `seams` is the test-only dependency injection every real caller omits, in the
 * idiom `runZarrFidelitySweep` established (`fetchIndexImpl` / `endpointUrl`):
 * production always resolves the real GitHub host, the real EZID, the real S3
 * bucket and the real raw content host.
 */
export async function runAnonymitySweep(
  env: Bindings,
  opts?: { limit?: number; seams?: AnonymitySweepSeams; sweepWideBudget?: number },
): Promise<AnonymitySweepResult> {
  const requested = opts?.limit ?? ANONYMITY_SWEEP_DEFAULT;
  const limit = Math.min(Math.max(requested, 1), ANONYMITY_SWEEP_MAX);

  const rows = await env.DB.prepare(ANONYMITY_SWEEP_CANDIDATE_SQL)
    .bind(limit)
    .all<AnonymityCandidate>();
  const candidates = rows.results ?? [];

  const seams = opts?.seams ?? {};
  const budget = { remaining: opts?.sweepWideBudget ?? ANONYMITY_SWEEP_WIDE_BUDGET };

  // One token for the whole pass. A failure to mint is not fatal: the row
  // invariants and the projections are still checkable, and the checks that
  // needed it are recorded as unchecked rather than assumed clean.
  let token: string | null = null;
  if (candidates.length > 0) {
    try {
      token = await getDatasetsToken(env);
    } catch (err) {
      console.warn(
        "[anonymity-sweep] no GitHub token; repository and deposit-file checks will be reported as unchecked:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  const resolvedSeams: AnonymitySweepSeams = {
    ...seams,
    getIdentifierImpl: seams.getIdentifierImpl ?? (await defaultIdentifierReader(env)),
    fetchZarrIndexImpl: seams.fetchZarrIndexImpl ?? defaultZarrIndexReader(env),
    listGitFilesImpl: seams.listGitFilesImpl ?? defaultGitFileLister(token),
  };

  let verified = 0;
  let withFindings = 0;
  let unverifiable = 0;
  let budgetExhausted = false;
  const results: AnonymityDatasetResult[] = [];
  const errors: { dataset_id: string; error: string }[] = [];
  const mailFailures: { dataset_id: string; recipient: string; error: string }[] = [];

  for (const row of candidates) {
    if (budget.remaining <= 0) {
      budgetExhausted = true;
      break;
    }

    // Recorded BEFORE anything branches on the outcome, so a dataset that
    // errors every run costs one slot per cycle rather than the whole batch.
    try {
      await env.DB.prepare(ANONYMITY_SWEEP_ATTEMPT_SQL).bind(row.dataset_id).run();
    } catch (err) {
      // Not just logged: without this stamp the row sorts never-attempted-first
      // again next cycle and permanently starves everything behind it, which is
      // the exact failure the stamp was introduced to prevent. Reporting it in
      // `errors` is what makes the run non-zero rather than quietly degenerate.
      console.error(`[anonymity-sweep] attempt stamp failed for ${row.dataset_id}:`, err);
      errors.push({
        dataset_id: row.dataset_id,
        error: `attempt stamp failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    let scan: Scan;
    try {
      scan = await scanDataset(env, row, token, resolvedSeams, isPlaceholderAuthor, budget);
    } catch (err) {
      errors.push({
        dataset_id: row.dataset_id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    // A real finding is not erased by an unrelated check that could not run:
    // the verdict is `findings` whenever there are any, and `unverifiable` only
    // when there are none AND something beyond the always-unchecked signal
    // headers was missed. Reporting "verified" while a check was skipped is the
    // exact failure ADR 0054 names.
    const missedSomethingCheckable = scan.unchecked.some(
      (u) => !ANONYMITY_DECLARED_SCOPE_LIMITS.includes(u),
    );
    const status: AnonymityVerdict =
      scan.findings.length > 0
        ? "findings"
        : missedSomethingCheckable
          ? "unverifiable"
          : "verified";

    try {
      await env.DB.prepare(ANONYMITY_SWEEP_STAMP_SQL)
        .bind(status, JSON.stringify(scan.findings), JSON.stringify(scan.unchecked), row.dataset_id)
        .run();
    } catch (err) {
      errors.push({
        dataset_id: row.dataset_id,
        error: `stamp write failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    if (status === "verified") verified += 1;
    else if (status === "findings") withFindings += 1;
    else unverifiable += 1;

    results.push({
      dataset_id: row.dataset_id,
      status,
      findings: scan.findings,
      unchecked: scan.unchecked,
      files_scanned: scan.filesScanned,
      files_listed: scan.filesListed,
    });

    if (status === "findings") {
      const announced = await recordAndAnnounce(
        env,
        row,
        scan,
        parsePreviousFindings(row.previous_findings),
      ).catch((err) => {
        // The verdict is already durable in `sweep_stamps`; losing the audit
        // row or the mail must not undo it.
        console.error(`[anonymity-sweep] announcement failed for ${row.dataset_id}:`, err);
        return {
          recipients: 0,
          mailFailures: [
            { recipient: "all", error: err instanceof Error ? err.message : String(err) },
          ],
        };
      });
      for (const failure of announced.mailFailures) {
        mailFailures.push({ dataset_id: row.dataset_id, ...failure });
      }
    } else if (status === "unverifiable") {
      // Named, not just counted. A dataset that is unverifiable every day --
      // a broken App token, unset EZID credentials, an index behind a
      // permanent 403 -- is "NEMAR cannot confirm this person is concealed",
      // and an aggregate count never says which person.
      console.error(
        `[anonymity-sweep] ${row.dataset_id}: unverifiable; could not check ${scan.unchecked
          .filter((u) => !ANONYMITY_DECLARED_SCOPE_LIMITS.includes(u))
          .join(", ")}`,
      );
    }
  }

  let remaining: number | null = null;
  try {
    const row = await env.DB.prepare(ANONYMITY_SWEEP_REMAINING_SQL).first<{ n: number }>();
    // `null` is reserved for "the query failed" and a caller pages on it, so a
    // successful query with no row must not borrow that meaning.
    remaining = row ? row.n : 0;
  } catch (err) {
    console.error("[anonymity-sweep] remaining count failed:", err);
  }

  return {
    processed: results.length + errors.length,
    verified,
    with_findings: withFindings,
    unverifiable,
    results,
    errors,
    remaining,
    budget_exhausted: budgetExhausted,
    mail_failures: mailFailures,
  };
}

/**
 * Production-only cron entry.
 *
 * The fence lives here rather than inside `runAnonymitySweep` so the admin
 * route still works on staging -- the same split `runRecordingStatsSweepCron`
 * uses. Returns `null` when skipped, which `sweepLogLines` renders as such.
 */
export async function runAnonymitySweepCron(env: Bindings): Promise<AnonymitySweepResult | null> {
  if (isNonProductionEnv(env)) {
    console.log("[anonymity-sweep] skipped (non-production)");
    return null;
  }
  return runAnonymitySweep(env);
}

/**
 * The real EZID reader, resolved once per pass.
 *
 * Returns `undefined` when EZID is not configured, which the scan records as
 * `unchecked` -- a missing credential is not evidence that a DOI is reserved.
 */
async function defaultIdentifierReader(
  env: Bindings,
): Promise<AnonymitySweepSeams["getIdentifierImpl"]> {
  const { getIdentifier, conceptEzidIdentifier } = await import("./ezid.js");
  const { resolveEzidAuth } = await import("./doi.js");
  return async (conceptDoi: string, isSandbox: boolean) => {
    // Sandbox and production shoulders have different credentials, and the row
    // says which one this DOI was minted on. Hardcoding production made every
    // exemplar-fleet dataset permanently `unverifiable` on staging -- where the
    // admin route is deliberately reachable -- because its sandbox DOI was
    // queried with production credentials. `resolveEzidAuth` throws when the
    // pair it needs is unset, which the caller turns into `unchecked`.
    const auth = resolveEzidAuth(
      {
        EZID_USERNAME: env.EZID_USERNAME,
        EZID_PASSWORD: env.EZID_PASSWORD,
        EZID_SANDBOX_USERNAME: env.EZID_SANDBOX_USERNAME,
        EZID_SANDBOX_PASSWORD: env.EZID_SANDBOX_PASSWORD,
      },
      isSandbox,
    );
    const record = await getIdentifier(auth, conceptEzidIdentifier(conceptDoi));
    return { status: record.status, dataciteXml: record.dataciteXml };
  };
}

/** The real Zarr index reader: one S3 GET, `null` when the dataset has no store. */
function defaultZarrIndexReader(env: Bindings): AnonymitySweepSeams["fetchZarrIndexImpl"] {
  return async (datasetId: string) => {
    // The RAW document, not `getZarrIndex`'s parsed summary: what this checks
    // for is the dataset-level `citation` string the converter composes from
    // the catalog row, and that field is not in the summary shape.
    //
    // Unsigned, because an anonymous deposit is `visibility = 'public'` and its
    // index is served publicly at zarr.nemar.org -- which is precisely why it
    // is worth checking.
    //
    // 404 and 403 are NOT the same answer. The bucket denies anonymous
    // ListBucket, so a 403 covers "no such key", "present but not public", "a
    // bucket-policy change in flight" and "the anonymous principal cannot see
    // it" -- and one of those is an index that exists, names the depositor, and
    // could not be read. Only 404 is absence; 403 is a gap, and the caller
    // turns a throw into `unchecked`.
    const origin = `https://${env.S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com`;
    const res = await fetch(`${origin}/${encodeURIComponent(datasetId)}/zarr/index.json`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`zarr index GET ${res.status}`);
    return await res.text();
  };
}

/**
 * The real file listing: the repository tree at `main`.
 *
 * Two GitHub `core` calls per dataset, which the candidate pool makes
 * affordable (anonymous deposits are rare and short-lived) and which the
 * published-manifest alternative cannot replace: an anonymous release skips
 * `version_doi`, so the `dataset_versions` row and the manifest that hangs off
 * it do not exist for these datasets at all.
 *
 * Imported from `github/contents.js` rather than the `services/github` barrel
 * ON PURPOSE. `backend/test/manifest-small-root-files.test.ts` installs a
 * process-wide `mock.module` on the barrel that makes `getTreeAtRef` return an
 * empty array, and `test/` and `backend/test/` share one process -- so a sweep
 * reading through the barrel would see no files in a full run and report a
 * clean deposit it never looked at.
 *
 * A truncated tree (GitHub's cap, ~100k entries) is not distinguished here.
 * Every file this scan prioritizes is at the repository root, and a recursive
 * tree lists the root first, so truncation cannot hide one.
 */
function defaultGitFileLister(token: string | null): AnonymitySweepSeams["listGitFilesImpl"] {
  return async (repo: string) => {
    if (!token) return null;
    const { getTreeAtRef } = await import("./github/contents.js");
    const tree = await getTreeAtRef(repo, "main", token);
    // Blobs only: `getTreeAtRef` returns directory entries too, and counting
    // those as files would inflate the listed total against which scope is
    // judged. `mode` is carried because 120000 is a git-annex symlink, whose
    // body is a pointer rather than the content.
    return tree
      .filter((entry) => entry.type === "blob")
      .map((entry) => ({
        path: entry.path,
        sha: entry.sha,
        size: entry.size,
        mode: entry.mode,
      }));
  };
}

/**
 * The durable record, then the two humans who can act.
 *
 * Order matters: the `audit_log` row is written FIRST and is the thing that
 * survives a mail outage, a revoked API key, or a depositor who deleted the
 * message. Mail is best-effort on top of it.
 *
 * Neither the row nor the mail carries the matched text. `AnonymityFinding`
 * already refuses to hold it; this is the reason why.
 */
/** Last run's findings off the stamp. Unreadable means "treat as changed". */
function parsePreviousFindings(raw: string | null): AnonymityFinding[] | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? (value as AnonymityFinding[]) : null;
  } catch {
    return null;
  }
}

async function recordAndAnnounce(
  env: Bindings,
  row: AnonymityCandidate,
  scan: Scan,
  previous: AnonymityFinding[] | null,
): Promise<{ recipients: number; mailFailures: { recipient: string; error: string }[] }> {
  const mailFailures: { recipient: string; error: string }[] = [];
  try {
    await auditLogStatement(env.DB, {
      userId: null,
      action: "anonymity_findings",
      resourceType: "dataset",
      resourceId: row.dataset_id,
      details: JSON.stringify({
        findings: scan.findings.map((f) => ({
          check: f.check,
          severity: f.severity,
          file: f.file,
        })),
        unchecked: scan.unchecked,
        files_scanned: scan.filesScanned,
        files_listed: scan.filesListed,
      }),
    }).run();
  } catch (err) {
    console.error(`[anonymity-sweep] audit write failed for ${row.dataset_id}:`, err);
  }

  // Unchanged findings are not re-mailed. A deposit finding stays true until
  // the depositor edits their own file, so mailing it daily would train both
  // audiences to ignore the one that is new. The audit row above is written on
  // every run regardless, so the durable record stays complete.
  if (previous && sameFindings(previous, scan.findings)) {
    return { recipients: 0, mailFailures };
  }

  if (!env.RESEND_API_KEY) {
    console.error(
      `[anonymity-sweep] ${row.dataset_id}: findings were recorded but RESEND_API_KEY is unset, so nobody was told.`,
    );
    return { recipients: 0, mailFailures };
  }
  const { getAdminEmailsForCategory, resolveEmailConfig, sendAnonymityFindingsEmail } =
    await import("./email.js");
  const { fromEmail, replyTo, isDev } = resolveEmailConfig(env);
  let recipients = 0;

  // The depositor first: the deposit findings are theirs to fix, and they are
  // the person whose concealment is at stake. The address comes off the
  // candidate row, which already joined `users`; re-deriving it from the
  // mutable `username` silently mailed nobody when that column was NULL.
  if (row.owner_email) {
    const sent = await sendAnonymityFindingsEmail(
      [row.owner_email],
      row.dataset_id,
      scan.findings,
      scan.unchecked,
      { audience: "depositor" },
      env.RESEND_API_KEY,
      fromEmail,
      replyTo,
      isDev,
      env,
    ).catch((err: unknown) => {
      console.error("[anonymity-sweep] depositor mail failed:", err);
      return {
        delivered: [] as string[],
        failed: [
          { recipient: "depositor", error: err instanceof Error ? err.message : String(err) },
        ],
      };
    });
    recipients += sent.delivered.length;
    mailFailures.push(...sent.failed);
  } else {
    console.error(
      `[anonymity-sweep] ${row.dataset_id}: the owner row carries no email address, so the depositor was not told.`,
    );
    mailFailures.push({ recipient: "depositor", error: "no address on the owner row" });
  }

  const adminEmails = await getAdminEmailsForCategory(env.DB, "dataset_anonymity", env);
  if (adminEmails.length > 0) {
    const sent = await sendAnonymityFindingsEmail(
      adminEmails,
      row.dataset_id,
      scan.findings,
      scan.unchecked,
      { audience: "admin" },
      env.RESEND_API_KEY,
      fromEmail,
      replyTo,
      isDev,
      env,
    ).catch((err: unknown) => {
      console.error("[anonymity-sweep] admin mail failed:", err);
      return {
        delivered: [] as string[],
        failed: [{ recipient: "admins", error: err instanceof Error ? err.message : String(err) }],
      };
    });
    recipients += sent.delivered.length;
    mailFailures.push(...sent.failed);
  }

  return { recipients, mailFailures };
}

/** Same set of findings, by the fields that identify one. Order-insensitive. */
export function sameFindings(a: AnonymityFinding[], b: AnonymityFinding[]): boolean {
  const key = (f: AnonymityFinding) => `${f.check}|${f.severity}|${f.file ?? ""}`;
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
}
