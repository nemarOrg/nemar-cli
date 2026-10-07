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

import { type Dirent, readdirSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import inquirer from "inquirer";
import ora from "ora";
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
  PREFLIGHT_VERSION,
  type PreflightScan,
  ReportError,
  type UploaderPreflight,
  describePreflight,
  foldOddFailures,
  foldOddFormats,
  parsePreflightScan,
  parseUploaderPreflight,
  screenGate,
} from "../../../shared/identifier-screen-report.js";
import { CONTRIBUTOR_TERMS_URL } from "../attestation.js";
import { identifierScreenLines } from "../identifier-screen-display.js";
import { version } from "../version.js";
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
    for (const child of children) {
      const name = child.name;
      // The upload plan's own exclusions (collectFileManifest): git's and the CLI's state at the
      // top, and the attributes file git-annex writes.
      if (dir === "" && (name === ".git" || name === ".nemar")) continue;
      if (name === ".gitattributes") continue;
      const path = dir === "" ? name : `${dir}/${name}`;
      if (child.isDirectory()) {
        pending.push(path);
        continue;
      }
      const url = `${LOCAL_URL}${entries.length}`;
      const absolute = join(root, path);
      let size: number | null = null;
      try {
        // Follows a link: what a read would see, and what the upload would send.
        const stats = statSync(absolute);
        if (stats.isFile()) {
          size = stats.size;
          readable.set(url, absolute);
        }
      } catch {
        // A broken link or an entry that cannot be stat'ed: listed, never opened, and counted
        // as a failed read if the scan asks for it.
      }
      entries.push({ path, size, url });
    }
  }
  return { entries, readable, unlisted };
}

/**
 * Read at most `n` bytes from the start of a local file. Fewer than `minBytes` is a failed read
 * (`short-body`), never a short header; an entry the walk did not find readable, or a file that
 * cannot be opened, is `unreadable-entry`. Local failures are final, so none is retryable.
 */
function createLocalReader(readable: ReadonlyMap<string, string>) {
  return async (
    entry: ManifestEntry,
    n: number,
    options: EntryReadOptions,
  ): Promise<Uint8Array> => {
    const absolute = readable.get(entry.url);
    if (absolute === undefined) throw new ReadFailure("unreadable-entry");
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(absolute, "r");
    } catch {
      throw new ReadFailure("unreadable-entry");
    }
    try {
      const out = new Uint8Array(n);
      let got = 0;
      while (got < n) {
        const { bytesRead } = await handle.read(out, got, n - got, got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      if (got < options.minBytes) throw new ReadFailure("short-body");
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
 */
export async function scanLocalDataset(root: string): Promise<PreflightScan> {
  const tree = walkDatasetTree(root);
  const ctx = createContext({
    fileConcurrency: PREFLIGHT_CONCURRENCY,
    workerConcurrency: 1,
    limits: { ...LOCAL_SCAN_LIMITS },
    readEntryHead: createLocalReader(tree.readable),
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
  return parsePreflightScan(foldOddFailures(foldOddFormats(scan)));
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
  /** The value of `--acknowledge-identifier-preflight`. */
  acknowledge?: string;
  dryRun?: boolean;
  /** `--no`: decline every prompt. */
  no?: boolean;
  isTty: boolean;
}

/**
 * The rule, without any input or output. `--yes` is deliberately not a choice here: skipping a
 * proceed confirmation is not looking at a finding (ADR 0024 makes the same call for the
 * attestation).
 */
export function decidePreflight(
  status: DatasetStatus,
  choices: PreflightChoices,
): PreflightDecision {
  const gate = screenGate(status);
  if (gate === "clear") return { action: "proceed", acknowledgedVia: null };
  // `blocks`, and anything that is not a verdict at all (a scan always ends in one, so this is
  // the fail-closed default rather than a path).
  if (gate !== "acknowledge") return { action: "refuse" };
  if (choices.acknowledge !== undefined) {
    return choices.acknowledge === status
      ? { action: "proceed", acknowledgedVia: "flag" }
      : { action: "stop", why: "acknowledgment-mismatch" };
  }
  if (choices.dryRun) return { action: "preview" };
  if (choices.no) return { action: "stop", why: "declined" };
  if (choices.isTty) return { action: "prompt" };
  return { action: "stop", why: "acknowledgment-required" };
}

/** Why a verdict needs a person, in a sentence that names nothing. */
const ACKNOWLEDGE_WHY: Partial<Record<DatasetStatus, string>> = {
  review: "the scanner found something a person should look at (the kinds are listed above)",
  unchecked: "the scanner could not read everything it should have (see Incomplete above)",
  "not-screened":
    "the recordings are in formats the scanner cannot read, so their headers were not checked",
  "clean-edf-only-others-unscreened":
    "the EDF/BDF headers are clean, but other recordings are in formats the scanner cannot read",
};

function printAcknowledgmentNeed(status: DatasetStatus): void {
  console.log(
    chalk.yellow(
      `  This does not stop an upload, but it needs your explicit acknowledgment: ${ACKNOWLEDGE_WHY[status] ?? "the verdict is not clean"}.`,
    ),
  );
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

/** The record sent with the attestation, checked against the contract it will be parsed with. */
function preflightRecord(scan: PreflightScan, via: AcknowledgedVia | null): UploaderPreflight {
  return parseUploaderPreflight({
    version: PREFLIGHT_VERSION,
    scanner: `nemar-cli@${version}`,
    scan,
    acknowledged_via: via,
  });
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
  options: { dryRun?: boolean; acknowledgeIdentifierPreflight?: string; no?: boolean },
  isTty: boolean = process.stdin.isTTY === true,
): Promise<Step<UploaderPreflight | null>> {
  const spinner = ora("Screening for identifiers on this machine (nothing is sent)...").start();
  let scan: PreflightScan;
  try {
    scan = await scanLocalDataset(absolutePath);
  } catch (error) {
    spinner.fail("Identifier preflight: DID NOT FINISH");
    console.log(
      chalk.red(
        `  The preflight could not produce a verdict, so nothing was uploaded (${error instanceof ReportError ? `report-${error.message}` : "scanner-error"}).`,
      ),
    );
    console.log(chalk.dim("  Please report this: https://github.com/nemarOrg/nemar-cli/issues"));
    return FAIL;
  }

  const view = describePreflight(scan, null);
  if (view.tone === "ok") spinner.succeed(view.headline);
  else if (view.tone === "stop") spinner.fail(view.headline);
  else spinner.warn(view.headline);
  // The headline is the spinner's line; the count lines follow it, indented and dim.
  for (const line of identifierScreenLines({ state: scan.status, ...view }, 2).slice(1)) {
    console.log(line);
  }

  const decision = decidePreflight(scan.status, {
    acknowledge: options.acknowledgeIdentifierPreflight,
    dryRun: options.dryRun,
    no: options.no,
    isTty,
  });

  let via: AcknowledgedVia | null;
  switch (decision.action) {
    case "proceed":
      if (decision.acknowledgedVia === "flag") {
        console.log(chalk.dim(`  Acknowledged with ${ACKNOWLEDGE_FLAG} ${scan.status}.`));
      } else if (options.acknowledgeIdentifierPreflight !== undefined) {
        console.log(chalk.dim(`  Nothing to acknowledge; ${ACKNOWLEDGE_FLAG} was not needed.`));
      }
      via = decision.acknowledgedVia;
      break;
    case "preview":
      printAcknowledgmentNeed(scan.status);
      console.log(
        chalk.yellow(
          `  A real upload stops here until you acknowledge it: answer the prompt, or pass ${ACKNOWLEDGE_FLAG} ${scan.status}.`,
        ),
      );
      console.log();
      return ok(null);
    case "prompt": {
      printAcknowledgmentNeed(scan.status);
      let acknowledged = false;
      try {
        ({ acknowledged } = await inquirer.prompt<{ acknowledged: boolean }>([
          { type: "confirm", name: "acknowledged", message: "Upload anyway?", default: false },
        ]));
      } catch {
        // An interrupted prompt (Ctrl+C) is not an acknowledgment.
        acknowledged = false;
      }
      if (!acknowledged) {
        console.log(chalk.red("  Upload cancelled. Nothing was sent."));
        return FAIL;
      }
      via = "prompt";
      break;
    }
    case "refuse":
      printRefusal();
      return FAIL;
    case "stop":
      if (decision.why === "acknowledgment-mismatch") {
        console.log(
          chalk.red(
            `  ${ACKNOWLEDGE_FLAG} names a different verdict than the one found (${scan.status}), so it does not acknowledge this one. Nothing was sent.`,
          ),
        );
      } else {
        printAcknowledgmentNeed(scan.status);
        console.log(
          chalk.red(
            decision.why === "declined"
              ? "  Declined (--no). Nothing was sent."
              : `  No terminal to ask at: run interactively, or pass ${ACKNOWLEDGE_FLAG} ${scan.status}. --yes does not acknowledge a finding. Nothing was sent.`,
          ),
        );
      }
      return FAIL;
  }

  let record: UploaderPreflight;
  try {
    record = preflightRecord(scan, via);
  } catch (error) {
    // The record failed its own contract: a bug in this module, never a property of the dataset.
    console.log(
      chalk.red(
        `  The preflight's record did not fit the report contract (${error instanceof ReportError ? error.message : "unexpected"}), so nothing was uploaded.`,
      ),
    );
    return FAIL;
  }
  console.log();
  return ok(record);
}
