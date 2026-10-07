/**
 * Upload pipeline: the identifier preflight (epic #1610 phase 3, ADR 0087).
 *
 * Before `nemar dataset upload` sends anything, this screens the dataset on the uploader's own
 * machine with the scanner every other surface uses, and decides whether the upload may go on.
 *
 * ONE QUESTION, ASKED THE SAME WAY. The files are handed to the fleet scan's
 * `scanDatasetFromManifest` with the `clone` source, which is what the publication screen
 * (ADR 0086) uses: every EDF/BDF header is read (256 bytes each, never the recording), and the
 * participants table, scans tables, non-BIDS JSON and small code and text files are read up to
 * the same byte limits (`LOCAL_SCAN_LIMITS`). So the verdict is `classifyDataset`'s, and the
 * words are the report contract's.
 *
 * WHAT IS SCREENED is what the upload plan lists (`collectFileManifest`): everything under the
 * dataset except `.git` and `.nemar` at the top and `.gitattributes` anywhere. The walk uses
 * `readdir` and `stat` itself rather than reusing that function, because it must COUNT what it
 * could not see: a directory it cannot list makes the scan `tree-truncated`, and a file it
 * cannot open (a broken link, a special file, no permission) is a failed read. Nothing is
 * skipped silently, so nothing unread can be called clean.
 *
 * LOCAL ONLY. Nothing here makes a network request: the reader opens files, and the scan context
 * is built so that the two network paths the fleet scan has (a manifest fetch and a GitHub token)
 * are unreachable.
 *
 * WHAT IT DECIDES (the publication gate's three sets, `screenGate`):
 *   clear        clean, dates only, no recordings: the upload goes on.
 *   blocks       direct identifiers: the upload is refused, with no override, even under
 *                --dry-run.
 *   acknowledge  a lesser finding, an incomplete scan, or recordings the scanner cannot read:
 *                the upload goes on only after an explicit acknowledgment, which is recorded.
 *                At a terminal that is a prompt that defaults to no; without one it is
 *                `--acknowledge-identifier-preflight <verdict>`, which must name the verdict
 *                found, so a pipeline that acknowledged one verdict stops when another appears.
 *                `--yes` never counts, and `--dry-run` never prompts.
 *
 * NOTHING PRINTED NAMES ANYTHING. Kinds, counts and fixed words only; no value from a file and no
 * path, because a path can be a name and an upload's output can land in a public CI log.
 *
 * NEVER TRUSTED. The record goes to the backend with the deposit attestation, and a modified
 * client can send anything, so no gate reads it as permission. The publication screen is the
 * check that holds.
 */

import { type Dirent, lstatSync, readdirSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import { InvalidArgumentError } from "commander";
import inquirer from "inquirer";
import ora, { type Ora } from "ora";
import {
  type EntryReadOptions,
  LOCAL_SCAN_LIMITS,
  type ManifestEntry,
  ReadFailure,
  createContext,
  scanDatasetFromManifest,
} from "../../../scripts/identifier-fleet-lib.js";
import {
  type AcknowledgedVia,
  type DatasetStatus,
  PREFLIGHT_ACKNOWLEDGEABLE,
  PREFLIGHT_VERSION,
  type PreflightScan,
  ReportError,
  type UploaderPreflight,
  dateFindingCount,
  dateNormalizationLine,
  describePreflight,
  foldOddFailures,
  foldUnknownFormats,
  parsePreflightScan,
  parseUploaderPreflight,
  screenGate,
} from "../../../shared/identifier-screen-report.js";
import { CONTRIBUTOR_TERMS_URL } from "../attestation.js";
import { markReportedExit } from "../debug-log.js";
import { identifierScreenLines } from "../identifier-screen-display.js";
import { version } from "../version.js";
import type { DatePlan } from "./date-normalization.js";
import { FAIL, type Step, ok } from "./types.js";

/** The flag that acknowledges a verdict without a terminal. */
export const ACKNOWLEDGE_FLAG = "--acknowledge-identifier-preflight";

/** Concurrent local reads: the disk is local, the bound keeps open file descriptors in check. */
const PREFLIGHT_CONCURRENCY = 16;

/** The identifier of a readable entry: its index in the walk, never its path. */
const LOCAL_URL = "local:";

/** What the walk saw. */
export interface LocalTree {
  entries: ManifestEntry[];
  /** The absolute path of each entry that is a regular file (through a link), by `url`. */
  readable: Map<string, string>;
  /** Directories that could not be listed, whose contents were therefore never seen. */
  unlisted: number;
}

/**
 * Every file the upload would list, as manifest entries. An entry that is not a regular file
 * (through a link) is listed, so the path rules see it, but is never opened: opening a FIFO
 * would block, and a broken link has nothing to read.
 */
export function walkDatasetTree(root: string): LocalTree {
  const entries: ManifestEntry[] = [];
  const readable = new Map<string, string>();
  let unlisted = 0;
  const pending: string[] = [""];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    let children: Dirent[];
    try {
      children = readdirSync(dir === "" ? root : join(root, dir), { withFileTypes: true });
    } catch {
      unlisted++;
      continue;
    }
    // Listing order is the filesystem's (APFS and ext4 differ), and it decides the order of the
    // counts in the record and the words printed. Sorted, the same tree gives the same output on
    // every machine; subdirectories are queued so that they are walked in that order too.
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirectories: string[] = [];
    for (const child of children) {
      const name = child.name;
      // The upload plan's own exclusions (collectFileManifest): git's and the CLI's state at the
      // top. `find -not -name .gitattributes` drops only that ENTRY and still descends into a
      // directory of that name, so a directory called `.gitattributes` is walked like any other.
      if (dir === "" && (name === ".git" || name === ".nemar")) continue;
      const path = dir === "" ? name : `${dir}/${name}`;
      if (child.isDirectory()) {
        subdirectories.push(path);
        continue;
      }
      if (name === ".gitattributes") continue;
      const url = `${LOCAL_URL}${entries.length}`;
      const absolute = join(root, path);
      let size: number | null = null;
      try {
        // Follows a link: what a read would see, and what the upload would send.
        const stats = statSync(absolute);
        if (stats.isFile()) {
          size = stats.size;
          readable.set(url, absolute);
        } else if (stats.isDirectory() && !lstatSync(absolute).isSymbolicLink()) {
          // A directory the listing did not type as one (a filesystem that reports an unknown
          // entry type): walk it rather than list it as a file nobody opens.
          subdirectories.push(path);
          continue;
        }
      } catch {
        // A broken link or an entry that cannot be stat'ed: listed and never opened. It counts
        // as a failed read when it is a file the scan reads (a recording, a table, a side file);
        // any other path is only in the file count and the path rules.
      }
      entries.push({ path, size, url });
    }
    // A stack: pushed last-first, so the first subdirectory is walked next.
    for (let i = subdirectories.length - 1; i >= 0; i--) pending.push(subdirectories[i] as string);
  }
  return { entries, readable, unlisted };
}

/**
 * Read at most `n` bytes from the start of a local file. Fewer than `minBytes` is a failed read
 * (`short-body`), never a short header; an entry the walk did not find readable, or a file that
 * cannot be opened, is `unreadable-entry`. Local failures are final, so none is retryable. A file
 * in `planned` (by absolute path) is read with its first bytes replaced by the planned header.
 */
function createLocalReader(
  readable: ReadonlyMap<string, string>,
  planned: ReadonlyMap<string, Uint8Array> = new Map(),
) {
  return async (
    entry: ManifestEntry,
    n: number,
    options: EntryReadOptions,
  ): Promise<Uint8Array> => {
    const absolute = readable.get(entry.url);
    if (absolute === undefined) throw new ReadFailure("unreadable-entry");
    const header = planned.get(absolute);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(absolute, "r");
    } catch {
      throw new ReadFailure("unreadable-entry");
    }
    try {
      // No more than the file held when the walk sized it: a 2 MiB buffer for a 40-byte file
      // is waste, and the scan judges truncation by that same size.
      const want = entry.size === null ? n : Math.min(n, entry.size);
      const out = new Uint8Array(want);
      let got = 0;
      while (got < want) {
        const { bytesRead } = await handle.read(out, got, want - got, got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      if (got < options.minBytes) throw new ReadFailure("short-body");
      // A header the upload will rewrite before anything is sent is read as it will be (ADR 0091).
      if (header) out.set(header.subarray(0, Math.min(got, header.length)), 0);
      return out.subarray(0, got);
    } catch (error) {
      if (error instanceof ReadFailure) throw error;
      throw new ReadFailure("unreadable-entry");
    } finally {
      await handle.close().catch(() => undefined);
    }
  };
}

/**
 * Screen a dataset directory and return the scan, in the contract's vocabulary. Throws when no
 * verdict could be produced (a bug, never a property of the dataset); the caller fails closed.
 * `planned` holds headers the upload will write before it sends anything (ADR 0091), by absolute
 * path: the scan is then of the tree as it will be sent.
 */
export async function scanLocalDataset(
  root: string,
  planned?: ReadonlyMap<string, Uint8Array>,
): Promise<PreflightScan> {
  const tree = walkDatasetTree(root);
  const ctx = createContext({
    fileConcurrency: PREFLIGHT_CONCURRENCY,
    workerConcurrency: 1,
    limits: { ...LOCAL_SCAN_LIMITS },
    readEntryHead: createLocalReader(tree.readable, planned),
    // A scan of given entries never fetches a manifest or a token. If it ever did, these make it
    // fail here rather than reach a network.
    githubToken: async () => null,
    readVersionManifest: async () => {
      throw new ReadFailure("unreadable-entry");
    },
    sleep: async () => undefined,
  });
  const record = await scanDatasetFromManifest(ctx, "local", null, tree.entries, "clone", {
    extraIncompleteReasons: tree.unlisted > 0 ? ["tree-truncated"] : [],
  });
  // Only the fields a preflight carries. `finding_fields`, the distinct-value counts and the
  // sampling table stay behind: a preflight is kinds and counts, and names no dataset.
  const scan = {
    scanned_at: record.scanned_at,
    status: record.status,
    incomplete: record.incomplete,
    incomplete_reasons: record.incomplete_reasons,
    files: record.files,
    findings_by_kind: record.findings_by_kind,
    edf_bdf_files_flagged: record.edf_bdf_files_flagged,
    unscreened_formats: record.unscreened_formats,
    read_failures: record.read_failures,
  };
  // Format names come from whatever a file is called, so only the closed list is kept.
  return parsePreflightScan(foldOddFailures(foldUnknownFormats(scan)));
}

/**
 * Every condition an acknowledgment must name, in the gate's own words, sorted.
 *
 * The verdict is only the scan's headline: `classifyDataset` ranks `review` above an incomplete
 * read, and both above recordings the scanner cannot parse, so a scan that found one image AND
 * could not read a header says only `review`. An acknowledgment bound to the verdict alone would
 * let a standing `review` cover an unread recording. So each condition that holds is a word of
 * its own: the verdict, `unchecked` when the scan is incomplete, and `not-screened` when there are
 * recordings it cannot parse. The kinds inside `review` are not bound (ADR 0087).
 */
export function preflightConditions(scan: PreflightScan): DatasetStatus[] {
  if (screenGate(scan.status) !== "acknowledge") return [];
  const conditions = new Set<DatasetStatus>([scan.status]);
  if (scan.incomplete && scan.status !== "unchecked") conditions.add("unchecked");
  const unscreened = Object.values(scan.unscreened_formats).reduce((a, b) => a + b, 0);
  const saysUnscreened =
    scan.status === "not-screened" || scan.status === "clean-edf-only-others-unscreened";
  if (unscreened > 0 && !saysUnscreened) conditions.add("not-screened");
  return [...conditions].sort();
}

const sameWords = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((word, i) => word === b[i]);

/**
 * Commander's parser for `--acknowledge-identifier-preflight`: repeatable, and comma-separated
 * within one value, each word one of the verdicts that can be acknowledged. Anything else, and
 * `direct-identifiers` in particular, is refused before the command runs.
 */
export function collectAcknowledgment(value: string, previous: string[] | undefined): string[] {
  const words = value
    .split(",")
    .map((word) => word.trim())
    .filter((word) => word !== "");
  const allowed = PREFLIGHT_ACKNOWLEDGEABLE as readonly string[];
  if (words.length === 0 || !words.every((word) => allowed.includes(word))) {
    throw new InvalidArgumentError(
      `Allowed verdicts are ${allowed.join(", ")}. Direct identifiers cannot be acknowledged.`,
    );
  }
  return [...(previous ?? []), ...words];
}

/** What the upload does with a verdict. */
export type PreflightDecision =
  | { action: "proceed"; acknowledgedVia: AcknowledgedVia | null }
  /** A dry run of a verdict that needs an acknowledgment: report it, ask nothing, send nothing. */
  | { action: "preview" }
  | { action: "prompt" }
  | { action: "refuse" }
  | { action: "stop"; why: "acknowledgment-required" | "acknowledgment-mismatch" | "declined" };

export interface PreflightChoices {
  /** The words given to `--acknowledge-identifier-preflight`, in any order. */
  acknowledge?: readonly string[];
  dryRun?: boolean;
  /** `--no`: decline every prompt. */
  no?: boolean;
  isTty: boolean;
}

/**
 * The rule, without any input or output. A flag acknowledges only when it names exactly the
 * conditions found, no fewer (a new condition stops a pipeline) and no more (a list of every word
 * would otherwise be a standing waiver). `--yes` is deliberately not a choice here: skipping a
 * proceed confirmation is not looking at a finding (ADR 0024 makes the same call for the
 * attestation).
 */
export function decidePreflight(scan: PreflightScan, choices: PreflightChoices): PreflightDecision {
  const gate = screenGate(scan.status);
  if (gate === "clear") return { action: "proceed", acknowledgedVia: null };
  // `blocks`, and anything that is not a verdict at all (a scan always ends in one, so this is
  // the fail-closed default rather than a path).
  if (gate !== "acknowledge") return { action: "refuse" };
  if (choices.acknowledge !== undefined) {
    const given = [...new Set(choices.acknowledge)].sort();
    return sameWords(given, preflightConditions(scan))
      ? { action: "proceed", acknowledgedVia: "flag" }
      : { action: "stop", why: "acknowledgment-mismatch" };
  }
  if (choices.dryRun) return { action: "preview" };
  if (choices.no) return { action: "stop", why: "declined" };
  if (choices.isTty) return { action: "prompt" };
  return { action: "stop", why: "acknowledgment-required" };
}

/** Why a condition needs a person, in a sentence that names nothing. */
const ACKNOWLEDGE_WHY: Partial<Record<DatasetStatus, string>> = {
  review: "the scanner found something a person should look at (the kinds are listed above)",
  unchecked: "the scanner could not read everything it should have (see Incomplete above)",
  "not-screened":
    "some recordings are in formats the scanner cannot read, so their headers were not checked",
  "clean-edf-only-others-unscreened":
    "the EDF/BDF headers are clean, but other recordings are in formats the scanner cannot read",
};

/** The flag as it would have to be given for this scan. */
const flagFor = (conditions: readonly string[]) => `${ACKNOWLEDGE_FLAG} ${conditions.join(",")}`;

function printAcknowledgmentNeed(conditions: readonly DatasetStatus[]): void {
  console.log(
    chalk.yellow("  This does not stop an upload, but it needs your explicit acknowledgment of:"),
  );
  for (const condition of conditions) {
    console.log(chalk.yellow(`    ${condition}: ${ACKNOWLEDGE_WHY[condition] ?? "not clean"}.`));
  }
  console.log(
    chalk.dim(
      "  Your acknowledgment is recorded with your deposit attestation. NEMAR screens the dataset again when you request publication, and an administrator decides then.",
    ),
  );
}

function printRefusal(): void {
  console.log();
  console.log(
    chalk.red(
      "  Upload refused: the preflight found direct identifiers (a name, a birth date finer than the year, a record number, an age over 89, or an identifying column or key). Nothing was sent.",
    ),
  );
  console.log(
    chalk.red(
      "  Remove them from the files (for EDF/BDF, the patient and recording fields of the header) and run the upload again.",
    ),
  );
  console.log(
    chalk.dim(
      `  There is no override, and ${ACKNOWLEDGE_FLAG} does not apply. If this is a false positive, please report it, so the scanner is fixed for every dataset. Terms: ${CONTRIBUTOR_TERMS_URL}`,
    ),
  );
}

/**
 * Why a scan threw, as a fixed word: the contract's own word, or the error's class and system
 * code. Never the message, which can carry a path.
 */
function failureWord(error: unknown): string {
  if (error instanceof ReportError) return `report-${error.message}`;
  const name =
    error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : "unknown";
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^E[A-Z0-9]{1,20}$/.test(code) ? `${name} ${code}` : name;
}

function printScanFailure(spinner: Ora, error: unknown): void {
  spinner.fail("Identifier preflight: DID NOT FINISH");
  console.log(
    chalk.red(
      `  The preflight could not produce a verdict, so nothing was uploaded (${failureWord(error)}).`,
    ),
  );
  console.log(chalk.dim("  Please report this: https://github.com/nemarOrg/nemar-cli/issues"));
}

/** Print a scan's headline on the spinner and its count lines under it. */
function printVerdict(spinner: Ora, scan: PreflightScan, suffix = ""): void {
  const view = describePreflight(scan, null);
  const headline = `${view.headline}${suffix}`;
  if (view.tone === "ok") spinner.succeed(headline);
  else if (view.tone === "stop") spinner.fail(headline);
  else spinner.warn(headline);
  for (const line of identifierScreenLines({ state: scan.status, ...view }, 2).slice(1)) {
    console.log(line);
  }
}

/** The record sent with the attestation, checked against the contract it will be parsed with. */
function preflightRecord(
  scan: PreflightScan,
  via: AcknowledgedVia | null,
): Step<UploaderPreflight> {
  try {
    return ok(
      parseUploaderPreflight({
        version: PREFLIGHT_VERSION,
        scanner: `nemar-cli@${version}`,
        scan,
        acknowledged_via: via,
      }),
    );
  } catch (error) {
    // The record failed its own contract: a bug in this module, never a property of the dataset.
    console.log(
      chalk.red(
        `  The preflight's record did not fit the report contract (${failureWord(error)}), so nothing was uploaded.`,
      ),
    );
    return FAIL;
  }
}

/**
 * The preflight step (between upload steps 1c and 1d): screen the dataset, print the verdict,
 * and decide. Returns the record to send with the attestation, or null for a dry run that
 * previewed a verdict needing an acknowledgment (nothing is sent on a dry run). A refusal, a
 * missing acknowledgment, or a scan that produced no verdict is FAIL: unknown is never clean,
 * so a preflight that could not finish stops the upload rather than waving it through.
 */
export async function identifierPreflightStep(
  absolutePath: string,
  options: { dryRun?: boolean; acknowledgeIdentifierPreflight?: string[]; no?: boolean },
  isTty: boolean = process.stdin.isTTY === true,
  datePlan?: DatePlan,
): Promise<Step<UploaderPreflight | null>> {
  const spinner = ora("Screening for identifiers on this machine (nothing is sent)...").start();
  let isDirectory = false;
  try {
    isDirectory = statSync(absolutePath).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    spinner.fail("Identifier preflight: the dataset path is not a directory");
    return FAIL;
  }
  const planned = new Map((datePlan?.items ?? []).map((item) => [item.path, item.after]));
  let scan: PreflightScan;
  try {
    scan = await scanLocalDataset(absolutePath, planned);
  } catch (error) {
    printScanFailure(spinner, error);
    return FAIL;
  }
  printVerdict(spinner, scan);
  // ADR 0091: what the upload sets itself is one neutral line, not a warning and not a question.
  if (planned.size > 0) console.log(chalk.dim(`  ${dateNormalizationLine(planned.size)}`));

  const conditions = preflightConditions(scan);
  const decision = decidePreflight(scan, {
    acknowledge: options.acknowledgeIdentifierPreflight,
    dryRun: options.dryRun,
    no: options.no,
    isTty,
  });

  let via: AcknowledgedVia | null;
  switch (decision.action) {
    case "proceed":
      if (decision.acknowledgedVia === "flag") {
        console.log(chalk.dim(`  Acknowledged with ${flagFor(conditions)}.`));
      } else if (options.acknowledgeIdentifierPreflight !== undefined) {
        console.log(chalk.dim(`  Nothing to acknowledge; ${ACKNOWLEDGE_FLAG} was not needed.`));
      }
      via = decision.acknowledgedVia;
      break;
    case "preview":
      printAcknowledgmentNeed(conditions);
      console.log(
        chalk.yellow(
          `  A real upload stops here until you acknowledge it: answer the prompt, or pass ${flagFor(conditions)}.`,
        ),
      );
      console.log();
      return ok(null);
    case "prompt": {
      printAcknowledgmentNeed(conditions);
      let acknowledged = false;
      // Ctrl+C at this prompt makes inquirer close its readline and re-raise SIGINT at this
      // process. Under Bun that signal is delivered after the event loop has nothing left to do,
      // so the process used to end with status 0 and no word (measured through a real
      // pseudo-terminal). A cancel is a cancel: the timer keeps the loop alive until the signal
      // lands, and the handler says so and exits 130 (128 + SIGINT).
      const onSigint = () => {
        console.log(chalk.red("\n  Upload cancelled. Nothing was sent."));
        markReportedExit();
        process.exit(130);
      };
      process.once("SIGINT", onSigint);
      const keepAlive = setInterval(() => undefined, 1_000);
      try {
        ({ acknowledged } = await inquirer.prompt<{ acknowledged: boolean }>([
          { type: "confirm", name: "acknowledged", message: "Upload anyway?", default: false },
        ]));
      } catch {
        // A prompt that failed or was closed is not an acknowledgment.
        acknowledged = false;
      } finally {
        clearInterval(keepAlive);
        process.off("SIGINT", onSigint);
      }
      if (acknowledged !== true) {
        console.log(chalk.red("  Upload cancelled. Nothing was sent."));
        markReportedExit();
        return FAIL;
      }
      console.log(chalk.dim("  Acknowledged at the prompt."));
      via = "prompt";
      break;
    }
    case "refuse":
      printRefusal();
      markReportedExit();
      return FAIL;
    case "stop":
      if (decision.why === "acknowledgment-mismatch") {
        console.log(
          chalk.red(
            `  ${ACKNOWLEDGE_FLAG} must name exactly what was found, which is: ${conditions.join(",")}. It does not acknowledge this scan. Nothing was sent.`,
          ),
        );
      } else {
        printAcknowledgmentNeed(conditions);
        console.log(
          chalk.red(
            decision.why === "declined"
              ? "  Declined (--no). Nothing was sent."
              : `  No terminal to ask at: run interactively, or pass ${flagFor(conditions)}. --yes does not acknowledge a finding. Nothing was sent.`,
          ),
        );
      }
      // The exit code is the answer here, not a bug: no "attach the log to an issue" nudge.
      markReportedExit();
      return FAIL;
  }

  const record = preflightRecord(scan, via);
  if (record.status === "ok") console.log();
  return record;
}

/**
 * Screen again right before the create call, and send THAT scan. Between the first screen and the
 * create call come validation, the license, provenance and attestation prompts and the final
 * confirmation, which take as long as a person likes, and some of them write into the tree; a
 * verdict about the files as they were is not one about the files being sent. The upload stops on
 * direct identifiers, and on any condition the acknowledgment did not cover. A scan that
 * produced no verdict stops it too.
 */
export async function recheckIdentifierPreflight(
  absolutePath: string,
  first: UploaderPreflight,
): Promise<Step<UploaderPreflight>> {
  const spinner = ora("Screening again, right before anything is sent...").start();
  let scan: PreflightScan;
  try {
    scan = await scanLocalDataset(absolutePath);
  } catch (error) {
    printScanFailure(spinner, error);
    return FAIL;
  }
  const gate = screenGate(scan.status);
  if (gate !== "clear" && gate !== "acknowledge") {
    printVerdict(spinner, scan);
    printRefusal();
    markReportedExit();
    return FAIL;
  }
  const before = preflightConditions(first.scan);
  const now = preflightConditions(scan);
  if (!sameWords(before, now)) {
    printVerdict(spinner, scan);
    console.log(
      chalk.red(
        `  The files changed since the preflight, and so did what it found (acknowledged: ${before.join(",") || "nothing"}; now: ${now.join(",")}). Nothing was sent. Run the upload again.`,
      ),
    );
    markReportedExit();
    return FAIL;
  }
  // The warning about acquisition dates (ADR 0090) is printed once, at the first screen. A tree
  // that gained or lost some while the prompts ran is told again, because the record sent is this
  // scan's and the uploader has not seen its count.
  if (dateFindingCount(scan.findings_by_kind) !== dateFindingCount(first.scan.findings_by_kind)) {
    printVerdict(spinner, scan, " (screened again)");
  } else {
    spinner.succeed(`${describePreflight(scan, null).headline} (screened again)`);
  }
  return preflightRecord(scan, first.acknowledged_via);
}
